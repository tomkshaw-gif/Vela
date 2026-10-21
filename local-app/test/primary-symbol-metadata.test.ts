import { Worker as NodeWorker } from 'node:worker_threads';
import { afterEach, expect, it } from 'vitest';
import { replaySymbolInfo } from '../shared/symbol-info';
import { cachedSymbolInfo } from '../server/cached-series';
import type { DatasetMeta } from '../shared/types';
import { LocalPineEngine } from '../scripting/pine-runtime';
import { runPineBacktest } from '../scripting/backtest';
import { loadPineWorkerSource } from '../scripting/worker-source.mjs';

const workers: NodeWorker[] = [];
afterEach(async () => { await Promise.all(workers.splice(0).map((worker) => worker.terminate())); });

it('uses identical primary metadata for actual chart execution and standalone backtesting', async () => {
    const workerSource = await loadPineWorkerSource();
    const createWorker = (): Pick<Worker, 'postMessage' | 'addEventListener' | 'terminate'> => {
        const worker = new NodeWorker(`const { parentPort } = require('node:worker_threads');
            globalThis.fetch = () => { throw new Error('No network.'); };
            globalThis.self = { postMessage: (data) => parentPort.postMessage(data),
                addEventListener: (_kind, listener) => parentPort.on('message', (data) => listener({ data })) };
            ${workerSource}`, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 192 } });
        workers.push(worker);
        return { postMessage: (message: unknown) => worker.postMessage(message),
            addEventListener: ((kind: string, listener: (event: { data?: unknown; message?: string }) => void) => {
                if (kind === 'message') worker.on('message', (data: unknown) => listener({ data }));
                if (kind === 'error') worker.on('error', (error) => listener({ message: error.message }));
            }) as Worker['addEventListener'], terminate: () => { void worker.terminate(); } };
    };
    const dataset = { symbol: 'NQM4', instrument: { root: 'NQ', tickSize: 0.25, pointValue: 20 } } as DatasetMeta;
    const chartMetadata = replaySymbolInfo(dataset), backtestMetadata = cachedSymbolInfo(dataset);
    expect(chartMetadata).toEqual(backtestMetadata);
    const bars = Array.from({ length: 10 }, (_, index) => ({ time: Date.UTC(2024, 3, 8) + index * 60_000,
        open: 100 + index, high: 102 + index, low: 99 + index, close: 100 + index, volume: 10 }));
    const source = `//@version=6
strategy("Primary metadata", initial_capital=10000, default_qty_type=strategy.fixed, default_qty_value=1, commission_type=strategy.commission.cash_per_order, commission_value=1)
metadata_ok = syminfo.root == "NQ" and syminfo.prefix == "CME" and syminfo.main_tickerid == "replay:NQM4"
plot(syminfo.root == "NQ" ? 1 : 0, "Root")
plot(syminfo.prefix == "CME" ? 1 : 0, "Prefix")
plot(syminfo.main_tickerid == "replay:NQM4" ? 1 : 0, "Main ticker")
if bar_index == 1 and metadata_ok
    strategy.entry("Long", strategy.long)
if bar_index == 5
    strategy.close("Long")`;
    const market = { symbol: 'replay:NQM4', timeframe: '1', symbolInfo: chartMetadata };
    const runtime = new LocalPineEngine({ workerUrl: '/local-pine-worker.js', cutoff: () => bars.at(-1)!.time, createWorker });
    try {
        const prepared = await runtime.prepare(source, 'metadata-proof');
        let finish: () => void, fail: (error: unknown) => void;
        const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
        const session = runtime.execute({ prepared, bars, market, mode: 'static' }, { onModel: () => {}, onDone: () => finish(), onError: (error) => fail(error) });
        await done;
        const context = await session.getContext?.(['plots', 'strategy', 'trades']);
        for (const title of ['Root', 'Prefix', 'Main ticker']) expect(context?.plots[title]?.at(-1)?.value).toBe(1);
        const backtest = await runPineBacktest({ source, bars, market: { ...market, symbolInfo: backtestMetadata }, createWorker });
        expect(context?.strategy?.netPnl).toBe(78);
        expect(backtest.state.netPnl).toBe(78);
        expect(backtest.trades).toEqual(context?.trades);
    } finally { runtime.dispose(); }
}, 20_000);
