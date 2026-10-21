import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplayStore } from '../server/store';
import { createSession, applyCommand } from '../engine/index';
import { DEFAULT_RULES, type Bar } from '../shared/types';
import { MarketStatsController } from '../server/stats-api';
import type { MarketStatsInput, MarketStatsResponse } from '../server/market-stats';
import { createReplayServer } from '../server/index';

const START = Date.UTC(2024, 3, 8);
const fixtures: { store: ReplayStore; directory: string }[] = [];
const apps: Awaited<ReturnType<typeof createReplayServer>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
afterEach(async () => { for (const { store, directory } of fixtures.splice(0)) { store.close(); await rm(directory, { recursive: true, force: true }); } });

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'vela-stats-api-'));
    const store = new ReplayStore(directory); fixtures.push({ store, directory });
    const bars: Bar[] = Array.from({ length: 12 }, (_, i) => ({ time: START + i * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
    const dataset = store.addDataset({ name: 'Synthetic minute source', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars });
    const config = { name: 'Synthetic replay', datasetId: dataset.id, mode: 'practice' as const, initialBalance: 50_000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, endIndex: 10, rules: DEFAULT_RULES };
    const session = applyCommand(createSession(config, dataset.instrument), bars, { type: 'advance', count: 2 }); store.createSession(session);
    const run = vi.fn(async (_input: MarketStatsInput) => ({ result: { n: 0 } }) as MarketStatsResponse);
    const controller = new MarketStatsController(store, { run, dispose: vi.fn(async () => {}) });
    const request = { datasetId: dataset.id, sourceMode: 'cache', from: START, until: dataset.end,
        session: { key: 'regular', start: '09:30', end: '16:00', tz: 'America/New_York', overnight: false },
        calendar: null, query: { dsl: 'closeGreen', sessionsLimit: 25 } };
    return { store, dataset, bars, session, run, controller, request };
}

describe('Market Stats cached-data route boundary', () => {
    it('exposes native-free registry metadata and actual dataset coverage', async () => {
        const f = await fixture(); const catalog = f.controller.catalog();
        expect(catalog.datasets.find(d => d.id === f.dataset.id)?.barCount).toBe(12);
        expect(catalog.registry.some(entry => entry.name === 'closeGreen' && entry.kind === 'outcome')).toBe(true);
        expect(catalog.registry.find(entry => entry.name === 'eventOccurs')?.doc).toContain('explicit bundled event-calendar');
        expect(catalog.eventCalendars?.map(item => item.event)).toEqual(expect.arrayContaining(['CPI', 'FOMC', 'NFP', 'OPEX']));
        expect(catalog.limits.bars).toBe(250_000);
    });
    it('reads only the requested cached window instead of materializing the dataset', async () => {
        const f = await fixture(); vi.spyOn(f.store, 'readBars').mockImplementation(() => { throw new Error('Unbounded source read'); });
        const response = await f.controller.run({ ...f.request, from: START + 3 * 60_000, until: START + 6 * 60_000 });
        expect(f.run.mock.calls[0]![0].bars.map(bar => bar.time)).toEqual(f.bars.slice(3, 6).map(bar => bar.time));
        expect(response.selection).toMatchObject({ datasetId: f.dataset.id, checksum: f.dataset.checksum, sourceMode: 'cache', from: START + 3 * 60_000, until: START + 6 * 60_000 });
    });
    it('pins revealed reads to the captured session and excludes every future bar', async () => {
        const f = await fixture();
        const response = await f.controller.run({ ...f.request, sourceMode: 'replay', replay: { id: f.session.id, revision: f.session.revision } });
        expect(f.run.mock.calls[0]![0].bars).toHaveLength(2);
        expect(f.run.mock.calls[0]![0].revealedUntil).toBe(START + 2 * 60_000);
        expect(response.selection.replay).toEqual({ id: f.session.id, revision: f.session.revision, cursor: 1 });
    });
    it('rejects a stale financial snapshot before starting a worker', async () => {
        const f = await fixture();
        await expect(f.controller.run({ ...f.request, sourceMode: 'replay', replay: { id: f.session.id, revision: f.session.revision + 1 } })).rejects.toMatchObject({ status: 409 });
        expect(f.run).not.toHaveBeenCalled();
    });
    it('rejects unknown payloads, implicit source modes and unaligned ranges', async () => {
        const f = await fixture();
        for (const input of [{ ...f.request, bars: [] }, { ...f.request, sourceMode: 'all' }, { ...f.request, sourceMode: ['replay'] },
            { ...f.request, sourceMode: ['cache'] }, { ...f.request, from: START + 1 }, { ...f.request, until: f.dataset.end + 60_000 }]) {
            await expect(f.controller.run(input)).rejects.toMatchObject({ status: 400 });
        }
        expect(f.run).not.toHaveBeenCalled();
    });
    it('requires a one-minute dataset and does not alter any account or saved revision', async () => {
        const f = await fixture(); const before = JSON.stringify(f.store.session(f.session.id));
        const second = f.store.addDataset({ name: 'Synthetic seconds', symbol: 'NQM4', schema: 'ohlcv-1s', source: 'csv', bars: f.bars });
        await expect(f.controller.run({ ...f.request, datasetId: second.id })).rejects.toMatchObject({ status: 400 });
        await f.controller.run(f.request);
        expect(JSON.stringify(f.store.session(f.session.id))).toBe(before);
    });
    it('runs the actual source worker through authenticated HTTP without changing replay state', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'vela-stats-api-'));
        const app = await createReplayServer({ dataDirectory: directory, port: 0, apiKey: '', fetch: vi.fn(async () => { throw new Error('No providers in statistics fixtures'); }) });
        apps.push(app);
        const url = await app.listen();
        const bootstrap = await (await fetch(url + '/api/bootstrap')).json() as { token: string };
        const bars = Array.from({ length: 12 }, (_, i) => ({ time: START + i * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
        const dataset = app.store.addDataset({ name: 'Synthetic worker source', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars });
        const payload = { datasetId: dataset.id, sourceMode: 'cache', from: dataset.start, until: dataset.end, calendar: null,
            session: { key: 'short', start: '00:00', end: '00:10', tz: 'UTC', overnight: false }, query: { dsl: 'closeGreen' } };
        const denied = await fetch(url + '/api/market-stats/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        expect(denied.status).toBe(403);
        const response = await fetch(url + '/api/market-stats/query', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': bootstrap.token }, body: JSON.stringify(payload) });
        const result = await response.json();
        expect(result).not.toHaveProperty('error'); expect(response.status).toBe(200);
        expect(result).toMatchObject({ source: { version: '0.1.0' }, selection: { datasetId: dataset.id }, result: { n: 1, estimate: null, guards: { refused: true } } });
        expect(app.store.sessions()).toEqual([]);
        await app.close(); apps.splice(apps.indexOf(app), 1);
        await rm(directory, { recursive: true, force: true });
    }, 15_000);
});
