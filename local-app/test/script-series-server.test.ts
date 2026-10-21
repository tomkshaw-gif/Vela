import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplayServer } from '../server/index';
import type { BacktestSnapshot, ScriptDocument, ScriptVersionSummary, StoredBacktest } from '../shared/scripts';
import type { Bar, ChartView, Schema, SessionView } from '../shared/types';
import { DEFAULT_RULES } from '../shared/types';

const START = Date.UTC(2024, 3, 8, 0, 0);
// Bounded integration-test budget for fresh SQLite fixtures and real loopback requests.
const HTTP_TEST_TIMEOUT_MS = 15_000;
const SECRET = 'script-server-fixture-private-key';
const apps: Awaited<ReturnType<typeof createReplayServer>>[] = [];
const directories: string[] = [];
function temp(): string { const directory = mkdtempSync(join(tmpdir(), 'vela-script-server-')); directories.push(directory); return directory; }
function bars(times: number[]): Bar[] { return times.map((time, index) => ({ time, open: 20000 + index, high: 20002 + index, low: 19999 + index, close: 20001 + index, volume: 10 + index })); }
async function setup(source = bars(Array.from({ length: 12 }, (_, i) => START + i * 60000)), schema: Schema = 'ohlcv-1m', extra: Parameters<typeof createReplayServer>[0] = {}) {
    const provider = vi.fn(async () => { throw new Error('Script data must remain local.'); });
    const app = await createReplayServer({ dataDirectory: temp(), port: 0, apiKey: SECRET, fetch: provider, ...extra }); apps.push(app);
    const url = await app.listen(); const { token } = await (await fetch(`${url}/api/bootstrap`)).json() as { token: string };
    const post = (path: string, value: unknown, selectedToken = token) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': selectedToken }, body: JSON.stringify(value) });
    const dataset = app.store.addDataset({ name: 'Private cached script fixture', symbol: 'NQM4', schema, source: 'csv', bars: source });
    const created = await (await post('/api/sessions', { name: 'Script attempt', datasetId: dataset.id, mode: 'practice', initialBalance: 50000, commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES })).json() as SessionView;
    let current = created;
    const advance = async (count: number) => {
        const response = await post(`/api/sessions/${created.session.id}/command`, { expectedRevision: current.session.revision, command: { type: 'advance', count } }); expect(response.status).toBe(200);
        current = await response.json() as SessionView; return current;
    };
    const series = (query: string) => fetch(`${url}/api/sessions/${created.session.id}/series?${query}`);
    const run = (overrides: Partial<BacktestSnapshot> = {}): BacktestSnapshot => ({ scriptVersion: 0, source: 'strategy("Saved")', symbol: dataset.symbol, timeframe: '1', datasetId: dataset.id, datasetChecksum: dataset.checksum, from: dataset.start, to: dataset.end - dataset.intervalMs, inputs: {}, properties: { commission: 2.5 }, engine: { vela: '0.8.5', pinets: '0.9.0' }, result: { trades: [], performance: { netPnl: 0 } }, ...overrides });
    return { app, url, post, dataset, created, advance, series, source, provider, run };
}
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('script and saved strategy HTTP routes', { timeout: HTTP_TEST_TIMEOUT_MS }, () => {
    it('saves, renames, versions, clones, archives and restores scripts through authenticated routes', async () => {
        const ctx = await setup(); const input = { name: 'Session strategy', source: '//@version=5\nstrategy("NQ")' };
        const createdResponse = await ctx.post('/api/scripts', input); expect(createdResponse.status).toBe(200);
        const created = await createdResponse.json() as ScriptDocument; expect(created).toMatchObject({ ...input, revision: 0, versions: 1 });
        expect(await (await fetch(`${ctx.url}/api/scripts/${created.id}`)).json()).toEqual(created);
        const next = await (await ctx.post('/api/scripts', { ...input, id: created.id, expectedRevision: 0, name: 'Renamed strategy' })).json() as ScriptDocument;
        expect(next).toMatchObject({ revision: 1, versions: 2, name: 'Renamed strategy' });
        expect((await ctx.post('/api/scripts', { ...input, id: created.id, expectedRevision: 0 })).status).toBe(409);
        const versions = await (await fetch(`${ctx.url}/api/scripts/${created.id}/versions`)).json() as ScriptVersionSummary[];
        expect(versions.map(item => item.version)).toEqual([2, 1]); expect(versions[0]).not.toHaveProperty('source');
        expect(await (await fetch(`${ctx.url}/api/scripts/${created.id}/versions/1`)).json()).toMatchObject({ name: input.name, source: input.source });
        const cloned = await (await ctx.post(`/api/scripts/${created.id}/clone`, { name: 'Independent copy' })).json() as ScriptDocument;
        expect(cloned.id).not.toBe(created.id); expect(cloned.source).toBe(input.source);
        expect((await ctx.post(`/api/scripts/${created.id}/archive`, { expectedRevision: 1 })).status).toBe(200);
        expect((await (await fetch(`${ctx.url}/api/scripts`)).json() as ScriptDocument[]).map(item => item.id)).toEqual([cloned.id]);
        expect(await (await fetch(`${ctx.url}/api/scripts?includeArchived=true`)).json()).toHaveLength(2);
        expect((await ctx.post(`/api/scripts/${created.id}/restore`, { expectedRevision: 2 })).status).toBe(200);
        expect((await fetch(`${ctx.url}/api/scripts/${created.id}/versions/99`)).status).toBe(400);
        expect(ctx.provider).not.toHaveBeenCalled();
    });
    it('saves immutable strategy snapshots with dataset identity and returns lightweight list metadata', async () => {
        const ctx = await setup(); const doc = await (await ctx.post('/api/scripts', { name: 'Saved strategy', source: 'strategy("Saved")' })).json() as ScriptDocument;
        const snapshot = ctx.run({ strategyId: doc.id, scriptVersion: 1, source: doc.source });
        const savedResponse = await ctx.post('/api/backtests', { name: 'NQ result', snapshot }); expect(savedResponse.status).toBe(200);
        const saved = await savedResponse.json() as StoredBacktest; expect(saved).toMatchObject({ ...snapshot, name: 'NQ result' });
        expect(await (await fetch(`${ctx.url}/api/backtests/${saved.id}`)).json()).toEqual(saved);
        const list = await (await fetch(`${ctx.url}/api/backtests?strategyId=${doc.id}`)).json() as StoredBacktest[];
        expect(list).toHaveLength(1); expect(list[0]).not.toHaveProperty('source'); expect(list[0]).not.toHaveProperty('result');
        for (const override of [{ datasetChecksum: 'b'.repeat(64) }, { symbol: 'ESM4' }, { datasetId: randomUUID() }]) expect((await ctx.post('/api/backtests', { name: 'Mismatch', snapshot: ctx.run(override) })).status).toBe(override.datasetId ? 404 : 400);
        expect((await ctx.post('/api/backtests', { name: 'Wrong source', snapshot: { ...snapshot, source: 'strategy("Different")' } })).status).toBe(409);
        expect(ctx.provider).not.toHaveBeenCalled();
    });
    it('blocks credentials, cross-origin writes, missing tokens and unknown query fields', async () => {
        const ctx = await setup(); const valid = { name: 'Valid', source: 'plot(close)' };
        expect((await ctx.post('/api/scripts', valid, '')).status).toBe(403);
        expect((await ctx.post('/api/scripts', { ...valid, source: `// ${SECRET}` })).status).toBe(400);
        expect((await ctx.post('/api/backtests', { name: 'Secret', snapshot: ctx.run({ result: { nested: { value: SECRET } } }) })).status).toBe(400);
        const doc = await (await ctx.post('/api/scripts', valid)).json() as ScriptDocument;
        for (const query of ['?includeArchived=1', '?includeArchived=true&includeArchived=false', '?unknown=true']) expect((await fetch(`${ctx.url}/api/scripts${query}`)).status).toBe(400);
        expect((await fetch(`${ctx.url}/api/scripts/${doc.id}?source=true`)).status).toBe(400);
        expect((await fetch(`${ctx.url}/api/backtests?strategyId=bad`)).status).toBe(400);
        expect((await fetch(`${ctx.url}/api/scripts`, { headers: { Origin: 'https://outside.example' } })).status).toBe(403);
        expect((await ctx.post(`/api/scripts/${doc.id}/archive`, { expectedRevision: 0, extra: true })).status).toBe(400);
        expect((await ctx.post(`/api/scripts/${doc.id}/clone`, { name: 'Copy', source: 'silently overridden' })).status).toBe(400);
        expect(await (await fetch(`${ctx.url}/api/backtests`)).json()).toEqual([]);
        expect((await fetch(`${ctx.url}/api/bootstrap`)).headers.get('content-security-policy')).not.toContain('unsafe-eval');
    });
    it('allows final backtest saves during managed updates while freezing script and general writes', async () => {
        const ctx = await setup(undefined, undefined, { runtime: { mode: 'run', version: 'script-server.1' } });
        const doc = await (await ctx.post('/api/scripts', { name: 'Before update', source: 'plot(close)' })).json() as ScriptDocument;
        ctx.app.runtime.prepare(randomUUID());
        expect((await ctx.post('/api/scripts', { name: 'During update', source: '' })).status).toBe(503);
        expect((await ctx.post(`/api/scripts/${doc.id}/archive`, { expectedRevision: 0 })).status).toBe(503);
        expect((await ctx.post('/api/backtests', { name: 'Completed before update', snapshot: ctx.run() })).status).toBe(200);
        expect((await ctx.post('/api/datasets/import', {})).status).toBe(503);
        expect((await ctx.post('/api/sessions', {})).status).toBe(503);
        expect((await fetch(`${ctx.url}/api/scripts/${doc.id}`)).status).toBe(200);
        expect((await ctx.series('timeframe=1&cursor=-1')).status).toBe(200);
    });
});

describe('cached script data gateway', { timeout: HTTP_TEST_TIMEOUT_MS }, () => {
    it('pins source rows before higher-timeframe aggregation even after the replay advances', async () => {
        const ctx = await setup(); await ctx.advance(2);
        const before = await (await ctx.series('timeframe=5&cursor=1')).json() as ChartView;
        expect(before.bars).toEqual([{ time: START, open: 20000, high: 20003, low: 19999, close: 20002, volume: 21 }]);
        await ctx.advance(8);
        const after = await (await ctx.series('timeframe=5&cursor=1')).json() as ChartView;
        expect(after).toEqual(before);
        const cutoff = await (await ctx.series(`timeframe=5&cutoff=${START + 60000}`)).json(); expect(cutoff).toEqual(before);
        const latest = await (await ctx.series('timeframe=5&cursor=9')).json() as ChartView;
        expect(latest.bars).toHaveLength(2); expect(latest.bars[0]!.high).toBe(20006); expect(latest.bars[0]!.volume).toBe(60);
        expect(before.cursorTime).toBe(START + 60000); expect(ctx.provider).not.toHaveBeenCalled();
    });
    it('keeps source cutoff independent from query date bounds and resolves source gaps backward', async () => {
        const ctx = await setup(bars([START, START + 60000, START + 180000, START + 240000, START + 600000])); await ctx.advance(5);
        const throughGap = await (await ctx.series(`timeframe=5&cutoff=${START + 120000}&to=${START + 300000}`)).json() as ChartView;
        expect(throughGap.cursorTime).toBe(START + 60000); expect(throughGap.bars[0]).toMatchObject({ high: 20003, close: 20002, volume: 21 });
        const earlierTo = await (await ctx.series(`timeframe=5&cursor=4&to=${START + 180000}`)).json() as ChartView;
        expect(earlierTo.cursorTime).toBe(START + 600000); expect(earlierTo.bars[0]).toMatchObject({ high: 20005, close: 20004, volume: 46 });
        const empty = await (await ctx.series(`timeframe=5&cutoff=${START - 1}`)).json() as ChartView;
        expect(empty.bars).toEqual([]); expect(empty.cursorTime).toBeNull();
        expect(ctx.provider).not.toHaveBeenCalled();
    });
    it('returns real contract metadata and bounds custom resolutions by the source granularity', async () => {
        const ctx = await setup(); await ctx.advance(12);
        const custom = await (await ctx.series('timeframe=7&cursor=11')).json() as ChartView & { symbolInfo: Record<string, unknown> };
        expect(custom.bars).toHaveLength(3); expect(custom.intervalMs).toBe(7 * 60000);
        expect(custom.bars[0]!.time).toBe(Math.floor(START / (7 * 60000)) * 7 * 60000);
        expect(custom.symbolInfo).toMatchObject({ tickerid: 'replay:NQM4', ticker: 'NQM4', symbol: 'NQM4', type: 'futures', mintick: 0.25, pointvalue: 20, pricescale: 4, minmove: 1, timezone: 'America/Chicago', currency: 'USD' });
        expect((await ctx.series('timeframe=15S&cursor=11')).status).toBe(400);
        const seconds = await setup(bars(Array.from({ length: 8 }, (_, i) => START + i * 1000)), 'ohlcv-1s'); await seconds.advance(8);
        const secondData = await (await seconds.series('timeframe=3S&cursor=4')).json() as ChartView;
        expect(secondData.bars).toHaveLength(2); expect(secondData.bars[1]).toMatchObject({ time: START + 3000, high: 20006, close: 20005, volume: 27 });
        expect(secondData.baseIntervalMs).toBe(1000);
    });
    it('uses Monday weekly buckets and real leap-month/calendar-quarter boundaries', async () => {
        const dates = [Date.UTC(2024, 0, 31, 23, 59), Date.UTC(2024, 1, 1), Date.UTC(2024, 1, 29, 23, 59), Date.UTC(2024, 2, 1), Date.UTC(2024, 3, 1)];
        const ctx = await setup(bars(dates)); await ctx.advance(5);
        const months = await (await ctx.series('timeframe=M&cursor=4')).json() as ChartView;
        expect(months.bars.map(item => item.time)).toEqual([Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1), Date.UTC(2024, 2, 1), Date.UTC(2024, 3, 1)]);
        expect(months.bars[1]).toMatchObject({ open: 20001, high: 20004, low: 20000, close: 20003, volume: 23 });
        const february = await (await ctx.series('timeframe=M&cursor=2')).json() as ChartView;
        expect(february.intervalMs).toBe(29 * 86400000); expect(months.intervalMs).toBe(30 * 86400000);
        const quarters = await (await ctx.series('timeframe=3M&cursor=4')).json() as ChartView;
        expect(quarters.bars.map(item => item.time)).toEqual([Date.UTC(2024, 0, 1), Date.UTC(2024, 3, 1)]);
        const weeks = await (await ctx.series('timeframe=W&cursor=4')).json() as ChartView;
        expect(weeks.bars.every(item => new Date(item.time).getUTCDay() === 1)).toBe(true);
        const chart = await (await fetch(`${ctx.url}/api/sessions/${ctx.created.session.id}/chart?timeframe=1M`)).json() as ChartView;
        expect(chart.bars).toEqual(months.bars);
    });
    it('returns bounded incremental and latest windows without loading or contacting provider data', async () => {
        const ctx = await setup(); await ctx.advance(12); const readBars = vi.spyOn(ctx.app.store, 'readBars');
        const latest = await (await ctx.series('timeframe=1&cursor=11&limit=3')).json() as ChartView;
        expect(latest.bars).toEqual(ctx.source.slice(9)); expect(latest.hasMore).toBe(true);
        const earliest = await (await ctx.series(`timeframe=1&cursor=11&from=${START + 60000}&limit=3`)).json() as ChartView;
        expect(earliest.bars).toEqual(ctx.source.slice(1, 4)); expect(earliest.hasMore).toBe(true);
        expect(readBars).not.toHaveBeenCalled(); expect(ctx.provider).not.toHaveBeenCalled();
    });
    it('rejects future cursors, future cutoffs, alternate symbols, duplicate or malformed options', async () => {
        const ctx = await setup(); await ctx.advance(2);
        for (const query of [
            '', 'timeframe=1', 'cursor=2', 'cursor=-2', 'cursor=1.5', 'cursor=01&cursor=1', 'cursor=NaN', 'cursor=12', `cutoff=${START + 60001}`, `cursor=1&cutoff=${START}`, 'cutoff=-1',
            `cursor=1&datasetId=${randomUUID()}`, 'cursor=1&limit=250001', 'cursor=1&limit=0', 'cursor=1&limit=1&limit=2', 'cursor=1&timeframe=0', 'cursor=1&timeframe=1&timeframe=5',
            'cursor=1&from=-1', 'cursor=1&from=1.5', `cursor=1&from=${START + 2}&to=${START + 1}`, `cursor=1&to=8640000000000001`, 'cursor=1&unknown=true',
        ]) expect((await ctx.series(query)).status, query).toBe(400);
        expect((await ctx.series('cursor=1&symbol=ESM4')).status).toBe(404);
        expect((await fetch(`${ctx.url}/api/sessions/${ctx.created.session.id}/series?cursor=1`, { headers: { Origin: 'https://outside.example' } })).status).toBe(403);
        expect((await ctx.post(`/api/sessions/${ctx.created.session.id}/series`, { cursor: 1 })).status).toBe(404);
        expect((await ctx.series('cursor=-1')).status).toBe(200);
    });
    it('sets evaluation permission only on the isolated worker asset and keeps main-document policy strict', async () => {
        const staticDirectory = temp(); writeFileSync(join(staticDirectory, 'index.html'), '<!doctype html><title>Local scripts</title>'); writeFileSync(join(staticDirectory, 'local-pine-worker.js'), 'self.onmessage=()=>{};');
        const ctx = await setup(undefined, undefined, { staticDirectory });
        const main = await fetch(ctx.url); expect(main.status).toBe(200); expect(main.headers.get('content-security-policy')).not.toContain('unsafe-eval');
        const worker = await fetch(`${ctx.url}/local-pine-worker.js`); expect(worker.status).toBe(200);
        expect(worker.headers.get('content-security-policy')).toContain("script-src 'self' 'unsafe-eval'"); expect(worker.headers.get('content-security-policy')).toContain("connect-src 'none'");
        expect(worker.headers.get('cache-control')).toBe('no-store'); expect(worker.headers.get('content-type')).toContain('text/javascript');
        expect((await fetch(`${ctx.url}/other-worker.js`)).status).toBe(404);
    });
    it('serves the maximum cached source prefix without admitting its final unrevealed bar', async () => {
        const source = Array.from({ length: 250000 }, (_, index) => ({ time: START + index * 1000, open: 20000, high: index === 249999 ? 9000000 : 20001, low: 19999, close: 20000.25, volume: 1 }));
        const ctx = await setup(source, 'ohlcv-1s');
        const createdResponse = await ctx.post('/api/sessions', { name: 'Maximum script prefix', datasetId: ctx.dataset.id, mode: 'practice', initialBalance: 50000, commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 249999, rules: DEFAULT_RULES });
        expect(createdResponse.status).toBe(200); const created = await createdResponse.json() as SessionView;
        const path = `${ctx.url}/api/sessions/${created.session.id}/series`;
        const response = await fetch(`${path}?timeframe=1S&cursor=249998&limit=250000`); expect(response.status).toBe(200);
        const result = await response.json() as ChartView;
        expect(result.bars).toHaveLength(249999); expect(result.bars[0]).toEqual(source[0]); expect(result.bars.at(-1)).toEqual(source[249998]);
        expect(result.hasMore).toBe(false); expect(result.cursorTime).toBe(source[249998]!.time);
        expect(result.bars.every(bar => bar.high < 9000000)).toBe(true);
        expect((await fetch(`${path}?timeframe=1S&cursor=249999`)).status).toBe(400); expect(ctx.provider).not.toHaveBeenCalled();
    }, 30000);
});
