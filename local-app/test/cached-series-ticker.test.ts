import { describe, expect, it } from 'vitest';
import { parseCachedTicker, transformCachedBars } from '../server/series-ticker';

describe('cached extended ticker requests', () => {
    it('recognizes standard, derived and explicitly extended-session ticker identities', () => {
        expect(parseCachedTicker('replay:NQM4;heikinashi')).toEqual({ symbol: 'NQM4', modifier: 'heikinashi' });
        expect(parseCachedTicker('CME:NQM4;standard')).toEqual({ symbol: 'NQM4', modifier: null });
        expect(parseCachedTicker('={"session":"extended","symbol":"replay:NQM4"};heikinashi')).toEqual({ symbol: 'NQM4', modifier: 'heikinashi' });
    });

    it.each(['NQM4;renko', 'NQM4;kagi', 'NQM4;linebreak', 'NQM4;pointfigure', 'NQM4;unknown', 'NQM4;',
        '={"session":"regular","symbol":"NQM4"}', '={"adjustment":"splits","symbol":"NQM4"}',
        '={"settlement-as-close":true,"symbol":"NQM4"}', '={"symbol":"NQM4","session":"extended","extra":true}'])('rejects an unsupported modifier instead of returning ordinary candles: %s', (symbol) => {
        expect(() => parseCachedTicker(symbol)).toThrow();
    });

    it('computes actual recursive Heikin Ashi values without modifying raw bars', () => {
        const raw = [
            { time: 0, open: 190, high: 210, low: 180, close: 206, volume: 1 },
            { time: 60000, open: 206, high: 220, low: 200, close: 216, volume: 2 },
            { time: 120000, open: 216, high: 218, low: 180, close: 188, volume: 3 },
        ];
        expect(transformCachedBars(raw, 'heikinashi')).toEqual([
            { time: 0, open: 198, high: 210, low: 180, close: 196.5, volume: 1 },
            { time: 60000, open: 197.25, high: 220, low: 197.25, close: 210.5, volume: 2 },
            { time: 120000, open: 203.875, high: 218, low: 180, close: 200.5, volume: 3 },
        ]);
        expect(raw[0]?.close).toBe(206);
        expect(transformCachedBars(raw, null)).toBe(raw);
    });
});
