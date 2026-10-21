import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMarketStatsService, createNodeMarketStatsJobFactory, prepareMarketStats } from '../server/market-stats';
import type { MarketStatsInput } from '../server/market-stats';
import { runMarketStatsEngine } from '../server/market-stats/engine';

const BASE = Date.UTC(2024, 0, 2);
const PROOF_ROOT = realpathSync(tmpdir());
const REPOSITORY = fileURLToPath(new URL('../..', import.meta.url));
const NATIVE_API = pathToFileURL(createRequire(import.meta.url).resolve('@duckdb/node-api')).href;
const fixtures = new Set<string>();
let scratch: string; let workerUrl: URL;
async function proofFixture() {
    const directory = mkdtempSync(join(PROOF_ROOT, 'vela-market-stats-')); fixtures.add(directory);
    const file = join(directory, 'market-stats-worker.mjs');
    await build({ absWorkingDir: REPOSITORY, entryPoints: [join(REPOSITORY, 'local-app/server/market-stats/worker.ts')], outfile: file,
        bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['node:*'], logLevel: 'silent',
        plugins: [{ name: 'explicit-native-test-runtime', setup(builder) {
            builder.onResolve({ filter: /^@duckdb\/node-api$/ }, () => ({ path: NATIVE_API, external: true }));
        } }],
    });
    return { scratch: directory, workerUrl: pathToFileURL(file) };
}
beforeAll(async () => { ({ scratch, workerUrl } = await proofFixture()); }, 30_000);
afterAll(() => {
    for (const directory of fixtures) {
        const target = realpathSync(directory);
        if (dirname(target) !== PROOF_ROOT || !target.startsWith(join(PROOF_ROOT, 'vela-market-stats-'))) throw new Error('Unexpected proof directory.');
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
function sample(days = 12): MarketStatsInput {
    return {
        bars: Array.from({ length: days * 3 }, (_, index) => {
            const day = Math.floor(index / 3); const minute = index % 3;
            return { time: BASE + day * 86_400_000 + minute * 60_000, open: 100, high: 103, low: 98, close: day % 2 === 0 ? 102 : 99, volume: 1 };
        }),
        symbol: 'TEST', assetClass: 'crypto', sourceIntervalMs: 60_000, revealedUntil: BASE + (days - 1) * 86_400_000 + 180_000,
        session: { key: 'test', start: '00:00', end: '00:03', tz: 'UTC', overnight: false }, calendar: null,
        orWindows: [1], ibWindow: 1, query: { dsl: 'closeGreen' },
    };
}
async function direct(input: MarketStatsInput) {
    const dataDirectory = mkdtempSync(join(scratch, 'direct-'));
    return runMarketStatsEngine(await prepareMarketStats(input), { dataDirectory });
}

describe('pinned full Edge Stats engine over explicit local bars', () => {
    it('does not require a pre-existing ignored directory in a fresh checkout', async () => {
        const fresh = mkdtempSync(join(scratch, 'fresh-cwd-')); const missingParent = join(fresh, '.scratchpad');
        expect(existsSync(missingParent)).toBe(false);
        const negative = spawnSync(process.execPath, ['--input-type=module', '-e', "import{mkdtempSync}from'node:fs';import{join,resolve}from'node:path';mkdtempSync(join(resolve('.scratchpad'),'market-stats-proof-'));"], { cwd: fresh, encoding: 'utf8', windowsHide: true });
        expect(negative.status).not.toBe(0); expect(negative.stderr).toContain('ENOENT');
        expect(dirname(realpathSync(scratch))).toBe(realpathSync(tmpdir()));
        const cwd = vi.spyOn(process, 'cwd').mockReturnValue(fresh);
        try {
            const fixture = await proofFixture();
            expect(dirname(fixture.scratch)).toBe(PROOF_ROOT);
            const service = createMarketStatsService({ startJob: createNodeMarketStatsJobFactory({ workerUrl: fixture.workerUrl, scratchDirectory: join(fixture.scratch, 'fresh-jobs') }) });
            try { expect((await service.run(sample())).result.n).toBe(12); } finally { await service.dispose(); }
            expect(existsSync(missingParent)).toBe(false);
        } finally { cwd.mockRestore(); }
    });

    it('withholds every low-N view from an actual compiled worker and preserves its counts', async () => {
        const request = sample(9); request.query.groupBy = 'dayOfWeek';
        const service = createMarketStatsService({ startJob: createNodeMarketStatsJobFactory({ workerUrl, scratchDirectory: join(scratch, 'low-sample-jobs') }) });
        try {
            const { result, warnings } = await service.run(request);
            expect(result.n).toBe(9); expect(result.successes).toBe(5);
            expect(result.estimate).toBeNull(); expect(result.ci95).toBeNull(); expect(result.guards.refused).toBe(true);
            expect.soft(result.perYear[0]).toMatchObject({ year: 2024, n: 9, successes: 5, estimate: null });
            expect.soft(result.groups!.every(group => group.estimate === null && group.ci95 === null && group.lowSample)).toBe(true);
            expect.soft(result.stability).toMatchObject({ firstHalf: { n: 4, k: 2, estimate: null, ci95: null }, secondHalf: { n: 5, k: 3, estimate: null, ci95: null }, agree: null });
            expect.soft(result.distribution).toBeNull(); expect(result.sessions).toHaveLength(9);
            expect.soft(warnings.join(' ')).toMatch(/distribution.*9.*withheld|distribution.*withheld.*9/i);
        } finally { await service.dispose(); }
    });

    it('gates native stability halves independently and warns for supported low samples', async () => {
        const service = createMarketStatsService({ startJob: createNodeMarketStatsJobFactory({ workerUrl, scratchDirectory: join(scratch, 'half-jobs') }) });
        try {
            const response = await service.run(sample(19)); const result = response.result;
            expect(result.n).toBe(19); expect(result.guards).toMatchObject({ refused: false, lowSample: true });
            expect(result.stability!.firstHalf).toMatchObject({ n: 9, k: 5, estimate: null, ci95: null });
            expect(result.stability!.secondHalf.n).toBe(10); expect(result.stability!.secondHalf.estimate).toBe(0.5);
            expect(result.stability!.secondHalf.ci95).not.toBeNull(); expect(result.stability!.agree).toBeNull();
            expect(result.distribution!.count).toBe(19); expect(response.warnings.join(' ')).toMatch(/Second stability half.*n=10/);
        } finally { await service.dispose(); }
    });

    it('withholds a sparse native year even when the total and another year qualify', async () => {
        const request = sample(40); const shift = Date.UTC(2023, 11, 23) - BASE;
        request.bars = request.bars.map(bar => ({ ...bar, time: bar.time + shift })); request.revealedUntil += shift;
        const service = createMarketStatsService({ startJob: createNodeMarketStatsJobFactory({ workerUrl, scratchDirectory: join(scratch, 'year-jobs') }) });
        try {
            const response = await service.run(request); const result = response.result;
            expect(result.n).toBe(40); expect(result.estimate).toBe(0.5);
            expect(result.perYear.find(year => year.year === 2023)).toEqual({ year: 2023, n: 9, successes: 5, estimate: null });
            expect(result.perYear.find(year => year.year === 2024)).toEqual({ year: 2024, n: 31, successes: 15, estimate: 0.4839 });
            expect(response.warnings.join(' ')).toMatch(/Year 2023.*n=9/);
        } finally { await service.dispose(); }
    });

    it('preserves adequate native estimates, groups, recency, halves and distributions', async () => {
        const request = sample(251); request.query.groupBy = 'dayOfWeek';
        const service = createMarketStatsService({ startJob: createNodeMarketStatsJobFactory({ workerUrl, scratchDirectory: join(scratch, 'adequate-jobs') }) });
        try {
            const response = await service.run(request); const result = response.result;
            expect(result.n).toBe(251); expect(result.successes).toBe(126); expect(result.estimate).toBeCloseTo(126 / 251, 4);
            expect(result.guards).toMatchObject({ refused: false, lowSample: false });
            expect(result.groups!.every(group => group.n >= 30 && group.estimate !== null && group.ci95 !== null && !group.lowSample)).toBe(true);
            expect(result.perYear[0]).toMatchObject({ year: 2024, n: 251 }); expect(result.perYear[0]!.estimate).not.toBeNull();
            expect(result.recency).toMatchObject({ window: 250, n: 250, successes: 125, estimate: 0.5 }); expect(result.recency!.ci95).not.toBeNull();
            expect(result.stability!.firstHalf.n).toBe(125); expect(result.stability!.secondHalf.n).toBe(126);
            expect(result.stability!.firstHalf.estimate).not.toBeNull(); expect(result.stability!.secondHalf.estimate).not.toBeNull();
            expect(result.stability!.agree).not.toBeNull(); expect(result.distribution!.count).toBe(251);
            expect(response.warnings).toEqual(['Schedule-only calendar: exchange holidays and early closes are not supplied.']);
        } finally { await service.dispose(); }
    });

    it('reproduces hand-counted sessions with Wilson intervals, groups and provenance without network', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Network is forbidden in this fixture.'); });
        try {
            const input = sample(); input.query.groupBy = 'dayOfWeek';
            const result = await direct(input);
            expect(result.engine.version).toBe('0.1.0'); expect(result.n).toBe(12); expect(result.successes).toBe(6);
            expect(result.estimate).toBe(0.5); expect(result.ci95![0]).toBeCloseTo(0.25378, 4); expect(result.ci95![1]).toBeCloseTo(0.74622, 4);
            expect(result.guards).toMatchObject({ lowSample: true, refused: false });
            expect(result.stability).toMatchObject({ firstHalf: { n: 6, k: 3 }, secondHalf: { n: 6, k: 3 }, agree: true });
            expect(result.perYear).toEqual([{ year: 2024, n: 12, successes: 6, estimate: 0.5 }]);
            expect(result.groups!.reduce((total, group) => total + group.n, 0)).toBe(12);
            expect(result.sessions).toHaveLength(12); expect(fetch).not.toHaveBeenCalled();
        } finally { fetch.mockRestore(); }
    });

    it('withholds small samples and does not count a forming session even inside upstream grace', async () => {
        const small = await direct(sample(9)); expect(small.n).toBe(9); expect(small.estimate).toBeNull(); expect(small.ci95).toBeNull();
        const input = sample(); input.revealedUntil -= 60_000;
        const beforeClose = await direct(input); expect(beforeClose.n).toBe(11); expect(beforeClose.successes).toBe(6);
        const afterClose = await direct(sample()); expect(afterClose.n).toBe(12); expect(afterClose.successes).toBe(6);
    });

    it('rejects unsupported event-dependent expressions and invalid queries', async () => {
        const input = sample(); input.query.dsl = "closeGreen WHERE NOT eventDay('FOMC')";
        await expect(direct(input)).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' });
        input.query.dsl = 'inventedOutcome'; await expect(direct(input)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
        input.query.dsl = 'closeGreen'; input.query.groupBy = 'inventedGrouping';
        await expect(direct(input)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    });

    it('uses only the explicitly supplied calendar and fingerprints it', async () => {
        const input = sample();
        input.calendar = { exchange: 'CRYPTO', version: 'local-fixture', sources: [], coverage: { from: '2024-01-01', to: '2024-01-31' }, holidays: [{ date: '2024-01-03', name: 'Synthetic holiday' }], halfDays: [] };
        const provided = await direct(input); const scheduleOnly = await direct(sample());
        expect(provided.n).toBe(11); expect(provided.successes).toBe(6);
        expect(provided.engine.calendarVersion).not.toBe(scheduleOnly.engine.calendarVersion);
        expect(provided.sessions.some(session => session.tradeDate === '2024-01-03')).toBe(false);
        input.calendar.coverage.to = '2024-01-05'; await expect(direct(input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('never uses a forming future session to answer a next-session outcome', async () => {
        const input = sample(); input.query.dsl = 'nextCloseGreen';
        const complete = await direct(input); expect(complete.n).toBe(11); expect(complete.successes).toBe(5);
        input.revealedUntil -= 60_000;
        const cutoff = await direct(input); expect(cutoff.n).toBe(10); expect(cutoff.successes).toBe(5);
        expect(cutoff.sessions.every(session => session.tradeDate <= '2024-01-11')).toBe(true);
    });

    it('returns unavailable estimates for an empty local dataset', async () => {
        const input = sample(); input.bars = [];
        const result = await direct(input); expect(result.n).toBe(0); expect(result.estimate).toBeNull(); expect(result.ci95).toBeNull();
    });

    it('closes native handles on a completed run so the store can be reopened', async () => {
        const input = await prepareMarketStats(sample()); const dataDirectory = mkdtempSync(join(scratch, 'close-'));
        await runMarketStatsEngine(input, { dataDirectory });
        const { Store } = await import('@luxalgo/edge-stats'); const store = await Store.open(dataDirectory);
        try { expect((await store.one('SELECT 1 AS ready'))?.ready).toBe(1); } finally { await store.close(); }
    });

    it('runs the compiled worker without a TypeScript loader and removes its ephemeral store', async () => {
        const scratchDirectory = join(scratch, 'worker-jobs');
        const service = createMarketStatsService({ startJob: createNodeMarketStatsJobFactory({ workerUrl, scratchDirectory }) });
        try {
            const response = await service.run(sample());
            expect(response.result.n).toBe(12); expect(response.result.successes).toBe(6);
            expect(response.result.estimate).toBe(0.5); expect(readdirSync(scratchDirectory)).toEqual([]);
        } finally { await service.dispose(); }
    });

    it('terminates an actual in-flight worker on cancellation and removes its scratch data', async () => {
        const scratchDirectory = join(scratch, 'cancel-jobs');
        const factory = createNodeMarketStatsJobFactory({ workerUrl, scratchDirectory });
        let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
        const service = createMarketStatsService({ startJob: input => { const job = factory(input); started(); return job; } });
        const controller = new AbortController();
        const pending = service.run(sample(), { signal: controller.signal });
        const cancelled = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
        await ready; controller.abort(); await cancelled;
        expect(readdirSync(scratchDirectory)).toEqual([]); await service.dispose();
    });

    it('sanitizes worker errors and cleans up workers that exit without a result', async () => {
        const file = join(scratch, 'error-worker.mjs');
        writeFileSync(file, "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({type:'market-stats:error',error:{code:'ENGINE_FAILED',message:'PRIVATE_PROFILE_PATH'}}); parentPort.close();");
        const scratchDirectory = join(scratch, 'error-jobs');
        const service = createMarketStatsService({ startJob: createNodeMarketStatsJobFactory({ workerUrl: pathToFileURL(file), scratchDirectory }) });
        await expect(service.run(sample())).rejects.toMatchObject({ code: 'ENGINE_FAILED', message: 'The market statistics worker could not complete this query.' });
        expect(readdirSync(scratchDirectory)).toEqual([]); await service.dispose();
        writeFileSync(file, "import { parentPort } from 'node:worker_threads'; parentPort.close();");
        const exited = createMarketStatsService({ startJob: createNodeMarketStatsJobFactory({ workerUrl: pathToFileURL(file), scratchDirectory }) });
        await expect(exited.run(sample())).rejects.toMatchObject({ code: 'ENGINE_FAILED' });
        expect(readdirSync(scratchDirectory)).toEqual([]); await exited.dispose();
    });
});
