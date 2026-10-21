import { describe, expect, it, vi } from 'vitest';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LocalResearchConnection } from '../mcp-research';
import { createChartMcp } from '../mcp';
import type { MarketStatsRequest, MarketStatsPageResponse } from '../shared/market-stats';
import { buildPreset, getStatsPresetCatalog } from '../server/stats-presets';
import { analytics, createSession } from '../engine/index';
import { DEFAULT_RULES } from '../shared/types';
import type { SessionBarsResult } from '@luxalgo/edge-stats/session-bars';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createReplayServer } from '../server/index';
import { describeEventSession, pinEventComparison, type EventComparisonResult, type EventComparisonRequest } from '../shared/event-comparison';

const DATASET = '11111111-1111-4111-8111-111111111111';
const REPLAY = '22222222-2222-4222-8222-222222222222';
const START = Date.UTC(2024, 3, 8);
const MATCH = 'NQM4|regular|2024-04-08';
const names = ['vela_research_apps', 'vela_edge_sources', 'vela_edge_fields', 'vela_edge_presets',
    'vela_edge_query', 'vela_edge_report', 'vela_edge_session_bars', 'vela_compare_event_sessions', 'vela_backtest_sessions', 'vela_backtest_statistics'];
function request(): MarketStatsRequest {
    return { datasetId: DATASET, sourceMode: 'cache', from: START, until: START + 60_000 * 60,
        session: { key: 'regular', start: '09:30', end: '16:00', tz: 'America/New_York', overnight: false },
        calendar: null, query: { dsl: 'closeGreen', sessionsLimit: 25 } };
}
function selected(input = request()) {
    return { datasetId: input.datasetId, name: 'Synthetic only', symbol: 'NQM4', checksum: 'c'.repeat(64),
        sourceMode: input.sourceMode, from: input.from, until: input.until,
        ...(input.replay ? { replay: { ...input.replay, cursor: 59 } } : {}), ...(input.eventCalendar ? { eventCalendar: input.eventCalendar } : {}) };
}
function page(input = request()) {
    return { source: { repository: 'https://github.com/LuxAlgo/edge-stats', commit: 'c'.repeat(40), version: '0.1.0' },
        coverage: { revealedUntil: input.until, fingerprint: 'synthetic-fingerprint', calendarMode: 'schedule-only' },
        warnings: ['Synthetic schedule-only source'], result: { n: 0, estimate: null, sessions: [{ sessionId: MATCH }] }, selection: selected(input) };
}
function sessionBars(): SessionBarsResult {
    return { sessionId: MATCH, symbol: 'NQM4', sessionKey: 'regular', tradeDate: '2024-04-08', tf: '1m', tz: 'America/New_York',
        startTs: START, endTs: request().until, isHalfDay: false, isRollDay: false, complete: true,
        bars: [{ ts: START, open: 100, high: 101, low: 99, close: 100, volume: 1 }], context: { kind: 'none', bars: [], note: 'Synthetic source' },
        levels: { prevClose: null, prevHigh: null, prevLow: null, prevMid: null, open: 100, high: 101, low: 99, close: 100,
            gapAbs: null, gapPct: null, gapDir: null, gapFilled: null, touchedPrevHigh: null, touchedPrevLow: null, ibBreak: null, ibWindow: 60, openingRanges: [] },
        times: { gapFillMin: null, touchPrevHighMin: null, touchPrevLowMin: null, highTimeMin: null, lowTimeMin: null }, disclaimer: 'Synthetic fixture' };
}
function artifact(input = request()) {
    return { kind: 'session', session: sessionBars(), selection: selected(input), source: page(input).source,
        coverage: page(input).coverage, query: { ...input.query, symbol: 'NQM4', sessionKey: input.session.key } };
}
function stats(points = 5) {
    const value = analytics(createSession({ name: 'Synthetic ledger', datasetId: DATASET, mode: 'practice', initialBalance: 50_000,
        commissionPerContractSide: 1, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES },
    { root: 'NQ', tickSize: 0.25, pointValue: 20 }));
    return { ...value, equityCurve: Array.from({ length: points }, (_, index) => ({ time: START + index * 60_000, balance: 50_000 + index, equity: 50_000 - index })) };
}
const catalog = { datasets: [{ id: DATASET, checksum: 'c'.repeat(64) }], sessions: [{ id: REPLAY, revision: 3 }], registry: [{ name: 'closeGreen' }], limits: { bars: 250_000 } };
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
function output(value: Record<string, unknown>): unknown {
    expect(value, JSON.stringify(value)).not.toHaveProperty('result.isError', true);
    return JSON.parse((value.result as { content: { text: string }[] }).content[0]!.text);
}
async function rpc(connection: LocalResearchConnection) {
    const chart = { clients: vi.fn(async () => { throw new Error('No chart available'); }), call: vi.fn(async () => { throw new Error('No chart available'); }) };
    const server = createChartMcp(chart, connection);
    const [client, transport] = InMemoryTransport.createLinkedPair(); let id = 0;
    const waiting = new Map<number, (value: Record<string, unknown>) => void>();
    client.onmessage = (message: JSONRPCMessage) => {
        if ('id' in message && typeof message.id === 'number') {
            waiting.get(message.id)?.(message as unknown as Record<string, unknown>); waiting.delete(message.id);
        }
    };
    await server.connect(transport); await client.start();
    const send = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>(resolve => {
        waiting.set(++id, resolve); void client.send({ jsonrpc: '2.0', id, method, params });
    });
    await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'proof', version: '1' } });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return { request: send, call: (name: string, args: Record<string, unknown>) => send('tools/call', { name, arguments: args }),
        cancel: () => client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Synthetic cancellation' } }),
        chart, close: async () => { waiting.clear(); await client.close(); await server.close(); } };
}

describe('typed local research MCP', () => {
    it('advertises report, source and backtesting access without connecting on registration', async () => {
        const remote = vi.fn<typeof fetch>(); const ctx = await rpc(new LocalResearchConnection(remote));
        try {
            const value = await ctx.request('tools/list', {});
            const list = (value.result as { tools: { name: string; annotations: { readOnlyHint: boolean; openWorldHint: boolean } }[] }).tools;
            expect(list).toHaveLength(50);
            expect(list.filter(tool => names.includes(tool.name)).map(tool => tool.name)).toEqual(names);
            expect(list.filter(tool => names.includes(tool.name)).every(tool => tool.annotations.readOnlyHint && !tool.annotations.openWorldHint)).toBe(true);
            expect(list.every(tool => !/order|provider|export|shell|credential/.test(tool.name))).toBe(true);
            expect(remote).not.toHaveBeenCalled(); expect(ctx.chart.clients).not.toHaveBeenCalled(); expect(ctx.chart.call).not.toHaveBeenCalled();
        } finally { await ctx.close(); }
    });
    it('pins one explicit app mode and keeps bootstrap credentials private', async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        const remote = vi.fn<typeof fetch>(async (url, init) => { calls.push({ url: String(url), init });
            return Response.json(String(url).endsWith('/api/bootstrap') ? { token: 'a'.repeat(64), dataDirectory: 'private-folder' } : page()); });
        const connection = new LocalResearchConnection(remote);
        const value = await connection.query('develop', request());
        expect(calls.map(call => call.url)).toEqual(['http://127.0.0.1:5199/api/bootstrap', 'http://127.0.0.1:5199/api/market-stats/query']);
        expect(calls[1]!.init?.headers).toMatchObject({ 'X-Local-Token': 'a'.repeat(64) });
        expect(calls.every(call => call.init?.redirect === 'error')).toBe(true);
        expect(JSON.stringify(value)).not.toContain('private-folder'); expect(JSON.stringify(value)).not.toContain('a'.repeat(64));
    });
    it('rejects malformed source modes and arbitrary destinations before making a request', async () => {
        const remote = vi.fn<typeof fetch>(); const ctx = await rpc(new LocalResearchConnection(remote));
        try {
            const result = await ctx.call('vela_edge_query', { mode: 'http://example.com', request: { sourceMode: ['replay'] } });
            expect(result.error ?? (result.result as { isError?: boolean })?.isError).toBeTruthy(); expect(remote).not.toHaveBeenCalled();
            for (const mode of ['constructor', '__proto__', '', 'http://127.0.0.1:1234']) {
                await expect(new LocalResearchConnection(remote).catalog(mode as 'run')).rejects.toThrow('Invalid local research payload');
            }
            expect(remote).not.toHaveBeenCalled();
        } finally { await ctx.close(); }
    });
    it('sanitizes failed HTTP responses and rejects private fields in successful results', async () => {
        const connection = new LocalResearchConnection(vi.fn(async () => Response.json({ token: 'secret', error: 'private-file-path' }, { status: 500 })));
        await expect(connection.catalog('desktop')).rejects.toThrow('Local research request failed (500).');
        const compromised = new LocalResearchConnection(vi.fn(async () => Response.json({ token: 'secret' })));
        await expect(compromised.catalog('run')).rejects.toThrow(/private/i);
    });
    it('discovers all exact modes without bootstrap and never falls back for an explicit failed mode', async () => {
        const remote = vi.fn<typeof fetch>(async url => {
            if (String(url).includes(':5197/')) throw new Error('private socket detail');
            return Response.json(catalog);
        });
        const ctx = await rpc(new LocalResearchConnection(remote));
        try {
            expect(output(await ctx.call('vela_research_apps', {}))).toEqual([
                { mode: 'desktop', available: true, datasets: 1, sessions: 1 }, { mode: 'run', available: false }, { mode: 'develop', available: true, datasets: 1, sessions: 1 },
            ]);
            expect(remote.mock.calls.map(([url]) => String(url))).toEqual([5196, 5197, 5199].map(port => 'http://127.0.0.1:' + port + '/api/market-stats'));
            remote.mockClear();
            const failure = await ctx.call('vela_edge_sources', { mode: 'run' });
            expect(failure).toHaveProperty('result.isError', true);
            expect(JSON.stringify(failure)).not.toContain('private socket');
            expect(remote.mock.calls.map(([url]) => String(url))).toEqual(['http://127.0.0.1:5197/api/market-stats']);
        } finally { await ctx.close(); }
    });
    it('refreshes only the rejected mode on the next explicit request without replaying a POST', async () => {
        const current = new Map([['5199', 'a'.repeat(64)], ['5197', 'b'.repeat(64)]]);
        const remote = vi.fn<typeof fetch>(async (url, init) => {
            const port = new URL(String(url)).port;
            if (String(url).endsWith('/api/bootstrap')) return Response.json({ token: current.get(port) });
            if (new Headers(init?.headers).get('x-local-token') !== current.get(port)) return Response.json({ error: 'private' }, { status: 403 });
            return Response.json(page());
        });
        const connection = new LocalResearchConnection(remote);
        await connection.query('develop', request()); await connection.query('run', request());
        current.set('5199', 'd'.repeat(64));
        await expect(connection.query('develop', request())).rejects.toThrow('not retried');
        expect(remote).toHaveBeenCalledTimes(5);
        await connection.query('run', request());
        await connection.query('develop', request());
        expect(remote.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
            '/api/bootstrap', '/api/market-stats/query', '/api/bootstrap', '/api/market-stats/query', '/api/market-stats/query',
            '/api/market-stats/query', '/api/bootstrap', '/api/market-stats/query',
        ]);
    });
    it('rejects invalid or missing bootstrap tokens before dispatching any calculation', async () => {
        for (const bootstrap of [null, {}, { token: 'wrong', dataDirectory: 'private' }]) {
            const remote = vi.fn<typeof fetch>(async () => Response.json(bootstrap));
            await expect(new LocalResearchConnection(remote).query('run', request())).rejects.toThrow('Reconnect');
            expect(remote).toHaveBeenCalledTimes(1);
        }
    });
    it.each(['token', 'refresh_token', 'Api-Key', 'Authorization', 'set-cookie', 'credentials', 'dataDirectory', 'repositoryDirectory', '__proto__', 'constructor', 'prototype'])(
        'rejects nested private field %s without echoing values', async key => {
            const remote = vi.fn<typeof fetch>(async () => new Response('{"catalog":{"' + key + '":"private-value"}}'));
            const ctx = await rpc(new LocalResearchConnection(remote));
            try {
                const value = await ctx.call('vela_edge_presets', { mode: 'run' });
                expect(value).toHaveProperty('result.isError', true);
                expect(JSON.stringify(value)).not.toContain('private-value');
            } finally { await ctx.close(); }
        });
    it('rejects a token echoed under an innocent key after private bootstrap', async () => {
        const remote = vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith('/api/bootstrap')
            ? { token: 'a'.repeat(64), dataDirectory: 'private-path' } : { note: 'a'.repeat(64) }));
        const ctx = await rpc(new LocalResearchConnection(remote));
        try {
            const value = await ctx.call('vela_edge_query', { mode: 'run', request: request() });
            expect(value).toHaveProperty('result.isError', true);
            expect(JSON.stringify(value)).not.toContain('a'.repeat(64)); expect(JSON.stringify(value)).not.toContain('private-path');
        } finally { await ctx.close(); }
    });
    it('rejects unknown nested fields, ambiguous replay scope and unbounded inputs before HTTP', async () => {
        const remote = vi.fn<typeof fetch>(); const ctx = await rpc(new LocalResearchConnection(remote)); const base = request();
        const bad = [{ ...base, url: 'http://example.com' }, { ...base, sourceMode: ['cache'] }, { ...base, sourceMode: 'replay' },
            { ...base, replay: { id: REPLAY, revision: 1 } }, { ...base, from: START + 1 }, { ...base, until: START },
            { ...base, from: Number.MAX_SAFE_INTEGER + 1 }, { ...base, until: START + 11 * 366 * 86_400_000 },
            { ...base, session: { ...base.session, start: '99:00' } }, { ...base, session: { ...base.session, tz: 'Not/AZone' } },
            { ...base, query: { dsl: 'x'.repeat(2001) } }, { ...base, query: { dsl: 'closeGreen', sessionsLimit: 101 } },
            { ...base, query: { dsl: 'closeGreen', since: '2024-02-30' } }, { ...base, query: { dsl: 'closeGreen', since: '2025-01-01', until: '2024-01-01' } },
            { ...base, calendar: { extra: {} } }, { ...base, session: { ...base.session, token: 'private' } }];
        try {
            for (const input of bad) expect(await ctx.call('vela_edge_query', { mode: 'run', request: input })).toHaveProperty('result.isError', true);
            expect(await ctx.call('vela_edge_session_bars', { mode: 'run', request: base, sessionId: MATCH, contextBars: 241 })).toHaveProperty('result.isError', true);
            expect(await ctx.call('vela_backtest_statistics', { mode: 'run', sessionId: REPLAY, curveLimit: 1001 })).toHaveProperty('result.isError', true);
            expect(remote).not.toHaveBeenCalled();
        } finally { await ctx.close(); }
    });
    it('accepts a full-day end clock through MCP while keeping starts and other end clocks strict', async () => {
        const sent: MarketStatsRequest[] = [];
        const remote = vi.fn<typeof fetch>(async (url, init) => {
            if (String(url).endsWith('/api/bootstrap')) return Response.json({ token: 'a'.repeat(64) });
            const input = JSON.parse(String(init?.body)) as MarketStatsRequest;
            sent.push(input); return Response.json(page(input));
        });
        const ctx = await rpc(new LocalResearchConnection(remote));
        const input = { ...request(), session: { key: 'day', start: '00:00', end: '24:00', tz: 'UTC', overnight: false } };
        try {
            output(await ctx.call('vela_edge_query', { mode: 'run', request: input }));
            expect(sent).toHaveLength(1); expect(sent[0]!.session).toEqual(input.session);
            for (const session of [{ ...input.session, start: '24:00' }, { ...input.session, end: '24:01' }, { ...input.session, end: '25:00' }]) {
                expect(await ctx.call('vela_edge_query', { mode: 'run', request: { ...input, session } })).toHaveProperty('result.isError', true);
            }
            expect(sent).toHaveLength(1);
        } finally { await ctx.close(); }
    });
    it('compares exact event receipts through MCP and discloses sampled paths without changing metrics', async () => {
        const requestWithEvents: MarketStatsRequest = { ...request(), eventCalendar: 'bundled' };
        const comparison: EventComparisonRequest = { request: requestWithEvents,
            pin: { ...pinEventComparison(requestWithEvents, page(requestWithEvents) as unknown as MarketStatsPageResponse), eventFingerprint: 'event-fingerprint' },
            calendarEvent: 'CPI', sessionIds: [MATCH] };
        const s = sessionBars(); s.context = { kind: 'none', note: 'No context', bars: [] };
        const value: EventComparisonResult = { pin: comparison.pin, calendar: { event: 'CPI', version: '1', sources: [],
            coverage: { from: '2024-01-01', to: '2024-12-31' }, fingerprint: 'calendar-fingerprint', timing: 'day-only' },
            sessions: [describeEventSession(s, { tickSize: 0.25, revealedUntil: s.endTs })],
            basis: 'First measured session open', disclaimer: 'Descriptive day-only comparison' };
        const remote = vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith('/api/bootstrap') ? { token: 'a'.repeat(64) } : value));
        const ctx = await rpc(new LocalResearchConnection(remote));
        try {
            const report = output(await ctx.call('vela_compare_event_sessions', { mode: 'run', comparison, pathLimit: 0 })) as EventComparisonResult;
            expect(report.pin).toEqual(comparison.pin); expect(report.sessions[0]!.netChange).toEqual(value.sessions[0]!.netChange);
            expect(report.sessions[0]!.path).toEqual([]);
            expect(report.sessions[0]).toHaveProperty('pathCoverage', { measured: 1, returned: 0, sampled: true });
            expect(remote.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/bootstrap', '/api/market-stats/event-comparison']);
            value.pin = { ...value.pin, eventFingerprint: 'changed' };
            expect(await ctx.call('vela_compare_event_sessions', { mode: 'run', comparison })).toHaveProperty('result.isError', true);
        } finally { await ctx.close(); }
    });
    it('bounds serialized request bodies before bootstrap, including structurally valid calendar data', async () => {
        const remote = vi.fn<typeof fetch>(); const input = request();
        input.calendar = { exchange: 'synthetic', version: '1', sources: [], coverage: { from: '2020-01-01', to: '2030-01-01' },
            holidays: Array.from({ length: 1000 }, () => ({ date: '2024-01-01', name: 'x'.repeat(200) })), halfDays: [] };
        await expect(new LocalResearchConnection(remote).query('develop', input)).rejects.toThrow('size limit');
        expect(remote).not.toHaveBeenCalled();
    });
    it('bounds streamed bytes and cancels the reader before returning an oversized response', async () => {
        const cancelled = vi.fn(); const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel: cancelled });
        const connection = new LocalResearchConnection(vi.fn(async () => new Response(stream)));
        await expect(connection.presets('run')).rejects.toThrow('size limit');
        expect(cancelled).toHaveBeenCalledTimes(1);
    });
    it.each([
        ['graph width', '[' + '0,'.repeat(60_001) + '0]'],
        ['graph depth', '['.repeat(26) + '0' + ']'.repeat(26)],
        ['nonfinite number', '{"value":1e309}'],
        ['invalid JSON', '{"private-path":'],
    ])('rejects %s without exposing a raw body', async (_, raw) => {
        const ctx = await rpc(new LocalResearchConnection(vi.fn(async () => new Response(raw))));
        try {
            const value = await ctx.call('vela_edge_presets', { mode: 'run' });
            expect(value).toHaveProperty('result.isError', true); expect(JSON.stringify(value)).not.toContain('private-path');
        } finally { await ctx.close(); }
    });
    it('bounds UTF-8 tool output separately from the larger transport limit', async () => {
        const ctx = await rpc(new LocalResearchConnection(vi.fn(async () => Response.json({ description: '界'.repeat(180_000) }))));
        try { expect(await ctx.call('vela_edge_presets', { mode: 'run' })).toHaveProperty('result.isError', true); }
        finally { await ctx.close(); }
    });
    it.each([403, 404, 409, 500])('does not retry or reflect a failed HTTP %i response', async status => {
        const remote = vi.fn<typeof fetch>(async () => Response.json({ error: 'private-file-path', token: 'private-secret' }, { status }));
        const ctx = await rpc(new LocalResearchConnection(remote));
        try {
            const value = await ctx.call('vela_edge_presets', { mode: 'run' });
            expect(value).toHaveProperty('result.isError', true); expect(remote).toHaveBeenCalledTimes(1);
            expect(JSON.stringify(value)).not.toMatch(/private-file-path|private-secret/);
        } finally { await ctx.close(); }
    });
    it('checks returned dataset, scope, replay revision and cutoff rather than relabeling a mismatched result', async () => {
        const input = { ...request(), sourceMode: 'replay' as const, replay: { id: REPLAY, revision: 3 } };
        const good = page(input);
        for (const value of [
            { ...good, selection: { ...good.selection, datasetId: REPLAY } },
            { ...good, selection: { ...good.selection, sourceMode: 'cache' } },
            { ...good, selection: { ...good.selection, replay: { id: REPLAY, revision: 4, cursor: 59 } } },
            { ...good, coverage: { ...good.coverage, revealedUntil: input.until + 60_000 } },
            { ...good, selection: { ...good.selection, until: input.until + 60_000 } },
        ]) {
            const remote = vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith('/api/bootstrap') ? { token: 'a'.repeat(64) } : value));
            await expect(new LocalResearchConnection(remote).query('run', input)).rejects.toThrow(/source/);
        }
    });
    it('rejects mismatched, malformed, future and roll-context session graphs', async () => {
        const good = artifact();
        const context = { kind: 'pre-session', bars: [{ ...good.session.bars[0]!, ts: START }], note: 'Synthetic' };
        for (const value of [
            { ...good, session: { ...good.session, sessionId: 'unmatched' } },
            { ...good, selection: { ...good.selection, datasetId: REPLAY } },
            { ...good, session: { ...good.session, endTs: request().until + 60_000 } },
            { ...good, session: { ...good.session, bars: [{ ...good.session.bars[0]!, ts: request().until }] } },
            { ...good, session: { ...good.session, bars: [{ ...good.session.bars[0]!, high: 99 }] } },
            { ...good, session: { ...good.session, bars: [...good.session.bars, ...good.session.bars] } },
            { ...good, session: { ...good.session, isRollDay: true, context } },
            { ...good, session: { ...good.session, context } },
        ]) {
            const remote = vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith('/api/bootstrap') ? { token: 'a'.repeat(64) } : value));
            await expect(new LocalResearchConnection(remote).sessionBars('run', { request: request(), sessionId: MATCH, contextBars: 0 })).rejects.toThrow(/research/);
        }
    });
    it('enables bundled event context only by explicit choice and carries it through report composition and execution', async () => {
        const built = { dsl: 'closeGreen', preset: { id: 'synthetic', title: 'Synthetic', version: 1, params: {} } };
        const remote = vi.fn<typeof fetch>(async (url, init) => {
            if (String(url).endsWith('/api/bootstrap')) return Response.json({ token: 'a'.repeat(64) });
            if (String(url).includes('/presets')) return Response.json({ presets: [], coverage: null });
            if (String(url).endsWith('/preset')) return Response.json(built);
            return Response.json(page(JSON.parse(String(init?.body)) as MarketStatsRequest));
        });
        const ctx = await rpc(new LocalResearchConnection(remote)); const { query: _, ...source } = request();
        try {
            expect(output(await ctx.call('vela_edge_presets', { mode: 'run' }))).toMatchObject({ eventCalendar: null });
            expect(output(await ctx.call('vela_edge_presets', { mode: 'run', eventCalendar: 'bundled' }))).toMatchObject({ eventCalendar: 'bundled' });
            expect(remote.mock.calls.slice(0, 2).map(([url]) => String(url))).toEqual([
                'http://127.0.0.1:5197/api/market-stats/presets', 'http://127.0.0.1:5197/api/market-stats/presets?events=bundled',
            ]);
            expect(output(await ctx.call('vela_edge_report', { mode: 'run', request: source, preset: { id: 'synthetic' } }))).toMatchObject({ result: { estimate: null } });
            expect(output(await ctx.call('vela_edge_report', { mode: 'run', request: { ...source, eventCalendar: 'bundled' }, preset: { id: 'synthetic' } }))).toMatchObject({ result: { estimate: null } });
            const bodies = remote.mock.calls.filter(([, init]) => init?.body).map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
            expect(bodies[0]).not.toHaveProperty('eventCalendar'); expect(bodies[1]).not.toHaveProperty('eventCalendar');
            expect(bodies[2]).toHaveProperty('eventCalendar', 'bundled'); expect(bodies[3]).toHaveProperty('eventCalendar', 'bundled');
            remote.mockClear();
            for (const value of [true, 'remote', ['bundled']]) expect(await ctx.call('vela_edge_presets', { mode: 'run', eventCalendar: value })).toHaveProperty('result.isError', true);
            expect(await ctx.call('vela_edge_report', { mode: 'run', request: source, preset: { id: 'synthetic', eventCalendar: 'bundled' } })).toHaveProperty('result.isError', true);
            expect(remote).not.toHaveBeenCalled();
        } finally { await ctx.close(); }
    });
    it('cancels an already aborted operation before bootstrap without exposing its supplied reason', async () => {
        const remote = vi.fn<typeof fetch>(); const controller = new AbortController(); controller.abort(new Error('private reason'));
        await expect(new LocalResearchConnection(remote).query('run', request(), controller.signal)).rejects.toThrow('cancelled');
        expect(remote).not.toHaveBeenCalled();
    });
    it.each(['headers', 'stream'])('enforces its deadline while waiting for %s even if transport ignores the signal', async phase => {
        const original = AbortSignal.timeout.bind(AbortSignal);
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => original(20));
        const cancelled = vi.fn();
        const remote = vi.fn<typeof fetch>(async () => phase === 'headers' ? await new Promise<Response>(() => {})
            : new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })));
        try {
            await expect(new LocalResearchConnection(remote).presets('run')).rejects.toThrow('timed out');
            expect(remote).toHaveBeenCalledTimes(1);
            if (phase === 'stream') expect(cancelled).toHaveBeenCalledTimes(1);
        } finally { timeout.mockRestore(); }
    });
    it.each(names)('propagates real MCP cancellation for %s', async name => {
        const started = deferred<void>(); const cancelled = deferred<void>();
        const remote = vi.fn<typeof fetch>(async (url, init) => {
            if (String(url).endsWith('/api/bootstrap')) return Response.json({ token: 'a'.repeat(64) });
            init?.signal?.addEventListener('abort', () => cancelled.resolve(), { once: true });
            started.resolve(); return new Promise<Response>(() => {});
        });
        const ctx = await rpc(new LocalResearchConnection(remote));
        const base = request(); const { query: _, ...source } = base;
        const args: Record<string, unknown> = name === 'vela_research_apps' ? {} : { mode: 'run' };
        if (['vela_edge_query', 'vela_edge_session_bars'].includes(name)) args.request = base;
        if (name === 'vela_edge_report') { args.request = source; args.preset = { id: 'synthetic' }; }
        if (name === 'vela_edge_session_bars') args.sessionId = MATCH;
        if (name === 'vela_compare_event_sessions') {
            const input: MarketStatsRequest = { ...base, eventCalendar: 'bundled' };
            args.comparison = { request: input, pin: { ...pinEventComparison(input, page(input) as unknown as MarketStatsPageResponse),
                eventFingerprint: 'event-fingerprint' }, calendarEvent: 'CPI', sessionIds: [MATCH] };
        }
        if (name === 'vela_backtest_statistics') args.sessionId = REPLAY;
        try {
            void ctx.call(name, args);
            await started.promise; await ctx.cancel(); await cancelled.promise;
            expect(remote.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
            expect(ctx.chart.clients).not.toHaveBeenCalled(); expect(ctx.chart.call).not.toHaveBeenCalled();
        } finally { await ctx.close(); }
    });
    it('does not dispatch the query after a cancelled report composition', async () => {
        const started = deferred<void>(); const cancelled = deferred<void>(); const { query: _, ...source } = request();
        const remote = vi.fn<typeof fetch>(async (url, init) => {
            if (String(url).endsWith('/api/bootstrap')) return Response.json({ token: 'a'.repeat(64) });
            init?.signal?.addEventListener('abort', () => cancelled.resolve(), { once: true }); started.resolve();
            return new Promise<Response>(() => {});
        });
        const ctx = await rpc(new LocalResearchConnection(remote));
        try {
            void ctx.call('vela_edge_report', { mode: 'run', request: source, preset: { id: 'synthetic' } });
            await started.promise; await ctx.cancel(); await cancelled.promise;
            expect(remote.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/bootstrap', '/api/market-stats/preset']);
        } finally { await ctx.close(); }
    });
    it('cancels report execution after composition without retrying either POST', async () => {
        const started = deferred<void>(); const cancelled = deferred<void>(); const { query: _, ...source } = request();
        const remote = vi.fn<typeof fetch>(async (url, init) => {
            if (String(url).endsWith('/api/bootstrap')) return Response.json({ token: 'a'.repeat(64) });
            if (String(url).endsWith('/preset')) return Response.json({ dsl: 'closeGreen', preset: { id: 'synthetic', title: 'Synthetic', version: 1, params: {} } });
            init?.signal?.addEventListener('abort', () => cancelled.resolve(), { once: true }); started.resolve();
            return new Promise<Response>(() => {});
        });
        const ctx = await rpc(new LocalResearchConnection(remote));
        try {
            void ctx.call('vela_edge_report', { mode: 'run', request: source, preset: { id: 'synthetic' } });
            await started.promise; await ctx.cancel(); await cancelled.promise;
            expect(remote.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/bootstrap', '/api/market-stats/preset', '/api/market-stats/query']);
        } finally { await ctx.close(); }
    });
    it.each([0, 1, 3, 1000])('samples retained equity with curveLimit %i while preserving account and null statistics', async curveLimit => {
        const original = { ...stats(), netPnl: 125.5, maxDrawdown: 800 };
        const ctx = await rpc(new LocalResearchConnection(vi.fn(async () => Response.json(original))));
        try {
            const value = output(await ctx.call('vela_backtest_statistics', { mode: 'desktop', sessionId: REPLAY, curveLimit })) as {
                statistics: ReturnType<typeof stats>; equityCoverage: unknown; metricBasis: Record<string, string>;
            };
            const expected = curveLimit === 0 ? [] : curveLimit === 1 ? [original.equityCurve[4]] : curveLimit === 3 ? [original.equityCurve[0], original.equityCurve[2], original.equityCurve[4]] : original.equityCurve;
            expect(value.statistics).toEqual({ ...original, equityCurve: expected });
            expect(value.equityCoverage).toEqual({ retained: 5, returned: Math.min(curveLimit, 5), sampled: curveLimit < 5 });
            expect(value.metricBasis.maxDrawdown).toContain('account');
            expect(value.metricBasis.avgR).toContain('coverage count unavailable');
            expect(value.statistics.winRate).toBeNull(); expect(value.statistics.profitFactor).toBeNull(); expect(value.statistics.avgR).toBeNull();
        } finally { await ctx.close(); }
    });
    it('rejects missing analytics and preserves an empty retained curve without fabricated points', async () => {
        const malformed = await rpc(new LocalResearchConnection(vi.fn(async () => Response.json({ equityCurve: [] }))));
        try { expect(await malformed.call('vela_backtest_statistics', { mode: 'run', sessionId: REPLAY })).toHaveProperty('result.isError', true); }
        finally { await malformed.close(); }
        const ctx = await rpc(new LocalResearchConnection(vi.fn(async () => Response.json(stats(0)))));
        try { expect(output(await ctx.call('vela_backtest_statistics', { mode: 'run', sessionId: REPLAY }))).toMatchObject({ statistics: { equityCurve: [] }, equityCoverage: { retained: 0, returned: 0, sampled: false } }); }
        finally { await ctx.close(); }
    });
    it.each([undefined, 1000])('bounds a large retained account curve at the default or maximum limit %s', async curveLimit => {
        const original = stats(1005);
        const ctx = await rpc(new LocalResearchConnection(vi.fn(async () => Response.json(original))));
        try {
            const value = output(await ctx.call('vela_backtest_statistics', { mode: 'run', sessionId: REPLAY, ...(curveLimit === undefined ? {} : { curveLimit }) })) as {
                statistics: ReturnType<typeof stats>; equityCoverage: unknown;
            };
            expect(value.statistics.equityCurve).toHaveLength(curveLimit ?? 200);
            expect(value.statistics.equityCurve[0]).toEqual(original.equityCurve[0]);
            expect(value.statistics.equityCurve.at(-1)).toEqual(original.equityCurve.at(-1));
            expect(value.equityCoverage).toEqual({ retained: 1005, returned: curveLimit ?? 200, sampled: true });
        } finally { await ctx.close(); }
    });
    it('paginates saved summaries without exposing the unrequested entries', async () => {
        const sessions = Array.from({ length: 4 }, (_, index) => ({ id: String(index), revision: index }));
        const ctx = await rpc(new LocalResearchConnection(vi.fn(async () => Response.json(sessions))));
        try { expect(output(await ctx.call('vela_backtest_sessions', { mode: 'run', offset: 1, limit: 2 }))).toMatchObject({ total: 4, offset: 1, sessions: sessions.slice(1, 3) }); }
        finally { await ctx.close(); }
    });
    it('uses the native local API and actual statistics workers over MCP with an isolated synthetic store', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'vela-mcp-'));
        const provider = vi.fn(async () => { throw new Error('No acquisition in synthetic MCP proof'); });
        const app = await createReplayServer({ dataDirectory: directory, port: 0, apiKey: '', fetch: provider });
        let ctx: Awaited<ReturnType<typeof rpc>> | undefined;
        try {
            const origin = new URL(await app.listen());
            const bars = Array.from({ length: 12 }, (_, index) => ({ time: START + index * 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 1 }));
            const dataset = app.store.addDataset({ name: 'Synthetic native MCP source', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars });
            const session = createSession({ name: 'Synthetic native MCP ledger', datasetId: dataset.id, mode: 'practice', initialBalance: 50_000,
                commissionPerContractSide: 1, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES }, dataset.instrument);
            app.store.createSession(session);
            const before = JSON.stringify(app.store.session(session.id));
            const input: MarketStatsRequest = { ...request(), datasetId: dataset.id, from: dataset.start, until: dataset.end,
                session: { key: 'short', start: '00:00', end: '00:10', tz: 'UTC', overnight: false } };
            const remote = vi.fn<typeof fetch>(async (url, init) => {
                const logical = new URL(String(url));
                if (logical.origin !== 'http://127.0.0.1:5199') throw new Error('Only synthetic develop source is bound');
                logical.port = origin.port; return fetch(logical, init);
            });
            ctx = await rpc(new LocalResearchConnection(remote));
            expect(output(await ctx.call('vela_edge_sources', { mode: 'develop' }))).toMatchObject({ datasets: [{ id: dataset.id, checksum: dataset.checksum }], sessions: [{ id: session.id }] });
            expect(output(await ctx.call('vela_edge_presets', { mode: 'develop' }))).toMatchObject({ eventCalendar: null, catalog: { total: 42 } });
            const value = output(await ctx.call('vela_edge_query', { mode: 'develop', request: input })) as { result: { sessions: { sessionId: string }[] } };
            expect(value).toMatchObject({ mode: 'develop', selection: { datasetId: dataset.id, checksum: dataset.checksum }, result: { n: 1, estimate: null, guards: { refused: true } } });
            const matched = value.result.sessions[0]!.sessionId;
            const detailResult = await ctx.call('vela_edge_session_bars', { mode: 'develop', request: input, sessionId: matched, contextBars: 0 });
            const detail = output(detailResult);
            expect(detail).toMatchObject({ mode: 'develop', kind: 'session', selection: { datasetId: dataset.id }, session: { sessionId: matched, complete: true, tf: '1m', context: { bars: [] } } });
            const replayInput = { ...input, sourceMode: 'replay', replay: { id: session.id, revision: session.revision } };
            expect(output(await ctx.call('vela_edge_query', { mode: 'develop', request: replayInput }))).toMatchObject({
                selection: { until: START, replay: { id: session.id, revision: session.revision, cursor: -1 } }, result: { n: 0, estimate: null },
            });
            expect(await ctx.call('vela_edge_session_bars', { mode: 'develop', request: replayInput, sessionId: matched, contextBars: 0 })).toHaveProperty('result.isError', true);
            expect(await ctx.call('vela_edge_query', { mode: 'develop', request: { ...replayInput, replay: { id: session.id, revision: session.revision + 1 } } })).toHaveProperty('result.isError', true);
            const { query: _, ...source } = input; const preset = getStatsPresetCatalog().presets.find(value => value.availability.available)!;
            expect(output(await ctx.call('vela_edge_report', { mode: 'develop', request: source, preset: { id: preset.id } }))).toMatchObject({ preset: { id: preset.id }, selection: { datasetId: dataset.id } });
            const ledger = output(await ctx.call('vela_backtest_statistics', { mode: 'develop', sessionId: session.id }));
            expect(ledger).toMatchObject({ statistics: { trades: 0, netPnl: 0, winRate: null, avgR: null }, equityCoverage: { retained: 0, returned: 0 } });
            const day = app.store.addDataset({ name: 'Synthetic full UTC day', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv',
                bars: Array.from({ length: 1440 }, (_, index) => ({ ...bars[0]!, time: START + index * 60_000 })) });
            const fullDay: MarketStatsRequest = { ...input, datasetId: day.id, from: day.start, until: day.end,
                session: { key: 'full', start: '00:00', end: '24:00', tz: 'UTC', overnight: false } };
            expect(output(await ctx.call('vela_edge_query', { mode: 'develop', request: fullDay }))).toMatchObject({
                selection: { datasetId: day.id, checksum: day.checksum }, result: { n: 1, estimate: null, guards: { refused: true } },
            });
            const cpiStart = Date.UTC(2024, 3, 10);
            const cpi = app.store.addDataset({ name: 'Synthetic covered event', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv',
                bars: bars.map((bar, i) => ({ ...bar, time: cpiStart + i * 60_000 })) });
            const cpiInput: MarketStatsRequest = { ...input, datasetId: cpi.id, from: cpi.start, until: cpi.end, eventCalendar: 'bundled' };
            const cpiPage = output(await ctx.call('vela_edge_query', { mode: 'develop', request: cpiInput })) as MarketStatsPageResponse;
            const compared = output(await ctx.call('vela_compare_event_sessions', { mode: 'develop', comparison: {
                request: cpiInput, pin: pinEventComparison(cpiInput, cpiPage), calendarEvent: 'CPI', sessionIds: [cpiPage.result.sessions[0]!.sessionId],
            }, pathLimit: 2 })) as EventComparisonResult;
            expect(compared).toMatchObject({ calendar: { event: 'CPI', timing: 'day-only' }, sessions: [{ barCount: 10,
                netChange: { points: 0.5, ticks: 2, percent: 0.5 }, pathCoverage: { measured: 10, returned: 2, sampled: true } }] });
            expect(compared.sessions[0]!.path.map(point => point.elapsedMinutes)).toEqual([1, 10]);
            expect(JSON.stringify(app.store.session(session.id))).toBe(before);
            expect(provider).not.toHaveBeenCalled(); expect(ctx.chart.call).not.toHaveBeenCalled(); expect(ctx.chart.clients).not.toHaveBeenCalled();
        } finally {
            await ctx?.close(); await app.close();
            const resolved = await realpath(directory); const parent = await realpath(tmpdir());
            if (dirname(resolved) !== parent || !resolved.startsWith(join(parent, 'vela-mcp-'))) throw new Error('Invalid owned MCP fixture path');
            await rm(resolved, { recursive: true, force: true });
        }
    }, 20_000);
    it('executes integrated MCP research over authenticated synthetic localhost HTTP with no chart or production app', async () => {
        const presets = getStatsPresetCatalog(); const preset = presets.presets.find(value => value.availability.available)!;
        const logical: { port: string; path: string; body?: unknown }[] = [];
        const networkStarted = deferred<void>(); const networkClosed = deferred<void>();
        const server = createServer(async (req, res) => {
            const send = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
            try {
                const path = req.url!;
                if (path === '/api/bootstrap') { send({ token: 'a'.repeat(64), dataDirectory: 'synthetic-private-path', provider: { configured: true } }); return; }
                if (req.method === 'POST' && req.headers['x-local-token'] !== 'a'.repeat(64)) { send({ error: 'private auth failure' }, 403); return; }
                let raw = ''; for await (const chunk of req) raw += String(chunk);
                const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
                logical.push({ port: '5199', path, body });
                if (path === '/api/market-stats') send(catalog);
                else if (path === '/api/market-stats/presets') send(presets);
                else if (path === '/api/market-stats/preset') send(buildPreset(body));
                else if (path === '/api/market-stats/query') {
                    if ((body as unknown as MarketStatsRequest).query.dsl === 'closeRed') {
                        res.once('close', () => networkClosed.resolve()); networkStarted.resolve(); return;
                    }
                    send(page(body as unknown as MarketStatsRequest));
                }
                else if (path === '/api/market-stats/session') {
                    if (body?.sessionId !== MATCH) { send({ error: 'not a matched session' }, 400); return; }
                    send(artifact(body.request as MarketStatsRequest));
                } else if (path === '/api/sessions') send([{ id: REPLAY, revision: 3 }]);
                else if (path === '/api/sessions/' + REPLAY + '/analytics') send(stats());
                else send({ error: 'unexpected route' }, 404);
            } catch { send({ error: 'synthetic failure' }, 500); }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as AddressInfo).port;
        const remote = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.origin !== 'http://127.0.0.1:5199') throw new Error('Synthetic mode unavailable');
            url.port = String(port); return fetch(url, init);
        });
        const ctx = await rpc(new LocalResearchConnection(remote));
        try {
            expect(output(await ctx.call('vela_research_apps', {}))).toEqual([
                { mode: 'desktop', available: false }, { mode: 'run', available: false }, { mode: 'develop', available: true, datasets: 1, sessions: 1 },
            ]);
            expect(output(await ctx.call('vela_edge_sources', { mode: 'develop' }))).toMatchObject({ mode: 'develop', datasets: catalog.datasets });
            expect(output(await ctx.call('vela_edge_fields', { mode: 'develop' }))).toMatchObject({ registry: catalog.registry });
            expect(output(await ctx.call('vela_edge_presets', { mode: 'develop' }))).toMatchObject({ mode: 'develop', catalog: { total: 42, namedVariants: 121 } });
            const replayRequest = { ...request(), sourceMode: 'replay' as const, replay: { id: REPLAY, revision: 3 } };
            const query = output(await ctx.call('vela_edge_query', { mode: 'develop', request: replayRequest }));
            expect(query).toMatchObject({ mode: 'develop', result: { n: 0, estimate: null }, selection: { checksum: 'c'.repeat(64), replay: { id: REPLAY, revision: 3 } } });
            const { query: _, ...source } = replayRequest;
            expect(output(await ctx.call('vela_edge_report', { mode: 'develop', request: source, preset: { id: preset.id } }))).toMatchObject({
                mode: 'develop', preset: { id: preset.id, version: preset.version }, selection: { replay: { id: REPLAY, revision: 3 } },
            });
            const queries = logical.filter(value => value.path === '/api/market-stats/query');
            expect(queries[1]!.body).toEqual({ ...source, query: { dsl: buildPreset({ id: preset.id }).dsl, groupBy: buildPreset({ id: preset.id }).groupBy, sessionsLimit: 100 } });
            expect(output(await ctx.call('vela_edge_session_bars', { mode: 'develop', request: replayRequest, sessionId: MATCH, contextBars: 0 }))).toMatchObject({ mode: 'develop', kind: 'session', session: { sessionId: MATCH } });
            expect(await ctx.call('vela_edge_session_bars', { mode: 'develop', request: replayRequest, sessionId: 'unmatched' })).toHaveProperty('result.isError', true);
            expect(output(await ctx.call('vela_backtest_sessions', { mode: 'develop' }))).toMatchObject({ mode: 'develop', total: 1, sessions: [{ id: REPLAY, revision: 3 }] });
            expect(output(await ctx.call('vela_backtest_statistics', { mode: 'develop', sessionId: REPLAY, curveLimit: 2 }))).toMatchObject({ statistics: { equityCurve: [stats().equityCurve[0], stats().equityCurve[4]] } });
            expect(JSON.stringify(query)).not.toMatch(/synthetic-private-path|configured|aaaaaaaaaaaaaaaa/);
            expect(remote.mock.calls.filter(([url]) => String(url).endsWith('/api/bootstrap'))).toHaveLength(1);
            expect(ctx.chart.clients).not.toHaveBeenCalled(); expect(ctx.chart.call).not.toHaveBeenCalled();
            expect(logical.every(value => !/assistant|provider|download|acquisition|export|command/.test(value.path))).toBe(true);
            void ctx.call('vela_edge_query', { mode: 'develop', request: { ...request(), query: { dsl: 'closeRed' } } });
            await networkStarted.promise; await ctx.cancel(); await networkClosed.promise;
        } finally {
            await ctx.close(); server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
});
