import { Worker as NodeWorker } from 'node:worker_threads';
import { PineWorkerEngine as OfficialPineWorkerEngine } from '@luxalgo/vela-pinets';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExecutionSession, IndicatorModel, OHLCV, PreparedScript } from '../../src/plugin';
import { LocalPineEngine, PineWorkerBudget } from '../scripting/pine-runtime';
import { extractPineHostSource, loadPineHostSource, loadPineWorkerSource } from '../scripting/worker-source.mjs';

const BASE = Date.UTC(2024, 3, 8);
const bars = (count = 10): OHLCV[] => Array.from({ length: count }, (_, index) => ({
    time: BASE + index * 60_000, open: 100 + index, high: 102 + index, low: 99 + index, close: 100 + index, volume: 10,
}));
const market = { symbol: 'replay:NQM4', timeframe: '1', symbolInfo: {
    ticker: 'NQM4', tickerid: 'replay:NQM4', type: 'futures', mintick: 0.25, pointvalue: 20, currency: 'USD', timezone: 'America/Chicago', session: 'extended',
} };
const indicator = '//@version=6\nindicator("SMA test", overlay=true)\nlength = input.int(3, "Length")\nplot(ta.sma(close, length), title="Average")';
const engines: LocalPineEngine[] = [];
const workers: NodeWorker[] = [];
let workerSource: string;

beforeAll(async () => { workerSource = await loadPineWorkerSource(); });
afterEach(async () => {
    for (const engine of engines.splice(0)) engine.dispose();
    await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
    vi.useRealTimers();
});

function realWorker(): Pick<Worker, 'postMessage' | 'addEventListener' | 'terminate'> {
    const worker = new NodeWorker(`const { parentPort } = require('node:worker_threads');
        globalThis.fetch = () => { throw new Error('Network is unavailable to scripts.'); };
        globalThis.self = { postMessage: (data) => parentPort.postMessage(data),
            addEventListener: (kind, listener) => parentPort.on(kind, (data) => listener({ data })) };
        ${workerSource}`, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 192 } });
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

function engine(options: Partial<ConstructorParameters<typeof LocalPineEngine>[0]> = {}): LocalPineEngine {
    const result = new LocalPineEngine({ workerUrl: '/local-pine-worker.js', cutoff: () => bars().at(-1)!.time,
        workerBudget: new PineWorkerBudget(8), createWorker: realWorker, ...options });
    engines.push(result);
    return result;
}

function run(runtime: LocalPineEngine, prepared: PreparedScript, source = bars()): { done: Promise<IndicatorModel>; session: ExecutionSession } {
    let model: IndicatorModel | undefined;
    let finish: (value: IndicatorModel) => void;
    let fail: (error: unknown) => void;
    const done = new Promise<IndicatorModel>((resolve, reject) => { finish = resolve; fail = reject; });
    const session = runtime.execute({ prepared, bars: source, market, mode: 'static' }, {
        onModel: (value) => { model = value; }, onError: (error) => fail(error),
        onDone: () => model ? finish(model) : fail(new Error('The script returned no model.')),
    });
    return { done, session };
}

describe('official Pine worker integration', () => {
    it('extracts the shipped worker without evaluating the host bundle', () => {
        expect(workerSource.length).toBeGreaterThan(100_000);
        expect(workerSource).toContain('postMessage');
        expect(workerSource).not.toContain('importScripts(');
    });

    it('extracts the exact official host transport without bundling the runtime twice', async () => {
        const host = await loadPineHostSource();
        expect(host.length).toBeLessThan(12_000);
        expect(host).not.toContain('worker_default');
        const module = await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(host)}`) as { PineWorkerEngine: typeof OfficialPineWorkerEngine };
        expect(module.PineWorkerEngine.toString()).toBe(OfficialPineWorkerEngine.toString());
        const transport = new module.PineWorkerEngine({ createWorker: realWorker });
        try {
            const prepared = await transport.prepare(indicator, 'host-proof');
            let fail: (error: unknown) => void;
            let finish: () => void;
            const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
            const session = transport.execute({ prepared, bars: bars(), market, mode: 'static' },
                { onModel: () => {}, onDone: () => finish(), onError: (error) => fail(error) });
            await done;
            const context = await session.getContext?.(['plots']);
            expect(context?.plots.Average?.at(-1)?.value).toBe(108);
            session.stop();
        } finally { transport.terminate(); }
    }, 15_000);

    it.each([
        'var PineWorkerEngine = class { method() { return newlyAddedDependency(); } };',
        'var PineWorkerEngine = class { method() { return { newlyAddedDependency }; } };',
        'var PineWorkerEngine = class { method() { return import("https://outside.example/code.js"); } };',
    ])('fails closed when the official host transport introduces an unreviewed dependency', (source) => {
        expect(() => extractPineHostSource(source)).toThrow('unreviewed dependencies');
    });

    it('fails closed when the official host transport changes shape', () => {
        expect(() => extractPineHostSource('var PineWorkerEngine = makeEngine();')).toThrow('changed shape');
    });

    it('compiles Pine v6 inputs and computes real indicator values in a worker', async () => {
        const runtime = engine();
        const prepared = await runtime.prepare(indicator, 'sma-proof');
        expect(prepared.language).toBe('pine');
        expect(prepared.meta.title).toBe('SMA test');
        expect(prepared.inputs.some((input) => input.defval === 3)).toBe(true);
        const { done, session } = run(runtime, prepared);
        const model = await done;
        expect(model.id).toBe('sma-proof');
        const context = await session.getContext?.(['plots', 'variables', 'meta']);
        expect(context?.meta.title).toBe('SMA test');
        expect(context?.plots.Average?.at(-1)?.value).toBe(108);
    }, 15_000);

    it('runs actual strategy orders and exposes the official trade ledger', async () => {
        const runtime = engine();
        const prepared = await runtime.prepare(`//@version=6
strategy("Round trip", overlay=true, initial_capital=10000, default_qty_type=strategy.fixed, default_qty_value=1, commission_type=strategy.commission.cash_per_order, commission_value=1)
if bar_index == 1
    strategy.entry("Long", strategy.long)
if bar_index == 5
    strategy.close("Long")
plot(close)`, 'strategy-proof');
        const { done, session } = run(runtime, prepared);
        await done;
        const context = await session.getContext?.(['strategy', 'trades']);
        expect(context?.strategy?.position).toBe(0);
        expect(context?.strategy?.initialCapital).toBe(10000);
        expect(context?.strategy?.wins).toBe(1);
        expect(context?.trades).toHaveLength(1);
        expect(context?.trades?.[0]).toMatchObject({ side: 'long', qty: 1, open: false,
            entry: { price: 102 }, exit: { price: 106 }, commission: 2, pnl: 78 });
        expect(context?.strategy?.netPnl).toBe(78);
    }, 15_000);

    it('runs Pine v5 source through the same official runtime', async () => {
        const runtime = engine();
        const prepared = await runtime.prepare(indicator.replace('version=6', 'version=5'), 'sma-v5-proof');
        const { done, session } = run(runtime, prepared);
        await done;
        const context = await session.getContext?.(['plots']);
        expect(context?.plots.Average?.at(-1)?.value).toBe(108);
    }, 15_000);

    it('keeps both primary and request.security candles at the revealed cursor', async () => {
        const cutoff = BASE + 4 * 60_000;
        const fetchSeries = vi.fn(async () => bars(20));
        const runtime = engine({ cutoff: () => cutoff, fetchSeries });
        const prepared = await runtime.prepare('//@version=6\nindicator("Secondary")\nplot(request.security(syminfo.tickerid, "60", close), title="Other")', 'security-proof');
        const { done, session } = run(runtime, prepared, bars(20));
        await done;
        expect(fetchSeries).toHaveBeenCalled();
        for (const [, , range] of fetchSeries.mock.calls as unknown as [string, string, { to: number }][]) expect(range.to).toBeLessThanOrEqual(cutoff);
        const context = await session.getContext?.(['plots', 'barIndex']);
        expect(context?.barIndex).toBe(4);
        for (const points of Object.values(context?.plots ?? {})) expect(points.every((point) => point.time <= cutoff)).toBe(true);
    }, 15_000);

    it('allows another cached contract through the explicit pinned-data gateway', async () => {
        const secondary = bars().map((bar) => ({ ...bar, open: bar.open + 1000, high: bar.high + 1000, low: bar.low + 1000, close: bar.close + 1000 }));
        const fetchSeriesAt = vi.fn(async () => secondary);
        const runtime = engine({ fetchSeriesAt });
        const prepared = await runtime.prepare('//@version=6\nindicator("Cross contract")\nplot(request.security("CME:ESM4", "1", close), title="Other")', 'cross-proof');
        const { done, session } = run(runtime, prepared);
        await done;
        expect(fetchSeriesAt).toHaveBeenCalled();
        expect((fetchSeriesAt.mock.calls as unknown as [string, string, unknown, number][])[0]?.[0]).toBe('ESM4');
        const context = await session.getContext?.(['plots']);
        expect(context?.plots.Other?.at(-1)?.value).toBe(1109);
    }, 15_000);

    it('warns when an actual Pine ticker helper returns ordinary candles', async () => {
        const runtime = engine();
        const prepared = await runtime.prepare('//@version=6\nindicator("Ticker helper")\nplot(request.security(ticker.renko(syminfo.tickerid, "ATR", 14), "1", close), title="Returned")', 'stub-proof');
        const onWarning = vi.fn();
        let finish: () => void; let fail: (error: unknown) => void;
        const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
        const session = runtime.execute({ prepared, bars: bars(), market, mode: 'static' },
            { onModel: () => {}, onDone: () => finish(), onError: (error) => fail(error), onWarning });
        await done;
        const context = await session.getContext?.(['plots', 'warnings']);
        expect(context?.plots.Returned?.at(-1)?.value).toBe(109);
        expect(context?.warnings.some((warning) => warning.method === 'ticker.renko')).toBe(true);
        expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ method: 'ticker.renko', message: expect.stringContaining('returns ordinary candles') }));
    }, 15000);

    it('hard-terminates an infinite script while the main event loop remains usable', async () => {
        const runtime = engine({ runTimeoutMs: 120 });
        const prepared = await runtime.prepare('//@version=6\nindicator("Loop")\nfor i = 0 to 9999\n    for j = 0 to 9999\n        value = math.sin(j)\nplot(close)', 'loop-proof');
        let ticks = 0;
        const interval = setInterval(() => { ticks += 1; }, 10);
        const { done, session } = run(runtime, prepared);
        try { await expect(done).rejects.toMatchObject({ kind: 'timeout' }); }
        finally { clearInterval(interval); }
        expect(ticks).toBeGreaterThan(1);
        expect(await session.getContext?.()).toBeNull();
    }, 15_000);

    it('reports a syntax failure without leaving a worker slot held', async () => {
        const budget = new PineWorkerBudget(1);
        const runtime = engine({ workerBudget: budget });
        const prepared = await runtime.prepare('//@version=6\nindicator("Bad")\nplot(', 'bad');
        await expect(run(runtime, prepared).done).rejects.toMatchObject({ kind: 'compile' });
        expect(budget.active).toBe(0);
        await runtime.prepare(indicator, 'good');
        expect(budget.active).toBe(1);
    }, 15_000);
});

class FakeWorker {
    readonly postMessage = vi.fn<(message: unknown) => void>();
    readonly terminate = vi.fn();
    private listeners = new Map<string, ((event: { data?: unknown; message?: string }) => void)[]>();
    readonly addEventListener = ((kind: string, listener: (event: { data?: unknown; message?: string }) => void) => {
        this.listeners.set(kind, [...this.listeners.get(kind) ?? [], listener]);
    }) as Worker['addEventListener'];
    emit(data: unknown): void { for (const listener of this.listeners.get('message') ?? []) listener({ data }); }
    error(message: string): void { for (const listener of this.listeners.get('error') ?? []) listener({ message }); }
    prepared(): void {
        const request = this.postMessage.mock.calls.findLast(([message]) => (message as { kind: string }).kind === 'prepare')?.[0] as { reqId: number };
        this.emit({ kind: 'prepared', reqId: request.reqId, prepared: {
            language: 'pine', inputs: [], meta: { title: 'Fake', overlay: true }, reactsToViewport: false, token: {},
        } });
    }
}

describe('Pine worker lifecycle', () => {
    it('settles pending compilation when its chart closes', async () => {
        const worker = new FakeWorker();
        const runtime = engine({ createWorker: () => worker });
        const compiling = runtime.prepare(indicator, 'pending');
        runtime.dispose();
        await expect(compiling).rejects.toMatchObject({ kind: 'cancelled' });
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        await expect(runtime.prepare(indicator, 'closed')).rejects.toMatchObject({ kind: 'cancelled' });
    });

    it('times out a worker which never acknowledges compilation', async () => {
        vi.useFakeTimers();
        const worker = new FakeWorker();
        const runtime = engine({ createWorker: () => worker, prepareTimeoutMs: 20 });
        const checking = expect(runtime.prepare(indicator, 'pending')).rejects.toMatchObject({ kind: 'timeout' });
        await vi.advanceTimersByTimeAsync(25);
        await checking;
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it('reports native worker startup failures', async () => {
        const worker = new FakeWorker();
        const runtime = engine({ createWorker: () => worker });
        const compiling = runtime.prepare(indicator, 'broken');
        worker.error('Worker CSP rejected execution.');
        await expect(compiling).rejects.toMatchObject({ kind: 'worker', message: 'Worker CSP rejected execution.' });
    });

    it('enforces one shared thread budget across charts and releases it on stop', async () => {
        const budget = new PineWorkerBudget(1);
        const worker = new FakeWorker();
        const first = engine({ createWorker: () => worker, workerBudget: budget });
        const second = engine({ createWorker: () => new FakeWorker(), workerBudget: budget });
        const compiling = first.prepare(indicator, 'first');
        worker.prepared();
        const prepared = await compiling;
        expect(budget.active).toBe(1);
        await expect(second.prepare(indicator, 'second')).rejects.toMatchObject({ kind: 'capacity' });
        const execution = first.execute({ prepared, bars: bars(), market, mode: 'static' }, { onModel: () => {} });
        execution.stop(); execution.stop();
        expect(budget.active).toBe(0);
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it('can replace an existing script at a full worker budget without disabling its editor', async () => {
        const budget = new PineWorkerBudget(1);
        const firstWorker = new FakeWorker();
        const replacementWorker = new FakeWorker();
        const createWorker = vi.fn().mockReturnValueOnce(firstWorker).mockReturnValueOnce(replacementWorker);
        const runtime = engine({ createWorker, workerBudget: budget });
        const compiling = runtime.prepare(indicator, 'editable');
        firstWorker.prepared();
        const prepared = await compiling;
        const current = runtime.execute({ prepared, bars: bars(), market, mode: 'static' }, { onModel: () => {} });
        const replacing = runtime.prepare(indicator.replace('SMA test', 'Changed'), 'editable');
        firstWorker.prepared();
        const replacement = await replacing;
        expect(createWorker).toHaveBeenCalledTimes(1);
        expect(budget.active).toBe(1);
        current.stop();
        runtime.execute({ prepared: replacement, bars: bars(), market, mode: 'static' }, { onModel: () => {} });
        expect(createWorker).toHaveBeenCalledTimes(2);
        expect(budget.active).toBe(1);
        expect(replacementWorker.postMessage.mock.calls.some(([message]) => (message as { kind: string }).kind === 'execute')).toBe(true);
    });

    it('does not stop the old script when borrowed metadata preparation fails', async () => {
        const budget = new PineWorkerBudget(1);
        const worker = new FakeWorker();
        const runtime = engine({ createWorker: () => worker, workerBudget: budget });
        const compiling = runtime.prepare(indicator, 'editable');
        worker.prepared();
        runtime.execute({ prepared: await compiling, bars: bars(), market, mode: 'static' }, { onModel: () => {} });
        const replacing = runtime.prepare('bad replacement', 'editable');
        const request = worker.postMessage.mock.calls.findLast(([message]) => (message as { kind: string }).kind === 'prepare')?.[0] as { reqId: number };
        worker.emit({ kind: 'prepared', reqId: request.reqId, error: 'Invalid declaration.' });
        await expect(replacing).rejects.toMatchObject({ kind: 'compile' });
        expect(budget.active).toBe(1);
        expect(worker.terminate).not.toHaveBeenCalled();
    });

    it('does not resurrect a worker when an outstanding secondary fetch finishes after stop', async () => {
        const worker = new FakeWorker();
        const createWorker = vi.fn(() => worker);
        let finish: (value: OHLCV[]) => void;
        const fetchSeries = vi.fn(() => new Promise<OHLCV[]>((resolve) => { finish = resolve; }));
        const runtime = engine({ createWorker, fetchSeries });
        const compiling = runtime.prepare(indicator, 'fetch');
        worker.prepared();
        const prepared = await compiling;
        const execution = runtime.execute({ prepared, bars: bars(), market, mode: 'static' }, { onModel: () => {} });
        worker.emit({ kind: 'fetchSeries', reqId: 7, symbol: 'replay:NQM4', timeframe: '60', range: {} });
        expect(fetchSeries).toHaveBeenCalledTimes(1);
        execution.stop();
        const posted = worker.postMessage.mock.calls.length;
        finish!(bars());
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(createWorker).toHaveBeenCalledTimes(1);
        expect(worker.postMessage.mock.calls.length).toBe(posted);
    });

    it('pins secondary aggregation to the source cursor rather than the chart bucket open', async () => {
        const worker = new FakeWorker();
        let cursor = BASE + 49 * 60_000;
        let source: OHLCV[] = [{ ...bars()[0]!, close: 149 }];
        const fetchSeriesAt = vi.fn(async (_symbol: string, _timeframe: string, _range: unknown, cutoff: number) => [{ ...bars()[0]!, close: cutoff }]);
        const runtime = engine({ createWorker: () => worker, cutoff: () => cursor, fetchSeriesAt });
        const compiling = runtime.prepare(indicator, 'pinned');
        worker.prepared();
        const session = runtime.execute({ prepared: await compiling, bars: source, getBars: () => source, market: { ...market, timeframe: '60' }, mode: 'static' }, { onModel: () => {} });
        worker.emit({ kind: 'fetchSeries', reqId: 9, symbol: market.symbol, timeframe: '60', range: { to: BASE } });
        await Promise.resolve(); await Promise.resolve();
        expect(fetchSeriesAt.mock.calls[0]?.[3]).toBe(BASE + 49 * 60_000);
        expect(fetchSeriesAt.mock.calls[0]?.[2]).toMatchObject({ to: BASE });
        cursor = BASE + 70 * 60_000;
        source = [{ ...bars()[0]!, close: 159 }, { ...bars()[0]!, time: BASE + 60 * 60_000, close: 170 }];
        session.notifyBars();
        worker.emit({ kind: 'fetchSeries', reqId: 10, symbol: market.symbol, timeframe: '60', range: {} });
        await Promise.resolve(); await Promise.resolve();
        expect(fetchSeriesAt.mock.calls[1]?.[3]).toBe(BASE + 49 * 60_000);
        worker.emit({ kind: 'done', sessionId: 1 });
        worker.emit({ kind: 'fetchSeries', reqId: 11, symbol: market.symbol, timeframe: '60', range: {} });
        await Promise.resolve(); await Promise.resolve();
        expect(fetchSeriesAt.mock.calls[2]?.[3]).toBe(BASE + 70 * 60_000);
    });

    it('rejects provider escapes and retains the running chart', async () => {
        const worker = new FakeWorker();
        const fetchSeries = vi.fn(async () => bars());
        const runtime = engine({ createWorker: () => worker, fetchSeries });
        const compiling = runtime.prepare(indicator, 'cross');
        worker.prepared();
        runtime.execute({ prepared: await compiling, bars: bars(), market, mode: 'static' }, { onModel: () => {} });
        worker.emit({ kind: 'fetchSeries', reqId: 8, symbol: 'CME:ESM4', timeframe: '60', range: {} });
        await Promise.resolve(); await Promise.resolve();
        expect(fetchSeries).not.toHaveBeenCalled();
        expect(worker.postMessage.mock.calls.some(([message]) => (message as { reqId?: number; error?: string }).reqId === 8
            && (message as { error?: string }).error?.includes('no cached data'))).toBe(true);
    });

    it('warns once when the official runtime supplies secondary-symbol syminfo defaults', async () => {
        const worker = new FakeWorker();
        const onWarning = vi.fn();
        const fetchSeriesAt = vi.fn(async () => bars());
        const runtime = engine({ createWorker: () => worker, fetchSeriesAt });
        const compiling = runtime.prepare(indicator, 'secondary-meta');
        worker.prepared();
        runtime.execute({ prepared: await compiling, bars: bars(), market, mode: 'static' }, { onModel: () => {}, onWarning });
        for (const reqId of [20, 21]) worker.emit({ kind: 'fetchSeries', reqId, symbol: 'ESM4', timeframe: '60', range: {} });
        await Promise.resolve(); await Promise.resolve();
        expect(fetchSeriesAt).toHaveBeenCalledTimes(2);
        expect(onWarning).toHaveBeenCalledTimes(1);
        expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ method: 'request.security', message: expect.stringContaining('syminfo') }));
    });

    it('does not treat strings and comments as unsupported ticker helper calls', async () => {
        const worker = new FakeWorker();
        const onWarning = vi.fn();
        const runtime = engine({ createWorker: () => worker });
        const source = `//@version=6
indicator("ticker.renko(close)")
// ticker.kagi(close)
note = 'ticker.linebreak(close)'
escaped = "quoted \\\"ticker.pointfigure(close)\\\""
/* ticker.renko(close) */
plot(close)`;
        const compiling = runtime.prepare(source, 'quoted-stubs');
        worker.prepared();
        runtime.execute({ prepared: await compiling, bars: bars(), market, mode: 'static' }, { onModel: () => {}, onWarning });
        expect(onWarning).not.toHaveBeenCalled();
    });

    it('warns for every referenced stub once without blocking execution', async () => {
        const worker = new FakeWorker();
        const onWarning = vi.fn();
        const runtime = engine({ createWorker: () => worker });
        const compiling = runtime.prepare('indicator("Stubs")\nticker.renko(close)\nticker.renko(close)\nticker.kagi(close)\nticker.linebreak(close)\nticker.pointfigure(close)', 'all-stubs');
        worker.prepared();
        runtime.execute({ prepared: await compiling, bars: bars(), market, mode: 'static' }, { onModel: () => {}, onWarning });
        expect(onWarning.mock.calls.map(([warning]) => (warning as { method: string }).method)).toEqual(['ticker.renko', 'ticker.kagi', 'ticker.linebreak', 'ticker.pointfigure']);
        expect(worker.postMessage.mock.calls.some(([message]) => (message as { kind?: string }).kind === 'execute')).toBe(true);
    });

    it('rejects oversized primary history before posting it to the worker', async () => {
        const worker = new FakeWorker();
        const onError = vi.fn();
        const runtime = engine({ maxBars: 2, createWorker: () => worker });
        const compiling = runtime.prepare(indicator, 'large');
        worker.prepared();
        runtime.execute({ prepared: await compiling, bars: bars(), market, mode: 'static' }, { onModel: () => {}, onError });
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'data' }));
        expect(worker.postMessage.mock.calls.some(([message]) => (message as { kind?: string }).kind === 'execute')).toBe(false);
    });

    it('times out context extraction and settles its request', async () => {
        vi.useFakeTimers();
        const worker = new FakeWorker();
        const runtime = engine({ createWorker: () => worker, contextTimeoutMs: 20 });
        const compiling = runtime.prepare(indicator, 'context');
        worker.prepared();
        const execution = runtime.execute({ prepared: await compiling, bars: bars(), market, mode: 'static' }, { onModel: () => {} });
        const context = expect(execution.getContext?.()).rejects.toMatchObject({ kind: 'timeout' });
        await vi.advanceTimersByTimeAsync(25);
        await context;
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it('rejects non-local worker URLs', () => {
        expect(() => engine({ workerUrl: 'https://outside.example/worker.js' })).toThrow('same-origin');
        expect(() => engine({ workerUrl: 'blob:worker' })).toThrow('same-origin');
    });
});
