import type { InputValue } from '../../src/plugin';
import type { ChartAgentTarget } from './chart-agent';
import type { Schema } from './types';
import { parseTimeframe, timeframeSupported } from './timeframes';

/** Limits shared by the detached analysis host and any tool schema that describes it. */
export const ANALYSIS_LIMITS = {
    scopeTtlMs: 300_000, maxScopes: 8, jobMs: 30_000, maxRunningJobs: 2, jobRetentionMs: 300_000, maxJobs: 32,
    sourceChars: 60_000, settingEntries: 64, settingText: 2_000, settingNumber: 1e12,
    warmupDefault: 5_000, warmupMax: 50_000, plotKeysDefault: 8, plotKeysMax: 16, variableKeysDefault: 16, variableKeysMax: 32,
    pointsDefault: 100, pointsMax: 500, totalPoints: 1_000, trades: 500, names: 200, warnings: 50, secondaryRequests: 64,
    responseBytes: 256 * 1024, maxTime: 4_102_444_800_000,
} as const;

export const PRIVATE_FIELD = /^(?:__proto__|constructor|prototype|api[_-]?key|authorization|cookie|password|secret|token|credentials?)$/i;

export interface AnalysisRegion {
    /** Inclusive bar-open bounds the model asked about; `to` is clamped to the loaded replay cursor. */
    from: number; to: number; requestedFrom: number; requestedTo: number; clamped: boolean;
    origin: 'visible' | 'range' | 'drawing'; drawingId?: string;
    /** Context only: price bounds never remove candles from a calculation. */
    priceLow?: number; priceHigh?: number;
}

export interface AnalysisClock {
    /** Open time of the last source candle revealed by the historical clock. Every request is pinned to it. */
    sourceCutoff: number;
    /** The moment the whole `sourceCutoff` candle has been observed (open + source interval). */
    availableUntil: number;
    sourceIntervalMs: number;
    label: string;
}

export interface AnalysisDatasetIdentity { id: string; checksum: string; symbol: string; schema: Schema; intervalMs: number }

export interface AnalysisScopeSummary {
    scopeId: string; target: ChartAgentTarget; createdAt: number; expiresAt: number;
    /** The loaded replay cursor at capture time; the region end was clamped to it. */
    cursorTime: number;
    region: AnalysisRegion; clock: AnalysisClock;
    chart: { symbol: string; timeframe: string; intervalMs: number | null };
    dataset: AnalysisDatasetIdentity;
}

export interface AnalysisEvaluateRequest {
    source: string;
    inputs: Record<string, InputValue>;
    properties: Record<string, InputValue>;
    /** Native resolution; defaults to the scope's chart timeframe. */
    timeframe: string;
    warmupBars: number;
    /** Undefined = the first {@link ANALYSIS_LIMITS.plotKeysDefault} plots in discovery order. */
    plotKeys?: string[];
    /** Undefined = the first {@link ANALYSIS_LIMITS.variableKeysDefault} variables that are not input echoes. */
    variableKeys?: string[];
    includeTrades: boolean;
    limit: number;
    pointsFrom: 'start' | 'end';
    includeSource: boolean;
}

export interface AnalysisPlotPoint { time: number; value: number | null }
export interface AnalysisPlotResult {
    key: string; total: number; returned: number; truncated: boolean;
    stats: { finite: number; min: number | null; max: number | null; first: number | null; last: number | null };
    points: AnalysisPlotPoint[];
}

export interface AnalysisTrade {
    id: string; side: 'long' | 'short'; qty: number; open: boolean;
    entry: { id: string; time: number; price: number; comment?: string };
    exit?: { id: string; time: number; price: number; comment?: string };
    pnl?: number; commission?: number; maxDrawdown?: number; maxRunup?: number;
}

export interface AnalysisResult {
    title: string; kind: 'indicator' | 'strategy';
    clock: AnalysisClock; region: AnalysisRegion;
    coverage: {
        timeframe: string; barsLoaded: number; firstBarTime: number | null; lastBarTime: number | null;
        barsInRegion: number; warmupBarsBeforeRegion: number; warmupBudget: number;
        /** False only when the warmup budget stopped before the region start although older history exists. */
        regionCovered: boolean; olderHistoryAvailable: boolean; datasetStartsAfterRegion: boolean;
    };
    outputs: { plots: { key: string; points: number }[]; variables: string[]; plotsOmitted: number; variablesOmitted: number };
    plots: AnalysisPlotResult[];
    variables: { asOfBarTime: number | null; values: Record<string, unknown> };
    strategy?: { includesWarmupBars: true; note: string; state: Record<string, unknown> };
    trades?: { total: number; inRegion: number; returned: number; truncated: boolean; items: AnalysisTrade[] };
    warnings: string[];
    settings: {
        timeframe: string; warmupBars: number; inputs: Record<string, InputValue>; properties: Record<string, InputValue>;
        sourceChars: number; sourceFingerprint: string; source?: string;
    };
    provenance: {
        dataset: AnalysisDatasetIdentity;
        primarySources: { id: string; checksum: string }[];
        secondary: { symbol: string; timeframe: string; bars: number; datasetId: string | null; checksum: string | null; sourceDatasets: { id: string; checksum: string }[] }[];
        partial: boolean; note: string;
    };
    /** The worker's own identity for the completed run, when the engine reports one. */
    computation?: { id: string; dataCutoff: number | null; bars: { revision: number; count: number; firstTime: number | null; lastTime: number | null } };
    /** Names of parts that were dropped or shortened to keep the response within its size limit. */
    trimmed: string[];
}

export type AnalysisJobState = 'running' | 'completed' | 'failed' | 'cancelled';
export interface AnalysisJobSummary {
    jobId: string; scopeId: string; state: AnalysisJobState;
    phase: 'compiling' | 'loading' | 'running' | 'collecting' | 'finished';
    createdAt: number; updatedAt: number; deadline: number; error?: string; result?: AnalysisResult;
}
export type AnalysisResultSummary = AnalysisJobSummary;

export interface AnalysisCaptureArgs { from?: number; to?: number; drawingId?: string }

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
    return value as Record<string, unknown>;
}

function allow(value: Record<string, unknown>, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported argument: ${key}.`);
}

function plain(value: unknown, label: string, max: number, empty = false): string {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.length) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        throw new Error(`${label} must be plain text of at most ${max} characters.`);
    }
    return value;
}

function whole(value: unknown, label: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}.`);
    return value;
}

export function sameTarget(left: ChartAgentTarget, right: ChartAgentTarget): boolean {
    return left.clientId === right.clientId && left.sessionId === right.sessionId && left.generation === right.generation && left.cellId === right.cellId;
}

export function copyTarget(target: ChartAgentTarget): ChartAgentTarget {
    return { clientId: target.clientId, sessionId: target.sessionId, generation: target.generation, ...(target.cellId === undefined ? {} : { cellId: target.cellId }) };
}

export function parseCaptureArgs(value: unknown): AnalysisCaptureArgs {
    const args = record(value ?? {}, 'Capture arguments');
    allow(args, ['from', 'to', 'drawingId']);
    if (args.drawingId !== undefined && (args.from !== undefined || args.to !== undefined)) throw new Error('Supply either a drawing id or an explicit range, not both.');
    if ((args.from === undefined) !== (args.to === undefined)) throw new Error('Supply both from and to, or neither.');
    const result: AnalysisCaptureArgs = {};
    if (args.drawingId !== undefined) result.drawingId = plain(args.drawingId, 'Drawing id', 128);
    if (args.from !== undefined) {
        result.from = whole(args.from, 'Range start', 0, ANALYSIS_LIMITS.maxTime);
        result.to = whole(args.to, 'Range end', 0, ANALYSIS_LIMITS.maxTime);
        if (result.from > result.to) throw new Error('The range start must not exceed its end.');
    }
    return result;
}

function settings(value: unknown, label: string): Record<string, InputValue> {
    const input = record(value ?? {}, label);
    const entries = Object.entries(input);
    if (entries.length > ANALYSIS_LIMITS.settingEntries) throw new Error(`At most ${ANALYSIS_LIMITS.settingEntries} ${label.toLowerCase()} may be supplied.`);
    const result: Record<string, InputValue> = Object.create(null) as Record<string, InputValue>;
    for (const [key, item] of entries) {
        if (!key.length || key.length > 100 || PRIVATE_FIELD.test(key)) throw new Error(`Invalid ${label.toLowerCase()} key.`);
        if (typeof item === 'boolean') result[key] = item;
        else if (typeof item === 'number') {
            if (!Number.isFinite(item) || Math.abs(item) > ANALYSIS_LIMITS.settingNumber) throw new Error(`${label} values must be finite numbers within ±${ANALYSIS_LIMITS.settingNumber}.`);
            result[key] = item;
        } else result[key] = plain(item, `${label} value`, ANALYSIS_LIMITS.settingText, true);
    }
    return result;
}

function names(value: unknown, label: string, max: number): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a list of at most ${max} names.`);
    const result = value.map((item) => plain(item, `${label} entry`, 100));
    if (new Set(result).size !== result.length) throw new Error(`${label} must not repeat a name.`);
    return result;
}

function flag(value: unknown, label: string, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
    return value;
}

export function parseEvaluateArgs(value: unknown, schema: Schema, chartTimeframe: string): AnalysisEvaluateRequest {
    const args = record(value, 'Evaluate arguments');
    allow(args, ['source', 'inputs', 'properties', 'timeframe', 'warmupBars', 'plotKeys', 'variableKeys', 'includeTrades', 'limit', 'pointsFrom', 'includeSource']);
    const source = plain(args.source, 'Pine source', ANALYSIS_LIMITS.sourceChars);
    if (!source.trim()) throw new Error('Pine source must not be empty.');
    let timeframe = chartTimeframe;
    if (args.timeframe !== undefined) {
        const next = plain(args.timeframe, 'Timeframe', 8);
        if (!timeframeSupported(next, schema)) throw new Error('This timeframe is not supported by the replay dataset.');
        timeframe = parseTimeframe(next)!.native;
    }
    const pointsFrom = args.pointsFrom ?? 'end';
    if (pointsFrom !== 'start' && pointsFrom !== 'end') throw new Error('pointsFrom must be start or end.');
    const plotKeys = names(args.plotKeys, 'plotKeys', ANALYSIS_LIMITS.plotKeysMax);
    const variableKeys = names(args.variableKeys, 'variableKeys', ANALYSIS_LIMITS.variableKeysMax);
    return {
        source, inputs: settings(args.inputs, 'Inputs'), properties: settings(args.properties, 'Properties'), timeframe,
        warmupBars: args.warmupBars === undefined ? ANALYSIS_LIMITS.warmupDefault : whole(args.warmupBars, 'warmupBars', 1, ANALYSIS_LIMITS.warmupMax),
        ...(plotKeys ? { plotKeys } : {}), ...(variableKeys ? { variableKeys } : {}),
        includeTrades: flag(args.includeTrades, 'includeTrades', false),
        limit: args.limit === undefined ? ANALYSIS_LIMITS.pointsDefault : whole(args.limit, 'limit', 1, ANALYSIS_LIMITS.pointsMax),
        pointsFrom, includeSource: flag(args.includeSource, 'includeSource', false),
    };
}

/** A short non-cryptographic identity for a source text; it lets two results be compared without echoing the source. */
export function sourceFingerprint(source: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index++) hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193) >>> 0;
    return `fnv1a:${hash.toString(16).padStart(8, '0')}:${source.length}`;
}

export interface SafeJsonLimits { depth: number; items: number; keys: number; text: number }
export const SAFE_VALUE: SafeJsonLimits = { depth: 4, items: 50, keys: 50, text: 500 };

/**
 * Copies a worker value into plain, bounded JSON: non-finite numbers become null, private-looking keys are dropped
 * and anything deeper or longer than the limits is shortened. `state.cut` reports whether anything was shortened.
 */
export function safeJson(value: unknown, limits: SafeJsonLimits = SAFE_VALUE, state: { cut: boolean } = { cut: false }, depth = 0): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') { if (value.length > limits.text) state.cut = true; return value.slice(0, limits.text); }
    if (typeof value !== 'object') return null;
    if (depth >= limits.depth) { state.cut = true; return null; }
    if (Array.isArray(value)) {
        if (value.length > limits.items) state.cut = true;
        return value.slice(0, limits.items).map((item) => safeJson(item, limits, state, depth + 1));
    }
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (PRIVATE_FIELD.test(key)) continue;
        if (count >= limits.keys) { state.cut = true; break; }
        count += 1;
        Object.defineProperty(result, key.slice(0, 100), { value: safeJson(item, limits, state, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return result;
}

export function byteLength(value: unknown): number {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : new TextEncoder().encode(serialized).byteLength;
}
