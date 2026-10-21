import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker as NodeWorker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReplayServer } from '../server/index';
import { checksum } from '../server/data';
import { DeepHistoryService, validateDeepHistory } from '../server/deep-history';
import type { DeepHistoryResponse, DeepSeriesResponse } from '../shared/deep-backtest';
import { DEFAULT_RULES, type Bar, type Schema, type SessionView } from '../shared/types';
import { replaySymbolInfo } from '../shared/symbol-info';
import { runPineBacktest } from '../scripting/backtest';
import { loadPineWorkerSource } from '../scripting/worker-source.mjs';

const BASE = Date.UTC(2024, 3, 8);
const apps: Awaited<ReturnType<typeof createReplayServer>>[] = [];
const directories: string[] = [];
const services: DeepHistoryService[] = [];
const pineWorkers: NodeWorker[] = [];
afterEach(async () => {
    await Promise.all(pineWorkers.splice(0).map((worker) => worker.terminate()));
    await Promise.all(services.splice(0).map((service) => service.close()));
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const directory of directories.splice(0)) {
        const target = resolve(directory);
        if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('vela-deep-test-')) throw new Error('Unexpected deep history fixture path.');
        rmSync(target, { recursive: true, force: true });
    }
});
function bar(time: number, close: number): Bar { return { time, open: close, high: close + 1, low: close - 1, close, volume: 1 }; }
async function setup(schema: Schema = 'ohlcv-1m', count = 6, managed = false) {
    const directory = mkdtempSync(join(tmpdir(), 'vela-deep-test-')); directories.push(directory);
    const provider = vi.fn(async () => { throw new Error('Deep history must not contact a provider.'); });
    const app = await createReplayServer({ dataDirectory: directory, port: 0, apiKey: 'private-deep-fixture-key', fetch: provider, ...(managed ? { runtime: { mode: 'run' as const, version: 'deep-test' } } : {}) }); apps.push(app);
    const url = await app.listen(); const { token } = await (await fetch(url + '/api/bootstrap')).json() as { token: string };
    const post = (path: string, input: unknown, signal?: AbortSignal) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify(input), signal });
    const interval = schema === 'ohlcv-1s' ? 1000 : 60000;
    const bars = Array.from({ length: count }, (_, index) => bar(BASE + index * interval, 18000 + index * 0.25));
    const anchor = app.store.addDataset({ name: 'Deep anchor', symbol: 'NQM4', schema, source: 'csv', bars });
    const add = (name: string, rows: Bar[], symbol = 'NQM4', sourceSchema = schema) => app.store.addDataset({ name, symbol, schema: sourceSchema, source: 'csv', bars: rows, scope: name });
    const load = (input: Record<string, unknown> = {}) => post('/api/deep-history', { datasetId: anchor.id, timeframe: interval === 1000 ? '1S' : '1', from: anchor.start, to: anchor.end, ...input });
    const series = (scopeId: string, input: Record<string, unknown> = {}) => post(`/api/deep-history/${scopeId}/series`, { symbol: 'ESM4', timeframe: '1', cutoff: bars.at(-1)!.time, ...input });
    return { app, url, token, post, anchor, add, bars, interval, load, series, provider };
}
async function pineFactory() {
    const source = await loadPineWorkerSource();
    return (): Pick<Worker, 'postMessage' | 'addEventListener' | 'terminate'> => {
        const worker = new NodeWorker(`const {parentPort}=require('node:worker_threads');
            globalThis.fetch=()=>{throw new Error('Pine cannot contact the network.');};
            globalThis.self={postMessage:(data)=>parentPort.postMessage(data),addEventListener:(kind,listener)=>parentPort.on(kind,(data)=>listener({data}))};
            ${source}`, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 192 }, execArgv: [] });
        pineWorkers.push(worker);
        return { postMessage: (message: unknown) => worker.postMessage(message),
            addEventListener: ((kind: string, listener: (event: { data?: unknown; message?: string }) => void) => {
                if (kind === 'message') worker.on('message', (data: unknown) => listener({ data }));
                else if (kind === 'error') worker.on('error', (error) => listener({ message: error.message }));
            }) as Worker['addEventListener'], terminate: () => { void worker.terminate(); } };
    };
}

describe('explicit deep cached history', () => {
    it('merges full cached partitions independently of the replay cursor and records all primary checksums', async () => {
        const ctx = await setup();
        const extra = ctx.add('Next partition', [ctx.bars[5]!, bar(BASE + 360000, 18002), bar(BASE + 420000, 18003)]);
        const view = await (await ctx.post('/api/sessions', { name: 'Deep cursor fixture', datasetId: ctx.anchor.id, mode: 'practice', initialBalance: 50000,
            commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 2, rules: DEFAULT_RULES })).json() as SessionView;
        const response = await ctx.load({ to: BASE + 480000 }); expect(response.status).toBe(200);
        const result = await response.json() as DeepHistoryResponse;
        expect(result.bars).toEqual([...ctx.bars, bar(BASE + 360000, 18002), bar(BASE + 420000, 18003)]);
        expect(result.history).toEqual({ mode: 'deep', requestedFrom: BASE, requestedTo: BASE + 480000, barCount: 8,
            sourceDatasets: [ctx.anchor, extra].map(({ id, checksum }) => ({ id, checksum })).sort((a, b) => a.id.localeCompare(b.id)), checksum: checksum(result.bars) });
        expect(result.symbolInfo).toEqual(replaySymbolInfo(ctx.anchor));
        expect(result.cursorTime).toBe(BASE + 420000); expect(result.hasMore).toBe(false);
        const ordinary = await (await fetch(`${ctx.url}/api/sessions/${view.session.id}/series?cursor=${view.session.cursor}&timeframe=1`)).json() as { bars: Bar[] };
        expect(ordinary.bars.at(-1)!.time).toBeLessThan(result.cursorTime);
        expect(ctx.provider).not.toHaveBeenCalled();
    });
    it('deduplicates identical overlap once and rejects conflicting candles without choosing a partition', async () => {
        const ctx = await setup(); ctx.add('Identical duplicate', ctx.bars.slice(2, 4));
        const response = await ctx.load(); expect(response.status).toBe(200);
        expect((await response.json() as DeepHistoryResponse).bars).toEqual(ctx.bars);
        ctx.add('Conflict', [bar(ctx.bars[3]!.time, 19000)]);
        const failed = await ctx.load(); expect(failed.status).toBe(409); expect(await failed.json()).toMatchObject({ code: 'HISTORY_CONFLICT' });
    });
    it('uses only the anchor exact contract and raw schema and preserves genuine gaps', async () => {
        const ctx = await setup();
        ctx.add('Other contract', [bar(BASE + 360000, 5000)], 'ESM4');
        ctx.add('Other raw schema', [bar(BASE + 360000, 19000)], 'NQM4', 'ohlcv-1s');
        ctx.add('Gap partition', [bar(BASE + 480000, 18004)]);
        const result = await (await ctx.load({ to: BASE + 540000 })).json() as DeepHistoryResponse;
        expect(result.bars.map((item) => item.time)).toEqual([...ctx.bars.map((item) => item.time), BASE + 480000]);
        expect(result.history.sourceDatasets).toHaveLength(2); expect(result.bars.at(-1)!.close).toBe(18004);
    });
    it('enforces inclusive start and exclusive end using full source closes before aggregation', async () => {
        const ctx = await setup();
        const result = await (await ctx.load({ from: BASE + 60000, to: BASE + 210000 })).json() as DeepHistoryResponse;
        expect(result.bars.map((item) => item.time)).toEqual([BASE + 60000, BASE + 120000]);
        expect(result.cursorTime).toBe(BASE + 120000);
        const grouped = await (await ctx.load({ timeframe: '5', to: BASE + 210000 })).json() as DeepHistoryResponse;
        expect(grouped.bars).toEqual([{ ...ctx.bars[0], high: ctx.bars[2]!.high, close: ctx.bars[2]!.close, volume: 3 }]);
        expect((await ctx.load({ from: BASE + 1000, to: BASE + 59000 })).status).toBe(404);
    });
    it('retains both intersecting partial buckets using only closed source candles inside the selected window', async () => {
        const ctx = await setup(); const start = BASE + 14 * 3600000;
        const rows = Array.from({ length: 180 }, (_, index) => bar(start + index * 60000, 18000 + index));
        const dataset = ctx.add('Partial-hour source', rows);
        const from = start + 30 * 60000; const to = start + 150 * 60000 + 30000;
        const response = await ctx.load({ datasetId: dataset.id, timeframe: '60', from, to }); expect(response.status).toBe(200);
        const result = await response.json() as DeepHistoryResponse;
        expect(result.bars).toEqual([
            { time: start, open: rows[30]!.open, high: rows[59]!.high, low: rows[30]!.low, close: rows[59]!.close, volume: 30 },
            { time: start + 3600000, open: rows[60]!.open, high: rows[119]!.high, low: rows[60]!.low, close: rows[119]!.close, volume: 60 },
            { time: start + 7200000, open: rows[120]!.open, high: rows[149]!.high, low: rows[120]!.low, close: rows[149]!.close, volume: 30 },
        ]);
        expect(result).toMatchObject({ from, to, cursorTime: rows[149]!.time, history: { requestedFrom: from, requestedTo: to, barCount: 3 } });
        const saved = await ctx.post('/api/backtests', { name: 'Partial bucket result', snapshot: {
            scriptVersion: 0, source: 'strategy("Partial fixture")', symbol: dataset.symbol, timeframe: '60', datasetId: dataset.id,
            datasetChecksum: dataset.checksum, from, to, inputs: {}, properties: {}, engine: { pinets: '0.12.0' }, history: result.history,
            result: { trades: [{ entry: { time: start, price: rows[30]!.open }, exit: { time: start + 7200000, price: rows[149]!.close } }] },
        } });
        expect(saved.status).toBe(200);
    });
    it.each(['D', 'W', 'M'])('retains the first partial %s secondary bucket in the eligible scoped prefix', async timeframe => {
        const ctx = await setup(); const start = BASE + 14.5 * 3600000;
        const rows = Array.from({ length: 4 }, (_, index) => bar(start + index * 60000, 18000 + index));
        const dataset = ctx.add('Mid-period source', rows);
        const result = await (await ctx.load({ datasetId: dataset.id, from: start, to: start + 240000 })).json() as DeepHistoryResponse;
        const secondary = await (await ctx.series(result.scopeId, { symbol: 'NQM4', timeframe, cutoff: start + 60000 })).json() as DeepSeriesResponse;
        const bucket = timeframe === 'M' ? Date.UTC(2024, 3, 1) : BASE;
        expect(secondary.bars).toEqual([{ time: bucket, open: rows[0]!.open, high: rows[1]!.high, low: rows[0]!.low, close: rows[1]!.close, volume: 2 }]);
        expect(secondary.cursorTime).toBe(rows[1]!.time);
    });
    it('freezes secondary cache membership, clamps availability and invalidates released scopes', async () => {
        const ctx = await setup('ohlcv-1s', 61);
        const es = ctx.add('Minute secondary', [bar(BASE, 8000), bar(BASE + 60000, 9000)], 'ESM4', 'ohlcv-1m');
        const primary = await (await ctx.load()).json() as DeepHistoryResponse;
        const early = await (await ctx.series(primary.scopeId, { cutoff: BASE + 1000 })).json() as DeepSeriesResponse;
        expect(early.bars).toEqual([]); expect(early.sourceDatasets).toEqual([]);
        const minute = await (await ctx.series(primary.scopeId, { cutoff: BASE + 59000 })).json() as DeepSeriesResponse;
        expect(minute.bars.map((item) => item.close)).toEqual([8000]); expect(minute.sourceDatasets).toEqual([{ id: es.id, checksum: es.checksum }]);
        expect((await ctx.series(primary.scopeId, { cutoff: BASE + 61000 })).status).toBe(400);
        ctx.add('Later import', [bar(BASE, 2000)], 'MESM4', 'ohlcv-1m');
        expect((await ctx.series(primary.scopeId, { symbol: 'MESM4' })).status).toBe(404);
        expect((await ctx.post(`/api/deep-history/${primary.scopeId}/release`, {})).status).toBe(200);
        expect((await ctx.series(primary.scopeId)).status).toBe(410);
    });
    it('makes all closed finer secondary candles available on a minute primary clock', async () => {
        const ctx = await setup('ohlcv-1m', 2);
        const seconds = Array.from({ length: 120 }, (_, index) => bar(BASE + index * 1000, 5000 + index * 0.25));
        ctx.add('Second secondary', seconds, 'ESM4', 'ohlcv-1s');
        ctx.add('Second primary', seconds.map((item) => ({ ...item, open: item.open + 13000, high: item.high + 13000, low: item.low + 13000, close: item.close + 13000 })), 'NQM4', 'ohlcv-1s');
        const primary = await (await ctx.load()).json() as DeepHistoryResponse;
        const result = await (await ctx.series(primary.scopeId, { cutoff: BASE, timeframe: '1S' })).json() as DeepSeriesResponse;
        expect(result.bars).toEqual(seconds.slice(0, 60)); expect(result.cursorTime).toBe(BASE + 59000);
        const finePrimary = await (await ctx.series(primary.scopeId, { symbol: 'NQM4', cutoff: BASE, timeframe: '1S' })).json() as DeepSeriesResponse;
        expect(finePrimary.bars).toHaveLength(60); expect(finePrimary.bars.at(-1)!.close).toBe(18014.75);
        const window = await (await ctx.series(primary.scopeId, { cutoff: BASE, timeframe: '1S', from: BASE + 10000, to: BASE + 59000, limit: 2 })).json() as DeepSeriesResponse;
        expect(window.bars).toEqual(seconds.slice(58, 60)); expect(window.hasMore).toBe(true);
    });
    it('applies HA to the complete cutoff-safe scoped prefix before windows and limits', async () => {
        const ctx = await setup('ohlcv-1m', 4);
        ctx.add('HA secondary', [100, 110, 120, 8000].map((price, index) => bar(BASE + index * 60000, price)), 'ESM4');
        const primary = await (await ctx.load()).json() as DeepHistoryResponse;
        const all = await (await ctx.series(primary.scopeId, { symbol: 'ESM4;heikinashi', cutoff: BASE + 120000 })).json() as DeepSeriesResponse;
        expect(all.bars.map((item) => [item.open, item.close])).toEqual([[100, 100], [100, 110], [105, 120]]);
        const last = await (await ctx.series(primary.scopeId, { symbol: 'ESM4;heikinashi', cutoff: BASE + 120000, from: BASE + 120000, to: BASE + 120000, limit: 1 })).json() as DeepSeriesResponse;
        expect(last.bars).toEqual(all.bars.slice(-1));
        const htf = await (await ctx.series(primary.scopeId, { symbol: 'ESM4;heikinashi', cutoff: BASE + 120000, timeframe: '5' })).json() as DeepSeriesResponse;
        expect(htf.bars[0]!.close).toBe(110); expect(htf.bars[0]!.volume).toBe(3);
        expect((await ctx.series(primary.scopeId, { symbol: 'ESM4;renko' })).status).toBe(400);
    });
    it('requires the same local request authority and strict input fields as other writes', async () => {
        const ctx = await setup(); const payload = { datasetId: ctx.anchor.id, timeframe: '1', from: BASE, to: ctx.anchor.end };
        expect((await fetch(ctx.url + '/api/deep-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).status).toBe(403);
        expect((await fetch(ctx.url + '/api/deep-history', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': ctx.token, Origin: 'https://untrusted.invalid' }, body: JSON.stringify(payload) })).status).toBe(403);
        for (const input of [{ from: BASE, to: BASE }, { to: '2024-04-09' }, { sourceIntervalMs: 60000 }, { timeframe: '1S' }]) expect((await ctx.load(input)).status).toBe(400);
        expect((await ctx.post('/api/deep-history?download=true', payload)).status).toBe(400);
        expect(ctx.provider).not.toHaveBeenCalled();
    });
    it('rejects new deep jobs during update preparation while allowing scope cleanup and final result saves', async () => {
        const ctx = await setup('ohlcv-1m', 6, true);
        const deep = await (await ctx.load()).json() as DeepHistoryResponse;
        const update = randomUUID(); expect(ctx.app.runtime.prepare(update)).toBe(true);
        expect((await ctx.load()).status).toBe(503); expect((await ctx.series(deep.scopeId, { symbol: 'NQM4' })).status).toBe(503);
        expect((await ctx.post(`/api/deep-history/${deep.scopeId}/release`, {})).status).toBe(200);
        const snapshot = { scriptVersion: 0, source: 'strategy("fixture")', symbol: 'NQM4', timeframe: '1', datasetId: ctx.anchor.id,
            datasetChecksum: ctx.anchor.checksum, from: BASE, to: ctx.anchor.end, inputs: {}, properties: {}, engine: { pinets: '0.12.0' }, result: {}, history: deep.history };
        expect((await ctx.post('/api/backtests', { name: 'Final deep save', snapshot })).status).toBe(200);
        expect(ctx.app.runtime.cancel(update)).toBe(true); expect((await ctx.load()).status).toBe(200);
    });
    it('uses real calendar month and Monday week buckets in the readonly worker', async () => {
        const ctx = await setup();
        const months = ctx.add('Calendar source', [bar(Date.UTC(2024, 0, 31), 18000), bar(Date.UTC(2024, 1, 29), 18001), bar(Date.UTC(2024, 2, 1), 18002)]);
        const result = await (await ctx.load({ datasetId: months.id, timeframe: 'M', from: Date.UTC(2024, 0, 1), to: Date.UTC(2024, 3, 1) })).json() as DeepHistoryResponse;
        expect(result.bars.map((item) => item.time)).toEqual([Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1), Date.UTC(2024, 2, 1)]);
        expect(result.intervalMs).toBe(31 * 86400000);
        const week = await (await ctx.load({ timeframe: 'W' })).json() as DeepHistoryResponse;
        expect(week.bars[0]!.time).toBe(BASE); expect(week.bars[0]!.volume).toBe(6);
    });
    it('runs the actual official strategy worker against scoped cached lower-timeframe data', async () => {
        const ctx = await setup();
        const secondary = ctx.add('Official worker secondary', Array.from({ length: 360 }, (_, index) => bar(BASE + index * 1000, 5000 + index * 0.25)), 'ESM4', 'ohlcv-1s');
        const deep = await (await ctx.load()).json() as DeepHistoryResponse;
        const provenance = new Map<string, string>();
        const fetchSeriesAt = vi.fn(async (symbol: string, timeframe: string, range: { from?: number; to?: number; limit?: number }, cutoff: number) => {
            expect(cutoff).toBe(deep.cursorTime);
            const response = await ctx.series(deep.scopeId, { symbol, timeframe, cutoff, ...range }); expect(response.status).toBe(200);
            const result = await response.json() as DeepSeriesResponse;
            for (const item of result.sourceDatasets) provenance.set(item.id, item.checksum);
            expect(result.hasMore).toBe(false); return result.bars;
        });
        const result = await runPineBacktest({ source: '//@version=6\nstrategy("Deep official fixture", initial_capital=50000, margin_long=10, margin_short=10, process_orders_on_close=true, commission_type=strategy.commission.cash_per_order, commission_value=1)\nvalues = request.security_lower_tf("ESM4", "1S", close)\nif bar_index == 1 and array.size(values) == 60\n    strategy.entry("Deep entry", strategy.long, qty=1)\nif bar_index == 4\n    strategy.close("Deep entry")',
            bars: deep.bars, cutoff: deep.cursorTime, market: { symbol: 'replay:NQM4', timeframe: '1', symbolInfo: deep.symbolInfo }, fetchSeriesAt, createWorker: await pineFactory() });
        expect(fetchSeriesAt).toHaveBeenCalled(); expect(result.state).toMatchObject({ initialCapital: 50000, position: 0, netPnl: 13 });
        expect(result.trades).toHaveLength(1); expect(result.trades[0]).toMatchObject({ qty: 1, commission: 2, entry: { time: BASE + 60000 }, exit: { time: BASE + 240000 } });
        expect([...provenance]).toEqual([[secondary.id, secondary.checksum]]); expect(ctx.provider).not.toHaveBeenCalled();
    }, 15000);
    it('matches normal and Deep daily-security trade ledgers for the same mid-day cache and source range', async () => {
        const ctx = await setup(); const start = BASE + 14.5 * 3600000;
        const rows = Array.from({ length: 18 }, (_, index) => bar(start + Math.floor(index / 6) * 86400000 + index % 6 * 60000, 18000 + index));
        const dataset = ctx.add('Daily security source', rows, 'ESM4');
        const view = await (await ctx.post('/api/sessions', { name: 'Daily security comparison', datasetId: dataset.id, mode: 'practice', initialBalance: 50000,
            commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES })).json() as SessionView;
        await ctx.post(`/api/sessions/${view.session.id}/command`, { expectedRevision: 0, command: { type: 'advance', count: rows.length } });
        const route = `${ctx.url}/api/sessions/${view.session.id}/series`;
        const normal = await (await fetch(`${route}?timeframe=1&cursor=${rows.length - 1}`)).json() as DeepSeriesResponse;
        const deep = await (await ctx.load({ datasetId: dataset.id, from: dataset.start, to: dataset.end })).json() as DeepHistoryResponse;
        expect(deep.bars).toEqual(normal.bars); expect(deep.cursorTime).toBe(normal.cursorTime);
        const securitySource = '//@version=6\nstrategy("Daily scoped comparison", initial_capital=50000, margin_long=1, margin_short=1, process_orders_on_close=true)\nd = request.security(syminfo.tickerid, "D", close)\nif bar_index == 7 and not na(d)\n    strategy.entry("Daily long", strategy.long, qty=1)\nif bar_index == 10\n    strategy.close("Daily long")\nif bar_index == 13 and not na(d)\n    strategy.entry("Daily short", strategy.short, qty=1)\nif bar_index == 16\n    strategy.close("Daily short")';
        const market = { symbol: 'replay:ESM4', timeframe: '1', symbolInfo: deep.symbolInfo };
        const makeWorker = await pineFactory();
        const replaySeries = vi.fn(async (symbol: string, timeframe: string, range: { from?: number; to?: number; limit?: number }, cutoff: number) => {
            const query = new URLSearchParams({ symbol, timeframe, cutoff: String(cutoff), limit: String(range.limit ?? 250000) });
            if (range.from !== undefined) query.set('from', String(range.from));
            if (range.to !== undefined) query.set('to', String(range.to));
            const response = await fetch(`${route}?${query}`); expect(response.status).toBe(200);
            return (await response.json() as DeepSeriesResponse).bars;
        });
        const deepSeries = vi.fn(async (symbol: string, timeframe: string, range: { from?: number; to?: number; limit?: number }, cutoff: number) => {
            const response = await ctx.series(deep.scopeId, { symbol, timeframe, cutoff, ...range }); expect(response.status).toBe(200);
            return (await response.json() as DeepSeriesResponse).bars;
        });
        const ordinary = await runPineBacktest({ source: securitySource, bars: normal.bars, cutoff: normal.cursorTime!, market, createWorker: makeWorker, fetchSeriesAt: replaySeries });
        const selected = await runPineBacktest({ source: securitySource, bars: deep.bars, cutoff: deep.cursorTime, market, createWorker: makeWorker, fetchSeriesAt: deepSeries });
        expect(replaySeries).toHaveBeenCalled(); expect(deepSeries).toHaveBeenCalled();
        expect(ordinary.trades).toHaveLength(2); expect(ordinary.trades.map(trade => trade.side)).toEqual(['long', 'short']);
        expect(selected.trades).toEqual(ordinary.trades); expect(selected.state).toEqual(ordinary.state);
        expect(ctx.provider).not.toHaveBeenCalled();
    }, 15000);
    it('persists primary and secondary provenance without ephemeral scope IDs and rejects forged source metadata', async () => {
        const ctx = await setup(); const secondary = ctx.add('Saved secondary', [bar(BASE, 5000)], 'ESM4');
        const deep = await (await ctx.load()).json() as DeepHistoryResponse;
        const history = { ...deep.history, secondarySourceDatasets: [{ id: secondary.id, checksum: secondary.checksum }] };
        const snapshot = { scriptVersion: 0, source: 'strategy("fixture")', symbol: 'NQM4', timeframe: '1', datasetId: ctx.anchor.id,
            datasetChecksum: ctx.anchor.checksum, from: BASE, to: ctx.anchor.end, inputs: {}, properties: {}, engine: { pinets: '0.12.0' }, result: {}, history };
        const savedResponse = await ctx.post('/api/backtests', { name: 'Deep fixture', snapshot }); expect(savedResponse.status).toBe(200);
        const saved = await savedResponse.json() as { id: string; history: typeof history };
        expect(saved.history).toEqual(history); expect(JSON.stringify(saved)).not.toContain(deep.scopeId);
        const summaries = await (await fetch(ctx.url + '/api/backtests')).json() as { history: typeof history }[];
        expect(summaries[0]!.history).toEqual(history);
        const invalid = { ...history, secondarySourceDatasets: [{ id: secondary.id, checksum: 'f'.repeat(64) }] };
        expect((await ctx.post('/api/backtests', { name: 'Forged history', snapshot: { ...snapshot, history: invalid } })).status).toBe(409);
        expect(() => validateDeepHistory({ ...history, scopeId: deep.scopeId })).toThrow(/Unsupported/);
        expect(() => validateDeepHistory({ ...history, sourceDatasets: [history.sourceDatasets[0], history.sourceDatasets[0]] })).toThrow(/reference/);
        const wrong = { ...history, sourceDatasets: [{ id: secondary.id, checksum: secondary.checksum }] };
        expect((await ctx.post('/api/backtests', { name: 'Wrong contract', snapshot: { ...snapshot, history: wrong } })).status).toBe(400);
    });
    it('bounds and expires immutable scopes without evicting active scopes silently', async () => {
        const ctx = await setup(); let now = 0;
        const service = new DeepHistoryService(ctx.app.store, { now: () => now }); services.push(service);
        const request = { datasetId: ctx.anchor.id, timeframe: '1', from: BASE, to: ctx.anchor.end };
        const scopes: DeepHistoryResponse[] = [];
        for (let index = 0; index < 8; index++) scopes.push(JSON.parse(await service.load(request)) as DeepHistoryResponse);
        await expect(service.load(request)).rejects.toMatchObject({ status: 429 });
        now = 600001;
        await expect(service.series(scopes[0]!.scopeId, { symbol: 'NQM4', timeframe: '1', cutoff: BASE })).rejects.toMatchObject({ status: 410 });
        await expect(service.load(request)).resolves.toContain('scopeId');
    });
    it('cancels and terminates SQL workers on abort, deadline and close and keeps the server responsive', async () => {
        const ctx = await setup(); const request = { datasetId: ctx.anchor.id, timeframe: '1', from: BASE, to: ctx.anchor.end };
        const service = new DeepHistoryService(ctx.app.store); services.push(service);
        const controller = new AbortController(); const cancelled = service.load(request, controller.signal); controller.abort();
        await expect(cancelled).rejects.toMatchObject({ code: 'ABORTED' });
        await expect(service.load(request)).resolves.toContain('scopeId');
        const timed = new DeepHistoryService(ctx.app.store, { workerMs: 1 }); services.push(timed);
        await expect(timed.load(request)).rejects.toMatchObject({ code: 'DEEP_HISTORY_TIMEOUT' });
        const pending = service.load(request); const queued = service.load(request);
        const pendingCheck = expect(pending).rejects.toMatchObject({ code: 'UPDATE_PENDING' });
        const queuedCheck = expect(queued).rejects.toMatchObject({ code: 'UPDATE_PENDING' });
        await service.close(); await Promise.all([pendingCheck, queuedCheck]);
        const start = Date.now(); const loaded = ctx.load();
        expect((await fetch(ctx.url + '/api/bootstrap')).status).toBe(200);
        expect(Date.now() - start).toBeLessThan(2000); expect((await loaded).status).toBe(200);
    });
    it('propagates an actual HTTP disconnect to the running readonly cache worker', async () => {
        const ctx = await setup();
        let started!: () => void; let disconnected!: () => void;
        const beginning = new Promise<void>((resolve) => { started = resolve; });
        const stopping = new Promise<void>((resolve) => { disconnected = resolve; });
        const original = DeepHistoryService.prototype.load;
        const observation = vi.spyOn(DeepHistoryService.prototype, 'load').mockImplementation(function (this: DeepHistoryService, value, signal) {
            signal!.addEventListener('abort', disconnected, { once: true });
            const result = original.call(this, value, signal); started(); return result;
        });
        const controller = new AbortController();
        try {
            const loading = ctx.post('/api/deep-history', { datasetId: ctx.anchor.id, timeframe: '1', from: BASE, to: ctx.anchor.end }, controller.signal);
            const rejection = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
            await beginning; controller.abort(); await rejection; await stopping;
        } finally { observation.mockRestore(); }
        expect((await ctx.load()).status).toBe(200); expect(ctx.provider).not.toHaveBeenCalled();
    });
    it('rejects mutated frozen cache identities before serving a secondary snapshot', async () => {
        const ctx = await setup(); const secondary = ctx.add('Frozen identity', [bar(BASE, 5000)], 'ESM4');
        const deep = await (await ctx.load()).json() as DeepHistoryResponse;
        ctx.app.store.db.prepare('UPDATE datasets SET checksum=? WHERE id=?').run('f'.repeat(64), secondary.id);
        const response = await ctx.series(deep.scopeId); expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'HISTORY_CHANGED' });
    });
    it('streams beyond one source partition and rejects output overflow without truncating', async () => {
        const ctx = await setup('ohlcv-1s', 1);
        const rows = Array.from({ length: 250001 }, (_, index) => bar(BASE + index * 1000, 18000 + (index % 100) * 0.25));
        ctx.add('Large source A', rows.slice(0, 125000)); ctx.add('Large source B', rows.slice(125000));
        const end = BASE + rows.length * 1000;
        let beats = 0; const heartbeat = setInterval(() => { beats++; }, 5);
        try {
            const aggregated = await ctx.load({ timeframe: '1', to: end }); expect(aggregated.status).toBe(200);
            const result = await aggregated.json() as DeepHistoryResponse;
            expect(result.bars).toHaveLength(Math.ceil(rows.length / 60)); expect(result.history.sourceDatasets).toHaveLength(3);
            const oversized = await ctx.load({ timeframe: '1S', to: end }); expect(oversized.status).toBe(413);
            expect(await oversized.json()).toMatchObject({ code: 'CAPACITY_REACHED' }); expect(beats).toBeGreaterThan(5);
        } finally { clearInterval(heartbeat); }
        expect(ctx.provider).not.toHaveBeenCalled();
    }, 30000);
});
