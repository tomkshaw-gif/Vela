import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSession } from '../engine';
import { ReplayStore } from '../server/store';
import { DEFAULT_RULES, type Bar } from '../shared/types';

const BASE = Date.UTC(2024, 0, 2);
const bars: Bar[] = [100, 100, 101, 1000, 1000].map((price, index) => ({ time: BASE + index * 60_000, open: price, high: price, low: price, close: price, volume: 1,
    instrumentId: index < 3 ? '1001' : '2002', contract: index < 3 ? 'NQH4' : 'NQM4' }));
const config = (datasetId: string) => ({ name: 'Compatibility fixture', datasetId, mode: 'practice' as const, initialBalance: 50_000, commissionPerContractSide: 2,
    slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES });
const temporary = () => mkdtempSync(join(tmpdir(), 'vela-history-p1-compat-'));
function cleanup(directory: string) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !target.includes('vela-history-p1-compat-')) throw new Error('Unexpected compatibility fixture path.');
    rmSync(target, { recursive: true, force: true });
}
async function datasets(store: ReplayStore) {
    const continuous = await store.addHistoryDataset({ name: 'Synthetic continuous', symbol: 'NQ.v.0', expectedRows: bars.length, scope: 'compatibility-fixture',
        provenance: { stypeIn: 'continuous', rollRule: 'volume', rank: 0, adjustment: 'none', rollPolicy: 'flatten-prior-close', requestedStart: new Date(BASE).toISOString(), requestedEnd: new Date(BASE + 86_400_000).toISOString(), manifestHash: 'a'.repeat(64) },
        bars: (async function* () { yield* bars; })() });
    const exact = store.addDataset({ name: 'Synthetic exact', symbol: 'NQH4', schema: 'ohlcv-1m', source: 'csv', bars });
    return { continuous, exact };
}

describe('continuous session guards on existing SQLite connections', () => {
    it('blocks legacy/string/real version inserts and retargeting through statements prepared before migration', async () => {
        const directory = temporary(); const old = new DatabaseSync(join(directory, 'replay.sqlite')); let modern: ReplayStore | undefined;
        try {
            old.exec(`PRAGMA journal_mode=WAL;
                CREATE TABLE sessions(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,state TEXT NOT NULL,summary TEXT NOT NULL);`);
            const insert = old.prepare('INSERT INTO sessions(id,revision,updated_at,state,summary) VALUES(?,?,?,?,?)');
            const update = old.prepare('UPDATE sessions SET state=? WHERE id=?');
            modern = new ReplayStore(directory); const { continuous, exact } = await datasets(modern);
            for (const version of [undefined, 1, 2, null, '3']) {
                const state = { ...createSession(config(continuous.id), continuous.instrument), executionVersion: version };
                expect(() => insert.run(state.id, 0, state.updatedAt, JSON.stringify(state), '{}')).toThrow(/execution version 3/);
            }
            const current = { ...createSession(config(continuous.id), continuous.instrument), executionVersion: 3 };
            expect(() => insert.run(current.id, 0, current.updatedAt, JSON.stringify(current).replace('"executionVersion":3', '"executionVersion":3.0'), '{}')).toThrow(/execution version 3/);
            insert.run(current.id, 0, current.updatedAt, JSON.stringify(current), '{}');
            for (const version of [undefined, 2]) {
                const legacy = { ...createSession(config(exact.id), exact.instrument), executionVersion: version };
                insert.run(legacy.id, 0, legacy.updatedAt, JSON.stringify(legacy), '{}');
                expect(() => update.run(JSON.stringify({ ...legacy, config: { ...legacy.config, datasetId: continuous.id } }), legacy.id)).toThrow(/execution version 3/);
                expect(JSON.parse((old.prepare('SELECT state FROM sessions WHERE id=?').get(legacy.id) as { state: string }).state).config.datasetId).toBe(exact.id);
            }
            expect(() => update.run(JSON.stringify({ ...current, executionVersion: 2 }), current.id)).toThrow(/newer application version/);
            expect(modern.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('sessions_continuous_version_insert','sessions_continuous_version_update','sessions_execution_version_update')").get()!.n).toBe(3);
            expect(modern.createSession(createSession(config(continuous.id), continuous.instrument)).executionVersion).toBe(3);
        } finally { modern?.close(); old.close(); cleanup(directory); }
    });
});

// Generic CI runs the synthetic connection proof above. The installed release is
// an optional explicit prerequisite for the separate, hash-pinned local proof.
const installedRuntime = process.env.VELA_151_RUNTIME_PROOF;
it.skipIf(!installedRuntime)('blocks the actual published 1.5.1 HTTP/Store writer while preserving exact-contract sessions', async () => {
    expect(createHash('sha256').update(readFileSync(installedRuntime!)).digest('hex')).toBe('c304adcfba89dd5ca31fb584c06a03c57c4b81acfdb26c26cc224edb958ffe97');
    const release = await import(/* @vite-ignore */ pathToFileURL(installedRuntime!).href);
    const directory = temporary();
    const app = await release.createReplayServer({ dataDirectory: directory, port: 0, apiKey: '', fetch: async () => { throw new Error('Provider access is forbidden in this compatibility proof.'); } });
    let modern: ReplayStore | undefined;
    try {
        const base = await app.listen(); const { token } = await (await fetch(base + '/api/bootstrap')).json() as { token: string };
        modern = new ReplayStore(directory); const { continuous, exact } = await datasets(modern);
        const post = (input: unknown) => fetch(base + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify(input) });
        expect((await post(config(continuous.id))).status).toBeGreaterThanOrEqual(400);
        expect((await post(config(exact.id))).status).toBe(200);
        for (const version of [undefined, 2]) {
            const rejected = { ...createSession(config(continuous.id), continuous.instrument), executionVersion: version };
            expect(() => app.store.createSession(rejected)).toThrow(/execution version 3/);
            const valid = { ...createSession(config(exact.id), exact.instrument), executionVersion: version };
            const saved = app.store.createSession(valid); expect(saved.config.datasetId).toBe(exact.id);
            expect(() => app.store.saveSession({ ...saved, config: { ...saved.config, datasetId: continuous.id }, revision: 1 }, 0)).toThrow(/execution version 3/);
        }
        const states = modern.db.prepare('SELECT state FROM sessions').all() as { state: string }[];
        expect(states.every(row => JSON.parse(row.state).config.datasetId === exact.id)).toBe(true);
    } finally { modern?.close(); await app.close(); cleanup(directory); }
});
