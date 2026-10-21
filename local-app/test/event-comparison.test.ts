import { describe, expect, it, vi } from 'vitest';
import type { SessionBarsResult } from '@luxalgo/edge-stats/session-bars';
import type { EventFile } from '@luxalgo/edge-stats/events';
import type { QueryResult } from '@luxalgo/edge-stats';
import { describeEventSession, pinEventComparison } from '../shared/event-comparison';
import type { EventComparisonRequest } from '../shared/event-comparison';
import { compareHistoricalEvents } from '../server/event-comparison';
import type { EventComparisonArtifact, EventComparisonPorts } from '../server/event-comparison';
import { MARKET_STATS_SOURCE } from '../server/market-stats/contract';
import type { MarketStatsPageResponse, MarketStatsRequest } from '../shared/market-stats';
import { eventCoverage } from '../server/market-stats/events';

const BASE = Date.UTC(2024, 0, 2), MINUTE = 60_000, DAY = 86_400_000;
const calendar: EventFile = { event: 'LOCAL_EVENT', version: 'synthetic-v1', sources: ['Synthetic test dates'],
    coverage: { from: '2024-01-02', to: '2024-01-04' }, dates: ['2024-01-02', '2024-01-03', '2024-01-04'] };
function session(day = 0): SessionBarsResult {
    const start = BASE + day * DAY;
    return { sessionId: `TEST|short|2024-01-0${day + 2}`, symbol: 'TEST', sessionKey: 'short', tradeDate: `2024-01-0${day + 2}`,
        tf: '1m', tz: 'UTC', startTs: start, endTs: start + 3 * MINUTE, isHalfDay: false, isRollDay: false, complete: true,
        bars: [{ ts: start, open: 100, high: 103, low: 98, close: 102, volume: 1 },
            { ts: start + MINUTE, open: 102, high: 108, low: 101, close: 105, volume: 2 },
            { ts: start + 2 * MINUTE, open: 105, high: 106, low: 96, close: 97, volume: 3 }],
        context: { kind: 'prior-session', note: 'Excluded from comparison', bars: [{ ts: start - MINUTE, open: 1000, high: 2000, low: 0, close: 1000, volume: 1 }] },
        levels: { open: 100, high: 108, low: 96, close: 97 } as SessionBarsResult['levels'],
        times: {} as SessionBarsResult['times'], disclaimer: 'Synthetic' };
}
function fixture() {
    const request: MarketStatsRequest = { datasetId: 'synthetic-dataset', sourceMode: 'cache', from: BASE, until: BASE + 2 * DAY + 3 * MINUTE,
        session: { key: 'short', start: '00:00', end: '00:03', tz: 'UTC', overnight: false }, calendar: null,
        query: { dsl: 'closeGreen', sessionsLimit: 25 } };
    const response: MarketStatsPageResponse = { source: MARKET_STATS_SOURCE,
        selection: { datasetId: request.datasetId, name: 'Synthetic', symbol: 'TEST', checksum: 'synthetic-checksum', sourceMode: 'cache', from: request.from, until: request.until },
        coverage: { fingerprint: 'synthetic-input-fingerprint', revealedUntil: request.until, inputBarCount: 9, eligibleBarCount: 9,
            excludedFutureBars: 0, firstBarOpen: BASE, lastBarClose: request.until, calendarMode: 'schedule-only', events: eventCoverage([calendar]) }, warnings: [],
        result: { query: { dsl: request.query.dsl, symbol: 'TEST', sessionKey: 'short', since: null, until: null },
            sessions: [0, 1, 2].map(day => ({ sessionId: session(day).sessionId, tradeDate: session(day).tradeDate, success: true, value: null })) } as QueryResult };
    const input: EventComparisonRequest = { request, pin: pinEventComparison(request, response), calendarEvent: calendar.event,
        sessionIds: [session(0).sessionId, session(1).sessionId] };
    const readSession = vi.fn(async (_request: MarketStatsRequest, id: string): Promise<EventComparisonArtifact> => {
        const day = Number(id.slice(-2)) - 2; const s = session(day); s.context.bars = [];
        return { kind: 'session', session: s, coverage: structuredClone(response.coverage), query: { ..._request.query, symbol: 'TEST', sessionKey: 'short', sessionsLimit: 25 },
            source: MARKET_STATS_SOURCE, selection: structuredClone(response.selection) };
    });
    const ports: EventComparisonPorts = { calendars: [structuredClone(calendar)], tickSize: 0.25, runQuery: vi.fn(async () => structuredClone(response)), readSession };
    return { request, response, input, ports, readSession };
}

describe('descriptive event-session arithmetic', () => {
    it('uses manual session-only expected price, tick, percent and signed excursion calculations', () => {
        const value = describeEventSession(session(), { tickSize: 0.25, revealedUntil: BASE + 3 * MINUTE });
        expect(value.prices).toEqual({ open: 100, high: 108, low: 96, close: 97 });
        expect(value.range).toEqual({ points: 12, ticks: 48, percent: 12 });
        expect(value.netChange).toEqual({ points: -3, ticks: -12, percent: -3 });
        expect(value.longMae).toEqual({ points: 4, ticks: 16, percent: 4 });
        expect(value.longMfe).toEqual({ points: 8, ticks: 32, percent: 8 });
        expect(value.shortMae).toEqual(value.longMfe); expect(value.shortMfe).toEqual(value.longMae);
        expect(value.path.map(point => [point.elapsedMinutes, point.change.points, point.change.percent])).toEqual([[1, 2, 2], [2, 5, 5], [3, -3, -3]]);
        expect(value).toMatchObject({ barCount: 3, firstBarOpen: BASE, lastBarClose: BASE + 3 * MINUTE,
            baseline: { kind: 'first-session-bar-open', price: 100, time: BASE, percentAvailable: true } });
    });
    it.each([0, -100])('keeps points and ticks but withholds percentages for a nonpositive open %s', open => {
        const s = session(); s.bars = s.bars.map(bar => ({ ...bar, open: bar.open - 100 + open, high: bar.high - 100 + open,
            low: bar.low - 100 + open, close: bar.close - 100 + open }));
        const value = describeEventSession(s, { tickSize: 0.25, revealedUntil: s.endTs });
        expect(value.netChange).toEqual({ points: -3, ticks: -12, percent: null });
        expect(value.range.percent).toBeNull(); expect(value.path.every(point => point.change.percent === null)).toBe(true);
    });
    it('labels a missing opening minute with the first measured bar basis and withholds unavailable ticks', () => {
        const s = session(); s.bars.shift();
        const value = describeEventSession(s, { tickSize: null, revealedUntil: s.endTs });
        expect(value.baseline).toMatchObject({ price: 102, time: BASE + MINUTE });
        expect(value.netChange.points).toBe(-5); expect(value.netChange.ticks).toBeNull(); expect(value.path[0]?.elapsedMinutes).toBe(2);
    });
    it('rejects malformed, future, duplicate, unbounded and mixed-contract measurements', () => {
        const mutations: ((s: SessionBarsResult) => void)[] = [s => { s.complete = false; }, s => { s.endTs += MINUTE; },
            s => { s.bars[1]!.ts = BASE; }, s => { s.bars[1]!.high = 1; }, s => { s.bars[0]!.volume = -1; },
            s => { s.bars[0]!.close = Infinity; }, s => { s.bars = []; },
            s => { s.bars[0]!.ts = BASE - MINUTE; }, s => { s.bars[2]!.ts += 1; },
            s => { s.symbol = 'NQ.v.0'; }, s => { Object.assign(s.bars[1]!, { contract: 'NQM4' }); },
            s => { s.bars = Array.from({ length: 5001 }, () => s.bars[0]!); }];
        for (const mutate of mutations) { const s = session(); mutate(s); expect(() => describeEventSession(s, { tickSize: 0.25, revealedUntil: BASE + 3 * MINUTE })).toThrow(); }
        for (const tickSize of [0, -1, NaN, Infinity]) expect(() => describeEventSession(session(), { tickSize, revealedUntil: BASE + 3 * MINUTE })).toThrow();
    });
    it('keeps an identified continuous-contract session separate and rejects identity mismatches', () => {
        const s = session(); s.symbol = 'NQ.v.0'; s.sessionId = `NQ.v.0|short|${s.tradeDate}`; s.isRollDay = true;
        const contract = { symbol: 'NQH4', instrumentId: '100' };
        const measured = describeEventSession(s, { tickSize: 0.25, revealedUntil: s.endTs, contract });
        expect(measured.contract).toEqual(contract); expect(measured.netChange.points).toBe(-3); expect(measured.isRollDay).toBe(true);
        for (const invalid of [{ symbol: 'NQH4', instrumentId: null }, { symbol: 'GCH4', instrumentId: '100' }, { symbol: 'NQH4', instrumentId: 'invalid' }]) {
            expect(() => describeEventSession(s, { tickSize: 0.25, revealedUntil: s.endTs, contract: invalid })).toThrow();
        }
        Object.assign(s.bars[1]!, { contract: 'NQM4', instrumentId: '200' });
        expect(() => describeEventSession(s, { tickSize: 0.25, revealedUntil: s.endTs, contract })).toThrow();
    });
});

describe('exact historical comparison boundary', () => {
    it('revalidates query membership, compares actual receipts and returns only descriptive day-session measurements', async () => {
        const f = fixture(); const result = await compareHistoricalEvents(f.input, f.ports);
        expect(f.ports.runQuery).toHaveBeenCalledWith(f.input.request, expect.any(AbortSignal)); expect(f.readSession).toHaveBeenCalledTimes(2);
        expect(result.sessions.map(value => value.netChange.points)).toEqual([-3, -3]);
        expect(result.calendar).toMatchObject({ event: calendar.event, timing: 'day-only', version: calendar.version });
        expect(result).not.toHaveProperty('probability'); expect(result).not.toHaveProperty('pnl');
    });
    it('rejects arbitrary calendars, uncovered dates, non-event days and unmatched IDs before reading bars', async () => {
        for (const kind of ['missing', 'coerced', 'uncovered', 'non-event', 'unmatched', 'duplicate', 'too-many'] as const) {
            const f = fixture();
            if (kind === 'missing') f.ports.calendars = [];
            if (kind === 'coerced') f.input.calendarEvent = ['LOCAL_EVENT'] as unknown as string;
            if (kind === 'uncovered') f.ports.calendars = [{ ...calendar, coverage: { from: '2024-01-03', to: '2024-01-04' }, dates: ['2024-01-03'] }];
            if (kind === 'non-event') f.ports.calendars = [{ ...calendar, dates: ['2024-01-03'] }];
            if (kind === 'unmatched') f.input.sessionIds = ['TEST|short|2024-01-05'];
            if (kind === 'duplicate') f.input.sessionIds = [f.input.sessionIds[0]!, f.input.sessionIds[0]!];
            if (kind === 'too-many') f.input.sessionIds = ['a', 'b', 'c', 'd'];
            await expect(compareHistoricalEvents(f.input, f.ports), kind).rejects.toThrow(); expect(f.readSession, kind).not.toHaveBeenCalled();
        }
    });
    it('rejects source, range, query, event provenance and replay pin changes', async () => {
        for (const kind of ['checksum', 'range', 'query', 'events', 'revision'] as const) {
            const f = fixture();
            if (kind === 'checksum') f.response.selection.checksum = 'changed';
            if (kind === 'range') f.input.request.until -= MINUTE;
            if (kind === 'query') f.input.request.query.dsl = 'closeRed';
            if (kind === 'events') f.response.coverage.events!.fingerprint = 'changed';
            if (kind === 'revision') f.response.selection.replay = { id: 'replay', revision: 2, cursor: 1 };
            await expect(compareHistoricalEvents(f.input, f.ports), kind).rejects.toThrow(); expect(f.readSession).not.toHaveBeenCalled();
        }
    });
    it('rejects unrecognized pin options instead of carrying them into a returned receipt', async () => {
        const f = fixture(); Object.assign(f.input.pin, { extra: 'unsupported' });
        await expect(compareHistoricalEvents(f.input, f.ports)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(f.readSession).not.toHaveBeenCalled();
    });
    it('rejects stale, mismatched, context-bearing and future native artifact receipts', async () => {
        for (const kind of ['fingerprint', 'query', 'source', 'id', 'date', 'context', 'future'] as const) {
            const f = fixture(); const artifact = await f.readSession(f.request, f.input.sessionIds[0]!); f.readSession.mockClear();
            if (kind === 'fingerprint') artifact.coverage.fingerprint = 'changed';
            if (kind === 'query') artifact.query.dsl = 'closeRed';
            if (kind === 'source') artifact.selection.checksum = 'changed';
            if (kind === 'id') artifact.session.sessionId = 'other';
            if (kind === 'date') artifact.session.tradeDate = '2024-01-03';
            if (kind === 'context') artifact.session.context.bars = session().context.bars;
            if (kind === 'future') artifact.session.endTs = f.request.until + MINUTE;
            f.readSession.mockResolvedValue(artifact);
            await expect(compareHistoricalEvents(f.input, f.ports), kind).rejects.toThrow(); expect(f.readSession).toHaveBeenCalledOnce();
        }
    });
    it('fetches serially, aborts and drains before settling, and never starts the next session after cancel', async () => {
        const f = fixture(); let release!: (artifact: EventComparisonArtifact) => void; let began!: () => void;
        const started = new Promise<void>(resolve => { began = resolve; }); const artifact = await f.readSession(f.request, f.input.sessionIds[0]!); f.readSession.mockClear();
        f.readSession.mockImplementation(() => { began(); return new Promise(resolve => { release = resolve; }); });
        const abort = new AbortController(); let settled = false;
        const pending = compareHistoricalEvents(f.input, f.ports, abort.signal).finally(() => { settled = true; });
        const failure = expect(pending).rejects.toThrow(); await started; abort.abort(); await Promise.resolve();
        expect(settled).toBe(false); expect(f.readSession).toHaveBeenCalledOnce(); release(artifact); await failure;
        expect(f.readSession).toHaveBeenCalledOnce();
    });
    it('detaches query, pin, calendar and session selection before an async source read can yield', async () => {
        const f = fixture(); let release!: (value: MarketStatsPageResponse) => void;
        f.ports.runQuery = vi.fn(() => new Promise<MarketStatsPageResponse>(resolve => { release = resolve; }));
        const original = structuredClone(f.input); const pending = compareHistoricalEvents(f.input, f.ports);
        f.input.request.query.dsl = 'closeRed'; f.input.sessionIds.reverse(); f.input.pin.coverageFingerprint = 'changed';
        f.ports.calendars[0]!.dates = []; f.ports.tickSize = 99;
        release(f.response); const result = await pending;
        expect(result.pin).toEqual(original.pin); expect(result.sessions.map(value => value.sessionId)).toEqual(original.sessionIds);
        expect(result.sessions.every(value => value.tickSize === 0.25 && value.range.ticks === 48)).toBe(true);
        expect(f.readSession.mock.calls.every(([request]) => request.query.dsl === 'closeGreen')).toBe(true);
    });
    it('makes no callback for pre-aborted work and never overlaps successful session reads', async () => {
        const f = fixture(); const abort = new AbortController(); abort.abort();
        await expect(compareHistoricalEvents(f.input, f.ports, abort.signal)).rejects.toMatchObject({ code: 'ABORTED' });
        expect(f.ports.runQuery).not.toHaveBeenCalled(); expect(f.readSession).not.toHaveBeenCalled();
        const nativeRead = f.readSession.getMockImplementation()!; let running = 0, peak = 0;
        f.readSession.mockImplementation(async (request, id) => {
            running++; peak = Math.max(peak, running); await Promise.resolve();
            const artifact = await nativeRead(request, id); running--; return artifact;
        });
        f.input.sessionIds.push(session(2).sessionId); const result = await compareHistoricalEvents(f.input, f.ports);
        expect(peak).toBe(1); expect(result.sessions).toHaveLength(3);
    });
});
