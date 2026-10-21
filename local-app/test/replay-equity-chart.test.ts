// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EquityPoint } from '../shared/types';
const mocks = vi.hoisted(() => {
    const series = { setData: vi.fn() }, scale = { fitContent: vi.fn() };
    const chart = { addSeries: vi.fn(() => series), applyOptions: vi.fn(), timeScale: () => scale, remove: vi.fn() };
    return { series, scale, chart, engine: { createChart: vi.fn(() => chart), BaselineSeries: {} } };
});
vi.mock('virtual:local-results-chart', () => ({ default: mocks.engine }));
import { mountReplayEquityChart, replayEquityData } from '../client/replay-equity-chart';
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('replay report equity chart', () => {
    it('plots change from initial capital, retains real zero, and deduplicates chronological timestamps', () => {
        const points = [{ time: 3000, equity: 50120 }, { time: 1000, equity: 50000 }, { time: 2000, equity: 49900 }, { time: 3000, equity: 50150 }, { time: 4000, equity: NaN }] as EquityPoint[];
        expect(replayEquityData(points, 50000)).toEqual([{ time: 1, value: 0 }, { time: 2, value: -100 }, { time: 3, value: 150 }]);
    });
    it('uses the actual engine seam and keeps its canvas dimensions in step with its host', () => {
        let resize!: () => void; const disconnect = vi.fn();
        vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect = disconnect; });
        const host = document.createElement('div'); host.innerHTML = '<svg></svg>'; document.body.append(host);
        Object.defineProperties(host, { clientWidth: { value: 850 }, clientHeight: { value: 280 } });
        const dispose = mountReplayEquityChart(host, [{ time: 1000, equity: 50020 }] as EquityPoint[], 50000)!;
        expect(host.querySelector('svg')).toBeNull();
        expect(mocks.engine.createChart).toHaveBeenCalledWith(host, expect.objectContaining({ width: 850, height: 280, layout: expect.objectContaining({ fontSize: 12, attributionLogo: true }) }));
        expect(mocks.chart.addSeries).toHaveBeenCalledWith(mocks.engine.BaselineSeries, expect.objectContaining({ baseValue: { type: 'price', price: 0 }, lineWidth: 2 }));
        expect(mocks.series.setData).toHaveBeenCalledWith([{ time: 1, value: 20 }]);
        resize(); expect(mocks.chart.applyOptions).toHaveBeenCalledWith({ width: 850, height: 280 });
        dispose.destroy(); expect(disconnect).toHaveBeenCalledOnce(); expect(mocks.chart.remove).toHaveBeenCalledOnce();
    });
    it('keeps one chart and observer for a hundred accepted report updates and disposes once', () => {
        const construct = vi.fn(), disconnect = vi.fn();
        vi.stubGlobal('ResizeObserver', class { constructor() { construct(); } observe() {} disconnect = disconnect; });
        const host = document.createElement('div'); document.body.append(host);
        const controller = mountReplayEquityChart(host, [], 50000)!;
        for (let index = 0; index < 100; index++) controller.update([{ time: index * 1000, equity: 50000 + index }] as EquityPoint[], 50000);
        expect(mocks.engine.createChart).toHaveBeenCalledOnce(); expect(mocks.chart.addSeries).toHaveBeenCalledOnce(); expect(construct).toHaveBeenCalledOnce();
        expect(mocks.series.setData).toHaveBeenCalledTimes(101); expect(mocks.series.setData).toHaveBeenLastCalledWith([{ time: 99, value: 99 }]);
        controller.destroy(); controller.destroy(); controller.update([], 50000);
        expect(disconnect).toHaveBeenCalledOnce(); expect(mocks.chart.remove).toHaveBeenCalledOnce(); expect(mocks.series.setData).toHaveBeenCalledTimes(101);
    });
    it('restores the existing SVG if the local engine fails before its chart is ready', () => {
        const host = document.createElement('div'); host.innerHTML = '<svg aria-label="Existing equity curve"></svg>'; const fallback = host.firstChild;
        mocks.engine.createChart.mockImplementationOnce(() => { throw new Error('Unavailable renderer'); });
        expect(mountReplayEquityChart(host, [], 50000)).toBeNull(); expect(host.firstChild).toBe(fallback);
    });
});
