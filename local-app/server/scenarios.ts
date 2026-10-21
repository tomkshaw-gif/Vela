import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionView } from '../shared/types';
import type { ScenarioContext, ScenarioDocument, ScenarioSummary, SaveScenarioInput } from '../shared/scenarios';
import { parseSaveScenario, parseScenarioContext, scenarioId, scenarioInteger, SCENARIO_LIMITS } from '../shared/scenarios';
import { AppError } from './errors';

type Row = {
    id: string; session_id: string; dataset_id: string; checksum: string; cursor: number; cutoff: number;
    available_cursor: number; title: string; content: string; revision: number; archived: number; created_at: string; updated_at: string;
};
function context(row: Row): ScenarioContext {
    return { sessionId: row.session_id, datasetId: row.dataset_id, datasetChecksum: row.checksum, cursor: row.cursor, cutoff: row.cutoff };
}
function summary(row: Row): ScenarioSummary {
    return { id: row.id, title: row.title, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, archived: row.archived === 1, context: context(row) };
}
function document(row: Row): ScenarioDocument { return { ...summary(row), content: JSON.parse(row.content) as ScenarioDocument['content'] }; }
function validate<T>(action: () => T): T {
    try { return action(); } catch { throw new AppError(400, 'Invalid scenario request. Use bounded plain JSON and finite levels.'); }
}

/** Standalone hypotheses only. The caller owns the SQLite connection and trusted SessionView. */
export class ScenarioLibrary {
    constructor(private readonly db: DatabaseSync) {
        db.exec(`CREATE TABLE IF NOT EXISTS local_scenarios(
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, dataset_id TEXT NOT NULL, checksum TEXT NOT NULL,
          cursor INTEGER NOT NULL, cutoff INTEGER NOT NULL, available_cursor INTEGER NOT NULL,
          title TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS local_scenarios_context ON local_scenarios(session_id,dataset_id,checksum,available_cursor);`);
    }
    context(view: SessionView): ScenarioContext {
        const datasetId = validate(() => scenarioId(view.dataset.id));
        const sessionId = validate(() => scenarioId(view.session.id));
        const cursor = validate(() => scenarioInteger(view.session.cursor));
        if (view.session.config.datasetId !== datasetId || cursor < view.session.config.startIndex
            || cursor >= (view.session.config.endIndex ?? view.dataset.barCount)) throw new AppError(400, 'A revealed session candle is required for a scenario.');
        const dataset = this.db.prepare('SELECT checksum FROM datasets WHERE id=?').get(datasetId) as { checksum: string } | undefined;
        if (!dataset || dataset.checksum !== view.dataset.checksum) throw new AppError(400, 'Scenario dataset identity does not match the current local data.');
        const candle = this.candle(datasetId, cursor);
        if (!candle) throw new AppError(400, 'Scenario replay cutoff is unavailable.');
        return validate(() => parseScenarioContext({ sessionId, datasetId, datasetChecksum: dataset.checksum, cursor, cutoff: candle.time }));
    }
    list(view: SessionView, includeArchived = false): ScenarioSummary[] {
        if (typeof includeArchived !== 'boolean') throw new AppError(400, 'Invalid scenario archive filter.');
        const current = this.context(view);
        const rows = this.db.prepare(`SELECT * FROM local_scenarios WHERE session_id=? AND dataset_id=? AND checksum=?
          AND available_cursor<=? AND cursor<=? AND cutoff<=? ${includeArchived ? '' : 'AND archived=0'} ORDER BY updated_at DESC,id`)
            .all(current.sessionId, current.datasetId, current.datasetChecksum, current.cursor, current.cursor, current.cutoff) as Row[];
        return rows.map(summary);
    }
    get(view: SessionView, id: string): ScenarioDocument { return document(this.row(this.context(view), validate(() => scenarioId(id)))); }
    save(view: SessionView, raw: SaveScenarioInput): ScenarioDocument {
        const input = validate(() => parseSaveScenario(raw));
        const current = this.context(view), captured = input.context;
        if (captured.sessionId !== current.sessionId || captured.datasetId !== current.datasetId || captured.datasetChecksum !== current.datasetChecksum
            || captured.cursor > current.cursor || captured.cursor < view.session.config.startIndex || captured.cutoff > current.cutoff
            || this.candle(current.datasetId, captured.cursor)?.time !== captured.cutoff) throw new AppError(400, 'Scenario context must match revealed local replay data.');
        const seen = new Set<number>();
        for (const ref of input.content.evidence) {
            if (ref.sourceIndex < view.session.config.startIndex || ref.sourceIndex > captured.cursor || ref.time > captured.cutoff
                || this.candle(current.datasetId, ref.sourceIndex)?.time !== ref.time || seen.has(ref.sourceIndex)) throw new AppError(400, 'Scenario evidence must reference distinct revealed candles at the captured replay cutoff.');
            seen.add(ref.sourceIndex);
        }
        const payload = JSON.stringify(input.content);
        if (Buffer.byteLength(JSON.stringify(input)) > SCENARIO_LIMITS.bytes) throw new AppError(413, 'Scenario exceeds the local size limit.');
        return this.transaction(() => {
            const previous = input.id === undefined ? undefined : this.row(current, input.id);
            if (previous && previous.revision !== input.expectedRevision) throw new AppError(409, 'Scenario changed in another window. Your draft is preserved.', 'REVISION_CONFLICT');
            if (previous?.archived) throw new AppError(409, 'This scenario is archived. Save a new scenario to continue.', 'SCENARIO_ARCHIVED');
            const usage = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(content AS BLOB))+length(CAST(title AS BLOB))),0) AS bytes FROM local_scenarios').get() as { count: number; bytes: number };
            const nextBytes = usage.bytes + Buffer.byteLength(payload) + Buffer.byteLength(input.content.title)
                - (previous ? Buffer.byteLength(previous.content) + Buffer.byteLength(previous.title) : 0);
            if ((!previous && usage.count >= SCENARIO_LIMITS.records) || nextBytes > SCENARIO_LIMITS.storedBytes) throw new AppError(413, 'The local scenario notebook is full. Existing notes are preserved.', 'CAPACITY_REACHED');
            const id = previous?.id ?? randomUUID(), now = new Date().toISOString();
            const available = Math.max(previous?.available_cursor ?? 0, current.cursor);
            if (previous) {
                this.db.prepare(`UPDATE local_scenarios SET cursor=?,cutoff=?,available_cursor=?,title=?,content=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?`)
                    .run(captured.cursor, captured.cutoff, available, input.content.title, payload, now, id, input.expectedRevision!);
            } else {
                this.db.prepare(`INSERT INTO local_scenarios(id,session_id,dataset_id,checksum,cursor,cutoff,available_cursor,title,content,revision,archived,created_at,updated_at)
                  VALUES(?,?,?,?,?,?,?,?,?,0,0,?,?)`).run(id, captured.sessionId, captured.datasetId, captured.datasetChecksum, captured.cursor, captured.cutoff, available, input.content.title, payload, now, now);
            }
            return document(this.row(current, id));
        });
    }
    archive(view: SessionView, id: string, expectedRevision: number): ScenarioDocument {
        validate(() => scenarioId(id)); validate(() => scenarioInteger(expectedRevision)); const current = this.context(view);
        return this.transaction(() => {
            const previous = this.row(current, id);
            if (previous.revision !== expectedRevision) throw new AppError(409, 'Scenario changed in another window. Your draft is preserved.', 'REVISION_CONFLICT');
            if (previous.archived) return document(previous);
            this.db.prepare('UPDATE local_scenarios SET archived=1,revision=revision+1,updated_at=?,available_cursor=? WHERE id=? AND revision=?')
                .run(new Date().toISOString(), Math.max(previous.available_cursor, current.cursor), id, expectedRevision);
            return document(this.row(current, id));
        });
    }
    private candle(datasetId: string, index: number): { time: number } | undefined {
        return this.db.prepare('SELECT time FROM bars WHERE dataset_id=? AND idx=?').get(datasetId, index) as { time: number } | undefined;
    }
    private row(current: ScenarioContext, id: string): Row {
        const row = this.db.prepare('SELECT * FROM local_scenarios WHERE id=? AND session_id=? AND dataset_id=? AND checksum=?')
            .get(id, current.sessionId, current.datasetId, current.datasetChecksum) as Row | undefined;
        if (!row) throw new AppError(404, 'Scenario is unavailable in this session and dataset.', 'NOT_FOUND');
        if (row.available_cursor > current.cursor || row.cursor > current.cursor || row.cutoff > current.cutoff) throw new AppError(404, 'Scenario is unavailable before its last saved replay candle. Advance the replay to reveal it.', 'EVIDENCE_UNAVAILABLE');
        return row;
    }
    private transaction<T>(action: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = action(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); if (error instanceof AppError) throw error; throw new AppError(500, 'Scenario storage failed. Your draft is preserved.', 'STORAGE_FAILED'); }
    }
}
