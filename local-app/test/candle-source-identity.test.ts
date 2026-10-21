import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { ReplayStore } from '../server/store';
import { parseTimeframe } from '../shared/timeframes';
import type { ContinuousProvenance } from '../shared/types';

describe('native candle source identity', () => {
    it('preserves each continuous contract identity in a bounded window across a roll', () => {
        const directory = mkdtempSync(join(tmpdir(), 'vela-candle-identity-'));
        const store = new ReplayStore(directory);
        try {
            const start = Date.UTC(2024, 2, 1);
            const dataset = store.addDataset({ name: 'Synthetic identity', symbol: 'NQH4', schema: 'ohlcv-1m', source: 'csv',
                bars: Array.from({ length: 3 }, (_, i) => ({ time: start + i * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 1 })) });
            const continuous: ContinuousProvenance = { stypeIn: 'continuous', rollRule: 'volume', rank: 0, adjustment: 'none', rollPolicy: 'flatten-prior-close',
                requestedStart: new Date(start).toISOString(), requestedEnd: new Date(dataset.end).toISOString(), manifestHash: 'a'.repeat(64),
                segments: [{ startIndex: 0, endIndex: 2, start, end: start + 2 * 60_000, instrumentId: '100', contract: 'NQH4' },
                    { startIndex: 2, endIndex: 3, start: start + 2 * 60_000, end: dataset.end, instrumentId: '200', contract: 'NQM4' }] };
            store.db.prepare('UPDATE datasets SET meta=? WHERE id=?').run(JSON.stringify({ ...dataset, symbol: 'NQ.v.0', continuous }), dataset.id);
            store.db.prepare('UPDATE bars SET instrument_id=?,contract=? WHERE dataset_id=? AND idx<?').run('100', 'NQH4', dataset.id, 2);
            store.db.prepare('UPDATE bars SET instrument_id=?,contract=? WHERE dataset_id=? AND idx=?').run('200', 'NQM4', dataset.id, 2);
            const full = vi.spyOn(store, 'readBars').mockImplementation(() => { throw new Error('Unbounded read'); });
            const result = store.chart(dataset.id, 2, '1m', parseTimeframe('1')!, 2);
            expect(result.hasMore).toBe(true);
            expect(result.bars.map(bar => [bar.time, bar.instrumentId, bar.contract])).toEqual([
                [start + 60_000, '100', 'NQH4'], [start + 120_000, '200', 'NQM4'],
            ]);
            expect(store.chart(dataset.id, 1, '1m', parseTimeframe('1')!, 2).bars.every(bar => bar.contract === 'NQH4')).toBe(true);
            expect(full).not.toHaveBeenCalled();
        } finally {
            store.close();
            const target = realpathSync(directory), parent = realpathSync(tmpdir());
            if (dirname(target) !== parent || !target.startsWith(join(parent, 'vela-candle-identity-'))) throw new Error('Unexpected test directory');
            rmSync(target, { recursive: true, force: true });
        }
    });
});
