import type { SymbolInfo } from '../../src/plugin';
import type { DatasetMeta } from './types';

/** Every supported local contract is a CME equity future, independent of its data source. */
export function replaySymbolInfo(dataset: Pick<DatasetMeta, 'symbol' | 'instrument'>): SymbolInfo {
    return { ticker: dataset.symbol, symbol: dataset.symbol, tickerid: `replay:${dataset.symbol}`, main_tickerid: `replay:${dataset.symbol}`,
        description: dataset.symbol, prefix: 'CME', root: dataset.instrument.root, type: 'futures', currency: 'USD',
        timezone: 'America/Chicago', session: 'extended', mintick: dataset.instrument.tickSize, minmove: 1,
        pointvalue: dataset.instrument.pointValue, pricescale: 1 / dataset.instrument.tickSize };
}
