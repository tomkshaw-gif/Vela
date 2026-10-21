import { bundledPresets } from '@luxalgo/edge-stats/preset-catalog';
import { composePresetDsl, presetSchema } from '@luxalgo/edge-stats/presets';
import type { Preset, PresetParam } from '@luxalgo/edge-stats/presets';
import { compileQuery, parseDsl } from '@luxalgo/edge-stats/query-tools';
import { describeRegistry } from '@luxalgo/edge-stats/registry';
import { MARKET_STATS_LIMITS, MARKET_STATS_SOURCE, MarketStatsError } from './market-stats/contract';
import type { EventFile } from '@luxalgo/edge-stats/events';
import { snapshotEventCalendars, eventCoverage, eventRequirements, requireEventCalendars } from './market-stats/events';

const DEFAULT_WINDOWS = [5, 10, 15, 30, 60];
const presets = bundledPresets.map(preset => presetSchema.parse(preset));
const byId = new Map(presets.map(preset => [preset.id, preset]));
const fields = describeRegistry('field');
const groupableFields = fields.filter(field => field.groupable).map(field => field.name);
const categoryTitles: Record<string, string> = {
    gaps: 'Gaps', 'opening-range': 'Opening range', 'initial-balance': 'Initial balance',
    levels: 'Prior levels', 'session-shape': 'Session shape', streaks: 'Streaks', seasonality: 'Seasonality',
    events: 'Events', 'time-of-day': 'Time of day', volatility: 'Volatility', fvg: 'Fair value gaps',
};

export interface StatsPresetContext { orWindows?: readonly number[]; ibWindow?: number; events?: readonly EventFile[] }
export interface BuiltStatsPreset {
    dsl: string;
    groupBy?: string;
    preset: { id: string; version: number; title: string; params: Record<string, number | string> };
}

function invalid(message: string): never { throw new MarketStatsError('INVALID_INPUT', message); }
function object(value: unknown, message: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(message);
    return value as Record<string, unknown>;
}
function knownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
    if (Object.keys(value).some(key => !allowed.includes(key))) invalid('Unknown statistics preset parameter.');
}
function contextFor(input: StatsPresetContext) {
    const context = object(input, 'Invalid statistics preset context.');
    knownKeys(context, ['orWindows', 'ibWindow', 'events']);
    const orWindows = input.orWindows ?? DEFAULT_WINDOWS; const ibWindow = input.ibWindow ?? 60;
    if (!Array.isArray(orWindows) || orWindows.length < 1 || orWindows.length > MARKET_STATS_LIMITS.windows
        || new Set(orWindows).size !== orWindows.length
        || [...orWindows, ibWindow].some(value => !Number.isSafeInteger(value) || value < 1 || value > MARKET_STATS_LIMITS.windowMinutes)) {
        invalid('Invalid opening-range or initial-balance windows.');
    }
    // The upstream compileCtxFor includes the derived initial-balance window too.
    return { orWindows: [...new Set([...orWindows, ibWindow])].sort((a, b) => a - b), ibWindow };
}

function parameterValue(spec: PresetParam, value: unknown): number | string {
    if (spec.type === 'number' || spec.type === 'duration') {
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) invalid(`Preset parameter '${spec.name}' must be a finite number.`);
        if (spec.type === 'duration' && (!Number.isSafeInteger(value) || value < 1 || value > MARKET_STATS_LIMITS.windowMinutes)) invalid('Preset durations must be whole minutes from 1 to 120.');
        if (spec.name === 'n' && (!Number.isSafeInteger(value) || value < 1)) invalid('The streak length must be a positive whole number.');
        if (['r', 'minGapPct', 'maxGapPct'].includes(spec.name) && value < 0) invalid(`Preset parameter '${spec.name}' cannot be negative.`);
        return value;
    }
    if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) invalid(`Preset parameter '${spec.name}' must be a bounded string.`);
    if (spec.type === 'enum' && !spec.values?.includes(value)) invalid(`Invalid value for preset parameter '${spec.name}'.`);
    return value;
}

function availability(preset: Preset, events: readonly EventFile[]) {
    const requirements = eventRequirements(parseDsl(composePresetDsl(preset, {}).dsl));
    const requiredEvents = [...new Set(requirements.map(requirement => requirement.event))];
    const available = requiredEvents.every(name => events.some(file => file.event === name));
    return { available, requires: requirements.length ? ['local-events'] : [], requiredEvents,
        coverage: eventCoverage(events)?.calendars.filter(file => requiredEvents.includes(file.event)) ?? [],
        ...(!available ? { reason: 'An explicit supplied local event calendar is required for each named event; uncovered dates and unknown trading neighbors are excluded.' } : {}),
    };
}

/** Same structural count as the pinned catalog generator; these are not separate reports. */
function namedVariants(preset: Preset): number {
    return 1 + preset.params.reduce((sum, param) => sum + (param.type === 'enum' ? param.values?.length ?? 0 : 0), 0)
        + (fields.find(field => field.name === preset.groupBy)?.enumValues?.length ?? 0);
}

/** Serializable metadata; no native store, file reads or market data are needed. */
export function getStatsPresetCatalog(context: StatsPresetContext = {}) {
    const compileContext = contextFor(context); const events = snapshotEventCalendars(context.events);
    return structuredClone({
        source: MARKET_STATS_SOURCE, total: presets.length, namedVariants: presets.reduce((sum, preset) => sum + namedVariants(preset), 0),
        categories: Object.entries(categoryTitles).map(([id, title]) => ({ id, title, count: presets.filter(preset => preset.category === id).length })),
        presets: presets.map(preset => ({ ...preset, namedVariants: namedVariants(preset), availability: availability(preset, events),
            groupByValues: fields.find(field => field.name === preset.groupBy)?.enumValues ?? [],
            defaultDsl: composePresetDsl(preset, {}).dsl,
            library: preset.library.map(reference => ({ ...reference, url: `https://www.luxalgo.com/library/${reference.kind}/${reference.slug}/` })),
        })),
        groupableFields, orWindows: compileContext.orWindows, events: eventCoverage(events),
        limits: { dslLength: MARKET_STATS_LIMITS.dslLength, windows: MARKET_STATS_LIMITS.windows, windowMinutes: MARKET_STATS_LIMITS.windowMinutes },
    });
}

/** Compose through the official API, then validate against the caller's actual derived windows. */
export function buildPreset(input: unknown, context: StatsPresetContext = {}): BuiltStatsPreset {
    const value = object(input, 'A statistics preset request must be an object.');
    knownKeys(value, ['id', 'params', 'groupBy']);
    if (typeof value.id !== 'string' || value.id.length > 80) invalid('A known statistics preset id is required.');
    const preset = byId.get(value.id);
    if (!preset) invalid('Unknown statistics preset id.');
    const supplied = value.params === undefined ? {} : object(value.params, 'Preset parameters must be an object.');
    knownKeys(supplied, preset.params.map(spec => spec.name));
    const params: Record<string, number | string> = {};
    for (const spec of preset.params) {
        const parameter = Object.hasOwn(supplied, spec.name) ? supplied[spec.name] : spec.default;
        if (parameter !== undefined) params[spec.name] = parameterValue(spec, parameter);
        else if (Object.hasOwn(supplied, spec.name)) invalid(`Preset parameter '${spec.name}' is missing its value.`);
    }
    for (const [minimum, maximum] of [['minGapPct', 'maxGapPct'], ['minOpenPos', 'maxOpenPos']]) {
        const low = params[minimum!]; const high = params[maximum!];
        if (typeof low === 'number' && typeof high === 'number' && low > high) invalid('A preset minimum cannot exceed its maximum.');
    }
    const groupBy = value.groupBy === undefined ? preset.groupBy : value.groupBy;
    if (groupBy !== undefined && (typeof groupBy !== 'string' || !groupableFields.includes(groupBy))) invalid('The selected field cannot group market statistics.');
    const compileContext = contextFor(context);
    const events = snapshotEventCalendars(context.events);
    try {
        const composed = composePresetDsl(preset, params);
        if (composed.dsl.length > MARKET_STATS_LIMITS.dslLength) invalid('The statistics preset query is too long.');
        const ast = parseDsl(composed.dsl);
        compileQuery(ast, compileContext);
        requireEventCalendars(eventRequirements(ast), events);
        return { dsl: composed.dsl, ...(groupBy ? { groupBy } : {}),
            preset: { id: preset.id, version: preset.version, title: preset.title, params: composed.resolved } };
    } catch (error) {
        if (error instanceof MarketStatsError) throw error;
        throw new MarketStatsError('INVALID_QUERY', error instanceof Error ? error.message : 'Invalid statistics preset query.');
    }
}
