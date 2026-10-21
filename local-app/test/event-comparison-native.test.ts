import { expect, it } from 'vitest';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MarketStatsInput } from '../server/market-stats/contract';
import { createMarketStatsService } from '../server/market-stats/service';
import { createStatsArtifactService } from '../server/market-stats/artifacts';
import { createNodeMarketStatsJobFactory, createNodeStatsArtifactJobFactory } from '../server/market-stats/node-job';
import { compareHistoricalEvents } from '../server/event-comparison';
import type { EventComparisonPorts } from '../server/event-comparison';
import { pinEventComparison } from '../shared/event-comparison';
import type { MarketStatsRequest, MarketStatsSelection } from '../shared/market-stats';
import { prepareMarketStats } from '../server/market-stats/prepare';
import { runMarketStatsEngine } from '../server/market-stats/engine';

it('compares actual guarded native session artifacts using only isolated synthetic data and manual expected measurements', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vela-event-comparison-'));
    const base = Date.UTC(2024, 0, 2), day = 86_400_000;
    const input: MarketStatsInput = { symbol: 'TEST', assetClass: 'crypto', sourceIntervalMs: 60_000,
        revealedUntil: base + 11 * day + 180_000, session: { key: 'short', start: '00:00', end: '00:03', tz: 'UTC', overnight: false },
        calendar: null, orWindows: [1], ibWindow: 1, query: { dsl: 'closeGreen' },
        events: [{ event: 'LOCAL_SYNTHETIC', version: 'test-v1', sources: ['Synthetic dates only'], coverage: { from: '2024-01-02', to: '2024-01-13' },
            dates: ['2024-01-03', '2024-01-05', '2024-01-09'] }],
        bars: Array.from({ length: 36 }, (_, i) => {
            const minute = i % 3;
            return { time: base + Math.floor(i / 3) * day + minute * 60_000, open: [100, 102, 105][minute]!, high: [103, 108, 106][minute]!,
                low: [98, 101, 96][minute]!, close: [102, 105, 97][minute]!, volume: minute + 1 };
        }) };
    const options = { workerUrl: new URL('../server/market-stats/worker.ts', import.meta.url), scratchDirectory: join(directory, 'jobs'),
        execArgv: ['--import', import.meta.resolve('tsx')] };
    const query = createMarketStatsService({ startJob: createNodeMarketStatsJobFactory(options) });
    const artifacts = createStatsArtifactService(createNodeStatsArtifactJobFactory(options));
    const request: MarketStatsRequest = { datasetId: 'synthetic', sourceMode: 'cache', from: base, until: input.revealedUntil,
        session: input.session, calendar: null, query: input.query };
    const selection: MarketStatsSelection = { datasetId: request.datasetId, name: 'Isolated synthetic', symbol: input.symbol, checksum: 'synthetic-test',
        sourceMode: 'cache', from: request.from, until: request.until };
    const ports: EventComparisonPorts = { calendars: input.events!, tickSize: 0.25,
        async runQuery(_request, signal) { return { ...await query.run(input, { signal }), selection }; },
        async readSession(_request, sessionId, signal) {
            const result = await artifacts.run(input, { kind: 'session', sessionId, contextBars: 0 }, { signal });
            if (result.kind !== 'session') throw new Error('Expected native session artifact.');
            return { ...result, selection };
        } };
    try {
        const response = await ports.runQuery(request, new AbortController().signal);
        const result = await compareHistoricalEvents({ request, pin: pinEventComparison(request, response), calendarEvent: 'LOCAL_SYNTHETIC',
            sessionIds: ['TEST|short|2024-01-03', 'TEST|short|2024-01-05'] }, ports);
        expect(result.sessions).toHaveLength(2);
        for (const session of result.sessions) {
            expect(session).toMatchObject({ barCount: 3, prices: { open: 100, high: 108, low: 96, close: 97 },
                range: { points: 12, ticks: 48, percent: 12 }, netChange: { points: -3, ticks: -12, percent: -3 },
                longMae: { points: 4, ticks: 16 }, longMfe: { points: 8, ticks: 32 } });
            expect(session.path.map(point => point.change.points)).toEqual([2, 5, -3]);
            expect(session.path.at(-1)?.time).toBe(session.endTs);
        }
        expect(await readdir(options.scratchDirectory)).toEqual([]);
        const restricted = { ...input, query: { dsl: 'closeGreen', since: '2024-01-05' } };
        const operation = { kind: 'session' as const, sessionId: 'TEST|short|2024-01-03', contextBars: 0 };
        // Prove the native membership failure itself. The existing worker transport masks INVALID_INPUT as ENGINE_FAILED.
        await expect(runMarketStatsEngine(await prepareMarketStats(restricted), { dataDirectory: join(directory, 'unmatched-native'), artifact: operation }))
            .rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'Choose a session from this exact query result.' });
        await expect(artifacts.run(restricted, operation)).rejects.toMatchObject({ code: 'ENGINE_FAILED' });
    } finally {
        await query.dispose(); await artifacts.dispose();
        const parent = await realpath(tmpdir()), resolved = await realpath(directory);
        if (dirname(resolved) !== parent || !resolved.startsWith(join(parent, 'vela-event-comparison-'))) throw new Error('Invalid owned fixture directory.');
        await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}, 20_000);
