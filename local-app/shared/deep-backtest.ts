import type { SymbolInfo } from '../../src/plugin';
import type { Bar } from './types';

export interface DeepSourceDataset { id: string; checksum: string }
/** Immutable primary data provenance. The checksum covers primary output bars only. */
export interface DeepHistoryManifest {
    mode: 'deep'; requestedFrom: number; requestedTo: number; barCount: number;
    sourceDatasets: DeepSourceDataset[]; checksum: string;
    secondarySourceDatasets?: DeepSourceDataset[];
}
/** UTC milliseconds, from inclusive and to exclusive. */
export interface DeepHistoryRequest { datasetId: string; timeframe: string; from: number; to: number }
export interface DeepHistoryResponse {
    bars: Bar[]; symbolInfo: SymbolInfo; timeframe: string; intervalMs: number; baseIntervalMs: number;
    from: number; to: number; cursorTime: number; hasMore: false; scopeId: string; history: DeepHistoryManifest;
}
/** Range fields select inclusive output bucket labels; cutoff is the primary source open. */
export interface DeepSeriesRequest { symbol: string; timeframe: string; cutoff: number; from?: number; to?: number; limit?: number }
export interface DeepSeriesResponse {
    bars: Bar[]; symbolInfo: SymbolInfo; timeframe: string; intervalMs: number; baseIntervalMs: number;
    cursorTime: number | null; hasMore: boolean; sourceDatasets: DeepSourceDataset[];
}
