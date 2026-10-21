import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarketStatsService, createNodeMarketStatsJobFactory, type MarketStatsInput } from '../server/market-stats';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
it.each(['orbBreak(1m, any)', 'hit(retOcPct, gte, 0)', 'gapHold(any)'])('accepts the native canonical parameterized outcome %s through the guarded worker service', async dsl => {
    const directory = await mkdtemp(join(tmpdir(), 'vela-stats-params-')); directories.push(directory);
    const base = Date.UTC(2024, 0, 1);
    const input: MarketStatsInput = { symbol: 'TEST', assetClass: 'crypto', sourceIntervalMs: 60000,
        revealedUntil: base + 11 * 86400000 + 180000,
        bars: Array.from({ length: 36 }, (_, i) => ({ time: base + Math.floor(i / 3) * 86400000 + i % 3 * 60000, open: 100, high: 102, low: 99, close: 101, volume: 1 })),
        session: { key: 'short', start: '00:00', end: '00:03', tz: 'UTC', overnight: false }, calendar: null, orWindows: [1], ibWindow: 1, query: { dsl } };
    const service = createMarketStatsService({ startJob: createNodeMarketStatsJobFactory({ workerUrl: new URL('../server/market-stats/worker.ts', import.meta.url), scratchDirectory: directory, execArgv: ['--import', import.meta.resolve('tsx')] }) });
    try { const response = await service.run(input); expect(response.result.query.outcome).toBe(dsl); expect(response.result.query.dsl).toBe(dsl); }
    finally { await service.dispose(); }
}, 15000);
