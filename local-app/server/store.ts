import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Bar, ChartView, DatasetMeta, Schema, Session, SessionNavigation, SessionSummary } from '../shared/types';
import type { TimeframeDescriptor } from '../shared/timeframes';
import { nextTimeframeBucket, timeframeBucket } from '../shared/timeframes';
import { checksum, instrumentFor, interval, MAX_BARS, validateBars } from './data';
import { AppError, text } from './errors';

type DatasetInput = { name: string; symbol: string; schema: Schema; source: DatasetMeta['source']; bars: Bar[]; scope?: string };
const MAX_SESSIONS = 1000;
const MAX_DATASETS = 200;
const MAX_TOTAL_BARS = 5_000_000;
export class ReplayStore {
    readonly db: DatabaseSync;
    readonly dataDirectory: string;
    private cache = new Map<string, Bar[]>();
    private cachedBars = 0;
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
        const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
        if (!columns.some(column => column.name === 'summary')) {
            this.db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
        }
        const update = this.db.prepare('UPDATE sessions SET summary=? WHERE id=?');
        for (const row of this.db.prepare("SELECT id,state FROM sessions WHERE summary='' LIMIT 1000").iterate() as Iterable<{ id: string; state: string }>) update.run(JSON.stringify(this.summarize(JSON.parse(row.state) as Session)), row.id);
    }
    close(): void { this.cache.clear(); this.db.close(); }
    listDatasets(): DatasetMeta[] { return (this.db.prepare('SELECT meta FROM datasets ORDER BY rowid DESC').all() as { meta: string }[]).map(row => JSON.parse(row.meta) as DatasetMeta); }
    dataset(id: string): DatasetMeta {
        const row = this.db.prepare('SELECT meta FROM datasets WHERE id=?').get(id) as { meta: string } | undefined;
        if (!row) throw new AppError(404, 'Dataset not found.', 'NOT_FOUND');
        return JSON.parse(row.meta) as DatasetMeta;
    }
    datasetForScope(scope: string): DatasetMeta | undefined {
        const row = this.db.prepare('SELECT meta FROM datasets WHERE scope=? ORDER BY rowid DESC LIMIT 1').get(scope) as { meta: string } | undefined;
        return row ? JSON.parse(row.meta) as DatasetMeta : undefined;
    }
    addDataset(input: DatasetInput): DatasetMeta {
        const bars = validateBars(input.bars, input.schema, input.symbol);
        const hash = checksum(bars); const scope = input.scope ?? JSON.stringify({ source: input.source, symbol: input.symbol, schema: input.schema, start: bars[0]!.time, end: bars.at(-1)!.time + interval(input.schema) });
        const existing = this.db.prepare('SELECT meta FROM datasets WHERE scope=? AND checksum=?').get(scope, hash) as { meta: string } | undefined;
        if (existing) return JSON.parse(existing.meta) as DatasetMeta;
        const meta: DatasetMeta = { id: randomUUID(), name: text(input.name, 'dataset name'), symbol: input.symbol, schema: input.schema, intervalMs: interval(input.schema), instrument: instrumentFor(input.symbol), barCount: bars.length, start: bars[0]!.time, end: bars.at(-1)!.time + interval(input.schema), source: input.source, createdAt: new Date().toISOString(), checksum: hash };
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const count = this.db.prepare('SELECT COUNT(*) AS datasets FROM datasets').get() as { datasets: number };
            const total = this.db.prepare('SELECT COUNT(*) AS bars FROM bars').get() as { bars: number };
            if (count.datasets >= MAX_DATASETS || total.bars + bars.length > MAX_TOTAL_BARS) throw new AppError(413, 'Local dataset capacity reached.');
            this.db.prepare('INSERT INTO datasets(id,scope,checksum,meta) VALUES(?,?,?,?)').run(meta.id, scope, hash, JSON.stringify(meta));
            const insert = this.db.prepare('INSERT INTO bars VALUES(?,?,?,?,?,?,?,?)');
            bars.forEach((bar, i) => insert.run(meta.id, i, bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume));
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        return meta;
    }
    readBars(id: string): Bar[] {
        const hit = this.cache.get(id);
        if (hit) { this.cache.delete(id); this.cache.set(id, hit); return hit; }
        this.dataset(id);
        const bars = this.db.prepare('SELECT time,open,high,low,close,volume FROM bars WHERE dataset_id=? ORDER BY idx').all(id) as unknown as Bar[];
        for (const bar of bars) Object.freeze(bar);
        Object.freeze(bars);
        while ((this.cachedBars + bars.length > MAX_BARS || this.cache.size >= 4) && this.cache.size) {
            const first = this.cache.keys().next().value!; this.cachedBars -= this.cache.get(first)!.length; this.cache.delete(first);
        }
        this.cache.set(id, bars); this.cachedBars += bars.length;
        return bars;
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
    navigation(session: Session, time: number): SessionNavigation {
        const target = this.resolveTime(session.config.datasetId, time);
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
        const until = before ?? 8_640_000_000_000_000;
        const cursorBar = this.db.prepare('SELECT time FROM bars WHERE dataset_id=? AND idx<=? AND time<=? ORDER BY idx DESC LIMIT 1').get(id, cursor, until) as { time: number } | undefined;
        const floor = after === undefined ? 0 : timeframeBucket(after, period);
        const order = after === undefined ? 'DESC' : 'ASC';
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
        return JSON.parse(row.state) as Session;
    }
    sessions(): SessionSummary[] {
        return (this.db.prepare('SELECT summary FROM sessions ORDER BY updated_at DESC LIMIT ?').all(MAX_SESSIONS) as { summary: string }[]).map(row => JSON.parse(row.summary) as SessionSummary);
    }
    private summarize(state: Session): SessionSummary {
        const dataset = this.dataset(state.config.datasetId);
        return { id: state.id, name: state.config.name, datasetId: dataset.id, symbol: dataset.symbol, mode: state.config.mode, status: state.status, cursor: state.cursor, barCount: dataset.barCount, equity: state.account.equity, netPnl: state.account.netPnl, trades: state.trades.length, updatedAt: state.updatedAt, revision: state.revision };
    }
    createSession(session: Session): Session {
        const count = this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
        if (count.count >= MAX_SESSIONS) throw new AppError(413, 'Local session capacity reached.');
        this.db.prepare('INSERT INTO sessions(id,revision,updated_at,state,summary) VALUES(?,?,?,?,?)').run(session.id, session.revision, session.updatedAt, JSON.stringify(session), JSON.stringify(this.summarize(session)));
        return session;
    }
    saveSession(session: Session, expectedRevision: number): Session {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new AppError(400, 'Invalid expected revision.');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = this.db.prepare('UPDATE sessions SET revision=?,updated_at=?,state=?,summary=? WHERE id=? AND revision=?').run(session.revision, session.updatedAt, JSON.stringify(session), JSON.stringify(this.summarize(session)), session.id, expectedRevision);
            if (result.changes !== 1) throw new AppError(409, 'Session changed. Reload it before continuing.', 'REVISION_CONFLICT');
            this.db.exec('COMMIT'); return session;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
}
