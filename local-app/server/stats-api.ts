import { describeRegistry } from '@luxalgo/edge-stats/registry';
import type { MarketStatsCatalog, MarketStatsPageResponse, MarketStatsRequest, MarketStatsSelection } from '../shared/market-stats';
import type { Bar } from '../shared/types';
import { MARKET_STATS_LIMITS, MarketStatsError } from './market-stats';
import type { createMarketStatsService, MarketStatsInput } from './market-stats';
import { AppError, requireObject } from './errors';
import type { ReplayStore } from './store';
import type { createStatsArtifactService, StatsArtifactOperation, StatsArtifactResponse } from './market-stats/artifacts';
import { eventCalendars } from '@luxalgo/edge-stats/calendar-data';

type Service = Pick<ReturnType<typeof createMarketStatsService>, 'run' | 'dispose'>;
const GUID = /^[a-f0-9-]{36}$/;
const EVENT_NAMES = new Set(['eventDay', 'dayBeforeEvent', 'dayAfterEvent', 'eventOccurs']);

export class MarketStatsController {
    private active = false;
    constructor(private readonly store: ReplayStore, private readonly service: Service,
        private readonly artifacts?: ReturnType<typeof createStatsArtifactService>) {}

    catalog(): MarketStatsCatalog {
        return { datasets: this.store.listDatasets(), sessions: this.store.sessions(),
            registry: describeRegistry().map(entry => EVENT_NAMES.has(entry.name)
                ? { ...entry, doc: `${entry.doc} Requires the explicit bundled event-calendar selection and verified date coverage.` } : entry),
            eventCalendars: eventCalendars.map(({ event, version, coverage, notes }) => ({ event, version, coverage: { ...coverage }, ...(notes ? { notes } : {}) })),
            limits: { bars: MARKET_STATS_LIMITS.bars, spanMs: MARKET_STATS_LIMITS.spanMs,
                sessions: MARKET_STATS_LIMITS.sessions, groups: MARKET_STATS_LIMITS.groups } };
    }

    run(raw: unknown, signal?: AbortSignal): Promise<MarketStatsPageResponse> {
        return this.execute(raw, signal, input => this.service.run(input, { signal }));
    }
    artifact(raw: unknown, operation: StatsArtifactOperation, signal?: AbortSignal): Promise<StatsArtifactResponse & { selection: MarketStatsSelection }> {
        return this.execute(raw, signal, input => {
            if (!this.artifacts) throw new MarketStatsError('UNSUPPORTED_INPUT', 'Statistics inspection is unavailable.');
            return this.artifacts.run(input, operation, { signal });
        });
    }
    private async execute<T extends object>(raw: unknown, signal: AbortSignal | undefined, work: (input: MarketStatsInput) => Promise<T>): Promise<T & { selection: MarketStatsSelection }> {
        if (this.active) throw new AppError(409, 'Another market statistics operation is running.', 'BUSY');
        const obj = requireObject(raw);
        if (Object.keys(obj).some(key => !['datasetId', 'sourceMode', 'from', 'until', 'replay', 'session', 'calendar', 'query', 'eventCalendar'].includes(key))
            || typeof obj.datasetId !== 'string' || !GUID.test(obj.datasetId) || obj.sourceMode !== 'cache' && obj.sourceMode !== 'replay') {
            throw new AppError(400, 'Choose a cached dataset and an explicit statistics source.');
        }
        const input = obj as unknown as MarketStatsRequest;
        if (input.eventCalendar !== undefined && input.eventCalendar !== 'bundled') throw new AppError(400, 'Choose the explicit bundled event calendar or leave events disabled.');
        const dataset = this.store.dataset(input.datasetId);
        if (dataset.intervalMs !== 60_000 || dataset.schema !== 'ohlcv-1m') throw new AppError(400, 'Market Stats requires one-minute cached bars.');
        if (!Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.until) || input.from % 60_000 !== 0 || input.until % 60_000 !== 0
            || input.from < dataset.start || input.until > dataset.end || input.until <= input.from
            || input.until - input.from > MARKET_STATS_LIMITS.spanMs) throw new AppError(400, 'Choose an aligned interval inside the cached dataset range.');
        if (input.calendar !== null && (typeof input.calendar !== 'object' || Array.isArray(input.calendar))) throw new AppError(400, 'Choose schedule-only mode or provide a holiday calendar.');
        let maximumCursor = dataset.barCount - 1;
        const selection: MarketStatsSelection = { datasetId: dataset.id, name: dataset.name, symbol: dataset.symbol, checksum: dataset.checksum,
            sourceMode: input.sourceMode, from: input.from, until: input.until, ...(input.eventCalendar ? { eventCalendar: input.eventCalendar } : {}) };
        if (input.sourceMode === 'replay') {
            const pin = requireObject(input.replay);
            if (Object.keys(pin).some(key => !['id', 'revision'].includes(key)) || typeof pin.id !== 'string' || !GUID.test(pin.id)
                || !Number.isSafeInteger(pin.revision)) throw new AppError(400, 'Choose a saved replay snapshot.');
            const replay = this.store.session(pin.id);
            if (replay.config.datasetId !== dataset.id) throw new AppError(400, 'The replay belongs to a different dataset.');
            if (replay.revision !== pin.revision) throw new AppError(409, 'The replay changed. Refresh the statistics sources before running again.', 'REVISION_CONFLICT');
            maximumCursor = Math.min(replay.cursor, (replay.config.endIndex ?? dataset.barCount) - 1);
            const current = this.store.db.prepare('SELECT time FROM bars WHERE dataset_id=? AND idx=?').get(dataset.id, maximumCursor) as { time: number } | undefined;
            selection.until = Math.min(selection.until, current ? current.time + 60_000 : dataset.start);
            selection.replay = { id: replay.id, revision: replay.revision, cursor: replay.cursor };
        } else if (input.replay !== undefined) throw new AppError(400, 'Cached-history queries cannot claim a replay snapshot.');
        const rows = this.store.db.prepare('SELECT time,open,high,low,close,volume,instrument_id,contract FROM bars WHERE dataset_id=? AND idx<=? AND time>=? AND time+60000<=? ORDER BY idx LIMIT ?')
            .all(dataset.id, maximumCursor, selection.from, selection.until, MARKET_STATS_LIMITS.bars + 1) as unknown as (Bar & { instrument_id: string | null; contract: string | null })[];
        const bars: Bar[] = rows.map(({ instrument_id, contract, ...bar }) => instrument_id !== null && contract !== null ? { ...bar, instrumentId: instrument_id, contract } : bar);
        if (bars.length > MARKET_STATS_LIMITS.bars) throw new AppError(413, 'This interval contains more than 250,000 bars. Choose a shorter date range.');
        if (signal?.aborted) throw new AppError(499, 'Statistics computation was cancelled.', 'ABORTED');
        this.active = true;
        try {
            const response = await work({ bars, symbol: dataset.symbol, assetClass: 'future', sourceIntervalMs: 60_000,
                revealedUntil: selection.until, session: input.session, calendar: input.calendar, query: input.query,
                ...(input.eventCalendar === 'bundled' ? { events: eventCalendars } : {}) });
            return { ...response, selection };
        } catch (error) {
            if (!(error instanceof MarketStatsError)) throw error;
            const status = error.code === 'BUSY' ? 409 : error.code === 'TIMEOUT' ? 408 : error.code === 'ABORTED' ? 499
                : ['ENGINE_FAILED', 'INVALID_RESULT'].includes(error.code) ? 500 : 400;
            throw new AppError(status, error.message, error.code);
        } finally { this.active = false; }
    }

    async dispose(): Promise<void> { await Promise.all([this.service.dispose(), this.artifacts?.dispose()]); }
}
