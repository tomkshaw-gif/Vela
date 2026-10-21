import { Worker as NodeWorker } from 'node:worker_threads';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Vela } from '../../src/Vela';
import type { IndicatorHandle } from '../../src/core/IndicatorHandle';
import type { IChartRenderer, IndicatorRenderHandle, VisibleRange } from '../../src/core/ports/IChartRenderer';
import type { MarketDataFeed } from '../../src/core/ports/MarketDataFeed';
import { registerNativeIndicator, unregisterNativeIndicator, type EngineContextSnapshot, type IndicatorModel, type NativeIndicatorContext,
    type NativeIndicatorOutput, type OHLCV, type PreparedScript } from '../../src/plugin';
import { LocalPineEngine, PineWorkerBudget } from '../scripting/pine-runtime';
import { loadPineWorkerSource } from '../scripting/worker-source.mjs';
import { createChartAgentController, type ChartAgentController } from '../client/chart-agent';
import type { SessionView } from '../shared/types';
import type { ChartAgentTask } from '../shared/chart-agent';

const BASE = Date.UTC(2024, 3, 8);
const bars = (count = 6): OHLCV[] => Array.from({ length: count }, (_, index) => ({
    time: BASE + index * 60_000, open: 100 + index, high: 102 + index, low: 99 + index, close: 100 + index, volume: 10,
}));
const SOURCE = '//@version=6\nindicator("Identity", overlay=true)\nk = input.int(1, "K")\nplot(close * k, title="Scaled")';
const SECONDARY_SOURCE = '//@version=6\nindicator("Identity", overlay=true, precision=2)\nk = input.int(1, "K")\nother = request.security("ESM4", k == 1 ? "1" : "2", close)\nplot(close * k + other * 0, title="Scaled")';
const charts: Vela[] = [];
const runtimes: LocalPineEngine[] = [];
const workers: NodeWorker[] = [];
const agents: ChartAgentController[] = [];
let workerSource: string;

beforeAll(async () => { workerSource = await loadPineWorkerSource(); });
afterEach(async () => {
    for (const agent of agents.splice(0)) agent.dispose();
    for (const chart of charts.splice(0)) chart.destroy();
    for (const runtime of runtimes.splice(0)) runtime.dispose();
    await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
    unregisterNativeIndicator('context-async-test');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

class RecordingRenderer implements IChartRenderer {
    range: VisibleRange | null = null;
    private readonly viewportHandlers = new Set<(range: VisibleRange) => void>();
    readonly name = 'computation-test';
    readonly features: readonly string[] = [];
    readonly capabilities = {
        panes: true, paneManagement: false, fills: 'primitive' as const, bgcolor: 'primitive' as const,
        hline: 'native' as const, markers: true, barcolor: 'approximated' as const, perPointColor: true,
        drawings: true, userDrawings: false, tables: true, inputsUI: true,
    };
    readonly mounts: IndicatorModel[] = [];
    readonly mounted = new Set<string>();
    readonly updates: string[] = [];
    applyFeature(): void {}
    readFeature(): unknown { return undefined; }
    mount(): void {}
    setTheme(): void {}
    resize(): void {}
    destroy(): void { this.mounted.clear(); }
    setBars(): void {}
    updateBar(): void {}
    ensurePane(): void {}
    removePane(): void {}
    mountIndicator(model: IndicatorModel): IndicatorRenderHandle {
        this.mounts.push(model);
        this.mounted.add(model.id);
        return { id: model.id };
    }
    updateIndicator(handle: IndicatorRenderHandle): void { this.updates.push(handle.id); }
    removeIndicator(handle: IndicatorRenderHandle): void { this.mounted.delete(handle.id); }
    setIndicatorInputs(): void {}
    onInputChange(): () => void { return () => {}; }
    onRemoveIndicator(): () => void { return () => {}; }
    onCrosshairMove(): () => void { return () => {}; }
    onClick(): () => void { return () => {}; }
    getVisibleRange(): VisibleRange | null { return this.range; }
    setVisibleRange(range: VisibleRange): void { this.range = range; for (const handler of this.viewportHandlers) handler(range); }
    onViewportChange(handler: (range: VisibleRange) => void): () => void { this.viewportHandlers.add(handler); return () => this.viewportHandlers.delete(handler); }
}

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

async function fixture(options: Partial<ConstructorParameters<typeof LocalPineEngine>[0]> = {}, live = false, feedOverride?: MarketDataFeed) {
    let cutoff = bars().at(-1)!.time;
    let liveBar: ((bar: OHLCV) => void) | undefined;
    const dataFeed: MarketDataFeed = { load: async (config) => config.data ?? bars(),
        subscribe: (_config, onBar) => { liveBar = onBar; return () => { liveBar = undefined; }; } };
    const renderer = new RecordingRenderer();
    const budget = options.workerBudget ?? new PineWorkerBudget(8);
    const runtime = new LocalPineEngine({ workerUrl: '/local-pine-worker.js', cutoff: () => cutoff,
        workerBudget: budget, createWorker: realWorker, ...options });
    const chart = new Vela({} as HTMLElement, { symbol: 'NQM4', timeframe: '1', live, volume: false, data: bars() },
        { renderer, engines: [runtime], ...(live || feedOverride ? { dataFeed: feedOverride ?? dataFeed } : {}) });
    runtimes.push(runtime);
    charts.push(chart);
    await chart.ready();
    return { chart, runtime, renderer, budget, setCutoff: (next: number) => { cutoff = next; }, tick: (bar: OHLCV) => liveBar?.(bar) };
}

async function ready(handle: IndicatorHandle): Promise<EngineContextSnapshot> {
    let snapshot: EngineContextSnapshot | null = null;
    await vi.waitFor(async () => {
        snapshot = await handle.context(['plots', 'computation']);
        expect(snapshot?.computation?.state).toBe('ready');
    }, { timeout: 10_000, interval: 10 });
    return snapshot!;
}

function delayedSeries() {
    let blocked = false;
    const pending: Array<(value: OHLCV[]) => void> = [];
    const fetchSeriesAt = vi.fn((): Promise<OHLCV[]> => blocked
        ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve(bars()));
    return {
        fetchSeriesAt,
        block: () => { blocked = true; },
        release: () => { blocked = false; for (const resolve of pending.splice(0)) resolve(bars()); },
        pending: () => pending.length,
    };
}

describe('Vela Pine computation identity', () => {
    it('resolves the public script run with settled strategy state and source variables', async () => {
        const { chart } = await fixture();
        const result = await chart.runScript('//@version=6\nstrategy("Settled strategy", initial_capital=12345)\nvalue=close*2\nplot(value, title="Value")');
        expect(result.ok).toBe(true);
        expect(result.run?.kind).toBe('strategy');
        expect(result.run?.strategy?.initialCapital).toBe(12345);
        expect(result.run?.vars.value).toBe(210);
        expect((await result.run?.series('Value'))?.at(-1)?.value).toBe(210);
    }, 15000);
    it.each([
        ['plotted strategy', '//@version=6\nstrategy("Agent plotted", initial_capital=12345)\nvalue=close*2\nplot(value, title="Value")'],
        ['unplotted strategy', '//@version=6\nstrategy("Agent empty", initial_capital=12345)\nvalue=close*2'],
    ] as const)('completes a real controller run_script job through public readiness for a %s', async (_label, source) => {
        const { chart } = await fixture(); await chart.setMarket({ symbol: 'replay:NQM4', data: bars() });
        const view = { session: { id: 'readiness-session', cursor: 5 }, dataset: { id: 'readiness-data', symbol: 'NQM4', schema: 'ohlcv-1m', intervalMs: 60000 } } as SessionView;
        const cell = { id: 'cell', chart };
        const flush = vi.fn(async () => {});
        const controller = createChartAgentController({ autoStart: false,
            api: { get: vi.fn(), post: vi.fn(), postKeepalive: vi.fn() },
            workspace: { cells: () => [cell], cell: () => cell, context: () => ({ activeCellId: 'cell' }) } as unknown as Parameters<typeof createChartAgentController>[0]['workspace'],
            session: () => view, generation: () => 1, blocked: () => false, cursorTime: () => bars().at(-1)!.time,
            setTimeframe: async () => {}, flush }); agents.push(controller);
        const task = (operation: ChartAgentTask['operation'], args: Record<string, unknown>): ChartAgentTask => ({ operation, args,
            target: { clientId: controller.clientId, sessionId: view.session.id, generation: 1, cellId: 'cell' }, requestId: crypto.randomUUID(), deadline: Date.now() + 10000 });
        const started = await controller.execute(task('run_script', { source })) as { jobId: string; indicatorId: string };
        await vi.waitFor(async () => {
            const job = await controller.execute(task('read_script_job', { jobId: started.jobId })) as { state: string; saved: boolean };
            expect(job.state).toBe('completed'); expect(job.saved).toBe(true);
        }, { timeout: 2000 });
        const handle = chart.indicators().find(item => item.id === started.indicatorId)!;
        const computed = await ready(handle);
        expect(computed.computation?.completed?.source).toBe(source);
        expect((await handle.context(['strategy']))?.strategy?.initialCapital).toBe(12345);
        expect(flush).toHaveBeenCalledTimes(1);
    }, 15000);
    it.each([3, 10])('recomputes a completed official-worker result when history depth changes from six to %i bars', async count => {
        const history = bars(10); const renderer = new RecordingRenderer();
        const feed: MarketDataFeed = { load: async () => history.slice(-6), loadRange: async () => history, subscribe: () => () => {} };
        const runtime = new LocalPineEngine({ workerUrl: '/local-pine-worker.js', cutoff: () => history.at(-1)!.time,
            workerBudget: new PineWorkerBudget(1), createWorker: realWorker }); runtimes.push(runtime);
        const chart = new Vela({} as HTMLElement, { symbol: 'NQM4', timeframe: '1', bars: 6, live: false, volume: false },
            { renderer, dataFeed: feed, engines: [runtime] }); charts.push(chart); await chart.ready();
        const handle = chart.addIndicator(SOURCE); const first = await ready(handle);
        expect(first.computation?.completed?.bars.count).toBe(6);
        await chart.setMarket({ bars: count });
        let snapshot: EngineContextSnapshot | null = null;
        await vi.waitFor(async () => {
            snapshot = await handle.context(['plots', 'computation']);
            expect(snapshot?.computation?.state).toBe('ready');
            expect(snapshot?.computation?.completed?.bars.count).toBe(count);
        }, { timeout: 2000 });
        const completed = snapshot as EngineContextSnapshot | null;
        expect(completed?.plots.Scaled).toHaveLength(count);
        expect(completed?.plots.Scaled?.at(-1)?.value).toBe(109);
        expect(completed?.computation?.completed?.id).not.toBe(first.computation?.completed?.id);
    }, 15000);
    it.each([
        ['numeric output', SOURCE],
        ['legitimate empty output', '//@version=6\nindicator("Empty output")\nvalue = close + 1'],
    ] as const)('does not call a deferred-history acknowledgment a completed computation for %s', async (_label, source) => {
        const { runtime } = await fixture();
        const prepared = await runtime.prepare(source, 'deferred-history');
        let identity = { id: 'deferred:1', source, inputs: {}, props: {}, market: { symbol: 'NQM4', timeframe: '1' },
            bars: { revision: 1, count: 6, firstTime: BASE, lastTime: bars().at(-1)!.time } };
        const onDone = vi.fn(); const onModel = vi.fn();
        const session = runtime.execute({ prepared, bars: bars(), market: identity.market, mode: 'static', historyState: 'backfill',
            getComputation: () => identity }, { onDone, onModel });
        await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
        expect(onModel).not.toHaveBeenCalled();
        const deferred = await session.getContext?.(['plots', 'computation']);
        expect(deferred?.computation?.state).toBe('pending');
        expect(deferred?.computation?.completed).toBeUndefined();
        expect(deferred?.barIndex).toBe(-1);
        identity = { ...identity, id: 'deferred:2', bars: { ...identity.bars, revision: 2 } };
        session.notifyBars('complete');
        await vi.waitFor(async () => {
            const computed = await session.getContext?.(['plots', 'computation']);
            expect(computed?.computation?.state).toBe('ready');
            expect(computed?.computation?.completed?.id).toBe('deferred:2');
            expect(computed?.barIndex).toBe(5);
            if (source === SOURCE) expect(computed?.plots.Scaled?.at(-1)?.value).toBe(105);
            else expect(computed?.plots).toEqual({});
        }, { timeout: 2000 });
    }, 15000);
    it.each([
        ['comment-only dependency', '//@version=6\nindicator("Comment viewport")\n// chart.left_visible_bar_time\nplot(close, title="Close")', false],
        ['runtime-only dependency', '//@version=6\nindicator("Runtime viewport")\nplot(close + chart . left_visible_bar_time * 0, title="Close")', true],
    ] as const)('keeps completed identities stable when the real worker corrects a %s', async (_label, source, reactive) => {
        const { chart, renderer } = await fixture(); renderer.range = { from: BASE, to: BASE + 300000 };
        const handle = chart.addIndicator(source);
        let snapshot: EngineContextSnapshot | null = null;
        await vi.waitFor(async () => {
            snapshot = await handle.context(['plots', 'computation']);
            expect(snapshot?.plots.Close?.at(-1)?.value).toBe(105);
        }, { timeout: 10000 });
        const first = snapshot as EngineContextSnapshot | null;
        expect(first?.computation?.state).toBe('ready');
        expect(first?.computation?.completed?.id).toBe(first?.computation?.requested.id);
        const completed = first?.computation?.completed?.id;
        chart.setVisibleRange({ from: BASE + 60000, to: BASE + 240000 });
        const moved = await ready(handle);
        expect(moved.plots.Close?.at(-1)?.value).toBe(105);
        if (reactive) expect(moved.computation?.completed?.id).not.toBe(completed);
        else expect(moved.computation?.completed?.id).toBe(completed);
    }, 15000);
    it('replays a newly detected viewport dependency after the viewport moved during delayed computation', async () => {
        const secondary = delayedSeries(); secondary.block();
        const { chart, renderer } = await fixture({ fetchSeriesAt: secondary.fetchSeriesAt });
        renderer.range = { from: BASE, to: BASE + 300000 };
        const source = '//@version=6\nindicator("Detected viewport")\nother=request.security("ESM4", "1", close)\nplot(chart . left_visible_bar_time + other * 0, title="Left")';
        const handle = chart.addIndicator(source);
        await vi.waitFor(() => expect(secondary.pending()).toBeGreaterThan(0));
        chart.setVisibleRange({ from: BASE + 60000, to: BASE + 240000 });
        await new Promise(resolve => setTimeout(resolve, 250));
        secondary.release();
        const completed = await ready(handle);
        expect(completed.plots.Left?.at(-1)?.value).toBe(BASE + 60000);
        expect(completed.computation?.completed?.visibleRange).toEqual({ left: BASE + 60000, right: BASE + 240000 });
    }, 15000);
    it('keeps completed input settings distinct while a real secondary-data recomputation is pending', async () => {
        const secondary = delayedSeries();
        const { chart } = await fixture({ fetchSeriesAt: secondary.fetchSeriesAt });
        const handle = chart.addIndicator(SECONDARY_SOURCE);
        const first = await ready(handle);
        const key = handle.inputs.find((input) => input.title === 'K')!.key;
        expect(first.plots.Scaled?.at(-1)?.value).toBe(105);
        expect(first.computation?.completed?.inputs[key]).toBe(1);

        secondary.block();
        handle.setInput(key, 2);
        await vi.waitFor(() => expect(secondary.pending()).toBeGreaterThan(0));
        const pending = await handle.context(['plots', 'computation']);
        expect(handle.inputValues()[key]).toBe(2);
        expect(pending?.computation).toMatchObject({ state: 'pending', requested: { inputs: { [key]: 2 } }, completed: { inputs: { [key]: 1 } } });
        expect(pending?.computation?.completed?.id).toBe(first.computation?.completed?.id);
        expect(pending?.computation?.requested.id).not.toBe(first.computation?.completed?.id);

        secondary.release();
        const second = await ready(handle);
        expect(second.plots.Scaled?.at(-1)?.value).toBe(210);
        expect(second.computation?.completed?.inputs[key]).toBe(2);
        expect(second.computation?.requested.id).toBe(second.computation?.completed?.id);
    }, 15_000);

    it('invalidates completed declaration props until the actual replacement run completes', async () => {
        const secondary = delayedSeries();
        const { chart } = await fixture({ fetchSeriesAt: secondary.fetchSeriesAt });
        const handle = chart.addIndicator(SECONDARY_SOURCE);
        const first = await ready(handle);
        expect(handle.props.some((prop) => prop.key === 'precision')).toBe(true);
        secondary.block();
        handle.setProp('precision', 4);
        await vi.waitFor(() => expect(secondary.pending()).toBeGreaterThan(0));
        const pending = await handle.context(['computation']);
        expect(pending?.computation?.state).toBe('pending');
        expect(pending?.computation?.requested.props.precision).toBe(4);
        expect(pending?.computation?.completed?.props).toEqual(first.computation?.completed?.props);
        secondary.release();
        const second = await ready(handle);
        expect(second.computation?.completed?.props.precision).toBe(4);
        expect(second.computation?.completed?.id).not.toBe(first.computation?.completed?.id);
    }, 15_000);

    it('changes completed identities for source, market, and revealed bars', async () => {
        const { chart, setCutoff } = await fixture();
        const handle = chart.addIndicator(SOURCE);
        const first = await ready(handle);
        expect(first.computation?.completed?.dataCutoff).toBe(bars().at(-1)!.time);
        const nextSource = SOURCE.replace('close * k', '(close + 1) * k');
        await expect(handle.updateCode(nextSource)).resolves.toMatchObject({ ok: true });
        const changed = await ready(handle);
        expect(changed.computation?.completed?.source).toBe(nextSource);
        expect(changed.computation?.completed?.id).not.toBe(first.computation?.completed?.id);

        setCutoff(bars()[3]!.time);
        await chart.setMarket({ symbol: 'ESM4', timeframe: '2', data: bars(4) });
        const moved = await ready(handle);
        expect(moved.computation?.completed?.market).toMatchObject({ symbol: 'ESM4', timeframe: '2' });
        expect(moved.computation?.completed?.bars).toMatchObject({ count: 4, firstTime: BASE, lastTime: bars()[3]!.time });
        expect(moved.computation?.completed?.id).not.toBe(changed.computation?.completed?.id);
        expect(moved.plots.Scaled?.at(-1)?.value).toBe(104);
        expect(moved.computation?.completed?.dataCutoff).toBe(bars()[3]!.time);
    }, 15_000);

    it('revises identity when replay changes the same forming candle without changing its timestamp or count', async () => {
        const { chart } = await fixture();
        await chart.replay.start({ from: bars()[2]!.time });
        chart.replay.setTicks(() => [{ price: 200 }, { price: 250 }, { price: 300 }]);
        const handle = chart.addIndicator(SOURCE);
        await ready(handle);
        expect(chart.replay.stepUpdate()).toBe(true);
        const opened = await ready(handle);
        expect(opened.plots.Scaled?.at(-1)?.value).toBe(200);
        expect(chart.replay.stepUpdate()).toBe(true);
        const updated = await ready(handle);
        expect(updated.plots.Scaled?.at(-1)?.value).toBe(250);
        expect(updated.computation?.completed?.bars.count).toBe(opened.computation?.completed?.bars.count);
        expect(updated.computation?.completed?.bars.lastTime).toBe(opened.computation?.completed?.bars.lastTime);
        expect(updated.computation?.completed?.bars.revision).not.toBe(opened.computation?.completed?.bars.revision);
        expect(updated.computation?.completed?.id).not.toBe(opened.computation?.completed?.id);
    }, 15_000);

    it('marks a changed reveal cutoff stale even before chart bars are replaced', async () => {
        const { chart, setCutoff } = await fixture();
        const handle = chart.addIndicator(SOURCE);
        const first = await ready(handle);
        setCutoff(bars()[3]!.time);
        const moved = await handle.context(['plots', 'computation']);
        expect(moved?.computation?.state).toBe('stale');
        expect(moved?.computation?.requested.dataCutoff).toBe(bars()[3]!.time);
        expect(moved?.computation?.completed?.dataCutoff).toBe(first.computation?.completed?.dataCutoff);
    }, 15_000);

    it('completes the latest coalesced replay bars with matching real worker values and identity', async () => {
        const secondary = delayedSeries();
        const { chart } = await fixture({ fetchSeriesAt: secondary.fetchSeriesAt });
        await chart.replay.start({ from: bars()[2]!.time });
        chart.replay.setTicks(() => [{ price: 200 }, { price: 250 }, { price: 300 }]);
        const handle = chart.addIndicator(SECONDARY_SOURCE);
        await ready(handle);
        secondary.block();
        expect(chart.replay.stepUpdate()).toBe(true);
        await vi.waitFor(() => expect(secondary.pending()).toBeGreaterThan(0));
        expect(chart.replay.stepUpdate()).toBe(true);
        const pending = await handle.context(['computation']);
        expect(pending?.computation?.state).toBe('pending');
        secondary.release();
        const completed = await ready(handle);
        expect(completed.plots.Scaled?.at(-1)?.value).toBe(250);
        expect(completed.computation?.completed?.id).toBe(pending?.computation?.requested.id);
        expect(completed.computation?.completed?.bars.revision).toBe(pending?.computation?.requested.bars.revision);
    }, 15_000);

    it('keeps live bar updates current through acknowledged coalesced worker reruns', async () => {
        const secondary = delayedSeries();
        const { chart, tick, runtime } = await fixture({ fetchSeriesAt: secondary.fetchSeriesAt }, true);
        expect(runtime.capabilities.streaming).toBe(false);
        const handle = chart.addIndicator(SECONDARY_SOURCE);
        await ready(handle);
        secondary.block();
        tick({ ...bars().at(-1)!, high: 201, close: 200 });
        await vi.waitFor(() => expect(secondary.pending()).toBeGreaterThan(0));
        tick({ ...bars().at(-1)!, high: 251, close: 250 });
        const pending = await handle.context(['computation']);
        expect(pending?.computation?.state).toBe('pending');
        secondary.release();
        const completed = await ready(handle);
        expect(completed.plots.Scaled?.at(-1)?.value).toBe(250);
        expect(completed.computation?.completed?.id).toBe(pending?.computation?.requested.id);
    }, 15_000);
});

interface Message { kind: string; reqId?: number; sessionId?: number; source?: string }

class DeferredWorker {
    holdContexts = false;
    readonly terminate = vi.fn();
    readonly postMessage = vi.fn((message: unknown): void => {
        const request = message as Message;
        if (request.kind === 'getContext' && !this.holdContexts) queueMicrotask(() => this.context(request));
    });
    context(request = this.requests('getContext').at(-1)!): void {
        this.emit({ kind: 'contextResult', reqId: request.reqId, snapshot: {
            language: 'pine', phase: 'idle', barIndex: 5, meta: { title: 'Deferred', overlay: true },
            plots: { Scaled: [{ time: bars().at(-1)!.time, value: 105 }] }, variables: {}, warnings: [],
        } });
    }
    private readonly listeners: Array<(event: { data: unknown }) => void> = [];
    readonly addEventListener = ((kind: string, listener: (event: { data: unknown }) => void): void => {
        if (kind === 'message') this.listeners.push(listener);
    }) as Worker['addEventListener'];
    requests(kind: string): Message[] { return this.postMessage.mock.calls.map(([message]) => message as Message).filter((message) => message.kind === kind); }
    emit(data: unknown): void { for (const listener of this.listeners) listener({ data }); }
    prepared(request = this.requests('prepare').at(-1)!): void {
        const prepared: PreparedScript = { language: 'pine', inputs: [{ key: 'K', title: 'K', type: 'int', defval: 1 }],
            meta: { title: 'Deferred', overlay: true }, reactsToViewport: false, token: {} };
        this.emit({ kind: 'prepared', reqId: request.reqId, prepared });
    }
    model(id: string): void {
        const model: IndicatorModel = { id, title: 'Deferred', overlay: true, paneHint: 'price', series: [], fills: [], backgrounds: [], priceLines: [], inputs: [], inputValues: { K: 1 } };
        this.emit({ kind: 'model', sessionId: this.requests('execute').at(-1)!.sessionId, model });
    }
    done(): void { this.emit({ kind: 'done', sessionId: this.requests('execute').at(-1)!.sessionId }); }
}

describe('Vela Pine preparation ownership', () => {
    it('starts compilation after a bounded yield when animation frames never fire', async () => {
        const requestFrame = vi.fn(() => 1); const cancelFrame = vi.fn();
        vi.stubGlobal('requestAnimationFrame', requestFrame); vi.stubGlobal('cancelAnimationFrame', cancelFrame);
        const worker = new DeferredWorker();
        const { chart } = await fixture({ createWorker: () => worker });
        const handle = chart.addIndicator(SOURCE);
        await vi.waitFor(() => expect(worker.requests('prepare')).toHaveLength(1), { timeout: 1000 });
        expect(requestFrame).toHaveBeenCalledTimes(1); expect(cancelFrame).toHaveBeenCalledWith(1);
        worker.prepared(); await vi.waitFor(() => expect(worker.requests('execute')).toHaveLength(1));
        worker.model(handle.id); worker.done(); await ready(handle);
    });
    it('does not revive a removed indicator when a late animation frame follows the yield deadline', async () => {
        const callbacks: FrameRequestCallback[] = [];
        const requestFrame = vi.fn((callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
        const cancelFrame = vi.fn();
        vi.stubGlobal('requestAnimationFrame', requestFrame); vi.stubGlobal('cancelAnimationFrame', cancelFrame);
        const createWorker = vi.fn(() => new DeferredWorker());
        const { chart, renderer } = await fixture({ createWorker });
        const handle = chart.addIndicator(SOURCE);
        await vi.waitFor(() => expect(requestFrame).toHaveBeenCalledTimes(1)); handle.remove();
        await new Promise(resolve => setTimeout(resolve, 150));
        callbacks[0]!(0);
        await Promise.resolve();
        expect(requestFrame).toHaveBeenCalledTimes(1); expect(cancelFrame).toHaveBeenCalledWith(1);
        expect(createWorker).not.toHaveBeenCalled(); expect(renderer.mounts).toHaveLength(0);
        expect(chart.indicators()).toHaveLength(0);
    });
    it.each([3, 10])('preserves pending compilation when history depth changes from six to %i bars', async (count) => {
        const worker = new DeferredWorker(); const renderer = new RecordingRenderer(); const budget = new PineWorkerBudget(1);
        const history = bars(10);
        const feed: MarketDataFeed = { load: async () => history.slice(-6), loadRange: async () => history, subscribe: () => () => {} };
        const runtime = new LocalPineEngine({ workerUrl: '/local-pine-worker.js', cutoff: () => history.at(-1)!.time,
            workerBudget: budget, createWorker: () => worker }); runtimes.push(runtime);
        const chart = new Vela({} as HTMLElement, { symbol: 'NQM4', timeframe: '1', bars: 6, live: false, volume: false },
            { renderer, dataFeed: feed, engines: [runtime] }); charts.push(chart); await chart.ready();
        const handle = chart.addIndicator(SOURCE);
        await vi.waitFor(() => expect(worker.requests('prepare')).toHaveLength(1));
        await chart.setMarket({ bars: count });
        expect(worker.terminate).not.toHaveBeenCalled(); expect(budget.active).toBe(1);
        expect(worker.requests('prepare')).toHaveLength(1);
        worker.prepared();
        await vi.waitFor(() => expect(worker.requests('execute')).toHaveLength(1));
        worker.model(handle.id); worker.done();
        expect((await ready(handle)).computation?.completed?.bars.count).toBe(count);
    });
    it.each(['remove', 'destroy', 'dispose'] as const)('releases pending preparation immediately on %s and ignores its late response', async (action) => {
        const worker = new DeferredWorker();
        const { chart, runtime, renderer, budget } = await fixture({ createWorker: () => worker });
        const handle = chart.addIndicator(SOURCE);
        await vi.waitFor(() => expect(worker.requests('prepare')).toHaveLength(1));
        expect(budget.active).toBe(1);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        if (action === 'remove') handle.remove();
        else if (action === 'destroy') chart.destroy();
        else runtime.dispose();
        expect(budget.active).toBe(0);
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        worker.prepared();
        await new Promise((resolve) => setTimeout(resolve, 15));
        expect(worker.requests('execute')).toHaveLength(0);
        expect(renderer.mounts).toHaveLength(0);
        if (action === 'remove') expect(chart.indicators()).toHaveLength(0);
    });

    it('cancels the original preparation when source is superseded and never mounts the old response', async () => {
        const original = new DeferredWorker();
        const replacement = new DeferredWorker();
        const createWorker = vi.fn().mockReturnValueOnce(original).mockReturnValueOnce(replacement);
        const { chart, renderer, budget } = await fixture({ createWorker });
        const handle = chart.addIndicator(SOURCE);
        await vi.waitFor(() => expect(original.requests('prepare')).toHaveLength(1));
        const nextSource = SOURCE.replace('Identity', 'Replacement');
        const changed = handle.updateCode(nextSource);
        expect(original.terminate).toHaveBeenCalledTimes(1);
        expect(budget.active).toBe(1);
        await vi.waitFor(() => expect(replacement.requests('prepare')).toHaveLength(1));
        original.prepared();
        await new Promise((resolve) => setTimeout(resolve, 15));
        expect(renderer.mounts).toHaveLength(0);
        expect(original.requests('execute')).toHaveLength(0);
        replacement.prepared();
        await vi.waitFor(() => expect(replacement.requests('execute')).toHaveLength(1));
        replacement.model(handle.id);
        replacement.done();
        await expect(changed).resolves.toMatchObject({ ok: true });
        expect(handle.source).toBe(nextSource);
        expect(renderer.mounted.has(handle.id)).toBe(true);
    });

    it('requires a static worker done acknowledgment before reporting a completed computation', async () => {
        const worker = new DeferredWorker();
        const { chart } = await fixture({ createWorker: () => worker });
        const handle = chart.addIndicator(SOURCE);
        const announced = vi.fn(); handle.on('ready', announced);
        await vi.waitFor(() => expect(worker.requests('prepare')).toHaveLength(1));
        worker.prepared();
        await vi.waitFor(() => expect(worker.requests('execute')).toHaveLength(1));
        worker.model(handle.id);
        expect(announced).not.toHaveBeenCalled();
        const pending = await handle.context(['computation']);
        expect(pending?.computation?.state).toBe('pending');
        expect(pending?.computation?.completed).toBeUndefined();
        worker.done();
        const completed = await ready(handle);
        expect(announced).toHaveBeenCalledTimes(1);
        expect(completed.computation?.completed?.id).toBe(completed.computation?.requested.id);
    });

    it('captures coalesced replay revisions when the next worker run is actually dispatched', async () => {
        const worker = new DeferredWorker();
        const { chart } = await fixture({ createWorker: () => worker });
        await chart.replay.start({ from: bars()[2]!.time });
        chart.replay.setTicks(() => [{ price: 200 }, { price: 250 }, { price: 300 }]);
        const handle = chart.addIndicator(SOURCE);
        await vi.waitFor(() => expect(worker.requests('prepare')).toHaveLength(1));
        worker.prepared();
        await vi.waitFor(() => expect(worker.requests('execute')).toHaveLength(1));
        worker.model(handle.id);
        worker.done();
        await ready(handle);
        expect(chart.replay.stepUpdate()).toBe(true);
        const dispatched = await handle.context(['computation']);
        expect(worker.requests('notifyBars')).toHaveLength(1);
        expect(chart.replay.stepUpdate()).toBe(true);
        const coalesced = await handle.context(['computation']);
        expect(worker.requests('notifyBars')).toHaveLength(1);
        expect(coalesced?.computation?.requested.id).not.toBe(dispatched?.computation?.requested.id);
        worker.model(handle.id);
        worker.done();
        expect(worker.requests('notifyBars')).toHaveLength(2);
        const pending = await handle.context(['computation']);
        expect(pending?.computation?.state).toBe('pending');
        expect(pending?.computation?.completed?.id).toBe(dispatched?.computation?.requested.id);
        worker.model(handle.id);
        worker.done();
        const finished = await ready(handle);
        expect(finished.computation?.completed?.id).toBe(coalesced?.computation?.requested.id);
    });

    it('keeps an existing computation pending while replacement source is still compiling', async () => {
        const worker = new DeferredWorker();
        const { chart } = await fixture({ createWorker: () => worker, workerBudget: new PineWorkerBudget(1) });
        const handle = chart.addIndicator(SOURCE);
        await vi.waitFor(() => expect(worker.requests('prepare')).toHaveLength(1));
        worker.prepared();
        await vi.waitFor(() => expect(worker.requests('execute')).toHaveLength(1));
        worker.model(handle.id);
        worker.done();
        const first = await ready(handle);
        const changing = handle.updateCode(SOURCE.replace('Identity', 'Replacement'));
        const pending = await handle.context(['computation']);
        expect(pending?.computation?.state).toBe('pending');
        expect(pending?.computation?.completed?.source).toBe(SOURCE);
        worker.emit({ kind: 'prepared', reqId: worker.requests('prepare').at(-1)!.reqId, error: 'Compile failed.' });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(changing).resolves.toMatchObject({ ok: false });
        expect((await ready(handle)).computation?.completed?.id).toBe(first.computation?.completed?.id);
    });

    it('cancels preparation before switching market and ignores the old market response', async () => {
        const original = new DeferredWorker();
        const replacement = new DeferredWorker();
        const createWorker = vi.fn().mockReturnValueOnce(original).mockReturnValueOnce(replacement);
        const { chart, renderer, budget } = await fixture({ createWorker });
        const handle = chart.addIndicator(SOURCE);
        await vi.waitFor(() => expect(original.requests('prepare')).toHaveLength(1));
        const switched = chart.setMarket({ symbol: 'ESM4', data: bars() });
        expect(budget.active).toBe(0);
        expect(original.terminate).toHaveBeenCalledTimes(1);
        await switched;
        await vi.waitFor(() => expect(replacement.requests('prepare')).toHaveLength(1));
        original.prepared();
        await new Promise((resolve) => setTimeout(resolve, 15));
        expect(renderer.mounts).toHaveLength(0);
        expect(original.requests('execute')).toHaveLength(0);
        replacement.prepared();
        await vi.waitFor(() => expect(replacement.requests('execute')).toHaveLength(1));
        replacement.model(handle.id);
        replacement.done();
        expect((await ready(handle)).computation?.completed?.market.symbol).toBe('ESM4');
    });

    it('releases the previous market worker before a delayed reload and ignores its late model', async () => {
        const original = new DeferredWorker();
        const replacement = new DeferredWorker();
        const createWorker = vi.fn().mockReturnValueOnce(original).mockReturnValueOnce(replacement);
        let completeLoad: ((value: OHLCV[]) => void) | undefined;
        const feed: MarketDataFeed = { load: async (config) => config.symbol === 'NQM4' ? bars()
            : new Promise((resolve) => { completeLoad = resolve; }), subscribe: () => () => {} };
        const { chart, renderer, budget } = await fixture({ createWorker }, false, feed);
        const handle = chart.addIndicator(SOURCE);
        await vi.waitFor(() => expect(original.requests('prepare')).toHaveLength(1));
        original.prepared();
        await vi.waitFor(() => expect(original.requests('execute')).toHaveLength(1));
        original.model(handle.id);
        original.done();
        await ready(handle);
        const switching = chart.setMarket({ symbol: 'ESM4' });
        expect(budget.active).toBe(0);
        expect(original.terminate).toHaveBeenCalledTimes(1);
        const mounts = renderer.mounts.length;
        original.model(handle.id);
        original.done();
        expect(renderer.mounts).toHaveLength(mounts);
        await vi.waitFor(() => expect(completeLoad).toBeDefined());
        completeLoad!(bars(4));
        await switching;
        await vi.waitFor(() => expect(replacement.requests('execute')).toHaveLength(1));
        replacement.model(handle.id);
        replacement.done();
        expect((await ready(handle)).computation?.completed?.market.symbol).toBe('ESM4');
    });

    it('rechecks current settings when an older context request resolves after an edit', async () => {
        const worker = new DeferredWorker();
        const { chart } = await fixture({ createWorker: () => worker });
        const handle = chart.addIndicator(SOURCE);
        await vi.waitFor(() => expect(worker.requests('prepare')).toHaveLength(1));
        worker.prepared();
        await vi.waitFor(() => expect(worker.requests('execute')).toHaveLength(1));
        worker.model(handle.id);
        worker.done();
        const first = await ready(handle);
        worker.holdContexts = true;
        const count = worker.requests('getContext').length;
        const reading = handle.context(['plots', 'computation']);
        expect(worker.requests('getContext')).toHaveLength(count + 1);
        handle.setInput('K', 2);
        worker.context();
        const snapshot = await reading;
        expect(snapshot?.computation?.state).not.toBe('ready');
        expect(snapshot?.computation?.completed?.id).toBe(first.computation?.completed?.id);
        expect(snapshot?.computation?.completed?.inputs.K).toBe(1);
        expect(snapshot?.computation?.requested.inputs.K).toBe(2);
        expect(snapshot?.plots).toEqual({});
    });

    it('rejects an old context response after newer inputs finish during the read', async () => {
        const worker = new DeferredWorker();
        const { chart } = await fixture({ createWorker: () => worker });
        const handle = chart.addIndicator(SOURCE);
        await vi.waitFor(() => expect(worker.requests('prepare')).toHaveLength(1));
        worker.prepared();
        await vi.waitFor(() => expect(worker.requests('execute')).toHaveLength(1));
        worker.model(handle.id);
        worker.done();
        await ready(handle);
        worker.holdContexts = true;
        const reading = handle.context(['plots', 'computation']);
        handle.setInput('K', 2);
        worker.model(handle.id);
        worker.done();
        worker.context();
        const snapshot = await reading;
        expect(snapshot?.computation?.state).toBe('stale');
        expect(snapshot?.plots).toEqual({});
        expect(snapshot?.computation?.requested.inputs.K).toBe(2);
    });

    it('resolves a context read as removed when cancellation happens during the read', async () => {
        const worker = new DeferredWorker();
        const { chart } = await fixture({ createWorker: () => worker });
        const handle = chart.addIndicator(SOURCE);
        await vi.waitFor(() => expect(worker.requests('prepare')).toHaveLength(1));
        worker.prepared();
        await vi.waitFor(() => expect(worker.requests('execute')).toHaveLength(1));
        worker.model(handle.id);
        worker.done();
        await ready(handle);
        worker.holdContexts = true;
        const reading = handle.context(['plots', 'computation']);
        handle.remove();
        await expect(reading).resolves.toBeNull();
        worker.context();
    });

    it('preserves the running script when a borrowed replacement preparation is aborted', async () => {
        const worker = new DeferredWorker();
        const { chart, runtime, renderer, budget } = await fixture({ createWorker: () => worker, workerBudget: new PineWorkerBudget(1) });
        const handle = chart.addIndicator(SOURCE);
        await vi.waitFor(() => expect(worker.requests('prepare')).toHaveLength(1));
        worker.prepared();
        await vi.waitFor(() => expect(worker.requests('execute')).toHaveLength(1));
        worker.model(handle.id);
        worker.done();
        await ready(handle);
        const controller = new AbortController();
        const compiling = runtime.prepare(SOURCE.replace('Identity', 'Cancelled replacement'), handle.id, { signal: controller.signal });
        const cancelled = expect(compiling).rejects.toMatchObject({ kind: 'cancelled' });
        controller.abort();
        expect(budget.active).toBe(1);
        expect(worker.terminate).not.toHaveBeenCalled();
        await cancelled;
        worker.prepared();
        const before = renderer.mounts.length;
        handle.setInput('K', 2);
        expect(worker.requests('update')).toHaveLength(1);
        worker.model(handle.id);
        worker.done();
        expect(renderer.mounts.length).toBeGreaterThan(before);
        expect(handle.source).toBe(SOURCE);
        expect((await ready(handle)).computation?.completed?.source).toBe(SOURCE);
    });
});

describe('Vela native computation contexts', () => {
    it('applies native inputs edited while hidden before acknowledging the resumed output', async () => {
        const { chart } = await fixture();
        const handle = chart.addNativeIndicator('sma', { inputs: { length: 3 } });
        expect(Object.values((await ready(handle)).plots)[0]?.at(-1)?.value).toBe(104);
        handle.setVisible(false); handle.setInput('length', 2); handle.setVisible(true);
        const resumed = await ready(handle);
        expect(resumed.computation?.completed?.inputs.length).toBe(2);
        expect(Object.values(resumed.plots)[0]?.at(-1)?.value).toBe(104.5);
    });
    it('returns copied numeric native output with the settings that produced it', async () => {
        const { chart } = await fixture();
        const handle = chart.addNativeIndicator('sma', { inputs: { length: 3 } });
        const first = await ready(handle);
        expect(first.language).toBe('native');
        expect(first.native).toMatchObject({ type: 'sma', outputKind: 'series', hidden: false });
        expect(Object.values(first.plots)[0]?.at(-1)?.value).toBe(104);
        expect(first.computation?.completed?.inputs.length).toBe(3);
        const values = Object.values(first.plots)[0] as Array<{ time: number; value: unknown }>;
        values[values.length - 1]!.value = -1;
        expect(Object.values((await ready(handle)).plots)[0]?.at(-1)?.value).toBe(104);
        handle.setInput('length', 2);
        const second = await ready(handle);
        expect(Object.values(second.plots)[0]?.at(-1)?.value).toBe(104.5);
        expect(second.computation?.completed?.inputs.length).toBe(2);
        expect(second.computation?.completed?.id).not.toBe(first.computation?.completed?.id);
    });

    it('marks hidden native output stale and recomputes it when shown after a market change', async () => {
        const { chart } = await fixture();
        const handle = chart.addNativeIndicator('sma', { inputs: { length: 2 } });
        await ready(handle);
        handle.setVisible(false);
        expect((await handle.context())?.computation?.state).toBe('stale');
        await chart.setMarket({ symbol: 'ESM4', timeframe: '2', data: bars(4) });
        const hidden = await handle.context();
        expect(hidden?.native?.hidden).toBe(true);
        expect(hidden?.computation?.state).toBe('stale');
        expect(hidden?.computation?.requested.market.symbol).toBe('ESM4');
        handle.setVisible(true);
        const shown = await ready(handle);
        expect(Object.values(shown.plots)[0]?.at(-1)?.value).toBe(102.5);
        expect(shown.computation?.completed?.market.symbol).toBe('ESM4');
    });

    it('identifies renderer-layer output without fabricating numeric geometry', async () => {
        const { chart } = await fixture();
        const handle = chart.addNativeIndicator('volume');
        const snapshot = await handle.context(['plots', 'warnings']);
        await vi.waitFor(async () => expect((await handle.context())?.native?.outputKind).toBe('renderer'));
        const current = await handle.context(['plots', 'warnings']);
        expect(current?.plots).toEqual({});
        expect(current?.native?.outputKind).toBe('renderer');
        expect(current?.warnings.some((warning) => warning.message.includes('renderer-layer'))).toBe(true);
        expect(snapshot?.language).toBe('native');
    });

    it('does not label asynchronous native emissions with the settings current at completion', async () => {
        let context: NativeIndicatorContext | undefined;
        registerNativeIndicator({ type: 'context-async-test', title: 'Asynchronous', overlay: true, paneHint: 'price',
            defaultInputs: () => ({ length: 1 }), inputsSchema: () => [{ key: 'length', title: 'Length', type: 'int', defval: 1 }],
            create: () => ({ start: (ctx) => { context = ctx; }, onBars: () => {}, onViewport: () => {}, setInputs: () => {},
                suspend: () => {}, resume: () => {}, stop: () => {} }) });
        const { chart } = await fixture();
        const handle = chart.addNativeIndicator('context-async-test');
        await vi.waitFor(() => expect(context).toBeDefined());
        handle.setInput('length', 2);
        const output: NativeIndicatorOutput = { series: [{ id: 'old-result', title: 'Old result', paneId: 'price', kind: 'line',
            points: [{ time: bars()[0]!.time, value: 100 }], style: { color: '#fff', width: 1, lineStyle: 'solid' } }] };
        context!.emit(output);
        const snapshot = await handle.context(['plots', 'warnings']);
        expect(snapshot?.computation?.state).toBe('stale');
        expect(snapshot?.computation?.completed).toBeUndefined();
        expect(snapshot?.computation?.requested.inputs.length).toBe(2);
        expect(snapshot?.warnings.some((warning) => warning.message.includes('no computation identity'))).toBe(true);
    });
});
