import type { Vela } from '../../src/index';
import type {
    ContextSelect, EngineComputationIdentity, EngineContextSnapshot, ExecutionHandlers, ExecutionRequest, ExecutionSession,
    InputSchema, InputValue, OHLCV, PreparedScript, StrategyTrade,
} from '../../src/plugin';
import type { LocalPineOptions } from '../scripting/pine-runtime';
import type { ChartAgentTarget } from '../shared/chart-agent';
import {
    ANALYSIS_LIMITS, PRIVATE_FIELD, SAFE_VALUE, byteLength, copyTarget, parseCaptureArgs, parseEvaluateArgs, safeJson, sameTarget, sourceFingerprint,
    type AnalysisClock, type AnalysisDatasetIdentity, type AnalysisEvaluateRequest, type AnalysisJobSummary, type AnalysisPlotResult,
    type AnalysisRegion, type AnalysisResult, type AnalysisResultSummary, type AnalysisScopeSummary, type AnalysisTrade,
} from '../shared/chart-analysis';
import { replaySymbolInfo } from '../shared/symbol-info';
import { parseTimeframe, timeframeSupported, toServerTimeframe } from '../shared/timeframes';
import type { Instrument, SessionView } from '../shared/types';
import type { LocalApi } from './api';

/** The slice of the Pine runtime a detached analysis needs; `LocalPineEngine` satisfies it. */
export interface AnalysisEngine {
    prepare(source: string, instanceId: string, options?: { signal?: AbortSignal }): Promise<PreparedScript>;
    execute(request: ExecutionRequest, handlers: ExecutionHandlers): ExecutionSession;
    dispose(): void;
}

export interface ChartAnalysisOptions {
    api: Pick<LocalApi, 'get'>;
    /** Test seam. The default builds a `LocalPineEngine` that runs in the same-origin, no-network Pine worker. */
    createEngine?: (options: LocalPineOptions) => AnalysisEngine | Promise<AnalysisEngine>;
    now?: () => number;
}

export interface AnalysisCaptureInput {
    target: ChartAgentTarget;
    chart: Pick<Vela, 'market' | 'getVisibleRange' | 'drawings'>;
    view: SessionView;
    /** The loaded replay cursor (open time of the last revealed source candle). */
    cutoff: number;
    /** Throws when the session, cursor, chart cell or timeframe is no longer the one that was captured. */
    assertCurrent: () => void;
    signal?: AbortSignal;
}

export interface ChartAnalysis {
    capture(input: AnalysisCaptureInput, args?: unknown): Promise<AnalysisScopeSummary>;
    evaluate(target: ChartAgentTarget, scopeId: string, args: unknown): AnalysisJobSummary;
    readJob(target: ChartAgentTarget, jobId: string, args?: unknown): AnalysisResultSummary;
    cancelJob(target: ChartAgentTarget, jobId: string): AnalysisJobSummary;
    readScope(target: ChartAgentTarget, scopeId: string): AnalysisScopeSummary;
    dispose(): void;
}

interface Scope {
    summary: AnalysisScopeSummary;
    instrument: Instrument;
    assertCurrent: () => void;
}

interface SourceDataset { id: string; checksum: string }
interface SecondaryRecord { symbol: string; timeframe: string; bars: number; datasetId: string | null; checksum: string | null; sourceDatasets: SourceDataset[]; partial: boolean }

interface Job {
    id: string; scope: Scope; target: ChartAgentTarget; request: AnalysisEvaluateRequest;
    state: AnalysisJobSummary['state']; phase: AnalysisJobSummary['phase'];
    createdAt: number; updatedAt: number; deadline: number; error?: string; result?: AnalysisResult;
    controller: AbortController; timer?: ReturnType<typeof setTimeout>; engine?: AnalysisEngine;
    secondary: Map<string, SecondaryRecord>; secondaryRequests: number; warnings: string[]; primarySources: SourceDataset[];
}

interface SeriesReply { bars?: unknown; cursorTime?: unknown; hasMore?: unknown; baseIntervalMs?: unknown; datasetId?: unknown; checksum?: unknown; sourceDatasets?: unknown }

const CLOCK_LABEL = 'Candle open time. The candle opened at sourceCutoff is wholly observed by availableUntil; the clock makes no promise about prices inside that minute.';
const CLOCK_NOTE = 'Aggregated candles are labelled by their open time and are built only from source candles opened at or before sourceCutoff, so the last aggregated candle can be partial.';

/** The dataset content a reply was built from; replies without the list fall back to their single dataset id and checksum. */
function sourcesOf(reply: SeriesReply): SourceDataset[] {
    const listed = Array.isArray(reply.sourceDatasets) ? reply.sourceDatasets : [];
    if (listed.length > 256) throw new Error('The dataset provenance exceeds its limit. Use a smaller analysis.');
    const result = listed.map((item: unknown) => {
        const entry = item as Partial<SourceDataset> | null;
        if (!entry || typeof entry.id !== 'string' || !entry.id.length || entry.id.length > 128
            || typeof entry.checksum !== 'string' || !entry.checksum.length || entry.checksum.length > 128) throw new Error('The dataset provenance is incomplete or invalid.');
        return { id: entry.id, checksum: entry.checksum };
    });
    if (!result.length && typeof reply.datasetId === 'string' && typeof reply.checksum === 'string') result.push({ id: reply.datasetId.slice(0, 128), checksum: reply.checksum.slice(0, 128) });
    return result;
}

function plainMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500) || 'The analysis failed.';
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validBars(value: unknown, label: string, max: number, before: number, ascending: boolean): OHLCV[] {
    if (!Array.isArray(value) || value.length > max) throw new Error(`The ${label} reply did not contain a valid candle list.`);
    let previous = -Infinity;
    return value.map((item: unknown) => {
        const bar = item as Partial<OHLCV> | null;
        if (!bar || typeof bar !== 'object' || !Number.isSafeInteger(bar.time) || ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)
            || (bar.volume !== undefined && !Number.isFinite(bar.volume))) throw new Error(`The ${label} reply contained an invalid candle.`);
        const time = bar.time!;
        // Fail closed on an unmistakable leak; valid replies never open at or after the end of the observed source candle.
        if (time >= before) throw new Error(`The ${label} reply contained a candle beyond the pinned historical clock.`);
        if (ascending && time <= previous) throw new Error(`The ${label} reply was not ordered from oldest to newest.`);
        previous = time;
        return { time, open: bar.open!, high: bar.high!, low: bar.low!, close: bar.close!, ...(bar.volume === undefined ? {} : { volume: bar.volume }) };
    });
}

function checkValue(entry: InputSchema, value: InputValue, label: string): InputValue {
    const name = `${label} "${entry.key}"`;
    if (entry.type === 'bool') {
        if (typeof value !== 'boolean') throw new Error(`The ${name} requires true or false.`);
        return value;
    }
    if (entry.type === 'int' || entry.type === 'time' || entry.type === 'float' || entry.type === 'price') {
        if (typeof value !== 'number') throw new Error(`The ${name} requires a number.`);
        if ((entry.type === 'int' || entry.type === 'time') && !Number.isSafeInteger(value)) throw new Error(`The ${name} requires an integer.`);
        if ((entry.min !== undefined && value < entry.min) || (entry.max !== undefined && value > entry.max)) {
            throw new Error(`The ${name} must be within ${entry.min ?? '-∞'} and ${entry.max ?? '∞'}.`);
        }
        return value;
    }
    if (typeof value !== 'string') throw new Error(`The ${name} requires text.`);
    if (entry.options && !entry.options.includes(value)) throw new Error(`The ${name} must be one of: ${entry.options.slice(0, 20).join(', ')}.`);
    return value;
}

/** Maps supplied names (a schema key or an unambiguous title) onto schema keys; anything else is rejected, never ignored. */
function resolveSettings(supplied: Record<string, InputValue>, schema: readonly InputSchema[], label: 'input' | 'property'): Record<string, InputValue> {
    const result: Record<string, InputValue> = Object.create(null) as Record<string, InputValue>;
    for (const [name, value] of Object.entries(supplied)) {
        const byKey = schema.find((entry) => entry.key === name);
        const byTitle = byKey ? [] : schema.filter((entry) => entry.title === name);
        if (byTitle.length > 1) throw new Error(`The ${label} title "${name}" is ambiguous. Use its key.`);
        const entry = byKey ?? byTitle[0];
        if (!entry) {
            const valid = schema.slice(0, 40).map((item) => item.title && item.title !== item.key ? `${item.key} ("${item.title}")` : item.key);
            throw new Error(`Unknown ${label} "${name.slice(0, 100)}". Valid ${label}s: ${valid.length ? valid.join(', ') : 'none'}${schema.length > 40 ? ', …' : ''}.`);
        }
        if (Object.hasOwn(result, entry.key)) throw new Error(`The ${label} "${entry.key}" was supplied twice.`);
        result[entry.key] = checkValue(entry, value, label);
    }
    return result;
}

function tradeCopy(trade: StrategyTrade): AnalysisTrade | null {
    const entryTime = finite(trade.entry?.time); const entryPrice = finite(trade.entry?.price); const qty = finite(trade.qty);
    if (entryTime === null || entryPrice === null || qty === null || (trade.side !== 'long' && trade.side !== 'short')) return null;
    const leg = (fill: StrategyTrade['entry'] | undefined, time: number, price: number): AnalysisTrade['entry'] => ({
        id: String(fill?.id ?? '').slice(0, 100), time, price, ...(typeof fill?.comment === 'string' ? { comment: fill.comment.slice(0, 200) } : {}),
    });
    const exitTime = finite(trade.exit?.time); const exitPrice = finite(trade.exit?.price);
    const optional = { pnl: finite(trade.pnl), commission: finite(trade.commission), maxDrawdown: finite(trade.maxDrawdown), maxRunup: finite(trade.maxRunup) };
    return {
        id: String(trade.id).slice(0, 100), side: trade.side, qty, open: trade.open === true, entry: leg(trade.entry, entryTime, entryPrice),
        ...(exitTime !== null && exitPrice !== null ? { exit: leg(trade.exit, exitTime, exitPrice) } : {}),
        ...Object.fromEntries(Object.entries(optional).filter(([, item]) => item !== null)),
    };
}

/** Degrades the response in a fixed order until it fits, flagging each part that was shortened. */
function fit(result: AnalysisResult): AnalysisResult {
    const budget = ANALYSIS_LIMITS.responseBytes - 8 * 1024;
    const trim = (name: string): void => { if (!result.trimmed.includes(name)) result.trimmed.push(name); };
    if (byteLength(result) > budget && result.trades?.items.length) {
        result.trades.items = []; result.trades.returned = 0; result.trades.truncated = true; trim('trades');
    }
    while (byteLength(result) > budget && result.plots.some((plot) => plot.points.length > 1)) {
        for (const plot of result.plots) {
            if (plot.points.length <= 1) continue;
            plot.points = plot.points.slice(0, Math.max(1, Math.floor(plot.points.length / 2)));
            plot.returned = plot.points.length; plot.truncated = true;
        }
        trim('plot points');
    }
    if (byteLength(result) > budget && Object.keys(result.variables.values).length) { result.variables.values = {}; trim('variables'); }
    if (byteLength(result) > budget && result.settings.source) { delete result.settings.source; trim('source'); }
    if (byteLength(result) > budget && result.warnings.length) { result.warnings = result.warnings.slice(0, 5); trim('warnings'); }
    if (byteLength(result) > budget && result.outputs.plots.length) { result.outputs.plots = []; result.outputs.variables = []; trim('output names'); }
    if (byteLength(result) > budget) throw new Error('The analysis result exceeds the response size limit. Request fewer outputs.');
    return result;
}

export function createChartAnalysis(options: ChartAnalysisOptions): ChartAnalysis {
    const now = options.now ?? Date.now;
    const scopes = new Map<string, Scope>();
    const jobs = new Map<string, Job>();
    let disposed = false;

    const factory = options.createEngine ?? (async (engineOptions: LocalPineOptions): Promise<AnalysisEngine> => {
        const { LocalPineEngine } = await import('../scripting/pine-runtime');
        return new LocalPineEngine(engineOptions);
    });

    const open = (): void => { if (disposed) throw new Error('Chart analysis has closed.'); };

    const pruneScopes = (): void => {
        for (const [id, scope] of scopes) if (scope.summary.expiresAt <= now()) scopes.delete(id);
    };

    const pruneJobs = (): void => {
        for (const [id, job] of jobs) if (job.state !== 'running' && now() - job.updatedAt > ANALYSIS_LIMITS.jobRetentionMs) jobs.delete(id);
    };

    /** Only a new job makes room: reads never evict. */
    const makeRoom = (): void => {
        pruneJobs();
        while (jobs.size >= ANALYSIS_LIMITS.maxJobs) {
            const oldest = [...jobs.values()].filter((job) => job.state !== 'running').sort((a, b) => a.updatedAt - b.updatedAt)[0];
            if (!oldest) break;
            jobs.delete(oldest.id);
        }
    };

    const scopeOf = (target: ChartAgentTarget, scopeId: string): Scope => {
        pruneScopes();
        const scope = typeof scopeId === 'string' ? scopes.get(scopeId) : undefined;
        if (!scope || !sameTarget(scope.summary.target, target)) throw new Error('Unknown or expired analysis scope. Capture a new scope.');
        return scope;
    };

    const jobOf = (target: ChartAgentTarget, jobId: string): Job => {
        const job = typeof jobId === 'string' ? jobs.get(jobId) : undefined;
        if (job && job.state !== 'running' && now() - job.updatedAt > ANALYSIS_LIMITS.jobRetentionMs) jobs.delete(job.id);
        else if (job && sameTarget(job.target, target)) return job;
        throw new Error('Unknown or expired analysis job.');
    };

    const summary = (job: Job): AnalysisJobSummary => ({
        jobId: job.id, scopeId: job.scope.summary.scopeId, state: job.state, phase: job.phase,
        createdAt: job.createdAt, updatedAt: job.updatedAt, deadline: job.deadline,
        ...(job.error ? { error: job.error } : {}), ...(job.result ? { result: structuredClone(job.result) } : {}),
    });

    /** The single exit for every job: success, failure, cancel and timeout all abort fetches and end the worker. */
    const settle = (job: Job, state: Exclude<Job['state'], 'running'>, detail?: { error?: string; result?: AnalysisResult }): void => {
        if (job.state !== 'running') return;
        job.state = state; job.phase = 'finished'; job.updatedAt = now();
        if (detail?.error) job.error = detail.error;
        if (detail?.result) job.result = detail.result;
        clearTimeout(job.timer);
        job.controller.abort();
        try { job.engine?.dispose(); } catch { /* the worker is already gone */ }
        job.engine = undefined;
    };

    const live = (job: Job): void => {
        if (job.state !== 'running') throw new Error('The analysis has ended.');
    };

    const fetchPinned = async (job: Job, symbol: string | undefined, timeframe: string, params: { limit: number; from?: number; to?: number },
        signal: AbortSignal): Promise<SeriesReply> => {
        const { summary: scope } = job.scope;
        const query = new URLSearchParams({ timeframe, limit: String(params.limit), cutoff: String(scope.clock.sourceCutoff) });
        if (symbol !== undefined) query.set('symbol', symbol);
        if (params.from !== undefined) query.set('from', String(params.from));
        if (params.to !== undefined) query.set('to', String(params.to));
        const reply = await options.api.get<SeriesReply>(`/api/sessions/${encodeURIComponent(scope.target.sessionId)}/series?${query}`, signal);
        live(job);
        if (!reply || typeof reply !== 'object') throw new Error('The data service returned an invalid series reply.');
        return reply;
    };

    const run = async (job: Job): Promise<void> => {
        const { summary: scope, instrument, assertCurrent } = job.scope;
        const { request } = job;
        const sourceCutoff = scope.clock.sourceCutoff;
        const before = scope.clock.availableUntil;
        try {
            const fetchSeriesAt = async (symbol: string, timeframe: string, range: { from?: number; to?: number; limit?: number },
                cutoff: number, signal: AbortSignal): Promise<OHLCV[]> => {
                if (cutoff !== sourceCutoff) throw new Error('A secondary request left the pinned historical clock.');
                if (++job.secondaryRequests > ANALYSIS_LIMITS.secondaryRequests) throw new Error(`A script may make at most ${ANALYSIS_LIMITS.secondaryRequests} secondary data requests.`);
                if (typeof symbol !== 'string' || !symbol.length || symbol.length > 200 || /[\u0000-\u001f\u007f]/.test(symbol)) throw new Error('A secondary request named an invalid symbol.');
                assertCurrent();
                const limit = Math.min(range.limit ?? 5_000, ANALYSIS_LIMITS.warmupMax);
                const reply = await fetchPinned(job, symbol, timeframe, {
                    limit, ...(range.from === undefined ? {} : { from: Math.max(0, Math.floor(range.from)) }),
                    ...(range.to === undefined ? {} : { to: Math.max(0, Math.floor(range.to)) }),
                }, AbortSignal.any([signal, job.controller.signal]));
                assertCurrent();
                const bars = validBars(reply.bars, 'secondary series', 250_000, before, false);
                const sources = sourcesOf(reply);
                const key = `${symbol}|${timeframe}`;
                const previous = job.secondary.get(key);
                const merged = new Map((previous?.sourceDatasets ?? []).map(item => [item.id, item.checksum]));
                for (const item of sources) {
                    if (merged.has(item.id) && merged.get(item.id) !== item.checksum) throw new Error('A secondary dataset changed during analysis. Capture the region again.');
                    merged.set(item.id, item.checksum);
                }
                if (merged.size > 256) throw new Error('The secondary provenance exceeds its dataset limit. Use a smaller analysis.');
                job.secondary.set(key, { symbol: symbol.slice(0, 200), timeframe, bars: (previous?.bars ?? 0) + bars.length,
                    datasetId: typeof reply.datasetId === 'string' ? reply.datasetId.slice(0, 128) : sources[0]?.id ?? null,
                    checksum: typeof reply.checksum === 'string' ? reply.checksum.slice(0, 128) : sources[0]?.checksum ?? null,
                    sourceDatasets: [...merged].map(([id, checksum]) => ({ id, checksum })), partial: previous?.partial === true || sources.length === 0 });
                return bars;
            };
            const engine = await factory({
                workerUrl: '/local-pine-worker.js', cutoff: () => sourceCutoff, fetchSeriesAt, maxBars: ANALYSIS_LIMITS.warmupMax,
                prepareTimeoutMs: 10_000, runTimeoutMs: 25_000, contextTimeoutMs: 10_000,
            });
            if (job.state !== 'running') { engine.dispose(); return; }
            job.engine = engine;

            job.phase = 'compiling';
            const prepared = await engine.prepare(request.source, `analysis-${job.id}`, { signal: job.controller.signal });
            live(job);
            assertCurrent();
            const inputs = resolveSettings(request.inputs, prepared.inputs, 'input');
            const properties = resolveSettings(request.properties, prepared.props ?? [], 'property');

            job.phase = 'loading';
            const primary = await fetchPinned(job, undefined, toServerTimeframe(request.timeframe), { limit: request.warmupBars }, job.controller.signal);
            assertCurrent();
            if (primary.cursorTime !== sourceCutoff) throw new Error('The data service answered for a different historical clock.');
            job.primarySources = sourcesOf(primary);
            if (job.primarySources.some((item) => item.id === scope.dataset.id && item.checksum !== scope.dataset.checksum)) throw new Error('The replay dataset changed after the scope was captured.');
            const bars = validBars(primary.bars, 'primary series', request.warmupBars, before, true);
            if (!bars.length) throw new Error('No candles are available at or before the selected historical clock for this timeframe.');

            const market = { symbol: `replay:${scope.dataset.symbol}`, timeframe: request.timeframe, symbolInfo: replaySymbolInfo({ symbol: scope.dataset.symbol, instrument }) };
            const computation: EngineComputationIdentity = {
                id: `analysis:${job.id}`, source: request.source, inputs: { ...inputs }, props: { ...properties }, market,
                bars: { revision: 1, count: bars.length, firstTime: bars[0]!.time, lastTime: bars.at(-1)!.time },
            };
            job.phase = 'running';
            let finish!: () => void; let fail!: (error: unknown) => void;
            const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
            done.catch(() => undefined);
            const session = engine.execute({ prepared, bars, market, inputs, props: properties, mode: 'static', getComputation: () => computation }, {
                onModel: () => undefined, onDone: finish, onError: fail,
                onWarning: (warning) => { if (job.warnings.length < ANALYSIS_LIMITS.warnings) job.warnings.push(plainMessage(warning.message)); },
            });
            await done;
            live(job);

            job.phase = 'collecting';
            const select: ContextSelect = ['meta', 'plots', 'variables', 'warnings', 'barIndex', 'strategy', 'computation', ...(request.includeTrades ? ['trades' as const] : [])];
            const snapshot = await session.getContext?.(select);
            live(job);
            if (!snapshot) throw new Error('The script produced no result.');
            // A ready flag alone is not proof: the completed run must be the very run that was requested for this job.
            const proof = snapshot.computation;
            if (proof && (proof.state !== 'ready' || proof.requested.id !== computation.id || proof.completed?.id !== computation.id)) {
                throw new Error(`The calculation did not complete cleanly (${proof.state}).`);
            }
            assertCurrent();
            settle(job, 'completed', { result: build(job, snapshot, bars, primary.hasMore === true, prepared, inputs, properties) });
        } catch (error) {
            if (job.state === 'running') settle(job, 'failed', { error: plainMessage(error) });
        }
    };

    const build = (job: Job, snapshot: EngineContextSnapshot, bars: OHLCV[], olderHistory: boolean, prepared: PreparedScript,
        inputs: Record<string, InputValue>, properties: Record<string, InputValue>): AnalysisResult => {
        const { summary: scope } = job.scope;
        const { request } = job;
        const { region, clock } = scope;
        const upper = Math.min(region.to, clock.sourceCutoff);
        const inRegion = (time: number): boolean => time >= region.from && time <= upper;
        const warnings = [...job.warnings];
        for (const warning of snapshot.warnings.slice(0, ANALYSIS_LIMITS.warnings)) {
            const message = plainMessage(warning.message);
            if (!warnings.includes(message) && warnings.length < ANALYSIS_LIMITS.warnings) warnings.push(message);
        }

        const first = bars[0]!.time;
        const regionCovered = first <= region.from || !olderHistory;
        const barsInRegion = bars.filter((bar) => inRegion(bar.time)).length;
        if (!regionCovered) warnings.push(`The ${request.warmupBars.toLocaleString('en-US')}-bar budget starts at ${new Date(first).toISOString()}, after the region start. Results before that time are not included; raise warmupBars or choose a later region.`);

        // Names that look like credentials are never returned, whatever the script calls them.
        const available = Object.keys(snapshot.plots).filter((key) => !PRIVATE_FIELD.test(key));
        const selectedPlots = (request.plotKeys ?? available.slice(0, ANALYSIS_LIMITS.plotKeysDefault));
        const unknownPlots = selectedPlots.filter((key) => !available.includes(key));
        if (unknownPlots.length) warnings.push(`Unknown plot output${unknownPlots.length > 1 ? 's' : ''}: ${unknownPlots.slice(0, 16).join(', ')}. Available outputs are listed under outputs.plots.`);
        const known = selectedPlots.filter((key) => available.includes(key));
        const perPlot = Math.max(1, Math.min(request.limit, Math.floor(ANALYSIS_LIMITS.totalPoints / Math.max(1, known.length))));
        const plots: AnalysisPlotResult[] = known.map((key) => {
            const points = snapshot.plots[key]!.filter((point) => Number.isSafeInteger(point.time) && inRegion(point.time));
            const numbers = points.map((point) => finite(point.value)).filter((value): value is number => value !== null);
            const kept = request.pointsFrom === 'start' ? points.slice(0, perPlot) : points.slice(-perPlot);
            return {
                key, total: points.length, returned: kept.length, truncated: kept.length < points.length,
                stats: { finite: numbers.length, min: numbers.length ? Math.min(...numbers) : null, max: numbers.length ? Math.max(...numbers) : null,
                    first: numbers[0] ?? null, last: numbers.at(-1) ?? null },
                points: kept.map((point) => ({ time: point.time, value: finite(point.value) })),
            };
        });
        if (plots.some((plot) => plot.truncated)) warnings.push(`Plot points were shortened to ${perPlot} per plot (${request.pointsFrom === 'start' ? 'oldest' : 'newest'} kept). Stats cover every point in the region.`);

        const inputKeys = new Set(prepared.inputs.map((entry) => entry.key));
        const variableNames = Object.keys(snapshot.variables).filter((key) => !PRIVATE_FIELD.test(key));
        const wantedVariables = request.variableKeys ?? variableNames.filter((key) => !inputKeys.has(key)).slice(0, ANALYSIS_LIMITS.variableKeysDefault);
        const unknownVariables = wantedVariables.filter((key) => !variableNames.includes(key));
        if (unknownVariables.length) warnings.push(`Unknown variable${unknownVariables.length > 1 ? 's' : ''}: ${unknownVariables.slice(0, 16).join(', ')}.`);
        const cut = { cut: false };
        const values: Record<string, unknown> = {};
        for (const key of wantedVariables.filter((name) => variableNames.includes(name))) {
            Object.defineProperty(values, key, { value: safeJson(snapshot.variables[key], SAFE_VALUE, cut), enumerable: true, writable: true, configurable: true });
        }
        if (cut.cut) warnings.push('Some variable values were shortened to keep the response bounded.');

        const isStrategy = !!snapshot.strategy;
        const trades = isStrategy && request.includeTrades ? (() => {
            const all = (snapshot.trades ?? []).map(tradeCopy).filter((trade): trade is AnalysisTrade => trade !== null);
            const matched = all.filter((trade) => trade.entry.time <= upper && (trade.open || !trade.exit || trade.exit.time >= region.from));
            const kept = request.pointsFrom === 'start' ? matched.slice(0, ANALYSIS_LIMITS.trades) : matched.slice(-ANALYSIS_LIMITS.trades);
            return { total: all.length, inRegion: matched.length, returned: kept.length, truncated: kept.length < matched.length, items: kept };
        })() : undefined;
        if (trades?.truncated) warnings.push(`Trades were shortened to ${ANALYSIS_LIMITS.trades}.`);

        const secondary = [...job.secondary.values()];
        const completed = snapshot.computation?.completed;
        const result: AnalysisResult = {
            title: String(snapshot.meta.title ?? prepared.meta.title ?? '').slice(0, 200), kind: isStrategy ? 'strategy' : 'indicator',
            clock: { ...clock }, region: { ...region },
            coverage: { timeframe: request.timeframe, barsLoaded: bars.length, firstBarTime: first, lastBarTime: bars.at(-1)!.time, barsInRegion,
                warmupBarsBeforeRegion: bars.filter((bar) => bar.time < region.from).length, warmupBudget: request.warmupBars,
                regionCovered, olderHistoryAvailable: olderHistory, datasetStartsAfterRegion: first > region.from && !olderHistory },
            outputs: {
                plots: available.slice(0, ANALYSIS_LIMITS.names).map((key) => ({ key, points: snapshot.plots[key]!.filter((point) => inRegion(point.time)).length })),
                variables: variableNames.slice(0, ANALYSIS_LIMITS.names),
                plotsOmitted: Math.max(0, available.length - ANALYSIS_LIMITS.names), variablesOmitted: Math.max(0, variableNames.length - ANALYSIS_LIMITS.names),
            },
            plots,
            variables: { asOfBarTime: bars.at(-1)!.time, values },
            ...(isStrategy ? { strategy: { includesWarmupBars: true as const,
                note: `Account totals come from a fresh calculation through ${new Date(clock.sourceCutoff).toISOString()} and include the earlier loaded warmup bars; they are not derived from the region-filtered plots.`,
                state: safeJson(snapshot.strategy) as Record<string, unknown> } } : {}),
            ...(trades ? { trades } : {}),
            warnings: warnings.slice(0, ANALYSIS_LIMITS.warnings),
            settings: { timeframe: request.timeframe, warmupBars: request.warmupBars, inputs: { ...inputs }, properties: { ...properties },
                sourceChars: request.source.length, sourceFingerprint: sourceFingerprint(request.source), ...(request.includeSource ? { source: request.source } : {}) },
            provenance: {
                dataset: { ...scope.dataset }, secondary,
                primarySources: job.primarySources.map((item) => ({ ...item })),
                partial: !job.primarySources.length || secondary.some((item) => item.partial || item.checksum === null),
                note: secondary.length
                    ? 'Primary candles come from the pinned dataset. Secondary series are served from the local cache at the same cutoff; a null checksum means that reply did not identify its dataset content, which makes the provenance partial.'
                    : 'Primary candles come from the pinned dataset.',
            },
            ...(completed ? { computation: { id: String(completed.id).slice(0, 200), dataCutoff: finite(completed.dataCutoff),
                bars: { revision: completed.bars.revision, count: completed.bars.count, firstTime: finite(completed.bars.firstTime), lastTime: finite(completed.bars.lastTime) } } } : {}),
            trimmed: [],
        };
        return fit(result);
    };

    return {
        async capture(input, rawArgs = {}) {
            open();
            const args = parseCaptureArgs(rawArgs);
            const { chart, view, target } = input;
            input.assertCurrent();
            if (target.sessionId !== view.session.id) throw new Error('The chart request belongs to a different session.');
            if (!Number.isSafeInteger(input.cutoff) || input.cutoff < 0) throw new Error('No replay candle is revealed yet.');
            pruneScopes();
            if (scopes.size >= ANALYSIS_LIMITS.maxScopes) throw new Error(`${ANALYSIS_LIMITS.maxScopes} analysis scopes are active. Wait for one to expire.`);
            const { symbol, timeframe } = chart.market;
            const period = timeframe ? parseTimeframe(timeframe) : null;
            if (!symbol || !timeframe || !period || !timeframeSupported(timeframe, view.dataset.schema)) throw new Error('The chart timeframe is not supported by the replay dataset.');

            let requestedFrom: number; let requestedTo: number; let origin: AnalysisRegion['origin'] = 'range';
            let priceLow: number | undefined; let priceHigh: number | undefined;
            if (args.drawingId !== undefined) {
                const drawing = chart.drawings.all().find((item) => item.id === args.drawingId);
                if (!drawing) throw new Error('Unknown drawing id.');
                const times = drawing.anchors.map((anchor) => anchor.time).filter(Number.isFinite);
                const prices = drawing.anchors.map((anchor) => anchor.price).filter(Number.isFinite);
                if (!times.length) throw new Error('This drawing has no time anchors to analyse.');
                requestedFrom = Math.floor(Math.min(...times)); requestedTo = Math.floor(Math.max(...times)); origin = 'drawing';
                if (prices.length) { priceLow = Math.min(...prices); priceHigh = Math.max(...prices); }
            } else if (args.from !== undefined) {
                requestedFrom = args.from; requestedTo = args.to!;
            } else {
                const visible = chart.getVisibleRange();
                if (!visible || !Number.isFinite(visible.from) || !Number.isFinite(visible.to)) throw new Error('The chart has no visible range yet.');
                requestedFrom = Math.floor(Math.min(visible.from, visible.to)); requestedTo = Math.floor(Math.max(visible.from, visible.to)); origin = 'visible';
            }
            if (requestedFrom < 0 || requestedTo > ANALYSIS_LIMITS.maxTime) throw new Error('The selected region is outside the supported time range.');
            if (requestedFrom > input.cutoff) throw new Error('The selected region starts after the loaded replay cursor.');
            const to = Math.min(requestedTo, input.cutoff);

            const query = new URLSearchParams({ timeframe: toServerTimeframe(timeframe), cutoff: String(to), limit: '1' });
            const reply = await options.api.get<SeriesReply>(`/api/sessions/${encodeURIComponent(view.session.id)}/series?${query}`, input.signal);
            input.signal?.throwIfAborted();
            open();
            input.assertCurrent();
            if (!reply || typeof reply !== 'object' || reply.cursorTime === null || reply.cursorTime === undefined) {
                throw new Error('No replay candle is revealed at or before the end of the selected region.');
            }
            if (sourcesOf(reply).some((item) => item.id === view.dataset.id && item.checksum !== view.dataset.checksum)) throw new Error('The replay dataset changed after the chart state was read.');
            const sourceCutoff = reply.cursorTime;
            if (typeof sourceCutoff !== 'number' || !Number.isSafeInteger(sourceCutoff) || sourceCutoff > to) throw new Error('The data service returned an invalid historical clock.');
            const intervalMs = view.dataset.intervalMs;
            if (reply.baseIntervalMs !== undefined && reply.baseIntervalMs !== intervalMs) throw new Error('The data service reported a different source interval.');

            pruneScopes();
            if (scopes.size >= ANALYSIS_LIMITS.maxScopes) throw new Error(`${ANALYSIS_LIMITS.maxScopes} analysis scopes are active. Wait for one to expire.`);
            const region: AnalysisRegion = { from: requestedFrom, to, requestedFrom, requestedTo, clamped: to !== requestedTo, origin,
                ...(args.drawingId === undefined ? {} : { drawingId: args.drawingId }),
                ...(priceLow === undefined ? {} : { priceLow, priceHigh }) };
            const clock: AnalysisClock = { sourceCutoff, availableUntil: sourceCutoff + intervalMs, sourceIntervalMs: intervalMs, label: `${CLOCK_LABEL} ${CLOCK_NOTE}` };
            const dataset: AnalysisDatasetIdentity = { id: view.dataset.id, checksum: view.dataset.checksum, symbol: view.dataset.symbol, schema: view.dataset.schema, intervalMs };
            const createdAt = now();
            const scopeSummary: AnalysisScopeSummary = {
                scopeId: crypto.randomUUID(), target: copyTarget(target), createdAt, expiresAt: createdAt + ANALYSIS_LIMITS.scopeTtlMs, cursorTime: input.cutoff,
                region, clock, chart: { symbol, timeframe: period.native, intervalMs: period.intervalMs }, dataset,
            };
            scopes.set(scopeSummary.scopeId, { summary: scopeSummary, instrument: { ...view.dataset.instrument }, assertCurrent: input.assertCurrent });
            return structuredClone(scopeSummary);
        },

        evaluate(target, scopeId, rawArgs) {
            open();
            const scope = scopeOf(target, scopeId);
            scope.assertCurrent();
            const request = parseEvaluateArgs(rawArgs, scope.summary.dataset.schema, scope.summary.chart.timeframe);
            makeRoom();
            if ([...jobs.values()].filter((job) => job.state === 'running').length >= ANALYSIS_LIMITS.maxRunningJobs) {
                throw new Error(`${ANALYSIS_LIMITS.maxRunningJobs} analysis jobs are already running. Wait or cancel one.`);
            }
            const createdAt = now();
            const job: Job = {
                id: crypto.randomUUID(), scope, target: copyTarget(target), request, state: 'running', phase: 'compiling',
                createdAt, updatedAt: createdAt, deadline: createdAt + ANALYSIS_LIMITS.jobMs, controller: new AbortController(),
                secondary: new Map(), secondaryRequests: 0, warnings: [], primarySources: [],
            };
            jobs.set(job.id, job);
            job.timer = setTimeout(() => settle(job, 'failed', { error: `The analysis exceeded ${ANALYSIS_LIMITS.jobMs / 1000} seconds and was stopped.` }), ANALYSIS_LIMITS.jobMs);
            void run(job);
            return summary(job);
        },

        readJob(target, jobId, rawArgs = {}) {
            open();
            if (rawArgs && typeof rawArgs === 'object' && Object.keys(rawArgs).length) throw new Error(`Unsupported argument: ${Object.keys(rawArgs)[0]}.`);
            pruneJobs();
            const job = jobOf(target, jobId);
            // A result describes one captured chart state; once that state is gone the read fails as stale instead of presenting it as current.
            job.scope.assertCurrent();
            return summary(job);
        },

        cancelJob(target, jobId) {
            open();
            const job = jobOf(target, jobId);
            settle(job, 'cancelled', { error: 'The analysis was cancelled.' });
            return summary(job);
        },

        readScope(target, scopeId) {
            open();
            const scope = scopeOf(target, scopeId);
            scope.assertCurrent();
            return structuredClone(scope.summary);
        },

        dispose() {
            if (disposed) return;
            for (const job of jobs.values()) settle(job, 'cancelled', { error: 'Chart analysis has closed.' });
            disposed = true;
            jobs.clear(); scopes.clear();
        },
    };
}
