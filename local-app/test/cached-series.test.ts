import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bar, DatasetMeta, Schema } from '../shared/types';
import { cachedSeries as resolveCachedSeries, type CachedSeriesRequest } from '../server/cached-series';
import { ReplayStore } from '../server/store';
import { replaySymbolInfo } from '../shared/symbol-info';

const BASE = Date.UTC(2024, 3, 8);
function cachedSeries(store: ReplayStore, request: Omit<CachedSeriesRequest, 'sourceIntervalMs'> & { sourceIntervalMs?: number }) {
    return resolveCachedSeries(store, { sourceIntervalMs: 60000, ...request });
}
let directory: string;
let store: ReplayStore;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'vela-cached-series-')); store = new ReplayStore(directory); });
afterEach(() => {
    store.close();
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('vela-cached-series-')) throw new Error('Unexpected test directory.');
    rmSync(target, { recursive: true, force: true });
});
function add(symbol = 'NQM4', options: { times?: number[]; schema?: Schema; offset?: number; name?: string } = {}): DatasetMeta {
    const times = options.times ?? Array.from({ length: 120 }, (_, index) => BASE + index * 60_000);
    const offset = options.offset ?? 0;
    const bars: Bar[] = times.map((time, index) => ({ time, open: 100 + offset + index, high: 102 + offset + index,
        low: 99 + offset + index, close: 101 + offset + index, volume: 1 }));
    return store.addDataset({ name: options.name ?? `${symbol} source`, symbol, schema: options.schema ?? 'ohlcv-1m', source: 'csv', bars });
}
function createdAt(dataset: DatasetMeta, value: string): void {
    store.db.prepare('UPDATE datasets SET meta=? WHERE id=?').run(JSON.stringify({ ...dataset, createdAt: value }), dataset.id);
}

describe('cached-only secondary market series', () => {
    it('serves another exact cached contract with real futures metadata and no provider', () => {
        add(); const es = add('ESM4', { offset: 1000 });
        const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No provider calls allowed'));
        try {
            const result = cachedSeries(store, { symbol: 'CME:ESM4', timeframe: '60', cutoff: BASE + 49 * 60_000 });
            expect(result.datasetId).toBe(es.id);
            expect(result.sourceDatasets).toEqual([{ id: es.id, checksum: es.checksum }]);
            expect(result.checksum).toBe(es.checksum);
            expect(result.bars).toHaveLength(1);
            expect(result.bars[0]).toMatchObject({ time: BASE, open: 1100, high: 1151, low: 1099, close: 1150, volume: 50 });
            expect(result.cursorTime).toBe(BASE + 49 * 60_000);
            expect(result.symbolInfo).toMatchObject({ ticker: 'ESM4', type: 'futures', mintick: 0.25, pointvalue: 50, timezone: 'America/Chicago' });
            expect(result.symbolInfo).toEqual(replaySymbolInfo(es));
            expect(fetch).not.toHaveBeenCalled();
        } finally { fetch.mockRestore(); }
    });

    it('uses the source cutoff independently of a higher-timeframe bar-open end', () => {
        add();
        const result = cachedSeries(store, { symbol: 'replay:NQM4;heikinashi', timeframe: '60', cutoff: BASE + 109 * 60_000, to: BASE });
        expect(result.bars).toHaveLength(1);
        expect(result.bars[0]).toMatchObject({ time: BASE, open: 130, close: 130, high: 161, volume: 60 });
        expect(result.cursorTime).toBe(BASE + 109 * 60_000);
    });

    it('never includes unrevealed source prices inside a partially formed higher-timeframe bar', () => {
        add();
        const old = cachedSeries(store, { symbol: 'NQM4', timeframe: '60', cutoff: BASE + 49 * 60_000, to: BASE });
        const later = cachedSeries(store, { symbol: 'NQM4', timeframe: '60', cutoff: BASE + 59 * 60_000, to: BASE });
        expect(old.bars[0]?.close).toBe(150);
        expect(old.bars[0]?.volume).toBe(50);
        expect(later.bars[0]?.close).toBe(160);
        expect(later.bars[0]?.volume).toBe(60);
    });

    it('derives a higher-timeframe prefix before applying a secondary Heikin Ashi window', () => {
        add('ESM4');
        const full = cachedSeries(store, { symbol: 'ESM4;heikinashi', timeframe: '5', cutoff: BASE + 49 * 60_000 });
        const window = cachedSeries(store, { symbol: 'ESM4;heikinashi', timeframe: '5', cutoff: BASE + 49 * 60_000,
            from: BASE + 10 * 60_000, to: BASE + 35 * 60_000, limit: 3 });
        expect(window.bars).toEqual(full.bars.filter((bar) => bar.time >= BASE + 10 * 60_000 && bar.time <= BASE + 35 * 60_000).slice(-3));
        expect(full.bars[0]).toMatchObject({ open: 102.5, close: 102.5, high: 106, low: 99, volume: 5 });
        expect(window.cursorTime).toBe(BASE + 49 * 60_000);
    });

    it('keeps recursive secondary source selection stable across window bounds', () => {
        const complete = add('ESM4');
        const recent = add('ESM4', { schema: 'ohlcv-1s', times: Array.from({ length: 60 }, (_, index) => BASE + 90 * 60_000 + index * 1000), offset: 1000 });
        createdAt(recent, '2026-12-01T00:00:00.000Z');
        const full = cachedSeries(store, { symbol: 'ESM4;heikinashi', timeframe: '1', cutoff: BASE + 119 * 60_000 });
        const tail = cachedSeries(store, { symbol: 'ESM4;heikinashi', timeframe: '1', cutoff: BASE + 119 * 60_000,
            from: BASE + 90 * 60_000, to: BASE + 90 * 60_000 });
        expect(full.datasetId).toBe(complete.id);
        expect(tail.datasetId).toBe(complete.id);
        expect(tail.bars).toEqual(full.bars.filter((bar) => bar.time === BASE + 90 * 60_000));
    });

    it('selects the finest compatible source first and newest creation next', () => {
        add();
        const coarseNewest = add('NQM4', { offset: 1000 }); createdAt(coarseNewest, '2026-12-01T00:00:00.000Z');
        const seconds = Array.from({ length: 120 }, (_, index) => BASE + index * 1000);
        const fineOld = add('NQM4', { schema: 'ohlcv-1s', times: seconds, offset: 2000 }); createdAt(fineOld, '2026-01-01T00:00:00.000Z');
        const fineNew = add('NQM4', { schema: 'ohlcv-1s', times: seconds, offset: 3000 }); createdAt(fineNew, '2026-02-01T00:00:00.000Z');
        const result = cachedSeries(store, { symbol: 'NQM4', timeframe: '1', cutoff: BASE + 119_000 });
        expect(result.datasetId).toBe(fineNew.id);
        expect(result.baseIntervalMs).toBe(1000);
        expect(result.bars[0]?.open).toBe(3100);
    });

    it('prefers complete requested coverage over a finer cache which only holds recent data', () => {
        const complete = add();
        const times = Array.from({ length: 60 }, (_, index) => BASE + 90 * 60_000 + index * 1000);
        const recent = add('NQM4', { schema: 'ohlcv-1s', times, offset: 1000 }); createdAt(recent, '2026-12-01T00:00:00.000Z');
        const result = cachedSeries(store, { symbol: 'NQM4', timeframe: '5', cutoff: BASE + 119 * 60_000, from: BASE, to: BASE + 60 * 60_000 });
        expect(result.datasetId).toBe(complete.id);
        expect(result.bars[0]?.time).toBe(BASE);
        expect(result.bars.at(-1)?.time).toBe(BASE + 60 * 60_000);
    });

    it('prefers complete requested coverage over a finer cache which ends too early', () => {
        const complete = add();
        const prefix = add('NQM4', { schema: 'ohlcv-1s', times: Array.from({ length: 60 }, (_, index) => BASE + index * 1000), offset: 1000 });
        createdAt(prefix, '2026-12-01T00:00:00.000Z');
        const result = cachedSeries(store, { symbol: 'NQM4', timeframe: '1', cutoff: BASE + 119 * 60_000, from: BASE });
        expect(result.datasetId).toBe(complete.id);
        expect(result.bars).toHaveLength(120);
    });

    it('finds an older cached dataset which covers an older bar-open window', () => {
        const complete = add(); createdAt(complete, '2026-01-01T00:00:00.000Z');
        const recent = add('NQM4', { times: Array.from({ length: 30 }, (_, index) => BASE + (90 + index) * 60_000), offset: 1000 });
        createdAt(recent, '2026-12-01T00:00:00.000Z');
        const result = cachedSeries(store, { symbol: 'NQM4', timeframe: '60', cutoff: BASE + 119 * 60_000, to: BASE });
        expect(result.datasetId).toBe(complete.id);
        expect(result.bars).toHaveLength(1);
        expect(result.bars[0]?.close).toBe(160);
    });

    it('does not roll or alias exact contracts', () => {
        add();
        for (const symbol of ['NQ', 'NQ1!', 'NQM24', 'NQU4', 'MNQM4']) expect(() => cachedSeries(store, { symbol, timeframe: '1', cutoff: BASE })).toThrow();
    });

    it('reports unavailable timeframes rather than inventing lower-resolution candles', () => {
        add();
        for (const timeframe of ['1S', '15S', '90S']) expect(() => cachedSeries(store, { symbol: 'NQM4', timeframe, cutoff: BASE })).toThrow('finer source interval');
    });

    it('uses the final cached candle when the dataset ends before the pinned global clock', () => {
        add('ESM4', { times: [BASE, BASE + 60_000] });
        const result = cachedSeries(store, { symbol: 'ESM4', timeframe: '1', cutoff: BASE + 10 * 60_000 });
        expect(result.bars.map((bar) => bar.time)).toEqual([BASE, BASE + 60_000]);
        expect(result.cursorTime).toBe(BASE + 60_000);
    });

    it('resolves market gaps to the last actually cached candle', () => {
        add('ESM4', { times: [BASE, BASE + 60_000, BASE + 5 * 60_000] });
        const result = cachedSeries(store, { symbol: 'ESM4', timeframe: '1', cutoff: BASE + 3 * 60_000 });
        expect(result.bars.map((bar) => bar.time)).toEqual([BASE, BASE + 60_000]);
        expect(result.cursorTime).toBe(BASE + 60_000);
    });

    it('reports a cache which only starts in the future as unavailable', () => {
        add('ESM4', { times: [BASE + 60_000, BASE + 120_000] });
        expect(() => cachedSeries(store, { symbol: 'ESM4', timeframe: '1', cutoff: BASE })).toThrow('at or before');
    });

    it('filters bucket labels and selects the newest requested bars without truncating buckets', () => {
        add();
        const result = cachedSeries(store, { symbol: 'NQM4', timeframe: '5', cutoff: BASE + 119 * 60_000,
            from: BASE + 7 * 60_000, to: BASE + 25 * 60_000, limit: 2 });
        expect(result.bars.map((bar) => bar.time)).toEqual([BASE + 20 * 60_000, BASE + 25 * 60_000]);
        expect(result.bars.map((bar) => bar.volume)).toEqual([5, 5]);
        expect(result.bars[1]?.close).toBe(130);
        expect(result.hasMore).toBe(true);
    });

    it('returns ordinary calendar month and week aggregations', () => {
        add();
        expect(cachedSeries(store, { symbol: 'NQM4', timeframe: 'M', cutoff: BASE + 119 * 60_000 }).bars[0]?.time).toBe(Date.UTC(2024, 3, 1));
        expect(cachedSeries(store, { symbol: 'NQM4', timeframe: 'W', cutoff: BASE + 119 * 60_000 }).bars[0]?.time).toBe(BASE);
    });

    it('validates all history bounds before querying source bars', () => {
        add();
        for (const fields of [{ cutoff: -1 }, { cutoff: NaN }, { cutoff: BASE, from: -1 }, { cutoff: BASE, to: Infinity },
            { cutoff: BASE, from: BASE + 1, to: BASE }, { cutoff: BASE, limit: 0 }, { cutoff: BASE, limit: 250001 }]) {
            expect(() => cachedSeries(store, { symbol: 'NQM4', timeframe: '1', ...fields })).toThrow();
        }
    });
});
