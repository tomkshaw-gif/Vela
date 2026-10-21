import { Worker as NodeWorker } from 'node:worker_threads';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Vela } from '../../src/Vela';
import type { IChartRenderer, IndicatorRenderHandle, VisibleRange } from '../../src/core/ports/IChartRenderer';
import type { EngineContextSnapshot, ExecutionRequest, ExecutionSession, IndicatorModel, PreparedScript } from '../../src/plugin';
import { createChartAnalysis, type AnalysisCaptureInput, type AnalysisEngine, type ChartAnalysis } from '../client/chart-analysis';
import { LocalPineEngine, PineWorkerBudget, type LocalPineOptions } from '../scripting/pine-runtime';
import { loadPineWorkerSource } from '../scripting/worker-source.mjs';
import type { AnalysisJobSummary, AnalysisScopeSummary } from '../shared/chart-analysis';
import { ANALYSIS_LIMITS, parseCaptureArgs, parseEvaluateArgs, safeJson, sourceFingerprint } from '../shared/chart-analysis';
import type { ChartAgentTarget } from '../shared/chart-agent';
import { parseTimeframe, timeframeBucket } from '../shared/timeframes';
import type { Bar, SessionView } from '../shared/types';

const BASE = Date.UTC(2024, 3, 8);
const COUNT = 3000;
const LAST = COUNT - 1;
const PIN = 1500;
const closeAt = (index: number): number => 1000 + ((index * 37) % 101) + index / 10;
const nq: Bar[] = Array.from({ length: COUNT }, (_, index) => {
    const close = closeAt(index);
    return { time: BASE + index * 60_000, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 10 };
});
/** The secondary contract is 5000 up to the pinned moment and 9000 afterwards, so any read past the pin is visible. */
const es: Bar[] = nq.map((bar, index) => { const close = index <= PIN ? 5000 : 9000; return { ...bar, open: close, high: close, low: close, close }; });
const target: ChartAgentTarget = { clientId: 'client', sessionId: 'session', generation: 1, cellId: 'cell' };
const view = { session: { id: 'session', cursor: LAST }, dataset: { id: 'dataset', name: 'NQ', symbol: 'NQM4', schema: 'ohlcv-1m', intervalMs: 60_000,
    instrument: { root: 'NQ', tickSize: 0.25, pointValue: 20 }, barCount: COUNT, start: nq[0]!.time, end: nq[LAST]!.time, source: 'demo',
    createdAt: '2024-01-01T00:00:00.000Z', checksum: 'checksum-nq' } } as unknown as SessionView;

function aggregate(bars: readonly Bar[], timeframe: string): Bar[] {
    const period = parseTimeframe(timeframe)!;
    const buckets = new Map<number, Bar>();
    for (const bar of bars) {
        const key = timeframeBucket(bar.time, period);
        const current = buckets.get(key);
        if (!current) buckets.set(key, { ...bar, time: key });
        else { current.high = Math.max(current.high, bar.high); current.low = Math.min(current.low, bar.low); current.close = bar.close; current.volume += bar.volume; }
    }
    return [...buckets.values()];
}

interface RequestRecord { path: string; url: URL; signal?: AbortSignal }

/** A series service with the real route's pinned-clock semantics: nothing opened after `cutoff` is ever served. */
function server() {
    const requests: RequestRecord[] = [];
    const state = { block: undefined as undefined | ((url: URL) => boolean), pending: 0, onRequest: undefined as undefined | ((url: URL) => void), omitChecksums: false, primaryChecksum: 'checksum-nq' };
    const serve = (url: URL): unknown => {
        const cutoff = Number(url.searchParams.get('cutoff'));
        if (!Number.isSafeInteger(cutoff) || cutoff > nq[LAST]!.time) throw new Error('Script data cutoff cannot advance beyond the saved replay cursor.');
        const timeframe = url.searchParams.get('timeframe')!;
        const limit = Number(url.searchParams.get('limit'));
        const symbol = url.searchParams.get('symbol') ?? 'NQM4';
        const source = symbol === 'NQM4' ? nq : es;
        const revealed = source.filter((bar) => bar.time <= cutoff);
        const cursorTime = revealed.at(-1)?.time ?? null;
        let bars = aggregate(revealed, timeframe);
        if (symbol !== 'NQM4') {
            const from = url.searchParams.has('from') ? Number(url.searchParams.get('from')) : undefined;
            const to = url.searchParams.has('to') ? Number(url.searchParams.get('to')) : undefined;
            bars = bars.filter((bar) => (from === undefined || bar.time >= from) && (to === undefined || bar.time <= to));
        }
        const hasMore = bars.length > limit;
        const result = { bars: bars.slice(-limit), timeframe, baseIntervalMs: 60_000, cursorTime, hasMore };
        if (state.omitChecksums) return symbol === 'NQM4' ? result : { ...result, datasetId: 'es-cache', symbol };
        return symbol === 'NQM4' ? { ...result, datasetId: 'dataset', checksum: state.primaryChecksum, sourceDatasets: [{ id: 'dataset', checksum: state.primaryChecksum }] }
            : { ...result, datasetId: 'es-cache', checksum: 'checksum-es', symbol, sourceDatasets: [{ id: 'es-cache', checksum: 'checksum-es' }] };
    };
    const api = {
        get: async <T>(path: string, signal?: AbortSignal): Promise<T> => {
            const url = new URL(path, 'http://local');
            requests.push({ path, url, signal });
            state.onRequest?.(url);
            if (state.block?.(url)) {
                state.pending += 1;
                await new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
            }
            return serve(url) as T;
        },
    };
    return { api, requests, state, primary: () => requests.filter((item) => !item.url.searchParams.has('symbol') && item.url.searchParams.get('limit') !== '1'),
        secondary: () => requests.filter((item) => item.url.searchParams.has('symbol')) };
}

function chartAt(range: VisibleRange | null, timeframe = '1', drawings: unknown[] = []): AnalysisCaptureInput['chart'] {
    return { market: { symbol: 'NQM4', timeframe }, getVisibleRange: () => range, drawings: { all: () => drawings } } as unknown as AnalysisCaptureInput['chart'];
}

const workers: NodeWorker[] = [];
let workerSource: string;
beforeAll(async () => { workerSource = await loadPineWorkerSource(); });

function realWorker(): Pick<Worker, 'postMessage' | 'addEventListener' | 'terminate'> {
    const worker = new NodeWorker(`const { parentPort } = require('node:worker_threads');
        globalThis.fetch = () => { throw new Error('Network is unavailable to scripts.'); };
        globalThis.self = { postMessage: (data) => parentPort.postMessage(data),
            addEventListener: (kind, listener) => parentPort.on(kind, (data) => listener({ data })) };
        ${workerSource}`, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    workers.push(worker);
    return {
        postMessage: (message: unknown) => worker.postMessage(message),
        addEventListener: ((kind: string, listener: (event: { data?: unknown; message?: string }) => void) => {
            if (kind === 'message') worker.on('message', (data: unknown) => listener({ data }));
            else if (kind === 'error') worker.on('error', (error) => listener({ message: error.message }));
            else if (kind === 'messageerror') worker.on('messageerror', () => listener({}));
        }) as Worker['addEventListener'],
        terminate: () => { void worker.terminate(); },
    };
}

interface EngineEvents { created: number; prepared: number; executed: number; disposed: number; afterPrepareCall?: () => void }
const live: ChartAnalysis[] = [];

function harness(options: { now?: () => number; stub?: (options: LocalPineOptions) => AnalysisEngine } = {}) {
    const service = server();
    const budget = new PineWorkerBudget(4);
    const events: EngineEvents = { created: 0, prepared: 0, executed: 0, disposed: 0 };
    let current = true;
    const createEngine = options.stub ?? ((engineOptions: LocalPineOptions): AnalysisEngine => {
        const engine = new LocalPineEngine({ ...engineOptions, workerBudget: budget, createWorker: realWorker });
        events.created += 1;
        return {
            prepare: (source, instanceId, prepareOptions) => {
                events.prepared += 1;
                const promise = engine.prepare(source, instanceId, prepareOptions);
                events.afterPrepareCall?.();
                return promise;
            },
            execute: (request, handlers) => { events.executed += 1; return engine.execute(request, handlers); },
            dispose: () => { events.disposed += 1; engine.dispose(); },
        };
    });
    const analysis = createChartAnalysis({ api: service.api, createEngine, ...(options.now ? { now: options.now } : {}) });
    live.push(analysis);
    const capture = (args: unknown = { from: nq[200]!.time, to: nq[300]!.time }, chart = chartAt(null), cutoff = nq[LAST]!.time, signal?: AbortSignal): Promise<AnalysisScopeSummary> =>
        analysis.capture({ target, chart, view, cutoff, signal, assertCurrent: () => { if (!current) throw new Error('The chart changed (stale).'); } }, args);
    const finish = async (jobId: string): Promise<AnalysisJobSummary> => {
        await vi.waitFor(() => expect(analysis.readJob(target, jobId).state).not.toBe('running'), { timeout: 25_000, interval: 10 });
        return analysis.readJob(target, jobId);
    };
    const run = async (scope: AnalysisScopeSummary, args: Record<string, unknown>): Promise<AnalysisJobSummary> =>
        finish(analysis.evaluate(target, scope.scopeId, args).jobId);
    return { service, budget, events, analysis, capture, finish, run, stale: () => { current = false; }, fresh: () => { current = true; } };
}

afterEach(async () => {
    for (const analysis of live.splice(0)) analysis.dispose();
    await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
    vi.useRealTimers();
});

function sma(index: number, length: number): number {
    let sum = 0;
    for (let offset = 0; offset < length; offset++) sum += closeAt(index - offset);
    return sum / length;
}
function rsi(index: number, length: number): number {
    let gain = 0; let loss = 0;
    for (let step = 1; step <= length; step++) { const change = closeAt(step) - closeAt(step - 1); gain += Math.max(change, 0); loss += Math.max(-change, 0); }
    let up = gain / length; let down = loss / length;
    for (let step = length + 1; step <= index; step++) {
        const change = closeAt(step) - closeAt(step - 1);
        up = (up * (length - 1) + Math.max(change, 0)) / length; down = (down * (length - 1) + Math.max(-change, 0)) / length;
    }
    return 100 - 100 / (1 + up / down);
}

const SMA_RSI = `//@version=6
indicator("Pinned", overlay=true)
len = input.int(5, "Length")
plot(ta.sma(close, len), title="Average")
plot(ta.rsi(close, 14), title="Strength")`;

describe('historical region capture', () => {
    it('pins an old region to the source clock even though the replay cursor is far ahead', async () => {
        const { capture, service } = harness();
        const scope = await capture();
        expect(scope.region).toMatchObject({ from: nq[200]!.time, to: nq[300]!.time, clamped: false, origin: 'range' });
        expect(scope.clock).toMatchObject({ sourceCutoff: nq[300]!.time, availableUntil: nq[300]!.time + 60_000, sourceIntervalMs: 60_000 });
        expect(scope.clock.label).toContain('open');
        expect(scope.cursorTime).toBe(nq[LAST]!.time);
        expect(scope.dataset).toMatchObject({ id: 'dataset', checksum: 'checksum-nq', intervalMs: 60_000 });
        expect(service.requests).toHaveLength(1);
        expect(service.requests[0]!.url.searchParams.get('cutoff')).toBe(String(nq[300]!.time));
        expect(service.requests[0]!.url.searchParams.get('limit')).toBe('1');
    });

    it('defaults to the visible range and clamps its end to the loaded cursor', async () => {
        const { capture, analysis } = harness();
        const scope = await capture({}, chartAt({ from: nq[400]!.time, to: nq[LAST]!.time + 600_000 }));
        expect(scope.region).toMatchObject({ from: nq[400]!.time, to: nq[LAST]!.time, requestedTo: nq[LAST]!.time + 600_000, clamped: true, origin: 'visible' });
        expect(scope.clock.sourceCutoff).toBe(nq[LAST]!.time);
        expect(analysis.readScope(target, scope.scopeId)).toEqual(scope);
    });

    it('derives a drawing region from its anchors and keeps price bounds as context', async () => {
        const { capture } = harness();
        const drawing = { id: 'd1', anchors: [{ time: nq[150]!.time, price: 1040 }, { time: nq[100]!.time, price: 1010 }] };
        const scope = await capture({ drawingId: 'd1' }, chartAt(null, '1', [drawing]));
        expect(scope.region).toMatchObject({ from: nq[100]!.time, to: nq[150]!.time, origin: 'drawing', drawingId: 'd1', priceLow: 1010, priceHigh: 1040 });
        await expect(capture({ drawingId: 'missing' }, chartAt(null, '1', [drawing]))).rejects.toThrow('Unknown drawing id');
    });

    it('rejects malformed, future or unrevealed regions', async () => {
        const { capture } = harness();
        await expect(capture({ from: 5 })).rejects.toThrow('both from and to');
        await expect(capture({ from: 5, to: 4 })).rejects.toThrow('must not exceed');
        await expect(capture({ from: 1, to: 2, drawingId: 'x' })).rejects.toThrow('not both');
        await expect(capture({ from: -1, to: 2 })).rejects.toThrow('between 0');
        await expect(capture({ nope: 1 })).rejects.toThrow('Unsupported argument');
        await expect(capture({ from: nq[LAST]!.time + 60_000, to: nq[LAST]!.time + 120_000 })).rejects.toThrow('after the loaded replay cursor');
        await expect(capture({ from: 0, to: nq[0]!.time - 1 })).rejects.toThrow('No replay candle is revealed');
        await expect(capture({}, chartAt(null))).rejects.toThrow('no visible range');
    });

    it('rejects a capture that goes stale during its request and stores nothing', async () => {
        const { capture, service, stale, fresh } = harness();
        service.state.onRequest = () => stale();
        await expect(capture()).rejects.toThrow('stale');
        fresh(); service.state.onRequest = undefined;
        for (let index = 0; index < ANALYSIS_LIMITS.maxScopes; index++) await capture();
        await expect(capture()).rejects.toThrow(`${ANALYSIS_LIMITS.maxScopes} analysis scopes`);
    });

    it('honours an aborted capture signal', async () => {
        const { capture, service } = harness();
        const controller = new AbortController();
        service.state.onRequest = () => controller.abort();
        await expect(capture({}, chartAt(null), nq[LAST]!.time, controller.signal)).rejects.toBeDefined();
    });

    it('expires scopes after five minutes and never evicts a live one for capacity', async () => {
        let clock = 1_000_000;
        const { capture, analysis } = harness({ now: () => clock });
        const first = await capture();
        for (let index = 1; index < ANALYSIS_LIMITS.maxScopes; index++) await capture();
        await expect(capture()).rejects.toThrow('analysis scopes');
        expect(analysis.readScope(target, first.scopeId).scopeId).toBe(first.scopeId);
        clock += ANALYSIS_LIMITS.scopeTtlMs + 1;
        expect(() => analysis.readScope(target, first.scopeId)).toThrow('expired');
        await expect(capture()).resolves.toBeDefined();
    });

    it('binds every operation to the original target', async () => {
        const { capture, analysis, run } = harness();
        const scope = await capture();
        const job = await run(scope, { source: SMA_RSI, limit: 5 });
        const others: ChartAgentTarget[] = [{ ...target, clientId: 'other' }, { ...target, sessionId: 'other' }, { ...target, generation: 2 }, { ...target, cellId: 'other' }, { clientId: 'client', sessionId: 'session', generation: 1 }];
        for (const other of others) {
            expect(() => analysis.readScope(other, scope.scopeId)).toThrow('Unknown or expired');
            expect(() => analysis.evaluate(other, scope.scopeId, { source: SMA_RSI })).toThrow('Unknown or expired');
            expect(() => analysis.readJob(other, job.jobId)).toThrow('Unknown or expired');
            expect(() => analysis.cancelJob(other, job.jobId)).toThrow('Unknown or expired');
        }
    });
});

describe('argument validation', () => {
    it('rejects malformed evaluate arguments before any job starts', async () => {
        const { capture, analysis, service } = harness();
        const scope = await capture();
        const before = service.requests.length;
        const bad: Array<[Record<string, unknown>, string]> = [
            [{}, 'plain text'], [{ source: '   ' }, 'must not be empty'], [{ source: 'x'.repeat(60_001) }, '60000'],
            [{ source: 'a\u0000b' }, 'plain text'], [{ source: 'a', extra: 1 }, 'Unsupported argument'],
            [{ source: 'a', inputs: [] }, 'object'], [{ source: 'a', inputs: { x: { y: 1 } } }, 'plain text'],
            [{ source: 'a', inputs: { x: Number.NaN } }, 'finite'], [{ source: 'a', inputs: { x: Infinity } }, 'finite'],
            [{ source: 'a', inputs: { token: 'x' } }, 'Invalid inputs key'], [{ source: 'a', properties: { __proto__x: 1, ['__proto__']: 1 } }, 'Invalid properties key'],
            [{ source: 'a', timeframe: '3x' }, 'not supported'], [{ source: 'a', timeframe: '1S' }, 'not supported'],
            [{ source: 'a', warmupBars: 0 }, 'between 1'], [{ source: 'a', warmupBars: 50_001 }, 'between 1'], [{ source: 'a', warmupBars: 1.5 }, 'integer'],
            [{ source: 'a', plotKeys: Array.from({ length: 17 }, (_, i) => `p${i}`) }, 'at most 16'],
            [{ source: 'a', variableKeys: Array.from({ length: 33 }, (_, i) => `v${i}`) }, 'at most 32'],
            [{ source: 'a', plotKeys: ['x', 'x'] }, 'repeat'], [{ source: 'a', limit: 501 }, 'between 1'], [{ source: 'a', limit: 0 }, 'between 1'],
            [{ source: 'a', pointsFrom: 'middle' }, 'start or end'], [{ source: 'a', includeTrades: 'yes' }, 'boolean'],
        ];
        for (const [args, message] of bad) expect(() => analysis.evaluate(target, scope.scopeId, args), JSON.stringify(args).slice(0, 80)).toThrow(message);
        expect(() => analysis.evaluate(target, scope.scopeId, { source: 'a', inputs: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])) })).toThrow('At most 64');
        expect(service.requests.length).toBe(before);
    });

    it('applies documented defaults and normalises the timeframe', () => {
        const request = parseEvaluateArgs({ source: 'x', timeframe: '5m' }, 'ohlcv-1m', '1');
        expect(request).toMatchObject({ timeframe: '5', warmupBars: 5000, limit: 100, pointsFrom: 'end', includeTrades: false, includeSource: false });
        expect(parseEvaluateArgs({ source: 'x' }, 'ohlcv-1m', '15').timeframe).toBe('15');
        expect(parseCaptureArgs(undefined)).toEqual({});
    });

    it('turns non-finite numbers into null, drops private keys and bounds depth', () => {
        const state = { cut: false };
        const value = safeJson({ a: Number.NaN, b: Infinity, token: 'x', nested: { apiKey: 'y', ok: [1, 2, { deep: { deeper: { deepest: 1 } } }] } }, undefined, state) as Record<string, unknown>;
        expect(value.a).toBeNull(); expect(value.b).toBeNull(); expect(value).not.toHaveProperty('token');
        expect(JSON.stringify(value)).not.toContain('apiKey');
        expect(state.cut).toBe(true);
    });
});

describe('detached Pine evaluation', () => {
    it('computes SMA and RSI from the pinned past in the real worker, not from the latest candles', async () => {
        const { capture, run, service, budget } = harness();
        const scope = await capture();
        const job = await run(scope, { source: SMA_RSI, inputs: { Length: 5 }, limit: 500 });
        expect(job.error).toBeUndefined();
        expect(job.state).toBe('completed');
        const result = job.result!;
        expect(result.settings.inputs).toEqual({ len: 5 });
        expect(result.coverage).toMatchObject({ barsLoaded: 301, firstBarTime: nq[0]!.time, lastBarTime: nq[300]!.time, barsInRegion: 101, warmupBarsBeforeRegion: 200, regionCovered: true, olderHistoryAvailable: false });
        const average = result.plots.find((plot) => plot.key === 'Average')!;
        const strength = result.plots.find((plot) => plot.key === 'Strength')!;
        expect(average.total).toBe(101);
        expect(average.points.map((point) => point.time)).toEqual(Array.from({ length: 101 }, (_, index) => nq[200 + index]!.time));
        average.points.forEach((point, offset) => expect(point.value).toBeCloseTo(sma(200 + offset, 5), 8));
        strength.points.forEach((point, offset) => expect(point.value).toBeCloseTo(rsi(200 + offset, 14), 6));
        expect(average.points.at(-1)!.value).not.toBeCloseTo(sma(LAST, 5), 3);
        expect(strength.points.at(-1)!.value).not.toBeCloseTo(rsi(LAST, 14), 3);
        expect(average.stats).toMatchObject({ finite: 101, last: average.points.at(-1)!.value });
        const [fetched] = service.primary();
        expect(service.primary()).toHaveLength(1);
        expect(fetched!.url.searchParams.get('cutoff')).toBe(String(nq[300]!.time));
        expect(fetched!.url.searchParams.get('limit')).toBe('5000');
        expect(fetched!.url.searchParams.has('from')).toBe(false);
        expect(fetched!.url.searchParams.has('to')).toBe(false);
        expect(budget.active).toBe(0);
        expect(result.provenance.partial).toBe(false);
        expect(result.provenance.secondary).toEqual([]);
        expect(result.computation).toMatchObject({ id: expect.stringContaining('analysis:'), dataCutoff: nq[300]!.time });
    }, 30_000);

    it('keeps the primary and secondary requests on the same historical clock', async () => {
        const { capture, run, service } = harness();
        const scope = await capture({ from: nq[1400]!.time, to: nq[PIN]!.time });
        const source = `//@version=6
indicator("Cross", overlay=true)
plot(request.security("ESM4", "60", close), title="Cross")
plot(close, title="Own")`;
        const job = await run(scope, { source, limit: 500 });
        expect(job.error).toBeUndefined();
        const pinned = String(nq[PIN]!.time);
        expect(service.secondary().length).toBeGreaterThan(0);
        for (const request of service.requests) expect(request.url.searchParams.get('cutoff'), request.path).toBe(pinned);
        for (const request of service.secondary()) {
            expect(request.url.searchParams.get('symbol')).toBe('ESM4');
            expect(request.url.searchParams.get('to')).not.toBe(pinned);
        }
        const cross = job.result!.plots.find((plot) => plot.key === 'Cross')!;
        expect(cross.points.length).toBeGreaterThan(0);
        for (const point of cross.points) expect(point.value === null || point.value === 5000).toBe(true);
        expect(cross.points.at(-1)!.value).toBe(5000);
        expect(job.result!.provenance).toMatchObject({ partial: false, primarySources: [{ id: 'dataset', checksum: 'checksum-nq' }],
            secondary: [{ symbol: 'ESM4', datasetId: 'es-cache', checksum: 'checksum-es', sourceDatasets: [{ id: 'es-cache', checksum: 'checksum-es' }] }] });
    }, 30_000);

    it('runs another timeframe on one pinned clock and keeps finer candles up to the source cutoff', async () => {
        const { capture, run, service } = harness();
        const to = nq[303]!.time;
        const scope = await capture({ from: nq[200]!.time, to }, chartAt(null, '5'));
        expect(scope.chart.timeframe).toBe('5');
        expect(scope.clock.sourceCutoff).toBe(to);
        const source = '//@version=6\nindicator("Close", overlay=true)\nplot(close, title="Close")';
        const fine = await run(scope, { source, timeframe: '1', limit: 500 });
        expect(fine.result!.plots[0]!.points.at(-1)).toEqual({ time: to, value: closeAt(303) });
        const coarse = await run(scope, { source, limit: 500 });
        expect(coarse.result!.coverage.timeframe).toBe('5');
        expect(coarse.result!.plots[0]!.points.at(-1)).toEqual({ time: nq[300]!.time, value: closeAt(303) });
        expect(service.primary().map((item) => item.url.searchParams.get('timeframe'))).toEqual(['1m', '5m']);
        for (const request of service.requests) expect(request.url.searchParams.get('cutoff')).toBe(String(to));
    }, 30_000);

    it('returns hidden plots and unplotted scalars from a fresh instance', async () => {
        const { capture, run } = harness();
        const scope = await capture();
        const source = `//@version=6
indicator("Hidden", overlay=true)
plot(close * 2, title="Doubled", display=display.none)
strength = ta.rsi(close, 14)
answer = 42
plot(close, title="Visible")`;
        const job = await run(scope, { source, variableKeys: ['strength', 'answer', 'missing'], plotKeys: ['Doubled', 'nope'], limit: 500 });
        expect(job.error).toBeUndefined();
        const result = job.result!;
        const hidden = result.plots.find((plot) => plot.key === 'Doubled')!;
        expect(hidden.points.at(-1)).toEqual({ time: nq[300]!.time, value: closeAt(300) * 2 });
        expect(result.variables.values.answer).toBe(42);
        expect(result.variables.values.strength as number).toBeCloseTo(rsi(300, 14), 6);
        expect(result.variables.asOfBarTime).toBe(nq[300]!.time);
        expect(result.outputs.plots.map((plot) => plot.key)).toEqual(['Doubled', 'Visible']);
        expect(result.outputs.variables).toEqual(expect.arrayContaining(['strength', 'answer']));
        expect(result.warnings.join(' ')).toContain('Unknown plot output: nope');
        expect(result.warnings.join(' ')).toContain('Unknown variable: missing');
    }, 30_000);

    it('marks strategy totals as warmup-inclusive and only returns trades when asked', async () => {
        const { capture, run } = harness();
        const scope = await capture();
        const source = `//@version=6
strategy("S", overlay=true, initial_capital=100000, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index % 40 == 10
    strategy.entry("L", strategy.long)
if bar_index % 40 == 30
    strategy.close("L")
plot(close, title="Close")`;
        const withTrades = await run(scope, { source, includeTrades: true });
        expect(withTrades.error).toBeUndefined();
        const result = withTrades.result!;
        expect(result.kind).toBe('strategy');
        expect(result.strategy).toMatchObject({ includesWarmupBars: true });
        expect(result.strategy!.note).toContain('warmup');
        expect(typeof result.strategy!.state.netPnl).toBe('number');
        expect(result.trades!.total).toBeGreaterThan(5);
        expect(result.trades!.items.every((trade) => trade.entry.time <= nq[300]!.time)).toBe(true);
        expect(result.trades!.inRegion).toBeLessThan(result.trades!.total);
        const without = await run(scope, { source });
        expect(without.result!.trades).toBeUndefined();
    }, 40_000);

    it('reports a warmup budget that does not reach the region start instead of faking coverage', async () => {
        const { capture, run } = harness();
        const scope = await capture();
        const job = await run(scope, { source: SMA_RSI, warmupBars: 50, limit: 500 });
        const result = job.result!;
        expect(result.coverage).toMatchObject({ barsLoaded: 50, firstBarTime: nq[251]!.time, regionCovered: false, olderHistoryAvailable: true, barsInRegion: 50, warmupBarsBeforeRegion: 0 });
        expect(result.warnings.join(' ')).toContain('budget starts at');
        expect(result.plots.find((plot) => plot.key === 'Average')!.total).toBe(50);
    }, 30_000);

    it('truncates explicitly, keeping the oldest or newest points', async () => {
        const { capture, run } = harness();
        const scope = await capture();
        const newest = (await run(scope, { source: SMA_RSI, limit: 20 })).result!;
        const average = newest.plots.find((plot) => plot.key === 'Average')!;
        expect(average).toMatchObject({ total: 101, returned: 20, truncated: true });
        expect(average.points[0]!.time).toBe(nq[281]!.time);
        expect(average.stats.finite).toBe(101);
        expect(newest.warnings.join(' ')).toContain('shortened to 20 per plot');
        const oldest = (await run(scope, { source: SMA_RSI, limit: 20, pointsFrom: 'start' })).result!;
        expect(oldest.plots[0]!.points[0]!.time).toBe(nq[200]!.time);
    }, 40_000);

    it('limits the total number of returned plot points', async () => {
        const { capture, run } = harness();
        const scope = await capture();
        const plots = Array.from({ length: 16 }, (_, index) => `plot(close + ${index}, title="P${index}")`).join('\n');
        const job = await run(scope, { source: `//@version=6\nindicator("Many", overlay=true)\n${plots}`, plotKeys: Array.from({ length: 16 }, (_, index) => `P${index}`), limit: 500 });
        const result = job.result!;
        expect(result.plots).toHaveLength(16);
        const total = result.plots.reduce((sum, plot) => sum + plot.points.length, 0);
        expect(total).toBeLessThanOrEqual(ANALYSIS_LIMITS.totalPoints);
        expect(result.plots[0]!.returned).toBe(Math.floor(ANALYSIS_LIMITS.totalPoints / 16));
        expect(JSON.stringify(job).length).toBeLessThan(ANALYSIS_LIMITS.responseBytes);
        const defaults = (await run(scope, { source: `//@version=6\nindicator("Many", overlay=true)\n${plots}` })).result!;
        expect(defaults.plots).toHaveLength(ANALYSIS_LIMITS.plotKeysDefault);
        expect(defaults.outputs.plots).toHaveLength(16);
    }, 40_000);

    it('rejects unknown, mistyped and ambiguous settings with the valid names, before fetching candles', async () => {
        const { capture, run, service, budget } = harness();
        const scope = await capture();
        const before = service.requests.length;
        const unknown = await run(scope, { source: SMA_RSI, inputs: { Lenght: 5 } });
        expect(unknown.state).toBe('failed');
        expect(unknown.error).toContain('Unknown input "Lenght"');
        expect(unknown.error).toContain('len ("Length")');
        const wrongType = await run(scope, { source: SMA_RSI, inputs: { len: 'ten' } });
        expect(wrongType.error).toContain('requires a number');
        const twice = await run(scope, { source: SMA_RSI, inputs: { len: 5, Length: 6 } });
        expect(twice.error).toContain('supplied twice');
        const property = await run(scope, { source: SMA_RSI, properties: { bogus: 1 } });
        expect(property.error).toContain('Unknown property "bogus"');
        expect(property.error).toContain('overlay');
        expect(service.requests.length).toBe(before);
        // A syntax error only surfaces when the transpiler runs, so it is the one failure that happens after the candles load.
        const broken = await run(scope, { source: 'indicator(' });
        expect(broken.state).toBe('failed');
        expect(broken.error).toBeTruthy();
        expect(budget.active).toBe(0);
    }, 40_000);
});

describe('chart isolation', () => {
    class RecordingRenderer implements IChartRenderer {
        readonly name = 'analysis-isolation';
        readonly features: readonly string[] = [];
        readonly capabilities = { panes: true, paneManagement: false, fills: 'primitive' as const, bgcolor: 'primitive' as const, hline: 'native' as const,
            markers: true, barcolor: 'approximated' as const, perPointColor: true, drawings: true, userDrawings: false, tables: true, inputsUI: true };
        readonly mounts: IndicatorModel[] = [];
        readonly updates: string[] = [];
        readonly viewportWrites: VisibleRange[] = [];
        range: VisibleRange = { from: nq[200]!.time, to: nq[300]!.time };
        applyFeature(): void {}
        readFeature(): unknown { return undefined; }
        mount(): void {}
        setTheme(): void {}
        resize(): void {}
        destroy(): void {}
        setBars(): void {}
        updateBar(): void {}
        ensurePane(): void {}
        removePane(): void {}
        mountIndicator(model: IndicatorModel): IndicatorRenderHandle { this.mounts.push(model); return { id: model.id }; }
        updateIndicator(handle: IndicatorRenderHandle): void { this.updates.push(handle.id); }
        removeIndicator(): void {}
        setIndicatorInputs(): void {}
        onInputChange(): () => void { return () => {}; }
        onRemoveIndicator(): () => void { return () => {}; }
        onCrosshairMove(): () => void { return () => {}; }
        onClick(): () => void { return () => {}; }
        getVisibleRange(): VisibleRange | null { return this.range; }
        setVisibleRange(range: VisibleRange): void { this.viewportWrites.push(range); this.range = range; }
        onViewportChange(): () => void { return () => {}; }
    }

    it('computes an arbitrary indicator without touching indicators, drawings, viewport or saved state', async () => {
        const renderer = new RecordingRenderer();
        const chart = new Vela({} as HTMLElement, { symbol: 'NQM4', timeframe: '1', live: false, volume: false, data: nq.slice(0, 400) }, { renderer, engines: [] });
        try {
            await chart.ready();
            const saved = vi.fn();
            const state = (): string => JSON.stringify({ indicators: chart.indicators().map((item) => item.id), drawings: chart.drawings.toJSON(), range: chart.getVisibleRange(), market: chart.market });
            const before = state();
            const mounted = renderer.mounts.length; const updated = renderer.updates.length;
            const { analysis, run } = harness();
            const scope = await analysis.capture({ target, chart, view, cutoff: nq[LAST]!.time, assertCurrent: () => undefined }, {});
            expect(scope.region).toMatchObject({ from: nq[200]!.time, to: nq[300]!.time, origin: 'visible' });
            const job = await run(scope, { source: SMA_RSI, limit: 5 });
            expect(job.state).toBe('completed');
            expect(state()).toBe(before);
            expect(chart.indicators()).toHaveLength(0);
            expect([renderer.mounts.length, renderer.updates.length, renderer.viewportWrites.length, saved.mock.calls.length]).toEqual([mounted, updated, 0, 0]);
        } finally { chart.destroy(); }
    }, 30_000);
});

describe('stale reads and provenance', () => {
    it('retains provenance for more than sixteen secondary series without claiming omissions are complete', async () => {
        const { capture, run } = harness(); const scope = await capture();
        const terms = Array.from({ length: 17 }, (_, index) => `request.security("S${index}", "1", close)`);
        const done = await run(scope, { source: `//@version=6\nindicator("All secondary sources")\nplot(${terms.join(' + ')})` });
        expect(done.state).toBe('completed');
        expect(done.result!.provenance.secondary).toHaveLength(17);
        expect(done.result!.provenance.secondary.at(-1)).toMatchObject({ symbol: 'S16', sourceDatasets: [{ id: 'es-cache', checksum: 'checksum-es' }] });
        expect(done.result!.provenance.partial).toBe(false);
    }, 30000);
    it('refuses to present a scope or a finished result once the captured chart state is gone, while cancel still works', async () => {
        const { capture, analysis, run, stale, fresh } = harness();
        const scope = await capture();
        const done = await run(scope, { source: SMA_RSI, limit: 5 });
        expect(done.state).toBe('completed');
        stale();
        expect(() => analysis.readScope(target, scope.scopeId)).toThrow('stale');
        expect(() => analysis.readJob(target, done.jobId)).toThrow('stale');
        expect(() => analysis.cancelJob(target, done.jobId)).not.toThrow();
        fresh();
        expect(analysis.readScope(target, scope.scopeId).scopeId).toBe(scope.scopeId);
        expect(analysis.readJob(target, done.jobId).state).toBe('completed');
    }, 30_000);

    it('reports partial provenance when a reply does not identify its dataset, and rejects a changed dataset', async () => {
        const first = harness();
        first.service.state.omitChecksums = true;
        const partial = await first.run(await first.capture({ from: nq[1400]!.time, to: nq[PIN]!.time }), { source: '//@version=6\nindicator("x")\nplot(request.security("ESM4", "60", close))' });
        expect(partial.result!.provenance).toMatchObject({ partial: true, primarySources: [], secondary: [{ datasetId: 'es-cache', checksum: null }] });
        const second = harness();
        const scope = await second.capture();
        second.service.state.primaryChecksum = 'checksum-other';
        const changed = await second.run(scope, { source: SMA_RSI });
        expect(changed.state).toBe('failed');
        expect(changed.error).toContain('dataset changed');
        await expect(second.capture()).rejects.toThrow('dataset changed');
    }, 30_000);
});

describe('cancellation and release', () => {
    it('releases the engine when cancelled while compiling', async () => {
        const { capture, analysis, events, budget } = harness();
        const scope = await capture();
        const job = analysis.evaluate(target, scope.scopeId, { source: SMA_RSI });
        events.afterPrepareCall = () => { analysis.cancelJob(target, job.jobId); };
        await vi.waitFor(() => expect(events.prepared).toBe(1), { timeout: 10_000 });
        const settled = analysis.readJob(target, job.jobId);
        expect(settled).toMatchObject({ state: 'cancelled', phase: 'finished' });
        expect(events.disposed).toBeGreaterThanOrEqual(1);
        expect(budget.active).toBe(0);
        expect(events.executed).toBe(0);
    }, 20_000);

    it('aborts a blocked primary fetch and releases the engine on cancel', async () => {
        const { capture, analysis, service, events, budget } = harness();
        const scope = await capture();
        service.state.block = (url) => url.searchParams.get('limit') !== '1';
        const job = analysis.evaluate(target, scope.scopeId, { source: SMA_RSI });
        await vi.waitFor(() => expect(service.state.pending).toBe(1), { timeout: 15_000 });
        const signal = service.primary()[0]!.signal!;
        expect(signal.aborted).toBe(false);
        expect(budget.active).toBe(1);
        analysis.cancelJob(target, job.jobId);
        expect(signal.aborted).toBe(true);
        expect(analysis.readJob(target, job.jobId).state).toBe('cancelled');
        expect(budget.active).toBe(0);
        expect(events.disposed).toBe(1);
        expect(events.executed).toBe(0);
    }, 30_000);

    it('aborts a blocked secondary fetch and releases the running worker on cancel', async () => {
        const { capture, analysis, service, budget } = harness();
        const scope = await capture({ from: nq[1400]!.time, to: nq[PIN]!.time });
        service.state.block = (url) => url.searchParams.has('symbol');
        const source = '//@version=6\nindicator("Cross", overlay=true)\nplot(request.security("ESM4", "60", close), title="Cross")';
        const job = analysis.evaluate(target, scope.scopeId, { source });
        await vi.waitFor(() => expect(service.state.pending).toBeGreaterThan(0), { timeout: 15_000 });
        const signal = service.secondary()[0]!.signal!;
        expect(analysis.readJob(target, job.jobId)).toMatchObject({ state: 'running', phase: 'running' });
        analysis.cancelJob(target, job.jobId);
        expect(signal.aborted).toBe(true);
        expect(budget.active).toBe(0);
    }, 30_000);

    it('terminates a long-running script on cancel', async () => {
        const { capture, analysis, budget, events } = harness();
        const scope = await capture();
        const source = '//@version=6\nindicator("Spin")\nfloat x = 0.0\nfor i = 0 to 20000\n    x += math.sin(i + bar_index)\nplot(x)';
        const job = analysis.evaluate(target, scope.scopeId, { source });
        await vi.waitFor(() => expect(events.executed).toBe(1), { timeout: 15_000 });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(analysis.readJob(target, job.jobId).state).toBe('running');
        analysis.cancelJob(target, job.jobId);
        expect(analysis.readJob(target, job.jobId).state).toBe('cancelled');
        expect(budget.active).toBe(0);
    }, 30_000);

    it('fails the job when the chart turns stale during the run and releases the engine', async () => {
        const { capture, analysis, finish, events, service, stale, fresh, budget } = harness();
        const scope = await capture();
        service.state.onRequest = (url) => { if (url.searchParams.get('limit') !== '1') stale(); };
        const started = analysis.evaluate(target, scope.scopeId, { source: SMA_RSI });
        await vi.waitFor(() => expect(events.disposed).toBeGreaterThanOrEqual(1), { timeout: 15_000 });
        expect(() => analysis.readJob(target, started.jobId)).toThrow('stale');
        fresh();
        const job = await finish(started.jobId);
        expect(job.state).toBe('failed');
        expect(job.error).toContain('stale');
        expect(job.result).toBeUndefined();
        expect(budget.active).toBe(0);
    }, 30_000);

    it('refuses to evaluate against a scope whose chart is no longer current', async () => {
        const { capture, analysis, stale } = harness();
        const scope = await capture();
        stale();
        expect(() => analysis.evaluate(target, scope.scopeId, { source: SMA_RSI })).toThrow('stale');
    });
});

describe('job bookkeeping with a scripted engine', () => {
    const prepared = (): PreparedScript => ({ language: 'pine', inputs: [{ key: 'len', title: 'Length', type: 'int', defval: 5 }], props: [],
        meta: { title: 'Scripted', overlay: false }, reactsToViewport: false, token: {} });
    const snapshot = (overrides: Partial<EngineContextSnapshot> = {}): EngineContextSnapshot => ({
        language: 'pine', phase: 'idle', barIndex: 300, meta: { title: 'Scripted', overlay: false },
        plots: { A: [{ time: nq[250]!.time, value: Number.NaN }, { time: nq[251]!.time, value: Infinity }, { time: nq[252]!.time, value: 7 }, { time: nq[999]!.time, value: 8 }] },
        variables: {}, warnings: [], ...overrides,
    });
    function scripted(make: (identity?: ReturnType<NonNullable<ExecutionRequest['getComputation']>>) => EngineContextSnapshot | Promise<EngineContextSnapshot | null>, hang = false) {
        const disposed = vi.fn();
        const factory = (): AnalysisEngine => ({
            prepare: () => hang ? new Promise<PreparedScript>(() => undefined) : Promise.resolve(prepared()),
            execute: (request, handlers): ExecutionSession => {
                const identity = request.getComputation?.();
                queueMicrotask(() => handlers.onDone?.());
                return { getContext: async () => make(identity), stop: () => undefined, update: () => undefined, setVisibleRange: () => undefined, notifyBars: () => undefined };
            },
            dispose: disposed,
        });
        return { factory, disposed };
    }

    it('nulls non-finite plot values and variables, drops private names and never returns the source by default', async () => {
        const stub = scripted(() => snapshot({ variables: { token: 'secret', n: Number.NaN, ok: 3, nested: { password: 'x', fine: Infinity } } }));
        const { capture, run } = harness({ stub: stub.factory });
        const scope = await capture();
        const source = '//@version=6\nindicator("x")\nplot(close)';
        const job = await run(scope, { source, variableKeys: ['n', 'ok', 'nested', 'token'], limit: 500 });
        const result = job.result!;
        expect(result.plots[0]!.points).toEqual([{ time: nq[250]!.time, value: null }, { time: nq[251]!.time, value: null }, { time: nq[252]!.time, value: 7 }]);
        expect(result.plots[0]!.stats).toMatchObject({ finite: 1, min: 7, max: 7, first: 7, last: 7 });
        expect(result.variables.values).toEqual({ n: null, ok: 3, nested: { fine: null } });
        expect(result.outputs.variables).not.toContain('token');
        expect(JSON.stringify(job)).not.toContain('secret');
        expect(result.settings.source).toBeUndefined();
        expect(result.settings).toMatchObject({ sourceChars: source.length, sourceFingerprint: sourceFingerprint(source) });
        expect(stub.disposed).toHaveBeenCalled();
        const withSource = await run(scope, { source, includeSource: true });
        expect(withSource.result!.settings.source).toBe(source);
    });

    it('degrades an oversized response in a fixed order and flags what was dropped', async () => {
        const big = Array.from({ length: 50 }, () => Array.from({ length: 50 }, () => 'x'.repeat(480)));
        const stub = scripted(() => snapshot({ variables: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`big${index}`, big])) }));
        const { capture, run } = harness({ stub: stub.factory });
        const scope = await capture();
        const job = await run(scope, { source: '//@version=6\nindicator("x")\nplot(close)' });
        expect(job.state).toBe('completed');
        expect(job.result!.trimmed).toContain('variables');
        expect(job.result!.variables.values).toEqual({});
        expect(new TextEncoder().encode(JSON.stringify(job)).byteLength).toBeLessThan(ANALYSIS_LIMITS.responseBytes);
    });

    it('fails a job whose computation never reached the ready state', async () => {
        const identity = { id: 'x', source: '', inputs: {}, props: {}, market: { symbol: 's', timeframe: '1' }, bars: { revision: 1, count: 1, firstTime: 0, lastTime: 0 } };
        const stub = scripted(() => snapshot({ computation: { state: 'stale', requested: identity } }));
        const { capture, run } = harness({ stub: stub.factory });
        const job = await run(await capture(), { source: '//@version=6\nindicator("x")\nplot(close)' });
        expect(job.state).toBe('failed');
        expect(job.error).toContain('did not complete cleanly');
    });

    it('requires the completed run to be the requested run, not just a ready flag', async () => {
        const source = '//@version=6\nindicator("x")\nplot(close)';
        const wrong = scripted((identity) => snapshot({ computation: { state: 'ready', requested: identity!, completed: { ...identity!, id: 'analysis:someone-else' } } }));
        const first = harness({ stub: wrong.factory });
        const bad = await first.run(await first.capture(), { source });
        expect(bad.state).toBe('failed');
        expect(bad.error).toContain('did not complete cleanly');
        const moved = scripted((identity) => snapshot({ computation: { state: 'ready', requested: { ...identity!, id: 'analysis:newer' }, completed: identity! } }));
        const second = harness({ stub: moved.factory });
        expect((await second.run(await second.capture(), { source })).state).toBe('failed');
        const right = scripted((identity) => snapshot({ computation: { state: 'ready', requested: identity!, completed: identity! } }));
        const third = harness({ stub: right.factory });
        const good = await third.run(await third.capture(), { source });
        expect(good.state).toBe('completed');
        expect(good.result!.computation).toMatchObject({ id: expect.stringContaining('analysis:') });
    });

    it('stops a job at thirty seconds and releases its engine', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const stub = scripted(() => snapshot(), true);
        const { capture, analysis } = harness({ stub: stub.factory });
        const scope = await capture();
        const job = analysis.evaluate(target, scope.scopeId, { source: '//@version=6\nindicator("x")\nplot(close)' });
        await vi.advanceTimersByTimeAsync(ANALYSIS_LIMITS.jobMs - 1);
        expect(analysis.readJob(target, job.jobId).state).toBe('running');
        await vi.advanceTimersByTimeAsync(1);
        const stopped = analysis.readJob(target, job.jobId);
        expect(stopped).toMatchObject({ state: 'failed' });
        expect(stopped.error).toContain('30 seconds');
        expect(stub.disposed).toHaveBeenCalledTimes(1);
    });

    it('allows two concurrent jobs, refuses a third and frees the slot on cancel', async () => {
        const stub = scripted(() => snapshot(), true);
        const { capture, analysis } = harness({ stub: stub.factory });
        const scope = await capture();
        const args = { source: '//@version=6\nindicator("x")\nplot(close)' };
        const first = analysis.evaluate(target, scope.scopeId, args);
        analysis.evaluate(target, scope.scopeId, args);
        expect(() => analysis.evaluate(target, scope.scopeId, args)).toThrow('2 analysis jobs are already running');
        await new Promise((resolve) => setTimeout(resolve, 0));
        analysis.cancelJob(target, first.jobId);
        expect(stub.disposed).toHaveBeenCalledTimes(1);
        expect(() => analysis.evaluate(target, scope.scopeId, args)).not.toThrow();
    });

    it('prunes completed jobs after five minutes and keeps at most thirty-two', async () => {
        let clock = 5_000_000;
        const stub = scripted(() => snapshot());
        const { capture, analysis, finish } = harness({ stub: stub.factory, now: () => clock });
        const scope = await capture();
        const args = { source: '//@version=6\nindicator("x")\nplot(close)' };
        const ids: string[] = [];
        for (let index = 0; index < ANALYSIS_LIMITS.maxJobs + 1; index++) {
            const job = analysis.evaluate(target, scope.scopeId, args);
            ids.push(job.jobId);
            await finish(job.jobId);
        }
        expect(() => analysis.readJob(target, ids[0]!)).toThrow('Unknown or expired');
        expect(analysis.readJob(target, ids.at(-1)!).state).toBe('completed');
        expect(analysis.readJob(target, ids[1]!).state).toBe('completed');
        clock += ANALYSIS_LIMITS.jobRetentionMs + 1;
        expect(() => analysis.readJob(target, ids.at(-1)!)).toThrow('Unknown or expired');
    });

    it('rejects readJob arguments it does not know and closes cleanly on dispose', async () => {
        const stub = scripted(() => snapshot(), true);
        const { capture, analysis } = harness({ stub: stub.factory });
        const scope = await capture();
        const job = analysis.evaluate(target, scope.scopeId, { source: '//@version=6\nindicator("x")\nplot(close)' });
        expect(() => analysis.readJob(target, job.jobId, { wait: true })).toThrow('Unsupported argument');
        await new Promise((resolve) => setTimeout(resolve, 0));
        analysis.dispose();
        expect(stub.disposed).toHaveBeenCalledTimes(1);
        expect(() => analysis.readJob(target, job.jobId)).toThrow('closed');
        expect(() => analysis.evaluate(target, scope.scopeId, { source: 'x' })).toThrow('closed');
        await expect(capture()).rejects.toThrow('closed');
    });
});
