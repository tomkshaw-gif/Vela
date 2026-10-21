import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplayServer } from '../server/index';
import { applyCommand, createSession } from '../engine/index';
import { validateExecutionVersion } from '../engine/validation';
import { ReplayStore } from '../server/store';
import { DEFAULT_RULES } from '../shared/types';
import type { Bar, Command, Session, SessionView } from '../shared/types';

const START = Date.parse('2026-06-01T14:00:00Z');
const bars: Bar[] = [100, 100, 102, 103, 104, 105].map((close, index) => ({ time: START + index * 60000, open: close, high: close, low: close, close, volume: 1 }));
const directories: string[] = [];
const stores: ReplayStore[] = [];
const apps: Awaited<ReturnType<typeof createReplayServer>>[] = [];
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), 'vela-partials-store-')); directories.push(directory); return directory; };
const config = (datasetId: string) => ({ name: 'Target persistence', datasetId, mode: 'practice' as const, initialBalance: 50000, commissionPerContractSide: 1.23, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES, maxContracts: 10 } });
function fixture(store: ReplayStore) {
    const dataset = store.addDataset({ name: 'Target persistence', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars });
    let state = createSession(config(dataset.id), dataset.instrument);
    const command = (value: Command) => { state = applyCommand(state, bars, value); return state; };
    command({ type: 'place', order: { side: 'buy', type: 'market', qty: 4, stopLoss: 90, takeProfits: [{ id: 'near-target', price: 102, qty: 1 }, { id: 'far-target', price: 104, qty: 2 }] } });
    command({ type: 'advance', count: 1 });
    return { dataset, command, state: () => state };
}
async function server(dataDirectory = temporary()) {
    const app = await createReplayServer({ dataDirectory, port: 0, apiKey: '', fetch: async () => { throw new Error('Provider access is outside this fixture'); } });
    apps.push(app);
    const url = await app.listen();
    const { token } = await (await fetch(`${url}/api/bootstrap`)).json() as { token: string };
    const post = (path: string, value: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify(value) });
    return { app, url, post };
}
afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('versioned target persistence', () => {
    it('keeps outstanding targets and allocated fees across store close and reopen', () => {
        const directory = temporary(); const first = new ReplayStore(directory); stores.push(first);
        const f = fixture(first); const reduced = f.command({ type: 'advance', count: 2 });
        first.createSession(reduced);
        expect(reduced.position?.qty).toBe(3);
        expect(reduced.position?.takeProfits).toEqual([{ id: 'far-target', price: 104, qty: 2 }]);
        expect(reduced.trades[0]?.takeProfitLegId).toBe('near-target');
        first.close(); stores.splice(stores.indexOf(first), 1);
        const reopened = new ReplayStore(directory); stores.push(reopened);
        expect(reopened.session(reduced.id)).toEqual(reduced);
        const completed = applyCommand(reopened.session(reduced.id), bars, { type: 'advance', count: 2 });
        reopened.saveSession(completed, reduced.revision);
        expect(reopened.session(reduced.id).position?.qty).toBe(1);
        expect(completed.account.fees).toBe(8.61);
        expect(completed.trades.map(trade => trade.takeProfitLegId)).toEqual(['near-target', 'far-target']);
    });

    it('rejects unknown or missing feature versions before a stored state can resume', () => {
        const store = new ReplayStore(temporary()); stores.push(store);
        const f = fixture(store); const valid = f.state();
        expect(() => store.createSession({ ...valid, executionVersion: 3 } as unknown as Session)).toThrow(/version/i);
        const unversioned = structuredClone(valid); delete unversioned.executionVersion;
        expect(() => store.createSession(unversioned)).toThrow(/version/i);
        store.createSession(valid);
        store.db.prepare("UPDATE sessions SET state=json_set(state,'$.executionVersion',3) WHERE id=?").run(valid.id);
        expect(() => store.session(valid.id)).toThrow(/version/i);
    });

    it('prevents an older writer from erasing execution fields and keeps the prior row intact', () => {
        const store = new ReplayStore(temporary()); stores.push(store);
        const f = fixture(store); const valid = f.state(); store.createSession(valid);
        const older = structuredClone(valid); delete older.executionVersion;
        if (older.position) delete older.position.takeProfits;
        for (const order of older.orders) delete order.takeProfits;
        const overwrite = store.db.prepare('UPDATE sessions SET state=?,revision=revision+1 WHERE id=?');
        expect(() => overwrite.run(JSON.stringify(older), valid.id)).toThrow(/newer application/i);
        expect(() => overwrite.run(JSON.stringify({ ...older, executionVersion: '2' }), valid.id)).toThrow(/newer application/i);
        expect(store.session(valid.id)).toEqual(valid);
        const renamed = applyCommand(valid, bars, { type: 'rename', name: 'Still supported' });
        expect(store.saveSession(renamed, valid.revision)).toEqual(renamed);
    });

    it('exports version 2 and preserves target IDs, provenance and balances through clone and import', async () => {
        const ctx = await server(); const f = fixture(ctx.app.store); const reduced = f.command({ type: 'advance', count: 2 }); ctx.app.store.createSession(reduced);
        const route = `/api/sessions/${reduced.id}`;
        const backup = await (await fetch(`${ctx.url}${route}/export`)).json() as { version: number; session: Session };
        expect(backup.version).toBe(2); expect(backup.session).toEqual(reduced);
        for (const path of [`${route}/clone`, '/api/sessions/import']) {
            const response = await ctx.post(path, path.endsWith('import') ? backup : {});
            expect(response.status).toBe(200); const { session } = await response.json() as SessionView;
            expect(session.id).not.toBe(reduced.id);
            expect(session.executionVersion).toBe(2);
            expect(session.position).toEqual(reduced.position);
            expect(session.account).toEqual(reduced.account);
            expect(session.fills.at(-1)?.takeProfitLegId).toBe('near-target');
            expect(session.trades.at(-1)?.takeProfitLegId).toBe('near-target');
            const next = await ctx.post(`/api/sessions/${session.id}/command`, { expectedRevision: session.revision, command: { type: 'advance', count: 2 } });
            expect(next.status).toBe(200);
            expect((await next.json() as SessionView).session.position?.qty).toBe(1);
        }
        const restart = await (await ctx.post(`${route}/clone`, { restart: true })).json() as SessionView;
        expect(restart.session.position).toBeNull(); expect(restart.session.orders).toEqual([]);
        expect(restart.session.executionVersion).toBeUndefined();
    });

    it('rejects backup version mismatches before creating any session or dataset', async () => {
        const ctx = await server(); const f = fixture(ctx.app.store); ctx.app.store.createSession(f.state());
        const backup = await (await fetch(`${ctx.url}/api/sessions/${f.state().id}/export`)).json() as { version: unknown; session: Session };
        const initial = { sessions: ctx.app.store.sessions().length, datasets: ctx.app.store.listDatasets().length };
        const invalid = [
            { ...backup, version: 1 }, { ...backup, version: '2' }, { ...backup, version: 3 },
            { ...backup, session: { ...backup.session, executionVersion: undefined } },
            { ...backup, session: { ...backup.session, executionVersion: 3 } },
        ];
        for (const input of invalid) expect((await ctx.post('/api/sessions/import', input)).status).toBe(400);
        expect(ctx.app.store.sessions()).toHaveLength(initial.sessions);
        expect(ctx.app.store.listDatasets()).toHaveLength(initial.datasets);
    });

    it('keeps ordinary legacy backups at version 1 and resumes them without target migration', async () => {
        const ctx = await server(); const f = fixture(ctx.app.store);
        const legacy = createSession(config(f.dataset.id), f.dataset.instrument); ctx.app.store.createSession(legacy);
        const backup = await (await fetch(`${ctx.url}/api/sessions/${legacy.id}/export`)).json() as { version: number; session: Session };
        expect(backup.version).toBe(1); expect(validateExecutionVersion(backup.session)).toBe(1);
        const response = await ctx.post('/api/sessions/import', backup);
        expect(response.status).toBe(200);
        const restored = (await response.json() as SessionView).session;
        expect(restored.executionVersion).toBeUndefined(); expect(restored.account).toEqual(legacy.account);
    });
});
