import type { Analytics, MonteCarlo, Session } from '../shared/types';
import { integer, money, object } from './validation';

export function analytics(session: Session): Analytics {
    const trades = session.trades;
    let wins = 0; let losses = 0; let grossProfit = 0; let grossLoss = 0;
    let winStreak = 0; let lossStreak = 0; let maxWinStreak = 0; let maxLossStreak = 0;
    const rValues: number[] = [];
    const hours = new Map<number, { hour: number; pnl: number; trades: number }>();
    const clock = new Intl.DateTimeFormat('en-US', { timeZone: session.config.rules.dayResetTimezone, hour: '2-digit', hourCycle: 'h23' });
    for (const trade of trades) {
        if (trade.netPnl > 0) { wins++; grossProfit += trade.netPnl; winStreak++; lossStreak = 0; }
        else if (trade.netPnl < 0) { losses++; grossLoss -= trade.netPnl; lossStreak++; winStreak = 0; }
        else { winStreak = 0; lossStreak = 0; }
        maxWinStreak = Math.max(maxWinStreak, winStreak); maxLossStreak = Math.max(maxLossStreak, lossStreak);
        if (trade.initialRisk !== undefined && trade.initialRisk > 0) rValues.push(trade.netPnl / trade.initialRisk);
        const hour = Number(clock.format(trade.exitTime));
        const row = hours.get(hour) ?? { hour, pnl: 0, trades: 0 };
        row.pnl = money(row.pnl + trade.netPnl); row.trades++; hours.set(hour, row);
    }
    const netPnl = money(trades.reduce((sum, trade) => sum + trade.netPnl, 0));
    return {
        trades: trades.length, wins, losses, winRate: trades.length ? wins / trades.length : null,
        netPnl, grossProfit: money(grossProfit), grossLoss: money(grossLoss), profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
        expectancy: trades.length ? netPnl / trades.length : null, avgWin: wins ? grossProfit / wins : 0, avgLoss: losses ? -grossLoss / losses : 0,
        avgR: rValues.length ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : null,
        maxDrawdown: session.account.maxDrawdown, maxWinStreak, maxLossStreak,
        byDay: session.days.map(day => ({ day: day.day, pnl: day.realizedPnl, trades: day.trades })),
        byHour: [...hours.values()].sort((a, b) => a.hour - b.hour),
        equityCurve: session.equityCurve.map(point => ({ ...point })),
    };
}

function quantile(sorted: number[], percentile: number): number {
    const index = (sorted.length - 1) * percentile;
    const low = Math.floor(index); const high = Math.ceil(index);
    return money(sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low));
}

/** Seeded bootstrap resampling of closed net trade results; it is not a forecast or a risk-rule replay. */
export function monteCarlo(session: Session, rawOptions: { runs?: number; tradesPerRun?: number; seed?: number } = {}): MonteCarlo {
    const options = object(rawOptions, 'Monte Carlo options');
    const runs = options.runs === undefined ? 1000 : integer(options.runs, 'Monte Carlo runs', 1, 5000);
    const count = options.tradesPerRun === undefined ? Math.max(1, Math.min(session.trades.length, 5000)) : integer(options.tradesPerRun, 'Trades per run', 1, 5000);
    const seed = options.seed === undefined ? 42 : integer(options.seed, 'Seed', 0, 4294967295);
    if (runs * count > 2000000) throw new Error('Monte Carlo is limited to 2000000 simulated trades per request');
    const initial = session.config.initialBalance;
    if (!session.trades.length) return { runs: 0, tradesPerRun: 0, seed, medianFinalBalance: initial, p05FinalBalance: initial, p95FinalBalance: initial, p95Drawdown: 0, probabilityOfProfit: 0, probabilityOfRuin: 0, paths: [{ step: 0, p05: initial, median: initial, p95: initial }] };
    let state = seed >>> 0;
    const random = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
    const steps = Array.from({ length: Math.min(count, 200) + 1 }, (_, index) => Math.floor(index * count / Math.min(count, 200)));
    const values = steps.map(() => [] as number[]);
    const final: number[] = []; const drawdowns: number[] = [];
    let profitable = 0; let ruined = 0;
    for (let run = 0; run < runs; run++) {
        let balance = initial; let peak = initial; let drawdown = 0; let ruin = false; let next = 1;
        values[0]!.push(initial);
        for (let step = 1; step <= count; step++) {
            const trade = session.trades[Math.floor(random() * session.trades.length)]!;
            balance = money(balance + trade.netPnl); peak = Math.max(peak, balance); drawdown = Math.max(drawdown, peak - balance);
            if (balance <= 0) ruin = true;
            if (step === steps[next]) { values[next]!.push(balance); next++; }
        }
        final.push(balance); drawdowns.push(money(drawdown));
        if (balance > initial) profitable++; if (ruin) ruined++;
    }
    final.sort((a, b) => a - b); drawdowns.sort((a, b) => a - b);
    return {
        runs, tradesPerRun: count, seed, medianFinalBalance: quantile(final, 0.5), p05FinalBalance: quantile(final, 0.05), p95FinalBalance: quantile(final, 0.95),
        p95Drawdown: quantile(drawdowns, 0.95), probabilityOfProfit: profitable / runs, probabilityOfRuin: ruined / runs,
        paths: values.map((column, index) => { column.sort((a, b) => a - b); return { step: steps[index]!, p05: quantile(column, 0.05), median: quantile(column, 0.5), p95: quantile(column, 0.95) }; }),
    };
}
