import type { StrategyState, StrategyTrade } from '../../src/index';
import type { DeepHistoryManifest } from './deep-backtest';

export interface EquityPoint { time: number; value: number }
export interface StrategyResultsSnapshot {
    name: string;
    symbol: string;
    timeframe: string;
    from: number;
    to: number;
    state: StrategyState;
    trades: StrategyTrade[];
    equity?: EquityPoint[];
    warnings?: string[];
    history?: DeepHistoryManifest;
}

export type NormalizedAccount = { [Key in keyof StrategyState]: number | null };
export interface AnalyzedTrade {
    index: number;
    id: string;
    side: 'long' | 'short';
    qty: number | null;
    entryTime: number | null;
    exitTime: number | null;
    entryPrice: number | null;
    exitPrice: number | null;
    entryId: string;
    exitId: string;
    entryComment: string;
    exitComment: string;
    pnl: number | null;
    commission: number | null;
    mae: number | null;
    mfe: number | null;
    durationMs: number | null;
    cumulativePnl: number | null;
}

/** Ratios use fractions; losses and drawdowns use positive currency magnitudes. */
export interface PerformanceMetrics {
    count: number;
    knownPnlCount: number;
    unknownPnlCount: number;
    complete: boolean;
    wins: number;
    losses: number;
    even: number;
    netPnl: number | null;
    grossProfit: number | null;
    grossLoss: number | null;
    profitFactor: number | null;
    winRate: number | null;
    maxDrawdown: number | null;
    maxDrawdownPct: number | null;
    returnPct: number | null;
    commission: number | null;
    knownCommissionCount: number;
    averagePnl: number | null;
    averageWin: number | null;
    averageLoss: number | null;
    largestWin: number | null;
    largestLoss: number | null;
    averageDurationMs: number | null;
    medianDurationMs: number | null;
    minDurationMs: number | null;
    maxDurationMs: number | null;
    averageWinDurationMs: number | null;
    averageLossDurationMs: number | null;
    maxLossStreak: number | null;
}

export interface EquitySeries {
    source: 'actual' | 'closed-trades';
    points: EquityPoint[];
    /** Currency drop from the highest preceding observed value, as a positive value. */
    drawdown: EquityPoint[];
    maxDrawdown: number | null;
    maxDrawdownPct: number | null;
    complete: boolean;
}
export interface PeriodPerformance {
    key: string;
    label: string;
    time: number;
    pnl: number | null;
    count: number;
    wins: number;
    losses: number;
    even: number;
    grossProfit: number | null;
    grossLoss: number | null;
    unknownPnlCount: number;
    complete: boolean;
    largestRunup: number | null;
    largestDrawdown: number | null;
}
export type PeriodInterval = 'day' | 'week' | 'month' | 'quarter' | 'year';
export interface TradeStreak {
    outcome: 'win' | 'loss' | 'even'; count: number; pnl: number | null;
    from: number | null; to: number | null; firstTrade: number; lastTrade: number;
}
export interface EquityPhase { direction: 'growth' | 'decline'; from: number; to: number; amount: number; observations: number }
export interface DistributionBin { from: number; to: number; count: number }
export interface StrategyAnalysis {
    account: NormalizedAccount;
    all: PerformanceMetrics;
    long: PerformanceMetrics;
    short: PerformanceMetrics;
    closedTrades: AnalyzedTrade[];
    openTrades: number;
    unknownPnlTrades: number;
    invalidTimeTrades: number;
    equity: EquitySeries;
    closedEquity: EquitySeries;
    daily: PeriodPerformance[];
    weekday: PeriodPerformance[];
    pnlDistribution: DistributionBin[];
    durationDistribution: DistributionBin[];
    streaks: TradeStreak[];
    entryPatterns: { hour: PeriodPerformance[]; weekday: PeriodPerformance[]; month: PeriodPerformance[] };
    equityPhases: EquityPhase[];
    warnings: string[];
}

export function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function magnitude(value: unknown): number | null {
    const number = finiteNumber(value);
    return number !== null && number >= 0 ? number : null;
}

function timestamp(value: unknown): number | null {
    const number = finiteNumber(value);
    return number !== null && Math.abs(number) <= 8.64e15 ? number : null;
}

function ratio(numerator: number, denominator: number): number | null {
    return denominator > 0 ? finiteNumber(numerator / denominator) : null;
}

function mean(values: number[]): number | null {
    if (!values.length) return null;
    // Dividing each term first avoids an overflowing sum for otherwise finite means.
    return finiteNumber(values.reduce((total, value) => total + value / values.length, 0));
}

function sortedPercentile(sorted: readonly number[], fraction: number): number | null {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * fraction;
    const lower = sorted[Math.floor(index)]!;
    const upper = sorted[Math.ceil(index)]!;
    return finiteNumber(lower * (1 - (index % 1)) + upper * (index % 1));
}

export function percentile(values: readonly number[], fraction: number): number | null {
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
    return sortedPercentile(values.filter(Number.isFinite).sort((a, b) => a - b), fraction);
}

export function distribution(values: readonly number[], requestedBins = 12): DistributionBin[] {
    const finite = values.filter(Number.isFinite);
    if (!finite.length) return [];
    let min = finite[0]!;
    let max = min;
    for (const value of finite) { min = Math.min(min, value); max = Math.max(max, value); }
    if (min === max) return [{ from: min, to: max, count: finite.length }];
    const count = Math.min(40, finite.length, Math.max(1, Math.floor(finiteNumber(requestedBins) ?? 12)));
    const width = (max - min) / count;
    if (!Number.isFinite(width) || width <= 0) return [];
    const bins = Array.from({ length: count }, (_, index) => ({ from: min + index * width, to: index === count - 1 ? max : min + (index + 1) * width, count: 0 }));
    for (const value of finite) bins[Math.min(count - 1, Math.floor((value - min) / width))]!.count += 1;
    return bins;
}

function normalizeAccount(state: StrategyState): NormalizedAccount {
    return {
        position: finiteNumber(state.position), avgPrice: finiteNumber(state.avgPrice),
        equity: finiteNumber(state.equity), openPnl: finiteNumber(state.openPnl), netPnl: finiteNumber(state.netPnl),
        grossProfit: magnitude(state.grossProfit), grossLoss: magnitude(state.grossLoss),
        wins: magnitude(state.wins), losses: magnitude(state.losses), even: magnitude(state.even),
        maxDrawdown: magnitude(state.maxDrawdown), maxRunup: magnitude(state.maxRunup),
        initialCapital: finiteNumber(state.initialCapital),
    };
}

function normalizeTrade(trade: StrategyTrade, index: number): AnalyzedTrade {
    const entryTime = timestamp(trade.entry.time);
    const exitTime = timestamp(trade.exit?.time);
    return {
        index, id: trade.id, side: trade.side, qty: magnitude(trade.qty),
        entryTime, exitTime, entryPrice: finiteNumber(trade.entry.price), exitPrice: finiteNumber(trade.exit?.price),
        entryId: trade.entry.id, exitId: trade.exit?.id ?? '',
        entryComment: trade.entry.comment ?? '', exitComment: trade.exit?.comment ?? '',
        pnl: finiteNumber(trade.pnl), commission: magnitude(trade.commission),
        mae: magnitude(trade.maxDrawdown), mfe: magnitude(trade.maxRunup),
        durationMs: entryTime !== null && exitTime !== null && exitTime >= entryTime ? exitTime - entryTime : null,
        cumulativePnl: null,
    };
}

function emptySeries(source: EquitySeries['source']): EquitySeries {
    return { source, points: [], drawdown: [], maxDrawdown: null, maxDrawdownPct: null, complete: false };
}

function equitySeries(points: EquityPoint[], source: EquitySeries['source'], complete: boolean): EquitySeries {
    if (!points.length) return emptySeries(source);
    if (points.length === 1) return { ...emptySeries(source), points };
    let peak = points[0]!.value;
    let maxDrawdown = 0;
    let maxDrawdownPct: number | null = peak > 0 ? 0 : null;
    const drawdown: EquityPoint[] = [];
    for (const point of points) {
        peak = Math.max(peak, point.value);
        const drop = finiteNumber(peak - point.value);
        if (drop === null) return { ...emptySeries(source), complete: false };
        drawdown.push({ time: point.time, value: drop });
        maxDrawdown = Math.max(maxDrawdown, drop);
        const fraction = ratio(drop, peak);
        if (fraction !== null) maxDrawdownPct = Math.max(maxDrawdownPct ?? 0, fraction);
    }
    return { source, points, drawdown, maxDrawdown, maxDrawdownPct, complete };
}

function closedSeries(trades: readonly AnalyzedTrade[], capital: number | null, start: number): EquitySeries {
    if (capital === null || !trades.length) return emptySeries('closed-trades');
    const first = trades[0]!;
    const anchor = timestamp(start) ?? first.entryTime ?? first.exitTime;
    if (anchor === null) return emptySeries('closed-trades');
    const points: EquityPoint[] = [{ time: Math.min(anchor, first.exitTime ?? anchor), value: capital }];
    let balance = capital;
    let complete = true;
    for (const trade of trades) {
        if (trade.pnl === null || trade.exitTime === null || trade.durationMs === null) { complete = false; break; }
        const next = finiteNumber(balance + trade.pnl);
        if (next === null) { complete = false; break; }
        balance = next;
        points.push({ time: trade.exitTime, value: balance });
    }
    // An initial-capital anchor alone does not prove a flat equity history.
    return points.length > 1 ? equitySeries(points, 'closed-trades', complete) : emptySeries('closed-trades');
}

function performance(trades: readonly AnalyzedTrade[], capital: number | null, start: number): PerformanceMetrics {
    const known = trades.filter(trade => trade.pnl !== null);
    const winners = known.filter(trade => trade.pnl! > 0);
    const losers = known.filter(trade => trade.pnl! < 0);
    const sum = (selected: readonly AnalyzedTrade[], field: 'pnl' | 'commission') => finiteNumber(selected.reduce((total, trade) => total + (trade[field] ?? 0), 0));
    const netPnl = known.length ? sum(known, 'pnl') : null;
    const grossProfit = known.length ? sum(winners, 'pnl') : null;
    const grossLoss = known.length ? finiteNumber(-losers.reduce((total, trade) => total + trade.pnl!, 0)) : null;
    const commissions = trades.filter(trade => trade.commission !== null);
    const durations = trades.flatMap(trade => trade.durationMs === null ? [] : [trade.durationMs]);
    const durationsOf = (selected: readonly AnalyzedTrade[]) => selected.flatMap(trade => trade.durationMs === null ? [] : [trade.durationMs]);
    let streak = 0;
    let longest = 0;
    for (const trade of trades) {
        streak = trade.pnl !== null && trade.pnl < 0 ? streak + 1 : 0;
        longest = Math.max(longest, streak);
    }
    const series = closedSeries(trades, capital ?? 0, start);
    const orderedDurations = durations.sort((a, b) => a - b);
    return {
        count: trades.length, knownPnlCount: known.length, unknownPnlCount: trades.length - known.length,
        complete: known.length === trades.length,
        wins: winners.length, losses: losers.length, even: known.length - winners.length - losers.length,
        netPnl, grossProfit, grossLoss,
        profitFactor: grossProfit !== null && grossLoss !== null ? ratio(grossProfit, grossLoss) : null,
        winRate: ratio(winners.length, known.length),
        maxDrawdown: series.complete ? series.maxDrawdown : null,
        maxDrawdownPct: series.complete && capital !== null && capital > 0 ? series.maxDrawdownPct : null,
        returnPct: netPnl !== null && capital !== null ? ratio(netPnl, capital) : null,
        commission: commissions.length ? sum(commissions, 'commission') : null, knownCommissionCount: commissions.length,
        averagePnl: mean(known.map(trade => trade.pnl!)),
        averageWin: mean(winners.map(trade => trade.pnl!)), averageLoss: mean(losers.map(trade => -trade.pnl!)),
        largestWin: winners.length ? winners.reduce((largest, trade) => Math.max(largest, trade.pnl!), 0) : null,
        largestLoss: losers.length ? losers.reduce((largest, trade) => Math.max(largest, -trade.pnl!), 0) : null,
        averageDurationMs: mean(durations), medianDurationMs: sortedPercentile(orderedDurations, 0.5),
        minDurationMs: orderedDurations[0] ?? null, maxDurationMs: orderedDurations[orderedDurations.length - 1] ?? null,
        averageWinDurationMs: mean(durationsOf(winners)), averageLossDurationMs: mean(durationsOf(losers)),
        maxLossStreak: known.length && known.length === trades.length && trades.every(trade => trade.durationMs !== null) ? longest : null,
    };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function emptyPeriod(key: string, label: string, time: number): PeriodPerformance {
    return { key, label, time, pnl: null, count: 0, wins: 0, losses: 0, even: 0, grossProfit: null, grossLoss: null, unknownPnlCount: 0, complete: true, largestRunup: null, largestDrawdown: null };
}

function addToPeriod(period: PeriodPerformance, trade: AnalyzedTrade): void {
    period.count++;
    if (trade.mfe !== null) period.largestRunup = Math.max(period.largestRunup ?? 0, trade.mfe);
    if (trade.mae !== null) period.largestDrawdown = Math.max(period.largestDrawdown ?? 0, trade.mae);
    if (trade.pnl === null) { period.unknownPnlCount++; period.complete = false; period.pnl = null; period.grossProfit = null; period.grossLoss = null; return; }
    if (trade.pnl > 0) period.wins++; else if (trade.pnl < 0) period.losses++; else period.even++;
    if (!period.complete) return;
    period.pnl = finiteNumber((period.pnl ?? 0) + trade.pnl);
    period.grossProfit = finiteNumber((period.grossProfit ?? 0) + Math.max(0, trade.pnl));
    period.grossLoss = finiteNumber((period.grossLoss ?? 0) + Math.max(0, -trade.pnl));
    if (period.pnl === null || period.grossProfit === null || period.grossLoss === null) { period.complete = false; period.pnl = null; period.grossProfit = null; period.grossLoss = null; }
}

/** Periods use UTC exit dates; weeks start on Monday, including across year boundaries. */
export function aggregatePeriods(trades: readonly AnalyzedTrade[], interval: PeriodInterval): PeriodPerformance[] {
    const groups = new Map<string, PeriodPerformance>();
    for (const trade of trades) {
        if (trade.exitTime === null) continue;
        const date = new Date(trade.exitTime);
        date.setUTCHours(0, 0, 0, 0);
        if (interval === 'week') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
        if (interval === 'month' || interval === 'quarter' || interval === 'year') date.setUTCDate(1);
        if (interval === 'quarter') date.setUTCMonth(Math.floor(date.getUTCMonth() / 3) * 3);
        if (interval === 'year') date.setUTCMonth(0);
        const key = interval === 'year' ? String(date.getUTCFullYear()) : interval === 'quarter' ? `${date.getUTCFullYear()} Q${Math.floor(date.getUTCMonth() / 3) + 1}` : date.toISOString().slice(0, interval === 'month' ? 7 : 10);
        const period = groups.get(key) ?? emptyPeriod(key, key, date.getTime());
        addToPeriod(period, trade); groups.set(key, period);
    }
    return [...groups.values()].sort((a, b) => a.time - b.time);
}

function pattern(trades: readonly AnalyzedTrade[], field: 'entryTime' | 'exitTime', unit: 'hour' | 'weekday' | 'month'): PeriodPerformance[] {
    const labels = unit === 'hour' ? Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`) : unit === 'weekday' ? WEEKDAYS : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const result = labels.map((label, index) => emptyPeriod(String(index), label, index));
    for (const trade of trades) {
        const time = trade[field]; if (time === null) continue;
        const date = new Date(time); const index = unit === 'hour' ? date.getUTCHours() : unit === 'weekday' ? date.getUTCDay() : date.getUTCMonth();
        addToPeriod(result[index]!, trade);
    }
    return result;
}

export function tradeStreaks(trades: readonly AnalyzedTrade[]): TradeStreak[] {
    const result: TradeStreak[] = []; let current: TradeStreak | undefined;
    for (const trade of trades) {
        if (trade.pnl === null || trade.durationMs === null) { current = undefined; continue; }
        const outcome = trade.pnl > 0 ? 'win' : trade.pnl < 0 ? 'loss' : 'even';
        if (current?.outcome === outcome) {
            current.count++; current.pnl = current.pnl === null ? null : finiteNumber(current.pnl + trade.pnl); current.to = trade.exitTime; current.lastTrade = trade.index + 1;
        } else {
            current = { outcome, count: 1, pnl: trade.pnl, from: trade.entryTime, to: trade.exitTime, firstTrade: trade.index + 1, lastTrade: trade.index + 1 };
            result.push(current);
        }
    }
    return result;
}

export function observedEquityPhases(points: readonly EquityPoint[]): EquityPhase[] {
    const phases: EquityPhase[] = []; let phase: EquityPhase | undefined;
    for (let index = 1; index < points.length; index++) {
        const previous = points[index - 1]!; const point = points[index]!; const change = finiteNumber(point.value - previous.value);
        if (change === null || point.time < previous.time) { phase = undefined; continue; }
        if (change === 0) { if (phase) phase.to = point.time; continue; }
        const direction = change > 0 ? 'growth' : 'decline';
        if (phase?.direction === direction && finiteNumber(phase.amount + Math.abs(change)) !== null) {
            phase.amount += Math.abs(change); phase.to = point.time; phase.observations++;
        } else {
            phase = { direction, from: previous.time, to: point.time, amount: Math.abs(change), observations: 1 }; phases.push(phase);
        }
    }
    return phases;
}

export function analyzeStrategy(snapshot: StrategyResultsSnapshot): StrategyAnalysis {
    const account = normalizeAccount(snapshot.state);
    const closedTrades = snapshot.trades.map((trade, index) => ({ trade, index })).filter(({ trade }) => !trade.open && trade.exit).map(({ trade, index }) => normalizeTrade(trade, index))
        .sort((a, b) => (a.exitTime ?? Infinity) - (b.exitTime ?? Infinity));
    let cumulative: number | null = 0;
    for (const trade of closedTrades) {
        cumulative = cumulative !== null && trade.pnl !== null && trade.exitTime !== null && trade.durationMs !== null ? finiteNumber(cumulative + trade.pnl) : null;
        trade.cumulativePnl = cumulative;
    }
    const unknownPnlTrades = closedTrades.filter(trade => trade.pnl === null).length;
    const invalidTimeTrades = closedTrades.filter(trade => trade.durationMs === null).length;
    const warnings = [...(snapshot.warnings ?? [])];
    if (unknownPnlTrades) warnings.push(`${unknownPnlTrades} closed trade(s) have unavailable P&L. Ledger metrics use known results; closed equity stops at the first gap.`);
    if (invalidTimeTrades) warnings.push(`${invalidTimeTrades} closed trade(s) have unavailable or inconsistent fill times; their durations and equity chronology are unavailable.`);
    if (account.initialCapital === null) warnings.push('Initial capital is unavailable; closed-trade account equity and return percentages are unavailable.');
    const closedEquity = closedSeries(closedTrades, account.initialCapital, snapshot.from);
    let equity = closedEquity;
    if (snapshot.equity?.length) {
        const valid = snapshot.equity.filter(point => timestamp(point.time) !== null && finiteNumber(point.value) !== null)
            .map(point => ({ time: point.time, value: point.value })).sort((a, b) => a.time - b.time);
        const points = valid.filter((point, index) => valid[index + 1]?.time !== point.time);
        if (valid.length !== snapshot.equity.length) warnings.push('Invalid account-equity samples were omitted; the supplied curve is incomplete.');
        if (points.length) {
            const from = timestamp(snapshot.from);
            const to = timestamp(snapshot.to);
            const complete = valid.length === snapshot.equity.length && points.length >= 2 && from !== null && to !== null && to >= from && points[0]!.time <= from && points[points.length - 1]!.time >= to;
            equity = equitySeries(points, 'actual', complete);
            if (!complete) warnings.push('The supplied account-equity samples do not establish complete coverage of the requested period. Sampled drawdown can miss unobserved extremes.');
        }
        else warnings.push('The supplied account-equity curve contains no valid samples; showing closed-trade equity when available.');
    }
    if (equity.source === 'closed-trades') warnings.push('Closed-trade equity includes realized trade P&L only. It does not include open-position or intrabar account changes. Official account drawdown is a separate metric.');
    return {
        account, all: performance(closedTrades, account.initialCapital, snapshot.from),
        long: performance(closedTrades.filter(trade => trade.side === 'long'), account.initialCapital, snapshot.from),
        short: performance(closedTrades.filter(trade => trade.side === 'short'), account.initialCapital, snapshot.from),
        closedTrades, openTrades: snapshot.trades.length - closedTrades.length, unknownPnlTrades, invalidTimeTrades,
        equity, closedEquity, daily: aggregatePeriods(closedTrades, 'day'), weekday: pattern(closedTrades, 'exitTime', 'weekday'),
        pnlDistribution: distribution(closedTrades.flatMap(trade => trade.pnl === null ? [] : [trade.pnl])),
        durationDistribution: distribution(closedTrades.flatMap(trade => trade.durationMs === null ? [] : [trade.durationMs])),
        streaks: tradeStreaks(closedTrades), entryPatterns: { hour: pattern(closedTrades, 'entryTime', 'hour'), weekday: pattern(closedTrades, 'entryTime', 'weekday'), month: pattern(closedTrades, 'entryTime', 'month') },
        equityPhases: observedEquityPhases(equity.points),
        warnings,
    };
}

function csv(rows: readonly (readonly (string | number | null)[])[]): string {
    return rows.map(row => row.map(value => {
        if (value === null || (typeof value === 'number' && !Number.isFinite(value))) return '';
        const raw = typeof value === 'number' ? String(Object.is(value, -0) ? 0 : value) : /^[=+@\-\t\r]/.test(value) ? `'${value}` : value;
        return /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
    }).join(',')).join('\r\n');
}

/** Export both fills in displayed order; totals retain their original ledger chronology. */
export function strategyTradesCsv(snapshot: StrategyResultsSnapshot, indices = snapshot.trades.map((_, index) => index)): string {
    const normalized = new Map(analyzeStrategy(snapshot).closedTrades.map(trade => [trade.index, trade]));
    const iso = (time: unknown): string | null => timestamp(time) === null ? null : new Date(time as number).toISOString();
    const rows: (string | number | null)[][] = [['Trade #', 'Type', 'Date/time (UTC)', 'Signal', 'Price', 'Position size', 'Net P&L', 'Run-up', 'Drawdown', 'Cumulative P&L', 'Commission', 'Elapsed duration (ms)']];
    for (const index of indices) {
        const trade = snapshot.trades[index]; if (!trade) continue;
        const item = normalized.get(index); const open = trade.open || !trade.exit;
        const metrics = [magnitude(trade.qty), open ? null : finiteNumber(trade.pnl), magnitude(trade.maxRunup), magnitude(trade.maxDrawdown) === null ? null : -trade.maxDrawdown!, item?.cumulativePnl ?? null, magnitude(trade.commission), item?.durationMs ?? null];
        rows.push([index + 1, `${open ? 'Open' : 'Exit'} ${trade.side}`, open ? null : iso(trade.exit?.time), open ? 'Open' : [trade.exit?.id, trade.exit?.comment].filter(Boolean).join(' · '), open ? null : finiteNumber(trade.exit?.price), ...metrics]);
        rows.push([index + 1, `Entry ${trade.side}`, iso(trade.entry.time), [trade.entry.id, trade.entry.comment].filter(Boolean).join(' · '), finiteNumber(trade.entry.price), ...metrics]);
    }
    return csv(rows);
}

export function strategyMetricsCsv(analysis: StrategyAnalysis): string {
    const keys: [string, keyof PerformanceMetrics][] = [['Closed trades', 'count'], ['Trades with reported P&L', 'knownPnlCount'], ['Net P&L after reported commission', 'netPnl'], ['Positive net outcomes', 'grossProfit'], ['Negative net outcomes (magnitude)', 'grossLoss'], ['Profit factor', 'profitFactor'], ['Profitable trades (fraction)', 'winRate'], ['Return on initial capital (fraction)', 'returnPct'], ['Reported commission', 'commission'], ['Closed-equity maximum drawdown', 'maxDrawdown'], ['Average trade', 'averagePnl'], ['Average winning trade', 'averageWin'], ['Average losing trade (magnitude)', 'averageLoss'], ['Largest winning trade', 'largestWin'], ['Largest losing trade (magnitude)', 'largestLoss'], ['Average elapsed duration (ms)', 'averageDurationMs']];
    return csv([['Metric', 'All', 'Long', 'Short'], ['Engine realized net P&L', analysis.account.netPnl, null, null], ['Engine account maximum drawdown', analysis.account.maxDrawdown, null, null], ...keys.map(([label, key]) => [label, ...[analysis.all, analysis.long, analysis.short].map(metrics => metrics[key] as number | null)])]);
}

export interface MonteCarloOptions {
    mode: 'resample' | 'shuffle';
    runs: number;
    seed: number | string;
    initialCapital: number;
    ruinThreshold?: number;
    signal?: AbortSignal;
    onProgress?: (completed: number, total: number) => void;
}
export interface MonteCarloResult {
    mode: MonteCarloOptions['mode'];
    runs: number;
    tradesPerRun: number;
    seed: number | string;
    finalP5: number | null;
    finalMedian: number | null;
    finalP95: number | null;
    maxDrawdownP95: number | null;
    probabilityOfProfit: number | null;
    ruinProbability: number | null;
    longestLossStreakP95: number | null;
    longestLossStreakMax: number | null;
    drawdownBasis: 'mae-adjusted' | 'closed-trades' | 'partial-mae';
    finalEquities: number[];
    maxDrawdowns: number[];
    curve: { step: number; p5: number; median: number; p95: number }[];
    warnings: string[];
}

export const MONTE_CARLO_LIMITS = Object.freeze({ runs: 1000, trades: 5000, checkpoints: 101 });

function randomSource(seed: number | string): () => number {
    const text = String(seed);
    let state = 2166136261;
    for (let index = 0; index < text.length; index += 1) state = Math.imul(state ^ text.charCodeAt(index), 16777619);
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        const error = new Error('Simulation cancelled.');
        error.name = 'AbortError';
        throw error;
    }
}

async function yieldToHost(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    throwIfAborted(signal);
}

/** Resamples official net P&L; no price fills, fees, leverage or position sizes are invented. */
export async function runMonteCarlo(trades: readonly StrategyTrade[], options: MonteCarloOptions): Promise<MonteCarloResult> {
    throwIfAborted(options.signal);
    if (options.mode !== 'resample' && options.mode !== 'shuffle') throw new RangeError('Choose resample or shuffle.');
    if (!Number.isFinite(options.runs) || options.runs < 1) throw new RangeError('Runs must be a positive finite number.');
    if (!Number.isFinite(options.initialCapital) || options.initialCapital <= 0) throw new RangeError('A positive finite initial capital is required.');
    if (typeof options.seed !== 'string' && !Number.isFinite(options.seed)) throw new RangeError('A finite number or string seed is required.');
    const ruinThreshold = options.ruinThreshold ?? 0;
    if (!Number.isFinite(ruinThreshold)) throw new RangeError('Ruin threshold must be finite.');
    const runs = Math.min(MONTE_CARLO_LIMITS.runs, Math.floor(options.runs));
    options.onProgress?.(0, runs);
    await yieldToHost(options.signal);
    const selected: { pnl: number; mae: number | null }[] = [];
    let eligible = 0;
    let unknown = 0;
    let operations = 0;
    for (const trade of trades) {
        if (!trade.open && trade.exit) {
            const pnl = finiteNumber(trade.pnl);
            if (pnl === null) unknown += 1;
            else {
                selected[eligible % MONTE_CARLO_LIMITS.trades] = { pnl, mae: magnitude(trade.maxDrawdown) };
                eligible += 1;
            }
        }
        if (++operations >= 8192) { operations = 0; await yieldToHost(options.signal); }
    }
    if (!selected.length) throw new RangeError('Simulation requires at least one closed trade with finite P&L.');
    // Retain the last bounded ledger segment, without mutating or sorting the source.
    const offset = eligible > MONTE_CARLO_LIMITS.trades ? eligible % MONTE_CARLO_LIMITS.trades : 0;
    const sample = offset ? selected.slice(offset).concat(selected.slice(0, offset)) : selected;
    const count = sample.length;
    const knownMae = sample.filter(trade => trade.mae !== null).length;
    const drawdownBasis = knownMae === count ? 'mae-adjusted' : knownMae ? 'partial-mae' : 'closed-trades';
    const warnings = ['Simulation is a serial-trade estimate using fixed official net P&L, not a new backtest or an account-equity forecast. Overlapping trades and intratrade chronology cannot be reconstructed.'];
    if (drawdownBasis !== 'mae-adjusted') warnings.push(`${count - knownMae} sampled trade(s) lack MAE; drawdown and ruin estimates cannot include their unreported adverse excursions.`);
    if (eligible > count) warnings.push(`Simulation is bounded to the last ${count} eligible trades in input ledger order (${eligible} available).`);
    if (options.runs > runs) warnings.push(`Simulation is bounded to ${runs} runs.`);
    if (unknown) warnings.push(`${unknown} closed trade(s) with unavailable P&L were excluded from simulation.`);
    const random = randomSource(options.seed);
    const checkpointCount = Math.min(count + 1, MONTE_CARLO_LIMITS.checkpoints);
    const steps = Array.from(new Set(Array.from({ length: checkpointCount }, (_, index) => Math.round(index * count / (checkpointCount - 1)))));
    const bands = steps.map(() => [] as number[]);
    const order = new Uint32Array(count);
    const finalEquities: number[] = [];
    const maxDrawdowns: number[] = [];
    const lossStreaks: number[] = [];
    let profitable = 0;
    let ruined = 0;
    for (let run = 0; run < runs; run += 1) {
        if (options.mode === 'shuffle') {
            for (let index = 0; index < count; index += 1) order[index] = index;
            for (let index = count - 1; index > 0; index -= 1) {
                const other = Math.floor(random() * (index + 1));
                const saved = order[index]!; order[index] = order[other]!; order[other] = saved;
                if (++operations >= 8192) { operations = 0; await yieldToHost(options.signal); }
            }
        }
        let balance = options.initialCapital;
        let peak = balance;
        let drawdown = 0;
        let streak = 0;
        let longest = 0;
        let ruin = balance <= ruinThreshold;
        let checkpoint = 1;
        bands[0]!.push(balance);
        for (let index = 0; index < count; index += 1) {
            const trade = sample[options.mode === 'shuffle' ? order[index]! : Math.floor(random() * count)]!;
            const trough = balance - (trade.mae ?? 0);
            drawdown = Math.max(drawdown, peak - trough);
            balance += trade.pnl;
            peak = Math.max(peak, balance);
            drawdown = Math.max(drawdown, peak - balance);
            if (!Number.isFinite(balance) || !Number.isFinite(drawdown)) throw new RangeError('Simulation arithmetic exceeds the finite number range.');
            ruin ||= trough <= ruinThreshold || balance <= ruinThreshold;
            streak = trade.pnl < 0 ? streak + 1 : 0;
            longest = Math.max(longest, streak);
            if (index + 1 === steps[checkpoint]) { bands[checkpoint]!.push(balance); checkpoint += 1; }
            if (++operations >= 8192) { operations = 0; await yieldToHost(options.signal); }
        }
        finalEquities.push(balance); maxDrawdowns.push(drawdown); lossStreaks.push(longest);
        if (balance > options.initialCapital) profitable += 1;
        if (ruin) ruined += 1;
        options.onProgress?.(run + 1, runs);
        throwIfAborted(options.signal);
    }
    const curve: MonteCarloResult['curve'] = [];
    for (let index = 0; index < steps.length; index += 1) {
        const sorted = bands[index]!.sort((a, b) => a - b);
        curve.push({ step: steps[index]!, p5: sortedPercentile(sorted, 0.05)!, median: sortedPercentile(sorted, 0.5)!, p95: sortedPercentile(sorted, 0.95)! });
        if (index % 8 === 7) await yieldToHost(options.signal);
    }
    return {
        mode: options.mode, runs, tradesPerRun: count, seed: options.seed,
        finalP5: percentile(finalEquities, 0.05), finalMedian: percentile(finalEquities, 0.5), finalP95: percentile(finalEquities, 0.95),
        maxDrawdownP95: percentile(maxDrawdowns, 0.95), probabilityOfProfit: ratio(profitable, runs), ruinProbability: ratio(ruined, runs),
        longestLossStreakP95: percentile(lossStreaks, 0.95), longestLossStreakMax: Math.max(...lossStreaks),
        drawdownBasis, finalEquities, maxDrawdowns, curve, warnings,
    };
}
