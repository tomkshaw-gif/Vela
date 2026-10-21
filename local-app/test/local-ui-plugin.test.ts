import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { localDrawingIcons, localResultsChart } from '../local-ui-plugin';

const directories: string[] = [];
async function fixture(raw?: string) {
    const dir = await mkdtemp(join(tmpdir(), 'vela-local-icons-')); directories.push(dir);
    const file = join(dir, 'icons.json'); if (raw !== undefined) await writeFile(file, raw);
    const plugin = localDrawingIcons(file); const watch = vi.fn();
    const load = plugin.load as (this: { addWatchFile: (file: string) => void }, source: string) => Promise<string | undefined>;
    return { load: () => load.call({ addWatchFile: watch }, '\0virtual:local-drawing-icons'), watch, file };
}
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('optional machine-local drawing assets', () => {
    it('builds with native icons when the private pack is absent', async () => {
        const ctx = await fixture(); expect(await ctx.load()).toBe('export default {};');
    });
    it('loads only bounded named strings and watches the exact private file', async () => {
        const ctx = await fixture(JSON.stringify({ trendline: '<svg/>', 'not.valid': '<svg/>', hline: 1 }));
        expect(await ctx.load()).toBe('export default {"trendline":"<svg/>"};');
        expect(ctx.watch).toHaveBeenCalledWith(ctx.file);
    });
    it.each(['[]', 'null', '{broken', ' '.repeat(256001)])('rejects invalid or oversized private packs', async raw => {
        const ctx = await fixture(raw); await expect(ctx.load()).rejects.toThrow();
    });
});

describe('optional machine-local results chart', () => {
    async function chartFixture(code?: string, manifestCode = code) {
        const dir = await mkdtemp(join(tmpdir(), 'vela-local-chart-')); directories.push(dir);
        const file = join(dir, 'chart.mjs'); const manifest = join(dir, 'chart.json');
        if (code !== undefined) await writeFile(file, code);
        if (manifestCode !== undefined) await writeFile(manifest, JSON.stringify({ format: 1, sha256: createHash('sha256').update(manifestCode).digest('hex') }));
        const plugin = localResultsChart(file, manifest); const watch = vi.fn();
        const load = plugin.load as (this: { addWatchFile(file: string): void }, source: string) => Promise<string | undefined>;
        return { file, manifest, watch, load: () => load.call({ addWatchFile: watch }, '\0virtual:local-results-chart') };
    }
    it('uses the built-in chart fallback when both local assets are absent', async () => {
        const ctx = await chartFixture(); expect(await ctx.load()).toBe('export default null;');
    });
    it('loads the unchanged static module only when its manifest matches', async () => {
        const code = 'export default {createChart(){}};'; const ctx = await chartFixture(code);
        expect(await ctx.load()).toBe(code); expect(ctx.watch.mock.calls).toEqual([[ctx.file], [ctx.manifest]]);
    });
    it('rejects an incomplete pack, changed code and an oversized module', async () => {
        const incomplete = await chartFixture(undefined, 'export default {};'); await expect(incomplete.load()).rejects.toThrow(/both/);
        const changed = await chartFixture('export default {};', 'export default null;'); await expect(changed.load()).rejects.toThrow(/manifest/);
        const oversized = await chartFixture(' '.repeat(512001)); await expect(oversized.load()).rejects.toThrow(/size limit/);
    });
});
