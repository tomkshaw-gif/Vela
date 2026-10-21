import { describe, expect, it } from 'vitest';
import { timeframeToMs } from '../src/data/timeframe';
import { parseTimeframe } from '../src/widget/timeframe';

describe('local replay source-bar durations', () => {
    it.each([['1S', 1000], ['5s', 5000], ['15S', 15000]])('keeps %s aligned with the picker', (value, expected) => {
        const canonical = parseTimeframe(String(value)).canonical!;
        expect(timeframeToMs(canonical)).toBe(expected);
    });
    it('preserves existing minute and named-period meanings', () => {
        expect(timeframeToMs('1')).toBe(60_000);
        expect(timeframeToMs('60')).toBe(3_600_000);
        expect(timeframeToMs('D')).toBe(86_400_000);
        expect(timeframeToMs('M')).toBe(2_592_000_000);
    });
    it('does not accept invalid or unbounded second durations', () => {
        expect(timeframeToMs('0S')).toBe(3_600_000);
        expect(timeframeToMs('-1S')).toBe(3_600_000);
        expect(timeframeToMs('999999999999999999S')).toBe(3_600_000);
    });
});
