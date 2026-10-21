import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionView } from '../shared/types';
import { emptyScenarioContent, parseSaveScenario, SCENARIO_LIMITS, type SaveScenarioInput } from '../shared/scenarios';
import { ScenarioLibrary } from '../server/scenarios';
import { AppError } from '../server/errors';

const resources: { directory: string; connections: DatabaseSync[] }[] = [];
const times = [1000, 2000, 5000, 9000, 12000];
function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'vela-scenario-test-'));
    const resource = { directory, connections: [] as DatabaseSync[] }; resources.push(resource);
    const db = new DatabaseSync(join(directory, 'test.sqlite')); resource.connections.push(db);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE datasets(id TEXT PRIMARY KEY,checksum TEXT); CREATE TABLE bars(dataset_id TEXT,idx INTEGER,time INTEGER,PRIMARY KEY(dataset_id,idx));');
    const datasetId = randomUUID(), sessionId = randomUUID(), checksum = 'a'.repeat(64);
    db.prepare('INSERT INTO datasets VALUES(?,?)').run(datasetId, checksum);
    times.forEach((time, index) => db.prepare('INSERT INTO bars VALUES(?,?,?)').run(datasetId, index, time));
    // Only session/data identity and replay bounds belong to this seam; no account fixture or user DB.
    const view = { session: { id: sessionId, cursor: 2, config: { datasetId, startIndex: 0, endIndex: 5 } },
        dataset: { id: datasetId, checksum, barCount: 5 } } as SessionView;
    const library = new ScenarioLibrary(db);
    const input = (): SaveScenarioInput => ({ context: { sessionId, datasetId, datasetChecksum: checksum, cursor: 2, cutoff: 5000 },
        content: { ...emptyScenarioContent(), notes: 'Keep this local hypothesis', evidence: [{ kind: 'candle', sourceIndex: 1, time: 2000, note: 'Observed rejection' }] } });
    const connect = () => { const next = new DatabaseSync(join(directory, 'test.sqlite')); resource.connections.push(next); return new ScenarioLibrary(next); };
    return { db, view, library, input, connect };
}
function rejected(action: () => unknown, status: number, code?: string) {
    try { action(); expect.fail('Expected rejected scenario request.'); }
    catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(status); if (code) expect((error as AppError).code).toBe(code); }
}
afterEach(() => { for (const resource of resources.splice(0)) { resource.connections.forEach(db => db.close()); rmSync(resource.directory, { recursive: true, force: true }); } });

describe('bounded local scenario library', () => {
    it('persists notes and exact evidence provenance across independent SQLite connections', () => {
        const f = setup(), created = f.library.save(f.view, f.input());
        expect(created.id).toMatch(/^[a-f0-9-]{36}$/); expect(created.revision).toBe(0);
        expect(f.connect().get(f.view, created.id)).toEqual(created);
        expect(f.library.context(f.view)).toEqual(f.input().context);
        expect(f.library.list(f.view)[0]).toMatchObject({ id: created.id, title: 'Untitled scenario' });
        expect(JSON.stringify(created)).not.toMatch(/directory|account|position|orders|test\.sqlite/);
    });
    it('requires exact CAS and preserves another window update on conflict', () => {
        const f = setup(), other = f.connect(), first = f.library.save(f.view, f.input());
        const input = { ...f.input(), id: first.id, expectedRevision: 0 };
        const saved = other.save(f.view, { ...input, content: { ...input.content, notes: 'Other window' } });
        expect(saved.revision).toBe(1); rejected(() => f.library.save(f.view, input), 409, 'REVISION_CONFLICT');
        expect(f.library.get(f.view, first.id).content.notes).toBe('Other window');
    });
    it('rejects wrong dataset/checksum/session and forged or unrevealed evidence', () => {
        const f = setup();
        for (const context of [{ datasetId: randomUUID() }, { datasetChecksum: 'b'.repeat(64) }, { sessionId: randomUUID() }, { cursor: 3, cutoff: 9000 }, { cutoff: 4000 }]) {
            rejected(() => f.library.save(f.view, { ...f.input(), context: { ...f.input().context, ...context } }), 400);
        }
        for (const ref of [{ sourceIndex: 3, time: 9000 }, { sourceIndex: 1, time: 1000 }]) {
            const input = f.input(); input.content.evidence = [{ kind: 'candle', note: '', ...ref }]; rejected(() => f.library.save(f.view, input), 400);
        }
        expect(f.library.list(f.view)).toEqual([]);
    });
    it('does not infer timestamps from interval, permits projected future prices/times, and validates actual candle membership', () => {
        const f = setup(), input = f.input(); input.content.bull.projectedTime = 100_000; input.content.bull.targetPrice = 45000;
        expect(f.library.save(f.view, input).content.bull.projectedTime).toBe(100_000);
        f.view.session.config.startIndex = 2;
        rejected(() => f.library.save(f.view, f.input()), 400);
    });
    it('hides all later saved content and summaries on rewind, including notes edited on an older scenario', () => {
        const f = setup(), first = f.library.save(f.view, f.input());
        f.view.session.cursor = 4;
        const latest = f.library.save(f.view, { ...f.input(), id: first.id, expectedRevision: 0, content: { ...f.input().content, notes: 'Later knowledge' } });
        f.view.session.cursor = 2;
        expect(f.library.list(f.view, true)).toEqual([]); rejected(() => f.library.get(f.view, first.id), 404, 'EVIDENCE_UNAVAILABLE');
        rejected(() => f.library.save(f.view, { ...f.input(), id: first.id, expectedRevision: latest.revision }), 404, 'EVIDENCE_UNAVAILABLE');
        f.view.session.cursor = 4; expect(f.library.get(f.view, first.id).content.notes).toBe('Later knowledge');
    });
    it('scopes reads and archives to identity and CAS without losing archived records', () => {
        const f = setup(), first = f.library.save(f.view, f.input());
        const other = { ...f.view, session: { ...f.view.session, id: randomUUID() } };
        expect(f.library.list(other)).toEqual([]); rejected(() => f.library.get(other, first.id), 404);
        rejected(() => f.library.archive(f.view, first.id, 3), 409, 'REVISION_CONFLICT');
        const archived = f.library.archive(f.view, first.id, 0); expect(archived.archived).toBe(true);
        expect(f.library.list(f.view)).toEqual([]); expect(f.library.list(f.view, true)).toHaveLength(1);
        rejected(() => f.library.save(f.view, { ...f.input(), id: first.id, expectedRevision: archived.revision }), 409, 'SCENARIO_ARCHIVED');
    });
    it('rolls back a failed update and keeps the exact persisted notes and revision', () => {
        const f = setup(), first = f.library.save(f.view, f.input());
        f.db.exec("CREATE TRIGGER reject_scenario BEFORE UPDATE ON local_scenarios BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
        expect(() => f.library.save(f.view, { ...f.input(), id: first.id, expectedRevision: 0, content: { ...f.input().content, notes: 'Not committed' } })).toThrow();
        expect(f.library.get(f.view, first.id)).toEqual(first);
    });
    it('bounds total records including archives and never evicts notes', () => {
        const f = setup(), first = f.library.save(f.view, f.input()); f.library.archive(f.view, first.id, 0);
        for (let i = 1; i < SCENARIO_LIMITS.records; i++) f.library.save(f.view, f.input());
        rejected(() => f.library.save(f.view, f.input()), 413, 'CAPACITY_REACHED'); expect(f.library.get(f.view, first.id).content.notes).toBe(f.input().content.notes);
    });
    it('bounds total payload bytes independently of record count and keeps existing work', () => {
        const f = setup(), input = f.input(); input.content.notes = 'n'.repeat(8000);
        for (const side of ['bull', 'bear'] as const) { input.content[side].thesis = 't'.repeat(4000); input.content[side].trigger = 't'.repeat(2000); input.content[side].invalidation = 'i'.repeat(2000); }
        input.content.evidence = [];
        // Unicode text consumes bytes independently of the bounded character counts.
        input.content.notes = '漢'.repeat(8000); input.content.bull.thesis = '漢'.repeat(4000); input.content.bear.thesis = '漢'.repeat(4000);
        const first = f.library.save(f.view, input); let count = 1;
        for (; count < SCENARIO_LIMITS.records; count++) {
            try { f.library.save(f.view, input); } catch (error) { expect(error).toMatchObject({ status: 413, code: 'CAPACITY_REACHED' }); break; }
        }
        expect(count).toBeLessThan(SCENARIO_LIMITS.records); expect(f.library.get(f.view, first.id)).toEqual(first);
    });
});

describe('scenario plain JSON boundary', () => {
    it('rejects accessors without calling them, prototypes, symbols, unknown keys and non-finite levels', () => {
        const f = setup(), getter = vi.fn(() => 'secret');
        const bad = { ...f.input() }; Object.defineProperty(bad, 'context', { get: getter, enumerable: true });
        expect(() => parseSaveScenario(bad)).toThrow(); expect(getter).not.toHaveBeenCalled();
        const arrayGetter = f.input(); Object.defineProperty(arrayGetter.content.evidence, '0', { get: getter, enumerable: true });
        expect(() => parseSaveScenario(arrayGetter)).toThrow(); expect(getter).not.toHaveBeenCalled();
        for (const value of [Object.assign(Object.create({}), f.input()), { ...f.input(), [Symbol('secret')]: true }, { ...f.input(), probability: 0.9 },
            { ...f.input(), expectedRevision: 0 }, JSON.parse('{"__proto__":{},"context":{},"content":{}}')]) expect(() => parseSaveScenario(value)).toThrow();
        for (const price of [NaN, Infinity, -Infinity, 1e13]) { const input = f.input(); input.content.bear.triggerPrice = price; expect(() => parseSaveScenario(input)).toThrow(); }
    });
    it('bounds text, rejects malformed Unicode and finite JSON violations without exposing rejected text', () => {
        const f = setup();
        for (const notes of ['x'.repeat(8001), '\ud800', '\udfff', 'not\0text']) {
            const input = f.input(); input.content.notes = notes; rejected(() => f.library.save(f.view, input), 400);
        }
        const input = f.input(); input.content.notes = 'A valid pair 😀 and newline\n'; expect(f.library.save(f.view, input).content.notes).toBe(input.content.notes);
        const extra = { ...f.input(), filePath: 'C:/private/credential' };
        try { f.library.save(f.view, extra); expect.fail('Rejected data expected.'); } catch (error) { expect((error as Error).message).not.toMatch(/private|credential/); }
    });
});
