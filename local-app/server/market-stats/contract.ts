import type { BarRow, HolidayCalendar, QueryRequest, QueryResult, SymbolConfig } from '@luxalgo/edge-stats';
import type { Bar } from '../../shared/types';
import type { StatsArtifact, StatsArtifactOperation } from './artifacts';
import type { EventFile } from '@luxalgo/edge-stats/events';

export const MARKET_STATS_SOURCE = {
    repository: 'https://github.com/LuxAlgo/edge-stats',
    commit: 'a48259887962d0f67a27d2b0815e2df9a52efca5',
    version: '0.1.0',
} as const;

export const MARKET_STATS_LIMITS = {
    bars: 250_000, spanMs: 10 * 366 * 86_400_000, dslLength: 2_000,
    sessions: 100, groups: 100, windows: 12, windowMinutes: 120,
    defaultTimeoutMs: 30_000, maxTimeoutMs: 60_000, outputBytes: 512_000,
} as const;

export interface MarketStatsInput {
    bars: readonly Bar[];
    symbol: string;
    assetClass: 'equity' | 'future' | 'crypto' | 'forex';
    /** Only one-minute source bars are supported by this integration. */
    sourceIntervalMs: 60_000;
    /** Exclusive UTC epoch-ms boundary. A bar is usable only after its entire interval closes. */
    revealedUntil: number;
    session: { key: string; start: string; end: string; tz: string; overnight: boolean };
    /** Explicit null means schedule-only: holidays and early closes are not supplied. */
    calendar: HolidayCalendar | null;
    /** Explicit local data only; absent event names or uncovered dates are unknown. */
    events?: readonly EventFile[];
    orWindows?: number[];
    ibWindow?: number;
    query: { dsl: string; since?: string; until?: string; groupBy?: string; sessionsLimit?: number };
}

export interface MarketStatsCoverage {
    fingerprint: string;
    revealedUntil: number;
    inputBarCount: number;
    eligibleBarCount: number;
    excludedFutureBars: number;
    firstBarOpen: number | null;
    lastBarClose: number | null;
    calendarMode: 'provided' | 'schedule-only';
    events?: MarketStatsEventCoverage;
}

export interface MarketStatsEventCoverage {
    fingerprint: string;
    calendars: { event: string; version: string; coverage: { from: string; to: string }; dates: number; fingerprint: string }[];
}

/** Detached, validated request. The worker revalidates it before opening any store. */
export interface PreparedMarketStatsRequest {
    bars: (BarRow & { instrumentId?: string })[];
    symbol: SymbolConfig;
    query: QueryRequest;
    calendar: HolidayCalendar | null;
    events: EventFile[];
    coverage: MarketStatsCoverage;
    warnings: string[];
}

export interface MarketStatsResponse {
    source: typeof MARKET_STATS_SOURCE;
    coverage: MarketStatsCoverage;
    warnings: string[];
    result: QueryResult;
}

export type MarketStatsErrorCode = 'INVALID_INPUT' | 'UNSUPPORTED_INPUT' | 'INVALID_QUERY'
    | 'BUSY' | 'ABORTED' | 'TIMEOUT' | 'ENGINE_FAILED' | 'INVALID_RESULT';

export class MarketStatsError extends Error {
    constructor(readonly code: MarketStatsErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = 'MarketStatsError'; }
}

export interface MarketStatsJob {
    result: Promise<QueryResult>;
    /** Must stop computation, close native handles, and remove this job's scratch data. */
    dispose(): Promise<void>;
}
export type StartMarketStatsJob = (input: PreparedMarketStatsRequest) => MarketStatsJob;

export interface MarketStatsWorkerRequest {
    type: 'market-stats:run';
    input: PreparedMarketStatsRequest;
    dataDirectory: string;
    artifact?: StatsArtifactOperation;
}
export type MarketStatsWorkerMessage = { type: 'market-stats:result'; result: QueryResult | StatsArtifact }
    | { type: 'market-stats:error'; error: { code: MarketStatsErrorCode; message: string } };
