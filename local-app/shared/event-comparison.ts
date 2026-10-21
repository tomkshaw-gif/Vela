import type { EventFile } from '@luxalgo/edge-stats/events';
import type { SessionBarsResult } from '@luxalgo/edge-stats/session-bars';
import type { MarketStatsPageResponse, MarketStatsRequest, MarketStatsSelection } from './market-stats';

export const EVENT_COMPARISON_LIMITS = { sessions: 3, barsPerSession: 5000, outputBytes: 2_000_000 } as const;
export interface EventComparisonPin {
    requestKey: string;
    selection: MarketStatsSelection;
    coverageFingerprint: string;
    eventFingerprint: string;
}
export interface EventComparisonRequest {
    request: MarketStatsRequest;
    pin: EventComparisonPin;
    calendarEvent: string;
    sessionIds: string[];
}
export interface EventSessionContract { symbol: string; instrumentId: string | null }
export interface EventMovement { points: number; ticks: number | null; percent: number | null }
export interface EventSessionComparison {
    sessionId: string; tradeDate: string; symbol: string; sessionKey: string; tz: string;
    contract: EventSessionContract | null; isRollDay: boolean;
    startTs: number; endTs: number; firstBarOpen: number; lastBarClose: number; barCount: number;
    baseline: { kind: 'first-session-bar-open'; price: number; time: number; percentAvailable: boolean };
    tickSize: number | null;
    prices: { open: number; close: number; high: number; low: number };
    range: EventMovement; netChange: EventMovement;
    longMae: EventMovement; longMfe: EventMovement; shortMae: EventMovement; shortMfe: EventMovement;
    path: { time: number; elapsedMinutes: number; change: EventMovement }[];
}
export interface EventComparisonResult {
    pin: EventComparisonPin;
    calendar: Pick<EventFile, 'event' | 'version' | 'sources' | 'coverage' | 'notes'> & { fingerprint: string; timing: 'day-only' };
    sessions: EventSessionComparison[];
    basis: string;
    disclaimer: string;
}
export interface EventComparisonContext {
    request: MarketStatsRequest;
    result: MarketStatsPageResponse;
    /** Explicit calendars supplied by the host, never inferred from an event name. */
    calendars: readonly EventFile[];
}

/** Stable across object key order; preserves exact query text and explicit source choices. */
export function eventComparisonRequestKey(request: MarketStatsRequest): string {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
    return JSON.stringify(canonical(request));
}
export function sameEventComparisonPin(a: EventComparisonPin, b: EventComparisonPin): boolean {
    return a.requestKey === b.requestKey && a.coverageFingerprint === b.coverageFingerprint && a.eventFingerprint === b.eventFingerprint
        && eventComparisonRequestKey(a.selection as unknown as MarketStatsRequest) === eventComparisonRequestKey(b.selection as unknown as MarketStatsRequest);
}
export function pinEventComparison(request: MarketStatsRequest, result: MarketStatsPageResponse): EventComparisonPin {
    return { requestKey: eventComparisonRequestKey(request), selection: structuredClone(result.selection),
        coverageFingerprint: result.coverage.fingerprint, eventFingerprint: result.coverage.events?.fingerprint ?? '' };
}
export function eventComparisonCandidates(result: MarketStatsPageResponse, calendar: EventFile) {
    const dates = new Set(calendar.dates);
    return result.result.sessions.filter(row => row.tradeDate >= calendar.coverage.from && row.tradeDate <= calendar.coverage.to && dates.has(row.tradeDate));
}

/** Pure, bounded descriptive math over the measured session; context is never included. */
export function describeEventSession(session: SessionBarsResult,
    options: { tickSize: number | null; revealedUntil: number; contract?: EventSessionContract | null }): EventSessionComparison {
    const invalid = (): never => { throw new Error('Invalid, incomplete, mixed-contract or unrevealed event session.'); };
    const time = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 && value % 60_000 === 0;
    if (!session || !options || !time(options.revealedUntil) || !time(session.startTs) || !time(session.endTs)
        || session.startTs >= session.endTs || session.endTs > options.revealedUntil || session.endTs - session.startTs > 36 * 3_600_000
        || session.tf !== '1m' || session.complete !== true || typeof session.isRollDay !== 'boolean'
        || typeof session.sessionId !== 'string' || session.sessionId.length > 240
        || typeof session.symbol !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(session.symbol)
        || typeof session.sessionKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(session.sessionKey)
        || !/^\d{4}-\d{2}-\d{2}$/.test(session.tradeDate) || !Number.isFinite(Date.parse(session.tradeDate))
        || new Date(session.tradeDate).toISOString().slice(0, 10) !== session.tradeDate
        || session.sessionId !== `${session.symbol}|${session.sessionKey}|${session.tradeDate}`
        || typeof session.tz !== 'string' || session.tz.length > 80
        || !Array.isArray(session.bars) || !session.bars.length || session.bars.length > EVENT_COMPARISON_LIMITS.barsPerSession
        || options.tickSize !== null && (typeof options.tickSize !== 'number' || !Number.isFinite(options.tickSize) || options.tickSize <= 0)) invalid();
    try { new Intl.DateTimeFormat('en-US', { timeZone: session.tz }); } catch { invalid(); }
    const rawContract = /^(MNQ|MES|NQ|ES|GC)[FGHJKMNQUVXZ]\d{1,4}$/;
    const continuous = /\.v\./.test(session.symbol);
    const contract = options.contract ?? (rawContract.test(session.symbol) ? { symbol: session.symbol, instrumentId: null } : null);
    if (continuous && !contract || contract && (!rawContract.test(contract.symbol)
        || contract.instrumentId !== null && (typeof contract.instrumentId !== 'string' || !/^[1-9]\d{0,19}$/.test(contract.instrumentId))
        || continuous && (contract.instrumentId === null || contract.symbol.match(/^(MNQ|MES|NQ|ES|GC)/)?.[0] !== session.symbol.split('.')[0])
        || !continuous && contract.symbol !== session.symbol)) invalid();
    let previous = -1, high = -Infinity, low = Infinity;
    for (const bar of session.bars) {
        if (!bar || !time(bar.ts) || bar.ts < session.startTs || bar.ts + 60_000 > session.endTs || bar.ts <= previous
            || ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(value => typeof value === 'number' && Number.isFinite(value))
            || bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close) || bar.volume < 0) invalid();
        // Native bars omit identity. If an injected source includes it, it must agree on every bar.
        const identity = bar as typeof bar & { contract?: unknown; instrumentId?: unknown };
        if (identity.contract !== undefined && identity.contract !== contract?.symbol
            || identity.instrumentId !== undefined && identity.instrumentId !== contract?.instrumentId) invalid();
        previous = bar.ts; high = Math.max(high, bar.high); low = Math.min(low, bar.low);
    }
    const first = session.bars[0]!, last = session.bars[session.bars.length - 1]!;
    const open = first.open;
    const movement = (points: number): EventMovement => {
        const ticks = options.tickSize === null ? null : points / options.tickSize;
        const percent = open > 0 ? points / open * 100 : null;
        if (![points, ticks, percent].every(value => value === null || Number.isFinite(value))) invalid();
        return { points: points === 0 ? 0 : points, ticks, percent };
    };
    return { sessionId: session.sessionId, tradeDate: session.tradeDate, symbol: session.symbol, sessionKey: session.sessionKey, tz: session.tz,
        contract: contract ? { ...contract } : null, isRollDay: session.isRollDay, startTs: session.startTs, endTs: session.endTs,
        firstBarOpen: first.ts, lastBarClose: last.ts + 60_000, barCount: session.bars.length,
        baseline: { kind: 'first-session-bar-open', price: open, time: first.ts, percentAvailable: open > 0 }, tickSize: options.tickSize,
        prices: { open, close: last.close, high, low }, range: movement(high - low), netChange: movement(last.close - open),
        longMae: movement(Math.max(0, open - low)), longMfe: movement(Math.max(0, high - open)),
        shortMae: movement(Math.max(0, high - open)), shortMfe: movement(Math.max(0, open - low)),
        path: session.bars.map(bar => ({ time: bar.ts + 60_000, elapsedMinutes: (bar.ts + 60_000 - session.startTs) / 60_000, change: movement(bar.close - open) })) };
}
