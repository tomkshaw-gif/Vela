// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mountMarketStatsPage } from '../client/market-stats-page';
import type { LocalApi } from '../client/api';
import type { MarketStatsCatalog, MarketStatsPageResponse } from '../shared/market-stats';
import type { SessionSummary } from '../shared/types';

const start = Date.UTC(2024, 3, 8);
const catalog = { datasets: [{ id: 'one-minute', name: 'Cached minute data', symbol: 'NQM4', schema: 'ohlcv-1m', intervalMs: 60000, start, end: start + 86400000,
    barCount: 1000, checksum: 'proof', source: 'csv', instrument: { root: 'NQ', tickSize: 0.25, pointValue: 20 }, createdAt: '' }], sessions: [],
    registry: [{ name: 'closeGreen', kind: 'outcome', title: 'Green close', doc: 'Close higher than open', examples: ['closeGreen'] },
        { name: 'dayOfWeek', kind: 'field', title: 'Day', doc: '', groupable: true }], limits: { bars: 250000, spanMs: 315360000000, sessions: 100, groups: 100 } } satisfies MarketStatsCatalog;
const pages: ReturnType<typeof mountMarketStatsPage>[] = [];
afterEach(() => { pages.splice(0).forEach(page => page.destroy()); document.body.replaceChildren(); localStorage.clear(); });
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function setup(data: MarketStatsCatalog = catalog, response?: Promise<MarketStatsPageResponse>) {
    const host = document.createElement('div'); document.body.append(host);
    const api = { get: vi.fn(async (_path: string, _signal?: AbortSignal) => data), post: vi.fn((_path: string, _body: unknown, _signal?: AbortSignal) => response ?? Promise.reject(new Error('Synthetic engine error'))) };
    const callbacks = { onHome: vi.fn(), onData: vi.fn() };
    const page = mountMarketStatsPage(host, api as unknown as LocalApi, callbacks); pages.push(page);
    return { host, api, callbacks, page };
}
function field<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement = HTMLInputElement>(host: HTMLElement, name: string): T { return host.querySelector<T>(`[name=${name}]`)!; }
function change(host: HTMLElement, name: string, value: string): void { const input = field(host, name); input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); }
function submit(host: HTMLElement): void { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
function envelope(): MarketStatsPageResponse {
    return { source: { repository: 'https://github.com/LuxAlgo/edge-stats', commit: 'a48259887962d0f67a27d2b0815e2df9a52efca5', version: '0.1.0' },
        selection: { datasetId: 'one-minute', name: 'Cached minute data', symbol: 'NQM4', checksum: 'source-checksum', sourceMode: 'cache', from: start, until: start + 86400000 },
        coverage: { fingerprint: 'coverage-proof', revealedUntil: start + 86400000, inputBarCount: 1000, eligibleBarCount: 998, excludedFutureBars: 2, firstBarOpen: start, lastBarClose: start + 86400000, calendarMode: 'schedule-only' },
        warnings: ['Schedule only: no exchange holiday calendar.'], result: {
            engine: { version: '0.1.0', storeFingerprint: 'store-proof', calendarVersion: 'schedule-only' },
            query: { dsl: 'closeGreen', ast: { outcome: { name: 'closeGreen', args: [] } }, outcome: 'closeGreen', symbol: 'NQM4', sessionKey: 'selected', since: null, until: null },
            n: 40, successes: 24, estimate: 0.6, ci95: [0.445, 0.736], guards: { lowSample: false, refused: false, warnFloor: 30, refuseFloor: 10 },
            stability: { firstHalf: { n: 20, k: 12, estimate: 0.6, ci95: [0.387, 0.781] }, secondHalf: { n: 20, k: 12, estimate: 0.6, ci95: [0.387, 0.781] }, agree: true },
            recency: { window: 20, n: 20, successes: 12, estimate: 0.6, ci95: [0.387, 0.781], diverges: false }, perYear: [{ year: 2024, n: 40, successes: 24, estimate: 0.6 }],
            groups: [{ group: 'Monday', n: 10, successes: 6, estimate: 0.6, ci95: [0.313, 0.832], lowSample: true }],
            distribution: { count: 40, mean: 1.2, min: -2, p25: -0.5, median: 1, p75: 2, p90: 3, max: 4, unit: 'points' },
            sessions: [{ sessionId: '<session-proof>', tradeDate: '2024-04-08', success: true, value: 1.2 }], disclaimer: 'Historical conditional frequencies with sample sizes. Not predictions, not advice.' } };
}
it('renders the complete engine envelope without substituting derived statistics', async () => {
    const response = envelope(); const { host, api } = setup(catalog, Promise.resolve(response)); await flush(); submit(host); await flush();
    const results = host.querySelector<HTMLElement>('.ms-results')!; expect(results.hidden).toBe(false);
    expect([...results.querySelectorAll('.ms-metrics strong')].map(item => item.textContent)).toEqual(['60.0%', '44.5% – 73.6%', '40', '24']);
    for (const text of ['First half', 'Second half', 'Last 20 sessions', '2024', 'Monday', 'points', '2024-04-08', '<session-proof>', 'source-checksum', 'coverage-proof', 'store-proof', response.result.disclaimer]) expect(results.textContent).toContain(text);
    expect(results.querySelector('session-proof')).toBeNull(); expect(api.post.mock.calls[0]![0]).toBe('/api/market-stats/query');
    change(host, 'dsl', 'gapFill'); expect(results.hidden).toBe(true); expect(field(host, 'dsl').value).toBe('gapFill');
});
it.each([9, 20])('shows the engine sample guard and withheld values honestly for N=%s', async n => {
    const response = envelope(); Object.assign(response.result, { n, successes: 5, estimate: n < 10 ? null : 0.25, ci95: null, guards: { ...response.result.guards, lowSample: true, refused: n < 10 } });
    const { host } = setup(catalog, Promise.resolve(response)); await flush(); submit(host); await flush();
    expect(host.querySelector('.ms-results')!.textContent).toContain(n < 10 ? 'Insufficient sample: estimate withheld' : 'Low sample: fewer than 30');
    expect(host.querySelector('.ms-metrics strong')!.textContent).toBe(n < 10 ? '—' : '25.0%');
});
it('uses native page pickers with unique ids, UTC bounds and an inclusive until boundary', async () => {
    const { host } = setup(); const second = setup(); await flush();
    const ids = [...document.querySelectorAll('[id]')].map(item => item.id); expect(new Set(ids).size).toBe(ids.length);
    expect(field(host, 'from').hidden).toBe(true); expect(field(host, 'from').dataset.zone).toBe('UTC');
    expect(host.querySelectorAll('[data-date-time-trigger]')).toHaveLength(2);
    const trigger = host.querySelectorAll<HTMLButtonElement>('[data-date-time-trigger]')[1]!; trigger.click();
    expect(host.querySelector('.date-time-available')!.textContent).toContain('09 April 2024');
    expect(host.querySelector('.date-time-available')!.textContent).toContain('latest allowed');
    const popup = host.querySelector('.date-time-picker:not([hidden])')!;
    popup.querySelector<HTMLInputElement>('[data-draft-date]')!.value = '09/04/2024'; popup.querySelector<HTMLInputElement>('[data-draft-time]')!.value = '00:00:00';
    popup.querySelector<HTMLButtonElement>('[data-picker-apply]')!.click(); expect(field(host, 'until').value).toMatch(/^2024-04-09T00:00/);
    host.querySelector<HTMLButtonElement>('[data-date-time-trigger]')!.click();
    const fromPopup = host.querySelector('.date-time-picker:not([hidden])')!;
    fromPopup.querySelector<HTMLInputElement>('[data-draft-date]')!.value = '09/04/2024'; fromPopup.querySelector<HTMLInputElement>('[data-draft-time]')!.value = '00:00:00';
    fromPopup.querySelector<HTMLButtonElement>('[data-picker-apply]')!.click();
    expect(fromPopup.querySelector('.date-time-error')!.textContent).toContain('within the available range');
    expect(field(host, 'from').value).toBe('2024-04-08T00:00');
    expect(second.host.querySelector('.date-time-picker:not([hidden])')).toBeNull();
});
it('updates dataset and saved replay date bounds from real timestamps without inferring dense bar coverage', async () => {
    const second = { ...catalog.datasets[0]!, id: 'second', name: 'Later cache', start: start + 86400000 * 10, end: start + 86400000 * 12 };
    const replay = { id: 'replay', datasetId: second.id, name: 'Saved range', revision: 7, cursor: 200, startTime: second.start + 3600000, endTime: second.end - 3600000 } as SessionSummary;
    const { host, api } = setup({ ...catalog, datasets: [catalog.datasets[0]!, second], sessions: [replay] }); await flush();
    change(host, 'datasetId', second.id); expect(field(host, 'from').value).toBe('2024-04-18T00:00');
    change(host, 'sourceMode', 'replay'); expect(field(host, 'from').value).toBe('2024-04-18T01:00'); expect(field(host, 'until').value).toBe('2024-04-19T23:00');
    expect(host.textContent).toMatch(/revealed.*server|server.*revealed/i);
    submit(host); await flush(); expect(api.post).toHaveBeenCalledWith('/api/market-stats/query', expect.objectContaining({ datasetId: 'second', from: replay.startTime, until: replay.endTime, replay: { id: 'replay', revision: 7 }, calendar: null }), expect.any(AbortSignal));
});
it('validates hidden canonical date inputs before posting and preserves the draft through refresh', async () => {
    const { host, api, page } = setup(); await flush();
    change(host, 'from', '2024-04-08T00:01:01'); submit(host); await flush(); expect(api.post).not.toHaveBeenCalled(); expect(host.textContent).toMatch(/minute/i);
    change(host, 'from', '2024-04-09T00:00'); submit(host); await flush(); expect(api.post).not.toHaveBeenCalled(); expect(host.textContent).toMatch(/before/i);
    change(host, 'from', '2024-04-08T01:00'); change(host, 'dsl', 'gapFill'); await page.refresh();
    expect(field(host, 'from').value).toBe('2024-04-08T01:00'); expect(field(host, 'dsl').value).toBe('gapFill');
});
it('allows contract-aware continuous sources with honest warnings and keeps one-second sources and missing replays fail closed', async () => {
    const datasets = [{ ...catalog.datasets[0]!, id: 'seconds', intervalMs: 1000 }, { ...catalog.datasets[0]!, id: 'continuous', continuous: { root: 'NQ' } }];
    const { host, api } = setup({ ...catalog, datasets } as MarketStatsCatalog); await flush();
    expect(host.querySelectorAll('[name=datasetId] option:disabled')).toHaveLength(1);
    expect(field(host, 'datasetId').value).toBe('continuous'); expect(host.querySelector<HTMLButtonElement>('[data-stats-run]')!.disabled).toBe(false);
    expect(host.querySelector('.ms-coverage')!.textContent).toContain('Unadjusted continuous'); expect(host.querySelector('.ms-coverage')!.textContent).toContain('mixed or partial contract sessions are omitted');
    expect(host.querySelector('.ms-coverage')!.textContent).toContain('250,000'); submit(host); await flush();
    expect(api.post).toHaveBeenCalledWith('/api/market-stats/query', expect.objectContaining({ datasetId: 'continuous' }), expect.any(AbortSignal));
    change(host, 'datasetId', 'seconds'); submit(host); expect(api.post).toHaveBeenCalledOnce();
    const supported = setup(); await flush(); change(supported.host, 'sourceMode', 'replay'); submit(supported.host);
    expect(supported.api.post).not.toHaveBeenCalled(); expect(supported.host.textContent).toMatch(/saved replay/i);
});
it('aborts query and catalog work on disposal and ignores late responses after cancellation', async () => {
    let resolve!: (response: MarketStatsPageResponse) => void;
    const pending = new Promise<MarketStatsPageResponse>(done => { resolve = done; }); const { host, api, page } = setup(catalog, pending); await flush(); submit(host); await flush();
    const signal = (api.post.mock.calls[0] as unknown[])[2] as AbortSignal; page.cancel(); expect(signal.aborted).toBe(true);
    resolve(envelope()); await flush(); expect(host.querySelector<HTMLElement>('.ms-results')!.hidden).toBe(true);
    const loading = new Promise<MarketStatsCatalog>(() => {}); api.get.mockImplementationOnce(() => loading);
    void page.refresh(); const loadSignal = (api.get.mock.lastCall as unknown[])[1] as AbortSignal;
    page.destroy(); page.destroy(); expect(loadSignal.aborted).toBe(true); expect(host.children).toHaveLength(0);
});
it('lets a newer query own the result and aborts outstanding work on direct disposal', async () => {
    let oldResolve!: (response: MarketStatsPageResponse) => void;
    const old = new Promise<MarketStatsPageResponse>(done => { oldResolve = done; });
    const { host, api, page } = setup(catalog, old); await flush(); submit(host); await flush();
    const oldSignal = api.post.mock.calls[0]![2]!;
    change(host, 'dsl', 'gapFill'); const newest = envelope(); newest.result.query.dsl = 'gapFill'; newest.result.n = 123;
    api.post.mockResolvedValueOnce(newest); submit(host); await flush();
    expect(oldSignal.aborted).toBe(true); expect(host.querySelector('.ms-results')!.textContent).toContain('123');
    const stale = envelope(); stale.result.n = 999; oldResolve(stale); await flush();
    expect(host.querySelector('.ms-results')!.textContent).not.toContain('999');
    change(host, 'dsl', 'closeGreen'); api.post.mockImplementationOnce(() => new Promise(() => {})); submit(host); await flush();
    const liveSignal = api.post.mock.lastCall![2]!; expect(liveSignal.aborted).toBe(false); page.destroy(); expect(liveSignal.aborted).toBe(true);
});
it('ignores a stale catalog response after a newer refresh completes', async () => {
    const { host, api, page } = setup(); await flush();
    let finish!: (value: MarketStatsCatalog) => void;
    api.get.mockImplementationOnce(() => new Promise(done => { finish = done; })); const old = page.refresh();
    const oldSignal = api.get.mock.lastCall![1]!;
    api.get.mockResolvedValueOnce({ ...catalog, datasets: [{ ...catalog.datasets[0]!, name: 'Latest cached source' }] }); await page.refresh();
    expect(oldSignal.aborted).toBe(true); finish({ ...catalog, datasets: [] }); await old;
    expect(host.textContent).toContain('Latest cached source'); expect(host.querySelector<HTMLButtonElement>('[data-stats-run]')!.disabled).toBe(false);
});
it('preparation drains superseded query and catalog handlers while preserving the draft', async () => {
    let finishQuery!: (value: MarketStatsPageResponse) => void, finishCatalog!: (value: MarketStatsCatalog) => void;
    const query = new Promise<MarketStatsPageResponse>(done => { finishQuery = done; });
    const { host, api, page } = setup(catalog, query); await flush(); submit(host); await flush();
    const querySignal = api.post.mock.calls[0]![2]!;
    const loading = new Promise<MarketStatsCatalog>(done => { finishCatalog = done; }); api.get.mockReturnValueOnce(loading);
    const refresh = page.refresh(); const catalogSignal = api.get.mock.lastCall![1]!;
    change(host, 'dsl', 'gapFill'); let prepared = false; const preparation = page.prepare().then(() => { prepared = true; });
    expect(querySignal.aborted).toBe(true); expect(catalogSignal.aborted).toBe(true);
    await flush(); expect(prepared).toBe(false); expect(host.querySelector<HTMLButtonElement>('[data-stats-run]')!.disabled).toBe(true);
    const count = api.get.mock.calls.length; await page.refresh(); expect(api.get).toHaveBeenCalledTimes(count);
    finishCatalog({ ...catalog, datasets: [] }); await refresh; await flush(); expect(prepared).toBe(false);
    finishQuery(envelope()); await preparation;
    expect(field(host, 'dsl').value).toBe('gapFill'); expect(host.querySelector('.ms-results')!.textContent).toBe('');
    expect(field(host, 'datasetId').value).toBe('one-minute');
});
it('shows real cached bounds, documented query choices and an explicit source mode', async () => {
    const { host } = setup(); await flush();
    expect(host.textContent).toContain('Cached minute data');
    expect(host.textContent).toContain('250,000');
    expect(host.querySelector<HTMLInputElement>('[name=from]')?.value).toBe('2024-04-08T00:00');
    expect(host.querySelector<HTMLTextAreaElement>('[name=dsl]')?.value).toBe('closeGreen');
    expect(host.querySelector<HTMLSelectElement>('[name=sourceMode]')?.value).toBe('cache');
});
it('provides an actionable empty-data state instead of a fabricated result', async () => {
    const { host, callbacks, api } = setup({ ...catalog, datasets: [] }); await flush();
    expect(host.querySelector<HTMLButtonElement>('[data-stats-run]')?.disabled).toBe(true);
    host.querySelector<HTMLButtonElement>('[data-stats-data]')!.click(); expect(callbacks.onData).toHaveBeenCalledOnce();
    expect(api.post).not.toHaveBeenCalled(); expect(host.textContent).toContain('one-minute');
});
it('preserves editable controls and ignores a result after a newer draft replaces its request', async () => {
    let resolve!: (response: MarketStatsPageResponse) => void;
    const response = new Promise<MarketStatsPageResponse>(done => { resolve = done; });
    const { host, api } = setup(catalog, response); await flush();
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush();
    expect(api.post).toHaveBeenCalledOnce();
    const query = host.querySelector<HTMLTextAreaElement>('[name=dsl]')!; query.value = 'gapFill'; query.dispatchEvent(new Event('input', { bubbles: true }));
    resolve({ result: { n: 999 } } as MarketStatsPageResponse); await flush();
    expect(query.value).toBe('gapFill'); expect(host.textContent).not.toContain('999');
});
it('surfaces an engine error without losing the query or moving focus into replay', async () => {
    const { host } = setup(); await flush();
    const query = host.querySelector<HTMLTextAreaElement>('[name=dsl]')!; query.focus();
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush();
    expect(host.textContent).toContain('Synthetic engine error'); expect(document.activeElement).toBe(query);
    expect(query.value).toBe('closeGreen');
});
