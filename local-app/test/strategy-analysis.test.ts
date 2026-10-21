// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StrategyState, StrategyTrade } from '../../src/index';
import { analyzeStrategy, distribution, MONTE_CARLO_LIMITS, percentile, runMonteCarlo } from '../shared/strategy-analysis';
import type { StrategyResultsSnapshot } from '../shared/strategy-analysis';
import * as strategyAnalysis from '../shared/strategy-analysis';
import { mountStrategyResults, type StrategyResultsController } from '../client/strategy-results';

const start = Date.parse('2026-10-12T00:00:00Z');
const state: StrategyState = {
    position: 0, avgPrice: 0, equity: 1050, openPnl: 0, netPnl: 50,
    grossProfit: 90, grossLoss: 40, wins: 1, losses: 1, even: 0,
    maxDrawdown: 999, maxRunup: 100, initialCapital: 1000,
};
function trade(index: number, pnl: number | undefined, extra: Partial<StrategyTrade> = {}): StrategyTrade {
    return {
        id: `trade-${index}`, side: 'long', qty: 1,
        entry: { id: 'entry', time: start + index * 60_000, price: 100 },
        exit: { id: 'exit', time: start + (index + 1) * 60_000, price: 200 },
        open: false, pnl, ...extra,
    };
}
function snapshot(trades: StrategyTrade[], extra: Partial<StrategyResultsSnapshot> = {}): StrategyResultsSnapshot {
    return { name: 'Strategy', symbol: 'TEST', timeframe: '1', from: start, to: start + 600_000, state, trades, ...extra };
}
const simulation = { mode: 'resample' as const, runs: 24, seed: 'fixed-seed', initialCapital: 1000 };
const viewers: StrategyResultsController[] = [];
afterEach(() => { viewers.splice(0).forEach(viewer => viewer.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('official strategy ledger analysis', () => {
    it('uses authoritative directions and NET P&L without subtracting commission again or deriving fills', () => {
        const input = [trade(0, 90, { commission: 10 }), trade(1, -40, { side: 'short', qty: 2, commission: 5 })];
        const original = structuredClone(input);
        const result = analyzeStrategy(snapshot(input));
        expect(result.all).toMatchObject({ count: 2, netPnl: 50, commission: 15, grossProfit: 90, grossLoss: 40, profitFactor: 2.25, winRate: 0.5, maxDrawdown: 40 });
        expect(result.long.netPnl).toBe(90);
        expect(result.short).toMatchObject({ count: 1, netPnl: -40, winRate: 0 });
        expect(result.closedEquity.points.map(point => point.value)).toEqual([1000, 1090, 1050]);
        expect(result.closedTrades.map(item => item.cumulativePnl)).toEqual([90, 50]);
        expect(result.account.maxDrawdown).toBe(999);
        expect(input).toEqual(original);
    });

    it('keeps trade MAE/MFE positive and distinct from official account and closed-equity drawdown', () => {
        const result = analyzeStrategy(snapshot([trade(0, 50, { maxDrawdown: 200, maxRunup: 400 })]));
        expect(result.closedTrades[0]).toMatchObject({ mae: 200, mfe: 400 });
        expect(result.all.maxDrawdown).toBe(0);
        expect(result.account.maxDrawdown).toBe(999);
        expect(result.equity.source).toBe('closed-trades');
        expect(result.warnings.join(' ')).toContain('intrabar');
    });

    it('separates supplied account equity from derived closed-trade equity', () => {
        const equity = [{ time: start, value: 1000 }, { time: start + 20_000, value: 700 }, { time: start + 60_000, value: 1100 }];
        const result = analyzeStrategy(snapshot([trade(0, 100)], { equity, to: start + 60_000 }));
        expect(result.equity).toMatchObject({ source: 'actual', complete: true, maxDrawdown: 300, maxDrawdownPct: 0.3 });
        expect(result.equity.drawdown.map(point => point.value)).toEqual([0, 300, 0]);
        expect(result.closedEquity.maxDrawdown).toBe(0);
        expect(result.account.maxDrawdown).toBe(999);
        expect(equity).toHaveLength(3);
    });

    it('reports empty or unavailable metrics as null rather than a zero result or infinity', () => {
        const empty = analyzeStrategy(snapshot([]));
        expect(empty.all).toMatchObject({ count: 0, netPnl: null, grossProfit: null, grossLoss: null, profitFactor: null, winRate: null, maxDrawdown: null, averageDurationMs: null, maxLossStreak: null });
        expect(empty.equity.points).toEqual([]);
        expect(empty.weekday.every(day => day.pnl === null)).toBe(true);
        const won = analyzeStrategy(snapshot([trade(0, 10)]));
        expect(won.all.profitFactor).toBeNull();
        expect(won.all.largestLoss).toBeNull();
        const invalid = analyzeStrategy(snapshot([trade(0, Infinity, { commission: NaN, maxDrawdown: -1 })], { state: { ...state, equity: Infinity, initialCapital: NaN } }));
        expect(invalid.account.equity).toBeNull();
        expect(invalid.closedTrades[0]).toMatchObject({ pnl: null, commission: null, mae: null });
        expect(invalid.all.netPnl).toBeNull();
        expect(invalid.all.returnPct).toBeNull();
        expect(invalid.closedEquity.points).toEqual([]);
    });

    it('does not bridge missing trade P&L, silently zero unknown days, or count open trades as closed', () => {
        const trades = [trade(0, 10), trade(1, undefined), trade(2, 5), trade(3, 100, { open: true }), trade(4, 100, { exit: undefined })];
        const result = analyzeStrategy(snapshot(trades));
        expect(result.openTrades).toBe(2);
        expect(result.unknownPnlTrades).toBe(1);
        expect(result.all).toMatchObject({ count: 3, knownPnlCount: 2, unknownPnlCount: 1, complete: false, netPnl: 15, maxDrawdown: null, maxLossStreak: null });
        expect(result.closedTrades.map(item => item.cumulativePnl)).toEqual([10, null, null]);
        expect(result.closedEquity).toMatchObject({ complete: false });
        expect(result.closedEquity.points.map(point => point.value)).toEqual([1000, 1010]);
        expect(result.daily[0]).toMatchObject({ pnl: null, count: 3, unknownPnlCount: 1 });
        expect(result.weekday[1]).toMatchObject({ key: '1', label: 'Monday', pnl: null, unknownPnlCount: 1 });
    });

    it('sorts by official exit time and measures elapsed fill duration in milliseconds', () => {
        const late = trade(2, -20, { entry: { id: 'e', time: start, price: 100 }, exit: { id: 'x', time: start + 3 * 86_400_000, price: 90 } });
        const early = trade(0, 10);
        const result = analyzeStrategy(snapshot([late, early]));
        expect(result.closedTrades.map(item => item.id)).toEqual(['trade-0', 'trade-2']);
        expect(result.all).toMatchObject({ largestWin: 10, largestLoss: 20, minDurationMs: 60_000, maxDurationMs: 259_200_000, averageWinDurationMs: 60_000, averageLossDurationMs: 259_200_000 });
        expect(result.daily.map(day => day.key)).toEqual(['2026-10-12', '2026-10-15']);
        const badTime = analyzeStrategy(snapshot([trade(0, 10, { exit: { id: 'x', time: start - 1, price: 1 } })]));
        expect(badTime.invalidTimeTrades).toBe(1);
        expect(badTime.all.averageDurationMs).toBeNull();
        expect(badTime.all.maxDrawdown).toBeNull();
        expect(badTime.all.maxLossStreak).toBeNull();
    });

    it('normalizes invalid supplied samples and counts every histogram observation exactly once', () => {
        const result = analyzeStrategy(snapshot([trade(0, 0)], { equity: [{ time: start, value: 1000 }, { time: start + 1, value: NaN }, { time: start + 2, value: 900 }] }));
        expect(result.equity).toMatchObject({ source: 'actual', complete: false, maxDrawdown: 100 });
        expect(distribution([-2, -1, 0, 0, 3, NaN], 4).reduce((total, bin) => total + bin.count, 0)).toBe(5);
        expect(distribution([5, 5])).toEqual([{ from: 5, to: 5, count: 2 }]);
        expect(distribution([])).toEqual([]);
        expect(percentile([0, 10], 0.5)).toBe(5);
        expect(percentile([Infinity], 0.5)).toBeNull();
    });

    it('keeps overflowed daily totals unavailable and does not claim full-period coverage from sparse samples', () => {
        const huge = analyzeStrategy(snapshot([trade(0, 1e308), trade(1, 1e308), trade(2, -1e308)]));
        expect(huge.daily[0]!.pnl).toBeNull(); expect(huge.weekday[1]!.pnl).toBeNull();
        const one = analyzeStrategy(snapshot([trade(0, 10)], { equity: [{ time: start, value: 1000 }] }));
        expect(one.equity).toMatchObject({ source: 'actual', complete: false, maxDrawdown: null });
        const short = analyzeStrategy(snapshot([], { equity: [{ time: start + 1, value: 1000 }, { time: start + 10, value: 990 }] }));
        expect(short.equity).toMatchObject({ source: 'actual', complete: false, maxDrawdown: 10 });
        expect(short.warnings.join(' ')).toContain('complete coverage');
    });
});

describe('bounded official-trade simulation', () => {
    it('uses MAE before closure, charges no second fee, and keeps favorable final P&L intact', async () => {
        const result = await runMonteCarlo([trade(0, 10, { commission: 100, maxDrawdown: 50 })], { ...simulation, initialCapital: 100, ruinThreshold: 60 });
        expect(result).toMatchObject({ finalP5: 110, finalMedian: 110, finalP95: 110, maxDrawdownP95: 50, probabilityOfProfit: 1, ruinProbability: 1, drawdownBasis: 'mae-adjusted', longestLossStreakP95: 0, longestLossStreakMax: 0 });
        expect(result.curve).toEqual([{ step: 0, p5: 100, median: 100, p95: 100 }, { step: 1, p5: 110, median: 110, p95: 110 }]);
    });

    it('calculates exact loss streaks and closed-trade ruin when adverse excursions are unavailable', async () => {
        const result = await runMonteCarlo([trade(0, -25), trade(1, -25), trade(2, -25)], { ...simulation, initialCapital: 100, ruinThreshold: 25 });
        expect(result).toMatchObject({ finalMedian: 25, maxDrawdownP95: 75, probabilityOfProfit: 0, ruinProbability: 1, longestLossStreakP95: 3, longestLossStreakMax: 3, drawdownBasis: 'closed-trades' });
        expect(result.warnings.join(' ')).toContain('lack MAE');
    });

    it('reproduces seeded resampling and conserves every official trade outcome when shuffling', async () => {
        const trades = [trade(0, 100, { maxDrawdown: 20 }), trade(1, -50), trade(2, 40), trade(3, -20)];
        const original = structuredClone(trades);
        const first = await runMonteCarlo(trades, simulation);
        const repeated = await runMonteCarlo(trades, simulation);
        const another = await runMonteCarlo(trades, { ...simulation, seed: 'other-seed' });
        expect(repeated).toEqual(first);
        expect(another.finalEquities).not.toEqual(first.finalEquities);
        expect(first.drawdownBasis).toBe('partial-mae');
        const shuffled = await runMonteCarlo(trades, { ...simulation, mode: 'shuffle' });
        expect(new Set(shuffled.finalEquities)).toEqual(new Set([1070]));
        expect(shuffled.curve.at(-1)).toMatchObject({ p5: 1070, median: 1070, p95: 1070 });
        expect(trades).toEqual(original);
    });

    it('limits runs and ledger size, labels excluded unknown P&L, and bounds curve storage', async () => {
        const lots = Array.from({ length: 5002 }, (_, index) => trade(index, index < 2 ? 999 : 1));
        lots.push(trade(5002, undefined));
        const cappedTrades = await runMonteCarlo(lots, { ...simulation, mode: 'shuffle', runs: 1 });
        expect(cappedTrades).toMatchObject({ runs: 1, tradesPerRun: 5000, finalMedian: 6000 });
        expect(cappedTrades.curve.length).toBeLessThanOrEqual(MONTE_CARLO_LIMITS.checkpoints);
        expect(cappedTrades.warnings.join(' ')).toContain('last 5000');
        expect(cappedTrades.warnings.join(' ')).toContain('unavailable P&L were excluded');
        const cappedRuns = await runMonteCarlo([trade(0, 1)], { ...simulation, runs: 1005 });
        expect(cappedRuns.runs).toBe(1000);
        expect(cappedRuns.finalEquities).toHaveLength(1000);
    });

    it('yields during a large run and cancels without finishing the requested work', async () => {
        const controller = new AbortController();
        const progress: number[] = [];
        const promise = runMonteCarlo(Array.from({ length: 5000 }, (_, index) => trade(index, index % 2 ? -1 : 1)), {
            ...simulation, runs: 1000, signal: controller.signal,
            onProgress: completed => { progress.push(completed); if (completed === 3) setTimeout(() => controller.abort(), 0); },
        });
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(progress[0]).toBe(0);
        expect(progress.at(-1)).toBeLessThan(1000);
    });

    it('rejects an empty known ledger, nonfinite options, and an already cancelled job', async () => {
        await expect(runMonteCarlo([trade(0, undefined)], simulation)).rejects.toThrow('at least one closed trade');
        await expect(runMonteCarlo([trade(0, 1)], { ...simulation, initialCapital: NaN })).rejects.toThrow('initial capital');
        await expect(runMonteCarlo([trade(0, 1)], { ...simulation, runs: Infinity })).rejects.toThrow('Runs');
        const controller = new AbortController(); controller.abort();
        await expect(runMonteCarlo([trade(0, 1)], { ...simulation, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('strategy results viewer', () => {
    function mount(onGoToTrade?: (time: number) => void) {
        const host = document.createElement('div'); document.body.append(host);
        const existing = document.createElement('span'); existing.textContent = 'Existing application content'; host.append(existing);
        const viewer = mountStrategyResults(host, { onGoToTrade }); viewers.push(viewer);
        return { host, viewer, existing };
    }
    function click(host: HTMLElement, selector: string): void {
        const button = host.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull(); button!.click();
    }
    function change(host: HTMLElement, control: string, value: string): void {
        const element = host.querySelector<HTMLSelectElement>(`[data-control="${control}"]`)!;
        element.value = value; element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function logRows(host: HTMLElement): HTMLTableRowElement[] { return [...host.querySelectorAll<HTMLTableRowElement>('.sr-log tbody tr[data-fill="exit"]')]; }

    it('preserves unrelated host content and escapes names, trade IDs and source warnings', () => {
        const { host, viewer, existing } = mount();
        const hostile = '<img src="x" onerror="globalThis.injected=true">';
        viewer.update(snapshot([trade(0, 5, { id: hostile, entry: { id: 'source', time: start, price: 100, comment: hostile } })], { name: hostile, warnings: [hostile] }));
        expect(host.querySelector('h2')!.textContent).toBe(hostile);
        expect(host.querySelector('img')).toBeNull();
        click(host, '[data-tab="trades"]');
        expect(host.querySelector('.sr-log tbody th small')!.textContent).toBe(hostile);
        expect(host.querySelector('img')).toBeNull();
        viewer.destroy(); viewer.destroy(); viewer.update(snapshot([]));
        expect(host.children).toHaveLength(1);
        expect(host.firstElementChild).toBe(existing);
    });

    it('keeps original cumulative P&L attached while sorting and filtering trade direction', () => {
        const { host, viewer } = mount();
        viewer.update(snapshot([trade(0, 100), trade(1, -25, { side: 'short' }), trade(2, 50)]));
        click(host, '[data-tab="trades"]'); click(host, '[data-sort="pnl"]');
        expect(logRows(host).map(row => row.querySelector('[data-field="cumulativePnl"]')!.textContent)).toEqual(['75', '125', '100']);
        change(host, 'direction', 'long');
        expect(logRows(host).map(row => row.querySelector('th small')!.textContent)).toEqual(['trade-2', 'trade-0']);
        expect(logRows(host).map(row => row.querySelector('[data-field="cumulativePnl"]')!.textContent)).toEqual(['125', '100']);
    });

    it('paginates the complete log, goes to the selected official fill time, and opens calendar dates', () => {
        const go = vi.fn(); const { host, viewer } = mount(go);
        viewer.update(snapshot(Array.from({ length: 30 }, (_, index) => trade(index, 1))));
        click(host, '[data-tab="trades"]');
        expect(logRows(host)).toHaveLength(25);
        click(host, '[data-action="page-next"]'); expect(logRows(host)).toHaveLength(5);
        click(host, '.sr-log tbody [data-go]'); expect(go).toHaveBeenCalledWith(start + 26 * 60_000);
        change(host, 'page-size', '100'); expect(logRows(host)).toHaveLength(30);
        change(host, 'view', 'calendar');
        expect(host.querySelectorAll('.sr-calendar-day:not([disabled])')).toHaveLength(1);
        click(host, '.sr-calendar-day:not([disabled])');
        expect(logRows(host)).toHaveLength(30);
        expect(host.querySelector<HTMLInputElement>('[data-control="day"]')!.value).toBe('2026-10-12');
    });

    it('aborts a pending simulation on snapshot replacement and destroy without a stale render', async () => {
        const signals: AbortSignal[] = [];
        vi.spyOn(strategyAnalysis, 'runMonteCarlo').mockImplementation((_trades, options) => {
            signals.push(options.signal!);
            return new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true }));
        });
        const { host, viewer, existing } = mount();
        viewer.update(snapshot([trade(0, 10)])); click(host, '[data-tab="simulation"]');
        host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(signals).toHaveLength(1); expect(signals[0]!.aborted).toBe(false);
        viewer.update(snapshot([trade(0, 20)], { name: 'Updated strategy' }));
        expect(signals[0]!.aborted).toBe(true);
        host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(signals).toHaveLength(2); expect(signals[1]!.aborted).toBe(false);
        viewer.destroy(); await Promise.resolve(); await Promise.resolve();
        expect(signals[1]!.aborted).toBe(true);
        expect(host.children).toHaveLength(1); expect(host.firstElementChild).toBe(existing);
    });
});
