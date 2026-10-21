import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarketStatsService, createNodeMarketStatsJobFactory, prepareMarketStats, type MarketStatsInput } from '../server/market-stats';
import { runMarketStatsEngine } from '../server/market-stats/engine';

const start = Date.UTC(2024, 0, 2); const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
function sample(): MarketStatsInput {
    return { symbol: 'NQ.v.0', assetClass: 'future', sourceIntervalMs: 60000, revealedUntil: start + 2 * 86400000 + 180000,
        bars: Array.from({ length: 9 }, (_, i) => { const day = Math.floor(i / 3); return { time: start + day * 86400000 + i % 3 * 60000,
            open: day === 0 ? 100 : day === 1 ? 1000 : 1001, high: day === 0 ? 101 : 1002, low: day === 0 ? 99 : 1000,
            close: day === 0 ? 100 : day === 1 ? 1000 : 1002, volume: 1, instrumentId: day === 0 ? '100' : '200', contract: day === 0 ? 'NQH4' : 'NQM4' }; }),
        session: { key: 'short', start: '00:00', end: '00:03', tz: 'UTC', overnight: false }, calendar: null, orWindows: [1], ibWindow: 1, query: { dsl: 'gapFill' } };
}
async function native(input: MarketStatsInput) {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'vela-continuous-stats-')); directories.push(dataDirectory);
    return runMarketStatsEngine(await prepareMarketStats(input), { dataDirectory });
}
it('detaches verified raw contracts and provider identities without replacing them by the continuous alias', async () => {
    const input = sample(); const prepared = await prepareMarketStats(input);
    expect(prepared.bars.map(bar => bar.contract)).toEqual(['NQH4', 'NQH4', 'NQH4', 'NQM4', 'NQM4', 'NQM4', 'NQM4', 'NQM4', 'NQM4']);
    expect(prepared.bars[0]).toHaveProperty('instrumentId', '100');
    expect(prepared.warnings.join(' ')).toMatch(/contract roll/i);
    expect(input.bars[0]!.contract).toBe('NQH4');
});
it('rejects missing, partial, injected and mismatched continuous identities before worker creation', async () => {
    for (const identity of [{}, { contract: 'NQH4' }, { instrumentId: '100' }, { instrumentId: '100', contract: 'GCG4' }, { instrumentId: '100', contract: 'NQH4,invalid' }]) {
        const input = sample(); const bars = input.bars.map(({ instrumentId: _id, contract: _contract, ...bar }) => ({ ...bar, ...identity }));
        await expect(prepareMarketStats({ ...input, bars })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
});
it('uses the real engine roll guard so a contract price jump is not counted as an overnight gap', async () => {
    const result = await native(sample());
    expect(result.n).toBe(1); expect(result.sessions.map(row => row.tradeDate)).toEqual(['2024-01-04']);
    expect(result.successes).toBe(1);
});
it('excludes a session that mixes contracts even when it is the first available session', async () => {
    const input = sample(); input.query.dsl = 'closeGreen';
    const bars = input.bars.map((bar, i) => i === 1 || i === 2 ? { ...bar, contract: 'NQM4', instrumentId: '200' } : bar);
    const result = await native({ ...input, bars });
    expect(result.n).toBe(2); expect(result.sessions.map(row => row.tradeDate)).not.toContain('2024-01-02');
});
it('marks the first complete session of a new contract as a roll and does not bridge a mixed session', async () => {
    const input = sample(); input.query.dsl = 'closeGreen WHERE rollDay';
    const result = await native(input);
    expect(result.n).toBe(1); expect(result.sessions[0]?.tradeDate).toBe('2024-01-03');
});
it('preserves identity through the actual worker protocol and the guarded service result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vela-continuous-stats-')); directories.push(directory);
    const service = createMarketStatsService({ startJob: createNodeMarketStatsJobFactory({ workerUrl: new URL('../server/market-stats/worker.ts', import.meta.url),
        scratchDirectory: directory, execArgv: ['--import', import.meta.resolve('tsx')] }) });
    try {
        const response = await service.run(sample());
        expect(response.result).toMatchObject({ n: 1, successes: 1, estimate: null, guards: { refused: true } });
        expect(response.warnings.join(' ')).toContain('contract roll');
    } finally { await service.dispose(); }
}, 15000);
it('never duplicates previous features when the final contract has no complete session', async () => {
    const input = sample(); input.query = { dsl: 'closeGreen', sessionsLimit: 0 };
    const base = Date.UTC(2024, 0, 1);
    const bars = Array.from({ length: 16 }, (_, index) => ({ time: base + (index < 15 ? Math.floor(index / 3) : 7) * 86400000 + index % 3 * 60000,
        open: 100, high: 101, low: 99, close: 101, volume: 1, instrumentId: index < 15 ? '100' : '200', contract: index < 15 ? 'NQH4' : 'NQM4' }));
    const result = await native({ ...input, bars, revealedUntil: bars[15]!.time + 60000 });
    expect(result.n).toBe(5); expect(result.guards.refused).toBe(true); expect(result.estimate).toBeNull();
});
it('marks the first complete roll separately for the requested RTH session', async () => {
    const input = sample(); const base = Date.UTC(2024, 0, 1, 23);
    const bars = Array.from({ length: 2880 }, (_, index) => ({ time: base + index * 60000, open: 100, high: 101, low: 99, close: 101, volume: 1,
        contract: index < 1440 ? 'NQH4' : 'NQM4', instrumentId: index < 1440 ? '100' : '200' }));
    const result = await native({ ...input, bars, revealedUntil: base + 2880 * 60000,
        session: { key: 'rth', start: '09:30', end: '16:00', tz: 'America/New_York', overnight: false }, query: { dsl: 'closeGreen WHERE rollDay' } });
    expect(result.n).toBe(1); expect(result.sessions.map(row => row.tradeDate)).toEqual(['2024-01-03']);
});
