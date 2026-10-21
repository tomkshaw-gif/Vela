import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BacktestSnapshot, SaveScriptInput } from '../shared/scripts';
import { AppError } from '../server/errors';
import { SCRIPT_LIBRARY_LIMITS, ScriptLibrary } from '../server/scripts';

const resources: { directory: string; connections: DatabaseSync[] }[] = [];
function setup({ inMemory = false }: { inMemory?: boolean } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'vela-script-store-'));
    const resource = { directory, connections: [] as DatabaseSync[] }; resources.push(resource);
    const connect = () => {
        const db = new DatabaseSync(inMemory ? ':memory:' : join(directory, 'scripts.sqlite'));
        resource.connections.push(db); db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
        return { db, library: new ScriptLibrary(db) };
    };
    return { ...connect(), connect };
}
function snapshot(overrides: Partial<BacktestSnapshot> = {}): BacktestSnapshot {
    return {
        scriptVersion: 0, source: '//@version=5\nstrategy("Example")\nstrategy.entry("L",strategy.long)',
        symbol: 'NQM4', timeframe: '1m', datasetId: randomUUID(), datasetChecksum: 'a'.repeat(64),
        from: Date.UTC(2024, 3, 8), to: Date.UTC(2024, 3, 9), inputs: { length: 20, visible: true },
        properties: { initialCapital: 50000, commission: 2.5, slippage: 1 },
        engine: { vela: '0.8.5', pinets: '0.9.0' },
        result: { netProfit: 95, profitFactor: null, trades: [{ side: 'long', entryPrice: 18000, exitPrice: 18005, fees: 5 }], equity: [50000, 50095] },
        ...overrides,
    };
}
function status(action: () => unknown, expected: number, code?: string): void {
    try { action(); expect.fail('Expected a rejected library operation.'); }
    catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(expected); if (code) expect((error as AppError).code).toBe(code); }
}
afterEach(() => {
    for (const resource of resources.splice(0)) {
        for (const db of resource.connections) db.close();
        rmSync(resource.directory, { recursive: true, force: true });
    }
});

describe('persistent script documents', () => {
    it('creates documents, retains Unicode source and reopens the same database', () => {
        const { library, connect } = setup();
        const created = library.save({ name: '  Session study  ', source: '//@version=6\n// 日本語 📈\nplot(close)' });
        expect(created).toMatchObject({ name: 'Session study', revision: 0, versions: 1, archived: false });
        expect(created.id).toMatch(/^[a-f0-9-]{36}$/); expect(Date.parse(created.createdAt)).toBeGreaterThan(0);
        expect(connect().library.get(created.id)).toEqual(created);
        created.source = 'changed outside storage';
        expect(library.get(created.id).source).toBe('//@version=6\n// 日本語 📈\nplot(close)');
        expect(library.list()).toEqual([expect.objectContaining({ id: created.id, name: 'Session study', versions: 1 })]);
        expect(library.list()[0]).not.toHaveProperty('source');
    });
    it('saves source and rename history with strict revisions and restores an old version as a new save', () => {
        const { library } = setup(); const first = library.save({ name: 'Original', source: 'plot(close)' });
        const second = library.save({ id: first.id, expectedRevision: first.revision, name: first.name, source: 'plot(open)' });
        const third = library.save({ id: first.id, expectedRevision: second.revision, name: 'Renamed', source: second.source });
        expect(third).toMatchObject({ id: first.id, revision: 2, versions: 3, createdAt: first.createdAt });
        expect(library.versions(first.id).map(item => [item.version, item.name])).toEqual([[3, 'Renamed'], [2, 'Original'], [1, 'Original']]);
        expect(library.versions(first.id)[0]).not.toHaveProperty('source');
        const original = library.version(first.id, 1); expect(original.source).toBe('plot(close)');
        original.source = 'outside mutation'; expect(library.version(first.id, 1).source).toBe('plot(close)');
        const restored = library.save({ id: first.id, expectedRevision: third.revision, name: third.name, source: library.version(first.id, 1).source });
        expect(restored).toMatchObject({ revision: 3, versions: 4, source: 'plot(close)' });
        expect(library.version(first.id, 2).source).toBe('plot(open)');
    });
    it('does not manufacture versions for an unchanged save but still enforces CAS', () => {
        const { library } = setup(); const first = library.save({ name: 'Unchanged', source: '' });
        expect(library.save({ id: first.id, expectedRevision: 0, name: first.name, source: first.source })).toEqual(first);
        const second = library.save({ id: first.id, expectedRevision: 0, name: 'Changed', source: '' });
        status(() => library.save({ id: first.id, expectedRevision: 0, name: second.name, source: second.source }), 409, 'REVISION_CONFLICT');
        expect(library.get(first.id)).toEqual(second); expect(library.versions(first.id)).toHaveLength(2);
    });
    it('rejects a stale writer through an independent SQLite connection without partial history', () => {
        const { library, connect } = setup(); const other = connect().library;
        const first = library.save({ name: 'Two windows', source: 'plot(close)' });
        const next = other.save({ id: first.id, expectedRevision: 0, name: 'Other window', source: 'plot(high)' });
        status(() => library.save({ id: first.id, expectedRevision: 0, name: 'Stale window', source: 'plot(low)' }), 409, 'REVISION_CONFLICT');
        expect(library.get(first.id)).toEqual(next); expect(other.versions(first.id)).toHaveLength(2);
    });
    it('archives and restores metadata while retaining source history and rejecting stale operations', () => {
        const { library } = setup(); const first = library.save({ name: 'Archived study', source: 'plot(close)' });
        const archived = library.archive(first.id, 0);
        expect(archived).toMatchObject({ archived: true, revision: 1, versions: 1 });
        expect(library.list()).toEqual([]); expect(library.list({ includeArchived: true })).toHaveLength(1);
        expect(library.archive(first.id, 1)).toEqual(archived);
        status(() => library.restore(first.id, 0), 409); status(() => library.save({ id: first.id, expectedRevision: 1, name: first.name, source: 'plot(open)' }), 409, 'SCRIPT_ARCHIVED');
        expect(library.restore(first.id, 1)).toMatchObject({ archived: false, revision: 2, versions: 1 });
        expect(library.list()).toHaveLength(1); expect(library.version(first.id, 1).source).toBe(first.source);
    });
    it('clones current or archived source into an independent document and history', () => {
        const { library } = setup(); const first = library.save({ name: 'Study', source: 'plot(close)' }); library.archive(first.id, 0);
        const cloned = library.clone(first.id, 'Study copy');
        expect(cloned.id).not.toBe(first.id); expect(cloned).toMatchObject({ name: 'Study copy', source: first.source, revision: 0, versions: 1, archived: false });
        expect(library.list({ includeArchived: true })).toHaveLength(2);
        expect(library.version(first.id, 1).name).toBe('Study');
    });
    it('requires valid names, sources, UUIDs, expected revisions and known request fields', () => {
        const { library } = setup(); const first = library.save({ name: 'Valid', source: 'plot(close)' });
        for (const name of ['', '  ', 'x'.repeat(121), 'line\nbreak', '\ud800']) status(() => library.save({ name, source: '' }), 400);
        for (const source of [null, true, 'x'.repeat(200001), 'a\0b', '\ud800']) status(() => library.save({ name: 'Invalid source', source } as SaveScriptInput), 400);
        for (const expectedRevision of [undefined, null, -1, 0.5, Infinity, '0']) status(() => library.save({ id: first.id, expectedRevision, name: 'Valid', source: '' } as SaveScriptInput), 400);
        status(() => library.save({ name: 'New', source: '', expectedRevision: 0 }), 400);
        status(() => library.save({ id: randomUUID(), expectedRevision: 0, name: 'Unknown', source: '' }), 404);
        status(() => library.save({ id: first.id, expectedRevision: 10, name: 'Duplicate', source: '' }), 409);
        status(() => library.save({ name: 'Extra', source: '', unexpected: true } as SaveScriptInput), 400);
        status(() => library.get('../scripts.sqlite'), 400); status(() => library.version(first.id, 0), 400);
        status(() => library.version(first.id, 99), 404); status(() => library.versions(randomUUID()), 404);
        status(() => library.list({ includeArchived: 'yes' } as never), 400);
        expect(library.list()).toHaveLength(1); expect(library.versions(first.id)).toHaveLength(1);
    });
    it('refuses the fifty-first version without dropping or changing any saved work', () => {
        const { library } = setup(); let current = library.save({ name: 'Many saves', source: '0' });
        for (let i = 1; i < SCRIPT_LIBRARY_LIMITS.versionsPerScript; i++) current = library.save({ id: current.id, expectedRevision: current.revision, name: current.name, source: String(i) });
        expect(current.versions).toBe(50);
        status(() => library.save({ id: current.id, expectedRevision: current.revision, name: 'Unsaved new name', source: 'next' }), 413, 'CAPACITY_REACHED');
        expect(library.get(current.id)).toEqual(current); expect(library.version(current.id, 1).source).toBe('0');
        expect(library.versions(current.id)).toHaveLength(50);
        expect(library.clone(current.id, 'Continued study')).toMatchObject({ versions: 1, source: '49' });
    });
    it('counts archived scripts toward capacity and never evicts the oldest document', () => {
        const { library } = setup({ inMemory: true }); const first = library.save({ name: 'First', source: 'first' }); library.archive(first.id, 0);
        for (let i = 1; i < SCRIPT_LIBRARY_LIMITS.scripts; i++) library.save({ name: `Study ${i}`, source: '' });
        status(() => library.save({ name: 'One too many', source: '' }), 413, 'CAPACITY_REACHED');
        expect(library.list({ includeArchived: true })).toHaveLength(250); expect(library.get(first.id).source).toBe('first');
    });
    it('rolls back both document and version insertions if a database write fails', () => {
        const { db, library } = setup(); const first = library.save({ name: 'Before', source: 'plot(close)' });
        db.exec("CREATE TRIGGER reject_version BEFORE INSERT ON local_script_versions BEGIN SELECT RAISE(ABORT,'test rejection'); END;");
        expect(() => library.save({ id: first.id, expectedRevision: first.revision, name: 'After', source: 'plot(open)' })).toThrow('test rejection');
        expect(library.get(first.id)).toEqual(first); expect(library.versions(first.id)).toHaveLength(1);
        expect(() => library.save({ name: 'New rejected', source: '' })).toThrow('test rejection'); expect(library.list()).toHaveLength(1);
        db.exec('DROP TRIGGER reject_version');
        expect(library.save({ id: first.id, expectedRevision: first.revision, name: 'Recovered', source: '' }).revision).toBe(1);
    });
});

describe('reproducible saved strategy results', () => {
    it.each(['D', 'W', 'M', '2D', '2W', '3M', '90', '30S', '2h'])('saves a canonical supported timeframe %s without changing its spelling', timeframe => {
        const { library } = setup(); const input = snapshot({ timeframe });
        const saved = library.saveRun(input, 'Timeframe result');
        expect(library.getRun(saved.id).timeframe).toBe(timeframe);
    });
    it.each(['', '0', '0D', '1Y', '1H', '367D', '53W', '121M', '525601', '86401S', '1m;invalid'])('rejects a timeframe outside the shared parser contract: %s', timeframe => {
        const { library } = setup();
        status(() => library.saveRun(snapshot({ timeframe }), 'Invalid timeframe'), 400);
        expect(library.listRuns()).toEqual([]);
    });
    it('retains a typed client-reported normal provenance manifest without attesting execution', () => {
        const { library } = setup(); const input = snapshot();
        input.provenance = { version: 1, mode: 'replay', reportedBy: 'client', sessionId: randomUUID(), cursor: 10, cutoff: input.to,
            primarySourceDatasets: [{ id: input.datasetId, checksum: input.datasetChecksum }], secondarySourceDatasets: [{ id: randomUUID(), checksum: 'b'.repeat(64) }] };
        const saved = library.saveRun(input, 'Client report');
        expect(library.getRun(saved.id).provenance).toEqual(input.provenance);
        expect(library.listRuns()[0]!.provenance).toEqual(input.provenance);
        for (const provenance of [
            { ...input.provenance, reportedBy: 'engine-signed' }, { ...input.provenance, cutoff: input.to + 1 },
            { ...input.provenance, primarySourceDatasets: [] }, { ...input.provenance, secondarySourceDatasets: [{ id: input.datasetId, checksum: 'b'.repeat(64) }] },
            { ...input.provenance, cursor: -1 }, { ...input.provenance, sessionId: '../session' },
        ]) status(() => library.saveRun({ ...input, provenance } as BacktestSnapshot, 'Invalid provenance'), 400);
        expect(library.listRuns()).toHaveLength(1);
    });
    it('bounds known trade and equity timestamps to the recorded dates and rejects invalid numeric shapes', () => {
        const { library } = setup(); const input = snapshot();
        for (const result of [
            { trades: [{ entry: { time: input.from - 1, price: 100 } }] },
            { trades: [{ entry: { time: input.from, price: 100 }, exit: { time: input.to + 1, price: 101 } }] },
            { trades: [{ entry: { time: input.from + 2, price: 100 }, exit: { time: input.from + 1, price: 101 } }] },
            { equity: [{ time: input.to + 1, value: 50000 }] }, { trades: [{ entryTime: input.from - 1 }] },
            { state: { equity: '50000' } }, { state: { wins: 0.5 } }, { trades: [{ qty: '1' }] },
            { trades: [{ entry: { time: input.from, price: '100' } }] }, { equity: [{ time: input.from, value: '50000' }] },
        ]) status(() => library.saveRun({ ...input, result }, 'Invalid result'), 400);
        const valid = library.saveRun({ ...input, result: { state: { equity: 50000, wins: 1 },
            trades: [{ entry: { time: input.from, price: 100 }, exit: { time: input.to, price: 101 }, qty: 1 }],
            equity: [{ time: input.from, value: 50000 }, { time: input.to, value: 50001 }] } }, 'Within dates');
        expect(library.getRun(valid.id).result).toEqual(valid.result);
    });
    it('allows a selected deep window first-bucket label while rejecting earlier buckets and the exclusive end', () => {
        const { library } = setup(); const bucket = Date.UTC(2024, 3, 8, 14);
        const input = snapshot({ timeframe: '60', from: bucket + 1800000, to: bucket + 9000000 });
        input.history = { mode: 'deep', requestedFrom: input.from, requestedTo: input.to, barCount: 3,
            sourceDatasets: [{ id: input.datasetId, checksum: input.datasetChecksum }], checksum: 'b'.repeat(64) };
        const valid = library.saveRun({ ...input, result: { trades: [{ entry: { time: bucket, price: 100 }, exit: { time: bucket + 7200000, price: 101 } }] } }, 'Partial first bucket');
        expect(library.getRun(valid.id).result).toEqual(valid.result);
        for (const time of [bucket - 1, input.to]) status(() => library.saveRun({ ...input, result: { trades: [{ entry: { time, price: 100 } }] } }, 'Out of window'), 400);
        expect(library.listRuns()).toHaveLength(1);
    });
    it('reads an older stored record without revalidating or rewriting its historical result', () => {
        const { db, library } = setup(); const input = snapshot(); const runId = randomUUID();
        input.result = { trades: [{ entry: { time: input.to + 1000, price: 'legacy' } }] };
        const serialized = JSON.stringify(input);
        db.prepare('INSERT INTO local_strategy_runs(id,name,created_at,strategy_id,snapshot,summary) VALUES(?,?,?,NULL,?,?)')
            .run(runId, 'Legacy', '2026-10-20T00:00:00Z', serialized, '{}');
        expect(library.getRun(runId).result).toEqual(input.result);
        expect((db.prepare('SELECT snapshot FROM local_strategy_runs WHERE id=?').get(runId) as { snapshot: string }).snapshot).toBe(serialized);
    });
    it('round-trips source, dates, data hash, versions, settings and the full trade/equity result', () => {
        const { library, connect } = setup(); const input = snapshot();
        const stored = library.saveRun(input, 'April practice result');
        expect(stored).toEqual({ ...input, id: expect.any(String), name: 'April practice result', createdAt: expect.any(String) });
        input.inputs.length = 99; (input.result.trades as { fees: number }[])[0]!.fees = 100;
        expect(connect().library.getRun(stored.id).inputs.length).toBe(20);
        (stored.result.trades as { fees: number }[])[0]!.fees = 200;
        expect((library.getRun(stored.id).result.trades as { fees: number }[])[0]!.fees).toBe(5);
        const summary = library.listRuns()[0]!;
        expect(summary).toMatchObject({ id: stored.id, name: stored.name, datasetChecksum: input.datasetChecksum, engine: input.engine });
        for (const field of ['source', 'inputs', 'properties', 'result']) expect(summary).not.toHaveProperty(field);
        summary.engine.pinets = 'modified'; expect(library.listRuns()[0]!.engine.pinets).toBe('0.9.0');
    });
    it('pins a saved run to the exact immutable script source and filters runs by script', () => {
        const { library } = setup(); const doc = library.save({ name: 'Strategy', source: 'strategy("first")' });
        const historical = snapshot({ strategyId: doc.id, scriptVersion: 1, source: doc.source });
        const run = library.saveRun(historical, 'Original version');
        library.save({ id: doc.id, expectedRevision: doc.revision, name: 'Strategy', source: 'strategy("second")' });
        expect(library.saveRun(historical, 'Still reproducible').source).toBe(doc.source);
        status(() => library.saveRun({ ...historical, source: 'unmatched source' }, 'Mismatch'), 409, 'SCRIPT_VERSION_MISMATCH');
        status(() => library.saveRun({ ...historical, scriptVersion: 99 }, 'Missing version'), 404);
        status(() => library.saveRun({ ...historical, scriptVersion: 0 }, 'Invalid version'), 400);
        expect(library.listRuns(doc.id)).toHaveLength(2); expect(library.listRuns(randomUUID())).toEqual([]);
        expect(library.getRun(run.id).source).toBe(doc.source); status(() => library.getRun(randomUUID()), 404);
    });
    it('rejects malformed context instead of persisting an unreproducible record', () => {
        const { library } = setup();
        const invalid = [
            { source: null }, { scriptVersion: -1 }, { scriptVersion: 0.5 }, { strategyId: 'bad' }, { datasetId: '../path' }, { datasetChecksum: 'not-a-hash' },
            { symbol: 'NQ\n' }, { symbol: '' }, { timeframe: '0m' }, { timeframe: '1m;invalid' }, { from: -1 }, { to: Infinity }, { from: 2, to: 1 }, { from: 0.5 },
            { inputs: [] }, { properties: null }, { result: [] }, { engine: {} }, { engine: { pinets: 1 } }, { engine: { pinets: 'bad\nversion' } }, { engine: { pinets: 'x'.repeat(161) } },
        ];
        for (const overrides of invalid) status(() => library.saveRun(snapshot(overrides as Partial<BacktestSnapshot>), 'Invalid'), 400);
        status(() => library.saveRun({ ...snapshot(), extra: true } as BacktestSnapshot, 'Unknown field'), 400);
        expect(library.listRuns()).toEqual([]);
    });
    it('rejects non-finite, non-JSON, cyclic and dangerous nested values', () => {
        const { library } = setup(); const cycle: Record<string, unknown> = {}; cycle.self = cycle;
        const sparse = Array(4); sparse[3] = 1;
        for (const result of [
            { value: NaN }, { nested: [Infinity] }, { missing: undefined }, { big: 1n }, { method() {} }, { createdAt: new Date() },
            cycle, JSON.parse('{"nested":{"__proto__":{"bad":true}}}'), { nested: { constructor: 'bad' } }, { values: sparse },
        ]) status(() => library.saveRun(snapshot({ result }), 'Rejected'), 400);
        let deep: Record<string, unknown> = {}; const root = deep; for (let i = 0; i < 26; i++) { const child = {}; deep.nested = child; deep = child; }
        status(() => library.saveRun(snapshot({ result: root }), 'Too deep'), 413);
        expect(library.listRuns()).toEqual([]);
    });
    it('enforces run bytes and result count before inserting, retaining all existing runs', () => {
        const { db, library } = setup(); const existing = library.saveRun(snapshot(), 'Preserved');
        status(() => library.saveRun(snapshot({ result: { value: 'x'.repeat(SCRIPT_LIBRARY_LIMITS.runBytes) } }), 'Too large'), 413, 'CAPACITY_REACHED');
        const template = db.prepare('SELECT * FROM local_strategy_runs WHERE id=?').get(existing.id) as { name: string; created_at: string; snapshot: string; summary: string };
        const insert = db.prepare('INSERT INTO local_strategy_runs(id,name,created_at,strategy_id,snapshot,summary) VALUES(?,?,?,NULL,?,?)');
        db.exec('BEGIN IMMEDIATE');
        try {
            for (let i = 1; i < SCRIPT_LIBRARY_LIMITS.runs; i++) insert.run(randomUUID(), template.name, template.created_at, template.snapshot, template.summary);
            db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        status(() => library.saveRun(snapshot(), 'One too many'), 413, 'CAPACITY_REACHED');
        expect(library.listRuns()).toHaveLength(500); expect(library.getRun(existing.id).name).toBe('Preserved');
    });
    it('refuses writes over the shared byte budget atomically, including multibyte source', () => {
        const { db, library } = setup({ inMemory: true }); const first = library.save({ name: 'Keep me', source: 'plot(close)' });
        const inserted = library.saveRun(snapshot(), 'Large historical record');
        const runMetadata = db.prepare('SELECT summary FROM local_strategy_runs WHERE id=?').get(inserted.id) as { summary: string };
        const fixedBytes = (Buffer.byteLength(first.name) + Buffer.byteLength(first.source)) * 2
            + Buffer.byteLength(inserted.name) + Buffer.byteLength(runMetadata.summary);
        // Leave room for the ASCII source and its retained version, but not the same number of UTF-8 characters.
        db.prepare('UPDATE local_strategy_runs SET snapshot=CAST(zeroblob(?) AS TEXT) WHERE id=?').run(SCRIPT_LIBRARY_LIMITS.storedBytes - fixedBytes - 3000, inserted.id);
        const before = library.get(first.id);
        status(() => library.save({ id: first.id, expectedRevision: first.revision, name: 'Unsaved', source: 'é'.repeat(1000) }), 413, 'CAPACITY_REACHED');
        status(() => library.saveRun(snapshot({ result: { value: 'x'.repeat(4000) } }), 'Unsaved result'), 413, 'CAPACITY_REACHED');
        expect(library.get(first.id)).toEqual(before); expect(library.versions(first.id)).toHaveLength(1);
        expect((db.prepare('SELECT COUNT(*) AS count FROM local_strategy_runs').get() as { count: number }).count).toBe(1);
        expect(library.save({ id: first.id, expectedRevision: first.revision, name: 'Unsaved', source: 'e'.repeat(1000) }))
            .toMatchObject({ revision: 1, source: 'e'.repeat(1000) });
    });
    it('rolls back a rejected run insertion and leaves the connection usable', () => {
        const { db, library } = setup(); const original = library.saveRun(snapshot(), 'Before');
        db.exec("CREATE TRIGGER reject_run BEFORE INSERT ON local_strategy_runs BEGIN SELECT RAISE(ABORT,'test rejection'); END;");
        expect(() => library.saveRun(snapshot(), 'Rejected')).toThrow('test rejection'); expect(library.listRuns()).toHaveLength(1);
        expect(library.getRun(original.id).name).toBe('Before'); db.exec('DROP TRIGGER reject_run');
        expect(library.saveRun(snapshot(), 'Recovered').name).toBe('Recovered');
    });
});
