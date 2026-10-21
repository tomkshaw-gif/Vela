import type { DeepHistoryManifest, DeepSourceDataset } from './deep-backtest';
/** Local Pine documents and reproducible strategy results. Times are UTC milliseconds. */
export interface ScriptSummary {
    id: string; name: string; revision: number; versions: number;
    createdAt: string; updatedAt: string; archived: boolean;
}
export interface ScriptDocument extends ScriptSummary { source: string }
export interface ScriptVersionSummary { scriptId: string; version: number; name: string; createdAt: string }
export interface ScriptVersion extends ScriptVersionSummary { source: string }
/** Omit id and expectedRevision to create a document. Existing documents require both. */
export interface SaveScriptInput { id?: string; expectedRevision?: number; name: string; source: string }
/** Dataset references reported by the client; this does not attest engine execution. */
export interface ReplayBacktestProvenance {
    version: 1; mode: 'replay'; reportedBy: 'client'; sessionId: string; cursor: number; cutoff: number;
    primarySourceDatasets: DeepSourceDataset[]; secondarySourceDatasets: DeepSourceDataset[];
}
export interface BacktestSnapshot {
    strategyId?: string; scriptVersion: number; source: string;
    symbol: string; timeframe: string; datasetId: string; datasetChecksum: string;
    from: number; to: number; inputs: Record<string, unknown>; properties: Record<string, unknown>;
    engine: Record<string, string>; result: Record<string, unknown>;
    history?: DeepHistoryManifest;
    provenance?: ReplayBacktestProvenance;
}
export interface BacktestSummary {
    id: string; name: string; createdAt: string; strategyId?: string; scriptVersion: number;
    symbol: string; timeframe: string; datasetId: string; datasetChecksum: string;
    from: number; to: number; engine: Record<string, string>;
    history?: DeepHistoryManifest;
    provenance?: ReplayBacktestProvenance;
}
export interface StoredBacktest extends BacktestSnapshot { id: string; name: string; createdAt: string }
