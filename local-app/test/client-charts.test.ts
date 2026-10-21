import { describe, expect, it, vi } from 'vitest';
import { createSession } from '../engine/index';
import { DEFAULT_RULES, type ChartView, type SessionView } from '../shared/types';
import type { LocalApi } from '../client/api';
import type { ScriptingEngine } from '../../src/index';
import type { LocalPineEngine } from '../scripting/pine-runtime';
import type { ChartCell } from '../../src/workspace';

const mocks = vi.hoisted(() => ({ instances: [] as unknown[], agentOptions: [] as import('../client/chart-agent').ChartAgentControllerOptions[], scriptWorkspaces: [] as { flush: ReturnType<typeof vi.fn>; prepareForUpdate: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] }));
vi.mock('../client/drawing-favorites', () => ({ mountDrawingFavorites: () => () => undefined }));
vi.mock('../client/drawing-utilities', () => ({ LOCAL_RANGE_PRESETS: [], mountDrawingUtilities: () => () => undefined }));
vi.mock('../client/chart-appearance', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../client/chart-appearance')>();
    return { ...actual, applyLightPlotAppearance: vi.fn(actual.applyLightPlotAppearance) };
});
vi.mock('../client/chart-agent', () => ({ createChartAgentController: (options: import('../client/chart-agent').ChartAgentControllerOptions) => { mocks.agentOptions.push(options); return { dispose: () => undefined }; } }));
vi.mock('../client/script-workspace', () => ({ mountScriptWorkspace: () => {
    const workspace = { flush: vi.fn(async () => {}), prepareForUpdate: vi.fn(async () => {}), busy: () => false, destroy: vi.fn() };
    mocks.scriptWorkspaces.push(workspace); return workspace;
} }));
vi.mock('../../src/workspace', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/workspace')>();
    const { NativeRenderer } = await import('../../src/renderers/native/NativeRenderer');
    const { mergeConfig } = await import('../../src/renderers/native/core/chartConfig');
    const { CHART_THEME } = await import('../client/chart-appearance');
    const initialConfig = (): ReturnType<InstanceType<typeof NativeRenderer>['getConfig']> => {
        const base = new NativeRenderer().getConfig();
        return { ...base,
            layout: { ...base.layout, background: CHART_THEME.background, textColor: CHART_THEME.textColor, fontFamily: CHART_THEME.fontFamily },
            grid: { vertLines: { visible: true, color: CHART_THEME.gridColor }, horzLines: { visible: true, color: CHART_THEME.gridColor } },
            priceScale: { ...base.priceScale, borderColor: CHART_THEME.borderColor }, panes: { separatorColor: CHART_THEME.borderColor },
        };
    };
    class Chart {
        market = { symbol: 'replay:NQZ6', timeframe: '1' };
        nativeDefaultConfig = initialConfig();
        config = structuredClone(this.nativeDefaultConfig);
        drawings: unknown[] = [];
        renderer = { getConfig: () => structuredClone(this.config), applyConfig: (patch: unknown) => { this.config = mergeConfig(this.config, patch); }, set: vi.fn() };
        marks = { defineGroup: vi.fn(), set: vi.fn() };
        engines = new Map<string, ScriptingEngine>();
        registerEngine = vi.fn((language: string, engine: ScriptingEngine) => { this.engines.set(language, engine); });
        listeners = new Map<string, ((value: { symbol: string; timeframe: string }) => void)[]>();
        async setMarket(next: { symbol?: string; timeframe?: string }): Promise<void> {
            Object.assign(this.market, { ...(next.symbol ? { symbol: next.symbol } : {}), ...(next.timeframe ? { timeframe: next.timeframe } : {}) });
            for (const callback of this.listeners.get('load:start') ?? []) callback(this.market);
            await Promise.resolve();
        }
        on(event: string, callback: (value: { symbol: string; timeframe: string }) => void): () => void {
            this.listeners.set(event, [...this.listeners.get(event) ?? [], callback]);
            return () => this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== callback));
        }
        getVisibleRange(): null { return null; }
        setVisibleRange(): void {}
    }
    const createCell = (id: string) => {
        let prefs: ReturnType<ChartCell['statusPrefs']> = { parts: null, indicatorTitles: true, indicatorValues: true, watermark: true, replayWatermark: true };
        return { id, chart: new Chart(), setStatuslineAppearance: vi.fn(), setExternalReplaying: vi.fn(), statusPrefs: () => prefs, applyStatusPrefs: (value: typeof prefs) => { prefs = value; } };
    };
    class Workspace {
        active = createCell('cell');
        members = new Map([[this.active.id, this.active]]);
        pool = new Map<string, { config: unknown; drawings: unknown[]; prefs: ReturnType<ChartCell['statusPrefs']> }>();
        createdCharts = [this.active.chart];
        events = new Map<string, (() => void)[]>();
        layout = { id: '1' };
        sync = { get: () => false };
        keymap = { activeScope: 'chart', handleKeydown: vi.fn(() => false) };
        constructor(_host: unknown, readonly options: unknown) { actual.registerBuiltinLayouts(); mocks.instances.push(this); }
        get chart(): Chart { return this.active.chart; }
        cells(): typeof this.active[] { return [...this.members.values()]; }
        cell(id: string): typeof this.active | undefined { return this.members.get(id); }
        on(event: string, callback: () => void): () => void {
            this.events.set(event, [...this.events.get(event) ?? [], callback]);
            return () => this.events.set(event, (this.events.get(event) ?? []).filter((item) => item !== callback));
        }
        applyState(state?: { layout: string; charts: { id: string }[] }): void {
            if (!state) return;
            const incoming = new Set(state.charts.map((chart) => chart.id));
            for (const id of this.pool.keys()) if (!incoming.has(id)) this.pool.delete(id);
        }
        setLayout(id: string): void {
            this.layout.id = id;
            const count = id === '4' ? 4 : 1;
            for (const [cellId] of this.members) if (cellId !== 'cell' && count === 1) {
                const cell = this.members.get(cellId)!;
                this.pool.set(cellId, { config: cell.chart.renderer.getConfig(), drawings: structuredClone(cell.chart.drawings), prefs: structuredClone(cell.statusPrefs()) });
                this.members.delete(cellId); for (const callback of this.events.get('cell:destroyed') ?? []) callback();
            }
            for (let index = 1; index < count; index++) if (!this.members.has(`extra${index}`)) {
                const cell = createCell(`extra${index}`); const { chart } = cell; this.createdCharts.push(chart);
                const pooled = this.pool.get(cell.id);
                if (pooled) { chart.renderer.applyConfig(pooled.config); chart.drawings = structuredClone(pooled.drawings); cell.applyStatusPrefs(pooled.prefs); this.pool.delete(cell.id); }
                this.members.set(cell.id, cell);
                for (const callback of this.events.get('cell:created') ?? []) callback();
            }
        }
        getState(): unknown { return { version: 1, layout: this.layout.id, charts: [{ id: 'cell', ...this.chart.market }] }; }
        destroy(): void {}
    }
    return { ...actual, VelaWorkspace: Workspace, sanitizeState: () => null };
});

import { ReplayCharts } from '../client/charts';

function fixture(): SessionView {
    const instrument = { root: 'NQ', tickSize: 0.25, pointValue: 20 };
    return { session: createSession({ name: 'Chart concurrency', datasetId: 'data', mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 1, rules: { ...DEFAULT_RULES } }, instrument, 'chart-test'),
    dataset: { id: 'data', name: 'Test', symbol: 'NQZ6', schema: 'ohlcv-1m', intervalMs: 60000, instrument,
        barCount: 100, start: 60000, end: 6000000, source: 'demo', createdAt: '', checksum: '' } };
}

function response(timeframe: string): ChartView {
    const close = timeframe === '1m' ? 100 : timeframe === '5m' ? 500 : 1500;
    return { timeframe, bars: [{ time: 60000, open: close, high: close + 1, low: close - 1, close, volume: 1 }],
        intervalMs: 60000, baseIntervalMs: 60000, cursorTime: 60123, hasMore: false };
}

describe('replay chart public seam', () => {
    it('applies the light appearance to every untouched cell added by grid expansion', async () => {
        const get = vi.fn(async (path: string) => response(new URL(path, 'http://local').searchParams.get('timeframe')!));
        const controller = new ReplayCharts(new EventTarget() as HTMLElement, { get } as unknown as LocalApi, async () => {}, vi.fn(), vi.fn(), vi.fn());
        try {
            await controller.mount(fixture()); await controller.setLayout('4');
            const workspace = mocks.instances.at(-1) as { cells(): { chart: { renderer: { getConfig(): { layout: unknown; grid: unknown }; set: ReturnType<typeof vi.fn> } }; statusPrefs(): unknown }[] };
            expect(workspace.cells()).toHaveLength(4);
            for (const cell of workspace.cells()) {
                expect(cell.chart.renderer.getConfig()).toMatchObject({ layout: { background: '#ffffff', backgroundGradient: { topColor: '#ffffff', bottomColor: '#d9d9d9' } },
                    grid: { vertLines: { visible: false }, horzLines: { visible: false } } });
                expect(cell.statusPrefs()).toMatchObject({ watermark: false, replayWatermark: false });
                expect(cell.chart.renderer.set).toHaveBeenCalledWith('gestureProfile', 'terminal');
                expect(cell.chart.renderer.set).toHaveBeenCalledWith('candleRasterization', 'terminal');
                expect(cell.chart.renderer.set).toHaveBeenCalledWith('axisRendering', 'terminal');
            }
        } finally { controller.destroy(); }
    });
    it('retains pooled custom appearance, intentional native defaults and drawings when cells return', async () => {
        const get = vi.fn(async (path: string) => response(new URL(path, 'http://local').searchParams.get('timeframe')!));
        const controller = new ReplayCharts(new EventTarget() as HTMLElement, { get } as unknown as LocalApi, async () => {}, vi.fn(), vi.fn(), vi.fn());
        try {
            await controller.mount(fixture()); await controller.setLayout('4');
            type TestChart = { nativeDefaultConfig: unknown; drawings: unknown[]; renderer: { getConfig(): unknown; applyConfig(value: unknown): void; set: ReturnType<typeof vi.fn> } };
            const workspace = mocks.instances.at(-1) as { cell(id: string): { chart: TestChart } };
            const custom = workspace.cell('extra1').chart; const original = workspace.cell('extra2').chart;
            custom.renderer.applyConfig({ layout: { background: '#203040' }, candles: { upColor: '#abcdef' } });
            custom.drawings = [{ id: 'retained-line', anchors: [{ time: 60000, price: 100 }] }];
            original.renderer.applyConfig(original.nativeDefaultConfig);
            const customBefore = custom.renderer.getConfig(); const originalBefore = original.renderer.getConfig();
            await controller.setLayout('1'); await controller.setLayout('4');
            expect(workspace.cell('extra1').chart).not.toBe(custom);
            expect(workspace.cell('extra1').chart.renderer.getConfig()).toEqual(customBefore);
            expect(workspace.cell('extra1').chart.drawings).toEqual(custom.drawings);
            expect(workspace.cell('extra2').chart.renderer.getConfig()).toEqual(originalBefore);
            expect(workspace.cell('extra1').chart.renderer.set).toHaveBeenCalledWith('gestureProfile', 'terminal');
            expect(workspace.cell('extra2').chart.renderer.set).toHaveBeenCalledWith('gestureProfile', 'terminal');
            expect(workspace.cell('extra1').chart.renderer.set).toHaveBeenCalledWith('candleRasterization', 'terminal');
            expect(workspace.cell('extra2').chart.renderer.set).toHaveBeenCalledWith('candleRasterization', 'terminal');
            expect(workspace.cell('extra1').chart.renderer.set).toHaveBeenCalledWith('axisRendering', 'terminal');
            expect(workspace.cell('extra2').chart.renderer.set).toHaveBeenCalledWith('axisRendering', 'terminal');
        } finally { controller.destroy(); }
    });
    it('initializes newly minted cell IDs again after a workspace template replaces the old pool', async () => {
        const get = vi.fn(async (path: string) => response(new URL(path, 'http://local').searchParams.get('timeframe')!));
        const controller = new ReplayCharts(new EventTarget() as HTMLElement, { get } as unknown as LocalApi, async () => {}, vi.fn(), vi.fn(), vi.fn());
        try {
            await controller.mount(fixture()); await controller.setLayout('4'); await controller.setLayout('1');
            await (controller as unknown as { applyTemplate(state: unknown): Promise<void> }).applyTemplate({ version: 1, layout: '1', charts: [{ id: 'cell', timeframe: '1' }] });
            await controller.setLayout('4');
            const workspace = mocks.instances.at(-1) as { cell(id: string): { chart: { renderer: { getConfig(): unknown } } } };
            expect(workspace.cell('extra1').chart.renderer.getConfig()).toMatchObject({ layout: { background: '#ffffff', backgroundGradient: { bottomColor: '#d9d9d9' } } });
        } finally { controller.destroy(); }
    });
    it('publishes paused manual changes to AI and tester callbacks without reloading candles', async () => {
        const initial = fixture(); const get = vi.fn(async () => response('1m'));
        const controller = new ReplayCharts(new EventTarget() as HTMLElement, { get } as unknown as LocalApi, async () => {}, vi.fn(), vi.fn(), vi.fn());
        try {
            await controller.mount(initial);
            const calls = get.mock.calls.length;
            const updated = { ...initial, session: { ...initial.session, revision: initial.session.revision + 1,
                account: { ...initial.session.account, equity: 49950 }, bookmarks: [{ id: 'paused-note', time: 60000, label: 'Updated without advancing' }] } };
            controller.updateMarkers(updated);
            const bridge = mocks.agentOptions.at(-1)!;
            expect(bridge.session()).toBe(updated);
            expect(await bridge.appContext!.readSession()).toMatchObject({ session: { revision: updated.session.revision }, account: { equity: 49950 }, bookmarks: { items: [{ id: 'paused-note' }] } });
            controller.updateMarkers(initial);
            expect(bridge.session()).toBe(updated);
            expect(get).toHaveBeenCalledTimes(calls);
        } finally { controller.destroy(); }
    });
    it('supplies the same complete primary futures metadata as the backtest gateway', async () => {
        const view = fixture();
        const get = vi.fn(async (path: string) => response(new URL(path, 'http://local').searchParams.get('timeframe')!));
        const controller = new ReplayCharts(new EventTarget() as HTMLElement, { get } as unknown as LocalApi, async () => {}, vi.fn(), vi.fn(), vi.fn());
        try {
            await controller.mount(view);
            const workspace = mocks.instances.at(-1) as { options: { providers: { replay: () => { getSymbolInfo(): Promise<Record<string, unknown>> } } } };
            expect(await workspace.options.providers.replay().getSymbolInfo()).toEqual({
                ticker: 'NQZ6', symbol: 'NQZ6', tickerid: 'replay:NQZ6', main_tickerid: 'replay:NQZ6',
                description: 'NQZ6', prefix: 'CME', root: 'NQ', type: 'futures', currency: 'USD',
                timezone: 'America/Chicago', session: 'extended', mintick: 0.25, minmove: 1, pointvalue: 20, pricescale: 4,
            });
        } finally { controller.destroy(); }
    });
    it('registers an isolated Pine engine per cell and disposes it as each cell leaves the workspace', async () => {
        const get = vi.fn(async (path: string) => response(new URL(path, 'http://local').searchParams.get('timeframe')!));
        const controller = new ReplayCharts(new EventTarget() as HTMLElement, { get } as unknown as LocalApi, async () => {}, vi.fn(), vi.fn(), vi.fn());
        try {
            await controller.mount(fixture());
            const workspace = mocks.instances.at(-1) as { createdCharts: { engines: Map<string, LocalPineEngine>; registerEngine: ReturnType<typeof vi.fn> }[] };
            const first = workspace.createdCharts[0]!; const firstEngine = first.engines.get('pine')!;
            expect(first.registerEngine).toHaveBeenCalledExactlyOnceWith('pine', firstEngine); expect(firstEngine.language).toBe('pine');
            const firstDispose = vi.spyOn(firstEngine, 'dispose');
            await controller.setLayout('4');
            const extras = workspace.createdCharts.slice(1); expect(extras).toHaveLength(3);
            const dispose = extras.map(chart => { const engine = chart.engines.get('pine')!; expect(engine).not.toBe(firstEngine); expect(chart.registerEngine).toHaveBeenCalledExactlyOnceWith('pine', engine); return vi.spyOn(engine, 'dispose'); });
            await controller.setLayout('1'); dispose.forEach(check => expect(check).toHaveBeenCalledOnce()); expect(firstDispose).not.toHaveBeenCalled();
            await controller.prepareForUpdate(); expect(mocks.scriptWorkspaces.at(-1)!.prepareForUpdate).toHaveBeenCalledOnce();
            controller.destroy(); expect(firstDispose).toHaveBeenCalledOnce(); expect(mocks.scriptWorkspaces.at(-1)!.destroy).toHaveBeenCalledOnce();
        } finally { controller.destroy(); }
    });
    it('flushes a fresh snapshot before either debounce expires and waits for durable persistence', async () => {
        vi.useFakeTimers();
        let finish: () => void = () => undefined;
        const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
        const get = vi.fn(async (path: string) => response(new URL(path, 'http://local').searchParams.get('timeframe')!));
        const controller = new ReplayCharts(new EventTarget() as HTMLElement, { get } as unknown as LocalApi,
            save, vi.fn(), vi.fn(), vi.fn());
        try {
            await controller.mount(fixture());
            await controller.setLayout('4');
            const workspace = mocks.instances.at(-1) as { events: Map<string, (() => void)[]> };
            for (const callback of workspace.events.get('state:changed') ?? []) callback();
            let persisted = false;
            const flush = controller.flush().then(() => { persisted = true; });
            await vi.advanceTimersByTimeAsync(0);
            expect(save).toHaveBeenCalledOnce();
            expect(persisted).toBe(false);
            finish(); await flush;
            await vi.advanceTimersByTimeAsync(1000);
            expect(save).toHaveBeenCalledOnce();
            expect(persisted).toBe(true);
        } finally { controller.destroy(); vi.useRealTimers(); }
    });
    it('rejects a failed chart save so the runtime cannot acknowledge an unsaved update', async () => {
        const get = vi.fn(async (path: string) => response(new URL(path, 'http://local').searchParams.get('timeframe')!));
        const controller = new ReplayCharts(new EventTarget() as HTMLElement, { get } as unknown as LocalApi,
            async () => { throw new Error('CAS conflict'); }, vi.fn(), vi.fn(), vi.fn());
        try {
            await controller.mount(fixture());
            await controller.setLayout('4');
            await expect(controller.flush()).rejects.toThrow('CAS conflict');
        } finally { controller.destroy(); }
    });
    it('saves a fresh layout once and does not repeat a clean snapshot after another window may have advanced its revision', async () => {
        const get = vi.fn(async (path: string) => response(new URL(path, 'http://local').searchParams.get('timeframe')!));
        const save = vi.fn(async () => undefined);
        const controller = new ReplayCharts(new EventTarget() as HTMLElement, { get } as unknown as LocalApi,
            save, vi.fn(), vi.fn(), vi.fn());
        try {
            await controller.mount(fixture());
            await controller.flush(); await controller.flush();
            expect(save).toHaveBeenCalledOnce();
            await controller.setLayout('4'); await controller.flush();
            expect(save).toHaveBeenCalledTimes(2);
            await controller.flush(); expect(save).toHaveBeenCalledTimes(2);
        } finally { controller.destroy(); }
    });
    it('keeps the latest timeframe selection when an earlier chart response is delayed', async () => {
        let release: (value: ChartView) => void = () => undefined;
        let started: () => void = () => undefined;
        const pending = new Promise<void>((resolve) => { started = resolve; });
        let delay = false;
        const get = vi.fn(async (path: string): Promise<ChartView> => {
            const timeframe = new URL(path, 'http://local').searchParams.get('timeframe')!;
            if (delay && timeframe === '5m') { delay = false; started(); return new Promise((resolve) => { release = resolve; }); }
            return response(timeframe);
        });
        const prices = vi.fn();
        const controller = new ReplayCharts(new EventTarget() as HTMLElement, { get } as unknown as LocalApi,
            async () => undefined, vi.fn(), vi.fn(), prices);
        try {
            const view = fixture(); await controller.mount(view); await controller.setTimeframe('5');
            delay = true; const oldSync = controller.sync(view); await pending;
            const selection = controller.setTimeframe('15');
            release(response('5m'));
            await Promise.all([oldSync, selection]);
            expect(controller.timeframe).toBe('15');
            expect(controller.lastPrice).toBe(100);
            expect(controller.cursorTime).toBe(60123);
            expect(prices).toHaveBeenLastCalledWith(100, 60123);
            expect(get.mock.calls.some(([path]) => path.includes('timeframe=15m'))).toBe(true);
        } finally { controller.destroy(); }
    });
    it('rechecks an AI task after queued chart work, before changing its timeframe', async () => {
        let release!: (value: ChartView) => void;
        let started!: () => void;
        const pending = new Promise<void>(resolve => { started = resolve; });
        let delay = false;
        const get = vi.fn(async (path: string): Promise<ChartView> => {
            const timeframe = new URL(path, 'http://local').searchParams.get('timeframe')!;
            if (delay) { delay = false; started(); return new Promise(resolve => { release = resolve; }); }
            return response(timeframe);
        });
        const controller = new ReplayCharts(new EventTarget() as HTMLElement, { get } as unknown as LocalApi,
            async () => undefined, vi.fn(), vi.fn(), vi.fn());
        try {
            const view = fixture(); await controller.mount(view);
            delay = true; const sync = controller.sync(view); await pending;
            const assertCurrent = vi.fn(() => { throw new Error('Chart request expired or workspace blocked'); });
            const selection = controller.setTimeframe('15', 'cell', assertCurrent);
            const rejected = expect(selection).rejects.toThrow('expired or workspace blocked');
            release(response('1m')); await sync; await rejected;
            expect(assertCurrent).toHaveBeenCalledOnce(); expect(controller.timeframe).toBe('1');
            expect(get.mock.calls.some(([path]) => path.includes('timeframe=15m'))).toBe(false);
        } finally { controller.destroy(); }
    });
    it('restores unsupported native market changes through the public chart seam', async () => {
        const get = vi.fn(async (path: string) => response(new URL(path, 'http://local').searchParams.get('timeframe')!));
        const errors = vi.fn();
        const controller = new ReplayCharts(new EventTarget() as HTMLElement, { get } as unknown as LocalApi,
            async () => undefined, errors, vi.fn(), vi.fn());
        try {
            const view = fixture(); await controller.mount(view);
            const workspace = mocks.instances.at(-1) as { chart: { setMarket: (next: { symbol: string; timeframe: string }) => Promise<void> }; options: { bottombar?: boolean; topbar?: { left: string[] } } };
            await workspace.chart.setMarket({ symbol: 'other:SYMBOL', timeframe: '1S' });
            await controller.sync(view);
            expect(controller.timeframe).toBe('1');
            expect(controller.snapshot()?.charts[0]?.symbol).toBe('replay:NQZ6');
            expect(get.mock.calls.every(([path]) => !path.includes('timeframe=1s'))).toBe(true);
            expect(errors).toHaveBeenCalledOnce();
            expect(workspace.options.bottombar).toBeUndefined();
            expect(workspace.options.topbar).toEqual({
                left: ['symbol', 'timeframes', 'style', 'indicators', 'local.templatesShortcut', 'alerts', 'local.replayToggle', 'undo-redo'],
                right: ['local.chart-mode', 'local.backtest-mode', 'layout', 'local.fullscreen', 'screenshot', 'local.tradeShortcut', 'local.sessions', 'panels'],
            });
        } finally { controller.destroy(); }
    });
    it('removes chart watchers immediately across repeated layout changes', async () => {
        const get = vi.fn(async (path: string) => response(new URL(path, 'http://local').searchParams.get('timeframe')!));
        const host = new EventTarget();
        const controller = new ReplayCharts(host as HTMLElement, { get } as unknown as LocalApi,
            async () => undefined, vi.fn(), vi.fn(), vi.fn());
        await controller.mount(fixture());
        const workspace = mocks.instances.at(-1) as { createdCharts: { listeners: Map<string, unknown[]> }[] };
        const subscriptions = (): number => workspace.createdCharts.reduce((count, chart) => count + (chart.listeners.get('load:start')?.length ?? 0), 0);
        try {
            for (let index = 0; index < 12; index++) {
                await controller.setLayout('4'); expect(subscriptions()).toBe(4);
                await controller.setLayout('1'); expect(subscriptions()).toBe(1);
            }
            const bubble = vi.fn(); host.addEventListener('keydown', bubble);
            const key = (value: string, alt = false): Event => Object.assign(new Event('keydown', { cancelable: true }), { key: value, ctrlKey: false, metaKey: false, altKey: alt });
            const digit = key('2'); host.dispatchEvent(digit);
            expect(digit.defaultPrevented).toBe(true); expect(bubble).not.toHaveBeenCalled();
            host.dispatchEvent(key('t', true)); expect(bubble).toHaveBeenCalledOnce();
        } finally { controller.destroy(); }
        expect(subscriptions()).toBe(0);
    });
});
