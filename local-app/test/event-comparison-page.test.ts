// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { eventCalendars } from '@luxalgo/edge-stats/calendar-data';
import type { SessionBarsResult } from '@luxalgo/edge-stats/session-bars';
import { mountMarketStatsPage } from '../client/market-stats-page';
import type { LocalApi } from '../client/api';
import type { MarketStatsCatalog, MarketStatsPageResponse, MarketStatsRequest } from '../shared/market-stats';
import type { EventComparisonRequest, EventComparisonResult } from '../shared/event-comparison';
import { describeEventSession } from '../shared/event-comparison';
import { MARKET_STATS_SOURCE } from '../server/market-stats/contract';
import { eventCoverage, snapshotEventCalendars } from '../server/market-stats/events';
import type { SessionSummary } from '../shared/types';

const BASE = Date.UTC(2024, 0, 10), DAY = 86_400_000;
const calendars = snapshotEventCalendars(eventCalendars), events = eventCoverage(calendars)!;
const catalog: MarketStatsCatalog = { datasets: [{ id: 'synthetic-minute', name: 'Synthetic cached minute data', symbol: 'NQH4', schema: 'ohlcv-1m',
    intervalMs: 60_000, start: BASE, end: BASE + 2 * DAY + 180_000, barCount: 9, checksum: 'synthetic-checksum', source: 'csv',
    instrument: { root: 'NQ', tickSize: 0.25, pointValue: 20 }, createdAt: '2024-01-13' }],
    sessions: [{ id: 'synthetic-replay', datasetId: 'synthetic-minute', name: 'Synthetic replay', revision: 3, cursor: 8,
        startTime: BASE, endTime: BASE + 2 * DAY + 180_000 } as SessionSummary],
    registry: [{ name: 'closeGreen', kind: 'outcome', title: 'Green close', doc: 'Synthetic outcome', examples: ['closeGreen'] }],
    limits: { bars: 250_000, spanMs: 10 * 366 * DAY, sessions: 100, groups: 100 } };
const pages: ReturnType<typeof mountMarketStatsPage>[] = [];
afterEach(() => { pages.splice(0).forEach(page => page.destroy()); document.body.replaceChildren(); });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function envelope(request: MarketStatsRequest): MarketStatsPageResponse {
    return { source: MARKET_STATS_SOURCE, selection: { datasetId: request.datasetId, name: catalog.datasets[0]!.name, symbol: 'NQH4', checksum: 'synthetic-checksum',
        sourceMode: request.sourceMode, from: request.from, until: request.until, ...(request.eventCalendar ? { eventCalendar: request.eventCalendar } : {}),
        ...(request.replay ? { replay: { ...request.replay, cursor: 8 } } : {}) },
        coverage: { fingerprint: `synthetic-${request.query.dsl}`, revealedUntil: request.until, inputBarCount: 9, eligibleBarCount: 9, excludedFutureBars: 0,
            firstBarOpen: request.from, lastBarClose: request.until, calendarMode: 'schedule-only', ...(request.eventCalendar ? { events } : {}) }, warnings: [],
        result: { engine: { version: '0.1.0', storeFingerprint: 'synthetic-store', calendarVersion: 'schedule-only' },
            query: { dsl: request.query.dsl, ast: { outcome: { name: request.query.dsl, args: [] } }, outcome: request.query.dsl, symbol: 'NQH4', sessionKey: 'selected', since: null, until: null },
            n: 2, successes: 0, estimate: null, ci95: null, guards: { lowSample: true, refused: true, warnFloor: 30, refuseFloor: 10 },
            stability: null, recency: null, perYear: [], groups: null, distribution: null,
            sessions: ['2024-01-11', '2024-01-12'].map(tradeDate => ({ sessionId: `NQH4|selected|${tradeDate}`, tradeDate, success: false, value: null })),
            disclaimer: 'Synthetic historical sessions only.' } };
}
function example(request: EventComparisonRequest): EventComparisonResult {
    const calendar = calendars.find(item => item.event === request.calendarEvent)!;
    const start = BASE + DAY;
    const session = { sessionId: 'NQH4|selected|2024-01-11', tradeDate: '2024-01-11', symbol: 'NQH4', sessionKey: 'selected', tz: 'UTC', tf: '1m',
        startTs: start, endTs: start + 180_000, isHalfDay: false, isRollDay: false, complete: true,
        bars: [{ ts: start, open: 100, high: 103, low: 98, close: 102, volume: 1 },
            { ts: start + 60_000, open: 102, high: 108, low: 101, close: 105, volume: 2 },
            { ts: start + 120_000, open: 105, high: 106, low: 96, close: 97, volume: 3 }] } as SessionBarsResult;
    return { pin: request.pin, calendar: { event: calendar.event, version: calendar.version, coverage: calendar.coverage, sources: calendar.sources,
        fingerprint: events.calendars.find(item => item.event === calendar.event)!.fingerprint, timing: 'day-only' },
        sessions: [describeEventSession(session, { tickSize: 0.25, revealedUntil: request.request.until })],
        basis: 'Synthetic session measurements from the first measured open.', disclaimer: 'Day-session comparisons; no release minute or probability.' };
}
function field(host: HTMLElement, name: string) { return host.querySelector<HTMLInputElement>(`[name="${name}"]`)!; }
function change(host: HTMLElement, name: string, value: string) { const target = field(host, name); target.value = value; target.dispatchEvent(new Event('change', { bubbles: true })); }
function setup() {
    const host = document.createElement('div'); document.body.append(host);
    let comparisonReply = async (request: EventComparisonRequest, _signal?: AbortSignal) => example(request);
    const api = { get: vi.fn(async (path: string, _signal?: AbortSignal): Promise<unknown> => path.includes('/presets')
        ? { presets: [], categories: [], total: 0, namedVariants: 0 } : structuredClone(catalog)),
        post: vi.fn(async (path: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
            if (path === '/api/market-stats/query') return envelope(body as MarketStatsRequest);
            if (path === '/api/market-stats/event-comparison') return comparisonReply(body as EventComparisonRequest, signal);
            throw new Error('Unexpected synthetic API path.');
        }) };
    const page = mountMarketStatsPage(host, api as unknown as LocalApi, { onHome() {}, onData() {} }); pages.push(page);
    const query = async (optIn = true) => {
        await flush(); change(host, 'schedule', 'custom'); change(host, 'open', '00:00'); change(host, 'close', '00:03'); change(host, 'zone', 'UTC');
        field(host, 'eventCalendar').checked = optIn; field(host, 'eventCalendar').dispatchEvent(new Event('change', { bubbles: true }));
        host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush();
    };
    const compare = async () => {
        const choice = host.querySelector<HTMLInputElement>('[data-event-session]'); expect(choice).not.toBeNull();
        choice!.checked = true; choice!.dispatchEvent(new Event('change', { bubbles: true }));
        host.querySelector<HTMLButtonElement>('[data-event-compare]')!.click(); await flush();
    };
    return { host, page, api, query, compare, reply: (reply: typeof comparisonReply) => { comparisonReply = reply; } };
}

it('mounts the actual comparison UI after an opted-in public query, posts the exact pin and draws its real overlay', async () => {
    const f = setup(); await f.query();
    const panel = f.host.querySelector<HTMLElement>('.ms-event-comparison'); expect(panel).not.toBeNull(); expect(panel!.hidden).toBe(false);
    expect([...panel!.querySelectorAll<HTMLOptionElement>('[data-event-calendar] option')].map(option => option.value)).toEqual(eventCalendars.map(item => item.event));
    expect(panel!.querySelectorAll('[data-event-session]')).toHaveLength(1); expect(panel!.textContent).toContain('2024-01-11');
    await f.compare();
    const queryCall = f.api.post.mock.calls.find(([path]) => path === '/api/market-stats/query')!;
    const call = f.api.post.mock.calls.find(([path]) => path === '/api/market-stats/event-comparison')!;
    expect(call[1]).toMatchObject({ request: queryCall[1], calendarEvent: 'CPI', sessionIds: ['NQH4|selected|2024-01-11'],
        pin: { selection: { datasetId: 'synthetic-minute', checksum: 'synthetic-checksum' }, eventFingerprint: events.fingerprint } });
    expect(call[2]).toBeInstanceOf(AbortSignal);
    expect(panel!.querySelector('svg[role="img"] path')?.getAttribute('d')).toContain('L');
    expect(panel!.textContent).toContain('12 points'); expect(panel!.textContent).toContain('-3 points');
    expect(panel!.textContent).toContain('no release minute'); expect(field(f.host, 'dsl').value).toBe('closeGreen');
});
it('keeps calendars and comparison requests unavailable without explicit bundled opt-in', async () => {
    const f = setup(); await f.query(false);
    expect(f.host.querySelector<HTMLElement>('.ms-event-comparison')?.hidden).toBe(true);
    expect(f.host.querySelectorAll('[data-event-calendar] option')).toHaveLength(0);
    f.host.querySelector<HTMLButtonElement>('[data-event-compare]')?.click(); await flush();
    expect(f.api.post.mock.calls.map(([path]) => path)).toEqual(['/api/market-stats/query']);
});
it.each(['dsl', 'datasetId', 'sourceMode', 'from', 'eventCalendar'])('invalidates and aborts a comparison on %s edits and never revives its late result', async name => {
    const f = setup(); await f.query(); let finish!: (value: EventComparisonResult) => void; let sent!: EventComparisonRequest;
    f.reply(request => { sent = request; return new Promise(resolve => { finish = resolve; }); }); await f.compare();
    const signal = f.api.post.mock.calls.find(([path]) => path === '/api/market-stats/event-comparison')![2]!;
    if (name === 'eventCalendar') { field(f.host, name).checked = false; field(f.host, name).dispatchEvent(new Event('change', { bubbles: true })); }
    else change(f.host, name, name === 'dsl' ? 'closeRed' : name === 'sourceMode' ? 'replay' : name === 'from' ? '2024-01-10T00:01' : 'synthetic-minute');
    expect(signal.aborted).toBe(true); expect(f.host.querySelector<HTMLElement>('.ms-event-comparison')!.hidden).toBe(true);
    expect(f.host.querySelector('svg[role="img"] path')).toBeNull();
    finish(example(sent)); await flush(); expect(f.host.querySelector('svg[role="img"] path')).toBeNull();
    expect(f.host.querySelector<HTMLElement>('.ms-event-comparison')!.hidden).toBe(true);
});
it('drains superseded comparison work and preserves the current query draft before page preparation settles', async () => {
    const f = setup(); await f.query(); let finish!: (value: EventComparisonResult) => void; let sent!: EventComparisonRequest;
    f.reply(request => { sent = request; return new Promise(resolve => { finish = resolve; }); }); await f.compare();
    change(f.host, 'dsl', 'closeRed'); let prepared = false;
    const pending = f.page.prepare().then(() => { prepared = true; }); await flush(); expect(prepared).toBe(false);
    expect(f.host.querySelector<HTMLButtonElement>('[data-stats-run]')!.disabled).toBe(true);
    finish(example(sent)); await pending; expect(prepared).toBe(true); expect(field(f.host, 'dsl').value).toBe('closeRed');
    expect(f.host.querySelector('svg[role="img"] path')).toBeNull();
});
it('keeps retired component disposal inside the public preparation barrier after synchronous page destruction', async () => {
    const f = setup(); await f.query(); let finish!: (value: EventComparisonResult) => void; let sent!: EventComparisonRequest;
    f.reply(request => { sent = request; return new Promise(resolve => { finish = resolve; }); }); await f.compare();
    let prepared = false; const pending = f.page.prepare().then(() => { prepared = true; }); f.page.destroy(); await flush();
    expect(f.host.children).toHaveLength(0); expect(prepared).toBe(false);
    finish(example(sent)); await pending; expect(prepared).toBe(true); expect(f.host.children).toHaveLength(0);
});
