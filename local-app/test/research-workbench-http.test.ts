import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReplayServer } from '../server/index';
import { DEFAULT_RULES, type SessionView } from '../shared/types';
import { pinEventComparison, type EventComparisonRequest, type EventComparisonResult } from '../shared/event-comparison';
import type { MarketStatsRequest, MarketStatsPageResponse } from '../shared/market-stats';

const BASE = Date.UTC(2024, 3, 8);
const fixtures: { directory: string; app: Awaited<ReturnType<typeof createReplayServer>> }[] = [];
afterEach(async () => {
    for (const { directory, app } of fixtures.splice(0)) {
        await app.close();
        const target = realpathSync(directory), parent = realpathSync(tmpdir());
        if (!target.startsWith(parent + sep) || !target.includes('vela-research-http-')) throw new Error('Unexpected fixture directory.');
        rmSync(target, { recursive: true, force: true });
    }
});

async function setup() {
    const directory = resolve(mkdtempSync(join(tmpdir(), 'vela-research-http-')));
    const provider = vi.fn(async () => { throw new Error('Research must not access a provider.'); });
    const app = await createReplayServer({ dataDirectory: directory, port: 0, apiKey: '', fetch: provider });
    fixtures.push({ directory, app });
    const url = await app.listen();
    const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json() as { token: string };
    const post = (path: string, value: unknown, token = bootstrap.token) => fetch(url + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify(value),
    });
    const dataset = app.store.addDataset({ name: 'Research fixture', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv',
        bars: Array.from({ length: 30 }, (_, index) => ({ time: BASE + index * 60_000, open: 100 + index,
            high: 102 + index, low: 99 + index, close: 101 + index, volume: 10 })) });
    let view = await (await post('/api/sessions', { name: 'Research fixture', datasetId: dataset.id, mode: 'practice',
        initialBalance: 50_000, commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES })).json() as SessionView;
    view = await (await post(`/api/sessions/${view.session.id}/command`, {
        expectedRevision: view.session.revision, command: { type: 'advance', count: 5 },
    })).json() as SessionView;
    const path = `/api/sessions/${view.session.id}/scenarios`;
    const get = (suffix = '') => fetch(url + path + suffix);
    return { app, provider, post, path, get, view, url, token: bootstrap.token };
}

const hypothesis = () => ({ thesis: 'A hypothesis to review', trigger: 'Hold the selected level', invalidation: 'Close below support',
    triggerPrice: 105, invalidationPrice: 99, targetPrice: 110, projectedTime: null });
const content = () => ({ title: 'Two-sided plan', bull: hypothesis(), bear: { ...hypothesis(), triggerPrice: 99,
    invalidationPrice: 105, targetPrice: 95 }, notes: 'User-authored hypotheses, not execution instructions.',
    evidence: [{ kind: 'candle', sourceIndex: 2, time: BASE + 2 * 60_000, note: 'Revealed source candle' }] });

describe('research workbench HTTP integration', () => {
    it.each(['create', 'edit', 'archive'] as const)('uses the completed-body replay cursor for a delayed scenario %s', async operation => {
        const ctx = await setup(), context = await (await ctx.get('/context')).json();
        let saved: { id: string; revision: number } | undefined;
        if (operation !== 'create') {
            const response = await ctx.post(ctx.path, { context, content: content() });
            expect(response.status).toBe(200); saved = await response.json() as typeof saved;
        }
        let captured!: () => void;
        const routeCaptured = new Promise<void>(resolve => { captured = resolve; });
        const read = ctx.app.store.session.bind(ctx.app.store);
        const spy = vi.spyOn(ctx.app.store, 'session').mockImplementation(id => { const value = read(id); captured(); return value; });
        const path = operation === 'archive' ? `${ctx.path}/${saved!.id}/archive` : ctx.path;
        let resolveResponse!: (value: { status: number; value: { id: string } }) => void, rejectResponse!: (error: unknown) => void;
        const result = new Promise<{ status: number; value: { id: string } }>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
        const request = httpRequest(ctx.url + path, { method: 'POST', headers: {
            'Content-Type': 'application/json', 'X-Local-Token': ctx.token,
        } }, response => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.on('end', () => {
                try { resolveResponse({ status: response.statusCode!, value: JSON.parse(Buffer.concat(chunks).toString()) as { id: string } }); }
                catch (error) { rejectResponse(error); }
            });
            response.once('error', rejectResponse);
        });
        request.once('error', rejectResponse); request.write('{');
        try {
            await routeCaptured; spy.mockRestore();
            const advance = await ctx.post(`/api/sessions/${ctx.view.session.id}/command`, {
                expectedRevision: ctx.view.session.revision, command: { type: 'advance', count: 5 },
            });
            expect(advance.status).toBe(200); const advanced = await advance.json() as SessionView;
            expect(advanced.session.cursor).toBe(9);
            const input = operation === 'archive' ? { expectedRevision: saved!.revision }
                : { ...(saved ? { id: saved.id, expectedRevision: saved.revision } : {}), context,
                    content: { ...content(), notes: 'Authored after source candle 9 became visible.' } };
            request.end(JSON.stringify(input).slice(1));
            const response = await result; expect(response.status).toBe(200);
            expect(ctx.app.store.db.prepare('SELECT available_cursor FROM local_scenarios WHERE id=?').get(response.value.id)).toEqual({ available_cursor: 9 });
            const beforeRewind = ctx.app.store.session(ctx.view.session.id);
            ctx.app.store.saveSession({ ...structuredClone(ctx.view.session), revision: beforeRewind.revision }, beforeRewind.revision);
            expect((await ctx.get('/' + response.value.id)).status).toBe(404);
            expect(await (await ctx.get('?includeArchived=true')).json()).toEqual([]);
            expect(ctx.provider).not.toHaveBeenCalled();
        } finally { spy.mockRestore(); request.destroy(); }
    });

    it('compares a covered event day through the actual native query and session artifact boundary', async () => {
        const ctx = await setup(), start = Date.UTC(2024, 3, 10);
        const dataset = ctx.app.store.addDataset({ name: 'Covered CPI day', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv',
            bars: Array.from({ length: 12 }, (_, i) => ({ time: start + i * 60_000, open: 100, high: 103, low: 99, close: 102, volume: 1 })) });
        const request: MarketStatsRequest = { datasetId: dataset.id, sourceMode: 'cache', from: start, until: start + 12 * 60_000,
            session: { key: 'short', start: '00:00', end: '00:10', tz: 'UTC', overnight: false }, calendar: null,
            eventCalendar: 'bundled', query: { dsl: 'closeGreen', sessionsLimit: 100 } };
        const before = ctx.app.store.sessions();
        const query = await ctx.post('/api/market-stats/query', request); expect(query.status).toBe(200);
        const page = await query.json() as MarketStatsPageResponse;
        expect(page.result.sessions).toHaveLength(1);
        const input: EventComparisonRequest = { request, pin: pinEventComparison(request, page), calendarEvent: 'CPI',
            sessionIds: [page.result.sessions[0]!.sessionId] };
        const response = await ctx.post('/api/market-stats/event-comparison', input); expect(response.status).toBe(200);
        const result = await response.json() as EventComparisonResult;
        expect(result.pin).toEqual(input.pin); expect(result.calendar.timing).toBe('day-only');
        expect(result.sessions[0]).toMatchObject({ barCount: 10, netChange: { points: 2, ticks: 8, percent: 2 },
            longMae: { points: 1 }, longMfe: { points: 3 }, contract: { symbol: 'NQM4', instrumentId: null } });
        expect(result.sessions[0]!.path.at(-1)!.time).toBe(start + 10 * 60_000);
        expect(ctx.app.store.sessions()).toEqual(before); expect(ctx.provider).not.toHaveBeenCalled();
        expect((await ctx.post('/api/market-stats/event-comparison', { ...input, pin: { ...input.pin, eventFingerprint: 'changed' } })).status).toBe(400);
        expect((await ctx.post('/api/market-stats/event-comparison', { ...input, request: { ...request, eventCalendar: undefined } })).status).toBe(400);
    }, 20_000);
    it('persists an explicit scenario save and preserves the entire replay ledger', async () => {
        const ctx = await setup(), before = ctx.app.store.sessions();
        const captured = await ctx.get('/context'); expect(captured.status).toBe(200);
        const context = await captured.json();
        expect(context).toMatchObject({ sessionId: ctx.view.session.id, datasetId: ctx.view.dataset.id,
            datasetChecksum: ctx.view.dataset.checksum, cursor: 4, cutoff: BASE + 4 * 60_000 });
        const response = await ctx.post(ctx.path, { context, content: content() }); expect(response.status).toBe(200);
        const saved = await response.json() as { id: string; revision: number; content: unknown };
        expect(saved.content).toEqual(content());
        expect((await (await ctx.get()).json()).map((row: { id: string }) => row.id)).toContain(saved.id);
        expect(await (await ctx.get('/' + saved.id)).json()).toEqual(saved);
        expect(ctx.app.store.sessions()).toEqual(before);
        expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('rejects stale scenario saves and leaves the accepted hypothesis intact', async () => {
        const ctx = await setup(), context = await (await ctx.get('/context')).json();
        const first = await ctx.post(ctx.path, { context, content: content() }); expect(first.status).toBe(200);
        const saved = await first.json() as { id: string; revision: number };
        const accepted = await ctx.post(ctx.path, { id: saved.id, expectedRevision: saved.revision, context,
            content: { ...content(), title: 'Accepted edit' } }); expect(accepted.status).toBe(200);
        const conflict = await ctx.post(ctx.path, { id: saved.id, expectedRevision: saved.revision, context,
            content: { ...content(), title: 'Stale edit' } }); expect(conflict.status).toBe(409);
        expect((await (await ctx.get('/' + saved.id)).json()).content.title).toBe('Accepted edit');
        expect(ctx.provider).not.toHaveBeenCalled();
    });

    it('requires the local write token and rejects evidence beyond the revealed clock', async () => {
        const ctx = await setup(), captured = await ctx.get('/context'); expect(captured.status).toBe(200);
        const context = await captured.json();
        expect((await ctx.post(ctx.path, { context, content: content() }, 'invalid')).status).toBe(403);
        const future = { ...content(), evidence: [{ kind: 'candle', sourceIndex: 20, time: BASE + 20 * 60_000, note: 'Unrevealed' }] };
        expect((await ctx.post(ctx.path, { context, content: future })).status).toBe(400);
        expect(await (await ctx.get()).json()).toEqual([]);
        expect(ctx.provider).not.toHaveBeenCalled();
    });
});
