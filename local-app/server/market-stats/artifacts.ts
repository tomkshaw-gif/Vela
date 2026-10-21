import type { SessionBarsResult } from '@luxalgo/edge-stats/session-bars';
import type { MarketStatsInput, PreparedMarketStatsRequest } from './contract';
import { MARKET_STATS_LIMITS, MARKET_STATS_SOURCE, MarketStatsError } from './contract';
import { prepareMarketStats, checkAborted } from './prepare';
import { createHash } from 'node:crypto';

export type StatsArtifactOperation = { kind: 'session'; sessionId: string; contextBars: number }
    | { kind: 'export'; format: 'csv' | 'parquet' };
export type StatsArtifact = { kind: 'session'; session: SessionBarsResult }
    | { kind: 'export'; format: 'csv' | 'parquet'; rows: number; bytes: number; sha256: string; data: string };
export interface StatsArtifactJob { result: Promise<StatsArtifact>; dispose(): Promise<void> }
export type StartStatsArtifactJob = (input: PreparedMarketStatsRequest, operation: StatsArtifactOperation) => StatsArtifactJob;
export type StatsArtifactResponse = StatsArtifact & { source: typeof MARKET_STATS_SOURCE; coverage: PreparedMarketStatsRequest['coverage']; query: PreparedMarketStatsRequest['query'] };

function validateArtifact(result: StatsArtifact, operation: StatsArtifactOperation, input: PreparedMarketStatsRequest): void {
    const invalid = (): never => { throw new MarketStatsError('INVALID_RESULT', 'Invalid statistics inspection result.'); };
    if (!result || result.kind !== operation.kind || Buffer.byteLength(JSON.stringify(result)) > 12_000_000) invalid();
    if (result.kind === 'export') {
        if (operation.kind !== 'export' || result.format !== operation.format || Object.keys(result).length !== 6
            || !Number.isSafeInteger(result.rows) || result.rows < 0 || result.rows > input.bars.length
            || !Number.isSafeInteger(result.bytes) || result.bytes < 0 || result.bytes > 8_000_000
            || typeof result.data !== 'string' || result.data.length > Math.ceil(8_000_000 / 3) * 4
            || result.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(result.data)) invalid();
        const data = Buffer.from(result.data, 'base64');
        if (data.toString('base64') !== result.data || data.length !== result.bytes || createHash('sha256').update(data).digest('hex') !== result.sha256
            || result.format === 'parquet' && (data.subarray(0, 4).toString() !== 'PAR1' || data.subarray(-4).toString() !== 'PAR1')) invalid();
    } else {
        const s = result.session;
        if (operation.kind !== 'session' || Object.keys(result).length !== 2 || !s || s.sessionId !== operation.sessionId
            || s.symbol !== input.symbol.symbol || s.tf !== '1m' || s.complete !== true
            || !Number.isSafeInteger(s.startTs) || !Number.isSafeInteger(s.endTs) || s.endTs <= s.startTs
            || s.endTs > input.coverage.revealedUntil || s.endTs - s.startTs > 36 * 3600000
            || !Array.isArray(s.bars) || s.bars.length > 5000 || !s.context || !Array.isArray(s.context.bars) || s.context.bars.length > operation.contextBars) invalid();
        for (const [bars, from, until] of [[s.bars, s.startTs, s.endTs], [s.context.bars, input.coverage.firstBarOpen ?? 0, s.startTs]] as const) {
            let previous = -1;
            for (const bar of bars) {
                if (!Number.isSafeInteger(bar.ts) || bar.ts < from || bar.ts >= until || bar.ts <= previous
                    || ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
                    || bar.volume < 0 || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)) invalid();
                previous = bar.ts;
            }
        }
    }
}

export function artifactOperation(value: unknown): StatsArtifactOperation {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MarketStatsError('INVALID_INPUT', 'Choose a session or export operation.');
    const item = value as Record<string, unknown>;
    if (item.kind === 'session' && Object.keys(item).every(key => ['kind', 'sessionId', 'contextBars'].includes(key))
        && typeof item.sessionId === 'string' && item.sessionId.length > 0 && item.sessionId.length <= 240 && !/[\u0000-\u001f]/.test(item.sessionId)
        && Number.isSafeInteger(item.contextBars) && (item.contextBars as number) >= 0 && (item.contextBars as number) <= 240) return item as StatsArtifactOperation;
    if (item.kind === 'export' && Object.keys(item).length === 2 && ['csv', 'parquet'].includes(String(item.format)) && typeof item.format === 'string') return item as StatsArtifactOperation;
    throw new MarketStatsError('INVALID_INPUT', 'Invalid statistics inspection or export options.');
}

export function createStatsArtifactService(startJob: StartStatsArtifactJob) {
    let active: Promise<StatsArtifactResponse> | null = null; let stop: AbortController | null = null; let closed = false;
    return {
        async run(input: MarketStatsInput, operation: unknown, options: { signal?: AbortSignal } = {}): Promise<StatsArtifactResponse> {
            if (closed) throw new MarketStatsError('ABORTED', 'Statistics inspection is closed.');
            if (active) throw new MarketStatsError('BUSY', 'Another statistics inspection is running.');
            const selected = artifactOperation(operation); checkAborted(options.signal);
            const abort = new AbortController(); stop = abort;
            const cancel = () => abort.abort(); options.signal?.addEventListener('abort', cancel, { once: true });
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; cancel(); }, MARKET_STATS_LIMITS.defaultTimeoutMs);
            const task = (async () => {
                let job: StatsArtifactJob | undefined;
                try {
                    const prepared = await prepareMarketStats(input, abort.signal); checkAborted(abort.signal);
                    job = startJob(prepared, selected);
                    checkAborted(abort.signal);
                    const cancelled = new Promise<never>((_resolve, reject) => abort.signal.addEventListener('abort', () => reject(new MarketStatsError('ABORTED', 'Statistics inspection was cancelled.')), { once: true }));
                    const result = await Promise.race([job.result, cancelled]); checkAborted(abort.signal);
                    validateArtifact(result, selected, prepared);
                    return { ...result, source: MARKET_STATS_SOURCE, coverage: prepared.coverage, query: prepared.query };
                } catch (error) {
                    if (timedOut) throw new MarketStatsError('TIMEOUT', 'Statistics inspection exceeded its time limit.');
                    if (abort.signal.aborted) throw new MarketStatsError('ABORTED', 'Statistics inspection was cancelled.');
                    if (error instanceof MarketStatsError) throw error;
                    throw new MarketStatsError('ENGINE_FAILED', 'Statistics inspection could not complete.');
                } finally { if (job) await job.dispose(); }
            })();
            active = task;
            try { return await task; }
            finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); active = null; stop = null; }
        },
        async dispose() { closed = true; stop?.abort(); try { await active; } catch { /* The caller receives cancellation. */ } },
    };
}
