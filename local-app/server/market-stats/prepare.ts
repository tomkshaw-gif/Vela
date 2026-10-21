import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { BarRow } from '@luxalgo/edge-stats';
import { MARKET_STATS_LIMITS as LIMITS, MarketStatsError } from './contract';
import type { MarketStatsInput, PreparedMarketStatsRequest } from './contract';
import { snapshotEventCalendars, eventCoverage } from './events';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const invalid = (message: string): never => { throw new MarketStatsError('INVALID_INPUT', message); };
export function checkAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new MarketStatsError('ABORTED', 'Market statistics computation was cancelled.');
}
function timestamp(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000; }
function isoDate(value: string): boolean {
    return typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function validateSession(input: MarketStatsInput): void {
    const session = input.session;
    if (!session || !IDENTIFIER.test(session.key) || !CLOCK.test(session.start)
        || !(CLOCK.test(session.end) || session.end === '24:00') || typeof session.overnight !== 'boolean') invalid('Invalid market statistics session.');
    if (typeof session.tz !== 'string' || session.tz.length > 80) invalid('Invalid session timezone.');
    try { new Intl.DateTimeFormat('en-US', { timeZone: session.tz }); } catch { invalid('Invalid session timezone.'); }
    if ((!session.overnight && session.end <= session.start) || (session.overnight && session.end > session.start)) invalid('Session clocks and overnight setting disagree.');
}
function validateQuery(input: MarketStatsInput): void {
    const query = input.query;
    if (!query || typeof query !== 'object' || Object.keys(query).some(key => !['dsl', 'since', 'until', 'groupBy', 'sessionsLimit'].includes(key))) invalid('Unsupported market statistics query options.');
    if (typeof query.dsl !== 'string' || !query.dsl.trim() || query.dsl.length > LIMITS.dslLength) invalid('The query must contain 1–2000 characters.');
    if ([query.since, query.until].some(value => value !== undefined && !isoDate(value))) invalid('Query dates must be valid ISO trade dates.');
    if (query.since && query.until && query.since > query.until) invalid('Query start must precede its end.');
    if (query.groupBy !== undefined && (typeof query.groupBy !== 'string' || !IDENTIFIER.test(query.groupBy))) invalid('Invalid grouping field.');
    if (query.sessionsLimit !== undefined && (!Number.isSafeInteger(query.sessionsLimit) || query.sessionsLimit < 0 || query.sessionsLimit > LIMITS.sessions)) invalid('At most 100 matching sessions may be returned.');
    let depth = 0; let quote = '';
    for (let index = 0; index < query.dsl.length; index++) {
        const char = query.dsl[index]!;
        if (quote) { if (char === '\\') index++; else if (char === quote) quote = ''; continue; }
        if (char === '"' || char === "'") quote = char;
        else if (char === '(' && ++depth > 24) invalid('The query is nested too deeply.');
        else if (char === ')') depth--;
    }
}
function calendarSnapshot(input: MarketStatsInput): MarketStatsInput['calendar'] {
    if (input.calendar === null) return null;
    const calendar = input.calendar;
    if (!calendar || typeof calendar !== 'object' || !calendar.coverage || !isoDate(calendar.coverage.from) || !isoDate(calendar.coverage.to)
        || calendar.coverage.from > calendar.coverage.to || !Array.isArray(calendar.holidays) || !Array.isArray(calendar.halfDays)
        || calendar.holidays.length > 10_000 || calendar.halfDays.length > 10_000
        || !Array.isArray(calendar.sources) || calendar.sources.length > 20
        || calendar.sources.some(source => typeof source !== 'string' || source.length > 500)
        || typeof calendar.version !== 'string' || calendar.version.length > 100
        || typeof calendar.exchange !== 'string' || calendar.exchange.length > 30) invalid('Supply a valid local calendar or explicitly choose schedule-only mode.');
    if (calendar.holidays.some(day => !day || !isoDate(day.date) || typeof day.name !== 'string' || day.name.length > 200)
        || calendar.halfDays.some(day => !day || !isoDate(day.date) || !CLOCK.test(day.close) || typeof day.name !== 'string' || day.name.length > 200)) invalid('Invalid local calendar entries.');
    return {
        exchange: calendar.exchange, version: calendar.version, sources: [...calendar.sources], coverage: { ...calendar.coverage },
        holidays: calendar.holidays.map(day => ({ date: day.date, name: day.name })),
        halfDays: calendar.halfDays.map(day => ({ date: day.date, name: day.name, close: day.close })),
    };
}

export async function prepareMarketStats(input: MarketStatsInput, signal?: AbortSignal): Promise<PreparedMarketStatsRequest> {
    checkAborted(signal);
    if (!input || !Array.isArray(input.bars) || input.bars.length > LIMITS.bars) invalid('Market statistics require at most 250000 local bars.');
    if (input.sourceIntervalMs !== 60_000) throw new MarketStatsError('UNSUPPORTED_INPUT', 'Market statistics currently require one-minute source bars.');
    if (typeof input.symbol !== 'string' || !IDENTIFIER.test(input.symbol) || !['equity', 'future', 'crypto', 'forex'].includes(input.assetClass)) invalid('Invalid statistics symbol or asset class.');
    if (!timestamp(input.revealedUntil)) invalid('Invalid exclusive revealed cutoff.');
    validateSession(input); validateQuery(input);
    const calendar = calendarSnapshot(input);
    const events = snapshotEventCalendars(input.events); const eventsReceipt = eventCoverage(events);
    const continuous = input.assetClass === 'future' && /^(NQ|GC)\.v\.0$/.test(input.symbol);
    if (input.assetClass === 'future' && input.symbol.includes('.v.') && !continuous) invalid('Unsupported continuous statistics contract.');
    const exchange = input.assetClass === 'future' && /^GC(?:[FGHJKMNQUVXZ]\d|\.v\.0$)/.test(input.symbol) ? 'COMEX'
        : { equity: 'NYSE', future: 'CME', crypto: 'CRYPTO', forex: 'FX' }[input.assetClass];
    if (calendar && calendar.exchange !== exchange) invalid('The local calendar exchange does not match the selected asset class.');
    const windows = input.orWindows ?? [5, 10, 15, 30, 60]; const ib = input.ibWindow ?? 60;
    if (!Array.isArray(windows) || windows.length < 1 || windows.length > LIMITS.windows || new Set(windows).size !== windows.length
        || [...windows, ib].some(value => !Number.isSafeInteger(value) || value < 1 || value > LIMITS.windowMinutes)) invalid('Invalid opening-range or initial-balance windows.');
    const prepared: PreparedMarketStatsRequest = {
        bars: [],
        symbol: {
            symbol: input.symbol, adapter: 'csv', assetClass: input.assetClass, defaultSession: input.session.key,
            sessions: { [input.session.key]: { start: input.session.start, end: input.session.end, tz: input.session.tz, overnight: input.session.overnight } },
            tf: '1m', orWindows: [...windows].sort((a, b) => a - b), ibWindow: ib, adapterOptions: {},
        },
        query: { ...input.query, symbol: input.symbol, sessionKey: input.session.key, sessionsLimit: input.query.sessionsLimit ?? 25 },
        calendar, events,
        coverage: { fingerprint: '', revealedUntil: input.revealedUntil, inputBarCount: input.bars.length, eligibleBarCount: 0, excludedFutureBars: 0, firstBarOpen: null, lastBarClose: null, calendarMode: calendar ? 'provided' : 'schedule-only', ...(eventsReceipt ? { events: eventsReceipt } : {}) },
        warnings: calendar ? [] : ['Schedule-only calendar: exchange holidays and early closes are not supplied.'],
    };
    if (continuous) prepared.warnings.push('Unadjusted continuous futures: contract roll state is reset between raw contracts; mixed or incomplete contract sessions are omitted.');
    if (events.length) prepared.warnings.push('Event-conditioned queries exclude uncovered dates and unknown or cross-contract trading neighbors.');
    // Detach before yielding so changes to a caller's dataset cannot mix two snapshots.
    const source = input.bars.map(bar => bar && ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
        instrumentId: bar.instrumentId, contract: bar.contract }));
    let previous = -1; let first = -1;
    for (let index = 0; index < source.length; index++) {
        if (index % 2048 === 0) { await setImmediate(); checkAborted(signal); }
        const bar = source[index];
        if (!bar) throw new MarketStatsError('INVALID_INPUT', 'Local bars must be present.');
        const identified = bar.instrumentId !== undefined || bar.contract !== undefined;
        if (continuous || identified) {
            const raw = typeof bar.contract === 'string' ? /^(MNQ|MES|NQ|ES|GC)[FGHJKMNQUVXZ]\d{1,4}$/.exec(bar.contract) : null;
            const root = /^(MNQ|MES|NQ|ES|GC)/.exec(input.symbol)?.[1];
            if (input.assetClass !== 'future' || typeof bar.instrumentId !== 'string' || !/^[1-9]\d{0,19}$/.test(bar.instrumentId)
                || !raw || !root || raw[1] !== root || !continuous && bar.contract !== input.symbol) invalid('Each futures bar must retain its matching raw contract and provider identity.');
        }
        if (!timestamp(bar.time) || bar.time % 60_000 !== 0 || bar.time <= previous || !timestamp(bar.time + 60_000)
            || [bar.open, bar.high, bar.low, bar.close, bar.volume].some(value => typeof value !== 'number' || !Number.isFinite(value))
            || bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close) || bar.volume < 0) invalid('Local bars must have unique ordered minute opens and valid finite OHLCV values.');
        first = first < 0 ? bar.time : first; previous = bar.time;
        if (bar.time - first > LIMITS.spanMs) invalid('Market statistics history is limited to ten years.');
        if (bar.time + 60_000 > prepared.coverage.revealedUntil) { prepared.coverage.excludedFutureBars++; continue; }
        prepared.bars.push({ symbol: prepared.symbol.symbol, tf: '1m', ts: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
            ...(prepared.symbol.assetClass === 'future' ? { contract: bar.contract ?? prepared.symbol.symbol } : {}), ...(bar.instrumentId !== undefined ? { instrumentId: bar.instrumentId } : {}) } satisfies BarRow & { instrumentId?: string });
    }
    prepared.coverage.eligibleBarCount = prepared.bars.length;
    prepared.coverage.firstBarOpen = prepared.bars[0]?.ts ?? null;
    prepared.coverage.lastBarClose = prepared.bars.length ? prepared.bars[prepared.bars.length - 1]!.ts + 60_000 : null;
    if (calendar && prepared.bars.length) {
        const start = new Date(prepared.bars[0]!.ts).toISOString().slice(0, 10);
        const end = new Date(prepared.bars[prepared.bars.length - 1]!.ts).toISOString().slice(0, 10);
        if (start < calendar.coverage.from || end > calendar.coverage.to) invalid('Local calendar coverage does not cover the selected history.');
    }
    prepared.coverage.fingerprint = createHash('sha256').update(JSON.stringify(prepared)).digest('hex');
    return prepared;
}
