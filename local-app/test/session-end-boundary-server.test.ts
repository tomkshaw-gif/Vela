import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createReplayServer } from '../server/index';
import { DEFAULT_RULES } from '../shared/types';
import type { Bar, ChartView, SessionCreateConfig, SessionSummary, SessionView } from '../shared/types';

const START = Date.parse('2024-11-03T01:30:00-04:00');
const bars: Bar[] = [0, 1, 60, 61, 120, 121].map((minute, index) => ({ time: START + minute * 60_000, open: 100 + index, high: 100 + index, low: 100 + index, close: 100 + index, volume: 1 }));
const apps: Awaited<ReturnType<typeof createReplayServer>>[] = [];
const directories: string[] = [];
async function setup(dataDirectory?: string) {
    const directory = dataDirectory ?? mkdtempSync(join(tmpdir(), 'vela-end-boundary-'));
    if (dataDirectory === undefined) directories.push(directory);
    const provider = vi.fn(async () => { throw new Error('Session boundaries must not contact a provider'); });
    const app = await createReplayServer({ dataDirectory: directory, port: 0, fetch: provider }); apps.push(app);
    const url = await app.listen(); const { token } = await (await fetch(`${url}/api/bootstrap`)).json() as { token: string };
    const post = (path: string, input: unknown) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify(input) });
    const dataset = app.store.addDataset({ name: 'Absolute DST times with gaps', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars });
    const config = { name: 'Bounded attempt', datasetId: dataset.id, mode: 'practice', initialBalance: 50_000, commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, rules: DEFAULT_RULES };
    const create = async (range: Record<string, unknown> = { startIndex: 1, endIndex: 4 }) => {
        const response = await post('/api/sessions', { ...config, ...range }); expect(response.status).toBe(200);
        return await response.json() as SessionView;
    };
    return { app, url, post, dataset, config, create, provider };
}
afterEach(async () => {
    vi.restoreAllMocks();
    for (const app of apps.splice(0)) await app.close();
    for (const directory of directories.splice(0)) {
        const target = resolve(directory);
        if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('vela-end-boundary-')) throw new Error('Unexpected session-boundary fixture path');
        rmSync(target, { recursive: true, force: true });
    }
});

describe('bounded replay session API', () => {
    it('resolves exclusive calendar ends against actual source times, including gaps and dataset.end, without reading cached prices', async () => {
        const ctx = await setup(); const readBars = vi.spyOn(ctx.app.store, 'readBars');
        for (const [endTime, endIndex] of [[bars[1]!.time, 1], [START + 2 * 60_000, 2], [bars[2]!.time, 2], [bars.at(-1)!.time + 1, bars.length], [ctx.dataset.end, bars.length]]) {
            const result = await ctx.create({ startIndex: 0, endTime });
            expect(result.session.config).toHaveProperty('endIndex', endIndex);
            expect(result.session.config).not.toHaveProperty('endTime');
        }
        const dst = await ctx.create({ startTime: Date.parse('2024-11-03T01:30:00-04:00'), endTime: Date.parse('2024-11-03T01:30:00-05:00') });
        expect(dst.session.config).toMatchObject({ startIndex: 0, endIndex: 2 });
        expect(readBars).not.toHaveBeenCalled(); expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('rejects ambiguous, malformed, outside-source and empty ranges without creating sessions', async () => {
        const ctx = await setup();
        const invalid = [
            ...[-1, 0, 1, 2.5, bars.length + 1, null, '4'].map(endIndex => ({ startIndex: 1, endIndex })),
            ...[START - 1, ctx.dataset.end + 1, null, '4', 1.5, 8_640_000_000_000_001].map(endTime => ({ startIndex: 0, endTime })),
            { startIndex: 0, endIndex: 4, endTime: bars[4]!.time },
            { startIndex: 0, endTime: START },
            { startTime: START + 2 * 60_000, endTime: START + 3 * 60_000 },
            { startIndex: 2, endTime: bars[2]!.time },
        ];
        for (const range of invalid) expect((await ctx.post('/api/sessions', { ...ctx.config, ...range })).status, JSON.stringify(range)).toBe(400);
        expect(ctx.app.store.sessions()).toEqual([]);
    });

    it('resolves second-source boundaries without rounding across the spring DST transition', async () => {
        const ctx = await setup();
        const startTime = Date.parse('2024-03-10T01:59:59-05:00');
        const endTime = Date.parse('2024-03-10T03:00:00-04:00');
        const seconds = [0, 1000, 4000, 5000].map((offset, index) => ({ ...bars[index]!, time: startTime + offset }));
        const dataset = ctx.app.store.addDataset({ name: 'Spring transition seconds', symbol: 'NQM4', schema: 'ohlcv-1s', source: 'csv', bars: seconds });
        for (const [time, endIndex] of [[endTime, 1], [endTime + 1, 2], [dataset.end, seconds.length]]) {
            const request: SessionCreateConfig = { ...ctx.config, mode: 'practice', datasetId: dataset.id, startTime, endTime: time! };
            const response = await ctx.post('/api/sessions', request); expect(response.status).toBe(200);
            expect(((await response.json()) as SessionView).session.config).toMatchObject({ startIndex: 0, endIndex });
        }
    });

    it('fails closed when source rows disagree with the dataset boundaries rather than substituting a cached end', async () => {
        const ctx = await setup();
        for (const metadata of [{ ...ctx.dataset, barCount: 3 }, { ...ctx.dataset, barCount: bars.length + 1 }, { ...ctx.dataset, end: ctx.dataset.end + 60_000 }]) {
            ctx.app.store.db.prepare('UPDATE datasets SET meta=? WHERE id=?').run(JSON.stringify(metadata), ctx.dataset.id);
            for (const range of [{ startIndex: 0, endTime: ctx.dataset.end }, { startIndex: 0, endIndex: 3 }]) {
                expect((await ctx.post('/api/sessions', { ...ctx.config, ...range })).status).toBe(400);
            }
        }
        expect(ctx.app.store.sessions()).toEqual([]);
    });

    it('reports actual selected bounds while retaining the full dataset barCount and legacy sessions', async () => {
        const ctx = await setup(); const bounded = await ctx.create(); const legacy = await ctx.create({ startIndex: 2 });
        expect(legacy.session.config).not.toHaveProperty('endIndex');
        const summaries = ctx.app.store.sessions();
        expect(summaries.find(item => item.id === bounded.session.id)).toMatchObject({ barCount: bars.length, startIndex: 1, endIndex: 4, startTime: bars[1]!.time, endTime: bars[4]!.time, cursor: 0 });
        expect(summaries.find(item => item.id === legacy.session.id)).toMatchObject({ barCount: bars.length, startIndex: 2, endIndex: bars.length, startTime: bars[2]!.time, endTime: ctx.dataset.end });
        const response = await ctx.post(`/api/sessions/${bounded.session.id}/command`, { expectedRevision: 0, command: { type: 'advance', count: 5000 } });
        expect(response.status).toBe(200); const done = await response.json() as SessionView;
        expect(done.session).toMatchObject({ cursor: 3, status: 'completed', config: { endIndex: 4 } });
        const bootstrap = await (await fetch(`${ctx.url}/api/bootstrap`)).json() as { sessions: SessionSummary[] };
        expect(bootstrap.sessions.find(item => item.id === bounded.session.id)).toMatchObject({ cursor: 3, endIndex: 4, barCount: bars.length });
    });

    it('bounds navigation by the resolved source index and clamps advanceTo without inspecting excluded source getters', async () => {
        const ctx = await setup(); const created = await ctx.create({ startIndex: 1, endIndex: 3 }); const path = `/api/sessions/${created.session.id}`;
        const readBars = vi.spyOn(ctx.app.store, 'readBars');
        const lookup = await fetch(`${ctx.url}${path}/navigation?time=${START + 2 * 60_000}`); expect(lookup.status).toBe(200);
        expect(await lookup.json()).toMatchObject({ targetIndex: 2, targetTime: bars[2]!.time });
        for (const time of [bars[3]!.time - 1, bars[3]!.time, ctx.dataset.end]) expect((await fetch(`${ctx.url}${path}/navigation?time=${time}`)).status).toBe(400);
        expect(readBars).not.toHaveBeenCalled();
        const cached = ctx.app.store.readBars(ctx.dataset.id);
        readBars.mockReturnValue(new Proxy(cached, { get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) >= 3) throw new Error(`Excluded source getter ${key}`);
            return Reflect.get(target, key, receiver) as unknown;
        } }));
        const response = await ctx.post(`${path}/command`, { expectedRevision: 0, command: { type: 'advanceTo', time: ctx.dataset.end } });
        expect(response.status).toBe(200); expect(((await response.json()) as SessionView).session).toMatchObject({ cursor: 2, status: 'completed' });
        const chart = await (await fetch(`${ctx.url}${path}/chart?timeframe=1m`)).json() as ChartView;
        expect(chart.bars.map(bar => bar.time)).toEqual(bars.slice(0, 3).map(bar => bar.time));
        expect((await fetch(`${ctx.url}${path}/series?timeframe=1&cursor=3`)).status).toBe(400);
        expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('preserves boundaries through clone, restart, export/import and server reopen; rejects imported cursors outside the range', async () => {
        const ctx = await setup(); const created = await ctx.create(); const path = `/api/sessions/${created.session.id}`;
        const advanced = await ctx.post(`${path}/command`, { expectedRevision: 0, command: { type: 'advance', count: 1 } }); expect(advanced.status).toBe(200);
        const saved = await advanced.json() as SessionView;
        for (const options of [{}, { restart: true }, { restart: true, startIndex: 2 }]) {
            const response = await ctx.post(`${path}/clone`, options); expect(response.status).toBe(200);
            const clone = await response.json() as SessionView;
            expect(clone.session.config).toHaveProperty('endIndex', 4);
            expect(clone.session.cursor).toBe(options.restart ? (options.startIndex ?? 1) - 1 : saved.session.cursor);
        }
        expect((await ctx.post(`${path}/clone`, { restart: true, startIndex: 4 })).status).toBe(400);
        const exported = await (await fetch(`${ctx.url}${path}/export`)).json() as { session: SessionView['session'] };
        const imported = await ctx.post('/api/sessions/import', exported); expect(imported.status).toBe(200);
        expect(((await imported.json()) as SessionView).session.config).toHaveProperty('endIndex', 4);
        exported.session.cursor = 4;
        expect((await ctx.post('/api/sessions/import', exported)).status).toBe(400);
        await ctx.app.close(); apps.splice(apps.indexOf(ctx.app), 1);
        const reopened = await setup(ctx.app.dataDirectory);
        expect(((await (await fetch(`${reopened.url}${path}`)).json()) as SessionView).session).toEqual(saved.session);
        const done = await reopened.post(`${path}/command`, { expectedRevision: saved.session.revision, command: { type: 'advance', count: 5000 } });
        expect(done.status).toBe(200); expect(((await done.json()) as SessionView).session).toMatchObject({ cursor: 3, status: 'completed', config: { endIndex: 4 } });
    });

    it('rejects a persisted cursor outside its end boundary before chart, clone or navigation can expose it', async () => {
        const ctx = await setup(); const created = await ctx.create(); const path = `/api/sessions/${created.session.id}`;
        const malformed = { ...created.session, cursor: 4 };
        ctx.app.store.db.prepare('UPDATE sessions SET state=? WHERE id=?').run(JSON.stringify(malformed), created.session.id);
        for (const action of ['', '/chart?timeframe=1m', `/navigation?time=${bars[4]!.time}`]) expect((await fetch(`${ctx.url}${path}${action}`)).status).toBe(400);
        expect((await ctx.post(`${path}/clone`, {})).status).toBe(400);
    });

    it('keeps explicit deep backtests free to select a different cached range', async () => {
        const ctx = await setup(); const created = await ctx.create({ startIndex: 1, endIndex: 3 });
        const response = await ctx.post('/api/deep-history', { datasetId: ctx.dataset.id, timeframe: '1', from: bars[3]!.time, to: ctx.dataset.end });
        expect(response.status).toBe(200);
        const deep = await response.json() as { bars: Bar[]; scopeId: string };
        expect(deep.bars.map(bar => bar.time)).toEqual(bars.slice(3).map(bar => bar.time));
        expect(ctx.app.store.session(created.session.id)).toEqual(created.session);
        expect((await ctx.post(`/api/deep-history/${deep.scopeId}/release`, {})).status).toBe(200);
        expect(ctx.provider).not.toHaveBeenCalled();
    });
});
