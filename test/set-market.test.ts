// chart.setMarket() — the in-place market switch. The chart instance survives: bars
// reload through the shared pipeline, Pine sessions re-execute over the new market,
// native indicators restart with a fresh context, the active chart-type data engine is
// rebuilt, the live subscription re-targets, and history tracking re-arms per load.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Vela } from '../src/index';
import type {
    IChartRenderer,
    RendererCapabilities,
    IndicatorRenderHandle,
    CrosshairEvent,
    ClickEvent,
    InputChangeEvent,
    VisibleRange,
} from '../src/core/ports/IChartRenderer';
import type {
    ScriptingEngine,
    EngineCapabilities,
    PreparedScript,
    ExecutionRequest,
    ExecutionHandlers,
    ExecutionSession,
    EngineContextSnapshot,
} from '../src/core/ports/ScriptingEngine';
import type { ScriptRun } from '../src/core/script-run';
import { Canvas2dBackend } from '../src/renderers/native/backend/Canvas2dBackend';
import { CoordinateSystem } from '../src/renderers/native/core/CoordinateSystem';
import { SceneGraph } from '../src/renderers/native/core/SceneGraph';
import type { MarketDataFeed, BarRange } from '../src/core/ports/MarketDataFeed';
import type { MarketConfig } from '../src/core/options';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { Pane } from '../src/core/model/scene';
import type { IndicatorModel } from '../src/core/model/indicator';
import type { DrawingLine } from '../src/core/model/drawings';
import type { ScenePatch } from '../src/core/model/patch';
import type { InputValue } from '../src/core/model/inputs';
import type { VelaTheme } from '../src/core/options';
import type { Unsubscribe } from '../src/core/util/types';
import { registerNativeIndicator, unregisterNativeIndicator, type NativeIndicatorDescriptor, type NativeIndicatorContext } from '../src/core/native-indicators/NativeIndicator';
import { registerChartType, unregisterChartType, type SeriesDataEngineHost } from '../src/chart-types/registry';

const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** Synthetic hourly bars whose close encodes the SYMBOL (so the painted market is assertable). */
function makeBars(n: number, base: number): OHLCV[] {
    const bars: OHLCV[] = [];
    for (let i = 0; i < n; i += 1) {
        bars.push({ time: 1_700_000_000_000 + i * 3_600_000, open: base, high: base + 1, low: base - 1, close: base, volume: 1 });
    }
    return bars;
}

const PRICE: Record<string, number> = { AAA: 100, BBB: 200, CCC: 300, SLOW: 900 };

/** Per-symbol feed: records loads/ranges, counts live (un)subscriptions, gates slow symbols. */
class SwitchFeed implements MarketDataFeed {
    loads: MarketConfig[] = [];
    rangeCalls: BarRange[] = [];
    subs: Record<string, number> = {};
    unsubs: Record<string, number> = {};
    /** Symbols whose LOAD is held until release() — the parked/slow-load knob. */
    readonly gatedLoads = new Set<string>();
    /** Symbols whose LOAD rejects — the provider-failure knob. */
    readonly failLoads = new Set<string>();
    /** Hold every loadRange until release() — races a backfill against a switch. */
    gateRanges = false;
    /** Bars available per symbol (default 50). */
    depth: Record<string, number> = {};
    private waiters: Array<() => void> = [];
    private unresolvedCb: ((info: { symbol: string; providers: string[] }) => void) | null = null;

    async load(cfg: MarketConfig): Promise<OHLCV[]> {
        this.loads.push({ ...cfg });
        if (cfg.data?.length) return cfg.data;
        const sym = cfg.symbol ?? 'TEST';
        if (this.failLoads.has(sym)) throw new Error(`no venue serves ${sym}`);
        if (this.gatedLoads.has(sym)) await new Promise<void>((r) => this.waiters.push(r));
        const have = this.depth[sym] ?? 50;
        // The TAIL of the symbol's fixed universe — so a progressive head + its ranged
        // extensions see one consistent market (loadRange shares the same makeBars grid).
        return makeBars(have, PRICE[sym] ?? 1).slice(-Math.min(cfg.bars ?? 500, have));
    }

    onUnresolved(cb: (info: { symbol: string; providers: string[] }) => void): () => void {
        this.unresolvedCb = cb;
        return () => {
            this.unresolvedCb = null;
        };
    }

    /** Report a parked load (what MultiProviderFeed does for a symbol nothing serves). */
    park(symbol: string): void {
        this.unresolvedCb?.({ symbol, providers: [] });
    }

    async loadRange(cfg: MarketConfig, range: BarRange): Promise<OHLCV[]> {
        this.rangeCalls.push({ ...range });
        if (this.gateRanges) await new Promise<void>((r) => this.waiters.push(r));
        const sym = cfg.symbol ?? 'TEST';
        const all = makeBars(this.depth[sym] ?? 50, PRICE[sym] ?? 1);
        const to = range.to ?? Infinity;
        let out = all.filter((b) => b.time <= to);
        if (range.limit != null && out.length > range.limit) out = out.slice(-range.limit);
        return out;
    }

    /** Release every held load/range. */
    release(): void {
        const w = this.waiters;
        this.waiters = [];
        for (const r of w) r();
    }

    subscribe(cfg: MarketConfig, _onBar: (bar: OHLCV) => void): Unsubscribe {
        const sym = cfg.symbol ?? 'TEST';
        this.subs[sym] = (this.subs[sym] ?? 0) + 1;
        return () => {
            this.unsubs[sym] = (this.unsubs[sym] ?? 0) + 1;
        };
    }
}

class FakeRenderer implements IChartRenderer {
    readonly capabilities: RendererCapabilities = {
        panes: true, paneManagement: false, fills: 'primitive', bgcolor: 'primitive', hline: 'native',
        markers: true, barcolor: 'approximated', perPointColor: true, drawings: true, userDrawings: false, tables: true, inputsUI: true,
    };
    readonly name = 'fake';
    readonly features: readonly string[] = [];
    /** Test knob: the price style a chart is CONSTRUCTED in (drives chart-type engines). */
    priceStyleFeature: unknown = undefined;
    bars: OHLCV[] = [];
    setBarsCalls: { n: number; close: number | undefined; preserveView: boolean }[] = [];
    visibleRangeCalls: VisibleRange[] = [];
    nativePushes: Array<[string, unknown]> = [];
    mountedModels: IndicatorModel[] = [];
    /** Whether the loading affordance is up right now. */
    loading = false;
    /** Interleaved series/loading timeline — the ORDER is what the load-state tests pin. */
    timeline: string[] = [];
    applyFeature(): void {}
    readFeature(key: string): unknown { return key === 'priceStyle' ? this.priceStyleFeature : undefined; }
    mount(_c: HTMLElement, _t: VelaTheme): void {}
    setTheme(): void {}
    resize(): void {}
    destroy(): void {}
    setBars(bars: OHLCV[], opts?: { preserveView?: boolean }): void {
        this.bars = bars;
        this.setBarsCalls.push({ n: bars.length, close: bars[0]?.close, preserveView: !!opts?.preserveView });
        this.timeline.push(`bars:${bars.length}`);
    }
    setLoading(loading: boolean): void {
        if (loading !== this.loading) this.timeline.push(`loading:${loading}`);
        this.loading = loading;
    }
    updateBar(bar: OHLCV): void { this.bars.push(bar); }
    setNativeData(type: string, data: unknown): void { this.nativePushes.push([type, data]); }
    ensurePane(_p: Pane): void {}
    removePane(_id: string): void {}
    mountIndicator(model: IndicatorModel): IndicatorRenderHandle { this.mountedModels.push(model); return { id: model.id }; }
    updates: ScenePatch[] = [];
    updateIndicator(_h: IndicatorRenderHandle, p: ScenePatch): void { this.updates.push(p); }
    removeIndicator(_h: IndicatorRenderHandle): void {}
    setIndicatorInputs(_h: IndicatorRenderHandle, _v: Record<string, InputValue>): void {}
    setIndicatorVisible(_h: IndicatorRenderHandle, _v: boolean): void {}
    onInputChange(_cb: (e: InputChangeEvent) => void): Unsubscribe { return () => {}; }
    onRemoveIndicator(_cb: (id: string) => void): Unsubscribe { return () => {}; }
    onCrosshairMove(_cb: (e: CrosshairEvent) => void): Unsubscribe { return () => {}; }
    onClick(_cb: (e: ClickEvent) => void): Unsubscribe { return () => {}; }
    /** Settable current viewport — what a session-only switch may carry over. */
    visibleRange: VisibleRange | null = null;
    getVisibleRange(): VisibleRange | null { return this.visibleRange; }
    setVisibleRange(r: VisibleRange): void { this.visibleRangeCalls.push(r); }
    onViewportChange(_cb: (r: VisibleRange) => void): Unsubscribe { return () => {}; }
}

/** Static engine that records the market of every execution and every session stop. */
class RecordingEngine implements ScriptingEngine {
    readonly language = 'pine';
    readonly capabilities: EngineCapabilities = { streaming: false, visibleRange: false, inputs: true };
    executions: Array<{ symbol: string; timeframe: string; barClose: number | undefined }> = [];
    stops = 0;

    prepare(_source: string, instanceId: string): Promise<PreparedScript> {
        return Promise.resolve({
            language: 'pine',
            inputs: [],
            meta: { title: 'Rec', overlay: true },
            reactsToViewport: false,
            token: { instanceId },
        });
    }

    execute(req: ExecutionRequest, handlers: ExecutionHandlers): ExecutionSession {
        const id = (req.prepared.token as { instanceId: string }).instanceId;
        const bars = req.getBars?.() ?? req.bars;
        this.executions.push({ symbol: req.market.symbol, timeframe: req.market.timeframe, barClose: bars[0]?.close });
        handlers.onModel({
            id,
            title: 'Rec',
            overlay: true,
            paneHint: 'price',
            series: [{ id: `${id}:line:x#0`, title: 'Rec', paneId: 'unrouted', kind: 'line', points: bars.map((b) => ({ time: b.time, value: b.close })), style: { color: '#f00', width: 1, lineStyle: 'solid' } }],
            fills: [], backgrounds: [], priceLines: [],
            inputs: req.prepared.inputs,
            inputValues: req.inputs ?? {},
        });
        handlers.onDone?.();
        return {
            stop: () => { this.stops += 1; },
            update: () => {},
            setVisibleRange: () => {},
            notifyBars: () => {},
        };
    }
}

/**
 * Static engine whose model carries every LINGER VECTOR of a market switch: content
 * that does not ride the bar series (drawings, bgcolor spans, hlines) keeps painting
 * on the incoming market's axis until the re-run's model lands. The handlers are kept
 * so a test can emit a STALE model mid-switch (a run already in flight at quiesce).
 */
class DrawingEngine implements ScriptingEngine {
    readonly language = 'pine';
    readonly capabilities: EngineCapabilities = { streaming: false, visibleRange: false, inputs: true };
    handlers: ExecutionHandlers | null = null;
    private id = '';
    private bars: OHLCV[] = [];

    prepare(_source: string, instanceId: string): Promise<PreparedScript> {
        return Promise.resolve({
            language: 'pine',
            inputs: [],
            meta: { title: 'Draw', overlay: true },
            reactsToViewport: false,
            token: { instanceId },
        });
    }

    execute(req: ExecutionRequest, handlers: ExecutionHandlers): ExecutionSession {
        this.handlers = handlers;
        this.id = (req.prepared.token as { instanceId: string }).instanceId;
        this.bars = req.getBars?.() ?? req.bars;
        this.emitModel();
        handlers.onDone?.();
        return { stop: () => {}, update: () => {}, setVisibleRange: () => {}, notifyBars: () => {} };
    }

    /** Emit a full model over the last-seen bars (call again to simulate a stale in-flight run). */
    emitModel(): void {
        const id = this.id;
        const t0 = this.bars[0]?.time ?? 0;
        const t1 = this.bars[this.bars.length - 1]?.time ?? 0;
        const price = this.bars[0]?.close ?? 0;
        const mkLine = (n: number): DrawingLine => ({ id: `${id}:l${n}`, paneId: 'unrouted', xloc: 'bar_time', x1: t0, y1: price + n, x2: t1, y2: price + n, extend: 'right', color: '#0f0', invisible: false, width: 1, style: 'solid', arrowLeft: false, arrowRight: false });
        this.handlers?.onModel({
            id,
            title: 'Draw',
            overlay: true,
            paneHint: 'price',
            series: [
                { id: `${id}:line:x#0`, title: 'Hi', paneId: 'unrouted', kind: 'line', points: this.bars.map((b) => ({ time: b.time, value: b.close + 1 })), style: { color: '#f00', width: 1, lineStyle: 'solid' } },
                { id: `${id}:line:x#1`, title: 'Lo', paneId: 'unrouted', kind: 'line', points: this.bars.map((b) => ({ time: b.time, value: b.close - 1 })), style: { color: '#f00', width: 1, lineStyle: 'solid' } },
                { id: `${id}:markers:x#2`, title: 'Marks', paneId: 'unrouted', kind: 'markers', markers: [{ time: t1, position: 'aboveBar', shape: 'arrowUp', color: '#0f0' }] },
            ],
            fills: [{ id: `${id}:f0`, paneId: 'unrouted', fromSeriesId: `${id}:line:x#0`, toSeriesId: `${id}:line:x#1`, color: '#808' }],
            backgrounds: [{ id: `${id}:bg0`, paneId: 'unrouted', from: t0, to: t1, color: '#00f' }],
            priceLines: [{ id: `${id}:hl0`, paneId: 'unrouted', price }],
            lines: [mkLine(0)],
            boxes: [{ id: `${id}:b0`, paneId: 'unrouted', xloc: 'bar_time', left: t0, top: price + 1, right: t1, bottom: price - 1, extend: 'none', bgColor: '#333', borderWidth: 1, borderStyle: 'solid', textSize: 'auto', hAlign: 'center', vAlign: 'center', wrap: false, fontFamily: 'default', bold: false, italic: false }],
            labels: [{ id: `${id}:lb0`, paneId: 'unrouted', xloc: 'bar_time', x: t1, y: price, yloc: 'price', style: 'label_up', color: '#ff0', size: 'small', textAlign: 'center', fontFamily: 'default' }],
            polylines: [{ id: `${id}:pl0`, paneId: 'unrouted', points: [{ xloc: 'bar_time', x: t0, price }, { xloc: 'bar_time', x: t1, price: price + 2 }], curved: false, closed: false, lineColor: '#fa0', lineWidth: 1, lineStyle: 'solid', arrowLeft: false, arrowRight: false }],
            linefills: [{ id: `${id}:lf0`, paneId: 'unrouted', line1: mkLine(1), line2: mkLine(2), color: '#088' }],
            tables: [{ id: `${id}:t0`, paneId: 'unrouted', position: 'top_right', columns: 1, rows: 1, frameWidth: 0, borderWidth: 0, cells: [[{ text: 'X', hAlign: 'center', vAlign: 'center', textSize: 'auto', fontFamily: 'default', bold: false, italic: false }]], merges: [] }],
            barColors: [{ time: t1, color: '#f0f' }],
            trades: [{ time: t1, price, side: 'buy', kind: 'entry' }],
            inputs: [],
            inputValues: {},
        });
    }
}

/** A probe native-indicator type: records each instance's start context + lifecycle. */
type ProbeInstance = { symbol?: string; ctx?: NativeIndicatorContext; started: number; stopped: number; resumed: number; suspended: number };

function probeNative(): { descriptor: NativeIndicatorDescriptor; instances: ProbeInstance[] } {
    const instances: ProbeInstance[] = [];
    const descriptor: NativeIndicatorDescriptor = {
        type: 'probe',
        title: 'Probe',
        paneHint: 'price',
        overlay: true,
        inputsSchema: () => [],
        defaultInputs: () => ({}),
        create: () => {
            const rec: ProbeInstance = { started: 0, stopped: 0, resumed: 0, suspended: 0 };
            instances.push(rec);
            return {
                start(ctx: NativeIndicatorContext) { rec.started += 1; rec.symbol = ctx.symbol; rec.ctx = ctx; ctx.emit({}); },
                onBars() {},
                onViewport() {},
                setInputs() {},
                suspend() { rec.suspended += 1; },
                resume() { rec.resumed += 1; },
                stop() { rec.stopped += 1; },
            };
        },
    };
    return { descriptor, instances };
}

const EL = {} as unknown as HTMLElement;
const charts: Vela[] = [];
function make(options: ConstructorParameters<typeof Vela>[1], deps: ConstructorParameters<typeof Vela>[2]): Vela {
    const chart = new Vela(EL, options, deps);
    charts.push(chart);
    return chart;
}

afterEach(() => {
    for (const c of charts.splice(0)) c.destroy();
    unregisterNativeIndicator('probe');
    unregisterChartType('probe-style');
});

/** Captures actual Canvas paints, including the frame at each bar replacement. */
class SnapshotCanvasRenderer extends FakeRenderer {
    readonly scene = new SceneGraph();
    readonly coords = new CoordinateSystem();
    readonly backend = new Canvas2dBackend();
    readonly frames: string[][] = [];
    private paints: string[] = [];
    private readonly theme: VelaTheme = { background: '#000', textColor: '#ccc', gridColor: '#222', borderColor: '#333', upColor: '#0a0', downColor: '#a00', fontFamily: 'sans-serif' };

    constructor() {
        super();
        this.coords.setSize(800, 200, 1);
        this.coords.setViewport({ barSpacing: 10, rightOffset: 0 });
        const ctx = new Proxy({ globalAlpha: 1 } as CanvasRenderingContext2D, {
            get: (target, key) => key === 'stroke' ? () => this.paints.push(String(target.strokeStyle))
                : key === 'fillRect' || key === 'fill' ? () => this.paints.push(String(target.fillStyle))
                : Reflect.has(target, key) ? Reflect.get(target, key) : () => undefined,
            set: (target, key, value) => Reflect.set(target, key, value),
        });
        this.backend.mount({ width: 800, height: 200, getContext: () => ctx } as unknown as HTMLCanvasElement);
    }

    override setBars(bars: OHLCV[], opts?: { preserveView?: boolean }): void {
        super.setBars(bars, opts);
        this.scene.bars = bars;
        this.coords.setBars(bars.map(bar => bar.time));
        this.frames.push(this.paint());
    }

    override ensurePane(pane: Pane): void {
        const node = this.scene.ensurePane(pane.id, pane.kind, pane.order);
        node.bounds = { top: 0, height: 200 };
        node.scale = { min: 0, max: 250 };
        node.manualScale = node.scale;
    }

    override mountIndicator(model: IndicatorModel): IndicatorRenderHandle {
        this.scene.indicators.set(model.id, model);
        this.scene.barColorsRevision++;
        return super.mountIndicator(model);
    }

    paint(): string[] {
        this.paints = [];
        this.backend.render(this.scene, this.coords, this.theme);
        return [...this.paints];
    }

    override destroy(): void { this.backend.destroy(); }
}

class SnapshotEngine extends RecordingEngine {
    autoEmit = true;
    readonly runs: Array<{ request: ExecutionRequest; handlers: ExecutionHandlers; model: IndicatorModel; contextCalls: number }> = [];
    holdContext: Promise<void> | null = null;

    override execute(request: ExecutionRequest, handlers: ExecutionHandlers): ExecutionSession {
        const id = (request.prepared.token as { instanceId: string }).instanceId;
        const bars = request.bars;
        const value = bars[bars.length - 1]?.close ?? 0;
        const model: IndicatorModel = { id, title: 'Snapshot', overlay: true, paneHint: 'price', series: [], fills: [],
            backgrounds: [], priceLines: bars.length ? [{ id: `${id}:last`, paneId: 'price', price: value, color: '#13579b' }] : [],
            barColors: bars.map(bar => ({ time: bar.time, color: '#2468ac' })), inputs: [], inputValues: {} };
        const run = { request, handlers, model, contextCalls: 0 };
        this.runs.push(run);
        if (this.autoEmit) { handlers.onModel(model); handlers.onDone?.(); }
        return { stop() {}, update() {}, setVisibleRange() {}, notifyBars() {}, getContext: async () => {
            run.contextCalls++;
            const held = this.holdContext;
            this.holdContext = null;
            if (held) await held;
            return { language: 'pine', phase: 'idle', barIndex: bars.length - 1, meta: { title: 'Snapshot', overlay: true },
                variables: { length: bars.length }, plots: { last: bars.map(bar => ({ time: bar.time, value: bar.close })) },
                trades: [{ id: 'local', side: 'long', qty: 1, entry: { id: 'entry', time: bars[0]?.time ?? 0, price: value }, open: true }], warnings: [] } satisfies EngineContextSnapshot;
        } };
    }
}

const snapshotBars = (n: number): OHLCV[] => makeBars(n, 100).map((bar, i) => ({ ...bar, open: 100 + i, high: 102 + i, low: 99 + i, close: 100 + i }));

describe('retreating offline snapshot fences', () => {
    it('clears future-derived Canvas output when a rewind revises the same aggregate candle', async () => {
        const time = Date.UTC(2024, 0, 1);
        const source = snapshotBars(10).map((bar, index) => ({ ...bar, time: time + index * 60_000 }));
        source[9] = { ...source[9]!, high: 200, close: 199, volume: 100 };
        const aggregate = (cursor: number): OHLCV[] => [0, 5].map(start => {
            const rows = source.slice(start, Math.min(start + 5, cursor + 1));
            return { time: rows[0]!.time, open: rows[0]!.open, high: Math.max(...rows.map(bar => bar.high)),
                low: Math.min(...rows.map(bar => bar.low)), close: rows[rows.length - 1]!.close, volume: rows.reduce((sum, bar) => sum + (bar.volume ?? 0), 0) };
        });
        const later = aggregate(9), earlier = aggregate(8);
        expect(later[1]!.time).toBe(earlier[1]!.time);
        expect(later[1]!.close).toBe(199); expect(earlier[1]!.close).toBe(108);
        const renderer = new SnapshotCanvasRenderer(), engine = new SnapshotEngine();
        const chart = make({ symbol: 'AAA', timeframe: '5', data: later, volume: false }, { renderer, engines: [engine] });
        chart.addIndicator('snapshot', { id: 'snapshot' });
        await chart.ready(); await flush();
        expect(renderer.paint()).toContain('#13579b'); expect(renderer.paint()).toContain('#2468ac');
        engine.autoEmit = false; renderer.frames.length = 0;
        await chart.setMarket({ data: earlier, preserveView: true });
        const rerun = engine.runs[engine.runs.length - 1]!;
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        try { rerun.handlers.onError?.(new Error('same-bucket rollback test failure')); } finally { errorLog.mockRestore(); }
        expect(renderer.paint()).not.toContain('#13579b'); expect(renderer.paint()).not.toContain('#2468ac');
        expect(renderer.frames.flat()).not.toContain('#13579b'); expect(renderer.frames.flat()).not.toContain('#2468ac');
        rerun.handlers.onModel(rerun.model);
        expect(renderer.paint()).toContain('#13579b');
        expect(renderer.scene.indicators.get('snapshot')!.priceLines[0]!.price).toBe(108);
    });

    for (const empty of [false, true]) it(`clears future-derived Canvas output before ${empty ? 'an empty snapshot' : 'a retreat'} and a failed rerun`, async () => {
        const renderer = new SnapshotCanvasRenderer(), engine = new SnapshotEngine();
        const chart = make({ symbol: 'AAA', timeframe: '60', data: snapshotBars(100), volume: false }, { renderer, engines: [engine] });
        chart.addIndicator('snapshot', { id: 'snapshot' });
        await chart.ready(); await flush();
        expect(renderer.paint()).toContain('#13579b');
        expect(renderer.paint()).toContain('#2468ac');
        expect(renderer.scene.indicators.get('snapshot')!.priceLines[0]!.price).toBe(199);
        const pane = renderer.scene.panes.get('price')!, scale = pane.manualScale;
        const viewport = renderer.coords.getViewport();
        engine.autoEmit = false;
        renderer.frames.length = 0;
        await chart.setMarket({ data: empty ? [] : snapshotBars(10), preserveView: true });
        const rerun = engine.runs[engine.runs.length - 1]!;
        if (empty) rerun.handlers.onModel(rerun.model);
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        try { rerun.handlers.onError?.(new Error('local test failure')); } finally { errorLog.mockRestore(); }
        expect(renderer.paint()).not.toContain('#13579b');
        expect(renderer.paint()).not.toContain('#2468ac');
        expect(renderer.frames.flat()).not.toContain('#13579b');
        expect(renderer.frames.flat()).not.toContain('#2468ac');
        expect(renderer.scene.panes.get('price')).toBe(pane);
        expect(pane.manualScale).toBe(scale);
        expect(renderer.coords.getViewport()).toEqual(viewport);
        expect(chart.indicators().map(handle => handle.id)).toEqual(['snapshot']);
        // An empty snapshot must not leave a future model waiting to reappear on refill.
        if (empty) {
            await chart.setMarket({ data: snapshotBars(10), preserveView: true });
            expect(renderer.paint()).not.toContain('#13579b');
            expect(renderer.frames.flat()).not.toContain('#13579b');
        }
        const current = engine.runs[engine.runs.length - 1]!;
        current.handlers.onModel(current.model);
        expect(renderer.paint()).toContain('#13579b');
        expect(renderer.scene.indicators.get('snapshot')!.priceLines[0]!.price).toBe(109);
    });

    for (const empty of [false, true]) it(`clears native and chart-type payloads on ${empty ? 'empty' : 'retreat'} without reviving stopped hosts`, async () => {
        const hosts: SeriesDataEngineHost[] = [];
        registerChartType({ id: 'probe-style', dataEngine: () => ({ start: host => {
            hosts.push(host);
            if (hosts.length === 1) { host.pushData({ derived: 199 }); host.pushPending([[1, 2]]); }
        }, suspend() {}, resume() {}, stop() {} }) });
        const { descriptor, instances } = probeNative();
        registerNativeIndicator(descriptor);
        const renderer = new FakeRenderer(); renderer.priceStyleFeature = 'probe-style';
        const chart = make({ symbol: 'AAA', timeframe: '60', data: snapshotBars(100), volume: false }, { renderer });
        chart.addNativeIndicator('probe');
        await chart.ready(); await flush();
        instances[0]!.ctx!.pushData({ derived: 199 });
        await chart.setMarket({ data: empty ? [] : snapshotBars(10), preserveView: true }); await flush();
        const pushes = new Map(renderer.nativePushes);
        expect(pushes.get('probe-style')).toBeUndefined();
        expect(pushes.get('probe-style-pending')).toEqual([]);
        expect(pushes.get('probe')).toBeUndefined();
        const count = renderer.nativePushes.length;
        hosts[0]!.pushData({ derived: 199 }); instances[0]!.ctx!.pushData({ derived: 199 });
        expect(renderer.nativePushes).toHaveLength(count);
    });
});

describe('deferred script run fences', () => {
    it('fences a snapshot restart before the deferred context pull starts', async () => {
        const engine = new SnapshotEngine(), runs: ScriptRun[] = [];
        const chart = make({ symbol: 'AAA', timeframe: '60', data: snapshotBars(100), volume: false }, { renderer: new FakeRenderer(), engines: [engine] });
        chart.on('script:run', run => runs.push(run));
        chart.addIndicator('snapshot', { id: 'snapshot' });
        await chart.ready(); await flush(); runs.length = 0;
        const old = engine.runs[0]!, calls = old.contextCalls;
        old.handlers.onModel(old.model);
        await chart.setMarket({ data: snapshotBars(10), preserveView: true }); await flush();
        expect(old.contextCalls).toBe(calls);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.vars).toEqual({ length: 10 });
    });

    it('fences a replaced execution on the same record without a market change', async () => {
        const engine = new SnapshotEngine(), runs: ScriptRun[] = [];
        const chart = make({ symbol: 'AAA', timeframe: '60', data: snapshotBars(100), volume: false }, { renderer: new FakeRenderer(), engines: [engine] });
        chart.on('script:run', run => runs.push(run));
        const handle = chart.addIndicator('snapshot', { id: 'snapshot' });
        await chart.ready(); await flush(); runs.length = 0;
        let release!: () => void;
        engine.holdContext = new Promise<void>(resolve => { release = resolve; });
        engine.runs[0]!.handlers.onModel(engine.runs[0]!.model);
        await flush();
        expect((await handle.updateCode('replacement')).ok).toBe(true);
        await flush(); release(); await flush();
        expect(engine.runs).toHaveLength(2);
        expect(runs).toHaveLength(1);
        expect(await runs[0]!.series('last')).toHaveLength(100);
    });

    it('drops an old context across snapshot restart and keeps current callbacks usable', async () => {
        const engine = new SnapshotEngine(), runs: ScriptRun[] = [];
        const chart = make({ symbol: 'AAA', timeframe: '60', data: snapshotBars(100), volume: false }, { renderer: new FakeRenderer(), engines: [engine] });
        chart.on('script:run', run => runs.push(run));
        let release!: () => void;
        engine.holdContext = new Promise<void>(resolve => { release = resolve; });
        chart.addIndicator('snapshot', { id: 'snapshot' });
        await chart.ready(); await flush();
        expect(engine.runs[0]!.contextCalls).toBe(1);
        await chart.setMarket({ data: snapshotBars(10), preserveView: true }); await flush();
        expect(runs).toHaveLength(1);
        const current = runs[0]!;
        expect(current.vars).toEqual({ length: 10 }); expect(current.bar).toBe(9);
        release(); await flush();
        expect(runs).toHaveLength(1);
        expect(await current.series('last')).toHaveLength(10);
        expect(await current.trades()).toHaveLength(1);

        let releaseSeries!: () => void;
        engine.holdContext = new Promise<void>(resolve => { releaseSeries = resolve; });
        const pendingSeries = current.series('last');
        let releaseTrades!: () => void;
        engine.holdContext = new Promise<void>(resolve => { releaseTrades = resolve; });
        const pendingTrades = current.trades();
        await chart.setMarket({ data: snapshotBars(5), preserveView: true }); await flush();
        releaseSeries(); releaseTrades();
        expect(await pendingSeries).toEqual([]); expect(await pendingTrades).toEqual([]);
        const latest = engine.runs[engine.runs.length - 1]!, calls = latest.contextCalls;
        expect(await current.series('last')).toEqual([]); expect(await current.trades()).toEqual([]);
        expect(latest.contextCalls).toBe(calls);
    });

    for (const beforeMicrotask of [false, true]) it(`drops same-id replacement emissions ${beforeMicrotask ? 'before the context pull' : 'after the context await'}`, async () => {
        const engine = new SnapshotEngine(), runs: ScriptRun[] = [];
        const chart = make({ symbol: 'AAA', timeframe: '60', data: snapshotBars(100), volume: false }, { renderer: new FakeRenderer(), engines: [engine] });
        chart.on('script:run', run => runs.push(run));
        const handle = chart.addIndicator('snapshot', { id: 'same' });
        await chart.ready(); await flush(); runs.length = 0;
        let release!: () => void;
        engine.holdContext = new Promise<void>(resolve => { release = resolve; });
        const old = engine.runs[0]!, previousCalls = old.contextCalls;
        old.handlers.onModel(old.model);
        if (!beforeMicrotask) await flush();
        handle.remove();
        if (beforeMicrotask) engine.holdContext = null;
        chart.addIndicator('replacement', { id: 'same' });
        await flush(); release(); await flush();
        expect(runs).toHaveLength(1);
        expect(old.contextCalls).toBe(previousCalls + (beforeMicrotask ? 0 : 1));
        expect(await runs[0]!.series('last')).toHaveLength(100);
    });
});

describe('same-market offline snapshots', () => {
    it('preserves the view, skips provider loads and identity events, and accepts an empty snapshot', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', data: makeBars(20, 100), volume: false }, { renderer, dataFeed: feed });
        await chart.ready();
        const identities: unknown[] = [], loads: unknown[] = [];
        chart.on('market:changed', e => identities.push(e));
        chart.on('load:start', e => loads.push(e));
        renderer.setBarsCalls.length = 0;
        await chart.setMarket({ data: makeBars(21, 110), preserveView: true });
        expect(renderer.setBarsCalls).toEqual([{ n: 21, close: 110, preserveView: true }]);
        await chart.setMarket({ data: [], preserveView: true });
        expect(renderer.bars).toEqual([]);
        expect(chart.latestBar).toBeNull();
        expect(chart.market.offline).toBe(true);
        expect(feed.loads).toEqual([]);
        expect(identities).toEqual([]);
        expect(loads).toEqual([]);
    });

    it('rejects preserving data across an identity or source change before mutating the chart', async () => {
        const chart = make({ symbol: 'AAA', timeframe: '60', data: makeBars(20, 100), volume: false }, { renderer: new FakeRenderer(), dataFeed: new SwitchFeed() });
        await chart.ready();
        for (const next of [{ symbol: 'BBB', data: [] }, { timeframe: '5', data: [] }, { session: 'extended' as const, data: [] }, {}]) {
            await expect(chart.setMarket({ ...next, preserveView: true })).rejects.toThrow('current offline market');
        }
        expect(chart.market).toMatchObject({ symbol: 'AAA', timeframe: '60', offline: true });
        expect(chart.latestBar?.close).toBe(100);
    });

    it('supersedes consumers, revokes stale hosts, and restarts scripts/natives/type engines over the newest snapshot', async () => {
        const hosts: SeriesDataEngineHost[] = [];
        registerChartType({ id: 'probe-style', dataEngine: () => ({ start: host => { hosts.push(host); }, suspend() {}, resume() {}, stop() {} }) });
        const { descriptor, instances } = probeNative();
        registerNativeIndicator(descriptor);
        const renderer = new FakeRenderer(); renderer.priceStyleFeature = 'probe-style';
        const engine = new RecordingEngine();
        const callbacks: ExecutionHandlers[] = [];
        const execute = engine.execute.bind(engine);
        engine.execute = (request, handlers) => { callbacks.push(handlers); return execute(request, handlers); };
        const chart = make({ symbol: 'AAA', timeframe: '60', data: makeBars(20, 100), volume: false }, { renderer, engines: [engine], dataFeed: new SwitchFeed() });
        chart.addIndicator('synthetic'); chart.addNativeIndicator('probe');
        await chart.ready(); await flush();
        const oldHost = hosts[0]!, oldNative = instances[0]!.ctx!;
        const oldScript = callbacks[0]!, oldModel = renderer.mountedModels[0]!;
        const beforeRuns = engine.executions.length;
        renderer.nativePushes.length = 0;
        const first = chart.setMarket({ data: makeBars(21, 110), preserveView: true });
        oldHost.pushData({ stale: true }); oldHost.pushPending([[1, 2]]);
        const models = renderer.mountedModels.length;
        oldNative.emit({});
        oldScript.onModel({ ...oldModel, title: 'Stale snapshot' });
        expect(renderer.mountedModels).toHaveLength(models);
        expect(renderer.updates).toEqual([]);
        expect(renderer.nativePushes).toEqual([]);
        const second = chart.setMarket({ data: makeBars(22, 120), preserveView: true });
        await Promise.all([first, second]); await flush();
        expect(engine.executions.slice(beforeRuns)).toEqual([{ symbol: 'AAA', timeframe: '60', barClose: 120 }]);
        const latestNativeBars = instances[instances.length - 1]!.ctx!.bars();
        expect(latestNativeBars).toHaveLength(22);
        expect(latestNativeBars[latestNativeBars.length - 1]?.close).toBe(120);
        expect(hosts[hosts.length - 1]!.bars()).toHaveLength(22);
        oldHost.pushData({ stale: 'after' }); oldNative.emit({});
        oldScript.onModel({ ...oldModel, title: 'Stale snapshot' });
        expect(renderer.nativePushes).toEqual([]);
        expect(renderer.mountedModels[renderer.mountedModels.length - 1]?.title).not.toBe('Stale snapshot');
        expect(chart.latestBar?.close).toBe(120);
    });

    it('replaces an internal replay with the host snapshot without restoring hidden future bars', async () => {
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', data: makeBars(100, 100), volume: false }, { renderer, dataFeed: new SwitchFeed() });
        await chart.ready();
        const replayBars = makeBars(20, 100);
        await chart.replay.start({ from: replayBars[replayBars.length - 1]!.time });
        expect(chart.replay.state.active).toBe(true);
        const snapshotBars = makeBars(21, 100);
        await chart.setMarket({ data: snapshotBars, preserveView: true });
        expect(chart.replay.state.active).toBe(false);
        expect(renderer.bars).toHaveLength(21);
        chart.replay.stop();
        expect(renderer.bars).toHaveLength(21);
        expect(chart.latestBar?.time).toBe(snapshotBars[snapshotBars.length - 1]!.time);
    });
});

describe('setMarket — in-place market switch', () => {
    it('reloads bars, re-frames (no preserveView), and emits market:changed with prev', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        const events: Array<{ symbol: string; timeframe: string; prev: { symbol: string; timeframe: string } }> = [];
        chart.on('market:changed', (e) => events.push(e));

        await chart.setMarket({ symbol: 'BBB', timeframe: '240' });

        expect(renderer.bars[0]?.close).toBe(PRICE.BBB);
        const last = renderer.setBarsCalls[renderer.setBarsCalls.length - 1]!;
        expect(last.preserveView).toBe(false); // a fresh series re-frames the view
        expect(events).toEqual([{ symbol: 'BBB', timeframe: '240', prev: { symbol: 'AAA', timeframe: '60' } }]);
        expect(feed.loads[feed.loads.length - 1]).toMatchObject({ symbol: 'BBB', timeframe: '240' });
    });

    it('chart.market snapshots the REQUESTED identity — an in-flight switch shows immediately', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        expect(chart.market).toMatchObject({ symbol: 'AAA', timeframe: '60', offline: false });

        const done = chart.setMarket({ symbol: 'BBB', timeframe: '240' });
        // Before the load lands: the snapshot already answers with the new identity
        // (persist-on-close must capture the INTENT, not the last committed market).
        expect(chart.market).toMatchObject({ symbol: 'BBB', timeframe: '240' });
        await done;
        expect(chart.market).toMatchObject({ symbol: 'BBB', timeframe: '240', offline: false });
        // A snapshot, not the live config — mutating it changes nothing.
        const snap = chart.market;
        snap.symbol = 'ZZZ';
        expect(chart.market.symbol).toBe('BBB');
    });

    it('a SESSION switch reloads like a timeframe change, and the flag rides the load config', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        const events: unknown[] = [];
        chart.on('market:changed', (e) => events.push(e));

        await chart.setMarket({ session: 'extended' });

        // The reload happened (same symbol — the SESSION is the changed identity),
        // and the feed saw the flag on the load config (providers read it off BarRange).
        expect(feed.loads[feed.loads.length - 1]).toMatchObject({ symbol: 'AAA', session: 'extended' });
        expect(chart.market.session).toBe('extended');
        expect(events).toHaveLength(1); // an identity change — the chrome must re-sync

        // Same session again: a no-op, no reload.
        const loadsBefore = feed.loads.length;
        await chart.setMarket({ session: 'extended' });
        expect(feed.loads.length).toBe(loadsBefore);
    });

    it('a session-only flip carries the current zoom/position over the reload', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        const window = { from: 1_700_010_000_000, to: 1_700_020_000_000 };
        renderer.visibleRange = window; // where the user panned/zoomed to

        await chart.setMarket({ session: 'extended' });
        // The reload re-framed the SAME window — no zoom/position reset on RTH↔ETH.
        expect(renderer.visibleRangeCalls).toContainEqual(window);

        // An explicit frame from the caller still wins over the carry.
        renderer.visibleRangeCalls = [];
        const asked = { from: 1_700_000_000_000, to: 1_700_005_000_000 };
        await chart.setMarket({ session: 'regular', visibleRange: asked });
        expect(renderer.visibleRangeCalls).toContainEqual(asked);
        expect(renderer.visibleRangeCalls).not.toContainEqual(window);
    });

    it('the carried view keeps the BAR COUNT, not the wall clock (densities differ per session)', async () => {
        // Extended = hourly bars; regular = every OTHER hour (half density), same right
        // edge — the RTH/ETH shape. Preserving the raw time window across the flip
        // would halve the bars on screen (a perceived zoom-in); the carry must instead
        // keep the COUNT and re-derive the window from the incoming series.
        const END = 1_700_216_000_000;
        const densityFeed = {
            load: (cfg: MarketConfig): Promise<OHLCV[]> => {
                const step = cfg.session === 'regular' ? 7_200_000 : 3_600_000;
                const n = 60;
                return Promise.resolve(Array.from({ length: n }, (_, i) => ({ time: END - (n - 1 - i) * step, open: 1, high: 2, low: 0, close: 1, volume: 1 })));
            },
            subscribe: (): (() => void) => () => {},
        } as unknown as MarketDataFeed;
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', session: 'extended', volume: false }, { renderer, engines: [], dataFeed: densityFeed });
        await chart.ready();
        // The user looks at the last 10 hourly bars.
        renderer.visibleRange = { from: END - 9 * 3_600_000 - 1, to: END + 1 };

        await chart.setMarket({ session: 'regular' });
        // Refined frame: 10 bars of the NEW series — twice the wall clock, same zoom.
        const last = renderer.visibleRangeCalls[renderer.visibleRangeCalls.length - 1]!;
        expect(last).toEqual({ from: END - 9 * 7_200_000, to: END + 1 });
    });

    it('a session-only flip DEEPENS the reload to cover the carried window', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        // The user panned ~900 hourly bars into the past — 500 bars cannot reach it.
        renderer.visibleRange = { from: Date.now() - 900 * 3_600_000, to: Date.now() - 880 * 3_600_000 };
        await chart.setMarket({ session: 'extended' });
        const deep = feed.loads[feed.loads.length - 1]!.bars ?? 0;
        expect(deep).toBeGreaterThanOrEqual(900); // reaches the window (+ margin)
        expect(deep).toBeLessThanOrEqual(5000); // …but never a mega-load

        // A NEARBY window needs no deepening — the default depth already covers it.
        renderer.visibleRange = { from: Date.now() - 100 * 3_600_000, to: Date.now() - 90 * 3_600_000 };
        await chart.setMarket({ session: 'regular' });
        // Depth only ever grows within a chart's lifetime (the previous flip deepened it).
        expect(feed.loads[feed.loads.length - 1]!.bars).toBe(deep);
    });

    it('a SYMBOL switch keeps today\'s re-frame (no stale window carried to a new clock)', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        renderer.visibleRange = { from: 1_700_010_000_000, to: 1_700_020_000_000 };

        await chart.setMarket({ symbol: 'BBB' });
        expect(renderer.visibleRangeCalls).not.toContainEqual({ from: 1_700_010_000_000, to: 1_700_020_000_000 });
    });

    it('frames a requested visibleRange on the first paint of the new market', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();

        const range = { from: 1_700_000_000_000, to: 1_700_036_000_000 };
        await chart.setMarket({ symbol: 'BBB', visibleRange: range });
        expect(renderer.visibleRangeCalls).toContainEqual(range);
    });

    it('re-executes Pine sessions over the new market (fresh ExecutionRequest.market)', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const engine = new RecordingEngine();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [engine], dataFeed: feed });
        chart.addIndicator('rec');
        await chart.ready();
        await flush();
        expect(engine.executions).toEqual([{ symbol: 'AAA', timeframe: '60', barClose: PRICE.AAA }]);

        await chart.setMarket({ symbol: 'BBB' });
        await flush();

        expect(engine.stops).toBe(1); // the old session was torn down
        expect(engine.executions[1]).toEqual({ symbol: 'BBB', timeframe: '60', barClose: PRICE.BBB });
    });

    it('an identity switch blanks mounted indicator visuals for the gap (nothing stale outlives the old market)', async () => {
        const feed = new SwitchFeed();
        feed.gatedLoads.add('SLOW');
        const renderer = new FakeRenderer();
        const engine = new DrawingEngine();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [engine], dataFeed: feed });
        chart.addIndicator('draw');
        await chart.ready();
        await flush();
        const mounted = renderer.mountedModels[renderer.mountedModels.length - 1]!;
        expect(mounted.lines).toHaveLength(1);
        expect(mounted.boxes).toHaveLength(1);
        expect(mounted.labels).toHaveLength(1);

        const done = chart.setMarket({ symbol: 'SLOW' });
        // Synchronously at the switch: the model is remounted BLANK. The new market's bars
        // land before the script's re-run completes, and time-anchored drawings, bgcolor
        // spans, and hlines would otherwise keep painting on the new axis for that window.
        const blanked = renderer.mountedModels[renderer.mountedModels.length - 1]!;
        expect(blanked.id).toBe(mounted.id);
        // EVERY output vocabulary is emptied — plots, markers, fills, bgcolor spans,
        // hlines, all six drawing kinds, barcolor, and strategy trades.
        expect(blanked.lines).toEqual([]);
        expect(blanked.boxes).toEqual([]);
        expect(blanked.labels).toEqual([]);
        expect(blanked.polylines).toEqual([]);
        expect(blanked.linefills).toEqual([]);
        expect(blanked.tables).toEqual([]);
        expect(blanked.backgrounds).toEqual([]);
        expect(blanked.priceLines).toEqual([]);
        expect(blanked.fills).toEqual([]);
        expect(blanked.barColors).toEqual([]);
        expect(blanked.trades).toEqual([]);
        expect(blanked.series.map((s) => (s.kind === 'markers' ? s.markers : s.kind === 'line' ? s.points : null))).toEqual([[], [], []]);
        // The structure survives — legend/settings keep working through the gap.
        expect(blanked.series[0]!.id).toBe(mounted.series[0]!.id);

        feed.release();
        await done;
        await flush();
        // The re-run's model repaints over the new market.
        const fresh = renderer.mountedModels[renderer.mountedModels.length - 1]!;
        expect(fresh.lines).toHaveLength(1);
        expect(fresh.lines![0]!.x1).toBe(renderer.bars[0]!.time);
    });

    it('a stale model landing MID-SWITCH is dropped (a run in flight at quiesce cannot repaint the blank)', async () => {
        const feed = new SwitchFeed();
        feed.gatedLoads.add('SLOW');
        const renderer = new FakeRenderer();
        const engine = new DrawingEngine();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [engine], dataFeed: feed });
        chart.addIndicator('draw');
        await chart.ready();
        await flush();

        const done = chart.setMarket({ symbol: 'SLOW' });
        const mounts = renderer.mountedModels.length;
        const updates = renderer.updates.length;
        engine.emitModel(); // the OLD session's run completes mid-switch, over the OLD bars
        expect(renderer.mountedModels.length).toBe(mounts); // dropped, not remounted…
        expect(renderer.updates.length).toBe(updates); // …and never value-patched

        feed.release();
        await done;
        await flush();
        // The post-load re-execution still delivers the new market's model.
        const fresh = renderer.mountedModels[renderer.mountedModels.length - 1]!;
        expect(fresh.lines).toHaveLength(1);
        expect(fresh.lines![0]!.x1).toBe(renderer.bars[0]!.time);
    });

    it('restarts a native indicator with a fresh context, keeping the record id', async () => {
        const { descriptor, instances } = probeNative();
        registerNativeIndicator(descriptor);
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        const handle = chart.addNativeIndicator('probe');
        await chart.ready();
        await flush();
        expect(instances).toHaveLength(1);
        expect(instances[0]!.symbol).toBe('AAA');

        await chart.setMarket({ symbol: 'BBB' });
        await flush();

        expect(instances[0]!.stopped).toBe(1); // old instance released
        expect(instances).toHaveLength(2); // fresh instance from the descriptor
        expect(instances[1]!.symbol).toBe('BBB'); // …started over the NEW market
        expect(chart.indicators().some((h) => h.id === handle.id)).toBe(true); // same record/legend
    });

    it('a hidden native goes stale: shown again, it STARTS fresh instead of resuming', async () => {
        const { descriptor, instances } = probeNative();
        registerNativeIndicator(descriptor);
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        const handle = chart.addNativeIndicator('probe');
        await chart.ready();
        await flush();
        handle.setVisible(false);
        expect(instances[0]!.suspended).toBe(1);

        await chart.setMarket({ symbol: 'BBB' });
        await flush();
        expect(instances).toHaveLength(2);
        expect(instances[1]!.started).toBe(0); // hidden — not started yet

        handle.setVisible(true);
        await flush();
        expect(instances[1]!.started).toBe(1); // started fresh…
        expect(instances[1]!.symbol).toBe('BBB'); // …over the new market
        expect(instances[1]!.resumed).toBe(0); // never resume()d (that would revive the old compute)
    });

    it('rebuilds the active chart-type data engine against the new market', async () => {
        const hosts: SeriesDataEngineHost[] = [];
        let stops = 0;
        registerChartType({
            id: 'probe-style',
            dataEngine: () => ({
                start: (host) => { hosts.push(host); },
                suspend: () => {},
                resume: () => {},
                stop: () => { stops += 1; },
            }),
        });
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        renderer.priceStyleFeature = 'probe-style'; // constructed in the plugin style
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        await flush();
        expect(hosts).toHaveLength(1);
        expect(hosts[0]!.symbol).toBe('AAA');

        await chart.setMarket({ symbol: 'BBB' });
        await flush();

        expect(stops).toBe(1); // the old engine was stopped (its host captured the old market)
        expect(hosts).toHaveLength(2);
        expect(hosts[1]!.symbol).toBe('BBB');
    });

    it('an identity switch silences the active type engine and blanks its channels for the gap', async () => {
        let suspends = 0;
        registerChartType({
            id: 'probe-style',
            dataEngine: () => ({
                start: (host) => { host.pushData({ cells: 'old-market' }); },
                suspend: () => { suspends += 1; },
                resume: () => {},
                stop: () => {},
            }),
        });
        const feed = new SwitchFeed();
        feed.gatedLoads.add('SLOW');
        const renderer = new FakeRenderer();
        renderer.priceStyleFeature = 'probe-style';
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        await flush();
        expect(renderer.nativePushes).toContainEqual(['probe-style', { cells: 'old-market' }]);
        renderer.nativePushes.length = 0;

        const done = chart.setMarket({ symbol: 'SLOW' });
        // Synchronously at the switch — the old engine's per-bar payloads must not survive
        // into the gap where they would map onto the new market's first candles.
        expect(suspends).toBe(1);
        expect(renderer.nativePushes).toContainEqual(['probe-style', undefined]);
        expect(renderer.nativePushes).toContainEqual(['probe-style-pending', []]);

        feed.release();
        await done;
        await flush();
        // The post-load rebuild starts a fresh engine, which pushes the NEW market's data.
        expect(renderer.nativePushes.filter(([t, d]) => t === 'probe-style' && d !== undefined).length).toBeGreaterThan(0);
    });

    it('work the old type engine left in flight never reaches the scene — neither in the gap nor after the reload', async () => {
        const hosts: SeriesDataEngineHost[] = [];
        registerChartType({
            id: 'probe-style',
            dataEngine: () => ({
                start: (host) => { hosts.push(host); host.pushData({ cells: host.symbol }); },
                suspend: () => {},
                resume: () => {},
                stop: () => {},
            }),
        });
        const feed = new SwitchFeed();
        feed.gatedLoads.add('SLOW');
        const renderer = new FakeRenderer();
        renderer.priceStyleFeature = 'probe-style';
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        await flush();
        const old = hosts[0]!;

        const done = chart.setMarket({ symbol: 'SLOW' });
        renderer.nativePushes.length = 0;
        // A fetch the old engine started before the switch resolves while the new bars load:
        // with no bars on the axis, every time-keyed cell it pushes maps to the same slot.
        old.pushData({ cells: 'late' });
        old.pushPending([[1, 2]]);
        expect(renderer.nativePushes).toEqual([]);

        feed.release();
        await done;
        await flush();
        expect(renderer.nativePushes).toContainEqual(['probe-style', { cells: 'SLOW' }]); // the rebuilt engine paints
        renderer.nativePushes.length = 0;
        // Landing after the rebuild, the stopped engine's push would overwrite the new market's cells.
        old.pushData({ cells: 'later' });
        old.pushPending([[3, 4]]);
        expect(renderer.nativePushes).toEqual([]);
    });

    it('an identity switch stops native indicators and blanks their layer channels; the old context goes dead', async () => {
        const { descriptor, instances } = probeNative();
        registerNativeIndicator(descriptor);
        const feed = new SwitchFeed();
        feed.gatedLoads.add('SLOW');
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        chart.addNativeIndicator('probe');
        await chart.ready();
        await flush();
        const oldCtx = instances[0]!.ctx!;
        oldCtx.pushData({ cells: 'AAA' });
        expect(renderer.nativePushes).toContainEqual(['probe', { cells: 'AAA' }]);

        const done = chart.setMarket({ symbol: 'SLOW' });
        // Synchronously at the switch: the old instance is released and its channel blanked —
        // its time-keyed payload would otherwise collapse onto the empty axis for the whole load.
        expect(instances[0]!.stopped).toBe(1);
        expect(renderer.nativePushes[renderer.nativePushes.length - 1]).toEqual(['probe', undefined]);
        renderer.nativePushes.length = 0;
        oldCtx.pushData({ cells: 'late' }); // a fetch it left in flight resolves mid-load
        expect(renderer.nativePushes).toEqual([]);

        feed.release();
        await done;
        await flush();
        expect(instances).toHaveLength(2);
        expect(instances[0]!.stopped).toBe(1); // released once — the post-load restart does not stop it again
        expect(instances[1]!.symbol).toBe('SLOW');
        const mounts = renderer.mountedModels.length;
        const updates = renderer.updates.length;
        oldCtx.pushData({ cells: 'later' });
        oldCtx.emit({});
        instances[1]!.ctx!.pushData({ cells: 'SLOW' });
        expect(renderer.nativePushes).toEqual([['probe', { cells: 'SLOW' }]]);
        expect(renderer.mountedModels.length).toBe(mounts);
        expect(renderer.updates.length).toBe(updates);
    });

    it('a chart CONSTRUCTED in a plugin style starts its data engine only after the first load', async () => {
        // The restore path: a persisted plugin style comes back through the chart
        // OPTIONS. The engine seed must await the REAL readyPromise — seeding before
        // its assignment awaited `undefined`, started the engine with no market, and
        // a later style re-select only resumed the empty engine (nothing painted).
        let startedBeforeData: boolean | null = null;
        let dataLanded = false;
        registerChartType({
            id: 'probe-style',
            dataEngine: () => ({
                start: () => { startedBeforeData ??= !dataLanded; },
                suspend: () => {}, resume: () => {}, stop: () => {},
            }),
        });
        const feed = new SwitchFeed();
        feed.gatedLoads.add('AAA'); // hold the FIRST load — construction must wait behind it
        const renderer = new FakeRenderer();
        renderer.priceStyleFeature = 'probe-style';
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await flush(); // without the ctor-order fix the engine starts HERE, before any data
        dataLanded = true;
        feed.release();
        await chart.ready();
        await flush();
        expect(startedBeforeData).toBe(false); // the engine saw a loaded market at start
    });

    it('a REMOVED auto-added volume stays removed across market switches (opt-out sticks)', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: true }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        await flush();
        const volume = chart.indicators().find((h) => h.title === 'Volume');
        expect(volume).toBeDefined(); // default-on auto-add
        volume!.remove();
        expect(chart.indicators().some((h) => h.title === 'Volume')).toBe(false);

        await chart.setMarket({ symbol: 'BBB' });
        await flush();
        // The auto-add fires on every load's first paint — the user's removal must win.
        expect(chart.indicators().some((h) => h.title === 'Volume')).toBe(false);
    });

    it('re-targets the live subscription', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', live: true, volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        expect(feed.subs).toEqual({ AAA: 1 });

        await chart.setMarket({ symbol: 'BBB' });

        expect(feed.unsubs).toEqual({ AAA: 1 }); // old stream closed
        expect(feed.subs).toEqual({ AAA: 1, BBB: 1 }); // new stream opened
    });

    it('re-arms historyComplete() per load (the old promise resolves, the event fires again)', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        const completes: string[] = [];
        chart.on('history:complete', (e) => completes.push(e.reason));
        const p1 = chart.historyComplete();
        await chart.ready();
        await p1;
        expect(completes).toEqual(['depth']);

        await chart.setMarket({ symbol: 'BBB' });
        await chart.historyComplete(); // the NEW load's promise
        expect(completes).toEqual(['depth', 'depth']);
    });

    it('same-market call is a no-op (no reload, no event)', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        const events: unknown[] = [];
        chart.on('market:changed', (e) => events.push(e));
        const loadsBefore = feed.loads.length;

        await chart.setMarket({ symbol: 'AAA', timeframe: '60' });
        await chart.setMarket({});

        expect(feed.loads.length).toBe(loadsBefore);
        expect(events).toEqual([]);
    });

    it('a depth-only reload fetches but does NOT emit market:changed', async () => {
        const feed = new SwitchFeed();
        feed.depth.AAA = 900;
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', bars: 100, volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        const events: unknown[] = [];
        chart.on('market:changed', (e) => events.push(e));

        await chart.setMarket({ bars: 800 }); // resolves at the progressive head…
        await chart.historyComplete(); // …the depth streams in behind it

        expect(renderer.bars.length).toBe(800);
        expect(events).toEqual([]);
    });

    it('rapid double switch: the last call wins, the superseded one resolves silently', async () => {
        const feed = new SwitchFeed();
        feed.gatedLoads.add('SLOW');
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        const events: Array<{ symbol: string }> = [];
        chart.on('market:changed', (e) => events.push(e));

        const pSlow = chart.setMarket({ symbol: 'SLOW' }); // load parks on the gate
        const pFast = chart.setMarket({ symbol: 'BBB' }); // supersedes it
        await pFast;
        await pSlow; // must resolve promptly (raced against supersession), not hang

        expect(renderer.bars[0]?.close).toBe(PRICE.BBB);
        feed.release(); // the stale SLOW load finally lands…
        await flush();
        expect(renderer.bars[0]?.close).toBe(PRICE.BBB); // …and is dropped, never painted
        expect(events.map((e) => e.symbol)).toEqual(['BBB']); // one switch, one event
    });

    it('switches to offline data (and a later symbol switch drops the offline dataset)', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();

        const offline = makeBars(30, 777);
        await chart.setMarket({ data: offline });
        expect(renderer.bars.length).toBe(30);
        expect(renderer.bars[0]?.close).toBe(777);

        await chart.setMarket({ symbol: 'CCC' }); // back to the provider path
        expect(renderer.bars[0]?.close).toBe(PRICE.CCC);
    });

    it('a switch mid-backfill abandons the old backfill loop', async () => {
        const feed = new SwitchFeed();
        feed.depth.AAA = 15_000;
        feed.gateRanges = true;
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', bars: 12_000, volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready(); // preview + first chunk painted; backfill parked on the gate
        const progress: number[] = [];
        chart.on('history:progress', (e) => progress.push(e.loaded));
        const oldComplete = chart.historyComplete();

        await chart.setMarket({ symbol: 'BBB', bars: 50 });
        await oldComplete; // the superseded load's promise resolves rather than hanging
        expect(renderer.bars[0]?.close).toBe(PRICE.BBB);

        feed.release(); // the old backfill chunk finally lands…
        await flush();
        expect(progress).toEqual([]); // …but the abandoned loop emitted nothing
        expect(renderer.bars[0]?.close).toBe(PRICE.BBB); // and the new market stayed put
    });

    it('destroy mid-switch releases the awaiter', async () => {
        const feed = new SwitchFeed();
        feed.gatedLoads.add('SLOW');
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();

        const p = chart.setMarket({ symbol: 'SLOW' });
        chart.destroy();
        await p; // resolves (silently) instead of hanging on the parked load
    });
});

describe('presentNativeIndicators — the sync presence read', () => {
    it('reflects an add and a remove in the same tick (no async catalog round-trip)', async () => {
        const { descriptor } = probeNative();
        registerNativeIndicator(descriptor);
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        expect(chart.presentNativeIndicators()).toEqual([]);

        const handle = chart.addNativeIndicator('probe');
        // Synchronous: an unload-time persist flush must see this immediately.
        expect(chart.presentNativeIndicators()).toEqual(['probe']);
        handle.remove();
        expect(chart.presentNativeIndicators()).toEqual([]);
    });
});

describe('load states — the cleared chart + the loading affordance', () => {
    it('first load: the affordance is up from the start and ends with the first batch', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        expect(renderer.timeline).toEqual(['loading:true', 'bars:50', 'loading:false']);
        expect(chart).toBeTruthy();
    });

    it('an identity switch blanks the chart immediately and raises the affordance until the new bars land', async () => {
        const feed = new SwitchFeed();
        feed.gatedLoads.add('SLOW');
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        renderer.timeline = [];

        const done = chart.setMarket({ symbol: 'SLOW' });
        // Synchronously on the call: old candles gone, affordance up — nothing waits on the fetch.
        expect(renderer.bars).toEqual([]);
        expect(renderer.loading).toBe(true);

        feed.release();
        await done;
        expect(renderer.bars[0]?.close).toBe(PRICE.SLOW);
        expect(renderer.loading).toBe(false);
        // The affordance rises BEFORE the blank (load:start reaches plugins first), and falls
        // with the new market's first batch.
        expect(renderer.timeline).toEqual(['loading:true', 'bars:0', 'bars:50', 'loading:false']);
    });

    it('the load:start/load:end pair brackets a switch for plugins — start before the blank, end with the first batch', async () => {
        const feed = new SwitchFeed();
        feed.gatedLoads.add('SLOW');
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        const seen: Array<{ ev: string; symbol: string; barsPainted: number; payloadBars?: number; firstLoad?: boolean }> = [];
        chart.on('load:start', (e) => seen.push({ ev: 'start', symbol: e.symbol, barsPainted: renderer.bars.length, firstLoad: e.firstLoad }));
        chart.on('load:end', (e) => seen.push({ ev: 'end', symbol: e.symbol, barsPainted: renderer.bars.length, payloadBars: e.bars }));

        const done = chart.setMarket({ symbol: 'SLOW', timeframe: '240' });
        // start already out, carrying the NEW identity, with the OLD series still painted —
        // a plugin hides its own visuals before anything is blanked.
        expect(seen).toEqual([{ ev: 'start', symbol: 'SLOW', barsPainted: 50, firstLoad: false }]);

        feed.release();
        await done;
        expect(seen[1]).toEqual({ ev: 'end', symbol: 'SLOW', barsPainted: 50, payloadBars: 50 });
        expect(seen).toHaveLength(2); // exactly one end per start
    });

    it('load:end fires alone (bars: 0) for a failed load and for a parked symbol', async () => {
        const feed = new SwitchFeed();
        feed.failLoads.add('DOWN');
        feed.gatedLoads.add('SLOW');
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        const ends: number[] = [];
        chart.on('load:end', (e) => ends.push(e.bars));

        await expect(chart.setMarket({ symbol: 'DOWN' })).rejects.toThrow();
        expect(ends).toEqual([0]); // the pair still closes — plugins never wait forever

        const pending = chart.setMarket({ symbol: 'SLOW' });
        feed.park('SLOW');
        expect(ends).toEqual([0, 0]); // parked: closed immediately, not when (if) bars arrive
        feed.release();
        await pending;
    });

    it('a depth-only change keeps the bars painted, never raises the affordance, and never re-pushes the series', async () => {
        const feed = new SwitchFeed();
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        renderer.timeline = [];

        await chart.setMarket({ bars: 80 });
        // Same market, deeper: the loaded bars ARE the requested series, so the depth change
        // extends instead of reloading. The feed has nothing older than its 50, so there is
        // nothing to prepend — and therefore no series push at all. A reload here used to hand
        // the renderer the very same 50 bars as a "fresh series", which re-framed the viewport.
        expect(renderer.timeline).toEqual([]);
        expect(renderer.bars).toHaveLength(50); // still painted, never blanked
        expect(renderer.loading).toBe(false);
    });

    it('growing the depth PREPENDS older bars and keeps the view (no fresh-series re-frame)', async () => {
        const feed = new SwitchFeed();
        feed.depth['AAA'] = 400; // deeper history than the first load asks for
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', bars: 50, volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        await chart.historyComplete();
        await flush();
        const firstHead = renderer.bars[0]!.time;
        const newest = renderer.bars[renderer.bars.length - 1]!.time;
        renderer.setBarsCalls = [];

        await chart.setMarket({ bars: 200 });
        await chart.historyComplete();
        await flush();

        expect(renderer.bars.length).toBeGreaterThan(50); // the extra depth arrived…
        expect(renderer.bars[0]!.time).toBeLessThan(firstHead); // …as OLDER bars, prepended
        expect(renderer.bars[renderer.bars.length - 1]!.time).toBe(newest); // newest end untouched
        // EVERY push of the extension preserves the viewport — that is what stops a depth
        // change from throwing the user's zoom away. A reload would have pushed at least one
        // fresh (non-preserving) series first.
        expect(renderer.setBarsCalls.length).toBeGreaterThan(0);
        expect(renderer.setBarsCalls.every((c) => c.preserveView)).toBe(true);
        expect(renderer.loading).toBe(false); // never re-raised: bars stayed on screen throughout
    });

    it('shrinking the depth trims in place, keeping the NEWEST bars and the view', async () => {
        const feed = new SwitchFeed();
        feed.depth['AAA'] = 400;
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', bars: 300, volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();
        await chart.historyComplete();
        await flush();
        const newest = renderer.bars[renderer.bars.length - 1]!.time;
        expect(renderer.bars.length).toBeGreaterThan(100);
        renderer.setBarsCalls = [];

        await chart.setMarket({ bars: 100 });
        await flush();

        expect(renderer.bars).toHaveLength(100);
        expect(renderer.bars[renderer.bars.length - 1]!.time).toBe(newest); // the newest end is kept
        expect(renderer.setBarsCalls).toEqual([{ n: 100, close: renderer.bars[0]!.close, preserveView: true }]);
        expect(renderer.loading).toBe(false);
    });

    it('a failed load still ends the affordance (empty chart, no eternal dots)', async () => {
        const feed = new SwitchFeed();
        feed.failLoads.add('DOWN');
        const renderer = new FakeRenderer();
        const chart = make({ symbol: 'AAA', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await chart.ready();

        await expect(chart.setMarket({ symbol: 'DOWN' })).rejects.toThrow();
        expect(renderer.bars).toEqual([]); // blanked at the switch; nothing came back
        expect(renderer.loading).toBe(false);
    });

    it('a parked load (no venue serves the symbol) drops the affordance instead of promising bars', async () => {
        const feed = new SwitchFeed();
        feed.gatedLoads.add('SLOW');
        const renderer = new FakeRenderer();
        make({ symbol: 'SLOW', timeframe: '60', volume: false }, { renderer, engines: [], dataFeed: feed });
        await flush();
        expect(renderer.loading).toBe(true); // first load in flight

        feed.park('SLOW'); // what MultiProviderFeed reports when nothing can serve the symbol
        expect(renderer.loading).toBe(false);
        expect(renderer.bars).toEqual([]);

        feed.release(); // a provider shows up later — the parked load resumes and paints
        await flush();
        expect(renderer.bars[0]?.close).toBe(PRICE.SLOW);
        expect(renderer.loading).toBe(false);
    });
});
