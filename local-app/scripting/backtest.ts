import type { ExecutionMarket, InputValue, OHLCV, StrategyState, StrategyTrade } from '../../src/plugin';
import { LocalPineEngine, PineRuntimeError, type LocalPineOptions } from './pine-runtime';

export interface PineBacktestProgress {
    phase: 'compiling' | 'running' | 'collecting' | 'done';
    bars: number;
}

export interface PineBacktestOptions {
    source: string;
    bars: readonly OHLCV[];
    market: ExecutionMarket;
    /** Source-candle cursor; pass it separately when bars are aggregated into larger buckets. */
    cutoff?: number;
    fetchSeriesAt?: LocalPineOptions['fetchSeriesAt'];
    signal?: AbortSignal;
    inputs?: Record<string, InputValue>;
    props?: Record<string, InputValue>;
    defaultProps?: Record<string, InputValue>;
    onProgress?: (progress: PineBacktestProgress) => void;
    workerUrl?: string;
    workerBudget?: LocalPineOptions['workerBudget'];
    createWorker?: LocalPineOptions['createWorker'];
    runTimeoutMs?: number;
}

export interface PineBacktestResult {
    title?: string;
    state: StrategyState;
    trades: StrategyTrade[];
    /** Present only when the runtime exposes an actual account-equity history. */
    equity?: { time: number; value: number }[];
    warnings: string[];
}

function snapshotBars(source: readonly OHLCV[]): OHLCV[] {
    if (source.length === 0 || source.length > 250_000) throw new PineRuntimeError('data', 'A backtest requires 1–250,000 cached candles.');
    let previous = -Infinity;
    return source.map((bar) => {
        if (!Number.isSafeInteger(bar.time) || bar.time < 0 || bar.time <= previous || ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)
            || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high
            || (bar.volume !== undefined && (!Number.isFinite(bar.volume) || bar.volume < 0))) throw new PineRuntimeError('data', 'Backtest candles must be valid, unique and ordered from oldest to newest.');
        previous = bar.time;
        return { ...bar };
    });
}

/** A standalone run of the official broker simulator; it never places a manual replay order. */
export async function runPineBacktest(options: PineBacktestOptions): Promise<PineBacktestResult> {
    if (options.signal?.aborted) throw new PineRuntimeError('cancelled', 'Backtest cancelled.');
    const metadata = options.market.symbolInfo;
    if (!metadata || typeof metadata.mintick !== 'number' || !Number.isFinite(metadata.mintick) || metadata.mintick <= 0
        || typeof metadata.pointvalue !== 'number' || !Number.isFinite(metadata.pointvalue) || metadata.pointvalue <= 0) {
        throw new PineRuntimeError('data', 'A strategy backtest requires the instrument tick size and point value.');
    }
    const bars = snapshotBars(options.bars);
    const cutoff = options.cutoff ?? bars.at(-1)!.time;
    if (!Number.isSafeInteger(cutoff) || cutoff < bars.at(-1)!.time) throw new PineRuntimeError('data', 'The backtest cursor must include its final candle.');
    const engine = new LocalPineEngine({ workerUrl: options.workerUrl ?? '/local-pine-worker.js', cutoff: () => cutoff,
        fetchSeriesAt: options.fetchSeriesAt, defaultProps: options.defaultProps, workerBudget: options.workerBudget,
        createWorker: options.createWorker, runTimeoutMs: options.runTimeoutMs ?? 120_000 });
    const cancel = (): void => engine.dispose();
    options.signal?.addEventListener('abort', cancel, { once: true });
    const progress = (phase: PineBacktestProgress['phase']): void => options.onProgress?.({ phase, bars: bars.length });
    try {
        progress('compiling');
        const prepared = await engine.prepare(options.source, `backtest-${crypto.randomUUID()}`);
        if (options.signal?.aborted) throw new PineRuntimeError('cancelled', 'Backtest cancelled.');
        progress('running');
        let resolveDone: () => void;
        let rejectDone: (error: unknown) => void;
        const hostWarnings: string[] = [];
        const completed = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
        const rejectOnCancel = (): void => rejectDone(new PineRuntimeError('cancelled', 'Backtest cancelled.'));
        options.signal?.addEventListener('abort', rejectOnCancel, { once: true });
        try {
            const session = engine.execute({ prepared, bars, market: options.market, inputs: options.inputs, props: options.props, mode: 'static' },
                { onModel: () => {}, onDone: () => resolveDone(), onError: (error) => rejectDone(error), onWarning: (warning) => hostWarnings.push(warning.message) });
            await completed;
            if (options.signal?.aborted) throw new PineRuntimeError('cancelled', 'Backtest cancelled.');
            progress('collecting');
            const snapshot = await session.getContext?.(['strategy', 'trades', 'warnings']);
            if (options.signal?.aborted) throw new PineRuntimeError('cancelled', 'Backtest cancelled.');
            if (!snapshot?.strategy) throw new PineRuntimeError('runtime', 'This script does not produce a strategy account. Start the script with strategy() to backtest it.');
            const trades = snapshot.trades ?? [];
            if (trades.length > 250_000) throw new PineRuntimeError('data', 'The strategy returned more than 250,000 trades. Choose a shorter backtest range.');
            const warnings = [...new Set([...hostWarnings, ...snapshot.warnings.slice(0, 200).map((warning) => warning.message.slice(0, 2_000))])];
            if (snapshot.warnings.length > 200) warnings.push(`${snapshot.warnings.length - 200} additional runtime warnings were omitted.`);
            warnings.push('The runtime exposes final account equity and trades, but does not expose a historical account-equity curve.');
            progress('done');
            return { title: prepared.meta.title, state: snapshot.strategy, trades, warnings };
        } finally { options.signal?.removeEventListener('abort', rejectOnCancel); }
    } finally {
        options.signal?.removeEventListener('abort', cancel);
        engine.dispose();
    }
}
