import { PineWorkerEngine, type PineWorkerOptions } from '@luxalgo/vela-pinets';
import type {
    BarRange, ContextSelect, EngineCapabilities, EngineContextSnapshot, EngineWarning, ExecutionHandlers, ExecutionRequest,
    ExecutionSession, FetchSeries, IndicatorModel, InputValue, OHLCV, PreparedScript, ScriptingEngine, VisibleBarRange,
} from '../../src/plugin';

type WorkerLike = ReturnType<NonNullable<PineWorkerOptions['createWorker']>>;
type WorkerFactory = (url: string) => Pick<Worker, 'postMessage' | 'addEventListener' | 'terminate'>;
type FailureKind = 'compile' | 'runtime' | 'timeout' | 'worker' | 'cancelled' | 'data' | 'capacity';

export class PineRuntimeError extends Error {
    constructor(readonly kind: FailureKind, message: string) { super(message); this.name = 'PineRuntimeError'; }
}

/** A shared thread budget keeps multi-cell workspaces from exhausting the machine. */
export class PineWorkerBudget {
    private count = 0;
    constructor(readonly limit = 8) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error('Pine worker capacity must contain 1–64 threads.');
    }
    get active(): number { return this.count; }
    reserve(): () => void {
        if (this.count >= this.limit) throw new PineRuntimeError('capacity', `All ${this.limit} Pine worker slots are in use. Remove a Pine script or increase the local worker budget before adding another.`);
        this.count += 1;
        let held = true;
        return () => { if (held) { held = false; this.count -= 1; } };
    }
}

const DEFAULT_WORKER_BUDGET = new PineWorkerBudget();

export interface LocalPineOptions {
    /** A same-origin classic worker with its own no-network CSP. */
    workerUrl: string;
    /** The server-owned replay cursor; null means no candle has been revealed. */
    cutoff: () => number | null;
    /** Read only cached, server-revealed series. Never a provider credential or direct provider request. */
    fetchSeries?: FetchSeries;
    /** Pins aggregation to the source cursor, independently of the requested bar-open window. */
    fetchSeriesAt?: (symbol: string, timeframe: string, range: BarRange, cutoff: number, signal: AbortSignal) => Promise<OHLCV[]>;
    defaultProps?: Record<string, InputValue>;
    maxBars?: number;
    maxScripts?: number;
    prepareTimeoutMs?: number;
    runTimeoutMs?: number;
    contextTimeoutMs?: number;
    workerBudget?: PineWorkerBudget;
    createWorker?: WorkerFactory;
}

type ComputationIdentity = ReturnType<NonNullable<ExecutionRequest['getComputation']>>;

interface Backend {
    engine: PineWorkerEngine;
    instanceId: string;
    alive: boolean;
    executing: boolean;
    pendingRuns: number;
    runIdentities: Array<{ identity?: ComputationIdentity; deferred: boolean }>;
    historyDeferred: boolean;
    completed?: ComputationIdentity;
    pendingModel?: IndicatorModel;
    lastRunComputed: boolean;
    identity?: () => ComputationIdentity;
    contextVersion: number;
    visibleRange?: VisibleBarRange;
    cutoff: number | null;
    symbol: string;
    barIndex: number;
    warnedSecondaryMetadata: boolean;
    hostWarnings: EngineWarning[];
    controller: AbortController;
    releaseBudget: () => void;
    timer?: ReturnType<typeof setTimeout>;
    unused?: ReturnType<typeof setTimeout>;
    handlers?: ExecutionHandlers;
    session?: ExecutionSession;
    waits: Set<(error: PineRuntimeError) => void>;
}

const DEAD_WORKER: WorkerLike = { postMessage: () => {}, addEventListener: () => {}, terminate: () => {} };
const RUN_MESSAGES = new Set(['execute', 'update', 'setVisibleRange', 'notifyBars', 'bars']);
const ALL_CONTEXT: ContextSelect = ['language', 'phase', 'barIndex', 'meta', 'plots', 'variables', 'strategy', 'trades', 'warnings'];

function failure(kind: FailureKind, error: unknown): PineRuntimeError {
    if (error instanceof PineRuntimeError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const parserFailure = /(?:failed to (?:parse|transpile)|unexpected (?:token|end)|syntax\s*error|parse error|unterminated)/i.test(message);
    return new PineRuntimeError(kind === 'runtime' && parserFailure ? 'compile' : kind, message);
}

function sameInstrument(value: string, expected: string): boolean {
    const plain = (symbol: string): string => symbol.split(';')[0]!.replace(/^[A-Za-z0-9_.-]+:/, '');
    return /^[A-Za-z0-9_.:-]+(?:;[^\s]{1,200})?$/.test(value) && plain(value) === plain(expected);
}

function stubTickerReferences(source: string): string[] {
    const code = source.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|`(?:\\[\s\S]|[^`\\])*(?:`|$)/g,
        (literal) => literal.replace(/[^\r\n]/g, ' '));
    return [...new Set([...code.matchAll(/\bticker\s*\.\s*(renko|kagi|linebreak|pointfigure)\s*\(/g)].map((match) => match[1]!))];
}

/** Official Pine semantics, isolated from the UI and from other running scripts. */
export class LocalPineEngine implements ScriptingEngine {
    readonly language = 'pine';
    // Static acknowledgments identify exactly which bars and settings completed. Live
    // charts still recompute on bar notifications, coalesced by PineWorkerEngine.
    readonly capabilities: EngineCapabilities = { streaming: false, visibleRange: true, inputs: true, props: true };
    private readonly backends = new Set<Backend>();
    private readonly prepared = new WeakMap<PreparedScript, Backend>();
    private readonly tickerReferences = new WeakMap<PreparedScript, readonly string[]>();
    private readonly maxBars: number;
    private readonly maxScripts: number;
    private disposed = false;

    constructor(private readonly options: LocalPineOptions) {
        this.maxBars = options.maxBars ?? 250_000;
        this.maxScripts = options.maxScripts ?? 32;
        if (!Number.isSafeInteger(this.maxBars) || this.maxBars < 1 || this.maxBars > 250_000) throw new Error('Pine history must contain 1–250,000 bars.');
        if (!Number.isSafeInteger(this.maxScripts) || this.maxScripts < 1 || this.maxScripts > 64) throw new Error('Pine capacity must contain 1–64 scripts.');
        for (const timeout of [options.prepareTimeoutMs, options.runTimeoutMs, options.contextTimeoutMs]) {
            if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000)) throw new Error('Pine time limits must contain 1–600,000 milliseconds.');
        }
        if (!/^\/(?!\/)[^?#]+\.js(?:\?[^#]*)?$/.test(options.workerUrl)) throw new Error('Pine requires a hosted, same-origin worker.');
    }

    async prepare(source: string, instanceId: string, options?: { signal?: AbortSignal }): Promise<PreparedScript> {
        if (options?.signal?.aborted) throw new PineRuntimeError('cancelled', 'Pine compilation was cancelled.');
        if (typeof source !== 'string' || source.length === 0 || source.length > 1_000_000) throw new PineRuntimeError('compile', 'A Pine script must contain 1–1,000,000 characters.');
        for (const pending of this.backends) if (pending.instanceId === instanceId && !pending.executing) this.release(pending);
        const previous = [...this.backends].find((item) => item.instanceId === instanceId && item.executing);
        const budget = this.options.workerBudget ?? DEFAULT_WORKER_BUDGET;
        const borrowing = !!previous && budget.active >= budget.limit;
        const backend = borrowing ? previous : this.createBackend(instanceId);
        const cancel = (): void => { if (!borrowing) this.release(backend); };
        options?.signal?.addEventListener('abort', cancel, { once: true });
        try {
            const result = await this.wait(backend, backend.engine.prepare(source, instanceId), this.options.prepareTimeoutMs ?? 15_000, 'Pine compilation', options?.signal, borrowing);
            this.prepared.set(result, backend);
            this.tickerReferences.set(result, stubTickerReferences(source));
            if (!backend.executing) backend.unused = setTimeout(() => this.release(backend), 60_000);
            return result;
        } catch (error) {
            if (!borrowing) this.release(backend);
            throw failure('compile', error);
        } finally {
            options?.signal?.removeEventListener('abort', cancel);
        }
    }

    execute(request: ExecutionRequest, handlers: ExecutionHandlers): ExecutionSession {
        let backend = this.prepared.get(request.prepared);
        if (!backend?.alive || backend.executing) backend = this.createBackend(backend?.instanceId ?? '');
        const current = backend;
        clearTimeout(current.unused);
        current.executing = true;
        current.symbol = request.market.symbol;
        current.handlers = handlers;
        current.identity = request.getComputation ? () => ({ ...request.getComputation!(), dataCutoff: this.options.cutoff() }) : undefined;
        const getBars = (): OHLCV[] => {
            const source = (request.getBars ?? (() => request.bars))();
            const cursor = this.options.cutoff();
            current.cutoff = cursor === null || !Number.isFinite(cursor) ? null : cursor;
            const bounded = this.boundedBars(source, current.cutoff);
            current.barIndex = bounded.length - 1;
            return bounded;
        };
        const guarded: ExecutionRequest = { ...request, mode: 'static', bars: [], getBars,
            fetchSeries: (symbol, timeframe, range) => this.fetch(current, symbol, timeframe, range, request.fetchSeries) };
        const forward: ExecutionHandlers = {
            onModel: (model) => { if (current.alive) current.pendingModel = model; },
            onAlert: (alert) => { if (current.alive) handlers.onAlert?.(alert); },
            onWarning: (warning) => { if (current.alive) handlers.onWarning?.(warning); },
            onError: (error) => this.fail(current, failure('runtime', error)),
            onDone: () => {
                if (!current.alive) return;
                const model = current.pendingModel; current.pendingModel = undefined;
                const requested = current.identity?.();
                // Model delivery announces public readiness. Its context must belong
                // to an acknowledged, current run before those callbacks can read it.
                if (model && current.lastRunComputed && current.pendingRuns === 0
                    && (!requested || JSON.stringify(current.completed) === JSON.stringify(requested))) handlers.onModel(model);
                if (current.alive) handlers.onDone?.();
            },
        };
        try { current.session = current.engine.execute(guarded, forward); }
        catch (error) { this.fail(current, failure('runtime', error)); }
        if (current.alive) for (const method of this.tickerReferences.get(request.prepared) ?? []) {
            this.warn(current, { method: `ticker.${method}`, bar: current.barIndex,
                message: `The installed PineTS ticker.${method} helper returns ordinary candles. Use standard or Heikin Ashi data until a runtime version implements this derived chart type.` });
        }
        return {
            getContext: (select = ALL_CONTEXT) => this.context(current, select),
            stop: () => this.release(current),
            update: (inputs, props) => this.command(current, () => current.session?.update(inputs, props)),
            setVisibleRange: (range) => this.command(current, () => current.session?.setVisibleRange(range)),
            notifyBars: (reason) => this.command(current, () => current.session?.notifyBars(reason)),
        };
    }

    /** Vela's engine port has no destroy hook; the workspace owner calls this on cell teardown. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const backend of [...this.backends]) this.release(backend);
    }

    private createBackend(instanceId: string): Backend {
        if (this.disposed) throw new PineRuntimeError('cancelled', 'This chart has closed.');
        if (this.backends.size >= this.maxScripts) throw new PineRuntimeError('capacity', `This chart already has ${this.maxScripts} active Pine scripts. Remove a script before adding another.`);
        const releaseBudget = (this.options.workerBudget ?? DEFAULT_WORKER_BUDGET).reserve();
        const backend: Backend = { engine: undefined as unknown as PineWorkerEngine, instanceId, alive: true, executing: false, pendingRuns: 0, runIdentities: [], historyDeferred: false, lastRunComputed: false, contextVersion: 0,
            cutoff: null, symbol: '', barIndex: -1, warnedSecondaryMetadata: false, hostWarnings: [], controller: new AbortController(), waits: new Set(), releaseBudget };
        backend.engine = new PineWorkerEngine({ props: 'all', defaultProps: this.options.defaultProps, createWorker: () => this.worker(backend) });
        this.backends.add(backend);
        return backend;
    }

    private worker(backend: Backend): WorkerLike {
        if (!backend.alive) return DEAD_WORKER;
        const worker = this.options.createWorker?.(this.options.workerUrl) ?? new Worker(this.options.workerUrl);
        worker.addEventListener('error', (event) => this.fail(backend, new PineRuntimeError('worker', event.message || 'The Pine worker could not execute.')));
        worker.addEventListener('messageerror', () => this.fail(backend, new PineRuntimeError('worker', 'The Pine worker returned unreadable data.')));
        return {
            postMessage: (message) => {
                if (!backend.alive) return;
                const payload = message as { kind?: string; visibleRange?: VisibleBarRange; range?: VisibleBarRange; historyState?: string };
                const kind = payload.kind;
                if (kind === 'execute') {
                    backend.visibleRange = payload.visibleRange;
                    backend.historyDeferred = payload.historyState === 'backfill';
                }
                else if (kind === 'setVisibleRange') backend.visibleRange = payload.range;
                else if (kind === 'notifyBars' || kind === 'bars') backend.historyDeferred = false;
                const run = kind && RUN_MESSAGES.has(kind);
                if (run) {
                    backend.pendingRuns += 1;
                    backend.contextVersion += 1;
                    const requested = backend.identity?.();
                    backend.runIdentities.push({ deferred: backend.historyDeferred, identity: requested ? { ...requested, dataCutoff: backend.cutoff,
                        visibleRange: backend.visibleRange ? { ...backend.visibleRange } : undefined } : undefined });
                    this.arm(backend);
                }
                worker.postMessage(message);
            },
            addEventListener: (_type, listener) => worker.addEventListener('message', (event) => {
                if (!backend.alive) return;
                const msg = event.data as { kind?: string };
                const kind = msg.kind;
                if (kind === 'done' || kind === 'error') {
                    const run = backend.runIdentities.shift();
                    backend.lastRunComputed = kind === 'done' && !!run && !run.deferred;
                    if (kind !== 'error' && run?.identity && !run.deferred) backend.completed = run.identity;
                    backend.contextVersion += 1;
                    backend.pendingRuns = Math.max(0, backend.pendingRuns - 1);
                    clearTimeout(backend.timer); backend.timer = undefined;
                    if (backend.pendingRuns > 0) this.arm(backend);
                }
                listener({ data: event.data });
            }),
            terminate: () => worker.terminate(),
        };
    }

    private arm(backend: Backend): void {
        if (backend.timer || !backend.alive) return;
        backend.timer = setTimeout(() => this.fail(backend, new PineRuntimeError('timeout', 'Pine execution exceeded its time limit. The script was stopped; the chart remains available.')), this.options.runTimeoutMs ?? 30_000);
    }

    private command(backend: Backend, action: () => void): void {
        if (!backend.alive) return;
        try { action(); } catch (error) { this.fail(backend, failure('runtime', error)); }
    }

    private async context(backend: Backend, select: ContextSelect): Promise<EngineContextSnapshot | null> {
        if (!backend.alive || !backend.session?.getContext) return null;
        const requested = backend.identity?.();
        const status = (): EngineContextSnapshot['computation'] => requested ? {
            state: backend.pendingRuns > 0 || !backend.completed ? 'pending' : JSON.stringify(backend.completed) === JSON.stringify(backend.identity?.()) ? 'ready' : 'stale',
            requested: backend.identity!(), ...(backend.completed ? { completed: structuredClone(backend.completed) } : {}),
        } : undefined;
        const empty = (state?: 'pending' | 'stale'): EngineContextSnapshot => {
            const computation = status();
            return { language: this.language, phase: 'idle', barIndex: -1,
                meta: { title: '', overlay: false }, plots: {}, variables: {}, warnings: [],
                ...(computation ? { computation: { ...computation, ...(state ? { state } : {}) } } : {}) };
        };
        // A worker may still be mutating lastCtx. Never label an uncompleted result as current.
        if (requested && backend.pendingRuns > 0) return empty();
        const version = backend.contextVersion;
        const snapshot = await this.wait(backend, backend.session.getContext(select), this.options.contextTimeoutMs ?? 10_000, 'Pine context');
        if (!backend.alive) return null;
        if (requested && (version !== backend.contextVersion || JSON.stringify(requested) !== JSON.stringify(backend.identity?.()))) return empty(backend.pendingRuns > 0 ? 'pending' : 'stale');
        if (!snapshot) return requested ? empty(backend.completed ? 'stale' : 'pending') : null;
        return { ...snapshot,
            ...(select.includes('warnings') ? { warnings: [...snapshot.warnings, ...backend.hostWarnings.map((warning) => ({ ...warning }))] } : {}),
            ...(requested ? { computation: status() } : {}) };
    }

    private wait<T>(backend: Backend, promise: Promise<T>, timeout: number, label: string, signal?: AbortSignal, preserveBackend = false): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const cleanup = (): void => { clearTimeout(timer); backend.waits.delete(cancel); signal?.removeEventListener('abort', aborted); };
            const cancel = (error: PineRuntimeError): void => { cleanup(); reject(error); };
            const aborted = (): void => cancel(new PineRuntimeError('cancelled', `${label} was cancelled.`));
            const timer = setTimeout(() => {
                const error = new PineRuntimeError('timeout', `${label} exceeded its time limit.`);
                if (preserveBackend) cancel(error);
                else this.fail(backend, error);
            }, timeout);
            backend.waits.add(cancel);
            signal?.addEventListener('abort', aborted, { once: true });
            if (signal?.aborted) { aborted(); return; }
            promise.then((value) => { cleanup(); if (backend.alive) resolve(value); },
                (error: unknown) => { cleanup(); reject(error); });
        });
    }

    private fail(backend: Backend, error: PineRuntimeError): void {
        if (!backend.alive) return;
        const handlers = backend.handlers;
        this.release(backend, error);
        handlers?.onError?.(error);
    }

    private warn(backend: Backend, warning: EngineWarning): void {
        if (!backend.alive) return;
        backend.hostWarnings.push(warning);
        backend.handlers?.onWarning?.({ ...warning });
    }

    private release(backend: Backend, error = new PineRuntimeError('cancelled', 'Pine execution was cancelled.')): void {
        if (!backend.alive) return;
        backend.alive = false;
        clearTimeout(backend.timer); clearTimeout(backend.unused);
        backend.controller.abort();
        backend.session?.stop();
        backend.engine.terminate();
        backend.releaseBudget();
        for (const cancel of [...backend.waits]) cancel(error);
        backend.waits.clear();
        backend.handlers = undefined;
        backend.session = undefined;
        this.backends.delete(backend);
    }

    private boundedBars(bars: OHLCV[], cutoff: number | null, range?: BarRange): OHLCV[] {
        if (bars.length > this.maxBars) throw new PineRuntimeError('data', `Pine history exceeds ${this.maxBars.toLocaleString('en-US')} bars. Choose a shorter range.`);
        if (cutoff === null) return [];
        const result = bars.filter((bar) => bar.time <= cutoff && (range?.from === undefined || bar.time >= range.from)
            && (range?.to === undefined || bar.time <= range.to));
        return range?.limit === undefined ? result : result.slice(-range.limit);
    }

    private async fetch(backend: Backend, symbol: string, timeframe: string, range: BarRange, fallback?: FetchSeries): Promise<OHLCV[]> {
        if (!backend.alive || backend.cutoff === null) return [];
        if (!this.options.fetchSeriesAt && !sameInstrument(symbol, backend.symbol)) throw new PineRuntimeError('data', 'This replay has no cached data for the requested instrument. Select a session for that instrument before requesting it.');
        if (this.options.fetchSeriesAt && !sameInstrument(symbol, backend.symbol) && !backend.warnedSecondaryMetadata) {
            backend.warnedSecondaryMetadata = true;
            this.warn(backend, { method: 'request.security', bar: backend.barIndex,
                message: 'The Pine runtime may use default syminfo values inside a different-symbol request. Check calculations that depend on the secondary contract tick size or point value.' });
        }
        if (!/^(?:[1-9]\d{0,5}[SDWM]?|[DWM])$/.test(timeframe)) throw new PineRuntimeError('data', 'The requested Pine timeframe is invalid.');
        if ((range.from !== undefined && !Number.isFinite(range.from)) || (range.to !== undefined && !Number.isFinite(range.to))
            || (range.limit !== undefined && (!Number.isSafeInteger(range.limit) || range.limit < 1))) throw new PineRuntimeError('data', 'The requested Pine history range is invalid.');
        const cutoff = backend.cutoff;
        const bounded = { ...range, ...(this.options.fetchSeriesAt ? {} : { to: Math.min(range.to ?? cutoff, cutoff) }), limit: Math.min(range.limit ?? this.maxBars, this.maxBars) };
        if (bounded.from !== undefined && bounded.to !== undefined && bounded.from > bounded.to) return [];
        const load = this.options.fetchSeries ?? fallback;
        if (!load && !this.options.fetchSeriesAt) return [];
        const bars = this.options.fetchSeriesAt
            ? await this.options.fetchSeriesAt(symbol, timeframe, bounded, cutoff, backend.controller.signal)
            : await load!(symbol, timeframe, bounded);
        return backend.alive ? this.boundedBars(bars, this.options.fetchSeriesAt ? Number.POSITIVE_INFINITY : cutoff, bounded) : [];
    }
}

export type { EngineContextSnapshot };
