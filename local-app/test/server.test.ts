import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createReplayServer } from '../server/index';
import { DEFAULT_RULES } from '../shared/types';
import type { Bar, ChartView, DatasetMeta, ProviderRequest, SessionView } from '../shared/types';
import { epochMilliseconds, validateBars } from '../server/data';
import { loadDatabentoKey, saveDatabentoKey } from '../server/secrets';

const SECRET = 'server-test-secret-do-not-persist';
const START = Date.UTC(2024, 5, 3, 13, 30);
const bars: Bar[] = Array.from({ length: 30 }, (_, i) => ({ time: START + i * 60_000, open: 20000 + i, high: 20002 + i, low: 19999 + i, close: 20001 + i, volume: 50 + i }));
const apps: Awaited<ReturnType<typeof createReplayServer>>[] = [];
const dirs: string[] = [];
function temp(): string { const path = mkdtempSync(join(tmpdir(), 'vela-server-test-')); dirs.push(path); return path; }
async function setup(options: Parameters<typeof createReplayServer>[0] = {}) {
    const app = await createReplayServer({ dataDirectory: temp(), port: 0, apiKey: SECRET, ...options }); apps.push(app);
    const url = await app.listen(); const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json() as { token: string };
    const send = (path: string, data: unknown, token = bootstrap.token) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify(data) });
    const dataset = app.store.addDataset({ name: 'NQM4 test', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars });
    const create = async () => (await (await send('/api/sessions', { name: 'Test attempt', datasetId: dataset.id, mode: 'practice', initialBalance: 50000, commissionPerContractSide: 2, slippageTicks: 1, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES })).json()) as SessionView;
    return { app, url, send, dataset, create, token: bootstrap.token };
}
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('local SQLite session API', () => {
    it('saves native daily, weekly and monthly reports through HTTP and rejects unsupported periods', async () => {
        const ctx = await setup();
        const snapshot = { scriptVersion: 0, source: 'strategy("Timeframe fixture")', symbol: ctx.dataset.symbol,
            datasetId: ctx.dataset.id, datasetChecksum: ctx.dataset.checksum, from: ctx.dataset.start, to: ctx.dataset.end,
            inputs: {}, properties: {}, engine: { vela: '0.8.5' }, result: { state: {}, trades: [] } };
        for (const timeframe of ['D', 'W', 'M', '2D', '2W', '3M', '90']) {
            const response = await ctx.send('/api/backtests', { name: 'Native timeframe', snapshot: { ...snapshot, timeframe } });
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ timeframe });
        }
        for (const timeframe of ['0D', '1Y', '367D', '53W', '121M', '1S']) {
            expect((await ctx.send('/api/backtests', { name: 'Invalid timeframe', snapshot: { ...snapshot, timeframe } })).status).toBe(400);
        }
    });
    it('persists commands with compare-and-swap and resumes through a server restart', async () => {
        const first = await setup(); const created = await first.create();
        expect(created.session.cursor).toBe(-1);
        const response = await first.send(`/api/sessions/${created.session.id}/command`, { expectedRevision: 0, command: { type: 'advance', count: 4 } });
        expect(response.status).toBe(200); const saved = await response.json() as SessionView;
        expect(saved.session.cursor).toBe(3); expect(saved.session.revision).toBe(1);
        expect((await first.send(`/api/sessions/${created.session.id}/command`, { expectedRevision: 0, command: { type: 'advance', count: 4 } })).status).toBe(409);
        const directory = first.app.dataDirectory; await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
        const resumed = await setup({ dataDirectory: directory });
        const result = await (await fetch(`${resumed.url}/api/sessions/${created.session.id}`)).json() as SessionView;
        expect(result.session).toEqual(saved.session);
        expect((await resumed.send(`/api/sessions/${created.session.id}/command`, { expectedRevision: 1, command: { type: 'advance', count: 5001 } })).status).toBe(400);
    });
    it('reveals only saved bars, aggregates the partial bucket and updates it incrementally', async () => {
        const ctx = await setup(); const { session } = await ctx.create();
        const route = `/api/sessions/${session.id}`;
        const initial = await (await fetch(`${ctx.url}${route}/chart?timeframe=5m`)).json(); expect(initial.bars).toEqual([]);
        await ctx.send(`${route}/command`, { expectedRevision: 0, command: { type: 'advance', count: 2 } });
        const first = await (await fetch(`${ctx.url}${route}/chart?timeframe=5m`)).json();
        expect(first.bars).toEqual([{ time: START, open: 20000, high: 20003, low: 19999, close: 20002, volume: 101 }]);
        await ctx.send(`${route}/command`, { expectedRevision: 1, command: { type: 'advance', count: 4 } });
        const increment = await (await fetch(`${ctx.url}${route}/chart?timeframe=5m&after=${START}`)).json();
        expect(increment.bars).toHaveLength(2); expect(increment.bars[0].volume).toBe(260); expect(increment.bars[1].close).toBe(20006);
        expect(increment.cursorTime).toBe(START + 5 * 60000);
        const base = await (await fetch(`${ctx.url}${route}/chart?timeframe=1m&limit=2`)).json(); expect(base.bars.map((b: Bar) => b.time)).toEqual([START + 4 * 60000, START + 5 * 60000]); expect(base.hasMore).toBe(true);
        expect((await fetch(`${ctx.url}${route}/chart?timeframe=1s`)).status).toBe(400);
        expect((await fetch(`${ctx.url}${route}/chart?limit=5001`)).status).toBe(400);
    });
    it('signals incremental overflow after 5000 new bars so a latest-window fetch reaches the saved cursor', async () => {
        const ctx = await setup();
        const source = Array.from({ length: 10_003 }, (_, i) => {
            const open = 20000 + (i % 100) * 0.25;
            return { time: START + i * 60000, open, high: open + 0.5, low: open - 0.25, close: open + 0.25, volume: 1 };
        });
        const dataset = ctx.app.store.addDataset({ name: 'Chart window integration', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars: source });
        const created = await (await ctx.send('/api/sessions', { name: 'Long chart attempt', datasetId: dataset.id, mode: 'practice', initialBalance: 50000, commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES })).json() as SessionView;
        const route = `/api/sessions/${created.session.id}`;
        await ctx.send(`${route}/command`, { expectedRevision: 0, command: { type: 'advance', count: 1 } });
        let after = START;
        for (let revision = 1; revision <= 2; revision++) {
            const advance = await ctx.send(`${route}/command`, { expectedRevision: revision, command: { type: 'advance', count: 5000 } });
            expect(advance.status).toBe(200); const state = await advance.json() as SessionView;
            const increment = await (await fetch(`${ctx.url}${route}/chart?timeframe=1m&limit=5000&after=${after}`)).json() as ChartView;
            expect(increment.bars).toHaveLength(5000); expect(increment.hasMore).toBe(true);
            expect(increment.bars.at(-1)!.time).toBeLessThan(source[state.session.cursor]!.time);
            const latest = await (await fetch(`${ctx.url}${route}/chart?timeframe=1m&limit=5000`)).json() as ChartView;
            expect(latest.bars).toHaveLength(5000); expect(latest.bars.at(-1)).toEqual(source[state.session.cursor]);
            expect(latest.cursorTime).toBe(source[state.session.cursor]!.time);
            expect(latest.bars.every(bar => bar.time <= latest.cursorTime!)).toBe(true);
            after = latest.bars.at(-1)!.time;
        }
        const partial = await (await fetch(`${ctx.url}${route}/chart?timeframe=5m`)).json() as ChartView;
        expect(partial.bars.at(-1)).toEqual(source[10_000]);
        expect(partial.bars.at(-1)!.volume).toBe(1);
        expect(partial.cursorTime).toBe(source[10_000]!.time);
        expect(partial.bars.at(-1)!.high).toBeLessThan(source[10_001]!.high);
    });
    it('clones and restarts as separate attempts and validates backup import', async () => {
        const ctx = await setup(); const created = await ctx.create(); const route = `/api/sessions/${created.session.id}`;
        await ctx.send(`${route}/command`, { expectedRevision: 0, command: { type: 'advance', count: 3 } });
        const cloned = await (await ctx.send(`${route}/clone`, {})).json() as SessionView;
        const restarted = await (await ctx.send(`${route}/clone`, { restart: true, startIndex: 5 })).json() as SessionView;
        expect(cloned.session.id).not.toBe(created.session.id); expect(cloned.session.cursor).toBe(2); expect(restarted.session.cursor).toBe(4);
        const exported = await (await fetch(`${ctx.url}${route}/export`)).json(); expect(JSON.stringify(exported)).not.toContain(SECRET);
        const imported = await ctx.send('/api/sessions/import', exported); expect(imported.status).toBe(200);
        const importedView = await imported.json() as SessionView; expect(importedView.session.id).not.toBe(created.session.id); expect(importedView.session.cursor).toBe(2);
        exported.session.account.balance = Infinity;
        expect((await ctx.send('/api/sessions/import', exported)).status).toBe(400);
        const original = await (await fetch(`${ctx.url}${route}`)).json() as SessionView; expect(original.session.cursor).toBe(2);
    });
    it('checks every source bar in a batched advance and never fills an order on an already visible bar', async () => {
        const ctx = await setup();
        const data = [bars[0]!, { ...bars[1]!, low: 19990 }, ...bars.slice(2)];
        const dataset = ctx.app.store.addDataset({ name: 'Intrabar risk fixture', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars: data });
        const created = await (await ctx.send('/api/sessions', { name: 'Risk integration', datasetId: dataset.id, mode: 'practice', initialBalance: 50000, commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES })).json() as SessionView;
        const route = `/api/sessions/${created.session.id}/command`;
        await ctx.send(route, { expectedRevision: 0, command: { type: 'advance', count: 1 } });
        const placed = await (await ctx.send(route, { expectedRevision: 1, command: { type: 'place', order: { side: 'buy', type: 'market', qty: 1, stopLoss: 20000 } } })).json() as SessionView;
        expect(placed.session.fills).toHaveLength(0); expect(placed.session.cursor).toBe(0);
        const advanced = await (await ctx.send(route, { expectedRevision: 2, command: { type: 'advance', count: 5 } })).json() as SessionView;
        expect(advanced.session.trades).toHaveLength(1); expect(advanced.session.trades[0]!.exitTime).toBe(data[1]!.time);
        expect(advanced.session.position).toBeNull(); expect(advanced.session.cursor).toBe(5);
    });
    it('deduplicates immutable content and rejects broken tick, ordering, schema and scope imports', async () => {
        const ctx = await setup();
        const input = { symbol: 'NQM4', schema: 'ohlcv-1m', format: 'jsonl', text: bars.map(bar => JSON.stringify(bar)).join('\n') };
        const one = await (await ctx.send('/api/datasets/import', input)).json() as DatasetMeta;
        const two = await (await ctx.send('/api/datasets/import', { ...input, name: 'Ignored rename' })).json() as DatasetMeta; expect(one.id).toBe(two.id);
        expect(() => validateBars([{ ...bars[0], close: 20000.1 }], 'ohlcv-1m', 'NQM4')).toThrow();
        expect(() => validateBars([bars[1], bars[0]], 'ohlcv-1m', 'NQM4')).toThrow();
        expect(() => validateBars(bars, 'ohlcv-1m', 'NQ.c.0')).toThrow();
        const cached = ctx.app.store.readBars(one.id); expect(Object.isFrozen(cached)).toBe(true); expect(Object.isFrozen(cached[0])).toBe(true);
        expect(epochMilliseconds('1717421400000000000')).toBe(START);
        expect(() => epochMilliseconds('1717421400000000001')).toThrow();
        for (let i = 0; i < 4; i++) {
            const extra = ctx.app.store.addDataset({ name: `Cache ${i}`, symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars: bars.map(bar => ({ ...bar, time: bar.time + (i + 1) * 86400000 })) });
            ctx.app.store.readBars(extra.id);
        }
        expect(ctx.app.store.readBars(one.id)).not.toBe(cached); expect(ctx.app.store.readBars(one.id)).toEqual(bars);
    });
    it('imports raw nanosecond Databento JSONL without guessing ISO pretty prices', async () => {
        const ctx = await setup();
        const raw = bars.slice(0, 2).map(bar => ({ hd: { ts_event: (BigInt(bar.time) * 1_000_000n).toString(), instrument_id: 12345, rtype: 33 }, open: (BigInt(Math.round(bar.open * 4)) * 250_000_000n).toString(), high: (BigInt(Math.round(bar.high * 4)) * 250_000_000n).toString(), low: (BigInt(Math.round(bar.low * 4)) * 250_000_000n).toString(), close: (BigInt(Math.round(bar.close * 4)) * 250_000_000n).toString(), volume: bar.volume }));
        const response = await ctx.send('/api/datasets/import', { name: 'Raw DBN JSON', symbol: 'NQM4', schema: 'ohlcv-1m', format: 'jsonl', text: raw.map(row => JSON.stringify(row)).join('\n') });
        expect(response.status).toBe(200); const dataset = await response.json() as DatasetMeta;
        expect(ctx.app.store.readBars(dataset.id)).toEqual(bars.slice(0, 2));
        const pretty = { hd: { ts_event: new Date(START).toISOString() }, open: '20000', high: '20002', low: '19999', close: '20001', volume: 50 };
        expect(validateBars([pretty], 'ohlcv-1m', 'NQM4')[0]).toEqual(bars[0]);
        expect(() => validateBars([{ ...raw[0], open: '20000000000001' }], 'ohlcv-1m', 'NQM4')).toThrow();
        expect(() => validateBars([{ ...raw[0], hd: { ...raw[0]!.hd, ts_event: '1717421400000000001' } }], 'ohlcv-1m', 'NQM4')).toThrow();
    });
});

describe('local-only request and credential boundaries', () => {
    it('requires the private token and exact Host/Origin, rejects traversal and bounds bodies', async () => {
        const ctx = await setup();
        expect((await ctx.send('/api/datasets/demo', {}, '')).status).toBe(403);
        const wrongHost = await new Promise<number>(resolveResult => { const req = httpRequest(`${ctx.url}/api/bootstrap`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolveResult(res.statusCode!); }); req.end(); });
        expect(wrongHost).toBe(403);
        expect((await fetch(`${ctx.url}/api/bootstrap`, { headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
        expect((await fetch(`${ctx.url}/api/bootstrap`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
        const traversal = await new Promise<number>(resolveResult => { const req = httpRequest(ctx.url, { path: '/assets/%2e%2e/server/index.ts' }, res => { res.resume(); resolveResult(res.statusCode!); }); req.end(); });
        expect(traversal).toBe(400);
        const oversized = await new Promise<number>(resolveResult => { const req = httpRequest(`${ctx.url}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '500000', 'X-Local-Token': ctx.token } }, res => { res.resume(); resolveResult(res.statusCode!); }); req.end('{}'); });
        expect(oversized).toBe(413);
        const result = await fetch(`${ctx.url}/api/bootstrap`); expect(result.headers.get('access-control-allow-origin')).toBeNull(); expect(result.headers.get('content-security-policy')).toContain("connect-src 'self'");
        const raw = await result.text(); expect(raw).not.toContain(SECRET);
    });
    it('serves only the client build and keeps configured keys out of persisted session state and backups', async () => {
        const staticDirectory = temp(); mkdirSync(join(staticDirectory, 'assets')); writeFileSync(join(staticDirectory, 'index.html'), '<html>Local replay</html>'); writeFileSync(join(staticDirectory, 'assets', 'client.js'), 'console.log("local")');
        const ctx = await setup({ staticDirectory }); const created = await ctx.create();
        expect((await fetch(`${ctx.url}/`)).status).toBe(200); expect((await fetch(`${ctx.url}/assets/client.js`)).status).toBe(200);
        expect((await fetch(`${ctx.url}/server/index.ts`)).status).toBe(404); expect((await fetch(`${ctx.url}/assets/client.js.map`)).status).toBe(404);
        expect((await ctx.send(`/api/sessions/${created.session.id}/command`, { expectedRevision: 0, command: { type: 'rename', name: SECRET } })).status).toBe(400);
        expect((await ctx.send(`/api/sessions/${created.session.id}/command`, { expectedRevision: 0, command: { type: 'layout', layout: { apiKey: 'not-allowed' } } })).status).toBe(400);
        const backup = await (await fetch(`${ctx.url}/api/sessions/${created.session.id}/export`)).text(); expect(backup).not.toContain(SECRET);
        for (const file of readdirSync(ctx.app.dataDirectory)) expect(readFileSync(join(ctx.app.dataDirectory, file)).includes(Buffer.from(SECRET))).toBe(false);
    });
    it.runIf(process.platform === 'win32')('encrypts keys with current-user DPAPI without plaintext files', async () => {
        const directory = temp(); await saveDatabentoKey(directory, SECRET);
        expect(readFileSync(join(directory, 'provider-key.dpapi'), 'utf8')).not.toContain(SECRET);
        const previous = process.env.DATABENTO_API_KEY; delete process.env.DATABENTO_API_KEY;
        try { expect(await loadDatabentoKey(directory)).toBe(SECRET); } finally { if (previous !== undefined) process.env.DATABENTO_API_KEY = previous; }
    });
});

describe('zero-budget Databento download admission', () => {
    const scope: ProviderRequest = { dataset: 'GLBX.MDP3', symbol: 'NQM4', schema: 'ohlcv-1m', start: new Date(START).toISOString(), end: new Date(START + 30 * 60000).toISOString() };
    it.each(['0.01', '-1', 'null', '{}', '"0"', '1e999', 'not-json'])('refuses positive or malformed top-level quotes: %s', async raw => {
        let calls = 0; const ctx = await setup({ fetch: async () => { calls++; return new Response(raw); } });
        const result = await ctx.send('/api/provider/quote', scope); expect(result.status).not.toBe(200); expect(calls).toBe(1);
        expect(ctx.app.store.listDatasets()).toHaveLength(1);
    });
    it('re-quotes the exact zero-cost scope, parses pretty precision and never fetches on startup', async () => {
        const calls: { url: URL; init: RequestInit }[] = [];
        const ctx = await setup({ fetch: async (input, init) => { const url = new URL(String(input)); calls.push({ url, init: init! }); return new Response(url.pathname.endsWith('get_cost') ? '0.0' : bars.map(bar => JSON.stringify({ hd: { ts_event: new Date(bar.time).toISOString() }, symbol: 'NQM4', open: bar.open.toFixed(9), high: bar.high.toFixed(9), low: bar.low.toFixed(9), close: bar.close.toFixed(9), volume: bar.volume })).join('\n')); } });
        expect(calls).toHaveLength(0);
        const quote = await (await ctx.send('/api/provider/quote', scope)).json(); expect(quote.maxCostUsd).toBe(0);
        const result = await ctx.send('/api/provider/download', { quoteId: quote.quoteId }); expect(result.status).toBe(200);
        expect(calls).toHaveLength(3); expect(calls[0]!.url.href).toBe(calls[1]!.url.href);
        expect(calls.every(call => call.url.origin === 'https://hist.databento.com')).toBe(true);
        const params = new URLSearchParams(String(calls[2]!.init.body));
        for (const [key, value] of calls[0]!.url.searchParams) expect(params.get(key)).toBe(value);
        expect(params.get('stype_in')).toBe('raw_symbol'); expect(params.get('pretty_px')).toBe('true'); expect(calls[2]!.init.redirect).toBe('error');
        const dataset = await result.json() as DatasetMeta; expect(ctx.app.store.readBars(dataset.id)).toEqual(bars);
        expect((await ctx.send('/api/provider/download', { quoteId: quote.quoteId })).status).toBe(400);
        const cachedQuote = await (await ctx.send('/api/provider/quote', scope)).json();
        const cached = await (await ctx.send('/api/provider/download', { quoteId: cachedQuote.quoteId })).json() as DatasetMeta;
        expect(cached.id).toBe(dataset.id); expect(calls).toHaveLength(4);
    });
    it('does not reach data after a positive re-quote, bindless ID or mutated scope', async () => {
        let calls = 0; const ctx = await setup({ fetch: async () => new Response(++calls === 1 ? '0' : '0.01') });
        const quote = await (await ctx.send('/api/provider/quote', scope)).json();
        expect((await ctx.send('/api/provider/download', { quoteId: quote.quoteId, start: scope.start })).status).toBe(400); expect(calls).toBe(1);
        expect((await ctx.send('/api/provider/download', { quoteId: quote.quoteId })).status).toBe(400); expect(calls).toBe(2);
        expect((await ctx.send('/api/provider/download', { quoteId: 'made-up' })).status).toBe(400); expect(calls).toBe(2);
        expect((await ctx.send('/api/provider/quote', { ...scope, symbol: 'NQ.c.0' })).status).toBe(400);
    });
    it('rejects oversized and out-of-scope provider responses without committing partial data', async () => {
        let mode = 'large'; const ctx = await setup({ fetch: async input => String(input).includes('get_cost') ? new Response('0') : mode === 'large' ? new Response('x', { headers: { 'Content-Length': String(49 * 1024 * 1024) } }) : new Response(JSON.stringify({ ...bars[0], time: START - 60000 })) });
        let quote = await (await ctx.send('/api/provider/quote', scope)).json(); expect((await ctx.send('/api/provider/download', { quoteId: quote.quoteId })).status).toBe(413);
        mode = 'scope'; quote = await (await ctx.send('/api/provider/quote', scope)).json(); expect((await ctx.send('/api/provider/download', { quoteId: quote.quoteId })).status).toBe(400);
        expect(ctx.app.store.listDatasets()).toHaveLength(1);
    });
    it('admits only one global data download and releases admission after completion', async () => {
        let release!: () => void; let began!: () => void;
        const started = new Promise<void>(resolveStarted => { began = resolveStarted; });
        const held = new Promise<void>(resolveHeld => { release = resolveHeld; });
        let dataCalls = 0;
        const ctx = await setup({ fetch: async input => {
            if (String(input).includes('get_cost')) return new Response('0');
            dataCalls++; began(); await held;
            return new Response(bars.map(bar => JSON.stringify({ ...bar, symbol: 'NQM4' })).join('\n'));
        } });
        const quoteOne = await (await ctx.send('/api/provider/quote', scope)).json();
        const quoteTwo = await (await ctx.send('/api/provider/quote', scope)).json();
        const first = ctx.send('/api/provider/download', { quoteId: quoteOne.quoteId }); await started;
        expect((await ctx.send('/api/provider/download', { quoteId: quoteTwo.quoteId })).status).toBe(409); expect(dataCalls).toBe(1);
        release(); expect((await first).status).toBe(200);
        expect((await ctx.send('/api/provider/download', { quoteId: quoteTwo.quoteId })).status).toBe(200); expect(dataCalls).toBe(1);
    });
});
