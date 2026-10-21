import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { EventFile } from '@luxalgo/edge-stats/events';
import { Store } from '@luxalgo/edge-stats';
import { createMarketStatsService, createNodeMarketStatsJobFactory, prepareMarketStats } from '../server/market-stats';
import type { MarketStatsInput } from '../server/market-stats';
import { runMarketStatsEngine } from '../server/market-stats/engine';
import { buildPreset, getStatsPresetCatalog } from '../server/stats-presets';

const BASE = Date.UTC(2024, 0, 2); const DAY = 86_400_000;
const root = fileURLToPath(new URL('../..', import.meta.url));
const directories: string[] = []; let scratch: string; let workerUrl: URL;
const date = (index: number) => new Date(BASE + index * DAY).toISOString().slice(0, 10);
function calendar(event = 'FOMC', from = 0, to = 63, dates = [2, 8, 12]): EventFile {
    return { event, version: 'synthetic-v1', sources: ['Synthetic test calendar'], notes: 'Synthetic only.',
        coverage: { from: date(from), to: date(to) }, dates: dates.map(date) };
}
function sample(days = 64): MarketStatsInput {
    return { symbol: 'TEST', assetClass: 'crypto', sourceIntervalMs: 60_000,
        revealedUntil: BASE + (days - 1) * DAY + 61 * 60_000,
        bars: Array.from({ length: days * 61 }, (_, index) => ({ time: BASE + Math.floor(index / 61) * DAY + index % 61 * 60_000,
            open: 100, high: 105, low: 95, close: Math.floor(index / 61) % 2 === 0 ? 101 : 99, volume: 1 })),
        session: { key: 'test', start: '00:00', end: '01:01', tz: 'UTC', overnight: false }, calendar: null,
        events: [calendar('FOMC', 0, days - 1, Array.from({ length: Math.ceil(days / 2) }, (_, index) => index * 2))],
        query: { dsl: 'closeGreen', sessionsLimit: 100 } };
}
beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'vela-events-')); directories.push(scratch);
    const nativeUrl = pathToFileURL(createRequire(import.meta.url).resolve('@duckdb/node-api')).href;
    const outfile = join(scratch, 'worker.mjs');
    await build({ absWorkingDir: root, entryPoints: [join(root, 'local-app/server/market-stats/worker.ts')], outfile,
        bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['node:*'], logLevel: 'silent',
        plugins: [{ name: 'explicit-synthetic-native-runtime', setup(builder) {
            builder.onResolve({ filter: /^@duckdb\/node-api$/ }, () => ({ path: nativeUrl, external: true }));
        } }],
    });
    workerUrl = pathToFileURL(outfile);
}, 30_000);
afterAll(async () => {
    const parent = await realpath(tmpdir());
    for (const directory of directories) {
        const target = await realpath(directory);
        if (dirname(target) !== parent || !target.startsWith(join(parent, 'vela-events-'))) throw new Error('Invalid owned event fixture.');
        await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
async function native(input: MarketStatsInput) {
    const dataDirectory = await mkdtemp(join(scratch, 'native-'));
    return { result: await runMarketStatsEngine(await prepareMarketStats(input), { dataDirectory }), dataDirectory };
}
async function worker(input: MarketStatsInput) {
    const service = createMarketStatsService({ startJob: createNodeMarketStatsJobFactory({ workerUrl, scratchDirectory: join(scratch, 'jobs') }) });
    try { return await service.run(input); } finally { await service.dispose(); }
}

describe('explicit supplied local event calendars', () => {
    it('rejects ambiguous, excessive or malformed calendars before starting a worker', async () => {
        const valid = calendar();
        const invalid: unknown[] = [null, {}, [null], [valid, valid],
            [{ ...valid, extra: true }], [{ ...valid, event: '' }], [{ ...valid, event: 'FOMC\n' }],
            [{ ...valid, version: 'v'.repeat(101) }], [{ ...valid, notes: 'n'.repeat(8193) }],
            [{ ...valid, coverage: { from: '2024-02-30', to: date(63) } }],
            [{ ...valid, coverage: { from: date(63), to: date(0) } }],
            [{ ...valid, dates: [date(2), date(2)] }], [{ ...valid, dates: ['2024-02-30'] }],
            [{ ...valid, coverage: { from: date(3), to: date(63) } }],
            [{ ...valid, dates: Array(10001).fill(date(2)) }],
            Array.from({ length: 33 }, (_, index) => ({ ...valid, event: `EVENT_${index}` })),
        ];
        for (const events of invalid) await expect(prepareMarketStats({ ...sample(4), events } as MarketStatsInput)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        const input = sample(4); input.events = [calendar('FOMC', 0, 3, [])]; input.query.dsl = "closeGreen WHERE NOT eventDay('FOMC')";
        expect((await native(input)).result.n).toBe(4);
    });

    it('detaches every supplied field before yielding and fingerprints exact data and versions', async () => {
        const input = sample(); const pending = prepareMarketStats(input);
        input.events![0]!.dates.push(date(3)); input.events![0]!.sources.push('changed'); input.events![0]!.coverage.to = date(62);
        const prepared = await pending; const baseline = await prepareMarketStats(sample());
        expect(prepared.events).toEqual(baseline.events); expect(prepared.coverage.fingerprint).toBe(baseline.coverage.fingerprint);
        expect(prepared.coverage.events?.calendars).toEqual([expect.objectContaining({ event: 'FOMC', version: 'synthetic-v1', coverage: { from: date(0), to: date(63) } })]);
        for (const field of ['version', 'notes', 'sources', 'dates', 'coverage'] as const) {
            const changed = sample(); const file = changed.events![0]!;
            if (field === 'version') file.version = 'synthetic-v2';
            else if (field === 'notes') file.notes = 'different provenance';
            else if (field === 'sources') file.sources = ['other source'];
            else if (field === 'dates') file.dates = file.dates.slice(1);
            else file.coverage = { from: date(0), to: date(64) };
            const next = await prepareMarketStats(changed);
            expect(next.coverage.fingerprint, field).not.toBe(baseline.coverage.fingerprint);
            expect(next.coverage.events?.fingerprint, field).not.toBe(baseline.coverage.events?.fingerprint);
        }
    });

    it('runs positive, negated and event-outcome queries through the actual compiled worker with adequate controls', async () => {
        const input = sample();
        const control = await worker(input); expect(control.result).toMatchObject({ n: 64, successes: 32, estimate: 0.5 });
        input.query.dsl = "closeGreen WHERE eventDay('FOMC')";
        expect((await worker(input)).result).toMatchObject({ n: 32, successes: 32, estimate: 1 });
        input.query.dsl = "closeGreen WHERE NOT eventDay('FOMC')";
        expect((await worker(input)).result).toMatchObject({ n: 32, successes: 0, estimate: 0 });
        input.query.dsl = "eventOccurs('FOMC')";
        const result = (await worker(input)).result;
        expect(result).toMatchObject({ n: 64, successes: 32, estimate: 0.5, guards: { refused: false, lowSample: false } });
        expect(result.query.outcome).toBe("eventOccurs('FOMC')");
    }, 30_000);

    it('excludes uncovered dates from both negated predicates and event outcome denominators', async () => {
        const input = sample(8); input.events = [calendar('FOMC', 2, 5, [2, 4])];
        input.query.dsl = "eventOccurs('FOMC')";
        expect((await native(input)).result).toMatchObject({ n: 4, successes: 2 });
        input.query.dsl = "closeGreen WHERE NOT eventDay('FOMC')";
        const result = (await native(input)).result;
        expect(result).toMatchObject({ n: 2, successes: 0 }); expect(result.sessions.map(row => row.tradeDate).sort()).toEqual([date(3), date(5)]);
        input.events = [calendar('FOMC', 20, 21, [])];
        expect((await native(input)).result.n).toBe(0);
    });

    it('requires every event referenced in the actual AST, including NOT and OR branches', async () => {
        for (const dsl of ["closeGreen WHERE NOT eventDay('ABSENT')", "eventOccurs('ABSENT')", "closeGreen WHERE eventDay('FOMC') OR dayBeforeEvent('ABSENT')"]) {
            const input = sample(4); input.query.dsl = dsl;
            await expect(native(input)).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' });
        }
        const input = sample(4); input.events = []; input.query.dsl = "eventOccurs('FOMC')";
        await expect(native(input)).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' });
    });

    it('intersects independent event coverage for compound conditions and preserves the original native query', async () => {
        const input = sample(8); input.events = [calendar('FOMC', 1, 6, [2, 4, 6]), calendar('CPI', 3, 7, [3, 5, 7])];
        input.query.dsl = "eventOccurs('FOMC') WHERE NOT eventDay('CPI')";
        const response = await worker(input);
        expect(response.result).toMatchObject({ n: 2, successes: 2, estimate: null, guards: { refused: true } });
        expect(response.result.sessions.map(row => row.tradeDate).sort()).toEqual([date(4), date(6)]);
        expect(response.result.query.dsl).toBe(input.query.dsl);
        expect(response.coverage.events?.calendars).toHaveLength(2);
        input.query.dsl = "closeGreen WHERE eventDay('FOMC') OR NOT eventDay('CPI')";
        expect((await native(input)).result.sessions.map(row => row.tradeDate).sort()).toEqual([date(4), date(6)]);
        input.query.dsl = "closeGreen WHERE NOT eventDay('CPI') AND NOT dayBeforeEvent('FOMC')";
        expect((await native(input)).result.sessions.map(row => row.tradeDate)).toEqual([date(4)]);
    });

    it('keeps unknown neighbor rows, excludes first/last unknowns, and never shifts adjacency after coverage filtering', async () => {
        const input = sample(4); input.events = [calendar('FOMC', 1, 1, [1])];
        input.query.dsl = "closeGreen WHERE dayBeforeEvent('FOMC')";
        const before = await native(input);
        expect(before.result.n).toBe(1); expect(before.result.sessions[0]?.tradeDate).toBe(date(0));
        const store = await Store.open(before.dataDirectory);
        try {
            const rows = await store.all("SELECT CAST(trade_date AS VARCHAR) AS date, complete FROM session_features WHERE session_key='test' ORDER BY trade_date");
            expect(rows).toHaveLength(4); expect(rows.map(row => row.complete)).toEqual([true, false, false, false]);
        } finally { await store.close(); }
        input.query.dsl = "closeGreen WHERE dayAfterEvent('FOMC')";
        const after = await native(input); expect(after.result.n).toBe(1); expect(after.result.sessions[0]?.tradeDate).toBe(date(2));
        input.events = [calendar('FOMC', 0, 3, [])];
        for (const relation of ['dayBeforeEvent', 'dayAfterEvent']) {
            input.query.dsl = `closeGreen WHERE NOT ${relation}('FOMC')`;
            const result = (await native(input)).result; expect(result.n).toBe(3);
            expect(result.sessions.map(row => row.tradeDate)).not.toContain(date(relation === 'dayBeforeEvent' ? 3 : 0));
        }
    });

    it('uses the next trading feature over a weekend and keeps neighbor context beyond a query date filter', async () => {
        const input = sample(2); const friday = Date.UTC(2024, 0, 5);
        input.assetClass = 'equity'; input.bars = input.bars.map((bar, index) => ({ ...bar, time: friday + (index < 61 ? 0 : 3 * DAY) + index % 61 * 60_000 }));
        input.revealedUntil = friday + 3 * DAY + 61 * 60_000;
        input.events = [{ ...calendar(), coverage: { from: '2024-01-05', to: '2024-01-08' }, dates: ['2024-01-08'] }];
        input.query = { dsl: "closeGreen WHERE dayBeforeEvent('FOMC')", until: '2024-01-05' };
        const result = (await native(input)).result; expect(result.n).toBe(1); expect(result.sessions[0]?.tradeDate).toBe('2024-01-05');
        input.revealedUntil = friday + 61 * 60_000;
        expect((await native(input)).result.n).toBe(0);
    });

    it('does not read an event from a forming future session or bridge a raw-contract cohort', async () => {
        const input = sample(4); input.events = [calendar('FOMC', 0, 3, [3])]; input.query.dsl = "closeGreen WHERE dayBeforeEvent('FOMC')";
        expect((await native(input)).result.sessions[0]?.tradeDate).toBe(date(2));
        input.revealedUntil -= 60_000; expect((await native(input)).result.n).toBe(0);
        const roll = sample(8); roll.assetClass = 'future'; roll.symbol = 'NQ.v.0';
        const tradingDates = [0, 1, 2, 3, 6, 7, 8, 9];
        roll.bars = roll.bars.map((bar, index) => ({ ...bar, time: BASE + tradingDates[Math.floor(index / 61)]! * DAY + index % 61 * 60_000,
            contract: index < 4 * 61 ? 'NQH4' : 'NQM4', instrumentId: index < 4 * 61 ? '100' : '200' }));
        roll.revealedUntil = BASE + 9 * DAY + 61 * 60_000;
        roll.events = [calendar('FOMC', 0, 9, [6, 8])]; roll.query.dsl = "closeGreen WHERE dayBeforeEvent('FOMC')";
        const result = (await native(roll)).result; expect(result.n).toBe(1); expect(result.sessions[0]?.tradeDate).toBe(date(7));
        roll.events = [calendar('FOMC', 0, 9, [])];
        for (const relation of ['dayBeforeEvent', 'dayAfterEvent']) {
            roll.query.dsl = `closeGreen WHERE NOT ${relation}('FOMC')`;
            expect((await native(roll)).result.n).toBe(6);
        }
    });

    it('changes the native receipt when event provenance changes even with identical bar/date counts', async () => {
        const input = sample(4); input.query.dsl = "eventOccurs('FOMC')";
        const first = (await native(input)).result;
        input.events![0]!.version = 'synthetic-v2';
        const next = (await native(input)).result;
        expect(next.n).toBe(first.n); expect(next.engine.storeFingerprint).not.toBe(first.engine.storeFingerprint);
    });

    it('runs all 42 official default presets with explicitly supplied event calendars through the native pipeline', async () => {
        const input = sample(); input.events = ['CPI', 'FOMC', 'NFP', 'OPEX'].map(name => calendar(name, 0, 63, [2, 8, 12, 20, 30, 40, 50, 60]));
        const context = { events: input.events };
        expect(getStatsPresetCatalog(context).presets.every(preset => preset.availability.available)).toBe(true);
        for (const preset of getStatsPresetCatalog(context).presets) {
            const query = buildPreset({ id: preset.id }, context); input.query = { dsl: query.dsl, groupBy: query.groupBy, sessionsLimit: 0 };
            const { result } = await native(input);
            expect(result.n, preset.id).toBeGreaterThanOrEqual(0); expect(result.successes, preset.id).toBeLessThanOrEqual(result.n);
            expect(result.query.dsl, preset.id).toBe(query.dsl);
        }
    }, 60_000);

    it('does not change any original vendored source bytes', async () => {
        const { createHash } = await import('node:crypto');
        const folder = join(root, 'vendor/edge-stats');
        const manifest = JSON.parse(await readFile(join(folder, 'provenance.json'), 'utf8')) as { sourceFiles: { path: string; sha256: string }[] };
        for (const file of manifest.sourceFiles) expect(createHash('sha256').update(await readFile(join(folder, file.path))).digest('hex')).toBe(file.sha256);
    });
});
