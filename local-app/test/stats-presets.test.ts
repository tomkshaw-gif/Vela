import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildPreset, getStatsPresetCatalog } from '../server/stats-presets';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixtures: string[] = [];
afterAll(async () => {
    const parent = await realpath(tmpdir());
    for (const fixture of fixtures) {
        const resolved = await realpath(fixture);
        if (dirname(resolved) !== parent || !resolved.startsWith(join(parent, 'vela-preset-'))) throw new Error('Invalid owned preset fixture.');
        await rm(resolved, { recursive: true, force: true });
    }
});

describe('official local statistics preset catalog', () => {
    it('includes all 42 originals, 11 categories and 121 structurally named variants', () => {
        const catalog = getStatsPresetCatalog();
        expect(catalog.total).toBe(42); expect(catalog.presets).toHaveLength(42);
        expect(catalog.categories).toHaveLength(11); expect(catalog.namedVariants).toBe(121);
        expect(new Set(catalog.presets.map(preset => preset.id)).size).toBe(42);
        expect(catalog.categories.reduce((sum, category) => sum + category.count, 0)).toBe(42);
        expect(catalog.presets.reduce((sum, preset) => sum + preset.namedVariants, 0)).toBe(121);
        for (const preset of catalog.presets) {
            expect(preset.summary.length).toBeGreaterThan(80); expect(preset.version).toBeGreaterThanOrEqual(1);
            for (const reference of preset.library) expect(reference.url).toBe(`https://www.luxalgo.com/library/${reference.kind}/${reference.slug}/`);
        }
        expect(catalog.presets.filter(preset => preset.library.length > 0)).toHaveLength(33);
        expect(catalog.presets.find(preset => preset.id === 'orb')?.params).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'window', type: 'duration', default: 15 }),
            expect.objectContaining({ name: 'dir', type: 'enum', values: ['up', 'down', 'any'], default: 'any' }),
        ]));
    });

    it('composes default and enum variants with the unchanged upstream composer', async () => {
        const { bundledPresets } = await import('@luxalgo/edge-stats/preset-catalog');
        const { composePresetDsl, presetSchema } = await import('@luxalgo/edge-stats/presets');
        const { compileQuery, parseDsl } = await import('@luxalgo/edge-stats/query-tools');
        for (const raw of bundledPresets) {
            const preset = presetSchema.parse(raw);
            const cases: Record<string, number | string>[] = [{}];
            for (const parameter of preset.params) if (parameter.type === 'enum') for (const value of parameter.values ?? []) cases.push({ [parameter.name]: value });
            for (const params of cases) {
                const expected = composePresetDsl(preset, params);
                expect(() => compileQuery(parseDsl(expected.dsl), { orWindows: [5, 10, 15, 30, 60], ibWindow: 60 })).not.toThrow();
                if (preset.category === 'events') expect(() => buildPreset({ id: preset.id, params })).toThrow(/local event/i);
                else expect(buildPreset({ id: preset.id, params })).toEqual({ dsl: expected.dsl,
                    ...(preset.groupBy ? { groupBy: preset.groupBy } : {}),
                    preset: { id: preset.id, version: preset.version, title: preset.title, params: expected.resolved } });
            }
        }
        expect(buildPreset({ id: 'gap-fill', params: { minGapPct: 0.15, dir: 'down' }, groupBy: 'dayOfWeek' })).toMatchObject({
            dsl: 'gapFill WHERE absGapPct >= 0.15 AND gapDir = down', groupBy: 'dayOfWeek',
            preset: { params: { minGapPct: 0.15, dir: 'down' } },
        });
        expect(buildPreset({ id: 'orb-target', params: { window: 120, r: 2, dir: 'up' } }, { orWindows: [120] }).dsl).toBe('orbTargetHit(120m, 2, up)');
        expect(buildPreset({ id: 'orb', params: { window: 60 } }, { orWindows: [5], ibWindow: 60 }).dsl).toBe('orbBreak(60m, any)');
    });

    it('fails closed on absent events without hiding their catalog entries', () => {
        const events = getStatsPresetCatalog().presets.filter(preset => preset.category === 'events');
        expect(events).toHaveLength(6);
        for (const preset of events) {
            expect(preset.availability).toMatchObject({ available: false, requires: ['local-events'] });
            expect(preset.availability.reason).toMatch(/local event/i);
            expect(() => buildPreset({ id: preset.id })).toThrow(/local event/i);
        }
        expect(getStatsPresetCatalog().presets.filter(preset => preset.availability.available)).toHaveLength(36);
    });

    it('activates all 42 only with actual supplied calendars and exposes event coverage before and after opt-in', async () => {
        const { eventCalendars } = await import('@luxalgo/edge-stats/calendar-data');
        const context = { events: eventCalendars };
        const enabled = getStatsPresetCatalog(context);
        expect(enabled.presets.filter(preset => preset.availability.available)).toHaveLength(42);
        expect(enabled.events?.calendars).toHaveLength(4);
        const cpi = enabled.presets.find(preset => preset.id === 'event-day-cpi')!;
        expect(cpi.availability).toMatchObject({ available: true, requires: ['local-events'], requiredEvents: ['CPI'],
            coverage: [expect.objectContaining({ event: 'CPI', coverage: { from: '2015-01-01', to: '2026-12-10' } })] });
        expect(getStatsPresetCatalog().presets.find(preset => preset.id === 'event-day-cpi')!.availability).toMatchObject({ available: false, requiredEvents: ['CPI'], coverage: [] });
        for (const preset of enabled.presets) expect(buildPreset({ id: preset.id }, context).dsl).toBe(preset.defaultDsl);
        expect(buildPreset({ id: 'day-after-event', params: { event: 'NFP' } }, context).dsl).toBe("closeGreen WHERE dayAfterEvent('NFP')");
        expect(() => buildPreset({ id: 'day-after-event', params: { event: 'ABSENT' } }, context)).toThrow(/local event calendar/i);
        const partial = { events: eventCalendars.filter(file => file.event === 'CPI') };
        expect(getStatsPresetCatalog(partial).presets.filter(preset => preset.availability.available)).toHaveLength(37);
        expect(() => buildPreset({ id: 'event-day-fomc' }, partial)).toThrow(/local event calendar/i);
        expect(() => getStatsPresetCatalog({ events: null } as unknown as Parameters<typeof getStatsPresetCatalog>[0])).toThrow();
    });

    it.each([
        null, [], {}, { id: 'absent' }, { id: 'orb', force: true }, { id: 'orb', params: [] },
        { id: 'orb', params: { unknown: 1 } }, { id: 'orb', params: { window: '15' } },
        { id: 'orb', params: { window: 0 } }, { id: 'orb', params: { window: 121 } },
        { id: 'orb', params: { window: 20 } }, { id: 'orb', params: { window: 5.5 } },
        { id: 'orb', params: { dir: 'sideways' } }, { id: 'orb', groupBy: 'closeGreen' },
        { id: 'orb-target', params: { r: Infinity } }, { id: 'orb-target', params: { r: -1 } },
        { id: 'streak-reversion', params: { n: 1.5 } }, { id: 'streak-reversion', params: { n: 0 } },
        { id: 'high-time', params: { within: 121 } }, { id: 'gap-fill', params: { minGapPct: -0.1 } },
        { id: 'gap-fill', params: { minGapPct: 1, maxGapPct: 0.5 } },
        { id: 'prev-range', params: { minOpenPos: 2, maxOpenPos: 1 } },
        { id: 'green-rate', params: { constructor: 1 } },
    ].map(input => ({ input })))('rejects malformed, coerced or unbounded input: $input', ({ input }) => {
        expect(() => buildPreset(input)).toThrow();
    });

    it('rejects incompatible contexts and preserves valid outside-range open positions', () => {
        expect(() => buildPreset({ id: 'orb' }, { orWindows: [5, 5] })).toThrow();
        expect(() => buildPreset({ id: 'orb' }, { orWindows: [121] })).toThrow();
        expect(() => buildPreset({ id: 'orb' }, { ibWindow: 0 })).toThrow();
        expect(buildPreset({ id: 'prev-range', params: { minOpenPos: -1, maxOpenPos: 2 } }).dsl).toContain('openPosInPrevRange >= -1');
        const first = getStatsPresetCatalog(); first.presets[0]!.title = 'mutated'; first.presets[0]!.params.length = 0;
        expect(getStatsPresetCatalog().presets[0]!.title).not.toBe('mutated');
    });

    it('bundles the actual catalog and source helpers into a detached native-free packaged path', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'vela-preset-')); fixtures.push(fixture);
        const outfile = join(fixture, 'catalog.mjs');
        const result = await build({ stdin: { contents: `import {getStatsPresetCatalog,buildPreset} from './local-app/server/stats-presets';
            import {getSessionBars} from '@luxalgo/edge-stats/session-bars';
            import {exportQuery,exportTable} from '@luxalgo/edge-stats/export';
            import {listAlerts,replayAlert} from '@luxalgo/edge-stats/live/replay';
            import {liveConfigSchema} from '@luxalgo/edge-stats/live/types';
            import {eventFileSchema} from '@luxalgo/edge-stats/events';
            import {eventCalendars,holidayCalendars} from '@luxalgo/edge-stats/calendar-data';
            console.log(JSON.stringify({catalog:getStatsPresetCatalog(),query:buildPreset({id:'orb'}),
            helpers:[getSessionBars,exportQuery,exportTable,listAlerts,replayAlert].map(fn=>typeof fn),
            live:liveConfigSchema.parse({}).watch.length,events:eventCalendars.map(value=>eventFileSchema.parse(value)).length,exchanges:Object.keys(holidayCalendars)}));`, resolveDir: root, loader: 'ts' },
            outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['node:*', '@duckdb/*'], metafile: true, logLevel: 'silent' });
        const inputs = Object.keys(result.metafile!.inputs).map(value => value.replaceAll('\\', '/'));
        expect(inputs.filter(value => /edge-stats\/presets\/.*\.json$/.test(value))).toHaveLength(42);
        expect(inputs.some(value => /@duckdb|edge-stats\/src\/(?:store|adapters|sync)|live\/(?:board|sinks)/.test(value))).toBe(false);
        const imports = Object.values(result.metafile!.outputs).flatMap(value => value.imports);
        expect(imports.every(value => value.path.startsWith('node:'))).toBe(true);
        const environment: NodeJS.ProcessEnv = {};
        for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key]) environment[key] = process.env[key];
        const output = JSON.parse(execFileSync(process.execPath, [outfile], { cwd: fixture, env: environment, windowsHide: true, timeout: 15_000, encoding: 'utf8' }));
        expect(output.catalog.total).toBe(42); expect(output.catalog.namedVariants).toBe(121);
        expect(output.query.dsl).toBe('orbBreak(15m, any)'); expect(output.helpers).toEqual(Array(5).fill('function'));
        expect(output.events).toBe(4); expect(output.exchanges).toEqual(['cme', 'nyse']);
    });

    it('records exact pinned source bytes, presets, CC BY datasets and licenses', async () => {
        const folder = join(root, 'vendor/edge-stats');
        const provenance = JSON.parse(await readFile(join(folder, 'provenance.json'), 'utf8')) as {
            commit: string; sourceFiles: { path: string; sha256: string; bytes: number; url: string }[];
        };
        expect(provenance.commit).toBe('a48259887962d0f67a27d2b0815e2df9a52efca5');
        expect(provenance.sourceFiles.filter(file => file.path.startsWith('presets/'))).toHaveLength(42);
        for (const source of provenance.sourceFiles) {
            const content = await readFile(join(folder, source.path));
            expect(content.length).toBe(source.bytes); expect(createHash('sha256').update(content).digest('hex')).toBe(source.sha256);
            expect(source.url).toContain(`/${provenance.commit}/`);
        }
        expect(await readFile(join(folder, 'DATA_LICENSE'), 'utf8')).toContain('Creative Commons Attribution 4.0 International');
        const attributes = await readFile(join(folder, '.gitattributes'), 'utf8');
        for (const pattern of ['src/** -text', 'presets/** -text', 'data/** -text', 'DATA_LICENSE -text']) expect(attributes).toContain(pattern);
    });
});
