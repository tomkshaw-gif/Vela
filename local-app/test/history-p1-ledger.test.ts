import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCommand, createSession, validateStoredSession } from '../engine';
import { createReplayServer } from '../server/index';
import { ReplayStore } from '../server/store';
import { DEFAULT_RULES, type Bar, type Command, type SessionView } from '../shared/types';

const BASE = Date.UTC(2024, 0, 2); const directories: string[] = []; const stores: ReplayStore[] = [];
const apps: Awaited<ReturnType<typeof createReplayServer>>[] = [];
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), 'vela-history-p1-ledger-')); directories.push(directory); return directory; };
const barsFor = (count: number): Bar[] => Array.from({ length: count }, (_, index) => ({ time: BASE + index * 60_000, open: 100, high: 100, low: 100, close: 100, volume: 1, instrumentId: '1001', contract: 'NQH4' }));
const config = (datasetId: string) => ({ name: 'Ledger fixture', datasetId, mode: 'practice' as const, initialBalance: 50_000, commissionPerContractSide: 2,
    slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES });
async function dataset(store: ReplayStore, continuous: boolean, bars: Bar[]) {
    if (!continuous) return store.addDataset({ name: 'Exact fixture', symbol: 'NQH4', schema: 'ohlcv-1m', source: 'csv', bars });
    return store.addHistoryDataset({ name: 'Continuous fixture', symbol: 'NQ.v.0', expectedRows: bars.length, scope: 'ledger-fixture',
        provenance: { stypeIn: 'continuous', rollRule: 'volume', rank: 0, adjustment: 'none', rollPolicy: 'flatten-prior-close', requestedStart: new Date(BASE).toISOString(), requestedEnd: new Date(BASE + bars.length * 60_000).toISOString(), manifestHash: 'a'.repeat(64) },
        bars: (async function* () { yield* bars; })() });
}
afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0)) {
        const target = resolve(directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('vela-history-p1-ledger-')) throw new Error('Unexpected ledger fixture path.');
        rmSync(target, { recursive: true, force: true });
    }
});

describe('bounded historical fill validation', () => {
    it.each([false, true])('accepts HTTP close after earlier fills for continuous=%s', async continuous => {
        const app = await createReplayServer({ dataDirectory: temporary(), port: 0, apiKey: '', fetch: async () => { throw new Error('Provider access is forbidden in this fixture.'); } }); apps.push(app);
        const source = barsFor(8); const meta = await dataset(app.store, continuous, source);
        let session = app.store.createSession(createSession(config(meta.id), meta.instrument));
        const base = await app.listen(); const { token } = await (await fetch(base + '/api/bootstrap')).json() as { token: string };
        const command = async (command: Command) => {
            const response = await fetch(`${base}/api/sessions/${session.id}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify({ expectedRevision: session.revision, command }) });
            const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200); session = (body as SessionView).session;
        };
        await command({ type: 'advance', count: 1 });
        await command({ type: 'place', order: { type: 'market', side: 'buy', qty: 1 } });
        await command({ type: 'advance', count: 2 }); expect(session.cursor).toBe(2);
        await command({ type: 'close' }); await command({ type: 'advance', count: 1 });
        expect(session.position).toBeNull(); expect(session.trades).toHaveLength(1); expect(session.account.balance).toBe(49_996);
    });

    it.each([false, true])('validates many historical fills without earlier OHLC/full-array reads and rejects invented source times for continuous=%s', async continuous => {
        const store = new ReplayStore(temporary()); stores.push(store); const source = barsFor(1000); const meta = await dataset(store, continuous, source);
        let session = createSession(config(meta.id), meta.instrument);
        session = applyCommand(session, source, { type: 'advance', count: 1 });
        for (let round = 0; round < 100; round++) {
            session = applyCommand(session, source, { type: 'place', order: { type: 'market', side: 'buy', qty: 1 } });
            session = applyCommand(session, source, { type: 'place', order: { type: 'market', side: 'buy', qty: 1 } });
            session = applyCommand(session, source, { type: 'advance', count: 1 });
            session = applyCommand(session, source, { type: 'close' }); session = applyCommand(session, source, { type: 'advance', count: 1 });
        }
        // Exact datasets use the ordinary source contract; identity is present only
        // on the continuous source stored by the history importer.
        if (!continuous) delete session.executionVersion;
        const all = vi.spyOn(store, 'readBars').mockImplementation(() => { throw new Error('Full history reads are forbidden.'); });
        const queries = vi.spyOn(store.db, 'prepare'); const windows = vi.spyOn(store, 'readBarWindow'); const bounded = store.commandBars(meta.id, session.cursor);
        const membershipIndex = queries.mock.calls.findIndex(([sql]) => sql.startsWith('SELECT 1 AS present FROM bars'));
        expect(membershipIndex).toBeGreaterThanOrEqual(0);
        expect(queries.mock.calls[membershipIndex]![0]).toBe('SELECT 1 AS present FROM bars WHERE dataset_id=? AND time=? AND idx>=? AND idx<=? LIMIT 1');
        const membership = vi.spyOn(queries.mock.results[membershipIndex]!.value, 'get');
        expect(validateStoredSession(session, bounded, meta.instrument).fills).toHaveLength(300);
        expect(membership).toHaveBeenCalledTimes(200);
        expect(membership.mock.calls.every(([id, , start, end]) => id === meta.id && start === 0 && end === session.cursor)).toBe(true);
        expect(all).not.toHaveBeenCalled(); expect(windows.mock.calls.map(call => call[2])).toEqual([5002, 1]);
        expect(() => bounded[100]).toThrow(/bounded/);
        expect(() => validateStoredSession({ ...session, config: { ...session.config, datasetId: 'unrelated-dataset' } }, bounded, meta.instrument)).toThrow(/bounded revealed source/);
        expect(() => validateStoredSession({ ...session, cursor: session.cursor + 1 }, bounded, meta.instrument)).toThrow(/bounded revealed source/);
        const offGrid = structuredClone(session); const first = offGrid.fills[0]!; const oldTime = first.time; const changedTime = oldTime + 30_000;
        first.time = changedTime;
        for (const order of offGrid.orders) if (order.filledTime === oldTime) order.filledTime = changedTime;
        for (const trade of offGrid.trades) { if (trade.entryTime === oldTime) trade.entryTime = changedTime; if (trade.exitTime === oldTime) trade.exitTime = changedTime; }
        expect(() => validateStoredSession(offGrid, bounded, meta.instrument)).toThrow(/revealed source-bar times/);
        expect(() => validateStoredSession({ ...offGrid, sourceTimeLookup: { contains: true } }, bounded, meta.instrument)).toThrow(/revealed source-bar times/);
        expect(() => validateStoredSession({ ...session, config: { ...session.config, startIndex: 10 } }, bounded, meta.instrument)).toThrow(/revealed source-bar times/);
        const wrongFees = structuredClone(session); wrongFees.fills[0]!.fees++;
        expect(() => validateStoredSession(wrongFees, bounded, meta.instrument)).toThrow(/ledger|fees/);
    });
});
