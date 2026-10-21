import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Bar, ChartView, ContinuousProvenance, ContinuousSegment, DatasetMeta, Schema, Session, SessionNavigation, SessionSummary } from '../shared/types';
import type { TimeframeDescriptor } from '../shared/timeframes';
import { nextTimeframeBucket, timeframeBucket } from '../shared/timeframes';
import { checksum, continuousInstrument, instrumentFor, interval, MAX_BARS, validateBars } from './data';
import { AppError, text } from './errors';
import { integer, registerSourceTimeLookup, validateExecutionVersion, validateSessionConfig } from '../engine/validation';

type DatasetInput = { name: string; symbol: string; schema: Schema; source: DatasetMeta['source']; bars: Bar[]; scope?: string };
type SourceBoundary = { idx: number; time: number };
const MAX_SESSIONS = 1000;
const MAX_DATASETS = 200;
const MAX_TOTAL_BARS = 5_000_000;
export class ReplayStore {
    readonly db: DatabaseSync;
    readonly dataDirectory: string;
    private cache = new Map<string, Bar[]>();
    private cachedBars = 0;
    private importingHistory = false;
    constructor(dataDirectory: string) {
        this.dataDirectory = resolve(dataDirectory);
        mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(join(this.dataDirectory, 'replay.sqlite'));
        this.db.function('vela_month_bucket', { deterministic: true }, (time, count) => timeframeBucket(Number(time), { native: 'M', server: '1M', unit: 'month', count: Number(count), intervalMs: null }));
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
          CREATE TABLE IF NOT EXISTS datasets(id TEXT PRIMARY KEY, scope TEXT NOT NULL, checksum TEXT NOT NULL, meta TEXT NOT NULL, UNIQUE(scope, checksum));
          CREATE TABLE IF NOT EXISTS bars(dataset_id TEXT NOT NULL REFERENCES datasets(id), idx INTEGER NOT NULL, time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume INTEGER NOT NULL, PRIMARY KEY(dataset_id, idx), UNIQUE(dataset_id, time)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, state TEXT NOT NULL, summary TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC);`);
        // Older runtimes must not erase execution fields that they do not understand.
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS sessions_execution_version_update
          BEFORE UPDATE OF state ON sessions
          WHEN json_extract(OLD.state, '$.executionVersion') >= 2 AND
            (json_type(NEW.state, '$.executionVersion') IS NOT 'integer' OR
             json_extract(NEW.state, '$.executionVersion') < json_extract(OLD.state, '$.executionVersion'))
          BEGIN SELECT RAISE(ABORT, 'This session requires a newer application version.'); END;`);
        // Database triggers also protect connections opened by an older runtime
        // before this migration, including their already-prepared statements.
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS sessions_continuous_version_insert
          BEFORE INSERT ON sessions
          WHEN EXISTS (SELECT 1 FROM datasets WHERE id=json_extract(NEW.state, '$.config.datasetId') AND json_type(meta, '$.continuous')='object')
            AND (json_type(NEW.state, '$.executionVersion') IS NOT 'integer' OR json_extract(NEW.state, '$.executionVersion')<>3)
          BEGIN SELECT RAISE(ABORT, 'This dataset requires execution version 3.'); END;
          CREATE TRIGGER IF NOT EXISTS sessions_continuous_version_update
          BEFORE UPDATE OF state ON sessions
          WHEN EXISTS (SELECT 1 FROM datasets WHERE id=json_extract(NEW.state, '$.config.datasetId') AND json_type(meta, '$.continuous')='object')
            AND (json_type(NEW.state, '$.executionVersion') IS NOT 'integer' OR json_extract(NEW.state, '$.executionVersion')<>3)
          BEGIN SELECT RAISE(ABORT, 'This dataset requires execution version 3. This session requires a newer application version.'); END;`);
        const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
        const barColumns = this.db.prepare('PRAGMA table_info(bars)').all() as { name: string }[];
        for (const column of ['instrument_id', 'contract']) if (!barColumns.some(item => item.name === column)) this.db.exec(`ALTER TABLE bars ADD COLUMN ${column} TEXT`);
        const datasetColumns = this.db.prepare('PRAGMA table_info(datasets)').all() as { name: string }[];
        if (!datasetColumns.some(column => column.name === 'ready')) this.db.exec('ALTER TABLE datasets ADD COLUMN ready INTEGER NOT NULL DEFAULT 1');
        if (!columns.some(column => column.name === 'summary')) {
            this.db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
        }
        const update = this.db.prepare('UPDATE sessions SET summary=? WHERE id=?');
        for (const row of this.db.prepare("SELECT id,state FROM sessions WHERE summary='' LIMIT 1000").iterate() as Iterable<{ id: string; state: string }>) update.run(JSON.stringify(this.summarize(JSON.parse(row.state) as Session)), row.id);
    }
    close(): void {
        if (this.importingHistory) throw new AppError(409, 'Cancel and drain history import before closing the store.', 'HISTORY_IMPORT_ACTIVE');
        this.cache.clear(); this.db.close();
    }
    listDatasets(): DatasetMeta[] { return (this.db.prepare('SELECT meta FROM datasets WHERE ready=1 ORDER BY rowid DESC').all() as { meta: string }[]).map(row => JSON.parse(row.meta) as DatasetMeta); }
    dataset(id: string): DatasetMeta {
        const row = this.db.prepare('SELECT meta FROM datasets WHERE id=? AND ready=1').get(id) as { meta: string } | undefined;
        if (!row) throw new AppError(404, 'Dataset not found.', 'NOT_FOUND');
        return JSON.parse(row.meta) as DatasetMeta;
    }
    datasetForScope(scope: string): DatasetMeta | undefined {
        const row = this.db.prepare('SELECT meta FROM datasets WHERE scope=? AND ready=1 ORDER BY rowid DESC LIMIT 1').get(scope) as { meta: string } | undefined;
        return row ? JSON.parse(row.meta) as DatasetMeta : undefined;
    }
    addDataset(input: DatasetInput): DatasetMeta {
        if (this.importingHistory) throw new AppError(409, 'History import is in progress.', 'HISTORY_IMPORT_ACTIVE');
        const bars = validateBars(input.bars, input.schema, input.symbol);
        const hash = checksum(bars); const scope = input.scope ?? JSON.stringify({ source: input.source, symbol: input.symbol, schema: input.schema, start: bars[0]!.time, end: bars.at(-1)!.time + interval(input.schema) });
        const existing = this.db.prepare('SELECT meta FROM datasets WHERE scope=? AND checksum=?').get(scope, hash) as { meta: string } | undefined;
        if (existing) return JSON.parse(existing.meta) as DatasetMeta;
        const meta: DatasetMeta = { id: randomUUID(), name: text(input.name, 'dataset name'), symbol: input.symbol, schema: input.schema, intervalMs: interval(input.schema), instrument: instrumentFor(input.symbol), barCount: bars.length, start: bars[0]!.time, end: bars.at(-1)!.time + interval(input.schema), source: input.source, createdAt: new Date().toISOString(), checksum: hash };
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const count = this.db.prepare('SELECT COUNT(*) AS datasets FROM datasets').get() as { datasets: number };
            const total = this.db.prepare("SELECT COALESCE(SUM(json_extract(meta,'$.barCount')),0) AS bars FROM datasets WHERE ready=1 AND json_type(meta,'$.continuous') IS NULL").get() as { bars: number };
            if (count.datasets >= MAX_DATASETS || total.bars + bars.length > MAX_TOTAL_BARS) throw new AppError(413, 'Local dataset capacity reached.');
            this.db.prepare('INSERT INTO datasets(id,scope,checksum,meta) VALUES(?,?,?,?)').run(meta.id, scope, hash, JSON.stringify(meta));
            const insert = this.db.prepare('INSERT INTO bars(dataset_id,idx,time,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?,?)');
            bars.forEach((bar, i) => insert.run(meta.id, i, bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume));
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        return meta;
    }
    readBars(id: string): Bar[] {
        const hit = this.cache.get(id);
        if (hit) { this.cache.delete(id); this.cache.set(id, hit); return hit; }
        const dataset = this.dataset(id);
        if (dataset.barCount > MAX_BARS) throw new AppError(413, 'Full history export is too large. Use bounded history windows; legacy backup files are limited to 250000 exact-contract bars.', 'HISTORY_EXPORT_TOO_LARGE');
        const bars = this.readBarWindow(id, 0, MAX_BARS);
        for (const bar of bars) Object.freeze(bar);
        Object.freeze(bars);
        while ((this.cachedBars + bars.length > MAX_BARS || this.cache.size >= 4) && this.cache.size) {
            const first = this.cache.keys().next().value!; this.cachedBars -= this.cache.get(first)!.length; this.cache.delete(first);
        }
        this.cache.set(id, bars); this.cachedBars += bars.length;
        return bars;
    }
    readBarWindow(id: string, startIndex: number, limit: number): Bar[] {
        const dataset = this.dataset(id);
        if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex > dataset.barCount || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BARS) throw new AppError(400, 'Invalid bounded source window.');
        const rows = this.db.prepare('SELECT time,open,high,low,close,volume,instrument_id,contract FROM bars WHERE dataset_id=? AND idx>=? AND idx<? ORDER BY idx LIMIT ?').all(id, startIndex, startIndex + limit, limit) as unknown as (Bar & { instrument_id: string | null; contract: string | null })[];
        return rows.map(({ instrument_id, contract, ...bar }) => {
            if (dataset.continuous && (!instrument_id || !contract)) throw new AppError(400, 'Continuous source contract provenance is missing.', 'INVALID_HISTORY');
            return instrument_id !== null && contract !== null ? { ...bar, instrumentId: instrument_id, contract } : bar;
        });
    }
    /** Array-compatible global indexing for the existing engine; only this command's window is resident. */
    commandBars(id: string, cursor: number): Bar[] {
        const dataset = this.dataset(id);
        if (!Number.isSafeInteger(cursor) || cursor < -1 || cursor >= dataset.barCount) throw new AppError(400, 'Invalid replay cursor.');
        const start = Math.max(0, cursor); const values = new Map<number, Bar>();
        for (const [offset, bar] of this.readBarWindow(id, start, 5002).entries()) values.set(start + offset, Object.freeze(bar));
        if (!values.has(0)) values.set(0, Object.freeze(this.readBarWindow(id, 0, 1)[0]!));
        const facade = new Proxy([] as Bar[], {
            get(target, property, receiver) {
                if (property === 'length') return dataset.barCount;
                if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
                    const index = Number(property); if (index >= dataset.barCount) return undefined;
                    const value = values.get(index);
                    if (!value) throw new AppError(400, 'Source access exceeds the bounded replay command window.', 'SOURCE_WINDOW_EXCEEDED');
                    return value;
                }
                if (property === 'toJSON') return () => { throw new AppError(413, 'Bounded source windows cannot be serialized as full history.', 'HISTORY_EXPORT_TOO_LARGE'); };
                return Reflect.get(target, property, receiver);
            },
            set() { throw new AppError(400, 'Source windows are immutable.'); },
        });
        const membership = this.db.prepare('SELECT 1 AS present FROM bars WHERE dataset_id=? AND time=? AND idx>=? AND idx<=? LIMIT 1');
        registerSourceTimeLookup(facade, { datasetId: id, maximumCursor: cursor, contains: (time, startIndex, revealedCursor) => {
            if (!Number.isSafeInteger(time) || !Number.isSafeInteger(startIndex) || startIndex < 0 || !Number.isSafeInteger(revealedCursor) || revealedCursor > cursor || revealedCursor < startIndex) return false;
            return membership.get(id, time, startIndex, revealedCursor) !== undefined;
        } });
        return facade;
    }
    async addHistoryDataset(input: { name: string; symbol: string; expectedRows: number; scope: string; provenance: Omit<ContinuousProvenance, 'segments'>; bars: AsyncIterable<Bar>; signal?: AbortSignal }): Promise<DatasetMeta> {
        if (this.importingHistory) throw new AppError(409, 'History import is in progress.', 'HISTORY_IMPORT_ACTIVE');
        const instrument = continuousInstrument(input.symbol);
        const provenance = input.provenance;
        if (!Number.isSafeInteger(input.expectedRows) || input.expectedRows < 1 || input.expectedRows > 5_000_000 || !/^[a-f0-9]{64}$/.test(provenance.manifestHash)
            || provenance.stypeIn !== 'continuous' || provenance.rollRule !== 'volume' || provenance.rank !== 0 || provenance.adjustment !== 'none' || provenance.rollPolicy !== 'flatten-prior-close'
            || !Number.isFinite(Date.parse(provenance.requestedStart)) || !Number.isFinite(Date.parse(provenance.requestedEnd)) || Date.parse(provenance.requestedEnd) <= Date.parse(provenance.requestedStart)
            || typeof input.scope !== 'string' || input.scope.length > 1024) throw new AppError(400, 'Invalid history import receipt.');
        const existing = this.datasetForScope(input.scope); if (existing) return existing;
        this.importingHistory = true; let began = false;
        try {
            this.db.exec('BEGIN IMMEDIATE'); began = true;
            const total = this.db.prepare("SELECT COALESCE(SUM(json_extract(meta,'$.barCount')),0) AS count FROM datasets WHERE json_type(meta,'$.continuous')='object'").get() as { count: number };
            const count = this.db.prepare('SELECT COUNT(*) AS count FROM datasets').get() as { count: number };
            if (count.count >= MAX_DATASETS || total.count + input.expectedRows > 10_000_000) throw new AppError(413, 'Continuous-history capacity reached.');
            const id = randomUUID(); const placeholder = `pending-${id}`;
            this.db.prepare('INSERT INTO datasets(id,scope,checksum,meta,ready) VALUES(?,?,?,?,0)').run(id, input.scope, placeholder, '{}');
            const insert = this.db.prepare('INSERT INTO bars(dataset_id,idx,time,open,high,low,close,volume,instrument_id,contract) VALUES(?,?,?,?,?,?,?,?,?,?)');
            const segments: ContinuousSegment[] = []; const digest = createHash('sha256'); let index = 0; let previous = -1;
            for await (const bar of input.bars) {
                if (input.signal?.aborted) throw new AppError(400, 'History import was cancelled.', 'ABORTED');
                if (index >= input.expectedRows || !bar.instrumentId || !/^[1-9]\d{0,9}$/.test(bar.instrumentId) || Number(bar.instrumentId) > 0xffff_ffff || !bar.contract || instrumentFor(bar.contract).root !== instrument.root || bar.time <= previous) throw new AppError(400, 'History identity, count or order does not match the staged receipt.', 'INVALID_HISTORY');
                const valid = validateBars([{ ...bar, symbol: bar.contract }], 'ohlcv-1m', bar.contract, { start: Date.parse(input.provenance.requestedStart), end: Date.parse(input.provenance.requestedEnd) })[0]!;
                insert.run(id, index, valid.time, valid.open, valid.high, valid.low, valid.close, valid.volume, bar.instrumentId, bar.contract);
                digest.update(JSON.stringify({ ...valid, instrumentId: bar.instrumentId, contract: bar.contract }) + '\n');
                let segment = segments.at(-1);
                if (!segment || segment.instrumentId !== bar.instrumentId || segment.contract !== bar.contract) {
                    if (segments.length >= 2000) throw new AppError(413, 'History contains too many contract roll segments.');
                    segment = { startIndex: index, endIndex: index + 1, start: valid.time, end: valid.time + 60_000, instrumentId: bar.instrumentId, contract: bar.contract }; segments.push(segment);
                } else { segment.endIndex = index + 1; segment.end = valid.time + 60_000; }
                previous = valid.time; index++;
                if (index % 4096 === 0) await setImmediate();
            }
            if (index !== input.expectedRows || input.signal?.aborted) throw new AppError(400, 'History import was incomplete or cancelled.', 'INVALID_HISTORY');
            const meta: DatasetMeta = { id, name: text(input.name, 'dataset name'), symbol: input.symbol, schema: 'ohlcv-1m', intervalMs: 60_000, instrument, barCount: index,
                start: segments[0]!.start, end: previous + 60_000, source: 'databento', createdAt: new Date().toISOString(), checksum: digest.digest('hex'), continuous: { ...input.provenance, segments } };
            this.db.prepare('UPDATE datasets SET checksum=?,meta=?,ready=1 WHERE id=?').run(meta.checksum, JSON.stringify(meta), id);
            this.db.exec('COMMIT'); return meta;
        } catch (error) { if (began) this.db.exec('ROLLBACK'); throw error; }
        finally { this.importingHistory = false; }
    }
    readRevealed(id: string, cursor: number, after: number, limit: number): Bar[] {
        return this.db.prepare('SELECT time,open,high,low,close,volume FROM bars WHERE dataset_id=? AND idx<=? AND time>=? ORDER BY idx DESC LIMIT ?').all(id, cursor, after, limit).reverse() as unknown as Bar[];
    }
    resolveTime(id: string, time: unknown): { index: number; time: number } {
        this.dataset(id);
        if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0 || time > 8_640_000_000_000_000) throw new AppError(400, 'Invalid replay date and time.');
        const first = this.db.prepare('SELECT time FROM bars WHERE dataset_id=? ORDER BY time LIMIT 1').get(id) as { time: number } | undefined;
        const last = this.db.prepare('SELECT time FROM bars WHERE dataset_id=? ORDER BY time DESC LIMIT 1').get(id) as { time: number } | undefined;
        if (!first || !last || time < first.time || time > last.time) throw new AppError(400, 'The requested date and time is outside the cached data.');
        // The dataset/time unique index resolves gaps without loading or returning future prices.
        const target = this.db.prepare('SELECT idx,time FROM bars WHERE dataset_id=? AND time>=? ORDER BY time LIMIT 1').get(id, time) as { idx: number; time: number };
        return { index: target.idx, time: target.time };
    }
    private sourceBounds(dataset: DatasetMeta): { first: SourceBoundary; last: SourceBoundary } {
        const first = this.db.prepare('SELECT idx,time FROM bars WHERE dataset_id=? ORDER BY idx LIMIT 1').get(dataset.id) as SourceBoundary | undefined;
        const last = this.db.prepare('SELECT idx,time FROM bars WHERE dataset_id=? ORDER BY idx DESC LIMIT 1').get(dataset.id) as SourceBoundary | undefined;
        if (!first || !last || first.idx !== 0 || last.idx + 1 !== dataset.barCount || first.time !== dataset.start || last.time + dataset.intervalMs !== dataset.end) throw new AppError(400, 'Cached source bounds do not match the dataset.');
        return { first, last };
    }
    resolveEndTime(id: string, time: unknown): number {
        const dataset = this.dataset(id);
        if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0 || time > 8_640_000_000_000_000) throw new AppError(400, 'Invalid replay end date and time.');
        const { first, last } = this.sourceBounds(dataset);
        if (time < first.time || time > dataset.end) throw new AppError(400, 'The requested end date and time is outside the cached data.');
        if (time > last.time) return last.idx + 1;
        const target = this.db.prepare('SELECT idx FROM bars WHERE dataset_id=? AND time>=? ORDER BY time LIMIT 1').get(id, time) as { idx: number } | undefined;
        if (!target) throw new AppError(400, 'The requested replay end has no matching source boundary.');
        return target.idx;
    }
    navigation(session: Session, time: number): SessionNavigation {
        const target = this.resolveTime(session.config.datasetId, time);
        if (session.config.endIndex !== undefined && target.index >= session.config.endIndex) throw new AppError(400, 'Choose a date and time within the selected replay range.');
        if (target.index <= session.cursor) throw new AppError(400, 'Choose a date and time after the current replay bar.');
        const current = this.db.prepare('SELECT time FROM bars WHERE dataset_id=? AND idx=?').get(session.config.datasetId, session.cursor) as { time: number } | undefined;
        return { currentIndex: session.cursor, currentTime: current?.time ?? null, targetIndex: target.index, targetTime: target.time };
    }
    pinnedCursor(id: string, maximumCursor: number, cutoff: number): number {
        const current = this.db.prepare('SELECT time FROM bars WHERE dataset_id=? AND idx=?').get(id, maximumCursor) as { time: number } | undefined;
        if (!current || cutoff > current.time) throw new AppError(400, 'Script data cutoff cannot advance beyond the saved replay cursor.');
        const selected = this.db.prepare('SELECT idx FROM bars WHERE dataset_id=? AND idx<=? AND time<=? ORDER BY idx DESC LIMIT 1').get(id, maximumCursor, cutoff) as { idx: number } | undefined;
        return selected?.idx ?? -1;
    }
    chart(id: string, cursor: number, timeframe: string, period: TimeframeDescriptor, limit: number, after?: number, before?: number): ChartView {
        const meta = this.dataset(id);
        if (meta.continuous && period.intervalMs !== 60_000) throw new AppError(400, 'Continuous history currently supports one-minute charts so contract rolls cannot be mixed inside an aggregated candle.', 'CONTINUOUS_TIMEFRAME_UNSUPPORTED');
        const until = before ?? 8_640_000_000_000_000;
        const cursorBar = this.db.prepare('SELECT time FROM bars WHERE dataset_id=? AND idx<=? AND time<=? ORDER BY idx DESC LIMIT 1').get(id, cursor, until) as { time: number } | undefined;
        const floor = after === undefined ? 0 : timeframeBucket(after, period);
        const order = after === undefined ? 'DESC' : 'ASC';
        if (period.intervalMs === meta.intervalMs) {
            const rows = this.db.prepare(`SELECT time,open,high,low,close,volume FROM bars WHERE dataset_id=? AND idx<=? AND time>=? AND time<=? ORDER BY time ${order} LIMIT ?`).all(id, cursor, floor, Math.min(until, cursorBar?.time ?? -1), limit + 1) as unknown as Bar[];
            const hasMore = rows.length > limit; const bars = rows.slice(0, limit); if (after === undefined) bars.reverse();
            return { bars, timeframe, intervalMs: meta.intervalMs, baseIntervalMs: meta.intervalMs, cursorTime: cursorBar?.time ?? null, hasMore };
        }
        const expression = period.unit === 'month' ? 'vela_month_bucket(time,?)' : period.unit === 'week' ? 'CAST((time+259200000)/? AS INTEGER)*?-259200000' : 'CAST(time/? AS INTEGER)*?';
        const parameters = period.unit === 'month' ? [period.count] : [period.intervalMs!, period.intervalMs!];
        const groups = this.db.prepare(`WITH grouped AS (
          SELECT ${expression} AS bucket,MIN(idx) AS first,MAX(idx) AS last,MAX(high) AS high,MIN(low) AS low,SUM(volume) AS volume
          FROM bars WHERE dataset_id=? AND idx<=? AND time>=? AND time<=? GROUP BY bucket ORDER BY bucket ${order} LIMIT ?)
          SELECT g.bucket AS time,o.open,g.high,g.low,c.close,g.volume FROM grouped g
          JOIN bars o ON o.dataset_id=? AND o.idx=g.first JOIN bars c ON c.dataset_id=? AND c.idx=g.last ORDER BY g.bucket ${order}`).all(...parameters, id, cursor, floor, until, limit + 1, id, id) as unknown as Bar[];
        const hasMore = groups.length > limit;
        const bars = groups.slice(0, limit); if (after === undefined) bars.reverse();
        const bucket = timeframeBucket(cursorBar?.time ?? meta.start, period);
        return { bars, timeframe, intervalMs: nextTimeframeBucket(bucket, period) - bucket, baseIntervalMs: meta.intervalMs, cursorTime: cursorBar?.time ?? null, hasMore };
    }
    session(id: string): Session {
        const row = this.db.prepare('SELECT state FROM sessions WHERE id=?').get(id) as { state: string } | undefined;
        if (!row) throw new AppError(404, 'Session not found.', 'NOT_FOUND');
        const state = JSON.parse(row.state) as Session;
        validateExecutionVersion(state);
        const dataset = this.dataset(state.config.datasetId);
        if (dataset.continuous && state.executionVersion !== 3) throw new AppError(400, 'Continuous history requires execution version 3.', 'UNSUPPORTED_EXECUTION_VERSION');
        if (!dataset.continuous && state.executionVersion === 3) throw new AppError(400, 'Execution version 3 requires a continuous-history dataset.', 'UNSUPPORTED_EXECUTION_VERSION');
        const config = validateSessionConfig(state.config, dataset.barCount);
        integer(state.cursor, 'Cursor', config.startIndex - 1, (config.endIndex ?? dataset.barCount) - 1);
        return state;
    }
    sessions(): SessionSummary[] {
        return (this.db.prepare('SELECT summary FROM sessions ORDER BY updated_at DESC LIMIT ?').all(MAX_SESSIONS) as { summary: string }[]).map(row => JSON.parse(row.summary) as SessionSummary);
    }
    private summarize(state: Session): SessionSummary {
        const dataset = this.dataset(state.config.datasetId);
        this.sourceBounds(dataset);
        const config = validateSessionConfig(state.config, dataset.barCount);
        const endIndex = config.endIndex ?? dataset.barCount;
        integer(state.cursor, 'Cursor', config.startIndex - 1, endIndex - 1);
        const start = this.db.prepare('SELECT time FROM bars WHERE dataset_id=? AND idx=?').get(dataset.id, config.startIndex) as { time: number } | undefined;
        const last = this.db.prepare('SELECT time FROM bars WHERE dataset_id=? AND idx=?').get(dataset.id, endIndex - 1) as { time: number } | undefined;
        const end = endIndex === dataset.barCount ? undefined : this.db.prepare('SELECT time FROM bars WHERE dataset_id=? AND idx=?').get(dataset.id, endIndex) as { time: number } | undefined;
        if (!start || !last || (endIndex < dataset.barCount && !end)) throw new AppError(400, 'The selected replay range is outside the cached source.');
        return { id: state.id, name: config.name, datasetId: dataset.id, symbol: dataset.symbol, mode: config.mode, status: state.status, cursor: state.cursor, barCount: dataset.barCount, startIndex: config.startIndex, endIndex, startTime: start.time, endTime: endIndex === dataset.barCount ? dataset.end : end!.time, equity: state.account.equity, netPnl: state.account.netPnl, trades: state.trades.length, updatedAt: state.updatedAt, revision: state.revision };
    }
    createSession(session: Session): Session {
        if (this.importingHistory) throw new AppError(409, 'History import is in progress.', 'HISTORY_IMPORT_ACTIVE');
        const dataset = this.dataset(session.config.datasetId);
        if (dataset.continuous) session = { ...session, executionVersion: 3 };
        else if (session.executionVersion === 3) throw new AppError(400, 'Execution version 3 requires a continuous-history dataset.', 'UNSUPPORTED_EXECUTION_VERSION');
        validateExecutionVersion(session);
        const count = this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
        if (count.count >= MAX_SESSIONS) throw new AppError(413, 'Local session capacity reached.');
        this.db.prepare('INSERT INTO sessions(id,revision,updated_at,state,summary) VALUES(?,?,?,?,?)').run(session.id, session.revision, session.updatedAt, JSON.stringify(session), JSON.stringify(this.summarize(session)));
        return session;
    }
    saveSession(session: Session, expectedRevision: number): Session {
        if (this.importingHistory) throw new AppError(409, 'History import is in progress.', 'HISTORY_IMPORT_ACTIVE');
        if (this.dataset(session.config.datasetId).continuous && session.executionVersion !== 3) throw new AppError(400, 'Continuous history requires execution version 3.');
        if (!this.dataset(session.config.datasetId).continuous && session.executionVersion === 3) throw new AppError(400, 'Execution version 3 requires a continuous-history dataset.');
        validateExecutionVersion(session);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new AppError(400, 'Invalid expected revision.');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = this.db.prepare('UPDATE sessions SET revision=?,updated_at=?,state=?,summary=? WHERE id=? AND revision=?').run(session.revision, session.updatedAt, JSON.stringify(session), JSON.stringify(this.summarize(session)), session.id, expectedRevision);
            if (result.changes !== 1) throw new AppError(409, 'Session changed. Reload it before continuing.', 'REVISION_CONFLICT');
            this.db.exec('COMMIT'); return session;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
}
