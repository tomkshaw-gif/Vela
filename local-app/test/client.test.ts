import { describe, expect, it, vi } from 'vitest';
import { blocksNativeMarketTyping, keyboardAction, linePath, MAX_BACKUP_BYTES, mergeBars, percent, serializeBackup } from '../client/util';
import { revealedWindow } from '../client/chart-data';
import { sessionMarks } from '../client/markers';
import { createSession } from '../engine/index';
import { DEFAULT_RULES, type Bar, type ChartView } from '../shared/types';
import type { LocalApi } from '../client/api';

const bar = (time: number, close = 100): Bar => ({ time, open: 100, high: Math.max(101, close), low: 99, close, volume: 1 });

describe('local replay client safeguards', () => {
    it('replaces a partial aggregate bucket and bounds visible history to 5,000 bars', () => {
        const previous = Array.from({ length: 5000 }, (_, index) => bar(index));
        const result = mergeBars(previous, [bar(4999, 102), bar(5000), bar(5001)]);
        expect(result).toHaveLength(5000);
        expect(result[0]!.time).toBe(2);
        expect(result.find((item) => item.time === 4999)?.close).toBe(102);
        expect(new Set(result.map((item) => item.time)).size).toBe(5000);
    });
    it('sorts incremental bars without inventing gaps or old prices', () => {
        expect(mergeBars([bar(1), bar(4)], [bar(4, 103), bar(9), bar(7)]).map(({ time, close }) => [time, close]))
            .toEqual([[1, 100], [4, 103], [7, 100], [9, 100]]);
    });
    it('refetches the latest bounded window when a 5,000-bar advance overflows the incremental answer', async () => {
        const response = (bars: Bar[], hasMore: boolean): ChartView => ({ bars, timeframe: '1m', intervalMs: 60_000, baseIntervalMs: 60_000, cursorTime: 5000, hasMore });
        const get = vi.fn().mockResolvedValueOnce(response(Array.from({ length: 5000 }, (_, index) => bar(index, index + 100)), true))
            .mockResolvedValueOnce(response(Array.from({ length: 5000 }, (_, index) => bar(index + 1, index + 101)), true));
        const result = await revealedWindow({ get } as unknown as Pick<LocalApi, 'get'>, 'session', '1', [bar(0)], new AbortController().signal);
        expect(get).toHaveBeenCalledTimes(2);
        expect(String(get.mock.calls[0]![0])).toContain('after=0');
        expect(String(get.mock.calls[1]![0])).not.toContain('after=');
        expect(result.bars).toHaveLength(5000);
        expect(result.bars[0]!.time).toBe(1);
        expect(result.bars.at(-1)).toEqual(bar(5000, 5100));
        expect(result.cursorTime).toBe(5000);
    });
    it('round-trips compact 250,000-bar backups within the server 64 MiB import limit', () => {
        const bars = Array.from({ length: 250_000 }, (_, index) => ({ time: 1_760_000_000_000 + index * 1000,
            open: 25000.25, high: 25010.5, low: 24999.75, close: 25002.25, volume: 1000 }));
        const backup = { version: 1, session: { name: 'Capacity test' }, dataset: { symbol: 'NQZ6' }, bars };
        expect(new TextEncoder().encode(JSON.stringify(backup, null, 2)).byteLength).toBeGreaterThan(32 * 1024 * 1024);
        const compact = serializeBackup(backup);
        expect(new TextEncoder().encode(compact).byteLength).toBeLessThan(MAX_BACKUP_BYTES);
        const restored = JSON.parse(compact) as { bars: Bar[] };
        expect(restored.bars).toHaveLength(250_000);
        expect(restored.bars.at(-1)).toEqual(bars.at(-1));
    });
    it('marks actual revealed executions and working orders without exposing future fills or outcomes', () => {
        const session = createSession({ name: 'Marker test', datasetId: 'test', mode: 'practice', initialBalance: 50000,
            commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES } },
        { root: 'NQ', tickSize: 0.25, pointValue: 20 }, 'marker-test');
        session.fills = [
            { id: 'revealed', orderId: 'order1', time: 100, side: 'buy', qty: 1, price: 25000, fees: 0, reason: 'entry' },
            { id: 'future', orderId: 'order2', time: 201, side: 'sell', qty: 1, price: 26000, fees: 0, reason: 'future secret outcome' },
        ];
        session.orders = [{ id: 'pending', status: 'working', createdTime: 200, side: 'sell', type: 'market', qty: 1 }];
        const marks = sessionMarks(session, 0, 200);
        expect(marks.map((mark) => mark.id)).toEqual(['fill-revealed', 'order-pending']);
        expect(marks.every((mark) => mark.time <= 200)).toBe(true);
        expect(JSON.stringify(marks)).not.toContain('future secret outcome');
        expect(JSON.stringify(marks)).toContain('No fill is implied');
    });
    it('ignores trading shortcuts while editing, in dialogs, or with a modifier', () => {
        const event = { key: 'b', code: 'KeyB', ctrlKey: false, metaKey: false, altKey: false };
        expect(keyboardAction(event, false)).toBe('buy');
        expect(keyboardAction(event, true)).toBeNull();
        expect(keyboardAction({ ...event, ctrlKey: true }, false)).toBeNull();
        expect(keyboardAction({ ...event, code: 'Space', key: ' ' }, false)).toBe('play');
        expect(keyboardAction({ ...event, code: 'ArrowRight', key: 'ArrowRight' }, false)).toBe('step');
    });
    it('blocks only native bare market typing and preserves editing, indicator and drawing shortcuts', () => {
        const event = { key: '2', ctrlKey: false, metaKey: false, altKey: false };
        expect(blocksNativeMarketTyping(event, false)).toBe(true);
        expect(blocksNativeMarketTyping({ ...event, key: 'N' }, false)).toBe(true);
        expect(blocksNativeMarketTyping(event, true)).toBe(false);
        expect(blocksNativeMarketTyping({ ...event, key: 't', altKey: true }, false)).toBe(false);
        expect(blocksNativeMarketTyping({ ...event, key: 'z', ctrlKey: true }, false)).toBe(false);
        expect(blocksNativeMarketTyping({ ...event, key: '/' }, false)).toBe(false);
        expect(blocksNativeMarketTyping({ ...event, key: '?' }, false)).toBe(false);
    });
    it('displays fraction-based statistics as percentages once', () => {
        expect(percent(0.5)).toBe('50%');
        expect(percent(1)).toBe('100%');
        expect(percent(null)).toBe('—');
    });
    it('draws flat and single-value equity curves with finite coordinates', () => {
        expect(linePath([50000, 50000, 50000])).not.toMatch(/NaN|Infinity/);
        expect(linePath([50000])).toBe('M0.00,102.00');
        expect(linePath([])).toBe('');
    });
});
