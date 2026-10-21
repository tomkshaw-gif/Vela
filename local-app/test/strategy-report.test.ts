// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StrategyState, StrategyTrade } from '../../src/index';
import { aggregatePeriods, analyzeStrategy, observedEquityPhases, strategyMetricsCsv, strategyTradesCsv, type StrategyResultsSnapshot } from '../shared/strategy-analysis';
import { mountStrategyResults, type StrategyResultsController } from '../client/strategy-results';

const start = Date.parse('2024-01-01T00:00:00Z');
const state: StrategyState = { position: 0, avgPrice: 0, equity: 1050, openPnl: 0, netPnl: 50, grossProfit: 90, grossLoss: 40, wins: 1, losses: 1, even: 0, maxDrawdown: 999, maxRunup: 100, initialCapital: 1000 };
function trade(index: number, pnl: number | undefined, extra: Partial<StrategyTrade> = {}): StrategyTrade {
    return { id: `trade-${index}`, side: 'long', qty: 2, entry: { id: 'entry', time: start + index * 60_000, price: 100.12345 }, exit: { id: 'exit', time: start + (index + 1) * 60_000, price: 101.98765 }, open: false, pnl, ...extra };
}
function snapshot(trades: StrategyTrade[], extra: Partial<StrategyResultsSnapshot> = {}): StrategyResultsSnapshot {
    return { name: 'Strategy', symbol: 'TEST', timeframe: '1', from: start, to: start + 600_000, state, trades, ...extra };
}
const viewers: StrategyResultsController[] = [];
afterEach(() => { viewers.splice(0).forEach(viewer => viewer.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mounted(value: StrategyResultsSnapshot) {
    const host = document.createElement('div'); document.body.append(host); const viewer = mountStrategyResults(host); viewers.push(viewer); viewer.update(value); return { host, viewer };
}
function click(host: HTMLElement, selector: string) { const button = host.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull(); expect(button!.disabled).toBe(false); button!.click(); }
function change(host: HTMLElement, name: string, value: string) { const select = host.querySelector<HTMLSelectElement>(`[data-control="${name}"]`)!; expect(select).not.toBeNull(); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }

describe('report ledger calculations', () => {
    it('groups UTC exit dates into Monday weeks, calendar months, quarters and years', () => {
        const dates = ['2023-12-31T23:59:00Z', '2024-01-01T00:01:00Z', '2024-01-07T23:59:00Z', '2024-04-01T00:01:00Z'];
        const trades = dates.map((date, index) => trade(index, index + 1, { entry: { id: 'e', time: Date.parse(date) - 60_000, price: 1 }, exit: { id: 'x', time: Date.parse(date), price: 2 } }));
        const analyzed = analyzeStrategy(snapshot(trades)).closedTrades;
        expect(aggregatePeriods(analyzed, 'week').map(p => [p.key, p.pnl, p.count])).toEqual([['2023-12-25', 1, 1], ['2024-01-01', 5, 2], ['2024-04-01', 4, 1]]);
        expect(aggregatePeriods(analyzed, 'month').map(p => [p.key, p.pnl])).toEqual([['2023-12', 1], ['2024-01', 5], ['2024-04', 4]]);
        expect(aggregatePeriods(analyzed, 'quarter').map(p => [p.key, p.pnl])).toEqual([['2023 Q4', 1], ['2024 Q1', 5], ['2024 Q2', 4]]);
        expect(aggregatePeriods(analyzed, 'year').map(p => [p.key, p.pnl])).toEqual([['2023', 1], ['2024', 9]]);
    });

    it('keeps an unknown or overflowing period unavailable without inventing zero or losing outcome counts', () => {
        const unknown = analyzeStrategy(snapshot([trade(0, 10), trade(1, undefined), trade(2, -5)])).daily[0]!;
        expect(unknown).toMatchObject({ pnl: null, grossProfit: null, grossLoss: null, count: 3, wins: 1, losses: 1, unknownPnlCount: 1, complete: false });
        const overflow = analyzeStrategy(snapshot([trade(0, 1e308), trade(1, 1e308)]));
        expect(overflow.daily[0]).toMatchObject({ pnl: null, count: 2, wins: 2, unknownPnlCount: 0, complete: false });
        expect(overflow.streaks[0]).toMatchObject({ count: 2, pnl: null });
    });

    it('uses ENTRY hour, weekday and month instead of relabeling exit-time performance', () => {
        const entry = Date.parse('2024-01-01T23:59:00Z'); const exit = Date.parse('2024-01-02T00:01:00Z');
        const a = analyzeStrategy(snapshot([trade(0, 10, { entry: { id: 'e', time: entry, price: 1 }, exit: { id: 'x', time: exit, price: 2 } })]));
        expect(a.entryPatterns.hour[23]).toMatchObject({ count: 1, wins: 1, pnl: 10 });
        expect(a.entryPatterns.weekday[1]).toMatchObject({ label: 'Monday', wins: 1 });
        expect(a.entryPatterns.weekday[2]!.count).toBe(0);
        expect(a.weekday[2]).toMatchObject({ label: 'Tuesday', wins: 1 });
        expect(a.entryPatterns.month[0]!.wins).toBe(1);
    });

    it('splits known streaks at missing outcomes and breakevens while preserving the actual exit sequence', () => {
        const a = analyzeStrategy(snapshot([10, 20, -5, undefined, -6, -7, 0, 0, 2].map((pnl, index) => trade(index, pnl))));
        expect(a.streaks.map(s => [s.outcome, s.count, s.pnl])).toEqual([['win', 2, 30], ['loss', 1, -5], ['loss', 2, -13], ['even', 2, 0], ['win', 1, 2]]);
        expect(a.streaks[2]).toMatchObject({ firstTrade: 5, lastTrade: 6, from: start + 4 * 60_000, to: start + 6 * 60_000 });
        expect(a.all.maxLossStreak).toBeNull();
    });

    it('derives only observed equity phases and extends flat time without fabricating bar counts', () => {
        const result = observedEquityPhases([100, 110, 110, 105, 95, 100].map((value, time) => ({ time: time * 60_000, value })));
        expect(result).toEqual([{ direction: 'growth', from: 0, to: 120_000, amount: 10, observations: 1 }, { direction: 'decline', from: 120_000, to: 240_000, amount: 15, observations: 2 }, { direction: 'growth', from: 240_000, to: 300_000, amount: 5, observations: 1 }]);
    });

    it('exports exact exit/entry pairs, raw precision, negative drawdown and escaped signal text', () => {
        const value = snapshot([trade(0, 12.12345, { commission: .75, maxRunup: 20, maxDrawdown: 5, entry: { id: 'entry,"quoted"\nline', time: start, price: 100.12345 }, exit: { id: '=FORMULA()', time: start + 60_000, price: 101.98765 } })]);
        const exported = strategyTradesCsv(value);
        expect(exported).toContain('1,Exit long,2024-01-01T00:01:00.000Z,\'=FORMULA(),101.98765,2,12.12345,20,-5,12.12345,0.75,60000');
        expect(exported).toContain('1,Entry long,2024-01-01T00:00:00.000Z,"entry,""quoted""\nline",100.12345');
        expect(exported).not.toContain('Position value'); expect(exported).not.toContain('Return %');
        expect(strategyMetricsCsv(analyzeStrategy(value))).toContain('Engine account maximum drawdown,999,,');
    });

    it('keeps cumulative P&L attached to original trade instances after filtering, including repeated IDs', () => {
        const value = snapshot([trade(0, 100, { id: 'same' }), trade(1, -25, { id: 'same' }), trade(2, 50, { id: 'same' })]);
        const lines = strategyTradesCsv(value, [2, 0]).split('\r\n');
        expect(lines[1]!.split(',')[9]).toBe('125'); expect(lines[3]!.split(',')[9]).toBe('100');
        const open = strategyTradesCsv(snapshot([trade(0, undefined, { open: true, exit: undefined })])).split('\r\n');
        expect(open[1]!.split(',').slice(6, 10)).toEqual(['', '', '', '']);
    });
});

describe('compact strategy report', () => {
    it('offers two primary views, four ordered KPIs and one dominant, clearly labeled curve', () => {
        const { host } = mounted(snapshot([trade(0, 50)]));
        expect([...host.querySelectorAll('[role="tab"]')].map(button => button.textContent)).toEqual(['Report', 'List of trades']);
        expect([...host.querySelectorAll('.sr-summary .sr-kpi > span')].map(label => label.textContent)).toEqual(['Total P&L', 'Max drawdown', 'Profitable trades', 'Profit factor']);
        expect(host.querySelectorAll('.sr-overview > .sr-chart')).toHaveLength(1);
        expect(host.querySelector('.sr-overview')!.textContent).toContain('Closed-trade equity');
        expect(host.querySelector('.sr-summary')!.textContent).toContain('999');
        expect(host.querySelector('.sr-calculation-notes[open]')).toBeNull();
        expect(host.querySelector('[data-tab="simulation"]')).not.toBeNull();
        expect(host.querySelectorAll('[data-section]')).not.toHaveLength(0);
    });

    it('switches real period, distribution, streak and entry-time controls with source-correct labels', () => {
        const { host } = mounted(snapshot([trade(0, 10), trade(1, -5), trade(2, 0)]));
        click(host, '[data-section="performance"][data-value="periodical"]'); change(host, 'period-interval', 'quarter');
        expect(host.querySelector('.sr-performance-analysis')!.textContent).toContain('2024 Q1');
        click(host, '[data-section="analysis"][data-value="streaks"]'); click(host, '[data-section="streak-unit"][data-value="amount"]');
        expect(host.querySelector('.sr-trade-analysis')!.textContent).toContain('Known sequence');
        click(host, '[data-section="analysis"][data-value="time"]'); click(host, '[data-section="pattern-unit"][data-value="weekday"]');
        expect(host.querySelector('.sr-trade-analysis')!.textContent).toContain('ENTRY time in UTC');
        click(host, '[data-section="performance"][data-value="growth"]');
        expect(host.querySelector('.sr-performance-analysis')!.textContent).toContain('Closed-trade equity');
        change(host, 'curve-unit', 'percent'); change(host, 'curve-mode', 'drawdown');
        expect(host.querySelector('.sr-overview .sr-chart')!.getAttribute('aria-label')).toContain('Closed-trade drawdown (%)');
    });

    it('renders paired fills and no visible negative zero while preserving engine values in CSV', () => {
        const { host } = mounted(snapshot([trade(0, -.000001, { maxDrawdown: .0000001 })], { state: { ...state, netPnl: -.000001 } }));
        expect(host.querySelector('.sr-summary strong')!.textContent).toBe('0');
        click(host, '[data-tab="trades"]');
        expect([...host.querySelectorAll('.sr-log thead th')].map(cell => cell.textContent!.replace(' ↑', ''))).toEqual(['Trade #', 'Type', 'Date/time · UTC', 'Signal', 'Price', 'Position size', 'Net P&L', 'Run-up', 'Drawdown', 'Cumulative P&L']);
        expect(host.querySelectorAll('.sr-log tbody tr')).toHaveLength(2);
        expect(host.querySelector('[data-field="pnl"]')!.textContent).toBe('0');
        expect(host.querySelector('[data-field="mae"]')!.textContent).toBe('0');
        expect(strategyTradesCsv(snapshot([trade(0, -.000001)]))).toContain('-0.000001');
    });

    it('labels only explicit deep manifests and removes the badge when replay results replace them', () => {
        const value = snapshot([trade(0, 10)], { history: { mode: 'deep', requestedFrom: start, requestedTo: start + 600_000, barCount: 10, checksum: 'test', sourceDatasets: [] } });
        const { host, viewer } = mounted(value);
        expect(host.querySelector('.sr-deep-badge')!.textContent).toBe('Deep backtest');
        expect(host.querySelector('.sr-context')!.textContent).toContain('end exclusive');
        expect(host.querySelector('.sr-context')!.textContent).toContain('10 cached bars');
        viewer.update(snapshot([trade(0, 5)])); expect(host.querySelector('.sr-deep-badge')).toBeNull();
    });

    it('exports metric CSV on Report and every filtered trade on List rather than only the current page', async () => {
        let blob: Blob | undefined; const create = vi.fn((value: Blob) => { blob = value; return 'blob:report-test'; });
        const OriginalURL = URL; vi.stubGlobal('URL', class extends OriginalURL { static override createObjectURL = create; static override revokeObjectURL = vi.fn(); });
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const read = () => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob!); });
        const { host } = mounted(snapshot(Array.from({ length: 30 }, (_, index) => trade(index, index + 1, { side: index % 2 ? 'short' : 'long' }))));
        click(host, '[data-action="export-csv"]'); expect(await read()).toMatch(/^Metric,All,Long,Short/);
        click(host, '[data-tab="trades"]'); change(host, 'direction', 'long'); click(host, '[data-sort="pnl"]');
        click(host, '[data-action="export-csv"]'); const lines = (await read()).split('\r\n');
        expect(lines).toHaveLength(31); expect(lines[1]).toContain('1,Exit long'); expect(lines.at(-1)).toContain('29,Entry long');
    });

    it('keeps chart samples and paired table DOM bounded for a large ledger', () => {
        const { host } = mounted(snapshot(Array.from({ length: 20_000 }, (_, index) => trade(index, index % 2 ? -1 : 2))));
        expect(host.querySelectorAll('.sr-overview .sr-hover-point').length).toBeLessThanOrEqual(365);
        click(host, '[data-tab="trades"]'); expect(host.querySelectorAll('.sr-log tbody tr')).toHaveLength(50);
        expect(host.querySelector('.sr-pagination')!.textContent).toContain('20,000 trades');
    });
});
