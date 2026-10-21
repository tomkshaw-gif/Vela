import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { DeepHistoryManifest, DeepHistoryRequest, DeepSeriesRequest, DeepSourceDataset } from '../shared/deep-backtest';
import type { DatasetMeta } from '../shared/types';
import { replaySymbolInfo } from '../shared/symbol-info';
import { parseTimeframe, timeframeSupported } from '../shared/timeframes';
import { AppError, requireObject } from './errors';
import type { ReplayStore } from './store';
import { parseCachedTicker } from './series-ticker';
import { DEEP_WORKER_SOURCE } from './deep-history-worker.mjs';

export const DEEP_HISTORY_LIMITS = Object.freeze({ bars: 250_000, scopes: 8, scopeMs: 600_000, workerMs: 30_000, pending: 16 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
type Scope = { id: string; anchor: DatasetMeta; datasets: DatasetMeta[]; from: number; to: number; expires: number; cursorTime?: number };
type Job = { input: Record<string, unknown>; signal?: AbortSignal; resolve: (value: WorkerSuccess) => void; reject: (error: unknown) => void; abort: () => void; worker?: Worker; timer?: ReturnType<typeof setTimeout>; settled: boolean };
type WorkerSuccess = { ok: true; body: string; cursorTime: number | null };
type WorkerFailure = { ok: false; status: number; message: string; code: string };
function exact(value: unknown, fields: string[]): Record<string, unknown> {
    const object = requireObject(value);
    if (![Object.prototype, null].includes(Object.getPrototypeOf(object)) || Object.getOwnPropertySymbols(object).length || Object.keys(object).some((key) => !fields.includes(key))) throw new AppError(400, 'Unsupported deep history option.');
    return object;
}
function time(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new AppError(400, 'Deep history dates must be UTC epoch milliseconds.');
    return value;
}
function datasetReferences(value: unknown, required: boolean): DeepSourceDataset[] {
    if (!Array.isArray(value) || value.length > 200 || required && value.length === 0) throw new AppError(400, 'Invalid deep history source manifest.');
    const seen = new Set<string>();
    return value.map((entry) => {
        const row = exact(entry, ['id', 'checksum']);
        if (typeof row.id !== 'string' || !UUID.test(row.id) || seen.has(row.id) || typeof row.checksum !== 'string' || !HASH.test(row.checksum)) throw new AppError(400, 'Invalid deep history source reference.');
        seen.add(row.id); return { id: row.id, checksum: row.checksum };
    });
}
/** Validate provenance before saving; scope IDs are deliberately absent from persisted results. */
export function validateDeepHistory(value: unknown, anchor?: DatasetMeta, datasets?: DatasetMeta[]): DeepHistoryManifest {
    const row = exact(value, ['mode', 'requestedFrom', 'requestedTo', 'barCount', 'sourceDatasets', 'checksum', 'secondarySourceDatasets']);
    if (row.mode !== 'deep' || time(row.requestedFrom) >= time(row.requestedTo) || typeof row.barCount !== 'number' || !Number.isSafeInteger(row.barCount) || row.barCount < 1 || row.barCount > DEEP_HISTORY_LIMITS.bars || typeof row.checksum !== 'string' || !HASH.test(row.checksum)) throw new AppError(400, 'Invalid deep history manifest.');
    const primary = datasetReferences(row.sourceDatasets, true);
    const secondary = row.secondarySourceDatasets === undefined ? undefined : datasetReferences(row.secondarySourceDatasets, false);
    if (anchor && datasets) {
        const current = new Map(datasets.map((dataset) => [dataset.id, dataset]));
        for (const reference of [...primary, ...(secondary ?? [])]) {
            const dataset = current.get(reference.id);
            if (!dataset || dataset.checksum !== reference.checksum) throw new AppError(409, 'A deep history source is missing or has changed.', 'HISTORY_CHANGED');
            if (dataset.end <= (row.requestedFrom as number) || dataset.start >= (row.requestedTo as number)) throw new AppError(400, 'A deep history source does not overlap the selected dates.');
        }
        for (const reference of primary) {
            const dataset = current.get(reference.id)!;
            if (dataset.symbol !== anchor.symbol || dataset.schema !== anchor.schema || dataset.intervalMs !== anchor.intervalMs) throw new AppError(400, 'Deep primary history must use the anchor exact contract and source schema.');
        }
    }
    return value as DeepHistoryManifest;
}
function overlapCoverage(datasets: DatasetMeta[], from: number, to: number): number {
    let covered = 0; let end = from;
    for (const dataset of [...datasets].sort((a, b) => a.start - b.start)) {
        const left = Math.max(from, dataset.start, end); const right = Math.min(to, dataset.end);
        if (right > left) { covered += right - left; end = right; }
    }
    return covered;
}

/** Bounded readonly cache jobs. Untrusted Pine remains isolated in the browser worker. */
export class DeepHistoryService {
    private readonly scopes = new Map<string, Scope>();
    private readonly queue: Job[] = [];
    private active?: Job;
    private readonly stopping = new Set<Promise<number>>();
    private closed = false;
    constructor(private readonly store: ReplayStore, private readonly options: { workerMs?: number; now?: () => number } = {}) {}
    async load(value: unknown, signal?: AbortSignal): Promise<string> {
        const input = exact(value, ['datasetId', 'timeframe', 'from', 'to']) as unknown as DeepHistoryRequest;
        if (typeof input.datasetId !== 'string' || !UUID.test(input.datasetId)) throw new AppError(400, 'Invalid deep history anchor dataset.');
        const anchor = this.store.dataset(input.datasetId); const from = time(input.from); const to = time(input.to);
        const period = parseTimeframe(input.timeframe);
        if (from >= to) throw new AppError(400, 'Deep history start must precede its exclusive end.');
        if (!period || !timeframeSupported(input.timeframe, anchor.schema)) throw new AppError(400, 'The anchor source cannot provide the requested deep timeframe.');
        this.prune();
        if (this.scopes.size >= DEEP_HISTORY_LIMITS.scopes) throw new AppError(429, 'Release a previous deep history scope before starting another.', 'DEEP_HISTORY_CAPACITY');
        const scope: Scope = { id: randomUUID(), anchor, datasets: structuredClone(this.store.listDatasets()), from, to, expires: this.now() + DEEP_HISTORY_LIMITS.scopeMs };
        this.scopes.set(scope.id, scope);
        const datasets = scope.datasets.filter((dataset) => dataset.symbol === anchor.symbol && dataset.schema === anchor.schema && dataset.intervalMs === anchor.intervalMs && dataset.end > from && dataset.start < to);
        if (!datasets.length) { this.scopes.delete(scope.id); throw new AppError(404, 'No cached primary history overlaps the selected dates.', 'HISTORY_EMPTY'); }
        try {
            const result = await this.run({ databasePath: join(this.store.dataDirectory, 'replay.sqlite'), datasets, scopeId: scope.id,
                primary: true, period, scopeFrom: from, scopeTo: to, availableUntil: to, baseIntervalMs: anchor.intervalMs,
                symbolInfo: replaySymbolInfo(anchor), maxBars: DEEP_HISTORY_LIMITS.bars }, signal);
            if (result.cursorTime === null) throw new AppError(404, 'No cached primary history is available.', 'HISTORY_EMPTY');
            scope.cursorTime = result.cursorTime; scope.expires = this.now() + DEEP_HISTORY_LIMITS.scopeMs;
            return result.body;
        } catch (error) { this.scopes.delete(scope.id); throw error; }
    }
    async series(scopeId: string, value: unknown, signal?: AbortSignal): Promise<string> {
        this.prune(); const scope = this.scopes.get(scopeId);
        if (!scope || scope.cursorTime === undefined) throw new AppError(410, 'This deep history scope expired. Start the backtest again.', 'DEEP_HISTORY_EXPIRED');
        const input = exact(value, ['symbol', 'timeframe', 'cutoff', 'from', 'to', 'limit']) as unknown as DeepSeriesRequest;
        const ticker = parseCachedTicker(input.symbol); const period = parseTimeframe(input.timeframe); const cutoff = time(input.cutoff);
        if (!period || cutoff < scope.from || cutoff > scope.cursorTime || cutoff % scope.anchor.intervalMs !== 0) throw new AppError(400, 'Invalid deep history source cutoff or timeframe.');
        const from = input.from === undefined ? undefined : time(input.from); const to = input.to === undefined ? undefined : time(input.to);
        if (from !== undefined && to !== undefined && from > to) throw new AppError(400, 'Invalid deep series window.');
        const limit = input.limit ?? DEEP_HISTORY_LIMITS.bars;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEEP_HISTORY_LIMITS.bars) throw new AppError(400, 'Invalid deep series calculation-bar limit.');
        const availableUntil = Math.min(scope.to, cutoff + scope.anchor.intervalMs);
        const candidates = scope.datasets.filter((dataset) => dataset.symbol === ticker.symbol && dataset.end > scope.from && dataset.start < availableUntil && timeframeSupported(input.timeframe, dataset.schema));
        if (!candidates.length) throw new AppError(404, `No compatible ${ticker.symbol} data was cached in this deep history scope.`, 'SERIES_NOT_CACHED');
        const schemas = [...new Set(candidates.map((dataset) => dataset.schema))];
        schemas.sort((left, right) => {
            if (ticker.symbol === scope.anchor.symbol && timeframeSupported(input.timeframe, scope.anchor.schema)) return Number(right === scope.anchor.schema) - Number(left === scope.anchor.schema);
            const a = candidates.filter((dataset) => dataset.schema === left); const b = candidates.filter((dataset) => dataset.schema === right);
            return overlapCoverage(b, scope.from, availableUntil) - overlapCoverage(a, scope.from, availableUntil) || a[0]!.intervalMs - b[0]!.intervalMs;
        });
        const datasets = candidates.filter((dataset) => dataset.schema === schemas[0]);
        scope.expires = this.now() + DEEP_HISTORY_LIMITS.scopeMs;
        return (await this.run({ databasePath: join(this.store.dataDirectory, 'replay.sqlite'), datasets, scopeId: scope.id, primary: false, period,
            scopeFrom: scope.from, scopeTo: scope.to, availableUntil, from, to, limit, modifier: ticker.modifier,
            baseIntervalMs: datasets[0]!.intervalMs, symbolInfo: replaySymbolInfo(datasets[0]!) }, signal)).body;
    }
    release(scopeId: string): void {
        this.scopes.delete(scopeId);
        for (const job of [...this.queue, ...(this.active ? [this.active] : [])]) if (job.input.scopeId === scopeId) this.finish(job, new AppError(499, 'Deep history scope was released.', 'ABORTED'));
    }
    async close(): Promise<void> {
        this.closed = true; this.scopes.clear();
        for (const job of [...this.queue, ...(this.active ? [this.active] : [])]) this.finish(job, new AppError(503, 'Deep history stopped because the application is restarting.', 'UPDATE_PENDING'));
        await Promise.allSettled([...this.stopping]);
    }
    private now(): number { return this.options.now?.() ?? Date.now(); }
    private prune(): void { for (const [id, scope] of this.scopes) if (scope.expires <= this.now()) this.scopes.delete(id); }
    private run(input: Record<string, unknown>, signal?: AbortSignal): Promise<WorkerSuccess> {
        if (this.closed) return Promise.reject(new AppError(503, 'Deep history is closed.', 'UPDATE_PENDING'));
        if (signal?.aborted) return Promise.reject(new AppError(499, 'Deep history was cancelled.', 'ABORTED'));
        if (this.queue.length >= DEEP_HISTORY_LIMITS.pending) return Promise.reject(new AppError(429, 'Too many pending deep history requests.', 'DEEP_HISTORY_CAPACITY'));
        return new Promise((resolve, reject) => {
            const job: Job = { input, signal, resolve, reject, settled: false, abort: () => this.finish(job, new AppError(499, 'Deep history was cancelled.', 'ABORTED')) };
            signal?.addEventListener('abort', job.abort, { once: true }); this.queue.push(job); this.pump();
        });
    }
    private pump(): void {
        if (this.active || this.closed) return;
        const job = this.queue.shift(); if (!job) return;
        this.active = job;
        try {
            job.worker = new Worker(DEEP_WORKER_SOURCE, { eval: true, workerData: job.input, resourceLimits: { maxOldGenerationSizeMb: 384 }, execArgv: [] });
            job.timer = setTimeout(() => this.finish(job, new AppError(408, 'Deep cache preparation exceeded its time budget. Choose a shorter range or a higher timeframe.', 'DEEP_HISTORY_TIMEOUT')), this.options.workerMs ?? DEEP_HISTORY_LIMITS.workerMs);
            job.worker.once('message', (message: WorkerSuccess | WorkerFailure) => {
                if (message.ok) this.finish(job, undefined, message);
                else this.finish(job, new AppError(message.status, message.message, message.code));
            });
            job.worker.once('error', () => this.finish(job, new AppError(500, 'The deep cache worker stopped. Try a shorter date range.', 'DEEP_HISTORY_UNAVAILABLE')));
            job.worker.once('exit', () => { if (!job.settled) this.finish(job, new AppError(500, 'The deep cache worker exited before finishing.', 'DEEP_HISTORY_UNAVAILABLE')); });
        } catch { this.finish(job, new AppError(500, 'The deep cache worker could not start.', 'DEEP_HISTORY_UNAVAILABLE')); }
    }
    private finish(job: Job, error?: unknown, result?: WorkerSuccess): void {
        if (job.settled) return; job.settled = true;
        clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort);
        const queued = this.queue.indexOf(job); if (queued >= 0) this.queue.splice(queued, 1);
        const terminating = job.worker?.terminate();
        if (terminating) { this.stopping.add(terminating); void terminating.finally(() => this.stopping.delete(terminating)); }
        if (error) job.reject(error); else job.resolve(result!);
        if (this.active === job) {
            // A replacement job starts only after the previous native thread has stopped.
            void Promise.resolve(terminating).finally(() => { if (this.active === job) this.active = undefined; this.pump(); });
        }
    }
}
