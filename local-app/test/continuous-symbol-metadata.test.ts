import { expect, it } from 'vitest';
import { replaySymbolInfo } from '../shared/symbol-info';
import { parseCachedTicker } from '../server/series-ticker';

it('reports the gold contract exchange and tick economics independently of equity futures', () => {
    expect(replaySymbolInfo({ symbol: 'GC.v.0', instrument: { root: 'GC', tickSize: 0.1, pointValue: 100 } }))
        .toMatchObject({ prefix: 'COMEX', root: 'GC', mintick: 0.1, pointvalue: 100, pricescale: 10 });
    expect(replaySymbolInfo({ symbol: 'NQ.v.0', instrument: { root: 'NQ', tickSize: 0.25, pointValue: 20 } }).prefix).toBe('CME');
});
it('roundtrips only the supported continuous cached ticker identities', () => {
    expect(parseCachedTicker('replay:NQ.v.0')).toEqual({ symbol: 'NQ.v.0', modifier: null });
    expect(parseCachedTicker('GC.v.0;heikinashi')).toEqual({ symbol: 'GC.v.0', modifier: 'heikinashi' });
    for (const ticker of ['NQ.v.1', 'NQ.c.0', 'ES.v.0', 'GC.v.0;adjusted', 'NQ.v.0/GC.v.0']) expect(() => parseCachedTicker(ticker)).toThrow();
});
