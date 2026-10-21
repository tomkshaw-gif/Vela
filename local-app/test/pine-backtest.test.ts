import { Worker as NodeWorker } from 'node:worker_threads';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OHLCV } from '../../src/plugin';
import { runPineBacktest } from '../scripting/backtest';
import { PineWorkerBudget } from '../scripting/pine-runtime';
import { loadPineWorkerSource } from '../scripting/worker-source.mjs';

const BASE = Date.UTC(2024, 3, 8);
const data: OHLCV[] = Array.from({ length: 10 }, (_, index) => ({ time: BASE + index * 60_000,
    open: 100 + index, high: 102 + index, low: 99 + index, close: 100 + index, volume: 10 }));
const market = { symbol: 'replay:NQM4', timeframe: '1', symbolInfo: {
    ticker: 'NQM4', tickerid: 'replay:NQM4', type: 'futures', mintick: 0.25, pointvalue: 20, currency: 'USD', timezone: 'America/Chicago', session: 'extended',
} };
const source = `//@version=6
strategy("Official backtest", overlay=true, initial_capital=10000, default_qty_type=strategy.fixed, default_qty_value=1, commission_type=strategy.commission.cash_per_order, commission_value=1)
if bar_index == 1
    strategy.entry("Long", strategy.long)
if bar_index == 5
    strategy.close("Long")
plot(close)`;
const workers: NodeWorker[] = [];
let workerSource: string;
beforeAll(async () => { workerSource = await loadPineWorkerSource(); });
afterEach(async () => { await Promise.all(workers.splice(0).map((worker) => worker.terminate())); });

function createWorker(): Pick<Worker, 'postMessage' | 'addEventListener' | 'terminate'> {
    const worker = new NodeWorker(`const { parentPort } = require('node:worker_threads');
        globalThis.fetch = () => { throw new Error('Network is unavailable to scripts.'); };
        globalThis.self = { postMessage: (data) => parentPort.postMessage(data),
            addEventListener: (kind, listener) => parentPort.on(kind, (data) => listener({ data })) };
        ${workerSource}`, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 192 } });
    workers.push(worker);
    return {
        postMessage: (message: unknown) => worker.postMessage(message),
        addEventListener: ((kind: string, listener: (event: { data?: unknown; message?: string }) => void) => {
            if (kind === 'message') worker.on('message', (value: unknown) => listener({ data: value }));
            else if (kind === 'error') worker.on('error', (error) => listener({ message: error.message }));
        }) as Worker['addEventListener'],
        terminate: () => { void worker.terminate(); },
    };
}

describe('standalone official Pine backtests', () => {
    it('reports real NQ results and releases all worker resources', async () => {
        const budget = new PineWorkerBudget(1);
        const phases: string[] = [];
        const result = await runPineBacktest({ source, bars: data, market, createWorker, workerBudget: budget,
            onProgress: ({ phase, bars }) => { expect(bars).toBe(10); phases.push(phase); } });
        expect(result.state).toMatchObject({ initialCapital: 10000, position: 0, netPnl: 78, equity: 10078, wins: 1 });
        expect(result.trades).toHaveLength(1);
        expect(result.trades[0]).toMatchObject({ side: 'long', qty: 1, open: false, pnl: 78, commission: 2,
            entry: { price: 102 }, exit: { price: 106 } });
        expect(result.equity).toBeUndefined();
        expect(result.warnings.some((warning) => warning.includes('historical account-equity curve'))).toBe(true);
        expect(phases).toEqual(['compiling', 'running', 'collecting', 'done']);
        expect(budget.active).toBe(0);
    }, 15_000);

    it('honors explicit strategy property overrides', async () => {
        const result = await runPineBacktest({ source, bars: data, market, createWorker,
            props: { initial_capital: 25000, commission_value: 2 } });
        expect(result.state.initialCapital).toBe(25000);
        expect(result.trades[0]?.commission).toBe(4);
        expect(result.state.netPnl).toBe(76);
    }, 15_000);

    it.each([[10, 1, 78], [100, 0, 0]])('applies declared %i%% margin to actual 18,000-point NQ contracts', async (margin, trades, netPnl) => {
        const nqBars = data.map((bar) => ({ ...bar, open: bar.open + 17900, high: bar.high + 17900,
            low: bar.low + 17900, close: bar.close + 17900 }));
        const declared = source.replace('initial_capital=10000', `initial_capital=50000, margin_long=${margin}, margin_short=${margin}`);
        const result = await runPineBacktest({ source: declared, bars: nqBars, market, createWorker });
        expect(result.state).toMatchObject({ initialCapital: 50000, netPnl, equity: 50000 + netPnl, position: 0 });
        expect(result.trades).toHaveLength(trades);
        if (trades) expect(result.trades[0]).toMatchObject({ qty: 1, pnl: 78, commission: 2, entry: { price: 18002 }, exit: { price: 18006 } });
    }, 15_000);

    it('uses cached secondary series with the independently pinned source cursor', async () => {
        const cutoff = BASE + 9 * 60_000 + 30_000;
        const fetchSeriesAt = vi.fn(async () => data);
        await runPineBacktest({ source: source + '\nplot(request.security(syminfo.tickerid, "60", close))', bars: data, market,
            cutoff, createWorker, fetchSeriesAt });
        expect(fetchSeriesAt).toHaveBeenCalled();
        expect((fetchSeriesAt.mock.calls as unknown as [string, string, unknown, number, AbortSignal][])[0]?.[3]).toBe(cutoff);
    }, 15_000);

    it('preserves host warnings about secondary contract metadata in saved results', async () => {
        const result = await runPineBacktest({ source: source + '\nplot(request.security("ESM4", "1", close))', bars: data, market,
            createWorker, fetchSeriesAt: async () => data });
        expect(result.warnings.filter((warning) => warning.includes('syminfo'))).toHaveLength(1);
    }, 15_000);

    it('retains the real results and runtime-stub warning when a strategy calls ticker.renko', async () => {
        const result = await runPineBacktest({ source: source + '\nplot(request.security(ticker.renko(syminfo.tickerid, "ATR", 14), "1", close))',
            bars: data, market, createWorker });
        expect(result.state.netPnl).toBe(78);
        expect(result.trades).toHaveLength(1);
        expect(result.warnings.filter((warning) => warning.includes('ticker.renko') && warning.includes('ordinary candles'))).toHaveLength(1);
    }, 15_000);

    it('cancels CPU-heavy execution and frees the worker slot', async () => {
        const controller = new AbortController();
        const budget = new PineWorkerBudget(1);
        const pending = runPineBacktest({ source: source + '\nfor i = 0 to 9999\n    for j = 0 to 9999\n        value = math.sin(j)',
            bars: data, market, createWorker, workerBudget: budget, signal: controller.signal,
            onProgress: ({ phase }) => { if (phase === 'running') setTimeout(() => controller.abort(), 25); } });
        await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
        expect(budget.active).toBe(0);
    }, 15_000);

    it('rejects an indicator rather than reporting a fabricated strategy', async () => {
        await expect(runPineBacktest({ source: '//@version=6\nindicator("Only an indicator")\nplot(close)', bars: data, market, createWorker }))
            .rejects.toThrow('does not produce a strategy account');
    }, 15_000);

    it('does not start a worker for an already cancelled run', async () => {
        const controller = new AbortController(); controller.abort();
        const factory = vi.fn(createWorker);
        await expect(runPineBacktest({ source, bars: data, market, createWorker: factory, signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
        expect(factory).not.toHaveBeenCalled();
    });

    it('requires futures pricing metadata before calculating any P&L', async () => {
        await expect(runPineBacktest({ source, bars: data, market: { symbol: market.symbol, timeframe: '1' }, createWorker })).rejects.toThrow('tick size and point value');
        await expect(runPineBacktest({ source, bars: data, market: { ...market, symbolInfo: { ticker: 'NQM4', mintick: 0.25, pointvalue: 0 } }, createWorker })).rejects.toThrow('tick size and point value');
    });

    it.each([
        ['empty history', []],
        ['duplicate timestamps', [data[0]!, data[0]!]],
        ['reversed history', [...data].reverse()],
        ['non-finite price', [{ ...data[0]!, close: NaN }]],
        ['invalid high', [{ ...data[0]!, high: 0 }]],
        ['negative volume', [{ ...data[0]!, volume: -1 }]],
    ])('rejects %s before starting execution', async (_name, bars) => {
        const factory = vi.fn(createWorker);
        await expect(runPineBacktest({ source, bars, market, createWorker: factory })).rejects.toMatchObject({ kind: 'data' });
        expect(factory).not.toHaveBeenCalled();
    });
});
