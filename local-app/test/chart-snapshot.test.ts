import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createReplayServer } from '../server/index';
import { checksum } from '../server/data';
import { ReplayCharts } from '../client/charts';
import { revealedWindow } from '../client/chart-data';
import { ApiError, type LocalApi } from '../client/api';
import { DEFAULT_RULES, type Bar, type Command, type SessionView } from '../shared/types';

const START = Date.UTC(2026, 5, 1);
const candle = (index: number, interval = 60000, offset = 0): Bar => ({ time: START + index * interval,
    open: 100 + offset + index / 4, high: 101 + offset + index / 4, low: 99 + offset + index / 4,
    close: 100 + offset + index / 4, volume: 1 });
const apps: Awaited<ReturnType<typeof createReplayServer>>[] = [];
const directories: string[] = [];
const controllers: ReplayCharts[] = [];

afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.destroy();
    for (const app of apps.splice(0)) await app.close();
    for (const directory of directories.splice(0)) {
        const target = resolve(directory);
        if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('vela-chart-snapshot-')) throw new Error('Unexpected snapshot fixture path.');
        rmSync(target, { recursive: true, force: true });
    }
});

function pin(view: SessionView, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ cursor: view.session.cursor, revision: view.session.revision,
        datasetId: view.dataset.id, checksum: view.dataset.checksum, ...extra });
}

async function fixture(count = 12, interval = 60000) {
    const directory = mkdtempSync(join(tmpdir(), 'vela-chart-snapshot-')); directories.push(directory);
    const provider = vi.fn(async () => { throw new Error('Snapshot fixtures must not use a provider.'); });
    const app = await createReplayServer({ dataDirectory: directory, port: 0, apiKey: '', fetch: provider }); apps.push(app);
    const url = await app.listen();
    const { token } = await (await fetch(`${url}/api/bootstrap`)).json() as { token: string };
    const source = Array.from({ length: count }, (_, index) => candle(index, interval));
    const dataset = app.store.addDataset({ name: 'Synthetic snapshot source', symbol: 'NQM4',
        schema: interval === 1000 ? 'ohlcv-1s' : 'ohlcv-1m', source: 'csv', bars: source });
    const post = (path: string, body: unknown) => fetch(url + path, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify(body) });
    const created = await post('/api/sessions', { name: 'Snapshot attempt', datasetId: dataset.id, mode: 'practice',
        initialBalance: 50000, commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0,
        startIndex: 0, endIndex: count - 1, rules: DEFAULT_RULES });
    expect(created.status).toBe(200);
    let current = await created.json() as SessionView;
    const requests: string[] = [];
    const api = { get: async <T>(path: string, signal?: AbortSignal): Promise<T> => {
        requests.push(path);
        const response = await fetch(url + path, { signal });
        const body = await response.json() as T & { error?: string };
        if (!response.ok) throw new ApiError(body.error ?? 'Synthetic request failed', response.status);
        return body;
    } };
    const command = async (command: Command): Promise<SessionView> => {
        const result = await post(`/api/sessions/${current.session.id}/command`, { expectedRevision: current.session.revision, command });
        expect(result.status).toBe(200); current = await result.json() as SessionView; return structuredClone(current);
    };
    return { app, url, source, dataset, provider, requests, api, post, command, current: () => structuredClone(current) };
}

function chartHarness(api: Pick<LocalApi, 'get'>, view: SessionView, timeframe = '1') {
    const chart = { market: { symbol: `replay:${view.dataset.symbol}`, timeframe, offline: true }, data: [] as Bar[],
        marks: { defineGroup: vi.fn(), set: vi.fn() },
        setMarket: vi.fn(async (market: { symbol: string; timeframe: string; data: Bar[] }) => {
            Object.assign(chart.market, market); chart.data = market.data;
        }) };
    const prices = vi.fn();
    const controller = new ReplayCharts(new EventTarget() as HTMLElement, api as LocalApi, async () => {}, vi.fn(), vi.fn(), prices);
    const internal = controller as unknown as { view: SessionView; workspace: unknown; bars: Map<string, Bar[]>;
        fetchSeries(symbol: string, timeframe: string, range: { from?: number; to?: number; limit?: number }, cutoff?: number): Promise<Bar[]> };
    internal.view = view;
    internal.workspace = { cells: () => [{ id: 'snapshot-cell', chart }], destroy: () => {} };
    controllers.push(controller);
    return { controller, chart, prices, internal };
}

describe('chart reads at a financial session snapshot', () => {
    it('keeps chart price, cursor and position marks aligned when another window advances the saved session', async () => {
        const ctx = await fixture();
        await ctx.command({ type: 'place', order: { type: 'market', side: 'buy', qty: 1 } });
        const snapshot = await ctx.command({ type: 'advance', count: 1 });
        const newer = await ctx.command({ type: 'advance', count: 1 });
        const { controller, chart } = chartHarness(ctx.api, snapshot);
        await controller.sync(snapshot);
        expect(snapshot.session.account.equity).toBe(50000); expect(newer.session.account.equity).toBe(50005);
        expect(controller.cursorTime).toBe(ctx.source[0]!.time);
        expect(controller.lastPrice).toBe(100); expect(chart.data).toEqual([ctx.source[0]]);
        expect(chart.marks.set).toHaveBeenCalled();
        const stale = await ctx.post(`/api/sessions/${snapshot.session.id}/command`, {
            expectedRevision: snapshot.session.revision, command: { type: 'close' } });
        expect(stale.status).toBe(409); expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('pins partial higher-timeframe aggregation and its separate native quote request', async () => {
        const ctx = await fixture(); const snapshot = await ctx.command({ type: 'advance', count: 1 });
        await ctx.command({ type: 'advance', count: 3 });
        const { controller, chart } = chartHarness(ctx.api, snapshot, '5');
        await controller.sync(snapshot);
        expect(chart.data).toEqual([ctx.source[0]]);
        expect(controller.cursorTime).toBe(START); expect(controller.lastPrice).toBe(100);
        expect(ctx.requests).toHaveLength(2);
        for (const path of ctx.requests) expect(new URL(path, ctx.url).searchParams.get('snapshot')).toBe(pin(snapshot));
        expect(ctx.requests.some(path => new URL(path, ctx.url).searchParams.get('limit') === '1')).toBe(true);
    });

    it('rebuilds partial buckets when reading an earlier snapshot instead of retaining later cached aggregates', async () => {
        const ctx = await fixture(); const earlier = await ctx.command({ type: 'advance', count: 1 });
        const later = await ctx.command({ type: 'advance', count: 3 });
        const { controller, chart } = chartHarness(ctx.api, later, '5');
        await controller.sync(later); expect(chart.data[0]!.high).toBe(ctx.source[3]!.high);
        await controller.sync(earlier);
        expect(chart.data).toEqual([ctx.source[0]]); expect(controller.lastPrice).toBe(100);
        expect(controller.cursorTime).toBe(START);
    });

    it('drops a later cached window and keeps its pin when a backward helper read needs a fresh window', async () => {
        const ctx = await fixture(); const earlier = await ctx.command({ type: 'advance', count: 1 });
        await ctx.command({ type: 'advance', count: 3 });
        const result = await revealedWindow(ctx.api, earlier.session.id, '1', ctx.source.slice(0, 4), new AbortController().signal, earlier);
        expect(result.bars).toEqual([ctx.source[0]]); expect(result.cursorTime).toBe(START);
        expect(ctx.requests).toHaveLength(2);
        for (const path of ctx.requests) expect(new URL(path, ctx.url).searchParams.get('snapshot')).toBe(pin(earlier));
    });

    it('invalidates older cached buckets when a financial refresh supplies a changed dataset fingerprint', async () => {
        const ctx = await fixture(); const original = await ctx.command({ type: 'advance', count: 8 });
        const { controller, chart } = chartHarness(ctx.api, original);
        await controller.sync(original);
        const replacement = ctx.source.map((bar, index) => index === 0 ? { ...bar, high: 500 } : bar);
        const dataset = { ...ctx.dataset, checksum: checksum(replacement) };
        ctx.app.store.db.prepare('UPDATE bars SET high=500 WHERE dataset_id=? AND idx=0').run(dataset.id);
        ctx.app.store.db.prepare('UPDATE datasets SET meta=? WHERE id=?').run(JSON.stringify(dataset), dataset.id);
        const refreshed = { ...original, dataset };
        controller.updateMarkers(refreshed);
        await controller.sync(refreshed);
        expect(chart.data[0]).toEqual(replacement[0]);
        expect(chart.data.at(-1)).toEqual(replacement[7]);
    });

    it('keeps a before-first-bar snapshot empty after another window reveals candles', async () => {
        const ctx = await fixture(); const before = ctx.current();
        await ctx.command({ type: 'advance', count: 3 });
        const { controller, chart } = chartHarness(ctx.api, before, '5');
        await controller.sync(before);
        expect(chart.data).toEqual([]); expect(controller.cursorTime).toBeNull(); expect(controller.lastPrice).toBeNull();
    });

    it('discards a delayed later-snapshot read after backward navigation', async () => {
        const ctx = await fixture(); const earlier = await ctx.command({ type: 'advance', count: 1 });
        const later = await ctx.command({ type: 'advance', count: 3 });
        let release!: () => void; let started!: () => void;
        const waiting = new Promise<void>(resolve => { started = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        let delayed = false;
        const api = { get: async <T>(path: string, signal?: AbortSignal): Promise<T> => {
            const answer = await ctx.api.get<T>(path, signal);
            if (!delayed) { delayed = true; started(); await gate; }
            return answer;
        } };
        const { controller, chart, prices } = chartHarness(api, later);
        const pending = controller.sync(later); await waiting;
        const backward = controller.sync(earlier); release(); await Promise.all([pending, backward]);
        expect(chart.data).toEqual([ctx.source[0]]);
        expect(prices.mock.calls).toEqual([[100, START]]);
        expect(chart.setMarket.mock.calls.every(([market]) => market.data.every(bar => bar.time <= START))).toBe(true);
    });

    it('keeps primary and secondary script series at the view pin even when the saved session is newer', async () => {
        const ctx = await fixture();
        ctx.app.store.addDataset({ name: 'Synthetic secondary', symbol: 'ESM4', schema: 'ohlcv-1m', source: 'csv',
            bars: ctx.source.map((_, index) => candle(index, 60000, 1000)) });
        const snapshot = await ctx.command({ type: 'advance', count: 1 });
        await ctx.command({ type: 'advance', count: 5 });
        const { internal } = chartHarness(ctx.api, snapshot);
        expect(await internal.fetchSeries('NQM4', '5', {})).toEqual([ctx.source[0]]);
        expect(await internal.fetchSeries('ESM4', '5', {}, START)).toEqual([candle(0, 60000, 1000)]);
        for (const path of ctx.requests) expect(new URL(path, ctx.url).searchParams.get('snapshot')).toBe(pin(snapshot));
        await expect(internal.fetchSeries('ESM4', '5', {}, START + 60000)).rejects.toMatchObject({ status: 400 });
        expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('excludes a secondary source candle until its exclusive close is revealed by the pinned primary clock', async () => {
        const ctx = await fixture(70, 1000);
        ctx.app.store.addDataset({ name: 'Synthetic minute secondary', symbol: 'ESM4', schema: 'ohlcv-1m', source: 'csv',
            bars: [candle(0, 60000, 1000), candle(1, 60000, 1000)] });
        const snapshot = await ctx.command({ type: 'advance', count: 1 });
        await ctx.command({ type: 'advance', count: 60 });
        const { internal } = chartHarness(ctx.api, snapshot, '1S');
        expect(await internal.fetchSeries('ESM4', '1', {})).toEqual([]);
        expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('retains the same pin through the overflow fallback after a large advance', async () => {
        const ctx = await fixture(5030); const first = await ctx.command({ type: 'advance', count: 1 });
        const { controller, chart } = chartHarness(ctx.api, first);
        await controller.sync(first);
        const snapshot = await ctx.command({ type: 'advance', count: 5000 });
        await ctx.command({ type: 'advance', count: 20 }); ctx.requests.length = 0;
        await controller.sync(snapshot);
        expect(chart.data).toHaveLength(5000); expect(chart.data.at(-1)).toEqual(ctx.source[5000]);
        expect(controller.cursorTime).toBe(ctx.source[5000]!.time);
        expect(ctx.requests).toHaveLength(2);
        expect(new URL(ctx.requests[0]!, ctx.url).searchParams.has('after')).toBe(true);
        expect(new URL(ctx.requests[1]!, ctx.url).searchParams.has('after')).toBe(false);
        for (const path of ctx.requests) expect(new URL(path, ctx.url).searchParams.get('snapshot')).toBe(pin(snapshot));
    });

    it('rejects untrusted snapshot revisions, identities and source bounds before returning chart or series data', async () => {
        const ctx = await fixture(); const snapshot = await ctx.command({ type: 'advance', count: 1 });
        await ctx.command({ type: 'advance', count: 3 });
        const invalid = [ { revision: 999 }, { datasetId: 'another-dataset' }, { checksum: 'changed' },
            { cursor: 4 }, { cursor: 11 }, { cursor: -2 }, { cursor: 0.5 }, { unexpected: true } ];
        for (const extra of invalid) for (const action of ['chart', 'series']) {
            const query = new URLSearchParams({ timeframe: '5', snapshot: pin(snapshot, extra), ...(action === 'series' ? { cursor: '0' } : {}) });
            const response = await fetch(`${ctx.url}/api/sessions/${snapshot.session.id}/${action}?${query}`);
            expect([400, 409], JSON.stringify(extra)).toContain(response.status);
        }
        const sameRevisionWrongCursor = new URLSearchParams({ snapshot: pin(snapshot, { revision: ctx.current().session.revision }) });
        expect((await fetch(`${ctx.url}/api/sessions/${snapshot.session.id}/chart?${sameRevisionWrongCursor}`)).status).toBe(409);
        for (const query of [new URLSearchParams({ timeframe: '1', cursor: '1', snapshot: pin(snapshot) }),
            new URLSearchParams({ timeframe: '1', cutoff: String(START + 60000), snapshot: pin(snapshot) })]) {
            expect((await fetch(`${ctx.url}/api/sessions/${snapshot.session.id}/series?${query}`)).status).toBe(400);
        }
        const changed = { ...ctx.dataset, checksum: 'different-source-content' };
        ctx.app.store.db.prepare('UPDATE datasets SET meta=? WHERE id=?').run(JSON.stringify(changed), ctx.dataset.id);
        const query = new URLSearchParams({ snapshot: pin(snapshot) });
        expect((await fetch(`${ctx.url}/api/sessions/${snapshot.session.id}/chart?${query}`)).status).toBe(409);
        expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('rejects malformed or duplicate snapshot envelopes', async () => {
        const ctx = await fixture(); const snapshot = await ctx.command({ type: 'advance', count: 1 });
        for (const raw of ['', 'null', '[]', '{', '{}', 'x'.repeat(1025), pin(snapshot, { revision: null })]) {
            const query = new URLSearchParams({ snapshot: raw });
            expect((await fetch(`${ctx.url}/api/sessions/${snapshot.session.id}/chart?${query}`)).status).toBe(400);
        }
        const query = new URLSearchParams({ snapshot: pin(snapshot) }); query.append('snapshot', pin(snapshot));
        expect((await fetch(`${ctx.url}/api/sessions/${snapshot.session.id}/chart?${query}`)).status).toBe(400);
    });
});
