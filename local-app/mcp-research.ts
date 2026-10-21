import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { MarketStatsPageResponse, MarketStatsRequest } from './shared/market-stats';
import type { SessionBarsResult } from '@luxalgo/edge-stats/session-bars';
import { eventComparisonRequestKey, sameEventComparisonPin, type EventComparisonRequest, type EventComparisonResult } from './shared/event-comparison';

const ports = { desktop: 5196, run: 5197, develop: 5199 } as const;
export type ResearchMode = keyof typeof ports;
const MAX_BYTES = 2 * 1024 * 1024;
const BODY_BYTES = 128_000;
const OUTPUT_BYTES = 512_000;
const PRIVATE = /^(?:proto|prototype|constructor|(?:access|refresh|local|bearer)?token|apikey|authorization|setcookie|cookies?|password|passphrase|secret|credentials?|datadirectory|repositorydirectory)$/i;

class ResearchError extends Error {}

function checked(value: unknown, tokens: readonly string[] = [], input = false): unknown {
    let nodes = 0;
    function visit(item: unknown, depth: number): void {
        if (++nodes > 60_000 || depth > 24) throw new ResearchError('Local research result is too complex.');
        if (typeof item === 'string') {
            if (tokens.some(token => item.includes(token))) throw new ResearchError('Local research result contains private connection data.');
            return;
        }
        if (input && item === undefined || item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
        if (!item || typeof item !== 'object') throw new ResearchError('Invalid local research result.');
        for (const [key, child] of Object.entries(item)) {
            if (PRIVATE.test(key.replace(/[^a-z0-9]/gi, ''))) throw new ResearchError('Local research result contains a private field.');
            visit(child, depth + 1);
        }
    }
    visit(value, 0); return value;
}

function aborted(signal: AbortSignal): ResearchError {
    return new ResearchError(signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
        ? 'Local research request timed out.' : 'Local research request was cancelled.');
}

// Also bounds injected transports and stalled streams that ignore fetch's signal.
async function interruptible<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw aborted(signal);
    let stop: () => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
        stop = () => reject(aborted(signal)); signal.addEventListener('abort', stop, { once: true });
    });
    try { return await Promise.race([work(), interrupted]); }
    finally { signal.removeEventListener('abort', stop); }
}

const modeSchema = z.enum(['desktop', 'run', 'develop']);
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const endClock = z.union([clock, z.literal('24:00')]);
const date = z.iso.date();
const label = z.string().min(1).max(200);
const calendar = z.object({ exchange: label, version: label, sources: z.array(z.string().max(500)).max(20),
    notes: z.string().max(2000).optional(), coverage: z.object({ from: date, to: date }).strict(),
    holidays: z.array(z.object({ date, name: label }).strict()).max(4000),
    halfDays: z.array(z.object({ date, name: label, close: clock }).strict()).max(4000),
}).strict().refine(value => value.coverage.from <= value.coverage.to, 'Calendar coverage must be ordered.');
const querySchema = z.object({ dsl: z.string().min(1).max(2000), since: date.optional(), until: date.optional(),
    groupBy: z.string().min(1).max(64).optional(), sessionsLimit: z.number().int().min(0).max(100).optional(),
}).strict().refine(value => !value.since || !value.until || value.since <= value.until, 'Query dates must be ordered.');
const selection = {
    datasetId: z.uuid(), sourceMode: z.enum(['replay', 'cache']), from: timestamp, until: timestamp,
    replay: z.object({ id: z.uuid(), revision: z.number().int().nonnegative() }).strict().optional(),
    session: z.object({ key: z.string().min(1).max(64), start: clock, end: endClock,
        tz: z.string().min(1).max(80).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Choose a valid timezone.'),
        overnight: z.boolean() }).strict(),
    calendar: calendar.nullable(),
    eventCalendar: z.literal('bundled').optional(),
};
function validSelection(value: { sourceMode: string; from: number; until: number; replay?: unknown }): boolean {
    return value.until > value.from && value.until - value.from <= 10 * 366 * 86_400_000
        && value.from % 60_000 === 0 && value.until % 60_000 === 0
        && (value.sourceMode === 'replay' ? value.replay !== undefined : value.replay === undefined);
}
const selectionSchema = z.object(selection).strict().refine(validSelection, 'Choose aligned bounds and an exact replay revision, or explicit cache scope.');
const requestSchema = z.object({ ...selection, query: querySchema }).strict().refine(validSelection, 'Choose aligned bounds and an exact replay revision, or explicit cache scope.') satisfies z.ZodType<MarketStatsRequest>;
const presetSchema = z.object({ id: z.string().min(1).max(80),
    params: z.record(z.string().min(1).max(64), z.union([z.string().min(1).max(128), z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)]))
        .refine(value => Object.keys(value).length <= 32, 'Too many preset parameters.').optional(),
    groupBy: z.string().min(1).max(64).optional(), eventCalendar: z.literal('bundled').optional() }).strict();
const composedSchema = z.object({ dsl: z.string().min(1).max(2000), groupBy: z.string().min(1).max(64).optional(),
    preset: z.object({ id: z.string().min(1).max(80), version: z.number().int().nonnegative(), title: label,
        params: z.record(z.string(), z.union([z.string(), z.number().finite()])) }).strict() }).strict();
const catalogSchema = z.object({ datasets: z.array(z.unknown()), sessions: z.array(z.unknown()), registry: z.array(z.unknown()), limits: z.record(z.string(), z.unknown()),
    eventCalendars: z.array(z.unknown()).optional() });
const returnedSelection = z.object({ datasetId: z.uuid(), name: z.string(), symbol: z.string(), checksum: z.string().min(1), sourceMode: z.enum(['cache', 'replay']),
    from: timestamp, until: timestamp, replay: z.object({ id: z.uuid(), revision: z.number().int().nonnegative(), cursor: z.number().int().min(-1) }).strict().optional(), eventCalendar: z.literal('bundled').optional() }).strict();
const pageSchema = z.object({
    source: z.object({ repository: z.string(), commit: z.string().regex(/^[a-f0-9]{40}$/), version: z.string() }).strict(),
    coverage: z.object({ revealedUntil: timestamp }).passthrough(), warnings: z.array(z.string()), result: z.record(z.string(), z.unknown()), selection: returnedSelection,
}).passthrough();
const finite = z.number().finite();
const count = z.number().int().nonnegative();
const nullableNumber = finite.nullable();
const comparisonPin = z.object({ requestKey: z.string().min(1).max(BODY_BYTES), selection: returnedSelection,
    coverageFingerprint: z.string().min(1).max(128), eventFingerprint: z.string().min(1).max(128) }).strict();
const comparisonInput = z.object({ request: requestSchema, pin: comparisonPin, calendarEvent: z.string().min(1).max(128),
    sessionIds: z.array(z.string().min(1).max(240)).min(1).max(3) }).strict()
    .refine(input => input.request.eventCalendar === 'bundled' && new Set(input.sessionIds).size === input.sessionIds.length
        && input.pin.requestKey === eventComparisonRequestKey(input.request), 'Choose exact matched sessions and explicit bundled events.');
const movement = z.object({ points: finite, ticks: nullableNumber, percent: nullableNumber }).strict();
const comparisonSession = z.object({ sessionId: z.string().min(1).max(240), tradeDate: date, symbol: label, sessionKey: label, tz: label,
    contract: z.object({ symbol: label, instrumentId: z.string().regex(/^[1-9]\d{0,19}$/).nullable() }).strict().nullable(),
    isRollDay: z.boolean(), startTs: timestamp, endTs: timestamp, firstBarOpen: timestamp, lastBarClose: timestamp,
    barCount: z.number().int().min(1).max(5000), tickSize: finite.positive().nullable(),
    baseline: z.object({ kind: z.literal('first-session-bar-open'), price: finite, time: timestamp, percentAvailable: z.boolean() }).strict(),
    prices: z.object({ open: finite, close: finite, high: finite, low: finite }).strict(),
    range: movement, netChange: movement, longMae: movement, longMfe: movement, shortMae: movement, shortMfe: movement,
    path: z.array(z.object({ time: timestamp, elapsedMinutes: finite.positive(), change: movement }).strict()).min(1).max(5000),
}).strict();
const comparisonResult = z.object({ pin: comparisonPin,
    calendar: z.object({ event: label, version: label, sources: z.array(z.string().max(2000)).max(32),
        coverage: z.object({ from: date, to: date }).strict(), notes: z.string().max(4000).optional(),
        fingerprint: z.string().min(1).max(128), timing: z.literal('day-only') }).strict(),
    sessions: z.array(comparisonSession).min(1).max(3), basis: z.string().min(1).max(4000), disclaimer: z.string().min(1).max(4000),
}).strict() satisfies z.ZodType<EventComparisonResult>;
const sessionBar = z.object({ ts: timestamp, open: finite, high: finite, low: finite, close: finite, volume: finite.nonnegative() }).strict()
    .refine(bar => bar.ts % 60_000 === 0 && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close) && bar.low <= bar.high, 'Invalid session bar.');
const sessionBarsSchema = z.object({ sessionId: z.string(), symbol: label, sessionKey: label, tradeDate: date, tf: z.literal('1m'), tz: label,
    startTs: timestamp, endTs: timestamp, isHalfDay: z.boolean(), isRollDay: z.boolean(), complete: z.literal(true),
    bars: z.array(sessionBar).max(5000),
    context: z.object({ kind: z.enum(['pre-session', 'prior-session', 'none']), bars: z.array(sessionBar).max(240), note: z.string().max(4000) }).strict(),
    levels: z.object({ prevClose: nullableNumber, prevHigh: nullableNumber, prevLow: nullableNumber, prevMid: nullableNumber,
        open: nullableNumber, high: nullableNumber, low: nullableNumber, close: nullableNumber, gapAbs: nullableNumber, gapPct: nullableNumber,
        gapDir: z.enum(['up', 'down', 'none']).nullable(), gapFilled: z.boolean().nullable(), touchedPrevHigh: z.boolean().nullable(),
        touchedPrevLow: z.boolean().nullable(), ibBreak: z.string().nullable(), ibWindow: count,
        openingRanges: z.array(z.object({ window: count, high: nullableNumber, low: nullableNumber,
            firstBreak: z.enum(['up', 'down', 'none']).nullable(), breakMin: nullableNumber }).strict()).max(12) }).strict(),
    times: z.object({ gapFillMin: nullableNumber, touchPrevHighMin: nullableNumber, touchPrevLowMin: nullableNumber, highTimeMin: nullableNumber, lowTimeMin: nullableNumber }).strict(),
    disclaimer: z.string().max(4000),
}).strict() satisfies z.ZodType<SessionBarsResult>;
const analyticsSchema = z.object({ trades: count, wins: count, losses: count, winRate: z.number().min(0).max(1).nullable(),
    netPnl: finite, grossProfit: finite.nonnegative(), grossLoss: finite.nonnegative(), profitFactor: finite.nonnegative().nullable(),
    expectancy: finite.nullable(), avgWin: finite, avgLoss: finite, avgR: finite.nullable(), maxDrawdown: finite.nonnegative(),
    maxWinStreak: count, maxLossStreak: count,
    byDay: z.array(z.object({ day: date, pnl: finite, trades: count }).strict()).max(10_000),
    byHour: z.array(z.object({ hour: z.number().int().min(0).max(23), pnl: finite, trades: count }).strict()).max(24),
    equityCurve: z.array(z.object({ time: timestamp, balance: finite, equity: finite }).strict()).max(10_000),
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new ResearchError('Invalid local research payload.');
    return result.data;
}
function sameSelection(selected: z.infer<typeof returnedSelection>, input: MarketStatsRequest): void {
    if (selected.datasetId !== input.datasetId || selected.sourceMode !== input.sourceMode || selected.from !== input.from || selected.eventCalendar !== input.eventCalendar
        || selected.until > input.until || selected.until < selected.from
        || (input.sourceMode === 'cache' ? selected.replay !== undefined || selected.until !== input.until
            : selected.replay?.id !== input.replay?.id || selected.replay?.revision !== input.replay?.revision)) {
        throw new ResearchError('The research result does not match the selected source snapshot.');
    }
}

/** Fixed loopback destinations only; discovery never redirects an analysis to another application. */
export class LocalResearchConnection {
    private readonly tokens = new Map<ResearchMode, string>();
    constructor(private readonly request: typeof fetch = fetch) {}

    private async exchange(mode: ResearchMode, path: string, signal: AbortSignal, body?: string, bootstrap = false): Promise<unknown> {
        let response: Response;
        const sentToken = body === undefined ? undefined : this.tokens.get(mode);
        try {
            response = await interruptible(() => {
                const pending = this.request('http://127.0.0.1:' + ports[mode] + path, {
                    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
                    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Local-Token': sentToken! }, body,
                });
                void pending.then(value => { if (signal.aborted) void value.body?.cancel().catch(() => {}); }, () => {});
                return pending;
            }, signal);
        } catch (error) {
            if (error instanceof ResearchError) throw error;
            throw new ResearchError('The selected local research application is unavailable.');
        }
        if (!response.ok) {
            if (response.status === 403 && this.tokens.get(mode) === sentToken) this.tokens.delete(mode);
            void response.body?.cancel().catch(() => {});
            throw new ResearchError(response.status === 403 ? 'Reconnect the selected local research bridge; this request was not retried.'
                : response.status === 404 ? 'This application version does not provide the requested research feature.'
                : response.status === 409 ? 'The local source changed or is busy. Refresh its exact source before retrying.' : 'Local research request failed (' + response.status + ').');
        }
        const reader = response.body?.getReader(); if (!reader) throw new ResearchError('Empty local research response.');
        const chunks: Uint8Array[] = []; let size = 0;
        try {
            for (;;) {
                const part = await interruptible(() => reader.read(), signal); if (part.done) break;
                size += part.value.byteLength;
                if (size > MAX_BYTES) throw new ResearchError('Local research response exceeds its size limit.');
                chunks.push(part.value);
            }
            let value: unknown;
            try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { throw new ResearchError('Invalid JSON in local research response.'); }
            if (signal.aborted) throw aborted(signal);
            return bootstrap ? value : checked(value, [...this.tokens.values()]);
        } catch (error) {
            void reader.cancel().catch(() => {});
            if (error instanceof ResearchError) throw error;
            throw new ResearchError('The local research response ended before completion.');
        } finally { reader.releaseLock(); }
    }

    private async read(mode: ResearchMode, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
        parse(modeSchema, mode);
        const deadline = AbortSignal.timeout(body === undefined ? 12_000 : 45_000);
        const active = signal ? AbortSignal.any([deadline, signal]) : deadline;
        if (active.aborted) throw aborted(active);
        let serialized: string | undefined;
        if (body !== undefined) {
            checked(body, [], true); serialized = JSON.stringify(body);
            if (Buffer.byteLength(serialized) > (path.endsWith('/preset') ? 4096 : BODY_BYTES)) throw new ResearchError('Local research request exceeds its size limit.');
            if (!this.tokens.has(mode)) {
                const bootstrapSignal = AbortSignal.any([active, AbortSignal.timeout(12_000)]);
                const bootstrap = await this.exchange(mode, '/api/bootstrap', bootstrapSignal, undefined, true);
                // Bootstrap contains private paths and other app state. Only retain its token.
                const token = bootstrap && typeof bootstrap === 'object' && 'token' in bootstrap ? bootstrap.token : undefined;
                if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new ResearchError('Reconnect the selected local research bridge.');
                this.tokens.set(mode, token);
            }
        }
        return this.exchange(mode, path, active, serialized);
    }
    async catalog(mode: ResearchMode, signal?: AbortSignal) { return parse(catalogSchema, await this.read(mode, '/api/market-stats', undefined, signal)); }
    presets(mode: ResearchMode, eventCalendar?: 'bundled', signal?: AbortSignal): Promise<unknown> {
        parse(z.literal('bundled').optional(), eventCalendar);
        return this.read(mode, '/api/market-stats/presets' + (eventCalendar === 'bundled' ? '?events=bundled' : ''), undefined, signal);
    }
    async compose(mode: ResearchMode, preset: z.infer<typeof presetSchema>, signal?: AbortSignal) {
        return parse(composedSchema, await this.read(mode, '/api/market-stats/preset', parse(presetSchema, preset), signal));
    }
    async query(mode: ResearchMode, request: MarketStatsRequest, signal?: AbortSignal): Promise<MarketStatsPageResponse> {
        const input = parse(requestSchema, request);
        const value = await this.read(mode, '/api/market-stats/query', input, signal);
        const page = parse(pageSchema, value);
        sameSelection(page.selection, input);
        if (page.coverage.revealedUntil !== page.selection.until) throw new ResearchError('The research result does not match the selected source cutoff.');
        return value as MarketStatsPageResponse;
    }
    async compareEvents(mode: ResearchMode, request: EventComparisonRequest, signal?: AbortSignal): Promise<EventComparisonResult> {
        const input = parse(comparisonInput, request);
        sameSelection(input.pin.selection, input.request);
        const value = parse(comparisonResult, await this.read(mode, '/api/market-stats/event-comparison', input, signal));
        if (!sameEventComparisonPin(input.pin, value.pin) || value.calendar.event !== input.calendarEvent
            || value.calendar.coverage.from > value.calendar.coverage.to || value.sessions.length !== input.sessionIds.length) {
            throw new ResearchError('The event comparison does not match the selected query and calendar.');
        }
        for (const [index, session] of value.sessions.entries()) {
            const first = session.path[0]!, last = session.path.at(-1)!;
            if (session.sessionId !== input.sessionIds[index] || session.symbol !== input.pin.selection.symbol
                || session.sessionKey !== input.request.session.key || session.tz !== input.request.session.tz
                || session.sessionId !== `${session.symbol}|${session.sessionKey}|${session.tradeDate}`
                || session.tradeDate < value.calendar.coverage.from || session.tradeDate > value.calendar.coverage.to
                || session.startTs < input.pin.selection.from || session.endTs > input.pin.selection.until
                || session.endTs <= session.startTs || session.endTs - session.startTs > 36 * 3_600_000
                || session.firstBarOpen < session.startTs || session.lastBarClose > session.endTs
                || session.baseline.time !== session.firstBarOpen || session.baseline.price !== session.prices.open
                || session.baseline.percentAvailable !== (session.prices.open > 0) || session.path.length !== session.barCount
                || first.time !== session.firstBarOpen + 60_000 || last.time !== session.lastBarClose
                || session.prices.low > Math.min(session.prices.open, session.prices.close)
                || session.prices.high < Math.max(session.prices.open, session.prices.close)) {
                throw new ResearchError('The event comparison contains a mismatched or unrevealed session.');
            }
            let previous = session.startTs;
            for (const point of session.path) {
                if (point.time <= previous || point.time % 60_000 !== 0 || point.time > session.endTs
                    || point.elapsedMinutes !== (point.time - session.startTs) / 60_000) {
                    throw new ResearchError('The event comparison contains an invalid session path.');
                }
                previous = point.time;
            }
        }
        return value;
    }
    async sessionBars(mode: ResearchMode, input: { request: MarketStatsRequest; sessionId: string; contextBars?: number }, signal?: AbortSignal) {
        const body = parse(z.object({ request: requestSchema, sessionId: z.string().min(1).max(240).regex(/^[^\u0000-\u001f\u007f]+$/), contextBars: z.number().int().min(0).max(240).optional() }).strict(), input);
        const value = await this.read(mode, '/api/market-stats/session', body, signal);
        const artifact = parse(z.object({ kind: z.literal('session'), session: sessionBarsSchema, selection: returnedSelection,
            source: pageSchema.shape.source, coverage: pageSchema.shape.coverage,
            query: z.object({ dsl: z.string().min(1).max(2000), symbol: label, sessionKey: label }).passthrough() }).strict(), value);
        sameSelection(artifact.selection, body.request);
        const session = artifact.session;
        if (artifact.coverage.revealedUntil !== artifact.selection.until || artifact.query.dsl !== body.request.query.dsl
            || artifact.query.symbol !== session.symbol || artifact.query.sessionKey !== session.sessionKey
            || session.sessionId !== body.sessionId || session.symbol !== artifact.selection.symbol || session.sessionKey !== body.request.session.key
            || session.tz !== body.request.session.tz || session.endTs <= session.startTs || session.startTs < artifact.selection.from
            || session.endTs > artifact.selection.until || session.endTs - session.startTs > 36 * 3_600_000
            || session.context.bars.length > (body.contextBars ?? 30)) {
            throw new ResearchError('The research result does not match the selected session.');
        }
        for (const [bars, from, until] of [[session.bars, session.startTs, session.endTs], [session.context.bars, artifact.selection.from, session.startTs]] as const) {
            let previous = -1;
            for (const bar of bars) {
                if (bar.ts < from || bar.ts + 60_000 > until || bar.ts <= previous) throw new ResearchError('The research session bars exceed the selected source bounds.');
                previous = bar.ts;
            }
        }
        return artifact;
    }
    async sessions(mode: ResearchMode, signal?: AbortSignal): Promise<unknown[]> { return parse(z.array(z.unknown()), await this.read(mode, '/api/sessions', undefined, signal)); }
    async statistics(mode: ResearchMode, id: string, signal?: AbortSignal) {
        parse(z.uuid(), id);
        return parse(analyticsSchema, await this.read(mode, '/api/sessions/' + id + '/analytics', undefined, signal));
    }
}

export function registerResearchTools(server: McpServer, connection = new LocalResearchConnection()): void {
    const mode = modeSchema;
    const annotations = { readOnlyHint: true, openWorldHint: false };
    const result = async (work: () => Promise<unknown>) => {
        try {
            const value = checked(await work()); const text = JSON.stringify(value);
            if (Buffer.byteLength(text) > OUTPUT_BYTES) throw new ResearchError('Research output exceeds the limit; request a smaller result.');
            return { content: [{ type: 'text' as const, text }] };
        } catch (error) { return { content: [{ type: 'text' as const, text: error instanceof ResearchError ? error.message : 'The local research request failed.' }], isError: true }; }
    };
    server.registerTool('vela_research_apps', { description: 'Discover local application research availability without requiring an open chart. Keep desktop, run and develop sources separate; a failed mode never falls back to another.', inputSchema: z.object({}).strict(), annotations },
        async (_, context) => result(async () => {
            const apps = await Promise.all(Object.keys(ports).map(async value => {
                const selected = value as ResearchMode;
                try { const catalog = await connection.catalog(selected, context.mcpReq.signal); return { mode: selected, available: true, datasets: catalog.datasets.length, sessions: catalog.sessions.length }; }
                catch { return { mode: selected, available: false }; }
            }));
            if (context.mcpReq.signal.aborted) throw aborted(context.mcpReq.signal);
            return apps;
        }));
    server.registerTool('vela_edge_sources', { description: 'Read cached source coverage, immutable checksums, replay IDs/revisions and query limits for one app. Use replay scope with its exact revision for blind analysis; cache scope explicitly permits selected historical data beyond replay.', inputSchema: z.object({ mode }).strict(), annotations },
        async (args, context) => result(async () => { const catalog = await connection.catalog(args.mode, context.mcpReq.signal); return { mode: args.mode, datasets: catalog.datasets, sessions: catalog.sessions, limits: catalog.limits,
            ...(catalog.eventCalendars ? { eventCalendars: catalog.eventCalendars } : {}) }; }));
    server.registerTool('vela_edge_fields', { description: 'List the actual local statistics outcomes, conditions, fields, examples and grouping support. Events require explicit bundled local calendar selection and verified date coverage; unknown coverage never means no event.', inputSchema: z.object({ mode }).strict(), annotations },
        async (args, context) => result(async () => { const catalog = await connection.catalog(args.mode, context.mcpReq.signal); return { mode: args.mode, registry: catalog.registry,
            ...(catalog.eventCalendars ? { eventCalendars: catalog.eventCalendars } : {}) }; }));
    server.registerTool('vela_edge_presets', { description: 'Read the official pinned report/template catalog, parameters, categories, Library references and data requirements. Events remain unavailable unless eventCalendar explicitly selects bundled local data. Unknown event coverage never means no event.', inputSchema: z.object({ mode, eventCalendar: z.literal('bundled').optional() }).strict(), annotations },
        async (args, context) => result(async () => ({ mode: args.mode, eventCalendar: args.eventCalendar ?? null, catalog: await connection.presets(args.mode, args.eventCalendar, context.mcpReq.signal) })));
    server.registerTool('vela_edge_query', { description: 'Run a composed question on explicit bounded local one-minute bars using the actual Edge Stats engine. Returns N, confidence intervals, guards, groups, stability, dates and provenance. Replay requires a captured saved revision; cache is an explicit separate scope. No orders or downloads.', inputSchema: z.object({ mode, request: requestSchema }).strict(), annotations },
        async (args, context) => result(async () => ({ ...await connection.query(args.mode, args.request, context.mcpReq.signal), mode: args.mode, eventCalendar: args.request.eventCalendar ?? null })));
    server.registerTool('vela_edge_report', { description: 'Compose an official report template with validated parameters, then run it on the explicit selected source. Uses the same engine and sample guards as the page; never forces withheld estimates. Event reports require explicit request.eventCalendar bundled selection.', inputSchema: z.object({ mode, request: selectionSchema, preset: presetSchema }).strict()
        .refine(args => !args.preset.eventCalendar || args.preset.eventCalendar === args.request.eventCalendar, 'Preset events require the same explicit source selection.'), annotations },
        async (args, context) => result(async () => {
            const signal = AbortSignal.any([context.mcpReq.signal, AbortSignal.timeout(45_000)]);
            const composed = await connection.compose(args.mode, { ...args.preset, ...(args.request.eventCalendar ? { eventCalendar: args.request.eventCalendar } : {}) }, signal);
            const value = await connection.query(args.mode, { ...args.request, query: { dsl: composed.dsl, groupBy: composed.groupBy, sessionsLimit: 100 } }, signal);
            return { ...value, mode: args.mode, eventCalendar: args.request.eventCalendar ?? null, preset: composed.preset };
        }));
    server.registerTool('vela_edge_session_bars', { description: 'Inspect one exact matched sessionId from an explicit bounded research query. Revalidates the saved replay revision and selected source; does not advance replay. contextBars is capped at 240 and contract-roll context is omitted. Large results fail closed; use a smaller context.', inputSchema: z.object({ mode, request: requestSchema, sessionId: z.string().min(1).max(240).regex(/^[^\u0000-\u001f\u007f]+$/), contextBars: z.number().int().min(0).max(240).optional() }).strict(), annotations },
        async (args, context) => result(async () => ({ ...await connection.sessionBars(args.mode, { request: args.request, sessionId: args.sessionId, contextBars: args.contextBars }, context.mcpReq.signal), mode: args.mode, eventCalendar: args.request.eventCalendar ?? null })));
    server.registerTool('vela_compare_event_sessions', { description: 'Compare 1–3 exact event-day matches from a prior Edge Stats query and its source/event receipt. Uses minute closes from the first measured session open, explicit points/ticks/percent and descriptive excursions. Calendars supply days, not release times. No probabilities, account P&L, orders or replay advancement. Paths may be sampled with coverage disclosed.',
        inputSchema: z.object({ mode, comparison: comparisonInput, pathLimit: z.number().int().min(0).max(120).default(60) }).strict(), annotations },
        async (args, context) => result(async () => {
            const value = await connection.compareEvents(args.mode, args.comparison, context.mcpReq.signal);
            return { ...value, mode: args.mode, sessions: value.sessions.map(session => {
                const count = Math.min(session.path.length, args.pathLimit);
                const path = Array.from({ length: count }, (_, i) => session.path[count <= 1 ? session.path.length - 1 : Math.round(i * (session.path.length - 1) / (count - 1))]!);
                return { ...session, path, pathCoverage: { measured: session.path.length, returned: count, sampled: count < session.path.length } };
            }) };
        }));
    const page = { limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).max(1000).default(0) };
    server.registerTool('vela_backtest_sessions', { description: 'List saved manual replay session summaries, including ones that have no open chart. This is global saved-history context, distinct from Pine results and the current replay clock.', inputSchema: z.object({ mode, ...page }).strict(), annotations },
        async (args, context) => result(async () => { const sessions = await connection.sessions(args.mode, context.mcpReq.signal); return { mode: args.mode, basis: 'saved manual replay summaries; not the active replay clock', total: sessions.length, offset: args.offset, sessions: sessions.slice(args.offset, args.offset + args.limit) }; }));
    server.registerTool('vela_backtest_statistics', { description: 'Read one explicit saved manual replay ledger\'s computed net P&L, win/loss counts, account drawdown, mean R and time breakdowns. R coverage counts are unavailable. Separates manual account statistics from Pine strategy results; retained equity points can be sampled.', inputSchema: z.object({ mode, sessionId: z.uuid(), curveLimit: z.number().int().min(0).max(1000).default(200) }).strict(), annotations },
        async (args, context) => result(async () => {
            const statistics = await connection.statistics(args.mode, args.sessionId, context.mcpReq.signal);
            const original = statistics.equityCurve; const count = Math.min(args.curveLimit, original.length);
            const equityCurve = Array.from({ length: count }, (_, index) => original[count <= 1 ? original.length - 1 : Math.round(index * (original.length - 1) / (count - 1))]);
            return { mode: args.mode, sessionId: args.sessionId, basis: 'saved manual replay ledger',
                metricBasis: { netPnl: 'sum of closed-trade net P&L', maxDrawdown: 'saved account peak-to-trough equity drawdown',
                    avgR: 'mean net P&L / positive initial risk among covered closed trades; coverage count unavailable',
                    equityCurve: 'retained account equity samples; not a complete intratrade price path' },
                statistics: { ...statistics, equityCurve }, equityCoverage: { retained: original.length, returned: count, sampled: count < original.length } };
        }));
}
