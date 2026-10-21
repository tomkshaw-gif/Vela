import type { RegistryEntryDescription } from '@luxalgo/edge-stats/registry';
import type { MarketStatsInput, MarketStatsResponse } from '../server/market-stats/contract';
import type { DatasetMeta, SessionSummary } from './types';

export interface MarketStatsRequest {
    datasetId: string;
    sourceMode: 'cache' | 'replay';
    from: number;
    until: number;
    replay?: { id: string; revision: number };
    session: MarketStatsInput['session'];
    calendar: MarketStatsInput['calendar'];
    eventCalendar?: 'bundled';
    query: MarketStatsInput['query'];
}
export interface MarketStatsSelection {
    datasetId: string; name: string; symbol: string; checksum: string;
    sourceMode: 'cache' | 'replay'; from: number; until: number;
    replay?: { id: string; revision: number; cursor: number };
    eventCalendar?: 'bundled';
}
export interface MarketStatsPageResponse extends MarketStatsResponse { selection: MarketStatsSelection }
export interface MarketStatsCatalog {
    datasets: DatasetMeta[]; sessions: SessionSummary[]; registry: RegistryEntryDescription[];
    limits: { bars: number; spanMs: number; sessions: number; groups: number };
    eventCalendars?: { event: string; version: string; coverage: { from: string; to: string }; notes?: string }[];
}
