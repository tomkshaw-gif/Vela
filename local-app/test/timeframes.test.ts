import { describe, expect, it } from 'vitest';
import { nextTimeframeBucket, parseTimeframe, timeframeBucket, timeframeSupported, toServerTimeframe } from '../shared/timeframes';

describe('native and server timeframe resolutions', () => {
    it('normalizes standard and custom resolutions without confusing minutes and months', () => {
        for (const [input, native, server] of [['1', '1', '1m'], ['7', '7', '7m'], ['60', '60', '1h'], ['2h', '120', '2h'], ['3S', '3S', '3s'], ['15s', '15S', '15s'], ['D', 'D', '1d'], ['2D', '2D', '2d'], ['1w', 'W', '1w'], ['2W', '2W', '2w'], ['M', 'M', '1M'], ['3M', '3M', '3M'], ['1m', '1', '1m']]) {
            expect(parseTimeframe(input!), input).toMatchObject({ native, server }); expect(toServerTimeframe(input!)).toBe(server);
        }
        expect(parseTimeframe('M')!.intervalMs).toBeNull(); expect(parseTimeframe('1m')!.intervalMs).toBe(60000);
    });
    it('rejects unsupported syntax, ambiguous zero prefixes and unreasonable counts', () => {
        for (const input of ['', ' 1', '1 ', '01', '0', '0D', '-1', '1.5', '1H', '1month', '1d extra', '1000000', '86401S', '525601', '367D', '53W', '121M']) expect(parseTimeframe(input), input).toBeNull();
        expect(() => toServerTimeframe('bad')).toThrow('Invalid chart timeframe');
        expect(timeframeSupported('59S', 'ohlcv-1m')).toBe(false); expect(timeframeSupported('60S', 'ohlcv-1m')).toBe(true);
        expect(timeframeSupported('90S', 'ohlcv-1m')).toBe(false); expect(timeframeSupported('90S', 'ohlcv-1s')).toBe(true);
        expect(timeframeSupported('120S', 'ohlcv-1m')).toBe(true);
        expect(timeframeSupported('1S', 'ohlcv-1s')).toBe(true); expect(timeframeSupported('D', 'ohlcv-1m')).toBe(true);
    });
    it('aligns custom minutes, UTC days and Monday weeks idempotently', () => {
        const time = Date.UTC(2024, 3, 10, 12, 34, 56);
        expect(timeframeBucket(time, parseTimeframe('5')!)).toBe(Date.UTC(2024, 3, 10, 12, 30));
        expect(timeframeBucket(time, parseTimeframe('D')!)).toBe(Date.UTC(2024, 3, 10));
        expect(timeframeBucket(time, parseTimeframe('W')!)).toBe(Date.UTC(2024, 3, 8));
        expect(timeframeBucket(0, parseTimeframe('W')!)).toBe(Date.UTC(1969, 11, 29));
        for (const value of ['7', '3S', '2D', '2W', '3M']) { const period = parseTimeframe(value)!; const bucket = timeframeBucket(time, period); expect(timeframeBucket(bucket, period)).toBe(bucket); expect(nextTimeframeBucket(bucket, period)).toBeGreaterThan(time); }
    });
    it('advances real calendar months through leap years and year boundaries', () => {
        const month = parseTimeframe('M')!;
        const february = timeframeBucket(Date.UTC(2024, 1, 29, 23, 59), month); expect(february).toBe(Date.UTC(2024, 1, 1));
        expect(nextTimeframeBucket(february, month) - february).toBe(29 * 86400000);
        expect(nextTimeframeBucket(Date.UTC(2024, 11, 1), month)).toBe(Date.UTC(2025, 0, 1));
        expect(timeframeBucket(Date.UTC(2024, 4, 31), parseTimeframe('3M')!)).toBe(Date.UTC(2024, 3, 1));
        expect(nextTimeframeBucket(Date.UTC(2024, 0, 1), parseTimeframe('12M')!)).toBe(Date.UTC(2025, 0, 1));
        const lastMonth = timeframeBucket(8_640_000_000_000_000, month);
        expect(Number.isFinite(nextTimeframeBucket(lastMonth, month))).toBe(true);
        expect(nextTimeframeBucket(lastMonth, month) - lastMonth).toBe(30 * 86400000);
    });
});
