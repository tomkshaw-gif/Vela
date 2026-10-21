import type { EventFile } from '@luxalgo/edge-stats/events';
import type { StatsArtifactResponse } from './market-stats/artifacts';
import type { MarketStatsPageResponse, MarketStatsRequest, MarketStatsSelection } from '../shared/market-stats';
import type { EventComparisonRequest, EventComparisonResult, EventSessionContract } from '../shared/event-comparison';
import { describeEventSession, EVENT_COMPARISON_LIMITS, eventComparisonCandidates, eventComparisonRequestKey, pinEventComparison, sameEventComparisonPin } from '../shared/event-comparison';
import { MarketStatsError, MARKET_STATS_SOURCE } from './market-stats/contract';
import { eventCoverage, snapshotEventCalendars } from './market-stats/events';
import { checkAborted } from './market-stats/prepare';

export type EventComparisonArtifact = Extract<StatsArtifactResponse, { kind: 'session' }> & {
    selection: MarketStatsSelection;
    /** Required for continuous futures; verified against every measured source bar by the host. */
    contract?: EventSessionContract | null;
};
export interface EventComparisonPorts {
    calendars: readonly EventFile[];
    /** Read from dataset metadata, never accepted from the request body. */
    tickSize: number | null;
    runQuery(request: MarketStatsRequest, signal: AbortSignal): Promise<MarketStatsPageResponse>;
    /** Must settle only after native cancellation/disposal has drained. Always request contextBars: 0. */
    readSession(request: MarketStatsRequest, sessionId: string, signal: AbortSignal): Promise<EventComparisonArtifact>;
}
export async function compareHistoricalEvents(input: EventComparisonRequest, ports: EventComparisonPorts,
    signal: AbortSignal = new AbortController().signal): Promise<EventComparisonResult> {
    const invalid = (message: string, code: 'INVALID_INPUT' | 'INVALID_RESULT' | 'UNSUPPORTED_INPUT' = 'INVALID_INPUT'): never => {
        throw new MarketStatsError(code, message);
    };
    checkAborted(signal);
    let body: EventComparisonRequest;
    try {
        if (JSON.stringify(input).length > 128_000) throw new Error();
        body = structuredClone(input);
    } catch { return invalid('Supply a bounded historical comparison request.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['request', 'pin', 'calendarEvent', 'sessionIds'].includes(key))
        || !body.request || typeof body.request !== 'object' || Array.isArray(body.request) || !body.pin || typeof body.pin !== 'object' || Array.isArray(body.pin)
        || Object.keys(body.pin).some(key => !['requestKey', 'selection', 'coverageFingerprint', 'eventFingerprint'].includes(key))
        || typeof body.calendarEvent !== 'string' || !body.calendarEvent.trim() || body.calendarEvent.length > 128
        || !Array.isArray(body.sessionIds) || body.sessionIds.length < 1 || body.sessionIds.length > EVENT_COMPARISON_LIMITS.sessions
        || new Set(body.sessionIds).size !== body.sessionIds.length
        || body.sessionIds.some(id => typeof id !== 'string' || !id || id.length > 240 || /[\u0000-\u001f\u007f]/.test(id))
        || typeof body.pin.requestKey !== 'string' || body.pin.requestKey !== eventComparisonRequestKey(body.request)
        || typeof body.pin.coverageFingerprint !== 'string' || !body.pin.coverageFingerprint
        || typeof body.pin.eventFingerprint !== 'string' || !body.pin.eventFingerprint || !body.pin.selection) {
        invalid('Choose 1–3 exact matched event sessions from the current query and source receipt.');
    }
    const tickSize = ports.tickSize;
    if (tickSize !== null && (typeof tickSize !== 'number' || !Number.isFinite(tickSize) || tickSize <= 0)) invalid('The source tick size is unavailable or invalid.');
    const calendars = snapshotEventCalendars(ports.calendars);
    const calendar = calendars.find(item => item.event === body.calendarEvent);
    if (!calendar) return invalid('Select an explicit bundled or supplied local event calendar.', 'UNSUPPORTED_INPUT');
    const events = eventCoverage(calendars)!;
    if (events.fingerprint !== body.pin.eventFingerprint) invalid('The supplied event calendars changed. Run the query again.');
    const request = body.request;
    const fresh = await ports.runQuery(structuredClone(request), signal); checkAborted(signal);
    const sourceValid = (source: MarketStatsPageResponse['source']): boolean => !!source && source.repository === MARKET_STATS_SOURCE.repository
        && source.commit === MARKET_STATS_SOURCE.commit && source.version === MARKET_STATS_SOURCE.version;
    if (!fresh || !sourceValid(fresh.source) || !fresh.coverage || !fresh.selection || !fresh.result
        || !Array.isArray(fresh.result.sessions) || fresh.result.sessions.length > 100
        || !sameEventComparisonPin(body.pin, pinEventComparison(request, fresh))
        || fresh.coverage.revealedUntil !== fresh.selection.until
        || fresh.selection.datasetId !== request.datasetId || fresh.selection.sourceMode !== request.sourceMode
        || fresh.selection.from !== request.from || fresh.selection.until > request.until
        || request.sourceMode === 'replay' && (!request.replay || fresh.selection.replay?.id !== request.replay.id || fresh.selection.replay?.revision !== request.replay.revision)
        || request.sourceMode === 'cache' && (request.replay !== undefined || fresh.selection.replay !== undefined)) {
        return invalid('The query, source or replay receipt changed. Run statistics again.', 'INVALID_RESULT');
    }
    const receipt = fresh.coverage.events;
    if (!receipt || receipt.fingerprint !== events.fingerprint
        || eventComparisonRequestKey(receipt as unknown as MarketStatsRequest) !== eventComparisonRequestKey(events as unknown as MarketStatsRequest)) {
        return invalid('The query does not use these exact supplied event calendars.', 'INVALID_RESULT');
    }
    const candidates = eventComparisonCandidates(fresh, calendar);
    const rows = body.sessionIds.map(id => {
        const matches = candidates.filter(row => row.sessionId === id);
        if (matches.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(matches[0]!.tradeDate)
            || !Number.isFinite(Date.parse(matches[0]!.tradeDate)) || new Date(matches[0]!.tradeDate).toISOString().slice(0, 10) !== matches[0]!.tradeDate) {
            return invalid('Every selected session must match this exact query and a covered event day.');
        }
        return matches[0]!;
    });
    const result: EventComparisonResult = { pin: structuredClone(body.pin),
        calendar: { event: calendar.event, version: calendar.version, sources: [...calendar.sources], coverage: { ...calendar.coverage },
            ...(calendar.notes ? { notes: calendar.notes } : {}), fingerprint: receipt.calendars.find(item => item.event === calendar.event)!.fingerprint, timing: 'day-only' },
        sessions: [], basis: 'Each path uses minute closes minus the first measured session-bar open. Range is high minus low. Net change is final close minus that open. MAE/MFE are nonnegative directional high/low excursions from that open, without intrabar ordering. Percent uses that open only when positive; ticks use the source tick size. Pre-session context is excluded.',
        disclaimer: 'Descriptive event-day sessions only. No release minute is supplied. Up to three selected examples do not establish a probability or account P&L.' };
    const expectedQuery = { ...request.query, symbol: fresh.selection.symbol, sessionKey: request.session.key, sessionsLimit: request.query.sessionsLimit ?? 25 };
    for (const row of rows) {
        checkAborted(signal);
        // Await disposal too: do not race an abort against a native callback still holding its store.
        const artifact = await ports.readSession(structuredClone(request), row.sessionId, signal); checkAborted(signal);
        if (!artifact || artifact.kind !== 'session' || !sourceValid(artifact.source) || !artifact.coverage || !artifact.selection
            || !sameEventComparisonPin(body.pin, { requestKey: body.pin.requestKey, selection: artifact.selection,
                coverageFingerprint: artifact.coverage.fingerprint, eventFingerprint: artifact.coverage.events?.fingerprint ?? '' })
            || artifact.coverage.revealedUntil !== fresh.coverage.revealedUntil
            || eventComparisonRequestKey(artifact.query as unknown as MarketStatsRequest) !== eventComparisonRequestKey(expectedQuery as unknown as MarketStatsRequest)
            || !artifact.session || artifact.session.sessionId !== row.sessionId || artifact.session.tradeDate !== row.tradeDate
            || artifact.session.symbol !== fresh.selection.symbol || artifact.session.sessionKey !== request.session.key
            || artifact.session.tz !== request.session.tz || artifact.session.startTs < fresh.selection.from
            || artifact.session.endTs > fresh.selection.until || !artifact.session.context || !Array.isArray(artifact.session.context.bars)
            || artifact.session.context.bars.length !== 0) {
            return invalid('The session artifact does not match the pinned query, event date and source.', 'INVALID_RESULT');
        }
        if (/\.v\./.test(artifact.session.symbol) && !artifact.contract) {
            return invalid('Continuous-futures comparisons require host-verified raw contract identity for every measured bar.', 'UNSUPPORTED_INPUT');
        }
        try { result.sessions.push(describeEventSession(artifact.session, { tickSize, revealedUntil: fresh.coverage.revealedUntil, contract: artifact.contract })); }
        catch { return invalid('Invalid, mixed-contract or unrevealed measured session.', 'INVALID_RESULT'); }
    }
    checkAborted(signal);
    if (Buffer.byteLength(JSON.stringify(result)) > EVENT_COMPARISON_LIMITS.outputBytes) invalid('Historical comparison output exceeds its bounded budget.', 'INVALID_RESULT');
    return result;
}
