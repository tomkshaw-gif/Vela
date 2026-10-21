import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BacktestSnapshot, BacktestSummary, ReplayBacktestProvenance, SaveScriptInput, ScriptDocument, ScriptSummary, ScriptVersion, ScriptVersionSummary, StoredBacktest } from '../shared/scripts';
import { parseTimeframe, timeframeBucket } from '../shared/timeframes';
import { AppError, text } from './errors';
import { validateDeepHistory } from './deep-history';

export const SCRIPT_LIBRARY_LIMITS = Object.freeze({
    scripts: 250, versionsPerScript: 50, runs: 500, sourceCharacters: 200_000,
    runBytes: 16 * 1024 * 1024, storedBytes: 100 * 1024 * 1024,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ScriptRow = { id: string; name: string; source: string; revision: number; created_at: string; updated_at: string; archived: number; versions: number };
type VersionRow = { script_id: string; version: number; name: string; source: string; created_at: string };
type RunRow = { id: string; name: string; created_at: string; snapshot: string };

function id(value: unknown, label = 'script id'): string {
    if (typeof value !== 'string' || !UUID.test(value)) throw new AppError(400, `Invalid ${label}.`);
    return value;
}
function revision(value: unknown, label = 'expected revision'): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AppError(400, `Invalid ${label}.`);
    return value;
}
function source(value: unknown): string {
    if (typeof value !== 'string' || value.length > SCRIPT_LIBRARY_LIMITS.sourceCharacters || value.includes('\0') || Buffer.from(value).toString() !== value) throw new AppError(400, 'Invalid script source. Use at most 200,000 characters of valid text.');
    return value;
}
function name(value: unknown): string {
    const result = text(value, 'script name');
    if (Buffer.from(result).toString() !== result) throw new AppError(400, 'Invalid script name.');
    return result;
}
function plainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exactObject(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
    if (!plainObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new AppError(400, 'Invalid script library request.');
}
function jsonObject(value: unknown, label: string): Record<string, unknown> {
    if (!plainObject(value)) throw new AppError(400, `Invalid ${label}.`);
    let nodes = 0;
    const seen = new Set<object>();
    const walk = (item: unknown, depth: number): void => {
        if (++nodes > 1_000_000 || depth > 24) throw new AppError(413, `${label} is too complex.`);
        if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
        if (typeof item === 'number' && Number.isFinite(item)) return;
        if (typeof item !== 'object' || !item || (!Array.isArray(item) && !plainObject(item)) || seen.has(item)) throw new AppError(400, `${label} must contain finite JSON data.`);
        if (Object.getOwnPropertySymbols(item).length) throw new AppError(400, `${label} must contain JSON fields.`);
        if (Array.isArray(item) && (Object.getPrototypeOf(item) !== Array.prototype || item.length > 1_000_000 || Object.keys(item).length !== item.length)) throw new AppError(400, `${label} must contain ordinary dense JSON arrays.`);
        seen.add(item);
        for (const key of Object.keys(item)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new AppError(400, `Invalid ${label} field.`);
            walk((item as Record<string, unknown>)[key], depth + 1);
        }
        seen.delete(item);
    };
    walk(value, 0);
    return value;
}
function resultTime(value: unknown, snapshot: BacktestSnapshot): number {
    const from = snapshot.history === undefined ? snapshot.from : timeframeBucket(snapshot.from, parseTimeframe(snapshot.timeframe)!);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < from || value > snapshot.to
        || snapshot.history !== undefined && value === snapshot.to) throw new AppError(400, 'Strategy result timestamps must remain within the recorded date bounds.');
    return value;
}
function knownNumbers(row: Record<string, unknown>, fields: readonly string[]): void {
    for (const field of fields) if (Object.hasOwn(row, field) && row[field] !== null
        && (typeof row[field] !== 'number' || !Number.isFinite(row[field]))) throw new AppError(400, `Invalid strategy result ${field}.`);
}
function validateResult(snapshot: BacktestSnapshot): void {
    const result = snapshot.result;
    if (result.state !== undefined) {
        if (!plainObject(result.state)) throw new AppError(400, 'Invalid strategy account state.');
        knownNumbers(result.state, ['position', 'avgPrice', 'equity', 'openPnl', 'netPnl', 'grossProfit', 'grossLoss', 'wins', 'losses', 'even', 'maxDrawdown', 'maxRunup', 'initialCapital']);
        for (const field of ['wins', 'losses', 'even']) if (result.state[field] !== undefined && result.state[field] !== null
            && (!Number.isSafeInteger(result.state[field]) || (result.state[field] as number) < 0)) throw new AppError(400, 'Invalid strategy outcome count.');
    }
    if (result.trades !== undefined) {
        if (!Array.isArray(result.trades) || result.trades.length > 250_000) throw new AppError(400, 'Invalid strategy trade ledger.');
        for (const trade of result.trades) {
            if (!plainObject(trade)) throw new AppError(400, 'Invalid strategy trade.');
            knownNumbers(trade, ['qty', 'pnl', 'commission', 'maxDrawdown', 'maxRunup', 'entryPrice', 'exitPrice', 'fees']);
            if (trade.side !== undefined && trade.side !== 'long' && trade.side !== 'short') throw new AppError(400, 'Invalid strategy trade side.');
            if (trade.open !== undefined && typeof trade.open !== 'boolean') throw new AppError(400, 'Invalid strategy trade state.');
            let entry: number | undefined, exit: number | undefined;
            for (const field of ['entry', 'exit'] as const) if (trade[field] !== undefined) {
                const fill = trade[field];
                if (!plainObject(fill)) throw new AppError(400, 'Invalid strategy fill.');
                knownNumbers(fill, ['price']);
                const time = resultTime(fill.time, snapshot);
                if (field === 'entry') entry = time; else exit = time;
            }
            if (trade.entryTime !== undefined) entry = resultTime(trade.entryTime, snapshot);
            if (trade.exitTime !== undefined) exit = resultTime(trade.exitTime, snapshot);
            if (entry !== undefined && exit !== undefined && exit < entry) throw new AppError(400, 'A strategy exit cannot precede its entry.');
        }
    }
    if (result.equity !== undefined) {
        if (!Array.isArray(result.equity) || result.equity.length > 250_000) throw new AppError(400, 'Invalid strategy equity history.');
        for (const point of result.equity) {
            if (typeof point === 'number') continue;
            if (!plainObject(point) || !Object.hasOwn(point, 'value')) throw new AppError(400, 'Invalid strategy equity point.');
            resultTime(point.time, snapshot); knownNumbers(point, ['value']);
        }
    }
    if (result.warnings !== undefined && (!Array.isArray(result.warnings) || result.warnings.length > 1000
        || result.warnings.some(warning => typeof warning !== 'string' || warning.length > 4000))) throw new AppError(400, 'Invalid strategy warnings.');
}
/** Checks reported references and bounds, without claiming the engine executed them. */
function validateProvenance(snapshot: BacktestSnapshot): ReplayBacktestProvenance {
    const value = snapshot.provenance;
    jsonObject(value, 'Backtest provenance');
    exactObject(value, ['version', 'mode', 'reportedBy', 'sessionId', 'cursor', 'cutoff', 'primarySourceDatasets', 'secondarySourceDatasets']);
    if (value.version !== 1 || value.mode !== 'replay' || value.reportedBy !== 'client' || snapshot.history !== undefined
        || !Number.isSafeInteger(value.cursor) || (value.cursor as number) < 0 || value.cutoff !== snapshot.to) throw new AppError(400, 'Invalid replay backtest provenance.');
    id(value.sessionId, 'provenance session id');
    const seen = new Map<string, string>();
    for (const field of ['primarySourceDatasets', 'secondarySourceDatasets'] as const) {
        const references = value[field];
        if (!Array.isArray(references) || references.length > 200 || field === 'primarySourceDatasets' && references.length === 0) throw new AppError(400, 'Invalid backtest dataset provenance.');
        const unique = new Set<string>();
        for (const reference of references) {
            exactObject(reference, ['id', 'checksum']);
            const datasetId = id(reference.id, 'provenance dataset id');
            if (unique.has(datasetId) || typeof reference.checksum !== 'string' || !/^[0-9a-f]{64}$/i.test(reference.checksum)
                || seen.has(datasetId) && seen.get(datasetId) !== reference.checksum) throw new AppError(400, 'Invalid or conflicting backtest dataset provenance.');
            unique.add(datasetId); seen.set(datasetId, reference.checksum);
        }
    }
    if (!(value.primarySourceDatasets as { id: string; checksum: string }[]).some(reference => reference.id === snapshot.datasetId && reference.checksum === snapshot.datasetChecksum)) throw new AppError(400, 'The primary backtest provenance must include the recorded dataset checksum.');
    return value as unknown as ReplayBacktestProvenance;
}
function summary(row: ScriptRow): ScriptSummary {
    return { id: row.id, name: row.name, revision: row.revision, versions: row.versions, createdAt: row.created_at, updatedAt: row.updated_at, archived: row.archived === 1 };
}
function document(row: ScriptRow): ScriptDocument { return { ...summary(row), source: row.source }; }
function versionDocument(row: VersionRow): ScriptVersion {
    return { scriptId: row.script_id, version: row.version, name: row.name, source: row.source, createdAt: row.created_at };
}

/** Uses the application's SQLite connection. Capacity errors never prune documents or history. */
export class ScriptLibrary {
    constructor(private readonly db: DatabaseSync) {
        db.exec(`CREATE TABLE IF NOT EXISTS local_scripts(
          id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, revision INTEGER NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS local_script_versions(
          script_id TEXT NOT NULL REFERENCES local_scripts(id), version INTEGER NOT NULL,
          name TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(script_id,version)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS local_strategy_runs(
          id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, strategy_id TEXT, snapshot TEXT NOT NULL, summary TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS local_scripts_updated ON local_scripts(updated_at DESC);
          CREATE INDEX IF NOT EXISTS local_strategy_runs_created ON local_strategy_runs(created_at DESC);
          CREATE INDEX IF NOT EXISTS local_strategy_runs_script ON local_strategy_runs(strategy_id);`);
    }
    list(options: { includeArchived?: boolean } = {}): ScriptSummary[] {
        exactObject(options, ['includeArchived']);
        if (options.includeArchived !== undefined && typeof options.includeArchived !== 'boolean') throw new AppError(400, 'Invalid archive filter.');
        return (this.db.prepare(`SELECT s.id,s.name,s.revision,s.created_at,s.updated_at,s.archived,
          (SELECT COUNT(*) FROM local_script_versions v WHERE v.script_id=s.id) AS versions
          FROM local_scripts s ${options.includeArchived ? '' : 'WHERE s.archived=0'} ORDER BY s.updated_at DESC,s.id`).all() as ScriptRow[]).map(summary);
    }
    get(scriptId: string): ScriptDocument { return document(this.row(id(scriptId))); }
    save(input: SaveScriptInput): ScriptDocument {
        exactObject(input, ['id', 'expectedRevision', 'name', 'source']);
        const nextName = name(input.name); const nextSource = source(input.source);
        const existingId = input.id === undefined ? undefined : id(input.id);
        const expected = existingId === undefined ? undefined : revision(input.expectedRevision);
        if (existingId === undefined && input.expectedRevision !== undefined) throw new AppError(400, 'A new script cannot have an expected revision.');
        return this.transaction(() => {
            const previous = existingId === undefined ? undefined : this.row(existingId);
            if (previous && previous.revision !== expected) throw new AppError(409, 'Script changed. Reload it before saving.', 'REVISION_CONFLICT');
            if (previous?.archived) throw new AppError(409, 'Restore this script before editing it.', 'SCRIPT_ARCHIVED');
            if (previous && previous.name === nextName && previous.source === nextSource) return document(previous);
            if (!previous && this.count('local_scripts') >= SCRIPT_LIBRARY_LIMITS.scripts) throw new AppError(413, 'The local script library is full. Export documents before making space.', 'CAPACITY_REACHED');
            if (previous && previous.versions >= SCRIPT_LIBRARY_LIMITS.versionsPerScript) throw new AppError(413, 'This script has 50 saved versions. Clone it to continue without losing history.', 'CAPACITY_REACHED');
            const payloadBytes = Buffer.byteLength(nextName) + Buffer.byteLength(nextSource);
            this.capacity(payloadBytes * 2 - (previous ? Buffer.byteLength(previous.name) + Buffer.byteLength(previous.source) : 0));
            const scriptId = previous?.id ?? randomUUID(); const now = new Date().toISOString();
            if (previous) this.db.prepare('UPDATE local_scripts SET name=?,source=?,revision=?,updated_at=? WHERE id=? AND revision=?').run(nextName, nextSource, previous.revision + 1, now, scriptId, expected!);
            else this.db.prepare('INSERT INTO local_scripts(id,name,source,revision,created_at,updated_at,archived) VALUES(?,?,?,0,?,?,0)').run(scriptId, nextName, nextSource, now, now);
            this.db.prepare('INSERT INTO local_script_versions(script_id,version,name,source,created_at) VALUES(?,?,?,?,?)').run(scriptId, (previous?.versions ?? 0) + 1, nextName, nextSource, now);
            return document(this.row(scriptId));
        });
    }
    clone(scriptId: string, nextName: string): ScriptDocument {
        const original = this.get(scriptId);
        return this.save({ name: nextName, source: original.source });
    }
    archive(scriptId: string, expectedRevision: number): ScriptDocument { return this.setArchived(scriptId, expectedRevision, true); }
    restore(scriptId: string, expectedRevision: number): ScriptDocument { return this.setArchived(scriptId, expectedRevision, false); }
    versions(scriptId: string): ScriptVersionSummary[] {
        this.get(scriptId);
        return (this.db.prepare('SELECT script_id,version,name,created_at FROM local_script_versions WHERE script_id=? ORDER BY version DESC').all(scriptId) as VersionRow[]).map(row => ({ scriptId: row.script_id, version: row.version, name: row.name, createdAt: row.created_at }));
    }
    version(scriptId: string, savedVersion: number): ScriptVersion {
        id(scriptId); revision(savedVersion, 'script version');
        if (savedVersion < 1) throw new AppError(400, 'Invalid script version.');
        const row = this.db.prepare('SELECT script_id,version,name,source,created_at FROM local_script_versions WHERE script_id=? AND version=?').get(scriptId, savedVersion) as VersionRow | undefined;
        if (!row) throw new AppError(404, 'Script version not found.', 'NOT_FOUND');
        return versionDocument(row);
    }
    saveRun(snapshot: BacktestSnapshot, runName: string): StoredBacktest {
        exactObject(snapshot, ['strategyId', 'scriptVersion', 'source', 'symbol', 'timeframe', 'datasetId', 'datasetChecksum', 'from', 'to', 'inputs', 'properties', 'engine', 'result', 'history', 'provenance']);
        const nextName = name(runName); source(snapshot.source); revision(snapshot.scriptVersion, 'script version');
        if (snapshot.strategyId !== undefined) id(snapshot.strategyId);
        id(snapshot.datasetId, 'dataset id');
        if (typeof snapshot.symbol !== 'string' || !/^[a-z0-9][a-z0-9._:/!+\-]{0,63}$/i.test(snapshot.symbol)) throw new AppError(400, 'Invalid strategy symbol.');
        if (typeof snapshot.timeframe !== 'string' || !parseTimeframe(snapshot.timeframe)) throw new AppError(400, 'Invalid strategy timeframe.');
        if (typeof snapshot.datasetChecksum !== 'string' || !/^[0-9a-f]{64}$/i.test(snapshot.datasetChecksum)) throw new AppError(400, 'Invalid dataset checksum.');
        for (const value of [snapshot.from, snapshot.to]) if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new AppError(400, 'Invalid strategy date bounds.');
        if (snapshot.from > snapshot.to) throw new AppError(400, 'Invalid strategy date bounds.');
        jsonObject(snapshot.inputs, 'Strategy inputs'); jsonObject(snapshot.properties, 'Strategy properties'); jsonObject(snapshot.result, 'Strategy result');
        validateResult(snapshot);
        if (snapshot.history !== undefined) {
            const history = validateDeepHistory(snapshot.history);
            if (history.requestedFrom !== snapshot.from || history.requestedTo !== snapshot.to) throw new AppError(400, 'Deep history dates must match the saved report.');
        }
        if (snapshot.provenance !== undefined) validateProvenance(snapshot);
        const engine = jsonObject(snapshot.engine, 'Engine versions');
        if (!Object.keys(engine).length || Object.keys(engine).length > 32 || Object.entries(engine).some(([key, value]) => !/^[a-z][a-z0-9._-]{0,63}$/i.test(key) || typeof value !== 'string' || !value || value.length > 160 || /[\u0000-\u001f]/.test(value))) throw new AppError(400, 'Invalid engine versions.');
        const serialized = JSON.stringify(snapshot);
        if (Buffer.byteLength(serialized) > SCRIPT_LIBRARY_LIMITS.runBytes) throw new AppError(413, 'The strategy result exceeds the 16 MiB saved-run limit.', 'CAPACITY_REACHED');
        return this.transaction(() => {
            if (snapshot.strategyId !== undefined) {
                const saved = this.version(snapshot.strategyId, snapshot.scriptVersion);
                if (saved.source !== snapshot.source) throw new AppError(409, 'The run source does not match the saved script version.', 'SCRIPT_VERSION_MISMATCH');
            }
            if (this.count('local_strategy_runs') >= SCRIPT_LIBRARY_LIMITS.runs) throw new AppError(413, 'The saved strategy run library is full.', 'CAPACITY_REACHED');
            const runId = randomUUID(); const now = new Date().toISOString();
            const summary = JSON.stringify({ id: runId, name: nextName, createdAt: now, ...(snapshot.strategyId === undefined ? {} : { strategyId: snapshot.strategyId }), scriptVersion: snapshot.scriptVersion, symbol: snapshot.symbol, timeframe: snapshot.timeframe, datasetId: snapshot.datasetId, datasetChecksum: snapshot.datasetChecksum, from: snapshot.from, to: snapshot.to, engine: snapshot.engine, ...(snapshot.history === undefined ? {} : { history: snapshot.history }), ...(snapshot.provenance === undefined ? {} : { provenance: snapshot.provenance }) } satisfies BacktestSummary);
            this.capacity(Buffer.byteLength(serialized) + Buffer.byteLength(nextName) + Buffer.byteLength(summary));
            this.db.prepare('INSERT INTO local_strategy_runs(id,name,created_at,strategy_id,snapshot,summary) VALUES(?,?,?,?,?,?)').run(runId, nextName, now, snapshot.strategyId ?? null, serialized, summary);
            return this.getRun(runId);
        });
    }
    listRuns(strategyId?: string): BacktestSummary[] {
        if (strategyId !== undefined) id(strategyId);
        const rows = (strategyId === undefined
            ? this.db.prepare('SELECT summary FROM local_strategy_runs ORDER BY created_at DESC,id').all()
            : this.db.prepare('SELECT summary FROM local_strategy_runs WHERE strategy_id=? ORDER BY created_at DESC,id').all(strategyId)) as { summary: string }[];
        return rows.map(row => JSON.parse(row.summary) as BacktestSummary);
    }
    getRun(runId: string): StoredBacktest {
        id(runId, 'strategy run id');
        const row = this.db.prepare('SELECT id,name,created_at,snapshot FROM local_strategy_runs WHERE id=?').get(runId) as RunRow | undefined;
        if (!row) throw new AppError(404, 'Strategy run not found.', 'NOT_FOUND');
        return { ...(JSON.parse(row.snapshot) as BacktestSnapshot), id: row.id, name: row.name, createdAt: row.created_at };
    }
    private row(scriptId: string): ScriptRow {
        const row = this.db.prepare(`SELECT s.*,(SELECT COUNT(*) FROM local_script_versions v WHERE v.script_id=s.id) AS versions FROM local_scripts s WHERE s.id=?`).get(scriptId) as ScriptRow | undefined;
        if (!row) throw new AppError(404, 'Script not found.', 'NOT_FOUND');
        return row;
    }
    private setArchived(scriptId: string, expectedRevision: number, archived: boolean): ScriptDocument {
        id(scriptId); revision(expectedRevision);
        return this.transaction(() => {
            const previous = this.row(scriptId);
            if (previous.revision !== expectedRevision) throw new AppError(409, 'Script changed. Reload it before continuing.', 'REVISION_CONFLICT');
            if (previous.archived === Number(archived)) return document(previous);
            this.db.prepare('UPDATE local_scripts SET archived=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(Number(archived), new Date().toISOString(), scriptId, expectedRevision);
            return document(this.row(scriptId));
        });
    }
    private count(table: 'local_scripts' | 'local_strategy_runs'): number {
        return (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    }
    private capacity(additionalBytes: number): void {
        const usage = this.db.prepare(`SELECT
          COALESCE((SELECT SUM(length(CAST(name AS BLOB))+length(CAST(source AS BLOB))) FROM local_scripts),0)+
          COALESCE((SELECT SUM(length(CAST(name AS BLOB))+length(CAST(source AS BLOB))) FROM local_script_versions),0)+
          COALESCE((SELECT SUM(length(CAST(name AS BLOB))+length(CAST(snapshot AS BLOB))+length(CAST(summary AS BLOB))) FROM local_strategy_runs),0) AS bytes`).get() as { bytes: number };
        if (usage.bytes + additionalBytes > SCRIPT_LIBRARY_LIMITS.storedBytes) throw new AppError(413, 'The script and strategy library has reached its 100 MiB payload limit. Existing work is preserved.', 'CAPACITY_REACHED');
    }
    private transaction<T>(action: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = action(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
}
