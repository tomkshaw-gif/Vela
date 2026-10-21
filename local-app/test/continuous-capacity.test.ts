import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { applyCommand, createSession } from '../engine';
import { ReplayStore } from '../server/store';
import { parseTimeframe } from '../shared/timeframes';
import { DEFAULT_RULES, type DatasetMeta } from '../shared/types';

it('advances one bar and fetches a chart window inside two million rows without loading history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vela-continuous-capacity-')); const store = new ReplayStore(directory);
    try {
        const start = Date.UTC(2020, 0, 2); const count = 2_000_000;
        const dataset = store.addDataset({ name: 'Capacity fixture', symbol: 'NQH0', schema: 'ohlcv-1m', source: 'csv', bars: [{ time: start, open: 100, high: 100, low: 100, close: 100, volume: 1 }] });
        store.db.prepare('UPDATE bars SET instrument_id=?,contract=? WHERE dataset_id=?').run('1', 'NQH0', dataset.id);
        store.db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
            INSERT INTO bars(dataset_id,idx,time,open,high,low,close,volume,instrument_id,contract)
            SELECT ?,i,?+i*60000,100,100,100,100,1,'1','NQH0' FROM n`).run(count - 1, dataset.id, start);
        const meta: DatasetMeta = { ...dataset, symbol: 'NQ.v.0', barCount: count, end: start + count * 60_000,
            continuous: { stypeIn: 'continuous', rollRule: 'volume', rank: 0, adjustment: 'none', rollPolicy: 'flatten-prior-close', requestedStart: new Date(start).toISOString(), requestedEnd: new Date(start + count * 60_000).toISOString(), manifestHash: '0'.repeat(64),
                segments: [{ startIndex: 0, endIndex: count, start, end: start + count * 60_000, instrumentId: '1', contract: 'NQH0' }] } };
        store.db.prepare('UPDATE datasets SET meta=? WHERE id=?').run(JSON.stringify(meta), meta.id);
        expect(() => store.readBars(meta.id)).toThrow(expect.objectContaining({ code: 'HISTORY_EXPORT_TOO_LARGE' }));
        const readAll = vi.spyOn(store, 'readBars').mockImplementation(() => { throw new Error('Full history read is forbidden.'); });
        const windows = vi.spyOn(store, 'readBarWindow');
        const config = { name: 'Middle of history', datasetId: meta.id, mode: 'practice' as const, initialBalance: 50_000,
            commissionPerContractSide: 2, slippageTicks: 0, spreadTicks: 0, startIndex: 1_000_000, rules: DEFAULT_RULES };
        const session = store.createSession(createSession(config, meta.instrument));
        const bars = store.commandBars(meta.id, session.cursor);
        const next = applyCommand(session, bars, { type: 'advance', count: 1 });
        expect(next.cursor).toBe(1_000_000); expect(next.executionVersion).toBe(3);
        expect(readAll).not.toHaveBeenCalled(); expect(windows.mock.calls.map(call => call[2])).toEqual([5002, 1]);
        expect(() => bars[1_500_000]).toThrow(/bounded/); expect(() => JSON.stringify(bars)).toThrow(expect.objectContaining({ code: 'HISTORY_EXPORT_TOO_LARGE' }));
        const chart = store.chart(meta.id, next.cursor, '1', parseTimeframe('1')!, 100);
        expect(chart.bars).toHaveLength(100); expect(chart.bars.at(-1)!.time).toBe(start + next.cursor * 60_000);
        expect(chart.hasMore).toBe(true); expect(store.resolveTime(meta.id, start + 1_234_567 * 60_000).index).toBe(1_234_567);
        expect(() => store.chart(meta.id, next.cursor, '5', parseTimeframe('5')!, 100)).toThrow(expect.objectContaining({ code: 'CONTINUOUS_TIMEFRAME_UNSUPPORTED' }));
        expect(() => store.db.prepare('UPDATE sessions SET state=? WHERE id=?').run(JSON.stringify({ ...next, executionVersion: 2 }), session.id)).toThrow(/newer application/);
    } finally {
        store.close(); const target = resolve(directory);
        if (dirname(target) !== resolve(tmpdir()) || !target.includes('vela-continuous-capacity-')) throw new Error('Unexpected capacity fixture path.');
        rmSync(target, { recursive: true, force: true });
    }
}, 60_000);
