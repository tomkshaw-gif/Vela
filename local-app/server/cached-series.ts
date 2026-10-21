import type { SymbolInfo } from '../../src/plugin';
import type { ChartView, DatasetMeta } from '../shared/types';
import { nextTimeframeBucket, parseTimeframe, timeframeBucket, timeframeSupported } from '../shared/timeframes';
import { replaySymbolInfo as cachedSymbolInfo } from '../shared/symbol-info';
import { MAX_BARS } from './data';
import { AppError } from './errors';
import type { ReplayStore } from './store';
import { parseCachedTicker, transformCachedBars } from './series-ticker';

export interface CachedSeriesRequest {
    symbol: string;
    timeframe: string;
    cutoff: number;
    /** Trusted primary source duration; cutoff identifies that source bar's open. */
    sourceIntervalMs: number;
    from?: number;
    to?: number;
    limit?: number;
}

export interface CachedSeriesView extends ChartView {
    datasetId: string;
    checksum: string;
    sourceDatasets: { id: string; checksum: string }[];
    symbol: string;
    symbolInfo: SymbolInfo;
}

function time(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new AppError(400, `Invalid cached series ${label}.`);
    return value;
}

export { cachedSymbolInfo };

/** Resolve an exact local contract at a fixed global clock; it cannot download data. */
export function cachedSeries(store: ReplayStore, request: CachedSeriesRequest): CachedSeriesView {
    const ticker = parseCachedTicker(request.symbol);
    const symbol = ticker.symbol;
    const period = parseTimeframe(request.timeframe);
    if (!period) throw new AppError(400, 'Invalid cached series timeframe.');
    const cutoff = time(request.cutoff, 'cutoff');
    if (![1000, 60000].includes(request.sourceIntervalMs)) throw new AppError(400, 'Invalid primary source candle duration.');
    const availableUntil = cutoff + request.sourceIntervalMs;
    const from = request.from === undefined ? undefined : time(request.from, 'start');
    const to = request.to === undefined ? undefined : time(request.to, 'end');
    const limit = request.limit ?? MAX_BARS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BARS) throw new AppError(400, `Cached series limit must contain 1–${MAX_BARS} bars.`);
    if (from !== undefined && to !== undefined && from > to) throw new AppError(400, 'Cached series start must precede its end.');
    const matches = store.listDatasets().filter((dataset) => dataset.symbol === symbol);
    if (matches.length === 0) throw new AppError(404, `No ${symbol} dataset is cached. Import its exact contract data first.`, 'SERIES_NOT_CACHED');
    const compatible = matches.filter((dataset) => timeframeSupported(request.timeframe, dataset.schema)
        && (period.intervalMs === null || period.intervalMs % dataset.intervalMs === 0));
    if (compatible.length === 0) throw new AppError(400, `Cached ${symbol} data cannot provide the requested timeframe. Import a finer source interval.`, 'SERIES_RESOLUTION_UNAVAILABLE');
    const firstBucket = ticker.modifier ? Math.min(...compatible.filter((dataset) => dataset.start < availableUntil).map((dataset) => dataset.start))
        : from === undefined ? to === undefined ? undefined : timeframeBucket(to, period)
        : timeframeBucket(from, period) === from ? from : nextTimeframeBucket(timeframeBucket(from, period), period);
    const lastSourceTime = ticker.modifier ? availableUntil - 1 : Math.min(availableUntil - 1, to === undefined ? availableUntil - 1 : nextTimeframeBucket(timeframeBucket(to, period), period) - 1);
    const coverage = (dataset: DatasetMeta): number => {
        if (firstBucket === undefined) return 0;
        if (dataset.start <= firstBucket && dataset.end > lastSourceTime) return 2;
        return dataset.start <= lastSourceTime && dataset.end > firstBucket ? 1 : 0;
    };
    const candidates = compatible.filter((dataset) => dataset.start < availableUntil)
        .sort((left, right) => Number(right.start + right.intervalMs <= availableUntil) - Number(left.start + left.intervalMs <= availableUntil)
            || coverage(right) - coverage(left) || left.intervalMs - right.intervalMs
            || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    const dataset = candidates[0];
    if (!dataset) throw new AppError(404, `No ${symbol} candles are cached at or before this replay date.`, 'SERIES_NOT_CACHED');
    const cursor = store.db.prepare('SELECT idx,time FROM bars WHERE dataset_id=? AND time<=? ORDER BY time DESC LIMIT 1')
        .get(dataset.id, availableUntil - dataset.intervalMs) as { idx: number; time: number } | undefined;
    // A bar-open window must not truncate the source candles inside its last bucket.
    const filtered = from !== undefined || to !== undefined;
    const result = store.chart(dataset.id, cursor?.idx ?? -1, period.native, period, filtered || ticker.modifier ? MAX_BARS : limit, ticker.modifier ? undefined : from);
    const derived = transformCachedBars(result.bars, ticker.modifier);
    const window = derived.filter((bar) => (from === undefined || bar.time >= from) && (to === undefined || bar.time <= to));
    return { ...result, bars: window.slice(-limit), hasMore: result.hasMore || window.length > limit,
        cursorTime: cursor?.time ?? null, datasetId: dataset.id, checksum: dataset.checksum,
        sourceDatasets: [{ id: dataset.id, checksum: dataset.checksum }], symbol, symbolInfo: cachedSymbolInfo(dataset) };
}
