import { describe, expect, it, vi } from 'vitest';
import type { QueryResult } from '@luxalgo/edge-stats';
import { createMarketStatsService, prepareMarketStats, MARKET_STATS_LIMITS } from '../server/market-stats';
import type { MarketStatsInput, PreparedMarketStatsRequest } from '../server/market-stats';

const BASE = Date.UTC(2024, 0, 2);
function input(): MarketStatsInput {
    return {
        bars: Array.from({ length: 4 }, (_, index) => ({ time: BASE + index * 60_000, open: 100, high: 102, low: 99, close: 101, volume: 1 })),
        symbol: 'TEST', assetClass: 'crypto', sourceIntervalMs: 60_000, revealedUntil: BASE + 180_000,
        session: { key: 'test', start: '00:00', end: '00:03', tz: 'UTC', overnight: false }, calendar: null,
        query: { dsl: 'closeGreen' },
    };
}
function result(): QueryResult {
    return {
        engine: { version: '0.1.0', storeFingerprint: 'fixture', calendarVersion: 'fixture' },
        query: { dsl: 'closeGreen', ast: { outcome: { name: 'closeGreen', args: [] } }, outcome: 'closeGreen', symbol: 'TEST', sessionKey: 'test', since: null, until: null },
        n: 0, successes: 0, estimate: null, ci95: null,
        guards: { lowSample: true, refused: true, warnFloor: 30, refuseFloor: 10 },
        stability: null, perYear: [], recency: null, distribution: null, groups: null, sessions: [],
        disclaimer: 'Historical conditional frequencies with sample sizes. Not predictions, not advice.',
    };
}
function populatedResult(): QueryResult {
    return {
        ...result(), n: 40, successes: 20, estimate: 0.5, ci95: [0.35, 0.65],
        guards: { lowSample: false, refused: false, warnFloor: 30, refuseFloor: 10 },
        perYear: [{ year: 2023, n: 9, successes: 4, estimate: 0.4444 }, { year: 2024, n: 31, successes: 16, estimate: 0.5161 }],
        groups: [{ group: 'small', n: 9, successes: 4, estimate: 0.4444, ci95: [0.18, 0.73], lowSample: true },
            { group: 'large', n: 31, successes: 16, estimate: 0.5161, ci95: [0.34, 0.69], lowSample: false }],
        recency: { window: 9, n: 9, successes: 4, estimate: 0.4444, ci95: [0.18, 0.73], diverges: false },
        stability: { firstHalf: { n: 20, k: 10, estimate: 0.5, ci95: [0.3, 0.7] }, secondHalf: { n: 20, k: 10, estimate: 0.5, ci95: [0.3, 0.7] }, agree: true },
        distribution: { count: 9, mean: 1, min: 0, p25: 0.5, median: 1, p75: 1.5, p90: 1.8, max: 2, unit: '%' },
        sessions: [{ sessionId: 'fixture', tradeDate: '2024-01-02', success: true, value: 1 }],
    };
}

describe('Market Stats replay input boundary', () => {
    it('sends only fully closed source bars in a detached snapshot with a reproducible fingerprint', async () => {
        const request = input(); const snapshot = await prepareMarketStats(request);
        expect(snapshot.bars.map(bar => bar.ts)).toEqual([BASE, BASE + 60_000, BASE + 120_000]);
        expect(snapshot.coverage).toMatchObject({ eligibleBarCount: 3, excludedFutureBars: 1, lastBarClose: BASE + 180_000, calendarMode: 'schedule-only' });
        request.bars[0]!.close = 999;
        expect(snapshot.bars[0]!.close).toBe(101);
        expect(snapshot.coverage.fingerprint).toBe((await prepareMarketStats(input())).coverage.fingerprint);
        const changed = input(); changed.revealedUntil -= 1;
        expect((await prepareMarketStats(changed)).bars).toHaveLength(2);
        expect((await prepareMarketStats(changed)).coverage.fingerprint).not.toBe(snapshot.coverage.fingerprint);
        expect(snapshot.warnings.join(' ')).toMatch(/holidays.*early closes/i);
    });

    it.each([
        ['one-second bars', (value: MarketStatsInput) => { (value as { sourceIntervalMs: number }).sourceIntervalMs = 1000; }],
        ['invalid OHLC', (value: MarketStatsInput) => { value.bars[0]!.high = 90; }],
        ['duplicate opens', (value: MarketStatsInput) => { value.bars[1]!.time = BASE; }],
        ['unsafe symbol', (value: MarketStatsInput) => { value.symbol = '../TEST,other'; }],
        ['missing calendar policy', (value: MarketStatsInput) => { delete (value as Partial<MarketStatsInput>).calendar; }],
        ['sub-minute cutoff', (value: MarketStatsInput) => { value.revealedUntil = NaN; }],
        ['invalid timezone', (value: MarketStatsInput) => { value.session.tz = 'Not/A_Zone'; }],
        ['invalid session clock', (value: MarketStatsInput) => { value.session.start = '24:15'; }],
        ['unbounded drilldown', (value: MarketStatsInput) => { value.query.sessionsLimit = MARKET_STATS_LIMITS.sessions + 1; }],
        ['force low samples', (value: MarketStatsInput) => { Object.assign(value.query, { force: true }); }],
        ['excessive windows', (value: MarketStatsInput) => { value.orWindows = Array.from({ length: 13 }, (_, index) => index + 1); }],
    ])('rejects %s before starting an engine', async (_name, mutate) => {
        const request = input(); mutate(request);
        await expect(prepareMarketStats(request)).rejects.toHaveProperty('code');
    });

    it('enforces bar and date span limits before computation', async () => {
        const request = input(); request.bars = new Array(MARKET_STATS_LIMITS.bars + 1);
        await expect(prepareMarketStats(request)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        const long = input(); long.bars = [long.bars[0]!, { ...long.bars[0]!, time: BASE + MARKET_STATS_LIMITS.spanMs + 60_000 }];
        await expect(prepareMarketStats(long)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
});

describe('Market Stats cancellable job service', () => {
    it.each([
        ['forged top-level guards', (value: QueryResult) => { value.guards.refused = false; }],
        ['non-boolean guard', (value: QueryResult) => { (value.guards as unknown as { lowSample: unknown }).lowSample = 'true'; }],
        ['forged minimum', (value: QueryResult) => { value.guards.refuseFloor = 0; }],
        ['negative nested count', (value: QueryResult) => { value.perYear = [{ year: 2024, n: -1, successes: 0, estimate: null }]; }],
        ['nested probability outside its domain', (value: QueryResult) => { value.perYear = [{ year: 2024, n: 0, successes: 0, estimate: 2 }]; }],
        ['malformed nested interval', (value: QueryResult) => { value.groups = [{ group: 'Tue', n: 0, successes: 0, estimate: null, ci95: [0.8, 0.2], lowSample: true }]; }],
        ['invalid recency shape', (value: QueryResult) => { value.recency = { window: 9, n: 0, successes: 0, estimate: null, ci95: null, diverges: 'yes' } as unknown as QueryResult['recency']; }],
        ['invalid stability shape', (value: QueryResult) => { value.stability = { firstHalf: {}, secondHalf: {}, agree: true } as QueryResult['stability']; }],
        ['invalid distribution quantiles', (value: QueryResult) => { value.distribution = { count: 0, mean: 1, min: 2, p25: 1, median: 1, p75: 1, p90: 1, max: 0, unit: '%' }; }],
        ['invalid session reference', (value: QueryResult) => { value.sessions = [{ sessionId: 'fixture', tradeDate: 'invalid', success: true, value: null }]; }],
    ])('rejects %s instead of hiding a malformed foreign result', async (_name, mutate) => {
        const value = result(); mutate(value); const dispose = vi.fn(async () => {});
        const service = createMarketStatsService({ startJob: () => ({ result: Promise.resolve(value), dispose }) });
        const request = input(); if (value.groups !== null) request.query.groupBy = 'dayOfWeek';
        await expect(service.run(request)).rejects.toMatchObject({ code: 'INVALID_RESULT' });
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('guards each view using its own sample size in a detached envelope', async () => {
        const original = populatedResult(); const before = structuredClone(original);
        const service = createMarketStatsService({ startJob: () => ({ result: Promise.resolve(original), dispose: async () => {} }) });
        const request = input(); request.query.groupBy = 'dayOfWeek';
        const response = await service.run(request); const value = response.result;
        expect(value.n).toBe(40); expect(value.estimate).toBe(0.5); expect(value.ci95).toEqual([0.35, 0.65]);
        expect(value.perYear).toEqual([{ year: 2023, n: 9, successes: 4, estimate: null }, { year: 2024, n: 31, successes: 16, estimate: 0.5161 }]);
        expect(value.groups![0]).toMatchObject({ n: 9, successes: 4, estimate: null, ci95: null, lowSample: true });
        expect(value.groups![1]).toEqual(before.groups![1]);
        expect(value.recency).toEqual({ window: 9, n: 9, successes: 4, estimate: null, ci95: null, diverges: null });
        expect(value.stability).toEqual(before.stability); expect(value.distribution).toBeNull(); expect(value.sessions).toEqual(before.sessions);
        expect(response.warnings.join(' ')).toMatch(/Recent sessions.*n=9/);
        expect(response.warnings.join(' ')).toMatch(/First stability half.*n=20/);
        expect(response.warnings.join(' ')).toMatch(/distribution.*n=9.*withheld/);
        expect(original).toEqual(before); expect(value).not.toBe(original);
        value.sessions[0]!.value = 123; value.stability!.firstHalf.ci95![0] = 0;
        expect(original).toEqual(before); await service.dispose();
    });

    it.each([
        ['inconsistent year totals', (value: QueryResult) => { value.perYear[0]!.n--; }],
        ['inconsistent group totals', (value: QueryResult) => { value.groups![0]!.successes--; }],
        ['forged group warning', (value: QueryResult) => { value.groups![0]!.lowSample = false; }],
        ['invalid recency interval', (value: QueryResult) => { value.recency!.ci95 = [0.8, 0.2]; }],
        ['invalid stability probability', (value: QueryResult) => { value.stability!.firstHalf.estimate = 2; }],
        ['inconsistent stability totals', (value: QueryResult) => { value.stability!.firstHalf.k--; }],
        ['additional unvalidated estimates', (value: QueryResult) => { Object.assign(value.perYear[0]!, { ci95: [0.1, 0.9] }); }],
    ])('rejects %s before applying withholding', async (_name, mutate) => {
        const value = populatedResult(); mutate(value); const before = structuredClone(value);
        const service = createMarketStatsService({ startJob: () => ({ result: Promise.resolve(value), dispose: async () => {} }) });
        const request = input(); request.query.groupBy = 'dayOfWeek';
        await expect(service.run(request)).rejects.toMatchObject({ code: 'INVALID_RESULT' });
        expect(value).toEqual(before); await service.dispose();
    });

    it('preserves unavailable values and disposes a successful job exactly once', async () => {
        const dispose = vi.fn(async () => {}); let prepared: PreparedMarketStatsRequest | undefined;
        const service = createMarketStatsService({ startJob: value => { prepared = value; return { result: Promise.resolve(result()), dispose }; } });
        const response = await service.run(input());
        expect(prepared?.bars).toHaveLength(3);
        expect(response.result.estimate).toBeNull(); expect(response.result.ci95).toBeNull();
        expect(response.result.distribution).toBeNull(); expect(dispose).toHaveBeenCalledTimes(1);
        await service.dispose(); expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('rejects a pre-aborted request without invoking the worker', async () => {
        const startJob = vi.fn(); const service = createMarketStatsService({ startJob });
        await expect(service.run(input(), { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'ABORTED' });
        expect(startJob).not.toHaveBeenCalled();
    });

    it('terminates on cancellation and refuses overlapping jobs', async () => {
        const controller = new AbortController(); const dispose = vi.fn(async () => {});
        let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
        const service = createMarketStatsService({ startJob: () => { started(); return { result: new Promise(() => {}), dispose }; } });
        const pending = service.run(input(), { signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' }); await ready;
        await expect(service.run(input())).rejects.toMatchObject({ code: 'BUSY' });
        controller.abort(); await rejected; expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('terminates on timeout and permits a later run', async () => {
        const dispose = vi.fn(async () => {}); let runs = 0;
        const service = createMarketStatsService({ startJob: () => ({ result: runs++ === 0 ? new Promise(() => {}) : Promise.resolve(result()), dispose }) });
        await expect(service.run(input(), { timeoutMs: 5 })).rejects.toMatchObject({ code: 'TIMEOUT' });
        expect(dispose).toHaveBeenCalledTimes(1);
        await expect(service.run(input())).resolves.toHaveProperty('result.n', 0);
    });

    it('closes an in-flight worker when the service is disposed', async () => {
        const dispose = vi.fn(async () => {}); let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        const service = createMarketStatsService({ startJob: () => { started(); return { result: new Promise(() => {}), dispose }; } });
        const pending = expect(service.run(input())).rejects.toMatchObject({ code: 'ABORTED' });
        await ready; await service.dispose(); await pending;
        expect(dispose).toHaveBeenCalledTimes(1);
        await expect(service.run(input())).rejects.toMatchObject({ code: 'ABORTED' });
    });

    it('rejects malformed or excessive output and disposes failed jobs', async () => {
        const dispose = vi.fn(async () => {}); const invalid = result(); invalid.estimate = NaN;
        const service = createMarketStatsService({ startJob: () => ({ result: Promise.resolve(invalid), dispose }) });
        await expect(service.run(input())).rejects.toMatchObject({ code: 'INVALID_RESULT' });
        expect(dispose).toHaveBeenCalledTimes(1);
        invalid.estimate = null; invalid.sessions = Array.from({ length: 101 }, () => ({ sessionId: 'fixture', tradeDate: '2024-01-02', success: true, value: null }));
        await expect(service.run(input())).rejects.toMatchObject({ code: 'INVALID_RESULT' });
    });

    it('does not expose private cleanup errors', async () => {
        const service = createMarketStatsService({ startJob: () => ({ result: Promise.resolve(result()), dispose: async () => { throw new Error('PRIVATE_PROFILE_PATH'); } }) });
        await expect(service.run(input())).rejects.toMatchObject({ code: 'ENGINE_FAILED', message: 'The market statistics worker could not be closed safely.' });
    });
});
