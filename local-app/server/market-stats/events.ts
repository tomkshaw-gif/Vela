import { createHash } from 'node:crypto';
import { eventFileSchema } from '@luxalgo/edge-stats/events';
import type { EventFile } from '@luxalgo/edge-stats/events';
import type { QueryAst, Store } from '@luxalgo/edge-stats';
import { MarketStatsError, MARKET_STATS_LIMITS } from './contract';
import type { MarketStatsEventCoverage } from './contract';

export const MARKET_STATS_EVENT_LIMITS = { calendars: 32, datesPerCalendar: 10_000, totalDates: 50_000, bytes: 1_000_000 } as const;
const RELATIONS = new Map<string, EventRequirement['relation']>([
    ['eventDay', 'current'], ['eventOccurs', 'current'], ['dayBeforeEvent', 'next'], ['dayAfterEvent', 'previous'],
]);
export interface EventRequirement { event: string; relation: 'current' | 'next' | 'previous' }
function invalid(): never { throw new MarketStatsError('INVALID_INPUT', 'Supply bounded, unique local event calendars with valid dates and declared coverage.'); }
function plain(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function isoDate(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function text(value: unknown, maximum: number): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

/** No files or implicit calendars: detach and validate before preparation can yield. */
export function snapshotEventCalendars(value: unknown): EventFile[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MARKET_STATS_EVENT_LIMITS.calendars) invalid();
    const names = new Set<string>(); let totalDates = 0;
    const files: EventFile[] = [];
    for (const raw of value) {
        if (!plain(raw) || !['event', 'version', 'sources', 'coverage', 'dates'].every(key => Object.hasOwn(raw, key))
            || Object.keys(raw).some(key => !['event', 'version', 'sources', 'notes', 'coverage', 'dates'].includes(key))
            || !text(raw.event, 128) || names.has(raw.event) || !text(raw.version, 100)
            || !Array.isArray(raw.sources) || raw.sources.length > 64 || raw.sources.some(source => !text(source, 2_000))
            || raw.notes !== undefined && (typeof raw.notes !== 'string' || raw.notes.length > 8_192)
            || !plain(raw.coverage) || !['from', 'to'].every(key => Object.hasOwn(raw.coverage as object, key))
            || Object.keys(raw.coverage).some(key => !['from', 'to'].includes(key))
            || !isoDate(raw.coverage.from) || !isoDate(raw.coverage.to) || raw.coverage.from > raw.coverage.to
            || !Array.isArray(raw.dates) || raw.dates.length > MARKET_STATS_EVENT_LIMITS.datesPerCalendar) invalid();
        const coverage = raw.coverage as { from: string; to: string }; const dates: unknown[] = raw.dates;
        totalDates += dates.length;
        if (totalDates > MARKET_STATS_EVENT_LIMITS.totalDates || new Set(dates).size !== dates.length
            || dates.some(date => !isoDate(date) || date < coverage.from || date > coverage.to)) invalid();
        const parsed = eventFileSchema.safeParse(raw);
        if (!parsed.success) invalid();
        names.add(parsed.data.event); files.push(parsed.data);
    }
    if (Buffer.byteLength(JSON.stringify(files)) > MARKET_STATS_EVENT_LIMITS.bytes) invalid();
    return files;
}

export function eventCoverage(files: readonly EventFile[]): MarketStatsEventCoverage | undefined {
    if (!files.length) return undefined;
    const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    return { fingerprint: fingerprint(files), calendars: files.map(file => ({ event: file.event, version: file.version,
        coverage: { ...file.coverage }, dates: file.dates.length, fingerprint: fingerprint(file) })) };
}

/** Inspect actual parsed calls, regardless of Boolean polarity or nesting. */
export function eventRequirements(ast: QueryAst): EventRequirement[] {
    const found = new Map<string, EventRequirement>(); const nodes: unknown[] = [ast];
    while (nodes.length) {
        const node = nodes.pop();
        if (!node || typeof node !== 'object') continue;
        if ('name' in node && typeof node.name === 'string' && RELATIONS.has(node.name)) {
            const args = 'args' in node && Array.isArray(node.args) ? node.args : [];
            const argument = args[0] as { t?: unknown; v?: unknown } | undefined;
            if (!argument || !['str', 'word'].includes(String(argument.t)) || typeof argument.v !== 'string') {
                throw new MarketStatsError('INVALID_QUERY', 'An event query needs an explicit event calendar name.');
            }
            const relation = RELATIONS.get(node.name)!;
            found.set(JSON.stringify([argument.v, relation]), { event: argument.v, relation });
        }
        nodes.push(...Object.values(node));
    }
    return [...found.values()];
}

export function requireEventCalendars(requirements: readonly EventRequirement[], files: readonly EventFile[]): void {
    const names = new Set(files.map(file => file.event));
    if (requirements.some(requirement => !names.has(requirement.event))) {
        throw new MarketStatsError('UNSUPPORTED_INPUT', 'This query requires a supplied local event calendar for every referenced event name.');
    }
}

interface FeatureDate { id: string; symbol: string; key: string; date: string; start: number; end: number; complete: boolean }
function featureDate(row: Record<string, unknown>): FeatureDate {
    const start = Number(row.start_ts); const end = Number(row.end_ts);
    if (typeof row.session_id !== 'string' || typeof row.symbol !== 'string' || typeof row.session_key !== 'string'
        || !isoDate(row.trade_date) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || typeof row.complete !== 'boolean') {
        throw new MarketStatsError('ENGINE_FAILED', 'The event coverage check received an invalid session feature.');
    }
    return { id: row.session_id, symbol: row.symbol, key: row.session_key, date: row.trade_date, start, end, complete: row.complete };
}

/** Mask only eligibility in this ephemeral job; keep every row for native neighbor subqueries. */
export async function applyEventEligibility(store: Store, requirements: readonly EventRequirement[], files: readonly EventFile[],
    cohorts: readonly { first: number; end: number }[], revealedUntil: number): Promise<void> {
    requireEventCalendars(requirements, files);
    const receipt = eventCoverage(files);
    if (receipt) {
        // The upstream Store receipt includes this opaque calendar-version meta value.
        const calendarVersion = await store.getMeta('calendar_version') ?? '';
        await store.setMeta('calendar_version', `${calendarVersion}|events:${receipt.fingerprint}`);
    }
    if (!requirements.length) return;
    const rows = await store.all(`SELECT session_id, symbol, session_key, CAST(trade_date AS VARCHAR) AS trade_date,
        start_ts, end_ts, complete FROM session_features ORDER BY symbol, session_key, trade_date LIMIT ${MARKET_STATS_LIMITS.bars + 1}`);
    if (rows.length > MARKET_STATS_LIMITS.bars) throw new MarketStatsError('ENGINE_FAILED', 'Too many event session features.');
    const groups = new Map<string, FeatureDate[]>();
    for (const raw of rows) {
        const row = featureDate(raw); const key = JSON.stringify([row.symbol, row.key]);
        const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
    }
    const calendars = new Map(files.map(file => [file.event, file])); const excluded: string[] = [];
    const cohortOf = (row: FeatureDate) => cohorts.length ? cohorts.findIndex(cohort => row.start >= cohort.first && row.end <= cohort.end) : 0;
    for (const group of groups.values()) for (let index = 0; index < group.length; index++) {
        const row = group[index]!;
        if (!row.complete) continue;
        const known = requirements.every(requirement => {
            const anchor = requirement.relation === 'current' ? row : group[index + (requirement.relation === 'next' ? 1 : -1)];
            const coverage = calendars.get(requirement.event)!.coverage;
            return anchor !== undefined && anchor.end <= revealedUntil && anchor.date >= coverage.from && anchor.date <= coverage.to
                && cohortOf(row) >= 0 && cohortOf(anchor) === cohortOf(row);
        });
        if (!known) excluded.push(row.id);
    }
    for (let index = 0; index < excluded.length; index += 500) {
        const ids = excluded.slice(index, index + 500).map(id => `'${id.replaceAll("'", "''")}'`).join(',');
        await store.run(`UPDATE session_features SET complete=false WHERE session_id IN (${ids})`);
    }
}
