import resultsChart from 'virtual:local-results-chart';
import type { EquityPoint } from '../shared/types';

interface Series { setData(data: { time: number; value: number }[]): void }
interface Chart {
    addSeries(definition: unknown, options: Record<string, unknown>): Series;
    applyOptions(options: Record<string, unknown>): void;
    timeScale(): { fitContent(): void };
    remove(): void;
}
interface ChartEngine {
    createChart(host: HTMLElement, options: Record<string, unknown>): Chart;
    BaselineSeries: unknown;
}
export interface ReplayEquityChart {
    update(points: readonly EquityPoint[], initialBalance: number): void;
    destroy(): void;
}

export function replayEquityData(points: readonly EquityPoint[], initialBalance: number): { time: number; value: number }[] {
    const data = new Map<number, number>();
    for (const point of points) {
        if (Number.isFinite(point.time) && Number.isFinite(point.equity)) data.set(point.time / 1000, point.equity - initialBalance);
    }
    return [...data].sort(([a], [b]) => a - b).map(([time, value]) => ({ time, value }));
}

/** The report chart uses the admitted static engine while its ledger stays local. */
export function mountReplayEquityChart(host: HTMLElement, points: readonly EquityPoint[], initialBalance: number): ReplayEquityChart | null {
    if (!resultsChart || typeof resultsChart !== 'object') return null;
    const engine = resultsChart as unknown as ChartEngine;
    if (typeof engine.createChart !== 'function' || !engine.BaselineSeries) return null;
    const fallback = [...host.childNodes];
    host.replaceChildren();
    let chart: Chart | undefined;
    let observer: ResizeObserver | undefined;
    let series: Series | undefined;
    const update = (points: readonly EquityPoint[], initialBalance: number): void => {
        if (!chart || !series) return;
        series.setData(replayEquityData(points, initialBalance)); chart.timeScale().fitContent();
    };
    try {
        chart = engine.createChart(host, {
            width: host.clientWidth, height: host.clientHeight || 280,
            grid: { horzLines: { visible: true, color: '#2e2e2e' }, vertLines: { visible: false } },
            layout: { background: { type: 'solid', color: '#0f0f0f' }, textColor: '#b8b8b8', fontSize: 12,
                fontFamily: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif', attributionLogo: true },
            timeScale: { timeVisible: true, secondsVisible: true, borderVisible: false, fixLeftEdge: true, fixRightEdge: true,
                lockVisibleTimeRangeOnResize: true, minBarSpacing: 4, barSpacing: 21 },
            leftPriceScale: { visible: false },
            rightPriceScale: { visible: true, scaleMargins: { top: 0, bottom: 0 }, borderVisible: false, entireTextOnly: true, minimumWidth: 80 },
            crosshair: { mode: 0, horzLine: { visible: false, labelVisible: false }, vertLine: { labelVisible: false, style: 0, color: '#4a4a4a' } },
            handleScale: false, handleScroll: false,
        });
        series = chart.addSeries(engine.BaselineSeries, {
            baseValue: { type: 'price', price: 0 }, lineWidth: 2,
            topLineColor: '#089981', bottomLineColor: '#f23645',
            topFillColor1: 'rgba(34,171,148,.05)', topFillColor2: 'rgba(34,171,148,.05)',
            bottomFillColor1: 'rgba(247,124,128,.05)', bottomFillColor2: 'rgba(247,124,128,.05)',
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: true, crosshairMarkerBorderWidth: 3,
        });
        update(points, initialBalance);
        observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
            if (host.clientWidth && host.clientHeight) chart?.applyOptions({ width: host.clientWidth, height: host.clientHeight });
        });
        observer?.observe(host);
    } catch {
        observer?.disconnect(); chart?.remove(); host.replaceChildren(...fallback); return null;
    }
    return { update, destroy: () => { if (!chart) return; observer?.disconnect(); chart.remove(); chart = undefined; series = undefined; } };
}
