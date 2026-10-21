import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Worker as NodeWorker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReplayServer } from '../server/index';
import type { CachedSeriesView } from '../server/cached-series';
import { cachedSymbolInfo } from '../server/cached-series';
import { DEFAULT_RULES, type Bar, type SessionView } from '../shared/types';
import { LocalPineEngine } from '../scripting/pine-runtime';
import { loadPineWorkerSource } from '../scripting/worker-source.mjs';
import { runPineBacktest } from '../scripting/backtest';
import type { EngineContextSnapshot } from '../../src/plugin';

const BASE = Date.UTC(2024, 3, 8);
const apps: Awaited<ReturnType<typeof createReplayServer>>[] = [];
const directories: string[] = [];
const engines: LocalPineEngine[] = [];
const workers: NodeWorker[] = [];
afterEach(async () => {
    for (const engine of engines.splice(0)) engine.dispose();
    await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
    for (const app of apps.splice(0)) await app.close();
    for (const directory of directories.splice(0)) {
        const target = resolve(directory);
        if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('vela-mixed-clock-')) throw new Error('Unexpected fixture directory.');
        rmSync(target, { recursive: true, force: true });
    }
});
function bar(time: number, close: number): Bar { return { time, open: close, high: close + 1, low: close - 1, close, volume: 1 }; }
async function setup(direction: 'fine-to-coarse' | 'coarse-to-fine', withPrior = true) {
    const directory = mkdtempSync(join(tmpdir(), 'vela-mixed-clock-')); directories.push(directory);
    const provider = vi.fn(async () => { throw new Error('Mixed-clock fixtures cannot contact providers.'); });
    const app = await createReplayServer({ dataDirectory: directory, port: 0, apiKey: 'mixed-clock-test-private-key', fetch: provider }); apps.push(app);
    const url = await app.listen(); const { token } = await (await fetch(`${url}/api/bootstrap`)).json() as { token: string };
    const post = (path: string, input: unknown) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify(input) });
    const fine = direction === 'fine-to-coarse';
    const primaryBars = fine ? Array.from({ length: 182 }, (_, index) => bar(BASE - 120000 + index * 1000, 18000 + index * 0.25))
        : [-60000, 0, 60000].map((offset, index) => bar(BASE + offset, 18000 + index * 0.25));
    const primary = app.store.addDataset({ name: 'Primary source clock', symbol: 'NQM4', schema: fine ? 'ohlcv-1s' : 'ohlcv-1m', source: 'csv', bars: primaryBars });
    const secondaryBars = fine ? [-120000, -60000, 0, 60000].filter((offset) => withPrior || offset >= 0).map((offset, index) => bar(BASE + offset, offset >= 0 ? 8000 + offset / 60 : 3000 + index * 1000))
        : Array.from({ length: 180 }, (_, index) => { const second = index - 60; return bar(BASE + second * 1000, second >= 60 ? 8000 + (second - 60) * 0.25 : 5000 + second * 0.25); });
    const secondary = app.store.addDataset({ name: 'Secondary source clock', symbol: 'ESM4', schema: fine ? 'ohlcv-1m' : 'ohlcv-1s', source: 'csv', bars: secondaryBars });
    let view = await (await post('/api/sessions', { name: 'Mixed source fixture', datasetId: primary.id, mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: fine ? 122 : 2, rules: DEFAULT_RULES })).json() as SessionView;
    const cutoff = fine ? BASE + 1000 : BASE;
    const series = (params: Record<string, string>) => fetch(`${url}/api/sessions/${view.session.id}/series?${new URLSearchParams({ cutoff: String(cutoff), symbol: 'ESM4', ...params })}`);
    const advance = async (count: number) => {
        const response = await post(`/api/sessions/${view.session.id}/command`, { expectedRevision: view.session.revision, command: { type: 'advance', count } });
        expect(response.status).toBe(200); view = await response.json() as SessionView;
    };
    return { app, primary, secondary, primaryBars, secondaryBars, cutoff, series, advance, provider };
}

async function workerFactory() {
    const workerSource = await loadPineWorkerSource();
    return (): Pick<Worker, 'postMessage' | 'addEventListener' | 'terminate'> => {
        const worker = new NodeWorker(`const { parentPort } = require('node:worker_threads');
            globalThis.fetch = () => { throw new Error('Pine workers cannot use the network.'); };
            globalThis.self = { postMessage: (data) => parentPort.postMessage(data),
                addEventListener: (kind, listener) => parentPort.on(kind, (data) => listener({ data })) };
            ${workerSource}`, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 192 } });
        workers.push(worker);
        return { postMessage: (message: unknown) => worker.postMessage(message),
            addEventListener: ((kind: string, listener: (event: { data?: unknown; message?: string }) => void) => {
                if (kind === 'message') worker.on('message', (data: unknown) => listener({ data }));
                else if (kind === 'error') worker.on('error', (error) => listener({ message: error.message }));
            }) as Worker['addEventListener'], terminate: () => { void worker.terminate(); } };
    };
}

function gateway(ctx: Awaited<ReturnType<typeof setup>>) {
    return async (symbol: string, timeframe: string, range: { from?: number; to?: number; limit?: number }, cutoff: number): Promise<Bar[]> => {
        const query: Record<string, string> = { symbol, timeframe, cutoff: String(cutoff), limit: String(range.limit ?? 250000) };
        if (range.from !== undefined) query.from = String(range.from);
        if (range.to !== undefined) query.to = String(range.to);
        const response = await ctx.series(query);
        if (!response.ok) throw new Error(`Mixed-clock fixture returned ${response.status}.`);
        return ((await response.json()) as CachedSeriesView).bars;
    };
}

async function run(ctx: Awaited<ReturnType<typeof setup>>, source: string): Promise<EngineContextSnapshot> {
    const engine = new LocalPineEngine({ workerUrl: '/local-pine-worker.js', cutoff: () => ctx.cutoff, createWorker: await workerFactory(), fetchSeriesAt: gateway(ctx) });
    engines.push(engine);
    const prepared = await engine.prepare(source, 'mixed-clock-proof');
    let finish: () => void; let fail: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    const session = engine.execute({ prepared, bars: ctx.primaryBars.filter((item) => item.time <= ctx.cutoff),
        market: { symbol: 'replay:NQM4', timeframe: ctx.primary.intervalMs === 1000 ? '1S' : '1', symbolInfo: cachedSymbolInfo(ctx.primary) }, mode: 'static' },
        { onModel: () => {}, onDone: () => finish(), onError: (error) => fail(error) });
    await done;
    const context = await session.getContext?.(['plots']);
    if (!context) throw new Error('Pine did not return a context.');
    return context;
}

describe('mixed source candle availability', () => {
    it('does not expose a minute candle until its close is available on the one-second primary clock', async () => {
        const ctx = await setup('fine-to-coarse');
        const response = await ctx.series({ timeframe: '1' }); expect(response.status).toBe(200);
        const result = await response.json() as CachedSeriesView;
        expect(result.bars.map((item) => item.close)).toEqual([3000, 4000]);
        expect(result.cursorTime).toBe(BASE - 60000);
        expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('includes all sixty closed secondary seconds inside a fully revealed primary minute', async () => {
        const ctx = await setup('coarse-to-fine');
        const response = await ctx.series({ timeframe: '1S', from: String(BASE), to: String(BASE + 59000) }); expect(response.status).toBe(200);
        const result = await response.json() as CachedSeriesView;
        expect(result.bars).toHaveLength(60);
        expect(result.bars.at(-1)?.time).toBe(BASE + 59000);
        expect(result.bars.at(-1)?.close).toBe(5014.75);
        expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('returns a genuine empty series while the first cached secondary minute is still unavailable', async () => {
        const ctx = await setup('fine-to-coarse', false);
        const result = await (await ctx.series({ timeframe: '1' })).json() as CachedSeriesView;
        expect(result.bars).toEqual([]); expect(result.cursorTime).toBeNull();
    });

    it('keeps a pinned mixed-clock response unchanged after the primary clock advances', async () => {
        const ctx = await setup('fine-to-coarse');
        const before = await (await ctx.series({ timeframe: '1', limit: '1' })).json();
        await ctx.advance(58);
        expect(await (await ctx.series({ timeframe: '1', limit: '1' })).json()).toEqual(before);
        const closed = await (await ctx.series({ timeframe: '1', cutoff: String(BASE + 59000), limit: '1' })).json() as CachedSeriesView;
        expect(closed.bars.at(-1)?.close).toBe(8000);
    });

    it('applies the availability boundary before higher-timeframe, Heikin Ashi and window transforms', async () => {
        const ctx = await setup('fine-to-coarse');
        const raw = await (await ctx.series({ timeframe: '5', limit: '1', from: String(BASE - 300000), to: String(BASE) })).json() as CachedSeriesView;
        expect(raw.bars).toEqual([{ time: BASE - 300000, open: 3000, high: 4001, low: 2999, close: 4000, volume: 2 }]);
        const ha = await (await ctx.series({ symbol: 'ESM4;heikinashi', timeframe: '5', limit: '1', from: String(BASE - 300000), to: String(BASE) })).json() as CachedSeriesView;
        expect(ha.bars).toEqual([{ time: BASE - 300000, open: 3500, high: 4001, low: 2999, close: 3500, volume: 2 }]);
        const unknown = await (await ctx.series({ timeframe: '1', from: String(BASE), to: String(BASE), limit: '1' })).json() as CachedSeriesView;
        expect(unknown.bars).toEqual([]);
    });

    it('can resolve finer cached data for the same instrument while retaining its original primary minute candles', async () => {
        const ctx = await setup('coarse-to-fine');
        ctx.app.store.addDataset({ name: 'NQ exact seconds', symbol: 'NQM4', schema: 'ohlcv-1s', source: 'csv',
            bars: ctx.secondaryBars.map((item) => ({ ...item, open: item.open + 13000, high: item.high + 13000, low: item.low + 13000, close: item.close + 13000 })) });
        const response = await ctx.series({ symbol: 'NQM4', timeframe: '1S', from: String(BASE), to: String(BASE + 59000) }); expect(response.status).toBe(200);
        expect(((await response.json()) as CachedSeriesView).bars).toHaveLength(60);
        const primary = await (await ctx.series({ symbol: 'NQM4', timeframe: '1' })).json() as CachedSeriesView;
        expect(primary.bars.at(-1)?.close).toBe(18000.25);
    });

    it('keeps actual request.security lookahead_on from seeing an unfinished secondary minute', async () => {
        const ctx = await setup('fine-to-coarse');
        const context = await run(ctx, '//@version=6\nindicator("Closed secondary candles")\nplot(request.security("ESM4", "1", close, lookahead=barmerge.lookahead_on), title="Observed")');
        const points = context.plots.Observed ?? [];
        expect(Number.isNaN(points.at(-1)?.value)).toBe(true);
        expect(points.some((point) => point.value === 4000)).toBe(true);
        expect(points.every((point) => !Number.isFinite(point.value) || Number(point.value) <= 4000)).toBe(true);
        expect(ctx.provider).not.toHaveBeenCalled();
    }, 15000);

    it('preserves all sixty lower-timeframe samples through the actual worker and server boundary', async () => {
        const ctx = await setup('coarse-to-fine');
        const context = await run(ctx, '//@version=6\nindicator("Closed lower candles")\nvalues = request.security_lower_tf("ESM4", "1S", close)\nplot(array.size(values), title="Count")\nplot(array.size(values) > 0 ? array.last(values) : na, title="Last")');
        expect(context.plots.Count?.at(-1)?.value).toBe(60);
        expect(context.plots.Last?.at(-1)?.value).toBe(5014.75);
        expect(ctx.provider).not.toHaveBeenCalled();
    }, 15000);

    it('uses the same availability clock for a finer request on its own cached contract', async () => {
        const ctx = await setup('coarse-to-fine');
        ctx.app.store.addDataset({ name: 'NQ cached seconds', symbol: 'NQM4', schema: 'ohlcv-1s', source: 'csv',
            bars: ctx.secondaryBars.map((item) => ({ ...item, open: item.open + 13000, high: item.high + 13000, low: item.low + 13000, close: item.close + 13000 })) });
        const context = await run(ctx, '//@version=6\nindicator("Own lower candles")\nvalues = request.security_lower_tf(syminfo.tickerid, "1S", close)\nplot(array.size(values), title="Count")\nplot(array.size(values) > 0 ? array.last(values) : na, title="Last")');
        expect(context.plots.Count?.at(-1)?.value).toBe(60);
        expect(context.plots.Last?.at(-1)?.value).toBe(18014.75);
    }, 15000);

    it('pins standalone backtests to the same complete primary-candle availability', async () => {
        const ctx = await setup('coarse-to-fine');
        const result = await runPineBacktest({ source: '//@version=6\nstrategy("Pinned lower candles", initial_capital=50000, margin_long=10, margin_short=10, process_orders_on_close=true)\nvalues = request.security_lower_tf("ESM4", "1S", close)\nif bar_index == 1 and array.size(values) == 60\n    strategy.entry("Complete minute", strategy.long, qty=1)',
            bars: ctx.primaryBars.filter((item) => item.time <= ctx.cutoff), cutoff: ctx.cutoff,
            market: { symbol: 'replay:NQM4', timeframe: '1', symbolInfo: cachedSymbolInfo(ctx.primary) },
            fetchSeriesAt: gateway(ctx), createWorker: await workerFactory() });
        expect(result.state.position).toBe(1);
        expect(result.trades).toHaveLength(1);
        expect(result.trades[0]?.entry.time).toBe(BASE);
        expect(ctx.provider).not.toHaveBeenCalled();
    }, 15000);
});
