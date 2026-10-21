import type { DatasetMeta } from '../shared/types';

export type HistorySymbol = 'NQ.v.0' | 'GC.v.0';
export interface HistoryRequest { symbols: HistorySymbol[]; start: string; end: string }
export interface HistoryScope { dataset: 'GLBX.MDP3'; symbols: HistorySymbol; schema: 'ohlcv-1m'; stype_in: 'continuous'; start: string; end: string }
export interface HistoryChunk {
    key: string; request: HistoryScope; state: 'pending' | 'complete'; rows: number;
    rawSha256: string | null; normalizedSha256: string | null; mappingSha256?: string | null; quotedAt: string | null; costUsd?: 0;
    firstTime: number | null; lastTime: number | null;
}
export interface HistoryMapping { instrumentId: string; contract: string; start: number; end: number }
export interface HistoryJobSummary {
    jobId: string; request: HistoryRequest; state: 'planned' | 'running' | 'cancelled' | 'failed' | 'ready';
    completedChunks: number; totalChunks: number; rows: number; chunks: HistoryChunk[];
    updatedAt: string; error: { code: string; message: string } | null;
}
export interface HistoryManifest extends HistoryJobSummary { format: 1; requestSha256: string }
export interface HistoryController {
    list(): HistoryJobSummary[];
    plan(input: unknown): HistoryJobSummary;
    status(jobId: string): HistoryJobSummary;
    run(jobId: string, options?: { signal?: AbortSignal }): Promise<HistoryJobSummary>;
    cancel(jobId: string): void;
    dispose(): Promise<void>;
    importDataset(store: import('./store').ReplayStore, jobId: string, symbol: HistorySymbol, options?: { signal?: AbortSignal }): Promise<DatasetMeta>;
}
