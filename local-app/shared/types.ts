/** Local Replay Studio: shared wire contracts. Times are UTC epoch milliseconds. */
export interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number }
export type Schema = 'ohlcv-1m' | 'ohlcv-1s';
export interface Instrument { root: string; tickSize: number; pointValue: number }
export const INSTRUMENTS: Instrument[] = [
    { root: 'NQ', tickSize: 0.25, pointValue: 20 }, { root: 'MNQ', tickSize: 0.25, pointValue: 2 },
    { root: 'ES', tickSize: 0.25, pointValue: 50 }, { root: 'MES', tickSize: 0.25, pointValue: 5 },
];
export interface DatasetMeta {
    id: string; name: string; symbol: string; schema: Schema; intervalMs: number;
    instrument: Instrument; barCount: number; start: number; end: number;
    source: 'databento' | 'csv' | 'demo'; createdAt: string; checksum: string;
}
export type Side = 'buy' | 'sell';
export interface PropRules {
    profitTargetUsd: number; maxDailyLossUsd: number; maxDrawdownUsd: number;
    drawdownType: 'static' | 'trailing-intraday' | 'trailing-eod';
    drawdownLocksAtInitialBalance: boolean; minTradingDays: number; maxContracts: number;
    consistencyPct: number | null; dayResetTimezone: string; dayResetHour: number;
    requireFlatToPass: boolean;
}
export const DEFAULT_RULES: PropRules = {
    profitTargetUsd: 3000, maxDailyLossUsd: 1000, maxDrawdownUsd: 2000,
    drawdownType: 'trailing-eod', drawdownLocksAtInitialBalance: true,
    minTradingDays: 5, maxContracts: 5, consistencyPct: null,
    dayResetTimezone: 'America/Chicago', dayResetHour: 17, requireFlatToPass: true,
};
export interface SessionConfig {
    name: string; datasetId: string; mode: 'practice' | 'prop'; initialBalance: number;
    commissionPerContractSide: number; slippageTicks: number; spreadTicks: number;
    startIndex: number;
    /** Exclusive source index; absent means the full cached dataset. */
    endIndex?: number; rules: PropRules;
}
/** Calendar bounds are resolved to source indices before a session is persisted. End times are exclusive. */
export type SessionCreateConfig = (
    (Omit<SessionConfig, 'endIndex'> & { startTime?: never }) |
    (Omit<SessionConfig, 'startIndex' | 'endIndex'> & { startTime: number; startIndex?: never })
) & ({ endIndex?: number; endTime?: never } | { endTime: number; endIndex?: never });
export interface SessionNavigation {
    currentIndex: number; currentTime: number | null; targetIndex: number; targetTime: number;
}
export interface TakeProfitLeg { id: string; price: number; qty: number }
export interface OrderDraft {
    side: Side; type: 'market' | 'limit' | 'stop'; qty: number;
    price?: number; stopLoss?: number; takeProfit?: number; takeProfits?: TakeProfitLeg[];
}
export interface Order extends OrderDraft {
    intent?: 'close' | 'reverse';
    id: string; status: 'working' | 'filled' | 'cancelled' | 'rejected';
    createdTime: number; filledTime?: number; fillPrice?: number; rejectReason?: string;
}
export interface Position {
    side: Side; qty: number; avgPrice: number; entryTime: number; entryFees: number;
    stopLoss?: number; takeProfit?: number; takeProfits?: TakeProfitLeg[]; initialRisk?: number; mae: number; mfe: number;
}
export interface Fill {
    id: string; orderId: string; time: number; side: Side; qty: number; price: number;
    fees: number; reason: string; takeProfitLegId?: string;
}
export interface Trade {
    id: string; side: Side; qty: number; entryTime: number; exitTime: number;
    entryPrice: number; exitPrice: number; grossPnl: number; fees: number; netPnl: number;
    reason: string; initialRisk?: number; mae: number; mfe: number; takeProfitLegId?: string;
}
export interface EquityPoint { time: number; balance: number; equity: number }
export interface DayStat {
    day: string; startBalance: number; realizedPnl: number; minEquity: number;
    endBalance: number; trades: number; traded: boolean;
}
export interface Account {
    balance: number; equity: number; unrealizedPnl: number; netPnl: number; fees: number;
    peakEquity: number; maxDrawdown: number;
}
export interface PropState {
    status: 'active' | 'passed' | 'failed'; reason: string | null;
    dailyLoss: number; drawdownFloor: number; trailingPeak: number;
    tradingDays: number; bestDayProfit: number; consistencyPct: number;
}
export interface Bookmark { id: string; time: number; label: string }
export interface Session {
    /** Absent for legacy executions; retained once target legs or their provenance are used. */
    executionVersion?: 2;
    id: string; config: SessionConfig; instrument: Instrument; cursor: number;
    status: 'paused' | 'completed' | 'passed' | 'failed'; revision: number;
    createdAt: string; updatedAt: string; account: Account; position: Position | null;
    orders: Order[]; fills: Fill[]; trades: Trade[]; equityCurve: EquityPoint[];
    days: DayStat[]; prop: PropState; bookmarks: Bookmark[]; layout: unknown;
}
export type Command =
    | { type: 'advance'; count: number }
    | { type: 'advanceTo'; time: number }
    | { type: 'place'; order: OrderDraft }
    | { type: 'cancel'; orderId: string }
    | { type: 'close'; qty?: number }
    | { type: 'reverse' }
    | { type: 'amend'; orderId?: string; price?: number; stopLoss?: number | null; takeProfit?: number | null; takeProfits?: TakeProfitLeg[] | null }
    | { type: 'bookmark'; label: string }
    | { type: 'layout'; layout: unknown }
    | { type: 'rename'; name: string };
export interface SessionSummary {
    id: string; name: string; datasetId: string; symbol: string; mode: 'practice' | 'prop';
    status: Session['status']; cursor: number; barCount: number; equity: number;
    netPnl: number; trades: number; updatedAt: string; revision: number;
    /** Effective selected range; barCount remains the full dataset count. Older saved summaries may omit these. */
    startIndex?: number; endIndex?: number; startTime?: number; endTime?: number;
}
export interface SessionView { session: Session; dataset: DatasetMeta }
export interface ChartView {
    bars: Bar[]; timeframe: string; intervalMs: number; baseIntervalMs: number;
    cursorTime: number | null; hasMore: boolean;
}
export interface Bootstrap {
    token: string; datasets: DatasetMeta[]; sessions: SessionSummary[];
    provider: { configured: boolean }; instruments: Instrument[]; dataDirectory: string;
}
export interface ProviderRequest {
    dataset: 'GLBX.MDP3'; symbol: string; schema: Schema; start: string; end: string;
}
export interface ProviderQuote {
    quoteId: string; estimatedCostUsd: number; maxCostUsd: 0; expiresAt: string;
    request: ProviderRequest;
}
export interface Analytics {
    /** winRate is a fraction in [0, 1]; null means there are no closed trades. */
    trades: number; wins: number; losses: number; winRate: number | null;
    netPnl: number; grossProfit: number; grossLoss: number; profitFactor: number | null;
    expectancy: number | null; avgWin: number; avgLoss: number; avgR: number | null;
    maxDrawdown: number; maxWinStreak: number; maxLossStreak: number;
    byDay: { day: string; pnl: number; trades: number }[];
    byHour: { hour: number; pnl: number; trades: number }[];
    equityCurve: EquityPoint[];
}
export interface MonteCarlo {
    /** Probability fields are fractions in [0, 1], not percent values. */
    runs: number; tradesPerRun: number; seed: number; medianFinalBalance: number;
    p05FinalBalance: number; p95FinalBalance: number; p95Drawdown: number;
    probabilityOfProfit: number; probabilityOfRuin: number;
    paths: { step: number; p05: number; median: number; p95: number }[];
}
