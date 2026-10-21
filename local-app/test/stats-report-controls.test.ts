// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountMarketStatsPage } from '../client/market-stats-page';
import type { LocalApi } from '../client/api';
import { buildPreset, getStatsPresetCatalog } from '../server/stats-presets';
import type { MarketStatsCatalog, MarketStatsPageResponse, MarketStatsRequest } from '../shared/market-stats';
import type { SessionBarsResult } from '@luxalgo/edge-stats/session-bars';
import { eventCalendars } from '@luxalgo/edge-stats/calendar-data';
import { describeRegistry } from '@luxalgo/edge-stats/registry';

const chart = vi.hoisted(() => ({ mount: vi.fn(), destroy: vi.fn(), add: vi.fn(() => ({ id: 'annotation' })), marks: vi.fn() }));
vi.mock('../../src/index', () => ({ Vela: class {
    drawings = { add: chart.add, lock: vi.fn(), showToolbar: vi.fn() }; renderer = { set: vi.fn() }; marks = { set: chart.marks };
    constructor(host: HTMLElement, options: unknown) { chart.mount(host, options); }
    ready = async () => {}; destroy = chart.destroy;
} }));
const pages: ReturnType<typeof mountMarketStatsPage>[] = [];
const start = Date.UTC(2024, 3, 8);
const source = { repository: 'https://github.com/LuxAlgo/edge-stats', commit: 'a48259887962d0f67a27d2b0815e2df9a52efca5', version: '0.1.0' } as const;
const datasets: MarketStatsCatalog['datasets'] = [{ id: 'minute-cache', name: 'Cached contract', symbol: 'NQM4', schema: 'ohlcv-1m', intervalMs: 60_000, start, end: start + 86400000 * 45, barCount: 10000, checksum: 'cache-proof', source: 'csv', instrument: { root: 'NQ', tickSize: 0.25, pointValue: 20 }, createdAt: '' }];
const catalog: MarketStatsCatalog = { datasets, sessions: [], registry: [{ name: 'dayOfWeek', kind: 'field', title: 'Weekday', doc: 'Trading weekday', groupable: true }], limits: { bars: 250000, spanMs: 315360000000, sessions: 100, groups: 100 } };
const coverage = { fingerprint: 'coverage-proof', revealedUntil: datasets[0]!.end, inputBarCount: 10000, eligibleBarCount: 9990, excludedFutureBars: 10, firstBarOpen: start, lastBarClose: datasets[0]!.end, calendarMode: 'schedule-only' as const };
function report(): MarketStatsPageResponse {
    return { source, coverage, warnings: [], selection: { datasetId: 'minute-cache', name: 'Cached contract', symbol: 'NQM4', checksum: 'cache-proof', sourceMode: 'cache', from: start, until: datasets[0]!.end }, result: {
        engine: { version: '0.1.0', storeFingerprint: 'store-proof', calendarVersion: 'schedule-only' }, query: { dsl: 'closeGreen', ast: { outcome: { name: 'closeGreen', args: [] } }, outcome: 'closeGreen', symbol: 'NQM4', sessionKey: 'selected', since: null, until: null },
        n: 44, successes: 22, estimate: 0.5, ci95: [0.35, 0.65], guards: { lowSample: false, refused: false, warnFloor: 30, refuseFloor: 10 }, stability: null, recency: null, perYear: [], groups: null, distribution: null,
        sessions: [{ sessionId: 'NQM4|selected|2024-04-08', tradeDate: '2024-04-08', success: true, value: null }, { sessionId: 'NQM4|selected|2024-04-09', tradeDate: '2024-04-09', success: false, value: null }], disclaimer: 'Historical conditional frequencies with sample sizes.' } };
}
const session: SessionBarsResult = { sessionId: report().result.sessions[0]!.sessionId, symbol: 'NQM4', sessionKey: 'selected', tradeDate: '2024-04-08', tf: '1m', tz: 'UTC', startTs: start, endTs: start + 180000, isHalfDay: false, isRollDay: false, complete: true,
    bars: [0, 1, 2].map(i => ({ ts: start + i * 60000, open: 100, high: 104, low: 98, close: 102, volume: 10 })), context: { kind: 'prior-session', bars: [{ ts: start - 60000, open: 99, high: 101, low: 98, close: 100, volume: 5 }], note: 'Tail of prior session.' },
    levels: { prevClose: 99, prevHigh: 105, prevLow: 95, prevMid: 100, open: 100, high: 104, low: 98, close: 102, gapAbs: 1, gapPct: 1, gapDir: 'up', gapFilled: true, touchedPrevHigh: false, touchedPrevLow: false, ibBreak: null, ibWindow: 60, openingRanges: [{ window: 1, high: 104, low: 98, firstBreak: 'none', breakMin: null }] },
    times: { gapFillMin: 1, touchPrevHighMin: null, touchPrevLowMin: null, highTimeMin: 0, lowTimeMin: 2 }, disclaimer: 'Historical session context.' };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setup() {
    const host = document.createElement('div'); document.body.append(host);
    const get = vi.fn(async (path: string, _signal?: AbortSignal): Promise<unknown> => {
        if (!path.startsWith('/api/market-stats/presets')) return catalog;
        return getStatsPresetCatalog(path.includes('?events=bundled') ? { events: eventCalendars } : {});
    });
    const post = vi.fn(async (path: string, body: unknown, _signal?: AbortSignal): Promise<unknown> => {
        if (path.endsWith('/preset')) { const { eventCalendar, ...preset } = body as Record<string, unknown>; return buildPreset(preset, eventCalendar === 'bundled' ? { events: eventCalendars } : {}); }
        if (path.endsWith('/session')) return { kind: 'session', session: { ...session, sessionId: (body as { sessionId: string }).sessionId }, source, coverage, query: { dsl: 'closeGreen', symbol: 'NQM4' }, selection: report().selection };
        if (path.endsWith('/export')) { const format = (body as { format: string }).format; const bytes = Buffer.from(format === 'csv' ? 'trade_date,outcome_success\n2024-04-08,true\n' : 'PAR1actual-response-bytesPAR1'); return { kind: 'export', format, rows: 44, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64'), source, coverage, query: { dsl: 'closeGreen', symbol: 'NQM4' }, selection: report().selection }; }
        return report();
    });
    const page = mountMarketStatsPage(host, { get, post } as unknown as LocalApi, { onHome: vi.fn(), onData: vi.fn() }); pages.push(page);
    return { host, get, post, page };
}
const field = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement = HTMLInputElement>(host: HTMLElement, selector: string) => host.querySelector<T>(selector)!;
const click = (host: HTMLElement, selector: string) => host.querySelector<HTMLButtonElement>(selector)!.click();
const change = (host: HTMLElement, selector: string, value: string) => { const input = field(host, selector); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); };
async function run(host: HTMLElement) { host.querySelector('.ms-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush(); }
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { pages.splice(0).forEach(page => page.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows all 42 official templates with searchable categories, versions, definitions and unavailable reasons', async () => {
    const { host, post } = setup(); await flush();
    expect(host.querySelectorAll('[data-preset-id]')).toHaveLength(42); expect(host.querySelectorAll('[data-preset-category] option')).toHaveLength(12);
    const official = getStatsPresetCatalog();
    for (const preset of official.presets) expect(host.querySelector(`[data-preset-id="${preset.id}"]`)!.textContent).toContain(preset.title);
    change(host, '[data-preset-search]', 'FOMC'); expect(host.querySelectorAll('[data-preset-id]').length).toBeGreaterThan(0);
    expect(host.querySelector('.ms-preset-list')!.textContent).toContain(official.presets.find(p => !p.availability.available)!.availability.reason!);
    change(host, '[data-preset-search]', ''); change(host, '[data-preset-category]', 'opening-range');
    expect(host.querySelectorAll('[data-preset-id]')).toHaveLength(official.categories.find(p => p.id === 'opening-range')!.count);
    click(host, '[data-preset-id="orb"]'); expect(host.querySelector('.ms-preset-detail')!.textContent).toContain(official.presets.find(p => p.id === 'orb')!.summary);
    expect(host.querySelectorAll('.ms-preset-detail a[href^="https://www.luxalgo.com/library/"]').length).toBeGreaterThan(0); expect(post).not.toHaveBeenCalled();
});
it('uses the unconditional close-green baseline despite the real registry first example having a streak condition', async () => {
    const { host, get, post, page } = setup(); await flush();
    const registry = describeRegistry();
    expect(registry.find(entry => entry.name === 'closeGreen')!.examples![0]).toBe('closeGreen WHERE streak(red, 3)');
    get.mockResolvedValueOnce({ ...catalog, registry }); await page.refresh();
    const baseline = [...host.querySelectorAll<HTMLButtonElement>('.ms-examples button')].find(button => button.textContent === 'Session closes green')!;
    expect(baseline).toBeDefined(); baseline.click(); expect(field(host, '[name=dsl]').value).toBe('closeGreen');
    for (const entry of registry.filter(item => item.kind === 'outcome' && ['gapFill', 'orbBreak', 'ibSingleBreak'].includes(item.name))) {
        const expected = entry.examples?.[0] ?? entry.name;
        [...host.querySelectorAll<HTMLButtonElement>('.ms-examples button')].find(button => button.dataset.query === expected)!.click();
        expect(field(host, '[name=dsl]').value).toBe(expected);
    }
    expect(post).not.toHaveBeenCalled();
});
it('composes typed parameters and explicit grouping through the official API without running the query', async () => {
    const { host, post } = setup(); await flush(); click(host, '[data-preset-id="orb"]');
    expect(field(host, '[data-preset-param="window"]').value).toBe('15'); expect(field(host, '[data-preset-param="window"]').max).toBe('120');
    change(host, '[data-preset-param="dir"]', 'up'); change(host, '[data-preset-group]', 'dayOfWeek'); click(host, '[data-preset-compose]'); await flush();
    const expected = buildPreset({ id: 'orb', params: { window: 15, dir: 'up' }, groupBy: 'dayOfWeek' });
    expect(post).toHaveBeenCalledExactlyOnceWith('/api/market-stats/preset', { id: 'orb', params: { window: 15, dir: 'up' }, groupBy: 'dayOfWeek' }, expect.any(AbortSignal));
    expect(field(host, '[name=dsl]').value).toBe(expected.dsl); expect(field(host, '[name=groupBy]').value).toBe('dayOfWeek');
    expect(host.querySelector('[data-preset-normalized]')!.textContent).toContain(expected.dsl); expect(post.mock.calls.some(([path]) => path.endsWith('/query'))).toBe(false);
});
it('enforces duration bounds and ignores a composition response after a newer user draft', async () => {
    const { host, post } = setup(); await flush(); click(host, '[data-preset-id="orb"]');
    change(host, '[data-preset-param="window"]', '121'); click(host, '[data-preset-compose]'); await flush(); expect(post).not.toHaveBeenCalled();
    expect(host.querySelector('.ms-preset-status')!.textContent).toMatch(/120|duration/i);
    change(host, '[data-preset-param="window"]', '15'); const pending = deferred<unknown>(); post.mockReturnValueOnce(pending.promise);
    click(host, '[data-preset-compose]'); await flush(); const signal = post.mock.calls[0]![2]!;
    change(host, '[name=dsl]', 'gapFill'); pending.resolve(buildPreset({ id: 'orb' })); await flush();
    expect(signal.aborted).toBe(true); expect(field(host, '[name=dsl]').value).toBe('gapFill');
});
it('preserves the official default grouping when no grouping override is selected', async () => {
    const { host, post } = setup(); await flush(); const item = getStatsPresetCatalog().presets.find(preset => preset.groupBy && preset.availability.available)!;
    click(host, `[data-preset-id="${item.id}"]`); expect(field(host, '[data-preset-group]').value).toBe('__default__');
    click(host, '[data-preset-compose]'); await flush();
    expect(post.mock.calls[0]![1]).not.toHaveProperty('groupBy'); expect(field(host, '[name=groupBy]').value).toBe(item.groupBy);
});
it('opts into bundled dates explicitly without silently attaching an exchange calendar', async () => {
    const { host, get, post } = setup(); await flush(); const events = field(host, '[name=eventCalendar]'); expect(events.checked).toBe(false);
    events.checked = true; events.dispatchEvent(new Event('change', { bubbles: true })); await flush();
    expect(get).toHaveBeenCalledWith('/api/market-stats/presets?events=bundled', expect.any(AbortSignal));
    expect(host.textContent).toMatch(/FOMC.*scheduled/i); expect(host.textContent).toMatch(/OPEX.*equity/i);
    expect(host.querySelectorAll('.ms-unavailable')).toHaveLength(0);
    const event = getStatsPresetCatalog({ events: eventCalendars }).presets.find(preset => preset.category === 'events')!;
    click(host, `[data-preset-id="${event.id}"]`); click(host, '[data-preset-compose]'); await flush();
    expect(post.mock.calls.find(([path]) => path.endsWith('/preset'))![1]).toMatchObject({ id: event.id, eventCalendar: 'bundled' });
    await run(host); expect(post.mock.calls.find(([path]) => path.endsWith('/query'))![1]).toMatchObject({ eventCalendar: 'bundled', calendar: null });
});
it('inspects and navigates matched sessions using the exact successful request and returned candle timestamps', async () => {
    const { host, post } = setup(); await flush(); await run(host);
    const submitted = structuredClone(post.mock.calls.find(([path]) => path.endsWith('/query'))![1]) as MarketStatsRequest;
    field(host, '[name=dsl]').value = 'A different unsent draft'; click(host, '[data-session-index="0"]'); await vi.waitFor(() => expect(chart.mount).toHaveBeenCalledOnce());
    expect(post.mock.calls.find(([path]) => path.endsWith('/session'))![1]).toEqual({ request: submitted, sessionId: session.sessionId, contextBars: 30 });
    const options = chart.mount.mock.calls[0]![1] as { data: { time: number }[] }; expect(options.data.map(bar => bar.time)).toEqual([start - 60000, start, start + 60000, start + 120000]);
    expect(host.querySelector('.ms-session-view')!.textContent).toContain('Tail of prior session'); expect(host.querySelector('.ms-session-view')!.textContent).toContain('closeGreen');
    click(host, '[data-session-next]'); await vi.waitFor(() => expect(chart.mount).toHaveBeenCalledTimes(2)); expect(chart.destroy).toHaveBeenCalled();
    expect(post.mock.calls.filter(([path]) => path.endsWith('/session'))[1]![1]).toMatchObject({ request: submitted, sessionId: report().result.sessions[1]!.sessionId });
});
it.each(['csv', 'parquet'] as const)('downloads exact %s response bytes with result-owned metadata', async format => {
    const { host, post } = setup(); const blobs: Blob[] = [], names: string[] = [];
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:stats-proof'; }), revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    await flush(); await run(host); const submitted = structuredClone(post.mock.calls[0]![1]); field(host, '[name=dsl]').value = 'Unsent query';
    click(host, `[data-stats-download="${format}"]`); await vi.waitFor(() => expect(blobs).toHaveLength(1));
    expect(post.mock.calls.find(([path]) => path.endsWith('/export'))![1]).toEqual({ request: submitted, format });
    expect(names[0]).toMatch(new RegExp(`\\.${format}$`)); expect(blobs[0]!.size).toBeGreaterThan(0);
    const decoded = await new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(blobs[0]!); });
    expect(Buffer.from(decoded).toString()).toBe(format === 'csv' ? 'trade_date,outcome_success\n2024-04-08,true\n' : 'PAR1actual-response-bytesPAR1');
    expect(host.querySelector('.ms-artifact-status')!.textContent).toContain('44'); expect(host.querySelector('.ms-artifact-status')!.textContent).toContain('SHA-256');
});
it.each(['compose', 'session', 'export', 'presets'])('preparation aborts and drains pending %s work before resolving', async kind => {
    const { host, post, get, page } = setup(); await flush(); await run(host); const pending = deferred<never>();
    if (kind === 'presets') { get.mockReturnValueOnce(pending.promise); const checkbox = field(host, '[name=eventCalendar]'); checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true })); }
    else { post.mockReturnValueOnce(pending.promise); if (kind === 'compose') click(host, '[data-preset-compose]'); else if (kind === 'session') click(host, '[data-session-index="0"]'); else click(host, '[data-stats-download="csv"]'); }
    await flush(); const signal = kind === 'presets' ? get.mock.lastCall![1]! : post.mock.lastCall![2]!; let prepared = false; const work = page.prepare().then(() => { prepared = true; });
    await flush(); expect(signal.aborted).toBe(true); expect(prepared).toBe(false);
    pending.reject(new DOMException('Settled cancellation', 'AbortError')); await work;
    expect(prepared).toBe(true); expect(chart.mount).not.toHaveBeenCalled();
});
it('keeps replay revision failures visible without fabricating an inspection', async () => {
    const { host, post } = setup(); await flush(); await run(host); post.mockRejectedValueOnce(new Error('Replay changed. Refresh sources.'));
    click(host, '[data-session-index="0"]'); await flush(); expect(host.querySelector('.ms-artifact-status')!.textContent).toContain('Replay changed'); expect(chart.mount).not.toHaveBeenCalled();
});
it('cancels a late inspection without creating a chart or replacing a newer query draft', async () => {
    const { host, post } = setup(); await flush(); await run(host); const pending = deferred<unknown>(); post.mockReturnValueOnce(pending.promise);
    click(host, '[data-session-index="0"]'); await flush(); const signal = post.mock.lastCall![2]!;
    change(host, '[name=dsl]', 'gapFill'); pending.resolve({ kind: 'session', session, source, coverage, query: { dsl: 'closeGreen', symbol: 'NQM4' }, selection: report().selection }); await flush();
    expect(signal.aborted).toBe(true); expect(chart.mount).not.toHaveBeenCalled(); expect(field(host, '[name=dsl]').value).toBe('gapFill');
});
it.each(['oversize', 'hash mismatch'])('refuses an invalid %s export without creating a download', async failure => {
    const { host, post } = setup(); const create = vi.fn(); vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    await flush(); await run(host); const bytes = Buffer.from('actual csv bytes');
    post.mockResolvedValueOnce({ kind: 'export', format: 'csv', rows: 44, bytes: failure === 'oversize' ? 8_000_001 : bytes.length, data: bytes.toString('base64'), sha256: '0'.repeat(64), source, coverage, selection: report().selection });
    click(host, '[data-stats-download="csv"]'); await vi.waitFor(() => expect(host.querySelector('.ms-artifact-status')!.textContent).toMatch(/bounds|SHA-256/));
    expect(create).not.toHaveBeenCalled(); expect(host.querySelector<HTMLButtonElement>('[data-stats-download="csv"]')!.disabled).toBe(false);
});
