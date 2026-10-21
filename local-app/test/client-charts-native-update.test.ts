import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vela } from '../../src/Vela';
import { NativeRenderer } from '../../src/renderers/native/NativeRenderer';
import { ReplayCharts } from '../client/charts';
import { createSession } from '../engine';
import { DEFAULT_RULES, type Bar, type ChartView, type SessionView } from '../shared/types';
import type { LocalApi } from '../client/api';
import type { MarketConfig } from '../../src/core/options';
import type { ScriptingEngine } from '../../src/core/ports/ScriptingEngine';
import type { OHLCV } from '../../src/core/model/ohlcv';

// Retain native transforms while replacing only browser paint sinks.
class InertNativeRenderer extends NativeRenderer {
    state = this as any;
    override mount(): void {
        this.state.coords.setSize(800, 200, 1);
        this.state.scheduler = { invalidate: vi.fn() };
        this.state.animator = { active: false, stop: vi.fn(), start: vi.fn() };
        this.state.introPlayed = true;
        this.state.scene.ensurePane('price', 'price', 0);
        this.applyFeature('gestureProfile', 'terminal');
    }
    override destroy(): void {}
}

const bars = (start: number, count: number, interval = 60000): Bar[] => Array.from({ length: count }, (_, n) => ({
    time: (start + n + 1) * interval, open: 100, high: 101, low: 99, close: 100 + n / 10000, volume: 1,
}));

function view(): SessionView {
    const instrument = { root: 'NQ', tickSize: 0.25, pointValue: 20 };
    return { session: createSession({ name: 'Synthetic chart', datasetId: 'synthetic', mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 1, rules: { ...DEFAULT_RULES } }, instrument, 'synthetic'),
    dataset: { id: 'synthetic', name: 'Synthetic', symbol: 'NQZ6', schema: 'ohlcv-1m', intervalMs: 60000, instrument,
        barCount: 10000, start: 60000, end: 600000000, source: 'demo', createdAt: '', checksum: '' } };
}

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

async function harness(initial: Bar[], timeframe = '1') {
    const renderer = new InertNativeRenderer();
    const feed = { load: vi.fn(async (market: MarketConfig) => market.data ?? []), subscribe: vi.fn(() => () => {}) };
    const chart = new Vela({} as HTMLElement, { symbol: 'replay:NQZ6', timeframe, data: initial, volume: false, live: false }, { renderer, dataFeed: feed });
    await chart.ready();
    const fixture = view();
    let result: ChartView = { timeframe: timeframe === '5' ? '5m' : '1m', bars: initial, intervalMs: 60000, baseIntervalMs: 60000,
        cursorTime: initial.at(-1)?.time ?? null, hasMore: false };
    const api = { get: vi.fn(async (path: string) => {
        if (path.includes('limit=1&') || path.endsWith('limit=1')) return { ...result, bars: result.bars.slice(-1) };
        return result;
    }) };
    const controller = new ReplayCharts(new EventTarget() as HTMLElement, api as unknown as LocalApi, async () => {}, vi.fn(), vi.fn(), vi.fn());
    const app = controller as any;
    app.workspace = { cells: () => [{ chart }], destroy: () => chart.destroy() };
    app.bars.set(timeframe, initial);
    app.view = fixture;
    const state = renderer.state;
    state.coords.setViewport({ barSpacing: 10.125, rightOffset: 10.25 });
    const pane = state.scene.panes.get('price');
    pane.manualScale = { min: 90, max: 110 };
    pane.scale = { ...pane.manualScale };
    const ownScale = state.scene.ensureIndicatorScale('synthetic-study', pane.scale);
    ownScale.manualScale = { min: 1, max: 3, log: true, invert: true };
    cleanup.push(() => controller.destroy());
    return { chart, renderer, state, pane, ownScale, controller, fixture, feed, api,
        update: async (next: Bar[], hasMore = false, cutoff = next.at(-1)?.time ?? result.cursorTime) => {
            result = { ...result, bars: next, cursorTime: cutoff, hasMore };
            await controller.sync(fixture);
        } };
}

describe('replay refresh through the app, engine and native renderer', () => {
    for (const count of [1, 1000]) it(`preserves fractional zoom, margin and manual main/own scales when revealing ${count} bars`, async () => {
        const h = await harness(bars(0, 200));
        const viewport = { ...h.state.coords.getViewport() };
        const changed = vi.fn(); h.chart.on('market:changed', changed);
        await h.update(bars(0, 200 + count), count > 1);
        expect(h.state.coords.getViewport()).toEqual(viewport);
        expect(h.pane.manualScale).toEqual({ min: 90, max: 110 });
        expect(h.ownScale.manualScale).toEqual({ min: 1, max: 3, log: true, invert: true });
        expect(h.chart.market.offline).toBe(true);
        expect(h.chart.latestBar?.time).toBe((200 + count) * 60000);
        expect(changed).not.toHaveBeenCalled();
        expect(h.feed.load).not.toHaveBeenCalled();
    });

    it('parks historical views by time across a rolling 5000-bar head and a large advance', async () => {
        const h = await harness(bars(0, 5000));
        h.state.coords.setViewport({ barSpacing: 10.125, rightOffset: -60.25 });
        const time = 4950 * 60000;
        const x = h.state.coords.timeToX(time);
        await h.update(bars(1, 5000));
        expect(h.state.coords.timeToX(time)).toBeCloseTo(x, 9);
        await h.update(bars(101, 5000));
        expect(h.state.coords.timeToX(time)).toBeCloseTo(x, 9);
        expect(h.state.coords.getViewport().barSpacing).toBe(10.125);
        expect(h.pane.manualScale).toEqual({ min: 90, max: 110 });
    });

    it('preserves an unchanged aggregate bucket and admits only revealed bars', async () => {
        const initial = bars(0, 200, 300000);
        const h = await harness(initial, '5');
        const viewport = { ...h.state.coords.getViewport() };
        await h.update([{ ...initial.at(-1)!, close: 100.75 }], false, initial.at(-1)!.time + 60000);
        expect(h.state.coords.getViewport()).toEqual(viewport);
        expect(h.chart.latestBar?.close).toBe(100.75);
        expect(h.chart.latestBar?.time).toBe(initial.at(-1)!.time);
        expect(h.pane.manualScale).toEqual({ min: 90, max: 110 });
    });

    it('filters future bars out of a supplied replay answer before handing it to the engine', async () => {
        const h = await harness(bars(0, 200));
        await h.update(bars(0, 250), false, 220 * 60000);
        expect(h.chart.latestBar?.time).toBe(220 * 60000);
        expect(h.state.bars).toHaveLength(220);
        expect(h.state.bars.every((bar: Bar) => bar.time <= 220 * 60000)).toBe(true);
        expect(h.feed.load).not.toHaveBeenCalled();
    });

    it('bounds a historical view when a jump has rolled its entire visible history out', async () => {
        const h = await harness(bars(0, 5000));
        h.state.coords.setViewport({ barSpacing: 10.125, rightOffset: -60.25 });
        await h.update(bars(6000, 5000), true);
        expect(h.state.coords.getViewport()).toEqual({ barSpacing: 10.125, rightOffset: 2 - 5000 });
        expect(h.chart.getVisibleRange()).not.toBeNull();
        expect(h.pane.manualScale).toEqual({ min: 90, max: 110 });
    });

    it('retains a mounted script indicator and its own manual scale while rerunning over the new snapshot', async () => {
        const h = await harness(bars(0, 200));
        h.state.inputsUI = new Proxy({}, { get: () => () => {} });
        h.state.wrapper = { clientWidth: 0, clientHeight: 0 };
        const executions: OHLCV[][] = [];
        const engine: ScriptingEngine = {
            language: 'synthetic', capabilities: { streaming: false, visibleRange: false, inputs: false },
            prepare: async (_source, id) => ({ language: 'synthetic', inputs: [], meta: { title: 'Synthetic', overlay: true }, reactsToViewport: false, token: id }),
            execute: (request, handlers) => {
                const data = request.getBars?.() ?? request.bars;
                executions.push(data);
                const id = String(request.prepared.token);
                handlers.onModel({ id, title: 'Synthetic', overlay: true, ownScale: true, legend: false, paneHint: 'price',
                    series: [{ id: `${id}:line`, title: 'Synthetic', paneId: 'price', kind: 'line', points: data.map(bar => ({ time: bar.time, value: bar.close })), style: { color: '#123456', width: 1, lineStyle: 'solid' } }],
                    fills: [], backgrounds: [], priceLines: [], inputs: [], inputValues: {} });
                handlers.onDone?.();
                return { stop() {}, update() {}, setVisibleRange() {}, notifyBars() {} };
            },
        };
        h.chart.registerEngine('synthetic', engine);
        const handle = h.chart.addIndicator('synthetic', { language: 'synthetic' });
        await new Promise<void>(resolve => handle.on('ready', resolve));
        const own = h.state.scene.ensureIndicatorScale(handle.id, { min: 0, max: 1 });
        own.manualScale = { min: 80, max: 160, log: true, invert: true };
        const viewport = { ...h.state.coords.getViewport() };
        await h.update(bars(0, 201));
        expect(executions.map(data => data.length)).toEqual([200, 201]);
        expect(h.state.scene.indicators.get(handle.id).ownScale).toBe(true);
        expect(h.state.scene.indicatorScales.get(handle.id)).toBe(own);
        expect(own.manualScale).toEqual({ min: 80, max: 160, log: true, invert: true });
        expect(h.pane.manualScale).toEqual({ min: 90, max: 110 });
        expect(h.state.coords.getViewport()).toEqual(viewport);
    });
});
