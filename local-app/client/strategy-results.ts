import './strategy-results.css';
import {
    aggregatePeriods, analyzeStrategy, distribution, runMonteCarlo, strategyMetricsCsv, strategyTradesCsv,
    type StrategyResultsSnapshot, type StrategyAnalysis, type PerformanceMetrics,
    type EquityPoint, type DistributionBin, type MonteCarloResult, type PeriodInterval, type PeriodPerformance,
} from '../shared/strategy-analysis';
import { escapeHtml } from './util';

export type { StrategyResultsSnapshot } from '../shared/strategy-analysis';
export interface StrategyResultsOptions { onGoToTrade?: (time: number) => void }
export interface StrategyResultsController { update(snapshot: StrategyResultsSnapshot): void; destroy(): void }

type Tab = 'performance' | 'trades' | 'simulation';
type SortKey = 'index' | 'entryTime' | 'exitTime' | 'exitPrice' | 'qty' | 'pnl' | 'cumulativePnl' | 'commission' | 'durationMs' | 'mae' | 'mfe';
interface TradeRow {
    index: number; id: string; side: string; open: boolean; qty: number | null;
    entryTime: number | null; exitTime: number | null; entryPrice: number | null; exitPrice: number | null;
    pnl: number | null; cumulativePnl: number | null; commission: number | null;
    durationMs: number | null; mae: number | null; mfe: number | null; search: string;
    entrySignal: string; exitSignal: string;
}
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const escape = escapeHtml;
const finite = (value: number | null | undefined): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const fmt = (value: number | null | undefined): string => finite(value) === null ? '—' : numberFormat.format(Math.abs(value!) < .005 ? 0 : value!);
const pct = (value: number | null | undefined): string => finite(value) === null || !Number.isFinite(value! * 100) ? '—' : `${fmt(value! * 100)}%`;
const tone = (value: number | null | undefined): string => value != null && value >= .005 ? 'sr-positive' : value != null && value <= -.005 ? 'sr-negative' : '';
function date(value: number | null | undefined, full = false): string {
    if (finite(value) === null || !Number.isFinite(new Date(value!).getTime())) return '—';
    return new Date(value!).toISOString().replace('T', ' ').slice(0, full ? 19 : 10);
}
function duration(value: number | null | undefined): string {
    if (finite(value) === null || value! < 0) return '—';
    if (value! < 1000) return `${fmt(value)} ms`;
    if (value! < 60_000) return `${fmt(value! / 1000)} s`;
    if (value! < 3_600_000) return `${fmt(value! / 60_000)} min`;
    if (value! < 86_400_000) return `${fmt(value! / 3_600_000)} h`;
    return `${fmt(value! / 86_400_000)} d`;
}
function card(label: string, value: string, note = '', className = ''): string {
    return `<div class="sr-kpi"><span>${escape(label)}</span><strong class="${className}">${escape(value)}</strong>${note ? `<small>${escape(note)}</small>` : ''}</div>`;
}
function empty(message: string): string { return `<p class="sr-empty">${escape(message)}</p>`; }

/** Preserve extrema while keeping SVG work independent of the full history length. */
function chartPoints(points: readonly EquityPoint[], limit = 360): EquityPoint[] {
    const valid = points.filter(p => finite(p.time) !== null && finite(p.value) !== null);
    if (valid.length <= limit) return valid;
    const sampled: EquityPoint[] = [valid[0]!];
    const size = Math.ceil(valid.length / ((limit - 2) / 2));
    for (let i = 1; i < valid.length - 1; i += size) {
        let low = i; let high = i;
        for (let j = i; j < Math.min(i + size, valid.length - 1); j++) {
            if (valid[j]!.value < valid[low]!.value) low = j;
            if (valid[j]!.value > valid[high]!.value) high = j;
        }
        for (const at of [...new Set([low, high])].sort((a, b) => a - b)) sampled.push(valid[at]!);
    }
    sampled.push(valid[valid.length - 1]!);
    return sampled;
}
function lineChart(series: { label: string; points: readonly EquityPoint[]; className?: string }[], timeAxis = true, detail?: (point: EquityPoint) => string): string {
    const lines = series.map(s => ({ ...s, points: chartPoints(s.points) }));
    const all = lines.flatMap(s => s.points);
    if (!all.length) return empty('No finite equity observations are available.');
    let min = Infinity; let max = -Infinity; let first = Infinity; let last = -Infinity;
    for (const point of all) { min = Math.min(min, point.value); max = Math.max(max, point.value); first = Math.min(first, point.time); last = Math.max(last, point.time); }
    const spread = max - min || Math.max(1, Math.abs(min) * .01);
    if (!Number.isFinite(spread)) return empty('The observations exceed a finite chart range.');
    const x = (time: number) => 76 + (time - first) / (last - first || 1) * 684;
    const y = (value: number) => 174 - (value - min) / spread * 150;
    const grid = [0, .5, 1].map(f => `<line x1="76" x2="760" y1="${24 + 150 * f}" y2="${24 + 150 * f}"/><text x="68" y="${28 + 150 * f}" text-anchor="end">${escape(fmt(max - (max - min) * f))}</text>`).join('');
    const paths = lines.map(s => `<path class="sr-line ${s.className ?? ''}" d="${s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(2)},${y(p.value).toFixed(2)}`).join(' ')}"/>${s.points.map(p => `<circle class="sr-hover-point" cx="${x(p.time)}" cy="${y(p.value)}" r="5"><title>${escape(detail?.(p) ?? `${timeAxis ? date(p.time, true) : fmt(p.time)} · ${s.label}: ${fmt(p.value)}`)}</title></circle>`).join('')}`).join('');
    return `<svg class="sr-chart" viewBox="0 0 800 205" role="img" aria-label="${escape(series.map(s => s.label).join(', '))}"><g class="sr-grid">${grid}</g>${paths}<g class="sr-axis"><text x="76" y="198">${escape(timeAxis ? date(first) : fmt(first))}</text><text x="760" y="198" text-anchor="end">${escape(timeAxis ? date(last) : fmt(last))}</text></g></svg><div class="sr-legend">${lines.map(s => `<span class="${s.className ?? ''}">━ ${escape(s.label)}</span>`).join('')}</div>`;
}
function barChart(items: { label: string; axisLabel?: string; value: number | null; count?: number; className?: string; detail?: string }[], label: string): string {
    if (!items.length) return empty('No closed-trade observations are available.');
    const values = items.map(p => finite(p.value));
    let low = 0; let high = 0;
    for (const value of values) if (value !== null) { low = Math.min(low, value); high = Math.max(high, value); }
    const spread = high - low || 1;
    if (!Number.isFinite(spread)) return empty('The observations exceed a finite chart range.');
    const zero = 172 - (0 - low) / spread * 144;
    const width = 684 / items.length;
    return `<svg class="sr-chart" viewBox="0 0 800 205" role="img" aria-label="${escape(label)}"><g class="sr-grid"><line x1="76" x2="760" y1="${zero}" y2="${zero}"/><text x="68" y="25" text-anchor="end">${escape(fmt(high))}</text><text x="68" y="176" text-anchor="end">${escape(fmt(low))}</text></g>${items.map((p, i) => {
        const value = values[i]; if (value === null || value === undefined) return '';
        const y = 172 - (value - low) / spread * 144;
        return `<rect class="${p.className ?? (value >= 0 ? 'sr-bar-up' : 'sr-bar-down')}" x="${76 + i * width + width * .12}" y="${Math.min(zero, y)}" width="${Math.max(.25, width * .76)}" height="${value === 0 ? 0 : Math.max(1, Math.abs(zero - y))}"><title>${escape(p.label)}: ${escape(fmt(value))}${p.count === undefined ? '' : ` · ${p.count} observations`}${p.detail ? ` · ${escape(p.detail)}` : ''}</title></rect>`;
    }).join('')}<g class="sr-axis">${items.filter((_, i) => items.length <= 8 || i === 0 || i === items.length - 1 || i === Math.floor(items.length / 2)).map(p => `<text x="${76 + items.indexOf(p) * width + width / 2}" y="196" text-anchor="${items.length > 1 && p === items[0] ? 'start' : items.length > 1 && p === items.at(-1) ? 'end' : 'middle'}">${escape(p.axisLabel ?? p.label)}</text>`).join('')}</g></svg>`;
}
function histogram(bins: readonly DistributionBin[], valueLabel: string): string {
    return barChart(bins.map(b => ({ label: `${fmt(b.from)} … ${fmt(b.to)}`, value: b.count })), valueLabel);
}
function sampleBins(values: readonly number[]): DistributionBin[] {
    return distribution(values, 16);
}
function segmented(control: string, choices: readonly (readonly [string, string])[], selected: string): string {
    return `<div class="sr-segments" role="group">${choices.map(([value, label]) => `<button type="button" data-section="${control}" data-value="${value}" aria-pressed="${value === selected}">${label}</button>`).join('')}</div>`;
}
function comparison(items: readonly { label: string; positive: number | null; negative: number | null; net?: number | null }[], count = false): string {
    if (!items.some(item => item.positive !== null || item.negative !== null)) return empty('No reported observations are available.');
    return barChart(items.flatMap(item => [
        { label: `${item.label} · ${count ? 'Winning trades' : 'Positive net outcomes'}`, axisLabel: item.label, value: item.positive, className: 'sr-bar-up' },
        { label: `${item.label} · ${count ? 'Losing trades' : 'Negative net outcomes'}`, axisLabel: item.label, value: item.negative === null ? null : count ? item.negative : -item.negative, className: 'sr-bar-down' },
        ...(item.net === undefined ? [] : [{ label: `${item.label} · Net P&L`, axisLabel: item.label, value: item.net, className: 'sr-bar-net' }]),
    ]), count ? 'Winning and losing trades by entry time' : 'Positive net outcomes, negative net outcomes and net P&L');
}
function outcomeDonut(a: StrategyAnalysis): string {
    const parts = [{ label: 'Winning', count: a.all.wins, className: 'sr-bar-up' }, { label: 'Losing', count: a.all.losses, className: 'sr-bar-down' }, { label: 'Breakeven', count: a.all.even, className: 'sr-bar-even' }, { label: 'Unavailable', count: a.unknownPnlTrades, className: 'sr-bar-unknown' }];
    const total = a.all.count; if (!total) return empty('No closed trades.');
    let offset = 0;
    return `<div class="sr-outcome-chart"><svg viewBox="0 0 160 160" role="img" aria-label="Closed-trade outcome counts"><g transform="rotate(-90 80 80)">${parts.map(part => { const share = part.count / total * 100; const start = offset; offset += share; return `<circle class="${part.className}" cx="80" cy="80" r="60" pathLength="100" fill="none" stroke-width="18" stroke-dasharray="${share} ${100 - share}" stroke-dashoffset="${-start}"><title>${part.label}: ${part.count} (${pct(part.count / total)})</title></circle>`; }).join('')}</g><text x="80" y="78" text-anchor="middle" class="sr-donut-total">${fmt(total)}</text><text x="80" y="99" text-anchor="middle">closed trades</text></svg><div class="sr-outcome-legend">${parts.filter(part => part.count || part.label !== 'Unavailable').map(part => `<div><span class="${part.className}">●</span> ${part.label}<strong>${fmt(part.count)} <small>${pct(part.count / total)}</small></strong></div>`).join('')}</div></div>`;
}
function downloadCsv(value: string, name: string): void {
    const url = URL.createObjectURL(new Blob([value], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => { URL.revokeObjectURL(url); }, 0);
}
function scatter(analysis: StrategyAnalysis): string {
    const valid = analysis.closedTrades.filter(t => t.durationMs !== null && t.pnl !== null);
    if (!valid.length) return empty('Trade duration and net P&L are required for this view.');
    const points = valid.filter((_, i) => i % Math.max(1, Math.ceil(valid.length / 300)) === 0);
    let maxDuration = 1; let low = 0; let high = 0;
    for (const t of valid) { maxDuration = Math.max(maxDuration, t.durationMs!); low = Math.min(low, t.pnl!); high = Math.max(high, t.pnl!); }
    const spread = high - low || 1;
    if (!Number.isFinite(spread)) return empty('The observations exceed a finite chart range.');
    return `<svg class="sr-chart" viewBox="0 0 800 205" role="img" aria-label="Elapsed trade duration versus net P&amp;L"><g class="sr-grid"><line x1="76" x2="760" y1="${172 - (0 - low) / spread * 144}" y2="${172 - (0 - low) / spread * 144}"/><text x="68" y="28" text-anchor="end">${escape(fmt(high))}</text><text x="68" y="176" text-anchor="end">${escape(fmt(low))}</text></g>${points.map(t => `<circle class="${t.pnl! >= 0 ? 'sr-bar-up' : 'sr-bar-down'}" cx="${76 + t.durationMs! / maxDuration * 684}" cy="${172 - (t.pnl! - low) / spread * 144}" r="3"><title>${escape(t.id)} · ${escape(duration(t.durationMs))} · ${escape(fmt(t.pnl))}</title></circle>`).join('')}<g class="sr-axis"><text x="76" y="198">0 s</text><text x="760" y="198" text-anchor="end">${escape(duration(maxDuration))}</text></g></svg><p class="sr-note">Elapsed clock time, including session gaps. ${points.length} of ${valid.length} trades plotted.</p>`;
}
function metricsTable(analysis: StrategyAnalysis, rows: { label: string; key: keyof PerformanceMetrics; format?: (value: number | null) => string }[]): string {
    return `<div class="sr-table-scroll"><table class="sr-table sr-metrics"><thead><tr><th scope="col">Metric</th>${(['All', 'Long', 'Short'] as const).map((label, index) => `<th scope="col">${label}${[analysis.all, analysis.long, analysis.short][index]!.complete ? '' : ' (known subset)'}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${escape(row.label)}</th>${[analysis.all, analysis.long, analysis.short].map(m => `<td>${escape((row.format ?? fmt)(m[row.key] as number | null))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
let instanceCounter = 0;

/** Local viewer of the engine's reported ledger. Mounting never changes chart or account state. */
export function mountStrategyResults(host: HTMLElement, options: StrategyResultsOptions = {}): StrategyResultsController {
    const root = document.createElement('section');
    root.className = 'strategy-results'; root.setAttribute('aria-label', 'Strategy backtest results');
    const id = `strategy-results-${++instanceCounter}`;
    root.innerHTML = `<header class="sr-header"><h2>Strategy report</h2><p class="sr-context">Run a strategy to review its results.</p></header><div class="sr-toolbar"><div class="sr-tabs" role="tablist" aria-label="Backtest views">${([['performance', 'Report'], ['trades', 'List of trades']] as const).map(([key, label]) => `<button type="button" role="tab" id="${id}-${key}" aria-controls="${id}-panel" data-tab="${key}" aria-selected="${key === 'performance'}" tabindex="${key === 'performance' ? '0' : '-1'}"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="${key === 'performance' ? 'M3 14V9h2v5M8 14V4h2v10M13 14V7h2v7' : 'M3 4h2m2 0h8M3 9h2m2 0h8M3 14h2m2 0h8'}"/></svg>${label}</button>`).join('')}</div><div class="sr-actions"><button type="button" data-action="export-csv" disabled>Export metrics CSV</button><details class="sr-more"><summary aria-label="More report tools">More ···</summary><button type="button" data-tab="simulation" id="${id}-simulation">Simulation</button></details></div></div><div class="sr-warnings" aria-live="polite"></div><div class="sr-content" id="${id}-panel" role="tabpanel" aria-labelledby="${id}-performance">${empty('Run a strategy to populate this viewer.')}</div>`;
    host.append(root);
    const content = root.querySelector<HTMLElement>('.sr-content')!;
    content.tabIndex = -1;
    let snapshot: StrategyResultsSnapshot | null = null; let analysis: StrategyAnalysis | null = null;
    let tab: Tab = 'performance'; let destroyed = false; let rows: TradeRow[] = [];
    let sort: SortKey = 'index'; let ascending = true; let page = 0; let pageSize = 25;
    let query = ''; let direction = 'all'; let outcome = 'all'; let view = 'list'; let selectedDay = ''; let month = '';
    let performanceView = 'breakdown'; let analysisView = 'distribution'; let periodInterval: PeriodInterval = 'day';
    let streakUnit = 'count'; let patternUnit: 'hour' | 'weekday' | 'month' = 'hour'; let curveMode = 'equity'; let curveUnit = 'currency';
    let simulation: MonteCarloResult | null = null; let abort: AbortController | null = null; let generation = 0;
    const simulationSettings = { mode: 'resample', runs: '500', seed: '42', ruinThreshold: '0' };

    function fitChartLabels(): void {
        for (const chart of content.querySelectorAll<SVGSVGElement>('.sr-chart')) {
            if (typeof chart.getScreenCTM !== 'function' || !chart.getBoundingClientRect().width) continue;
            const transform = chart.getScreenCTM();
            if (!transform) continue;
            const scale = Math.hypot(transform.a, transform.b);
            if (!Number.isFinite(scale) || scale <= 0) continue;
            // SVG viewBox scaling also scales text; keep labels readable at the rendered size.
            for (const label of chart.querySelectorAll<SVGTextElement>('text')) label.style.fontSize = `${11 / scale}px`;
            const ticks = [...chart.querySelectorAll<SVGTextElement>('.sr-axis text')];
            for (const tick of ticks) tick.style.display = '';
            let previous = ticks[0]?.getBoundingClientRect();
            const last = ticks.at(-1)?.getBoundingClientRect();
            for (const tick of ticks.slice(1, -1)) {
                const bounds = tick.getBoundingClientRect();
                if (previous && last && (bounds.left < previous.right + 8 || bounds.right > last.left - 8)) tick.style.display = 'none';
                else previous = bounds;
            }
        }
    }
    const chartMutations = new MutationObserver(fitChartLabels);
    chartMutations.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    const chartResize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitChartLabels);
    chartResize?.observe(root);

    function cancelSimulation(): void { generation++; abort?.abort(); abort = null; }
    function preserveFocus(render: () => void): void {
        const active = document.activeElement;
        const focused = active instanceof HTMLElement && root.contains(active) ? active : null;
        const identity = focused ? ['control', 'sort', 'action', 'day', 'section', 'value', 'tab', 'go'].filter(key => focused.dataset[key] !== undefined)
            .map(key => [key, focused.dataset[key]] as const) : [];
        const disclosure = focused?.matches('summary') && focused.parentElement instanceof HTMLDetailsElement ? focused.parentElement : null;
        const disclosureOpen = disclosure?.open;
        const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
            ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null;
        render();
        if (!focused || document.activeElement === focused && root.contains(focused) && !focused.matches(':disabled')) return;
        const replacement = [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, summary')].find(element => {
            if (element.tagName !== focused.tagName || element.matches(':disabled') || element.closest('[hidden]')) return false;
            if (focused.id) return element.id === focused.id;
            if (identity.length) return identity.every(([key, value]) => element.dataset[key] === value);
            if (focused.getAttribute('name')) return element.getAttribute('name') === focused.getAttribute('name');
            return disclosure && element.parentElement?.className === disclosure.className
                && (disclosure.classList.contains('sr-calculation-notes') || element.textContent === focused.textContent);
        });
        if (replacement?.parentElement instanceof HTMLDetailsElement && disclosureOpen !== undefined) replacement.parentElement.open = disclosureOpen;
        (replacement ?? root.querySelector<HTMLElement>('[role="tab"][tabindex="0"]') ?? content).focus({ preventScroll: true });
        if (selection?.start != null && selection.end != null && (replacement instanceof HTMLInputElement || replacement instanceof HTMLTextAreaElement)) {
            replacement.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
        }
    }
    function summary(): string {
        const account = analysis!.account;
        const count = account.wins !== null && account.losses !== null && account.even !== null ? account.wins + account.losses + account.even : null;
        const rate = count && account.wins !== null ? account.wins / count : null;
        const factor = account.grossProfit !== null && account.grossLoss !== null && account.grossLoss > 0 ? account.grossProfit / account.grossLoss : null;
        const capital = account.initialCapital;
        return card('Total P&L', fmt(account.netPnl), capital !== null && capital > 0 && account.netPnl !== null ? `${pct(account.netPnl / capital)} · engine realized` : 'Engine realized · account currency', tone(account.netPnl))
            + card('Max drawdown', fmt(account.maxDrawdown), 'Engine account equity', tone(account.maxDrawdown === null ? null : -account.maxDrawdown))
            + card('Profitable trades', pct(rate), `${fmt(account.wins)} / ${fmt(count)} engine closed trades`)
            + card('Profit factor', fmt(factor), 'Engine gross profit / gross loss');
    }
    function renderPerformance(): void {
        const a = analysis!; const actual = a.equity.source === 'actual'; const capital = a.account.initialCapital;
        if (!(capital !== null && capital > 0)) curveUnit = 'currency';
        const points = (curveMode === 'drawdown' ? a.equity.drawdown : a.equity.points).map(point => ({ ...point, value: curveUnit === 'percent' ? (curveMode === 'drawdown' ? point.value : point.value - capital!) / capital! * 100 : point.value }));
        const label = `${actual ? 'Reported account' : 'Closed-trade'} ${curveMode === 'drawdown' ? 'drawdown' : 'equity'}${curveUnit === 'percent' ? ' (%)' : ''}`;
        const basis = curveMode === 'drawdown' ? `Drawdown from observed peak${curveUnit === 'percent' ? ' / initial capital, in percent.' : ', in account currency.'}`
            : curveUnit === 'percent' ? 'Equity change from initial capital / initial capital, in percent.' : 'Account equity level, including initial capital, in account currency.';
        const sampled = chartPoints(points);
        const coverage = points.length ? `${fmt(points.length)} ${actual ? 'supplied observations' : 'closed-trade equity observations'}; ${fmt(sampled.length)} plotted${sampled.length < points.length ? ' as an extrema sample across the supplied history' : ''}. ${date(points[0]!.time, true)} UTC — ${date(points.at(-1)!.time, true)} UTC.` : 'No finite equity observations are available.';
        const atTime = new Map(a.closedTrades.map(trade => [trade.exitTime, trade]));
        content.innerHTML = `<section class="sr-overview"><div class="sr-section-heading"><h3>Metrics</h3><span>Account currency</span></div><div class="sr-summary">${summary()}</div><div class="sr-curve-toolbar"><strong>${escape(label)}</strong><div><label>Curve<select data-control="curve-mode"><option value="equity" ${curveMode === 'equity' ? 'selected' : ''}>Equity</option><option value="drawdown" ${curveMode === 'drawdown' ? 'selected' : ''}>Drawdown</option></select></label><label>Unit<select data-control="curve-unit"><option value="currency">Currency</option>${capital !== null && capital > 0 ? `<option value="percent" ${curveUnit === 'percent' ? 'selected' : ''}>% of initial capital</option>` : ''}</select></label></div></div>${lineChart([{ label, points, className: curveMode === 'drawdown' ? 'sr-negative' : '' }], true, point => {
            const trade = atTime.get(point.time);
            return `${date(point.time, true)} UTC · ${label}: ${fmt(point.value)}${trade ? ` · Trade ${trade.index + 1} · ${trade.side} · Cumulative P&L ${fmt(trade.cumulativePnl)}` : ''}`;
        })}<p class="sr-note sr-curve-basis">${escape(basis)}</p><p class="sr-note sr-curve-coverage">${escape(coverage)}</p><p class="sr-note">${actual ? 'Runtime equity observations; sampled history can miss intrabar extremes.' : 'Closed-trade equity · initial capital plus reported realized P&L. Open-position and intrabar changes are excluded.'}${a.equity.complete ? '' : ' Incomplete curve coverage.'} Engine account drawdown is a separate metric.</p></section><section class="sr-report-section"><div class="sr-section-heading"><h3>Performance analysis</h3></div>${segmented('performance', [['breakdown', 'Breakdown'], ['periodical', 'Periodical'], ['growth', 'Growth and decline']], performanceView)}<div class="sr-performance-analysis"></div><details class="sr-detail-table"><summary>Performance metrics · All / Long / Short</summary>${metricsTable(a, [
            { label: 'Net P&L after reported commission', key: 'netPnl' }, { label: 'Positive net outcomes', key: 'grossProfit' }, { label: 'Negative net outcomes (magnitude)', key: 'grossLoss' },
            { label: 'Profit factor', key: 'profitFactor' }, { label: 'Profitable trades', key: 'winRate', format: pct }, { label: 'Return on initial capital', key: 'returnPct', format: pct },
            { label: 'Reported commission', key: 'commission' }, { label: 'Closed trades', key: 'count' }, { label: 'Trades with reported P&L', key: 'knownPnlCount' },
            { label: 'Trades with unavailable P&L', key: 'unknownPnlCount' }, { label: 'Closed-equity max drawdown', key: 'maxDrawdown' }, { label: 'Closed-equity max drawdown / peak', key: 'maxDrawdownPct', format: pct }, { label: 'Average net P&L', key: 'averagePnl' },
        ])}<p class="sr-note">Trade P&L already includes commission. Directional closed-equity metrics use the same initial capital. A dash means unavailable or undefined.</p></details></section><section class="sr-report-section"><div class="sr-section-heading"><h3>Trades analysis</h3></div>${segmented('analysis', [['distribution', 'Distribution'], ['streaks', 'Streaks'], ['time', 'Time patterns']], analysisView)}<div class="sr-trade-analysis"></div><details class="sr-detail-table"><summary>Detailed trade statistics</summary>${metricsTable(a, [
            { label: 'Closed trades', key: 'count' }, { label: 'Winning trades', key: 'wins' }, { label: 'Losing trades', key: 'losses' }, { label: 'Breakeven trades', key: 'even' },
            { label: 'Profitable trades', key: 'winRate', format: pct }, { label: 'Average net P&L', key: 'averagePnl' }, { label: 'Average winning trade', key: 'averageWin' }, { label: 'Average losing trade (magnitude)', key: 'averageLoss' },
            { label: 'Largest winning trade', key: 'largestWin' }, { label: 'Largest losing trade (magnitude)', key: 'largestLoss' }, { label: 'Average elapsed duration', key: 'averageDurationMs', format: duration },
            { label: 'Median elapsed duration', key: 'medianDurationMs', format: duration }, { label: 'Average winning duration', key: 'averageWinDurationMs', format: duration }, { label: 'Average losing duration', key: 'averageLossDurationMs', format: duration },
            { label: 'Shortest elapsed duration', key: 'minDurationMs', format: duration }, { label: 'Longest elapsed duration', key: 'maxDurationMs', format: duration }, { label: 'Longest consecutive losing streak (trades)', key: 'maxLossStreak' },
        ])}<div class="sr-two-charts"><section class="sr-block"><h4>Elapsed duration vs. net P&L</h4>${scatter(a)}</section><section class="sr-block"><h4>Elapsed duration distribution</h4>${barChart(a.durationDistribution.map(bin => ({ label: `${duration(bin.from)} · ${duration(bin.to)}`, value: bin.count })), 'Elapsed trade duration distribution')}</section></div></details></section>`;
        renderPerformanceSection(); renderAnalysis();
    }
    function renderPerformanceSection(): void {
        const a = analysis!; const target = content.querySelector<HTMLElement>('.sr-performance-analysis'); if (!target) return;
        if (performanceView === 'breakdown') {
            target.innerHTML = comparison([a.all, a.long, a.short].map((metrics, index) => ({ label: ['All', 'Long', 'Short'][index]!, positive: metrics.complete ? metrics.grossProfit : null, negative: metrics.complete ? metrics.grossLoss : null, net: metrics.complete ? metrics.netPnl : null }))) + '<div class="sr-legend"><span>· Positive net outcomes</span><span class="sr-negative">· Negative net outcomes</span><span class="sr-net">· Net P&L</span></div><p class="sr-note">Closed-trade results after reported commission. Unavailable outcomes prevent a complete group total.</p>';
        } else if (performanceView === 'periodical') {
            const periods = aggregatePeriods(a.closedTrades, periodInterval); const shown = periods.slice(-90);
            target.innerHTML = `<div class="sr-section-controls"><label>Period<select data-control="period-interval">${(['day', 'week', 'month', 'quarter', 'year'] as const).map(value => `<option value="${value}" ${value === periodInterval ? 'selected' : ''}>${({ day: 'Daily', week: 'Weekly', month: 'Monthly', quarter: 'Quarterly', year: 'Yearly' })[value]}</option>`).join('')}</select></label></div>${barChart(shown.map(period => ({ label: period.label, value: period.pnl, count: period.count, detail: `Largest reported trade run-up ${fmt(period.largestRunup)}; drawdown ${fmt(period.largestDrawdown)}` })), 'Periodical realized net P&L')}<p class="sr-note">UTC exit dates · weeks begin Monday. Most recent ${shown.length} of ${periods.length} active periods. Unknown P&L makes that period unavailable.</p>`;
        } else {
            const phases = a.equityPhases.slice(-120); const growth = a.equityPhases.filter(phase => phase.direction === 'growth'); const decline = a.equityPhases.filter(phase => phase.direction === 'decline');
            const largest = (items: typeof phases) => items.length ? items.reduce((maximum, phase) => Math.max(maximum, phase.amount), 0) : null;
            target.innerHTML = `<div class="sr-mini-summary">${card('Largest observed growth', fmt(largest(growth)))}${card('Largest observed decline', fmt(largest(decline)))}${card('Observed growth periods', fmt(growth.length))}${card('Observed decline periods', fmt(decline.length))}</div>${barChart(phases.map(phase => ({ label: `${date(phase.from)} · ${date(phase.to)}`, axisLabel: date(phase.from), value: phase.direction === 'growth' ? phase.amount : -phase.amount, count: phase.observations })), 'Observed equity growth and decline periods')}<p class="sr-note">${a.equity.source === 'actual' ? 'Supplied account-equity samples' : 'Closed-trade equity'} only. Consecutive increasing/decreasing observations form a period; flat observations extend its elapsed time. This is not a historical intrabar run-up or margin series. Most recent ${phases.length} periods.</p>`;
        }
    }
    function renderAnalysis(): void {
        const a = analysis!; const target = content.querySelector<HTMLElement>('.sr-trade-analysis'); if (!target) return;
        if (analysisView === 'distribution') {
            const bins = a.pnlDistribution; const low = bins[0]?.from ?? 0; const high = bins.at(-1)?.to ?? 0;
            let chart = barChart(bins.map(bin => ({ label: `${fmt(bin.from)} · ${fmt(bin.to)}`, value: bin.count, className: bin.to <= 0 && bin.from < 0 ? 'sr-bar-down' : 'sr-bar-up' })), 'Closed-trade net P&L distribution');
            if (high > low) chart = chart.replace('</svg>', `<g class="sr-average-markers">${[{ value: a.all.averageWin, label: 'Average win' }, { value: a.all.averageLoss === null ? null : -a.all.averageLoss, label: 'Average loss' }].flatMap(marker => marker.value === null ? [] : [`<line x1="${76 + (marker.value - low) / (high - low) * 684}" x2="${76 + (marker.value - low) / (high - low) * 684}" y1="20" y2="174"><title>${marker.label}: ${fmt(marker.value)}</title></line>`]).join('')}</g></svg>`);
            target.innerHTML = `<div class="sr-mini-summary">${card('Expected payoff', fmt(a.all.averagePnl), 'Average reported trade')}${card('Largest profit', fmt(a.all.largestWin), '', 'sr-positive')}${card('Largest loss', fmt(a.all.largestLoss), 'Magnitude', 'sr-negative')}${card('Average elapsed duration', duration(a.all.averageDurationMs), 'Clock time, including gaps')}</div><div class="sr-distribution-row"><div>${chart}<p class="sr-note">Net P&L ranges · heights count reported trades. Dashed markers show average win/loss.</p></div>${outcomeDonut(a)}</div>`;
        } else if (analysisView === 'streaks') {
            const streaks = a.streaks.slice(-120); const maximum = (outcome: 'win' | 'loss') => a.streaks.filter(streak => streak.outcome === outcome).reduce((max, streak) => Math.max(max, streak.count), 0);
            target.innerHTML = `<div class="sr-section-controls">${segmented('streak-unit', [['count', 'Trade count'], ['amount', 'Net P&L']], streakUnit)}</div><div class="sr-mini-summary">${card('Longest winning streak', a.all.knownPnlCount ? fmt(maximum('win')) : '—', 'Known sequence')}${card('Longest losing streak', a.all.knownPnlCount ? fmt(maximum('loss')) : '—', 'Known sequence')}</div>${barChart(streaks.map(streak => ({ label: `Trades ${streak.firstTrade}—${streak.lastTrade}`, axisLabel: `#${streak.firstTrade}`, value: streakUnit === 'amount' ? streak.pnl : streak.outcome === 'loss' ? -streak.count : streak.count, className: streak.outcome === 'even' ? 'sr-bar-even' : streak.outcome === 'win' ? 'sr-bar-up' : 'sr-bar-down', count: streak.count })), 'Consecutive trade streaks')}<p class="sr-note">Exit-time ledger order · an unknown result or inconsistent fill time breaks a sequence. Breakeven forms its own sequence. Most recent ${streaks.length} streaks.</p>`;
        } else {
            const best = (periods: PeriodPerformance[]): string => {
                const sorted = periods.filter(period => period.count > period.unknownPnlCount).sort((a, b) => b.wins / (b.count - b.unknownPnlCount) - a.wins / (a.count - a.unknownPnlCount) || b.count - a.count || a.time - b.time);
                const first = sorted[0]; return first ? `${first.label} · ${pct(first.wins / (first.count - first.unknownPnlCount))}` : '—';
            };
            const groups = a.entryPatterns[patternUnit];
            target.innerHTML = `<div class="sr-mini-summary">${card('Best entry hour', best(a.entryPatterns.hour), 'Highest known win rate · UTC')}${card('Best entry weekday', best(a.entryPatterns.weekday), 'Highest known win rate · UTC')}${card('Best entry month', best(a.entryPatterns.month), 'Highest known win rate · UTC')}${card('Average elapsed duration', duration(a.all.averageDurationMs), 'Clock time; not bars')}</div><div class="sr-section-controls">${segmented('pattern-unit', [['hour', 'Hour'], ['weekday', 'Day of week'], ['month', 'Month']], patternUnit)}</div>${comparison(groups.map(group => ({ label: group.label, positive: group.wins, negative: group.losses })), true)}<div class="sr-legend"><span>· Winning trades</span><span class="sr-negative">· Losing trades</span></div><p class="sr-note">Grouped by ENTRY time in UTC, independently of exit date. Breakeven/unknown outcomes are excluded from win/loss bars; win rates use known results. ${a.closedTrades.filter(trade => trade.entryTime === null).length} unavailable entry times omitted.</p>`;
        }
    }
    function filteredRows(): TradeRow[] {
        return rows.filter(row => (direction === 'all' || row.side === direction) && (!query || row.search.includes(query.toLowerCase()))
            && (!selectedDay || date(row.exitTime) === selectedDay)
            && (outcome === 'all' || (outcome === 'open' ? row.open : outcome === 'unknown' ? row.pnl === null && !row.open : outcome === 'wins' ? !row.open && row.pnl !== null && row.pnl > 0 : outcome === 'losses' ? !row.open && row.pnl !== null && row.pnl < 0 : !row.open && row.pnl === 0)));
    }
    function compareRows(a: TradeRow, b: TradeRow): number {
        const av = a[sort]; const bv = b[sort];
        if (av === null) return bv === null ? a.index - b.index : 1;
        if (bv === null) return -1;
        return (ascending ? av - bv : bv - av) || a.index - b.index;
    }
    function renderLog(): void {
        content.innerHTML = `<div class="sr-log-toolbar"><label>Direction<select data-control="direction"><option value="all">All trades</option><option value="long">Long</option><option value="short">Short</option></select></label><label>Outcome<select data-control="outcome"><option value="all">All outcomes</option><option value="wins">Winners</option><option value="losses">Losers</option><option value="even">Breakeven</option><option value="open">Open</option><option value="unknown">Unavailable P&L</option></select></label><label class="sr-search">Search trades<input data-control="query" type="search" placeholder="Trade / order ID or comment" value="${escape(query)}"></label><label>Exit date (UTC)<input type="date" data-control="day" value="${escape(selectedDay)}"></label><label>View<select data-control="view"><option value="list">Trade list</option><option value="calendar">Calendar</option></select></label></div><div class="sr-log-results"></div>`;
        for (const [name, value] of [['direction', direction], ['outcome', outcome], ['view', view]]) content.querySelector<HTMLSelectElement>(`[data-control="${name}"]`)!.value = value!;
        renderLogResults();
    }
    function renderCalendar(target: HTMLElement, filtered: TradeRow[]): void {
        const validMonth = /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
        const start = new Date(`${validMonth}-01T00:00:00Z`);
        if (!Number.isFinite(start.getTime())) { target.innerHTML = empty('Select a valid month.'); return; }
        const days = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
        const byDate = new Map<string, { pnl: number; count: number; wins: number; unknown: boolean }>();
        for (const row of filtered) {
            if (row.open || row.exitTime === null) continue;
            const key = date(row.exitTime); if (!key.startsWith(validMonth)) continue;
            const cell = byDate.get(key) ?? { pnl: 0, count: 0, wins: 0, unknown: false };
            cell.count++; if (row.pnl === null) cell.unknown = true; else { cell.pnl += row.pnl; if (row.pnl > 0) cell.wins++; } byDate.set(key, cell);
        }
        const entries = [...byDate.values()]; const monthPnl = entries.length && !entries.some(p => p.unknown) ? entries.reduce((sum, p) => sum + p.pnl, 0) : null;
        const knownDays = [...byDate.entries()].filter(([, p]) => !p.unknown).sort((a, b) => a[1].pnl - b[1].pnl);
        target.innerHTML = `<div class="sr-calendar-toolbar"><button type="button" data-action="month-prev" aria-label="Previous month">‹</button><label>Month (UTC)<input type="month" data-control="month" value="${escape(validMonth)}"></label><button type="button" data-action="month-next" aria-label="Next month">›</button><span>Calendar follows the trade filters.</span></div><div class="sr-calendar" role="group" aria-label="Daily closed-trade results">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => `<div class="sr-calendar-weekday">${day}</div>`).join('')}${'<div class="sr-calendar-blank"></div>'.repeat(start.getUTCDay())}${Array.from({ length: days }, (_, i) => {
            const key = `${validMonth}-${String(i + 1).padStart(2, '0')}`; const p = byDate.get(key);
            return `<button type="button" class="sr-calendar-day ${p ? tone(p.unknown ? null : p.pnl) : ''}" data-day="${key}" ${p ? '' : 'disabled'} aria-label="${key}${p ? `, ${p.count} trades, P&L ${escape(p.unknown ? 'unavailable' : fmt(p.pnl))}` : ', no closed trades'}"><span>${i + 1}</span>${p ? `<strong>${p.unknown ? '—' : fmt(p.pnl)}</strong><small>${p.count} trades · ${p.unknown ? '—' : pct(p.wins / p.count)} wins</small>` : '<small>No trades</small>'}</button>`;
        }).join('')}</div><div class="sr-mini-summary">${card('Month net P&L', fmt(monthPnl), '', tone(monthPnl))}${card('Best reported day', knownDays.length ? `${knownDays.at(-1)![0]} · ${fmt(knownDays.at(-1)![1].pnl)}` : '—')}${card('Worst reported day', knownDays.length ? `${knownDays[0]![0]} · ${fmt(knownDays[0]![1].pnl)}` : '—')}${card('Trades / active day', entries.length ? fmt(entries.reduce((sum, p) => sum + p.count, 0) / entries.length) : '—')}</div><p class="sr-note">Daily results use official net P&L at exit in UTC. Empty dates have no reported closed trades. Partial months and filters limit the comparison.</p>`;
    }
    function renderLogResults(): void {
        const target = content.querySelector<HTMLElement>('.sr-log-results'); if (!target) return;
        const filtered = filteredRows(); if (view === 'calendar') { renderCalendar(target, filtered); return; }
        filtered.sort(compareRows);
        const pages = Math.max(1, Math.ceil(filtered.length / pageSize)); page = Math.min(page, pages - 1);
        const columns: [SortKey | null, string][] = [['index', 'Trade #'], [null, 'Type'], ['exitTime', 'Date/time · UTC'], [null, 'Signal'], ['exitPrice', 'Price'], ['qty', 'Position size'], ['pnl', 'Net P&L'], ['mfe', 'Run-up'], ['mae', 'Drawdown'], ['cumulativePnl', 'Cumulative P&L']];
        const fillTime = (time: number | null, entry: boolean) => time === null ? '—' : `<button type="button" data-go="${time}" ${options.onGoToTrade ? '' : 'disabled'} title="Go to ${entry ? 'entry' : 'exit'} on chart">${date(time, true)}</button>`;
        target.innerHTML = `<div class="sr-table-scroll"><table class="sr-table sr-log"><thead><tr>${columns.map(([key, label]) => `<th scope="col" ${key ? `aria-sort="${sort === key ? ascending ? 'ascending' : 'descending' : 'none'}"` : ''}>${key ? `<button type="button" data-sort="${key}">${label}${sort === key ? ascending ? ' ↑' : ' ↓' : ''}</button>` : label}</th>`).join('')}</tr></thead><tbody>${filtered.slice(page * pageSize, (page + 1) * pageSize).map(row => `<tr data-fill="exit" data-trade="${row.index}"><th scope="rowgroup" rowspan="2"><span>${row.index + 1}</span><small title="${escape(row.id)}">${escape(row.id)}</small></th><td><span class="sr-side sr-${row.side}">${row.open ? 'Open' : 'Exit'} ${escape(row.side)}</span></td><td>${row.open ? '<span class="sr-open">Open</span>' : fillTime(row.exitTime, false)}</td><td class="sr-signal" title="${escape(row.exitSignal)}">${row.open ? 'Open' : escape(row.exitSignal)}</td><td>${row.open ? '—' : fmt(row.exitPrice)}</td><td rowspan="2" data-field="qty">${fmt(row.qty)}</td><td rowspan="2" data-field="pnl" class="${tone(row.pnl)}">${fmt(row.pnl)}</td><td rowspan="2" data-field="mfe" class="${tone(row.mfe)}">${fmt(row.mfe)}</td><td rowspan="2" data-field="mae" class="${row.mae ? 'sr-negative' : ''}">${row.mae === null ? '—' : fmt(-row.mae)}</td><td rowspan="2" data-field="cumulativePnl" class="${tone(row.cumulativePnl)}">${fmt(row.cumulativePnl)}</td></tr><tr data-fill="entry" data-trade="${row.index}"><td><span class="sr-side sr-${row.side}">Entry ${escape(row.side)}</span></td><td>${fillTime(row.entryTime, true)}</td><td class="sr-signal" title="${escape(row.entrySignal)}">${escape(row.entrySignal)}</td><td>${fmt(row.entryPrice)}</td></tr>`).join('') || '<tr><td colspan="10">No trades match these filters.</td></tr>'}</tbody></table></div><div class="sr-pagination"><span>${fmt(filtered.length)} trades · page ${page + 1} / ${pages}</span><label>Rows<select data-control="page-size">${[25, 50, 100].map(n => `<option value="${n}" ${n === pageSize ? 'selected' : ''}>${n}</option>`).join('')}</select></label><button type="button" data-action="page-prev" ${page === 0 ? 'disabled' : ''}>Previous</button><button type="button" data-action="page-next" ${page >= pages - 1 ? 'disabled' : ''}>Next</button></div><details class="sr-detail-table sr-note"><summary>Trade list calculations</summary><p>Account currency · exit then entry. Net P&L already includes reported commission. Run-up uses reported MFE; drawdown displays reported MAE as a negative amount. Cumulative P&L follows the original exit sequence when sorting/filtering. Open rows have no realized P&L. CSV includes both fills plus commission and elapsed duration; unsupported percentages and position notionals are not inferred.</p></details>`;
    }
    function renderSimulation(): void {
        content.innerHTML = `<form class="sr-simulation-form"><label>Method<select name="mode"><option value="resample">Resample with replacement</option><option value="shuffle">Shuffle without replacement</option></select></label><label>Runs (1–1000)<input name="runs" type="number" min="1" max="1000" step="1" value="${escape(simulationSettings.runs)}" required></label><label>Random seed<input name="seed" maxlength="120" value="${escape(simulationSettings.seed)}" required></label><label>Ruin equity threshold<input name="ruinThreshold" type="number" step="any" value="${escape(simulationSettings.ruinThreshold)}" required></label><button type="submit" class="sr-run">Run simulation</button><button type="button" data-action="cancel-simulation" hidden>Cancel</button></form><p class="sr-note">Replays reported closed-trade outcomes with fixed sizing and no added fees or price model. Maximum 1000 runs × 5000 trades. Ruin means equity reaches or crosses the selected account-currency threshold at any point. Starting capital: ${fmt(analysis!.account.initialCapital)}.</p><p class="sr-sim-status" role="status" aria-live="polite"></p><div class="sr-sim-results"></div>`;
        content.querySelector<HTMLSelectElement>('[name="mode"]')!.value = simulationSettings.mode;
        renderSimulationResults();
    }
    function renderSimulationResults(): void {
        const target = content.querySelector<HTMLElement>('.sr-sim-results'); if (!target) return;
        const result = simulation;
        if (!result) { target.innerHTML = empty('Choose a seed and run the observed trade ledger to explore sequencing and sampling risk.'); return; }
        target.innerHTML = `<div class="sr-mini-summary">${card('Final equity · P5', fmt(result.finalP5))}${card('Final equity · median', fmt(result.finalMedian))}${card('Final equity · P95', fmt(result.finalP95))}${card('Max drawdown · P95', fmt(result.maxDrawdownP95))}${card('Probability of profit', pct(result.probabilityOfProfit))}${card('Risk of ruin', pct(result.ruinProbability))}${card('Longest loss streak · P95', fmt(result.longestLossStreakP95), 'Consecutive trades')}${card('Longest loss streak · maximum', fmt(result.longestLossStreakMax), 'Consecutive trades')}</div><section class="sr-block"><div class="sr-block-heading"><h3>Simulated equity paths</h3><span>${result.runs} runs · ${result.tradesPerRun} trades · seed ${escape(String(result.seed))}</span></div>${lineChart([
            { label: 'P5 equity', points: result.curve.map(p => ({ time: p.step, value: p.p5 })), className: 'sr-p5' },
            { label: 'Median equity', points: result.curve.map(p => ({ time: p.step, value: p.median })) },
            { label: 'P95 equity', points: result.curve.map(p => ({ time: p.step, value: p.p95 })), className: 'sr-p95' },
        ], false)}<p class="sr-note">Horizontal axis: replayed trades. Pointwise quantiles can come from different runs; the median is not one particular run.</p></section><div class="sr-two-charts"><section class="sr-block"><h3>Final equity distribution</h3>${histogram(sampleBins(result.finalEquities), 'Simulated final equity distribution')}</section><section class="sr-block"><h3>Maximum drawdown distribution</h3>${histogram(sampleBins(result.maxDrawdowns), 'Simulated maximum drawdown distribution')}</section></div><p class="sr-note">Drawdown basis: ${result.drawdownBasis === 'mae-adjusted' ? 'reported per-trade MAE applied to serial replay equity' : result.drawdownBasis === 'partial-mae' ? 'reported MAE where available; other trades use closed equity only' : 'closed equity only; MAE unavailable'}. This estimate cannot reproduce overlapping positions or intrabar chronology and differs from official account drawdown (${fmt(analysis!.account.maxDrawdown)}). Final P&L is net of the engine's commission. Resampling explores this observed ledger and does not predict new market conditions.</p>${result.warnings.map(w => `<p class="sr-note">${escape(w)}</p>`).join('')}`;
    }
    async function startSimulation(): Promise<void> {
        if (!snapshot || !analysis) return;
        cancelSimulation(); const current = generation; const controller = new AbortController(); abort = controller;
        const form = content.querySelector<HTMLFormElement>('.sr-simulation-form')!;
        const data = new FormData(form);
        for (const key of ['mode', 'runs', 'seed', 'ruinThreshold'] as const) simulationSettings[key] = String(data.get(key) ?? '');
        const status = content.querySelector<HTMLElement>('.sr-sim-status')!;
        const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        const cancel = form.querySelector<HTMLButtonElement>('[data-action="cancel-simulation"]')!;
        button.disabled = true; cancel.hidden = false; status.textContent = 'Preparing simulation…';
        try {
            const result = await runMonteCarlo(snapshot.trades, { mode: simulationSettings.mode === 'shuffle' ? 'shuffle' : 'resample', runs: Number(simulationSettings.runs), seed: simulationSettings.seed,
                initialCapital: analysis.account.initialCapital ?? NaN, ruinThreshold: Number(simulationSettings.ruinThreshold), signal: controller.signal,
                onProgress: (completed, total) => { if (current === generation && !destroyed) status.textContent = `${completed} / ${total} runs`; },
            });
            if (current !== generation || destroyed) return;
            simulation = result; status.textContent = `Completed ${result.runs} ${result.mode} runs.`; renderSimulationResults();
        } catch (error) {
            if (current !== generation || destroyed) return;
            status.textContent = error instanceof Error ? error.message : 'Simulation could not complete.';
        } finally {
            if (current === generation && !destroyed) { abort = null; button.disabled = false; cancel.hidden = true; }
        }
    }
    function renderTab(): void {
        if (!analysis) return;
        if (tab === 'performance') renderPerformance(); else if (tab === 'trades') renderLog(); else renderSimulation();
    }
    function selectTab(next: Tab, focus = false): void {
        if (next === tab) { if (focus) root.querySelector<HTMLElement>(`[data-tab="${tab}"]`)!.focus(); return; }
        cancelSimulation(); tab = next;
        for (const button of root.querySelectorAll<HTMLButtonElement>('[role="tab"]')) { const selected = button.dataset.tab === tab; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected || (tab === 'simulation' && button.dataset.tab === 'performance') ? 0 : -1; if (selected && focus) button.focus(); }
        root.querySelector('[data-action="export-csv"]')!.textContent = tab === 'trades' ? 'Export trades CSV' : 'Export metrics CSV';
        root.querySelector<HTMLDetailsElement>('.sr-more')!.open = false;
        content.setAttribute('aria-labelledby', `${id}-${tab}`); renderTab();
    }
    function clickAction(event: Event): void {
        const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button || !root.contains(button) || button.disabled) return;
        if (button.dataset.tab) { selectTab(button.dataset.tab as Tab); return; }
        if (button.dataset.section) {
            const section = button.dataset.section; const value = button.dataset.value!;
            if (section === 'performance') performanceView = value;
            if (section === 'analysis') analysisView = value;
            if (section === 'streak-unit') streakUnit = value;
            if (section === 'pattern-unit' && ['hour', 'weekday', 'month'].includes(value)) patternUnit = value as typeof patternUnit;
            for (const sibling of root.querySelectorAll<HTMLButtonElement>(`[data-section="${section}"]`)) sibling.setAttribute('aria-pressed', String(sibling === button));
            if (section === 'performance') renderPerformanceSection(); else renderAnalysis();
            return;
        }
        if (button.dataset.go) { const time = Number(button.dataset.go); if (Number.isFinite(time)) options.onGoToTrade?.(time); return; }
        if (button.dataset.sort) { const key = button.dataset.sort as SortKey; ascending = sort === key ? !ascending : true; sort = key; page = 0; renderLogResults(); return; }
        if (button.dataset.day) { selectedDay = button.dataset.day; view = 'list'; page = 0; renderLog(); return; }
        const action = button.dataset.action;
        if (action === 'export-csv' && analysis && snapshot) {
            const filtered = filteredRows().filter(row => tab !== 'trades' || view !== 'calendar' || (!row.open && date(row.exitTime).startsWith(month))); filtered.sort((a, b) => compareRows(a, b));
            downloadCsv(tab === 'trades' ? strategyTradesCsv(snapshot, filtered.map(row => row.index)) : strategyMetricsCsv(analysis), tab === 'trades' ? 'strategy-trades.csv' : 'strategy-metrics.csv');
        }
        if (action === 'page-prev' || action === 'page-next') { page += action === 'page-next' ? 1 : -1; renderLogResults(); }
        if (action === 'month-prev' || action === 'month-next') { const value = new Date(`${month}-01T00:00:00Z`); value.setUTCMonth(value.getUTCMonth() + (action === 'month-next' ? 1 : -1)); if (Number.isFinite(value.getTime())) month = value.toISOString().slice(0, 7); renderLogResults(); }
        if (action === 'cancel-simulation') { cancelSimulation(); renderSimulation(); content.querySelector<HTMLElement>('.sr-sim-status')!.textContent = 'Simulation cancelled.'; }
    }
    function changeAction(event: Event): void {
        const input = event.target as HTMLInputElement; const control = input.dataset.control; if (!control || control === 'query') return;
        if (control === 'curve-mode' || control === 'curve-unit') { if (control === 'curve-mode') curveMode = input.value; else curveUnit = input.value; renderPerformance(); return; }
        if (control === 'period-interval' && ['day', 'week', 'month', 'quarter', 'year'].includes(input.value)) { periodInterval = input.value as PeriodInterval; renderPerformanceSection(); return; }
        if (control === 'direction') direction = input.value; if (control === 'outcome') outcome = input.value;
        if (control === 'view') view = input.value; if (control === 'day') selectedDay = input.value;
        if (control === 'month') month = input.value; if (control === 'page-size') pageSize = [25, 50, 100].includes(Number(input.value)) ? Number(input.value) : 25;
        page = 0; renderLogResults();
    }
    function input(event: Event): void { const field = event.target as HTMLInputElement; if (field.dataset.control === 'query') { query = field.value; page = 0; renderLogResults(); } }
    function keydown(event: KeyboardEvent): void {
        const button = (event.target as Element).closest<HTMLElement>('[role="tab"]'); if (!button) return;
        const tabs: Tab[] = ['performance', 'trades']; let index = tabs.indexOf(tab);
        if (event.key === 'ArrowRight') index = (index + 1) % 2; else if (event.key === 'ArrowLeft') index = (index + 1) % 2; else if (event.key === 'Home') index = 0; else if (event.key === 'End') index = 1; else return;
        event.preventDefault(); event.stopPropagation(); selectTab(tabs[index]!, true);
    }
    function submit(event: Event): void { if ((event.target as Element).matches('.sr-simulation-form')) { event.preventDefault(); event.stopPropagation(); void startSimulation(); } }
    const click = (event: Event): void => preserveFocus(() => clickAction(event));
    const change = (event: Event): void => preserveFocus(() => changeAction(event));
    root.addEventListener('click', click); root.addEventListener('change', change); root.addEventListener('input', input); root.addEventListener('keydown', keydown); root.addEventListener('submit', submit);
    return {
        update(value) {
            if (destroyed) return;
            preserveFocus(() => {
                cancelSimulation(); simulation = null;
                snapshot = { ...value, state: { ...value.state }, trades: value.trades.map(t => ({ ...t, entry: { ...t.entry }, ...(t.exit ? { exit: { ...t.exit } } : {}) })),
                    ...(value.equity ? { equity: value.equity.map(p => ({ ...p })) } : {}), ...(value.warnings ? { warnings: [...value.warnings] } : {}) };
                analysis = analyzeStrategy(snapshot); page = 0;
                const a = analysis;
                const cumulative = new Map(a.closedTrades.map(t => [t.index, t.cumulativePnl]));
                rows = value.trades.map((t, index) => {
                    const entryTime = Number.isFinite(new Date(t.entry.time).getTime()) ? finite(t.entry.time) : null;
                    const exitTime = t.exit && Number.isFinite(new Date(t.exit.time).getTime()) ? finite(t.exit.time) : null;
                    return { index, id: t.id, side: t.side, open: t.open || !t.exit, qty: finite(t.qty), entryTime, exitTime, entryPrice: finite(t.entry.price), exitPrice: finite(t.exit?.price),
                        pnl: t.open || !t.exit ? null : finite(t.pnl), commission: finite(t.commission), cumulativePnl: t.open || !t.exit ? null : cumulative.get(index) ?? null,
                        mae: finite(t.maxDrawdown) !== null && t.maxDrawdown! >= 0 ? t.maxDrawdown! : null, mfe: finite(t.maxRunup) !== null && t.maxRunup! >= 0 ? t.maxRunup! : null,
                        durationMs: entryTime !== null && exitTime !== null && exitTime >= entryTime ? exitTime - entryTime : null,
                        entrySignal: [t.entry.id, t.entry.comment].filter(Boolean).join(' · '), exitSignal: [t.exit?.id, t.exit?.comment].filter(Boolean).join(' · '),
                        search: [t.id, t.side, t.entry.id, t.entry.comment, t.exit?.id, t.exit?.comment].join(' ').toLowerCase(), };
                });
                if (!month) { const latest = [...rows].reverse().find(row => row.exitTime !== null)?.exitTime ?? value.to; month = date(latest).slice(0, 7); if (!/^\d{4}-\d{2}$/.test(month)) month = new Date().toISOString().slice(0, 7); }
                root.querySelector('h2')!.textContent = value.name || 'Strategy report';
                root.querySelector('.sr-context')!.textContent = `${value.symbol} · ${value.timeframe} · ${date(value.from)} — ${date(value.to)}${value.history ? ' (end exclusive)' : ''} · UTC`;
                if (value.history?.mode === 'deep') {
                    const badge = document.createElement('span'); badge.className = 'sr-deep-badge'; badge.textContent = 'Deep backtest';
                    root.querySelector('.sr-context')!.prepend(badge);
                    root.querySelector('.sr-context')!.append(` · ${fmt(value.history.barCount)} cached bars · independent of replay`);
                }
                root.querySelector<HTMLButtonElement>('[data-action="export-csv"]')!.disabled = false;
                const notes = [...new Set(a.warnings)];
                root.querySelector('.sr-warnings')!.innerHTML = notes.length ? `<details class="sr-calculation-notes"><summary>Data & calculations · ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}</summary>${notes.map(note => `<p>${escape(note)}</p>`).join('')}</details>` : '';
                renderTab();
            });
        },
        destroy() {
            if (destroyed) return; destroyed = true; cancelSimulation();
            chartMutations.disconnect(); chartResize?.disconnect();
            root.removeEventListener('click', click); root.removeEventListener('change', change); root.removeEventListener('input', input); root.removeEventListener('keydown', keydown); root.removeEventListener('submit', submit);
            root.remove(); snapshot = null; analysis = null; rows = []; simulation = null;
        },
    };
}
