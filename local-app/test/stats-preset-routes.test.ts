import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplayServer } from '../server/index';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it('serves all official templates and composes their actual default grouping through authenticated HTTP', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vela-presets-http-'));
    const app = await createReplayServer({ dataDirectory: directory, port: 0, apiKey: '' });
    cleanups.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
    const origin = await app.listen();
    const catalogResponse = await fetch(origin + '/api/market-stats/presets');
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as { total: number; categories: unknown[]; presets: { id: string; category: string; groupBy?: string; defaultDsl: string }[] };
    expect(catalog.total).toBe(42); expect(catalog.categories).toHaveLength(11);
    const preset = catalog.presets.find(item => item.groupBy && item.category !== 'events')!;
    const body = JSON.stringify({ id: preset.id });
    const denied = await fetch(origin + '/api/market-stats/preset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(denied.status).toBe(403);
    const { token } = await (await fetch(origin + '/api/bootstrap')).json() as { token: string };
    const post = (value: unknown, path = '/api/market-stats/preset') => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify(value) });
    const response = await post({ id: preset.id }); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dsl: preset.defaultDsl, groupBy: preset.groupBy, preset: { id: preset.id } });
    const event = catalog.presets.find(item => item.category === 'events')!;
    const unavailable = await post({ id: event.id }); expect(unavailable.status).toBe(400);
    expect(await unavailable.json()).toMatchObject({ code: 'UNSUPPORTED_INPUT' });
    const enabled = await (await fetch(origin + '/api/market-stats/presets?events=bundled')).json() as { presets: { availability: { available: boolean } }[] };
    expect(enabled.presets).toHaveLength(42); expect(enabled.presets.every(item => item.availability.available)).toBe(true);
    const composedEvent = await post({ id: event.id, eventCalendar: 'bundled' }); expect(composedEvent.status).toBe(200);
    expect(await composedEvent.json()).toHaveProperty('dsl');
    for (const value of [{ id: preset.id, force: true }, { id: preset.id, params: [] }, { id: preset.id, groupBy: 'notAField' }]) expect((await post(value)).status).toBe(400);
    expect((await post({ id: preset.id }, '/api/market-stats/preset?force=1')).status).toBe(400);
    expect(app.store.sessions()).toEqual([]);
});

it('requires explicit event data and returns its actual coverage and fingerprint through the native HTTP query', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vela-presets-http-'));
    const app = await createReplayServer({ dataDirectory: directory, port: 0, apiKey: '' });
    cleanups.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
    const origin = await app.listen(); const { token } = await (await fetch(origin + '/api/bootstrap')).json() as { token: string };
    const base = Date.UTC(2024, 3, 8);
    const dataset = app.store.addDataset({ name: 'Synthetic event query', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars: Array.from({ length: 3 }, (_, i) => ({ time: base + i * 60000, open: 100, high: 101, low: 99, close: 101, volume: 1 })) });
    const request = { datasetId: dataset.id, sourceMode: 'cache', from: dataset.start, until: dataset.end, calendar: null,
        session: { key: 'short', start: '00:00', end: '00:03', tz: 'UTC', overnight: false }, query: { dsl: "eventOccurs('CPI')" } };
    const post = (body: unknown) => fetch(origin + '/api/market-stats/query', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify(body) });
    expect((await post(request)).status).toBe(400);
    const response = await post({ ...request, eventCalendar: 'bundled' }); expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ selection: { eventCalendar: 'bundled' }, result: { n: 1, successes: 0, estimate: null, query: { outcome: "eventOccurs('CPI')" } }, coverage: { events: { fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), calendars: expect.any(Array) } } });
    expect(result.coverage.events.calendars).toHaveLength(4);
    expect((await post({ ...request, eventCalendar: ['bundled'] })).status).toBe(400);
    expect(app.store.sessions()).toEqual([]);
}, 15000);
