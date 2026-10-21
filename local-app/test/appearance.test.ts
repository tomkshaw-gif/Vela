// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { appearanceModule } from '../server/appearance';
import { createReplayServer } from '../server/index';
import { getDrawingType, iconMarkup, registerIcon } from '../../src/plugin';
import { applyThemeTokens } from '../../src/ui';
import { CHART_THEME, LIGHT_PLOT_APPEARANCE, applyLightPlotAppearance, configureChartAppearance, isDefaultPlotAppearance, needsPlotAppearanceMigration, nativeChartConfig, sanitizeDrawingIcon } from '../client/chart-appearance';
import { NativeRenderer } from '../../src/renderers/native/NativeRenderer';
import type { ChartCell } from '../../src/workspace';

const originalTrend = getDrawingType('trendline')!.icon;
const originalLayout = iconMarkup('layout');
afterEach(() => { getDrawingType('trendline')!.icon = originalTrend; if (originalLayout !== null) registerIcon('layout', originalLayout); document.body.replaceChildren(); });

const extensionRoots: string[] = [];
const appearanceApps: Awaited<ReturnType<typeof createReplayServer>>[] = [];

afterEach(async () => {
    for (const app of appearanceApps.splice(0)) await app.close();
    for (const root of extensionRoots.splice(0)) {
        const absolute = resolve(root); const withinTemp = relative(resolve(tmpdir()), absolute);
        if (withinTemp === '' || withinTemp === '..' || withinTemp.startsWith(`..${sep}`) || isAbsolute(withinTemp) || !absolute.split(sep).at(-1)?.startsWith('vela-appearance-test-')) throw new Error('Unsafe appearance fixture cleanup');
        rmSync(absolute, { recursive: true, force: true });
    }
});

function extensionFixture() {
    const root = mkdtempSync(join(tmpdir(), 'vela-appearance-test-')); extensionRoots.push(root);
    const data = join(root, 'data'); const directory = join(data, 'appearance'); mkdirSync(directory, { recursive: true });
    const write = (name: string, value: string) => { writeFileSync(join(directory, name), value); };
    const results = (code = 'export default { label: "local fixture" };', manifest: Record<string, unknown> = {}) => {
        write('results-chart.mjs', code);
        write('results-chart.json', JSON.stringify({ format: 1, sha256: createHash('sha256').update(code).digest('hex'), ...manifest }));
        return code;
    };
    return { root, data, directory, write, results };
}

async function appearanceServer() {
    const f = extensionFixture(); const providerFetch = vi.fn(async (): Promise<Response> => { throw new Error('Provider access is forbidden in appearance tests'); });
    const app = await createReplayServer({ dataDirectory: f.data, staticDirectory: join(f.root, 'static'), port: 5196,
        apiKey: 'appearance-test-fixture', fetch: providerFetch });
    appearanceApps.push(app);
    const request = (url: string, headers: Record<string, string> = {}, method = 'GET') => new Promise<{ status: number; headers: Record<string, string>; body: string }>((finish, reject) => {
        const output: Record<string, string> = {}; let status = 200;
        const response = { headersSent: false,
            setHeader: (name: string, value: string) => { output[name.toLowerCase()] = value; },
            writeHead: (code: number, values: Record<string, string>) => {
                status = code; response.headersSent = true;
                for (const [name, value] of Object.entries(values)) output[name.toLowerCase()] = value;
            },
            end: (body = '') => { finish({ status, headers: output, body: String(body) }); },
        };
        try { app.server.emit('request', { url, method, headers: { host: '127.0.0.1:5196', ...headers } }, response); }
        catch (error) { reject(error); }
    });
    return { ...f, app, request, providerFetch };
}

describe('local appearance extension loading', () => {
    it('uses native defaults when the extension directory or fixed assets are absent', async () => {
        const f = extensionFixture();
        for (const data of [join(f.root, 'missing-data'), f.data]) {
            await expect(appearanceModule(data, 'drawing-icons')).resolves.toBe('export default {};');
            await expect(appearanceModule(data, 'results-chart')).resolves.toBe('export default null;');
        }
        f.write('unrelated.json', '{"ignore":true}');
        await expect(appearanceModule(f.data, 'drawing-icons')).resolves.toBe('export default {};');
    });

    it('loads only bounded drawing names and values and leaves SVG sanitization to the client', async () => {
        const f = extensionFixture(); const valid = '<svg viewBox="0 0 24 24"><path d="M0 0 24 24"/></svg>';
        f.write('drawing-icons.json', JSON.stringify({ trendline: valid, 'icon-layout': valid, ['a'.repeat(51)]: 'x'.repeat(12_000),
            '../escape': 'bad', Uppercase: 'bad', ['a'.repeat(52)]: 'bad', 'long-value': 'x'.repeat(12_001), number: 42, nested: {}, '__proto__': null }));
        const source = await appearanceModule(f.data, 'drawing-icons');
        expect(JSON.parse(source.slice('export default '.length, -1))).toEqual({ trendline: valid, 'icon-layout': valid, ['a'.repeat(51)]: 'x'.repeat(12_000) });
    });

    it.each(['{bad', 'null', '[]', 'false', '"text"'])('rejects invalid drawing JSON: %s', async raw => {
        const f = extensionFixture(); f.write('drawing-icons.json', raw);
        await expect(appearanceModule(f.data, 'drawing-icons')).rejects.toMatchObject({ status: 500, message: 'The local drawing extension is invalid.' });
    });

    it('accepts 128 drawing entries and rejects a larger pack', async () => {
        const f = extensionFixture(); const entries = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`icon-${index}`, '<svg/>']));
        f.write('drawing-icons.json', JSON.stringify(entries));
        expect(JSON.parse((await appearanceModule(f.data, 'drawing-icons')).slice('export default '.length, -1))).toEqual(entries);
        f.write('drawing-icons.json', JSON.stringify({ ...entries, extra: '<svg/>' }));
        await expect(appearanceModule(f.data, 'drawing-icons')).rejects.toMatchObject({ status: 500 });
    });

    it('returns exact result code only with a matching SHA-256 and manifest format', async () => {
        const f = extensionFixture(); const code = f.results('export default { label: "local \u00e9 fixture" };\r\n');
        await expect(appearanceModule(f.data, 'results-chart')).resolves.toBe(code);
        f.write('results-chart.mjs', `${code}\n// changed after installation`);
        await expect(appearanceModule(f.data, 'results-chart')).rejects.toMatchObject({ status: 500, message: 'The local results extension does not match its manifest.' });
    });

    it.each(['results-chart.mjs', 'results-chart.json'])('rejects an incomplete result pair containing only %s', async name => {
        const f = extensionFixture(); f.write(name, name.endsWith('.mjs') ? 'export default {};' : '{"format":1,"sha256":"missing"}');
        await expect(appearanceModule(f.data, 'results-chart')).rejects.toMatchObject({ status: 500, message: 'The local results extension is incomplete.' });
    });

    it.each(['{bad', 'null', '[]', '"text"', '{}', '{"format":2}', '{"format":"1"}', '{"format":1,"sha256":42}'])('rejects an invalid result manifest: %s', async raw => {
        const f = extensionFixture(); f.results(); f.write('results-chart.json', raw);
        await expect(appearanceModule(f.data, 'results-chart')).rejects.toMatchObject({ status: 500 });
    });

    it.each([
        ['drawing-icons.json', 'drawing-icons', 256_000],
        ['results-chart.mjs', 'results-chart', 512_000],
        ['results-chart.json', 'results-chart', 16_000],
    ] as const)('enforces the byte limit for %s, including multibyte text', async (name, kind, limit) => {
        const f = extensionFixture(); f.results();
        const content = '\u00e9'.repeat(Math.floor(limit / 2) + 1); expect(content.length).toBeLessThan(limit);
        f.write(name, content);
        await expect(appearanceModule(f.data, kind)).rejects.toMatchObject({ status: 500, message: 'The local appearance extension is invalid.' });
    });

    it('accepts drawing JSON and result code at their byte limits', async () => {
        const f = extensionFixture(); const icons = '{"trendline":"<svg/>"}';
        f.write('drawing-icons.json', icons.padEnd(256_000, ' '));
        await expect(appearanceModule(f.data, 'drawing-icons')).resolves.toBe(`export default ${icons};`);
        const code = 'export default null;'.padEnd(512_000, ' '); f.results(code);
        const manifest = readFileSync(join(f.directory, 'results-chart.json'), 'utf8');
        f.write('results-chart.json', manifest.padEnd(16_000, ' '));
        await expect(appearanceModule(f.data, 'results-chart')).resolves.toBe(code);
    });

    it('rejects a non-file at a fixed asset path', async () => {
        const f = extensionFixture(); mkdirSync(join(f.directory, 'drawing-icons.json'));
        await expect(appearanceModule(f.data, 'drawing-icons')).rejects.toMatchObject({ status: 500, message: 'The local appearance extension is invalid.' });
    });

    it('rejects a linked appearance directory and never includes the target path in the error', async () => {
        const f = extensionFixture(); f.write('drawing-icons.json', '{"trendline":"outside"}');
        const otherData = join(f.root, 'other-data'); mkdirSync(otherData);
        symlinkSync(f.directory, join(otherData, 'appearance'), process.platform === 'win32' ? 'junction' : 'dir');
        for (const kind of ['drawing-icons', 'results-chart'] as const) {
            await expect(appearanceModule(otherData, kind)).rejects.toMatchObject({ status: 500, message: 'The local appearance extension is invalid.' });
        }
    });

    it('rejects an asset link escaping into a sibling with the same path prefix', async () => {
        const f = extensionFixture(); const outside = join(dirname(f.directory), 'appearance-outside'); mkdirSync(outside);
        symlinkSync(outside, join(f.directory, 'drawing-icons.json'), process.platform === 'win32' ? 'junction' : 'dir');
        await expect(appearanceModule(f.data, 'drawing-icons')).rejects.toMatchObject({ status: 500, message: 'The local appearance extension is invalid.' });
    });

    it('rejects a file symlink to otherwise valid result code outside the extension directory', async ({ skip }) => {
        const f = extensionFixture(); const outside = join(dirname(f.directory), 'appearance-outside'); mkdirSync(outside);
        const code = 'export default { escaped: true };'; const target = join(outside, 'results-chart.mjs'); writeFileSync(target, code);
        f.write('results-chart.json', JSON.stringify({ format: 1, sha256: createHash('sha256').update(code).digest('hex') }));
        try { symlinkSync(target, join(f.directory, 'results-chart.mjs'), 'file'); }
        catch (error) {
            if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
                skip('Windows file symlinks require Developer Mode or symlink privilege'); return;
            }
            throw error;
        }
        await expect(appearanceModule(f.data, 'results-chart')).rejects.toMatchObject({ status: 500, message: 'The local appearance extension is invalid.' });
    });
});

describe('fixed local appearance HTTP routes', () => {
    it('serves the exact extension routes with no-store and the existing security headers, without a listener or provider call', async () => {
        const f = await appearanceServer(); f.write('drawing-icons.json', '{"trendline":"fixture"}'); const code = f.results();
        const icons = await f.request('/local-appearance/drawing-icons.js');
        expect(icons).toMatchObject({ status: 200, body: 'export default {"trendline":"fixture"};', headers: {
            'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
            'cross-origin-resource-policy': 'same-origin', 'x-frame-options': 'DENY',
        } });
        expect(icons.headers['content-security-policy']).toContain("default-src 'none'");
        expect(await f.request('/local-appearance/results-chart.mjs', { origin: 'http://127.0.0.1:5196' })).toMatchObject({ status: 200, body: code });
        expect(f.app.server.listening).toBe(false); expect(f.providerFetch).not.toHaveBeenCalled();
    });

    it.each([
        { host: 'attacker.invalid:5196' }, { host: 'localhost:5196' }, { host: '127.0.0.1:5197' },
        { origin: 'https://attacker.invalid' }, { origin: 'http://127.0.0.1:5197' }, { 'sec-fetch-site': 'cross-site' },
    ] as Record<string, string>[])('applies the local Host/Origin gate to appearance requests: %j', async headers => {
        const f = await appearanceServer();
        for (const route of ['/local-appearance/drawing-icons.js', '/local-appearance/results-chart.mjs']) {
            const response = await f.request(route, headers);
            expect(response.status).toBe(403); expect(JSON.parse(response.body)).toMatchObject({ code: 'LOCAL_ONLY' });
        }
        expect(f.app.server.listening).toBe(false); expect(f.providerFetch).not.toHaveBeenCalled();
    });

    it.each(['/local-appearance/drawing-icons.json', '/local-appearance/results-chart.json', '/local-appearance/arbitrary.mjs',
        '/appearance/drawing-icons.json', '/.cache/private.json', '/local-appearance/results-chart.mjs/extra'])('does not expose an arbitrary local path: %s', async path => {
        const f = await appearanceServer(); expect((await f.request(path)).status).toBe(404);
    });

    it.each(['/local-appearance/../results-chart.mjs', '/local-appearance/%2e%2e/results-chart.mjs',
        '/local-appearance/%2fresults-chart.mjs', '/local-appearance/..\\results-chart.mjs'])('rejects traversal and encoded paths: %s', async path => {
        const f = await appearanceServer(); expect((await f.request(path)).status).toBe(400);
    });

    it('returns a generic extension error without disclosing malformed content or disk paths', async () => {
        const f = await appearanceServer(); f.write('drawing-icons.json', '{private fixture content');
        const response = await f.request('/local-appearance/drawing-icons.js');
        expect(response.status).toBe(500); expect(JSON.parse(response.body)).toMatchObject({ error: 'The local drawing extension is invalid.' });
        expect(response.body).not.toContain('private fixture content'); expect(response.body).not.toContain(f.root);
    });
});

describe('local drawing glyphs', () => {
    it('retains static geometry and inherited paint while removing fixed root dimensions', () => {
        const clean = sanitizeDrawingIcon('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 24 24 4"/><circle cx="4" cy="24" r="2"/></g></svg>');
        expect(clean).not.toBeNull();
        const icon = new DOMParser().parseFromString(clean!, 'image/svg+xml').documentElement;
        expect(icon.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(icon.getAttribute('viewBox')).toBe('0 0 28 28');
        expect(icon.hasAttribute('width')).toBe(false);
        expect(icon.hasAttribute('height')).toBe(false);
        expect(icon.querySelector('g')?.getAttribute('stroke')).toBe('currentColor');
        expect(icon.querySelector('path')?.getAttribute('d')).toBe('M4 24 24 4');
    });

    it('derives a view box from explicit numeric dimensions for compact cached glyphs', () => {
        const clean = sanitizeDrawingIcon('<svg width="24" height="24"><rect x="3" y="4" width="18" height="16" fill="#123456"/></svg>');
        expect(clean).toContain('viewBox="0 0 24 24"');
        expect(clean).toContain('fill="#123456"');
    });

    it.each([
        '<svg viewBox="0 0 24 24" onload="alert(1)"><path d="M0 0"/></svg>',
        '<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>',
        '<svg viewBox="0 0 24 24"><foreignObject><div>content</div></foreignObject></svg>',
        '<svg viewBox="0 0 24 24"><path d="M0 0" fill="url(https://example.invalid/fill)"/></svg>',
        '<svg viewBox="0 0 24 24"><use href="https://example.invalid/icon.svg#path"/></svg>',
        '<svg viewBox="0 0 24 24"><path d="M0 0" style="fill:red"/></svg>',
        '<svg viewBox="0 0 24 24"><g xmlns="http://www.w3.org/1999/xhtml"><path d="M0 0"/></g></svg>',
        '<svg viewBox="0 0 24 24"><animate attributeName="opacity"/></svg>',
        '<!DOCTYPE svg [<!ENTITY payload "secret">]><svg viewBox="0 0 24 24">&payload;</svg>',
        '<svg viewBox="0 0 24 24"><path></svg>',
        '<svg viewBox="0 0 -24 24"><path d="M0 0"/></svg>',
        '<svg viewBox="0 0 24"><path d="M0 0"/></svg>',
        '<svg viewBox="0 0 24 24"/>',
    ])('rejects an icon containing unsafe or malformed markup: %s', (markup) => {
        expect(sanitizeDrawingIcon(markup)).toBeNull();
    });

    it('updates only existing drawing types and leaves invalid overrides on their native glyph', () => {
        expect(configureChartAppearance({ unknown: '<svg viewBox="0 0 24 24"/>', trendline: '<svg onload="x()"/>' })).toBe(0);
        expect(getDrawingType('trendline')!.icon).toBe(originalTrend);
        expect(configureChartAppearance({ trendline: '<svg viewBox="0 0 28 28"><path d="M3 24 24 3"/></svg>' })).toBe(1);
        expect(getDrawingType('trendline')!.icon).toContain('M3 24 24 3');
        expect(getDrawingType('unknown')).toBeUndefined();
    });

    it('reapplies validated utility icons through the public registry after workspace registration', () => {
        const pack = { 'icon-layout': '<svg viewBox="0 0 28 28"><rect x="3" y="4" width="22" height="20"/></svg>' };
        expect(configureChartAppearance(pack)).toBe(1);
        expect(iconMarkup('layout')).toContain('width="22"');
        registerIcon('layout', '<svg viewBox="0 0 16 16"><path d="M1 1"/></svg>');
        expect(configureChartAppearance(pack)).toBe(1);
        expect(iconMarkup('layout')).toContain('width="22"');
        const safe = iconMarkup('layout');
        expect(configureChartAppearance({ 'icon-layout': '<svg viewBox="0 0 28 28" onload="x()"><path d="M0 0"/></svg>',
            'icon-': '<svg viewBox="0 0 28 28"><path d="M0 0"/></svg>' })).toBe(0);
        expect(iconMarkup('layout')).toBe(safe);
    });
});

describe('saved chart cosmetics', () => {
    it('updates only the unchanged earlier light preset typography and leaves custom appearances intact', () => {
        const renderer = new NativeRenderer();
        renderer.applyConfig({ ...LIGHT_PLOT_APPEARANCE, layout: { ...LIGHT_PLOT_APPEARANCE.layout, fontSize: 11 } });
        const old = renderer.getConfig(); const before = JSON.stringify(old);
        expect(needsPlotAppearanceMigration(old)).toBe(true);
        const next = nativeChartConfig(old);
        expect(next).toEqual({ ...old, layout: { ...old.layout, fontSize: 12 } });
        expect(JSON.stringify(old)).toBe(before);
        expect(needsPlotAppearanceMigration(next)).toBe(false);
        expect(nativeChartConfig(next)).toBe(next);
        for (const custom of [
            { ...old, layout: { ...old.layout, fontSize: 14 } },
            { ...old, candles: { ...old.candles, upColor: '#123456' } },
            { ...old, crosshair: { ...old.crosshair, opacity: .8 } },
        ]) {
            expect(needsPlotAppearanceMigration(custom)).toBe(false);
            expect(nativeChartConfig(custom)).toBe(custom);
        }
    });
    it('migrates only the entire untouched current preset and retains view, session, scale and custom cosmetics', () => {
        const base = new NativeRenderer().getConfig();
        const current = { ...base,
            layout: { ...base.layout, background: CHART_THEME.background, textColor: CHART_THEME.textColor, fontFamily: CHART_THEME.fontFamily },
            grid: { vertLines: { visible: true, color: CHART_THEME.gridColor }, horzLines: { visible: true, color: CHART_THEME.gridColor } },
            panes: { separatorColor: CHART_THEME.borderColor },
            priceScale: { ...base.priceScale, borderColor: CHART_THEME.borderColor, log: true, invert: true },
            timeScale: { timezone: 'America/New_York' }, margins: { top: 20, bottom: 15, right: 30 },
        };
        const before = JSON.stringify(current);
        expect(isDefaultPlotAppearance(current)).toBe(true);
        const next = nativeChartConfig(current);
        expect(next).toMatchObject({ layout: LIGHT_PLOT_APPEARANCE.layout,
            candles: { hollowUp: true }, priceScale: { log: true, invert: true }, timeScale: current.timeScale, margins: current.margins });
        expect(JSON.stringify(current)).toBe(before);
        for (const custom of [
            { ...current, candles: { ...current.candles, upColor: '#009900' } },
            { ...current, grid: { ...current.grid, horzLines: { ...current.grid.horzLines, visible: false } } },
            { ...current, crosshair: { ...current.crosshair, opacity: 0.7 } },
            { ...current, layout: { ...current.layout, fontSize: 14 } },
        ]) {
            expect(isDefaultPlotAppearance(custom)).toBe(false);
            expect(nativeChartConfig(custom)).toBe(custom);
        }
    });

    it('applies the explicit mixed appearance through public config and preserves unrelated status preferences', () => {
        const renderer = new NativeRenderer();
        const before = { parts: null, indicatorTitles: false, indicatorValues: true, watermark: true, replayWatermark: true };
        let prefs = before;
        const cell = { chart: { renderer: { applyConfig: (value: unknown) => renderer.applyConfig(value), set: () => {} } },
            statusPrefs: () => prefs, applyStatusPrefs: (value: typeof prefs) => { prefs = value; } } as unknown as ChartCell;
        applyLightPlotAppearance(cell);
        expect(renderer.getConfig()).toMatchObject({ layout: LIGHT_PLOT_APPEARANCE.layout,
            grid: { vertLines: { visible: false }, horzLines: { visible: false } }, candles: { hollowUp: true } });
        expect(prefs).toEqual({ ...before, watermark: false, replayWatermark: false });
        expect(before.watermark).toBe(true);
        expect(CHART_THEME.background).toBe('#0f0f0f');
    });

    it('uses the current dark plot palette while retaining the execution candle colors', () => {
        expect(CHART_THEME).toMatchObject({ background: '#0f0f0f', textColor: '#dbdbdb', gridColor: '#242424',
            borderColor: '#2e2e2e', upColor: '#089981', downColor: '#f23645' });
    });

    it('limits the installed dark chrome palette to the exact native theme pair', () => {
        const css = readFileSync('local-app/client/styles.css', 'utf8');
        const rule = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].find((match) => match[2]!.includes('--vela-surface-overlay:#1f1f1f!important'));
        expect(rule).toBeDefined();
        const page = document.createElement('div'); page.id = 'standard-workspace'; document.body.append(page);
        const host = document.createElement('div'); page.append(host);
        applyThemeTokens(host, CHART_THEME);
        expect(host.matches(rule![1]!.trim())).toBe(true);
        applyThemeTokens(host, { ...CHART_THEME, background: '#ffffff', textColor: '#222222' });
        expect(host.matches(rule![1]!.trim())).toBe(false);
        applyThemeTokens(host, { ...CHART_THEME, textColor: '#aabbcc' });
        expect(host.matches(rule![1]!.trim())).toBe(false);
        applyThemeTokens(host, { ...CHART_THEME, background: '#131722' });
        expect(host.matches(rule![1]!.trim())).toBe(false);
    });

    it('migrates the prior native defaults while preserving custom colors and unrelated plugin settings', () => {
        const saved = { layout: { background: '#151619', textColor: '#b2b5be', fontFamily: 'sans-serif', fontSize: 13 },
            grid: { vertLines: { color: '#20222c', visible: false }, horzLines: { color: '#123456', visible: true } },
            priceScale: { borderColor: '#2a2b30', invert: true }, candles: { upColor: '#ddee33', downColor: '#f23645' },
            chartTypes: { custom: { color: '#20222c' } } };
        const before = JSON.stringify(saved);
        expect(nativeChartConfig(saved)).toEqual({ ...saved,
            layout: { ...saved.layout, background: CHART_THEME.background, textColor: CHART_THEME.textColor, fontFamily: CHART_THEME.fontFamily },
            grid: { ...saved.grid, vertLines: { color: CHART_THEME.gridColor, visible: false } },
            priceScale: { ...saved.priceScale, borderColor: CHART_THEME.borderColor } });
        expect(JSON.stringify(saved)).toBe(before);
    });

    it('preserves a customized plot palette even when one color matches a former default', () => {
        const custom = { layout: { background: '#151619', textColor: '#eeeeee', fontFamily: 'Consolas' }, grid: { color: '#20222c' } };
        expect(nativeChartConfig(custom)).toBe(custom);
    });

    it('migrates only known fields from the first local palette', () => {
        const saved = { layout: { background: '#101419', textColor: '#8795a8', fontFamily: 'Custom Sans' },
            candles: { upColor: '#50d5ac', downColor: '#f17b82', wickUpColor: '#aa3311' },
            custom: { color: '#50d5ac' }, priceScale: { borderColor: '#26313f' } };
        expect(nativeChartConfig(saved)).toEqual({ ...saved,
            layout: { ...saved.layout, background: CHART_THEME.background, textColor: CHART_THEME.textColor },
            candles: { ...saved.candles, upColor: CHART_THEME.upColor, downColor: CHART_THEME.downColor },
            priceScale: { borderColor: CHART_THEME.borderColor } });
    });

    it('migrates the preceding host default pair without changing custom chart colors or options', () => {
        const saved = { layout: { background: '#131722', textColor: '#d1d4dc', fontFamily: 'Custom Sans', fontSize: 14 },
            grid: { vertLines: { visible: false, color: '#1e222d' }, horzLines: { visible: true, color: '#626262' } },
            candles: { upColor: '#228822', downColor: '#f23645', bodyVisible: false },
            priceScale: { borderColor: '#2a2e39', log: true }, custom: { color: '#1e222d' } };
        expect(nativeChartConfig(saved)).toEqual({ ...saved,
            layout: { ...saved.layout, background: CHART_THEME.background, textColor: CHART_THEME.textColor },
            grid: { ...saved.grid, vertLines: { visible: false, color: CHART_THEME.gridColor } },
            priceScale: { ...saved.priceScale, borderColor: CHART_THEME.borderColor } });
        const custom = { ...saved, layout: { ...saved.layout, textColor: '#eeeeee' } };
        expect(nativeChartConfig(custom)).toBe(custom);
    });
});
