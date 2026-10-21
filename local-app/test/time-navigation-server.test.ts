import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplayServer } from '../server/index';
import { DEFAULT_RULES } from '../shared/types';
import type { Bar, DatasetMeta, SessionView } from '../shared/types';

const START = Date.UTC(2024, 3, 8);
const apps: Awaited<ReturnType<typeof createReplayServer>>[] = [];
const directories: string[] = [];
function source(times: number[]): Bar[] { return times.map((time, index) => ({ time, open: 20000 + index, high: 20002 + index, low: 19999 + index, close: 20001 + index, volume: index + 1 })); }
async function setup(managed = false) {
    const directory = mkdtempSync(join(tmpdir(), 'vela-navigation-test-')); directories.push(directory);
    const provider = vi.fn(async () => { throw new Error('Navigation must not contact a provider'); });
    const app = await createReplayServer({ dataDirectory: directory, port: 0, apiKey: 'navigation-test-private-key', fetch: provider, ...(managed ? { runtime: { mode: 'run' as const, version: 'navigation-test.1' } } : {}) }); apps.push(app);
    const url = await app.listen(); const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json() as { token: string };
    const post = (path: string, value: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': bootstrap.token }, body: JSON.stringify(value) });
    const dataset = app.store.addDataset({ name: 'Minute bars with a market gap', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars: source([START, START + 60000, START + 300000, START + 360000]) });
    const config = (selected: DatasetMeta = dataset) => ({ name: 'Calendar attempt', datasetId: selected.id, mode: 'practice' as const, initialBalance: 50000, commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, rules: DEFAULT_RULES });
    const create = async (startIndex = 0, selected = dataset) => (await (await post('/api/sessions', { ...config(selected), startIndex })).json()) as SessionView;
    return { app, url, post, dataset, config, create, provider };
}
afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('calendar replay starts', () => {
    it('resolves exact and gap timestamps to source indices without caching or revealing candles', async () => {
        const ctx = await setup(); const readBars = vi.spyOn(ctx.app.store, 'readBars');
        for (const [startTime, startIndex] of [[START, 0], [START + 60000, 1], [START + 61000, 2], [START + 360000, 3]]) {
            const response = await ctx.post('/api/sessions', { ...ctx.config(), startTime }); expect(response.status).toBe(200);
            const result = await response.json() as SessionView;
            expect(result.session.config.startIndex).toBe(startIndex); expect(result.session.config).not.toHaveProperty('startTime');
            expect(result.session.cursor).toBe(startIndex! - 1); expect(result.session.equityCurve).toEqual([]);
            const chart = await (await fetch(`${ctx.url}/api/sessions/${result.session.id}/chart?timeframe=1m`)).json() as { bars: Bar[] };
            expect(chart.bars.every(bar => bar.time < startTime!)).toBe(true);
        }
        expect(readBars).not.toHaveBeenCalled(); expect(ctx.provider).not.toHaveBeenCalled();
    });
    it('keeps the existing index contract and rejects ambiguous, invalid or outside-span starts', async () => {
        const ctx = await setup(); expect((await ctx.create(2)).session.config.startIndex).toBe(2);
        for (const startTime of [START - 1, START + 360001, START + 419999, -1, 1.5, null, '1712534400000', true, {}, 8640000000000001]) {
            expect((await ctx.post('/api/sessions', { ...ctx.config(), startTime })).status, String(startTime)).toBe(400);
        }
        expect((await ctx.post('/api/sessions', { ...ctx.config(), startIndex: 0, startTime: START })).status).toBe(400);
        expect((await ctx.post('/api/sessions', ctx.config())).status).toBe(400);
        expect((await ctx.post('/api/sessions', { ...ctx.config(), datasetId: randomUUID(), startTime: START })).status).toBe(404);
        expect(ctx.app.store.sessions()).toHaveLength(1);
    });
    it('uses second source bars without rounding to chart intervals', async () => {
        const ctx = await setup();
        const dataset = ctx.app.store.addDataset({ name: 'Second source', symbol: 'NQM4', schema: 'ohlcv-1s', source: 'csv', bars: source([START, START + 1000, START + 4000, START + 5000]) });
        const response = await ctx.post('/api/sessions', { ...ctx.config(dataset), startTime: START + 1001 }); expect(response.status).toBe(200);
        expect(((await response.json()) as SessionView).session.config.startIndex).toBe(2);
    });
});

describe('forward navigation lookup', () => {
    it('returns only source index/time metadata and leaves the cursor, revision and chart unchanged', async () => {
        const ctx = await setup(); const created = await ctx.create(); const path = `/api/sessions/${created.session.id}`;
        const readBars = vi.spyOn(ctx.app.store, 'readBars');
        const first = await (await fetch(`${ctx.url}${path}/navigation?time=${START + 61000}`)).json();
        expect(first).toEqual({ currentIndex: -1, currentTime: null, targetIndex: 2, targetTime: START + 300000 });
        expect(readBars).not.toHaveBeenCalled();
        expect(await (await fetch(`${ctx.url}${path}`)).json()).toEqual(created);
        expect(((await (await fetch(`${ctx.url}${path}/chart?timeframe=1m`)).json()) as { bars: Bar[] }).bars).toEqual([]);
        const advanced = await ctx.post(`${path}/command`, { expectedRevision: 0, command: { type: 'advance', count: 1 } }); expect(advanced.status).toBe(200);
        const next = await (await fetch(`${ctx.url}${path}/navigation?time=${START + 1}`)).json();
        expect(next).toEqual({ currentIndex: 0, currentTime: START, targetIndex: 1, targetTime: START + 60000 });
        expect(ctx.provider).not.toHaveBeenCalled();
    });
    it('rejects backward, same-bar, malformed, missing and out-of-range lookups', async () => {
        const ctx = await setup(); const created = await ctx.create(2); const path = `/api/sessions/${created.session.id}/navigation`;
        for (const query of ['', '?time=', '?time=NaN', '?time=Infinity', '?time=1.5', '?time=-1', '?time=1e12', `?time=${START - 1}`, `?time=${START + 360001}`, `?time=${START}`, `?time=${START + 60000}`, `?time=${START + 300000}&time=${START + 360000}`, `?time=${START + 300000}&datasetId=${randomUUID()}`]) {
            expect((await fetch(`${ctx.url}${path}${query}`)).status, query).toBe(400);
        }
        expect((await fetch(`${ctx.url}/api/sessions/${randomUUID()}/navigation?time=${START}`)).status).toBe(404);
        expect((await fetch(`${ctx.url}${path}?time=${START + 300000}`, { headers: { Origin: 'https://outside.example' } })).status).toBe(403);
        expect((await ctx.post(path, { time: START + 300000 })).status).toBe(404);
    });
    it('resolves only the session dataset even when another dataset has matching timestamps', async () => {
        const ctx = await setup();
        const other = ctx.app.store.addDataset({ name: 'Different candle schedule', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars: source([START + 60000, START + 120000, START + 180000]) });
        const one = await ctx.create(); const two = await ctx.create(0, other);
        const lookup = async (id: string) => (await (await fetch(`${ctx.url}/api/sessions/${id}/navigation?time=${START + 120000}`)).json()) as { targetIndex: number; targetTime: number };
        expect(await lookup(one.session.id)).toMatchObject({ targetIndex: 2, targetTime: START + 300000 });
        expect(await lookup(two.session.id)).toMatchObject({ targetIndex: 1, targetTime: START + 120000 });
    });
    it('allows read-only lookup during update preparation while freezing starts and replay mutation', async () => {
        const ctx = await setup(true); const created = await ctx.create(); const path = `/api/sessions/${created.session.id}`;
        ctx.app.runtime.prepare(randomUUID());
        expect((await fetch(`${ctx.url}${path}/navigation?time=${START + 300000}`)).status).toBe(200);
        expect((await ctx.post('/api/sessions', { ...ctx.config(), startTime: START })).status).toBe(503);
        expect((await ctx.post(`${path}/command`, { expectedRevision: 0, command: { type: 'advance', count: 3 } })).status).toBe(503);
        expect(ctx.app.store.session(created.session.id)).toEqual(created.session);
    });
});
