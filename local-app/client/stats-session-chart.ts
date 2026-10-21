import type { SessionBarsResult } from '@luxalgo/edge-stats/session-bars';
import type { TimelineMark, Vela } from '../../src/index';

export interface StatsSessionChart { destroy(): void }
type ChartModule = Pick<typeof import('../../src/index'), 'Vela'>;

/** The renderer receives only the returned, bounded offline snapshot; it never registers a provider. */
export async function mountStatsSessionChart(host: HTMLElement, session: SessionBarsResult, signal: AbortSignal,
    load: () => Promise<ChartModule> = () => import('../../src/index')): Promise<StatsSessionChart | null> {
    const { Vela: Chart } = await load();
    if (signal.aborted || !host.isConnected) return null;
    let chart: Vela | null = new Chart(host, { data: [...session.context.bars, ...session.bars].map(({ ts, ...bar }) => ({ ...bar, time: ts })),
        symbol: session.symbol, timeframe: '1m', live: false, theme: 'dark', priceStyle: 'candles',
        visibleRange: { from: session.context.bars[0]?.ts ?? session.startTs, to: session.endTs }, animations: false });
    let observer: ResizeObserver | undefined;
    const destroy = (): void => { signal.removeEventListener('abort', abort); observer?.disconnect(); observer = undefined; chart?.destroy(); chart = null; };
    let cancelled!: () => void;
    const stopped = new Promise<void>(resolve => { cancelled = resolve; });
    const abort = (): void => { destroy(); cancelled(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
        await Promise.race([chart.ready(), stopped]);
        if (signal.aborted || !chart || !host.isConnected) { destroy(); return null; }
        chart.drawings.showToolbar(false);
        // Native locks prevent dragging, but settings and history can still change a locked drawing.
        chart.renderer.set({ drawingsInteractive: false, keyboard: false, historyChords: false });
        const line = (label: string, price: number | null, color: string): void => {
            if (price === null || !Number.isFinite(price)) return;
            const drawing = chart!.drawings.add('hline', { anchors: [{ time: session.startTs, price }], style: { lineColor: color, lineWidth: 1 },
                text: { value: label, size: 'small', hAlign: 'right', vAlign: 'top', place: 'end' } });
            if (drawing) chart!.drawings.lock(drawing.id);
        };
        line('Prior high', session.levels.prevHigh, '#dba3f5'); line('Prior low', session.levels.prevLow, '#dba3f5');
        line('Prior close', session.levels.prevClose, '#f5c879'); line('Session open', session.levels.open, '#a3c8ff');
        for (const range of session.levels.openingRanges) { line(`OR ${range.window}m high`, range.high, '#5bd6be'); line(`OR ${range.window}m low`, range.low, '#5bd6be'); }
        if (session.levels.prevClose !== null && session.levels.open !== null && session.levels.prevClose !== session.levels.open) {
            const gap = chart.drawings.add('box', { anchors: [{ time: session.startTs, price: session.levels.prevClose }, { time: session.endTs, price: session.levels.open }],
                style: { lineColor: '#f5c879', lineWidth: 1, fillColor: '#f5c879', fillOpacity: 0.12 } });
            if (gap) chart.drawings.lock(gap.id);
        }
        const marks: TimelineMark[] = [];
        const mark = (label: string, minutes: number | null): void => {
            if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return;
            const time = session.startTs + minutes * 60_000;
            if (time >= session.endTs) return;
            marks.push({ id: `stats-event-${marks.length}`, time, title: label, tooltip: `${label} · ${minutes} minutes after open`,
                glyph: { color: '#7392ff', letter: '•' }, content: { text: `${label}: ${new Date(time).toISOString()}` } });
        };
        mark('Gap fill', session.times.gapFillMin); mark('Prior high touched', session.times.touchPrevHighMin); mark('Prior low touched', session.times.touchPrevLowMin);
        mark('Session high', session.times.highTimeMin); mark('Session low', session.times.lowTimeMin);
        for (const range of session.levels.openingRanges) mark(`OR ${range.window}m first break · ${range.firstBreak}`, range.breakMin);
        chart.marks.set(marks);
        if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(() => chart?.resize()); observer.observe(host); }
        return { destroy };
    } catch (error) { destroy(); if (signal.aborted) return null; throw error; }
}
