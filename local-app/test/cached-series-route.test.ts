import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Worker as NodeWorker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReplayServer } from '../server/index';
import { cachedSymbolInfo, type CachedSeriesView } from '../server/cached-series';
import { DEFAULT_RULES, type Bar, type SessionView } from '../shared/types';
import { LocalPineEngine } from '../scripting/pine-runtime';
import { loadPineWorkerSource } from '../scripting/worker-source.mjs';

const BASE = Date.UTC(2024, 3, 8);
// Bounded integration-test budget for fresh SQLite fixtures and real loopback requests.
const HTTP_TEST_TIMEOUT_MS = 15_000;
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
        if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('vela-cached-route-')) throw new Error('Unexpected fixture directory.');
        rmSync(target, { recursive: true, force: true });
    }
});

async function setup(asymmetric = false) {
    const directory = mkdtempSync(join(tmpdir(), 'vela-cached-route-')); directories.push(directory);
    const provider = vi.fn(async () => { throw new Error('Cached series must never call a provider.'); });
    const app = await createReplayServer({ dataDirectory: directory, port: 0, apiKey: 'cached-route-fixture-private-key', fetch: provider }); apps.push(app);
    const url = await app.listen();
    const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json() as { token: string };
    const post = (path: string, value: unknown) => fetch(`${url}${path}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Local-Token': bootstrap.token }, body: JSON.stringify(value) });
    const bars = (offset: number): Bar[] => Array.from({ length: 120 }, (_, index) => asymmetric && index === 0
        ? { time: BASE, open: 190 + offset, high: 210 + offset, low: 180 + offset, close: 206 + offset, volume: 1 }
        : ({ time: BASE + index * 60_000,
        open: 100 + offset + index, high: index === 119 ? 9_000_000 : 102 + offset + index,
        low: 99 + offset + index, close: 101 + offset + index, volume: 1 }));
    const primary = app.store.addDataset({ name: 'NQ cached prefix', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars: bars(0) });
    const secondary = app.store.addDataset({ name: 'ES cached prefix', symbol: 'ESM4', schema: 'ohlcv-1m', source: 'csv', bars: bars(1000) });
    let view = await (await post('/api/sessions', { name: 'Pinned cached contract session', datasetId: primary.id, mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 50, rules: DEFAULT_RULES })).json() as SessionView;
    const series = (query: string) => fetch(`${url}/api/sessions/${view.session.id}/series?${query}`);
    const advance = async (count: number) => {
        const response = await post(`/api/sessions/${view.session.id}/command`, { expectedRevision: view.session.revision, command: { type: 'advance', count } });
        expect(response.status).toBe(200); view = await response.json() as SessionView;
    };
    return { app, url, primary, secondary, provider, series, advance };
}

describe('pinned cached contract HTTP gateway', { timeout: HTTP_TEST_TIMEOUT_MS }, () => {
    it('serves another cached exact contract without advancing the session or exposing future prices', async () => {
        const ctx = await setup();
        const before = ctx.app.store.sessions();
        const response = await ctx.series(`symbol=ESM4&timeframe=60&cutoff=${BASE + 49 * 60_000}&to=${BASE}`);
        expect(response.status).toBe(200);
        const result = await response.json() as CachedSeriesView;
        expect(result.datasetId).toBe(ctx.secondary.id);
        expect(result.bars).toEqual([{ time: BASE, open: 1100, high: 1151, low: 1099, close: 1150, volume: 50 }]);
        expect(result.symbolInfo).toMatchObject({ type: 'futures', pointvalue: 50, mintick: 0.25 });
        expect(result.cursorTime).toBe(BASE + 49 * 60_000);
        expect(ctx.app.store.sessions()).toEqual(before);
        expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('keeps the old secondary cutoff stable when the primary replay advances', async () => {
        const ctx = await setup(); const query = `symbol=CME:ESM4&timeframe=60&cutoff=${BASE + 49 * 60_000}&to=${BASE}`;
        const before = await (await ctx.series(query)).json();
        await ctx.advance(20);
        const after = await (await ctx.series(query)).json();
        expect(after).toEqual(before);
        const latest = await (await ctx.series('symbol=ESM4&timeframe=60&cursor=69')).json() as CachedSeriesView;
        expect(latest.bars.map((bar) => bar.close)).toEqual([1160, 1170]);
        expect(latest.bars.every((bar) => bar.high < 9_000_000)).toBe(true);
        expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('filters primary bar-open windows without truncating the source candles inside their bucket', async () => {
        const ctx = await setup();
        const response = await ctx.series(`symbol=NQM4&timeframe=60&cutoff=${BASE + 49 * 60_000}&to=${BASE}`);
        expect(response.status).toBe(200);
        const result = await response.json() as CachedSeriesView;
        expect(result.bars).toEqual([{ time: BASE, open: 100, high: 151, low: 99, close: 150, volume: 50 }]);
        expect(result.cursorTime).toBe(BASE + 49 * 60_000);
    });

    it('serves actual primary and secondary Heikin Ashi prices rather than dropping ticker modifiers', async () => {
        const ctx = await setup(true);
        for (const [symbol, close] of [['replay:NQM4;heikinashi', 196.5], ['CME:ESM4;heikinashi', 1196.5]] as const) {
            const query = new URLSearchParams({ symbol, timeframe: '1', cutoff: String(BASE + 49 * 60_000), to: String(BASE) });
            const response = await ctx.series(query.toString()); expect(response.status).toBe(200);
            const result = await response.json() as CachedSeriesView;
            expect(result.bars).toHaveLength(1); expect(result.bars[0]?.close).toBe(close);
            expect(result.bars[0]?.volume).toBe(1);
        }
        expect(ctx.app.store.readRevealed(ctx.primary.id, 0, 0, 1)[0]?.close).toBe(206);
        expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('transforms partial higher-timeframe data after its source cutoff and keeps old windows stable', async () => {
        const ctx = await setup(true);
        const query = new URLSearchParams({ symbol: 'replay:NQM4;heikinashi', timeframe: '60', cutoff: String(BASE + 49 * 60_000), to: String(BASE) });
        const first = await (await ctx.series(query.toString())).json() as CachedSeriesView;
        expect(first.bars).toEqual([{ time: BASE, open: 170, high: 210, low: 100, close: 162.5, volume: 50 }]);
        await ctx.advance(20);
        expect(await (await ctx.series(query.toString())).json()).toEqual(first);
        expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('preserves recursive primary opens when a caller asks for a clipped window', async () => {
        const ctx = await setup(true);
        const common = { symbol: 'NQM4;heikinashi', timeframe: '1', cursor: '49' };
        const full = await (await ctx.series(new URLSearchParams(common).toString())).json() as CachedSeriesView;
        const window = await (await ctx.series(new URLSearchParams({ ...common, from: String(BASE + 10 * 60_000), to: String(BASE + 15 * 60_000), limit: '3' }).toString())).json() as CachedSeriesView;
        expect(window.bars).toEqual(full.bars.slice(10, 13));
        expect(window.bars[0]?.open).not.toBe((window.bars[0]!.close + 110) / 2);
    });

    it('accepts an explicitly extended encoded ticker and rejects unsupported adjustments or chart types', async () => {
        const ctx = await setup(true);
        const symbol = '={"session":"extended","symbol":"replay:NQM4"};heikinashi';
        const response = await ctx.series(new URLSearchParams({ symbol, timeframe: '1', cursor: '49', to: String(BASE) }).toString());
        expect(response.status).toBe(200);
        expect(((await response.json()) as CachedSeriesView).bars[0]?.close).toBe(196.5);
        for (const requested of ['NQM4;renko', 'ESM4;kagi', 'NQM4;unknown', '={"session":"regular","symbol":"NQM4"}', '={"adjustment":"splits","symbol":"ESM4"}']) {
            expect((await ctx.series(new URLSearchParams({ symbol: requested, timeframe: '1', cursor: '49' }).toString())).status).toBe(400);
        }
        expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('honors ticker.heikinashi through the actual Pine worker and pinned HTTP data gateway', async () => {
        const ctx = await setup(true);
        const workerSource = await loadPineWorkerSource();
        const worker = new NodeWorker(`const { parentPort } = require('node:worker_threads');
            globalThis.fetch = () => { throw new Error('Pine workers cannot use the network.'); };
            globalThis.self = { postMessage: (data) => parentPort.postMessage(data),
                addEventListener: (kind, listener) => parentPort.on(kind, (data) => listener({ data })) };
            ${workerSource}`, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 192 } });
        workers.push(worker);
        const seen: string[] = [];
        const engine = new LocalPineEngine({ workerUrl: '/local-pine-worker.js', cutoff: () => BASE + 49 * 60_000,
            createWorker: () => ({ postMessage: (message: unknown) => worker.postMessage(message),
                addEventListener: ((kind: string, listener: (event: { data?: unknown; message?: string }) => void) => {
                    if (kind === 'message') worker.on('message', (data: unknown) => listener({ data }));
                    else if (kind === 'error') worker.on('error', (error) => listener({ message: error.message }));
                }) as Worker['addEventListener'], terminate: () => { void worker.terminate(); } }),
            fetchSeriesAt: async (symbol, timeframe, range, cutoff) => {
                seen.push(symbol);
                const query = new URLSearchParams({ symbol, timeframe, cutoff: String(cutoff), limit: String(range.limit ?? 250000) });
                if (range.from !== undefined) query.set('from', String(range.from));
                if (range.to !== undefined) query.set('to', String(range.to));
                const response = await ctx.series(query.toString());
                if (!response.ok) throw new Error(`Cached fixture returned ${response.status}.`);
                return ((await response.json()) as CachedSeriesView).bars;
            } });
        engines.push(engine);
        const prepared = await engine.prepare('//@version=6\nindicator("Derived ticker proof")\nplot(close, title="Raw")\nplot(request.security(ticker.heikinashi(syminfo.tickerid), "1", close), title="Derived")', 'derived-proof');
        let finish: () => void; let fail: (error: unknown) => void;
        const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
        const session = engine.execute({ prepared, bars: ctx.app.store.readRevealed(ctx.primary.id, 49, 0, 50),
            market: { symbol: 'replay:NQM4', timeframe: '1', symbolInfo: cachedSymbolInfo(ctx.primary) }, mode: 'static' },
            { onModel: () => {}, onDone: () => finish(), onError: (error) => fail(error) });
        await done;
        const context = await session.getContext?.(['plots']);
        expect(seen.some((symbol) => symbol.endsWith(';heikinashi'))).toBe(true);
        expect(context?.plots.Raw?.[0]?.value).toBe(206);
        expect(context?.plots.Derived?.[0]?.value).toBe(196.5);
        expect(context?.plots.Derived?.at(-1)?.value).toBe(149.5);
        expect(ctx.provider).not.toHaveBeenCalled();
    }, 15000);

    it('rejects future clocks and data aliases rather than opening an external provider', async () => {
        const ctx = await setup();
        for (const query of [`symbol=ESM4&timeframe=60&cutoff=${BASE + 50 * 60_000}`, 'symbol=ESM4&timeframe=60&cursor=50',
            'symbol=ES1!&timeframe=60&cursor=49', 'symbol=ES&timeframe=60&cursor=49', 'symbol=ESM4&timeframe=1S&cursor=49',
            'symbol=ESM4&symbol=NQM4&timeframe=60&cursor=49']) expect((await ctx.series(query)).status, query).toBe(400);
        expect((await ctx.series('symbol=ESU4&timeframe=60&cursor=49')).status).toBe(404);
        expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('does not reveal a cached secondary candle before the first primary source bar', async () => {
        const ctx = await setup();
        expect((await ctx.series('symbol=ESM4&timeframe=60&cursor=-1')).status).toBe(400);
        expect((await ctx.series(`symbol=ESM4&timeframe=60&cutoff=${BASE - 1}`)).status).toBe(400);
        expect(ctx.provider).not.toHaveBeenCalled();
    });
});
