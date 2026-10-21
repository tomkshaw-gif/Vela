import type { QueryResult } from '@luxalgo/edge-stats';
import { astToDsl, parseDsl } from '@luxalgo/edge-stats/query-tools';
import { MARKET_STATS_LIMITS as LIMITS, MARKET_STATS_SOURCE, MarketStatsError } from './contract';
import type { MarketStatsInput, MarketStatsResponse, StartMarketStatsJob, PreparedMarketStatsRequest } from './contract';
import { checkAborted, prepareMarketStats } from './prepare';

const SAMPLE_FLOORS = { refuse: 10, warn: 30 } as const;
const invalidResult = (): never => { throw new MarketStatsError('INVALID_RESULT', 'The statistics engine returned an invalid or excessive result.'); };

function validateResult(result: QueryResult, input: PreparedMarketStatsRequest): void {
    const sameQuery = (): boolean => {
        try {
            const expected = astToDsl(parseDsl(input.query.dsl!));
            return astToDsl(result.query.ast) === expected && result.query.dsl === expected
                && astToDsl({ outcome: result.query.ast.outcome }) === result.query.outcome;
        } catch { return false; }
    };
    const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
        && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
    const shape = (value: unknown, keys: string[]) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    const text = (value: unknown) => typeof value === 'string' && value.length > 0;
    const count = (value: unknown, maximum: number = LIMITS.bars): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
    const counts = (n: unknown, successes: unknown, maximum: number = result.n) => count(n, maximum) && count(successes, n);
    const probability = (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    const interval = (value: unknown) => value === null || Array.isArray(value) && value.length === 2
        && value.every(item => item !== null && probability(item)) && value[0] <= value[1];
    const frequency = (n: number, estimate: unknown, ci95: unknown) => probability(estimate) && interval(ci95)
        && (estimate === null) === (ci95 === null) && (n !== 0 || estimate === null);
    const nullableBoolean = (value: unknown) => value === null || typeof value === 'boolean';
    const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (!shape(result, ['engine', 'query', 'n', 'successes', 'estimate', 'ci95', 'guards', 'stability', 'perYear', 'recency', 'distribution', 'groups', 'sessions', 'disclaimer'])
        || !shape(result.engine, ['version', 'storeFingerprint', 'calendarVersion']) || result.engine.version !== MARKET_STATS_SOURCE.version
        || !text(result.engine.storeFingerprint) || !text(result.engine.calendarVersion)
        || !shape(result.query, ['dsl', 'ast', 'outcome', 'symbol', 'sessionKey', 'since', 'until'])
        || result.query.symbol !== input.symbol.symbol || result.query.sessionKey !== input.query.sessionKey
        || result.query.since !== (input.query.since ?? null) || result.query.until !== (input.query.until ?? null)
        || !text(result.query.dsl) || !text(result.query.outcome) || !record(result.query.ast)
        || !record(result.query.ast.outcome) || !Array.isArray(result.query.ast.outcome.args) || !sameQuery()
        || !counts(result.n, result.successes, LIMITS.bars) || !frequency(result.n, result.estimate, result.ci95)
        || !text(result.disclaimer) || !shape(result.guards, ['lowSample', 'refused', 'warnFloor', 'refuseFloor'])
        || result.guards.warnFloor !== SAMPLE_FLOORS.warn || result.guards.refuseFloor !== SAMPLE_FLOORS.refuse
        || result.guards.lowSample !== (result.n < SAMPLE_FLOORS.warn) || result.guards.refused !== (result.n < SAMPLE_FLOORS.refuse)
        || result.guards.refused && (result.estimate !== null || result.ci95 !== null)) invalidResult();

    if (!Array.isArray(result.perYear) || result.perYear.length > 12) invalidResult();
    const years = new Set<number>(); let yearN = 0; let yearSuccesses = 0;
    for (const year of result.perYear) {
        if (!shape(year, ['year', 'n', 'successes', 'estimate']) || !count(year.year, 9999) || year.year < 1000 || years.has(year.year)
            || !counts(year.n, year.successes) || !probability(year.estimate) || year.n === 0 && year.estimate !== null) invalidResult();
        years.add(year.year); yearN += year.n; yearSuccesses += year.successes;
    }
    if (yearN !== result.n || yearSuccesses !== result.successes) invalidResult();

    if ((input.query.groupBy === undefined) !== (result.groups === null)) invalidResult();
    if (result.groups !== null) {
        if (!Array.isArray(result.groups) || result.groups.length > LIMITS.groups) invalidResult();
        const names = new Set<string>(); let groupN = 0; let groupSuccesses = 0;
        for (const group of result.groups) {
            if (!shape(group, ['group', 'n', 'successes', 'estimate', 'ci95', 'lowSample']) || !text(group.group) || names.has(group.group)
                || !counts(group.n, group.successes) || !frequency(group.n, group.estimate, group.ci95)
                || group.lowSample !== (group.n < SAMPLE_FLOORS.warn)) invalidResult();
            names.add(group.group); groupN += group.n; groupSuccesses += group.successes;
        }
        if (groupN !== result.n || groupSuccesses !== result.successes) invalidResult();
    }
    if (result.stability !== null) {
        const stability = result.stability;
        if (!shape(stability, ['firstHalf', 'secondHalf', 'agree']) || !nullableBoolean(stability.agree)) invalidResult();
        for (const half of [stability.firstHalf, stability.secondHalf]) {
            if (!shape(half, ['n', 'k', 'estimate', 'ci95']) || !counts(half.n, half.k) || !frequency(half.n, half.estimate, half.ci95)) invalidResult();
        }
        if (stability.firstHalf.n + stability.secondHalf.n !== result.n || stability.firstHalf.k + stability.secondHalf.k !== result.successes
            || (!stability.firstHalf.ci95 || !stability.secondHalf.ci95) && stability.agree !== null) invalidResult();
    }
    if (result.recency !== null) {
        const recency = result.recency;
        if (!shape(recency, ['window', 'n', 'successes', 'estimate', 'ci95', 'diverges']) || !count(recency.window) || recency.window === 0
            || !counts(recency.n, recency.successes) || recency.n !== Math.min(recency.window, result.n) || recency.n >= result.n
            || recency.successes > result.successes || recency.n - recency.successes > result.n - result.successes
            || !frequency(recency.n, recency.estimate, recency.ci95) || !nullableBoolean(recency.diverges)) invalidResult();
    }
    if (result.distribution !== null) {
        const distribution = result.distribution;
        if (!shape(distribution, ['count', 'mean', 'min', 'p25', 'median', 'p75', 'p90', 'max', 'unit']) || !count(distribution.count, result.n)
            || distribution.count === 0 || typeof distribution.unit !== 'string'
            || ![distribution.mean, distribution.min, distribution.p25, distribution.median, distribution.p75, distribution.p90, distribution.max]
                .every(value => typeof value === 'number' && Number.isFinite(value))
            || distribution.min > distribution.p25 || distribution.p25 > distribution.median || distribution.median > distribution.p75
            || distribution.p75 > distribution.p90 || distribution.p90 > distribution.max
            || distribution.mean < distribution.min || distribution.mean > distribution.max) invalidResult();
    }
    if (!Array.isArray(result.sessions) || result.sessions.length > Math.min(result.n, input.query.sessionsLimit ?? 25)) invalidResult();
    const sessionIds = new Set<string>();
    for (const session of result.sessions) {
        if (!shape(session, ['sessionId', 'tradeDate', 'success', 'value']) || !text(session.sessionId) || sessionIds.has(session.sessionId)
            || !date(session.tradeDate) || typeof session.success !== 'boolean'
            || !(session.value === null || typeof session.value === 'number' && Number.isFinite(session.value))) invalidResult();
        sessionIds.add(session.sessionId);
    }
    let nodes = 0; const pending: unknown[] = [result];
    while (pending.length) {
        if (++nodes > 30_000) invalidResult();
        const value = pending.pop();
        if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
        if (typeof value === 'number') { if (!Number.isFinite(value)) invalidResult(); continue; }
        const items = Array.isArray(value) ? value : record(value) ? Object.values(value) : invalidResult();
        for (const item of items) {
            if (pending.length + nodes >= 30_000) invalidResult();
            pending.push(item);
        }
    }
    try { if (Buffer.byteLength(JSON.stringify(result), 'utf8') > LIMITS.outputBytes) invalidResult(); } catch { invalidResult(); }
}

/** Guard every view independently without changing the pinned engine's result. */
function guardedResult(source: QueryResult): { result: QueryResult; warnings: string[] } {
    const result = structuredClone(source); const warnings: string[] = [];
    const lowSample = (label: string, n: number) => {
        if (n < SAMPLE_FLOORS.warn) warnings.push(`${label}: low sample (n=${n}; warning threshold ${SAMPLE_FLOORS.warn}).${n < SAMPLE_FLOORS.refuse ? ` Estimates withheld below ${SAMPLE_FLOORS.refuse}.` : ''}`);
    };
    const frequency = (label: string, value: { n: number; estimate: number | null; ci95: [number, number] | null }) => {
        if (value.n < SAMPLE_FLOORS.refuse) { value.estimate = null; value.ci95 = null; }
        lowSample(label, value.n);
    };
    frequency('All matching sessions', result);
    for (const year of result.perYear) {
        if (year.n < SAMPLE_FLOORS.refuse) year.estimate = null;
        lowSample(`Year ${year.year}`, year.n);
    }
    for (const group of result.groups ?? []) frequency(`Group ${group.group}`, group);
    if (result.recency) {
        frequency('Recent sessions', result.recency);
        if (!result.recency.ci95 || !result.ci95) result.recency.diverges = null;
    }
    if (result.stability) {
        frequency('First stability half', result.stability.firstHalf);
        frequency('Second stability half', result.stability.secondHalf);
        if (!result.stability.firstHalf.ci95 || !result.stability.secondHalf.ci95) result.stability.agree = null;
    }
    if (result.distribution) {
        const n = result.distribution.count;
        if (n < SAMPLE_FLOORS.refuse) {
            result.distribution = null;
            warnings.push(`Outcome distribution: n=${n}; distribution withheld below ${SAMPLE_FLOORS.refuse} observations.`);
        } else lowSample('Outcome distribution', n);
    }
    return { result, warnings };
}

export function createMarketStatsService({ startJob }: { startJob: StartMarketStatsJob }) {
    let active: Promise<MarketStatsResponse> | null = null;
    let stop: AbortController | null = null; let closed = false;
    return {
        async run(input: MarketStatsInput, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<MarketStatsResponse> {
            if (closed) throw new MarketStatsError('ABORTED', 'Market statistics service is closed.');
            if (active) throw new MarketStatsError('BUSY', 'Another market statistics query is running.');
            checkAborted(options.signal);
            const timeoutMs = options.timeoutMs ?? LIMITS.defaultTimeoutMs;
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.maxTimeoutMs) throw new MarketStatsError('INVALID_INPUT', 'Invalid market statistics time limit.');
            const controller = new AbortController(); stop = controller;
            const cancel = () => controller.abort(); options.signal?.addEventListener('abort', cancel, { once: true });
            let timedOut = false; let timer: ReturnType<typeof setTimeout> | undefined;
            const task = (async () => {
                const aborted = new Promise<never>((_resolve, reject) => {
                    controller.signal.addEventListener('abort', () => reject(new MarketStatsError(timedOut ? 'TIMEOUT' : 'ABORTED', timedOut ? 'Market statistics exceeded its time limit.' : 'Market statistics computation was cancelled.')), { once: true });
                });
                // Observe early cancellation during preparation before the worker race begins.
                void aborted.catch(() => {});
                timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
                let job: ReturnType<StartMarketStatsJob> | undefined;
                try {
                    const prepared = await prepareMarketStats(input, controller.signal);
                    checkAborted(controller.signal);
                    job = startJob(prepared);
                    const result = await Promise.race([job.result, aborted]);
                    checkAborted(controller.signal); validateResult(result, prepared);
                    const guarded = guardedResult(result);
                    return { source: MARKET_STATS_SOURCE, coverage: prepared.coverage, warnings: [...prepared.warnings, ...guarded.warnings], result: guarded.result };
                } catch (error) {
                    if (controller.signal.aborted) throw new MarketStatsError(timedOut ? 'TIMEOUT' : 'ABORTED', timedOut ? 'Market statistics exceeded its time limit.' : 'Market statistics computation was cancelled.');
                    if (error instanceof MarketStatsError) throw error;
                    throw new MarketStatsError('ENGINE_FAILED', 'The market statistics engine could not complete this query.');
                } finally {
                    if (job) {
                        try { await job.dispose(); }
                        catch { throw new MarketStatsError('ENGINE_FAILED', 'The market statistics worker could not be closed safely.'); }
                    }
                }
            })();
            active = task;
            try { return await task; }
            finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); active = null; stop = null; }
        },
        async dispose(): Promise<void> {
            closed = true; stop?.abort();
            try { await active; } catch { /* The request receives its own failure. */ }
        },
    };
}
