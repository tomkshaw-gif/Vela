// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryJobSummary, HistorySymbol } from '../server/history-types';
import type { DatasetMeta } from '../shared/types';
import { LocalApi } from '../client/api';
import { mountHistoryControls } from '../client/history-controls';

const id = `history-${'a'.repeat(24)}`;
const hash = 'b'.repeat(64);
const symbols: HistorySymbol[] = ['NQ.v.0', 'GC.v.0'];
const now = '2026-10-21T08:35:12.000Z';
function job(state: HistoryJobSummary['state'] = 'planned'): HistoryJobSummary {
    const complete = state === 'ready';
    return { jobId: id, request: { symbols: [...symbols], start: '2020-01-01T00:00:00.000Z', end: '2026-10-21T08:30:00.000Z' },
        state, completedChunks: complete ? 2 : 0, totalChunks: 2, rows: complete ? 246 : 0, updatedAt: now, error: null,
        chunks: symbols.map(symbol => ({ key: `${symbol.slice(0, 2)}-2026-10`,
            request: { dataset: 'GLBX.MDP3', symbols: symbol, schema: 'ohlcv-1m', stype_in: 'continuous', start: '2026-10-01T00:00:00.000Z', end: '2026-10-21T08:30:00.000Z' },
            state: complete ? 'complete' : 'pending', rows: complete ? 123 : 0,
            rawSha256: complete ? hash : null, normalizedSha256: complete ? hash : null, mappingSha256: complete ? hash : null,
            quotedAt: complete ? now : null, firstTime: null, lastTime: null })) };
}
function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }
const mounted: ReturnType<typeof mountHistoryControls>[] = [];
function fixture(jobs = [job()]) {
    const host = document.createElement('div'); document.body.append(host);
    const api = new LocalApi();
    const get = vi.spyOn(api, 'get').mockImplementation(async <T>(path: string) =>
        (path === '/api/history' ? jobs : jobs.find(item => path === `/api/history/${item.jobId}`)) as T);
    const post = vi.spyOn(api, 'post').mockImplementation(async <T>() => job() as T);
    const onImported = vi.fn<() => Promise<void> | void>();
    const controls = mountHistoryControls(host, api, { onImported }); mounted.push(controls);
    const button = (selector: string) => host.querySelector<HTMLButtonElement>(selector)!;
    const input = (name: string) => host.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    const plan = () => button('[data-history-plan]').click();
    return { host, get, post, onImported, controls, button, input, plan };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in this suite.'); })); });
afterEach(() => { mounted.splice(0).forEach(item => item.destroy()); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('history controls: explicit local staging actions', () => {
    it('mounts with GET only, shows persisted bounds/months, and never polls an externally running job', async () => {
        const f = fixture([job('running')]); await flush();
        expect(f.get).toHaveBeenCalledWith('/api/history', expect.any(AbortSignal));
        expect(f.post).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
        expect(f.input('start').value).toBe('2020-01-01T00:00'); expect(f.input('end').value).toBe('2026-10-21T00:00');
        for (const symbol of symbols) expect(f.host.querySelector<HTMLInputElement>(`[value="${symbol}"]`)!.checked).toBe(true);
        expect(f.host.textContent).toContain('2026-10-21 08:30 UTC'); expect(f.host.textContent).toContain('2020-01-01 00:00 UTC');
        expect(f.host.textContent).toContain('end excluded'); expect(f.host.textContent).toContain('0 / 2');
        expect(f.host.textContent).toContain('NQ-2026-10'); expect(f.host.textContent).toContain('GC-2026-10');
        expect(f.button('[data-history-run]').disabled).toBe(false);
        expect(f.button('[data-history-cancel]').hidden).toBe(true);
        await vi.advanceTimersByTimeAsync(5000); expect(f.get).toHaveBeenCalledTimes(1);
    });

    it('plans only on submission, freezes the selected UTC bounds, and requires another click to download', async () => {
        const f = fixture([]); await flush();
        f.input('end').value = '2026-10-21T08:30';
        f.host.querySelector<HTMLInputElement>('[value="GC.v.0"]')!.checked = false;
        f.plan(); await flush();
        expect(f.post).toHaveBeenCalledExactlyOnceWith('/api/history', {
            symbols: ['NQ.v.0'], start: '2020-01-01T00:00:00.000Z', end: '2026-10-21T08:30:00.000Z',
        }, expect.any(AbortSignal));
        expect(f.host.textContent).toContain('Download'); expect(f.onImported).not.toHaveBeenCalled();
        expect(f.input('end').value).toBe('2026-10-21T08:30');
    });

    it.each(['2019-12-31T23:59', '2026-10-21T08:36', '2020-01-01T00:00', '2026-10-21T08:30:01', ''])(
        'rejects invalid end %s without a POST and retains the draft', async end => {
            const f = fixture([]); await flush(); f.input('end').value = end; const value = f.input('end').value;
            f.plan(); await flush(); expect(f.post).not.toHaveBeenCalled(); expect(f.input('end').value).toBe(value);
            expect(f.host.querySelector<HTMLElement>('[data-history-error]')!.hidden).toBe(false);
        });

    it('requires a symbol and rejects a start before 2020', async () => {
        const f = fixture([]); await flush(); f.input('start').value = '2019-12-31T00:00'; f.plan(); await flush();
        expect(f.post).not.toHaveBeenCalled(); f.input('start').value = '2020-01-01T00:00';
        f.host.querySelectorAll<HTMLInputElement>('[name=symbol]').forEach(input => { input.checked = false; }); f.plan(); await flush();
        expect(f.post).not.toHaveBeenCalled(); expect(f.host.textContent).toContain('Choose NQ');
    });

    it('uses bounded, unique, hidden canonical UTC inputs and themed pickers without native popovers', async () => {
        const f = fixture([]); const second = fixture([]); await flush();
        for (const name of ['start', 'end']) {
            const input = f.input(name); expect(input.hidden).toBe(true); expect(input.readOnly).toBe(true);
            expect(input.type).toBe('datetime-local'); expect(input.dataset.zone).toBe('UTC'); expect(input.step).toBe('60');
            expect(input.id).not.toBe(second.input(name).id);
        }
        const trigger = f.button(`[data-date-time-trigger="${f.input('start').id}"]`); trigger.click();
        expect(f.host.querySelector<HTMLInputElement>('[aria-label="Calendar year"]')!.min).toBe('2020');
        expect(f.host.querySelector<HTMLInputElement>('[aria-label="Calendar year"]')!.max).toBe('2026');
        expect(f.button('[data-calendar-prev]').disabled).toBe(true);
        f.host.querySelector<HTMLInputElement>('[data-draft-date]')!.value = '21/10/2026';
        f.host.querySelector<HTMLInputElement>('[data-draft-time]')!.value = '08:36:00'; f.button('[data-picker-apply]').click();
        expect(f.input('start').value).toBe('2020-01-01T00:00');
        const apply = f.button('[data-picker-apply]'); f.controls.destroy(); apply.click(); trigger.click();
        expect(f.host.querySelector('.date-time-control')).toBeNull(); expect(f.post).not.toHaveBeenCalled();
    });

    it('preserves edited controls and focus through refresh and plan failures', async () => {
        const f = fixture(); await flush();
        const symbol = f.host.querySelector<HTMLInputElement>('[value="GC.v.0"]')!; symbol.checked = false;
        f.input('start').value = '2021-04-01T00:00'; f.input('end').value = '2025-01-01T00:00';
        symbol.focus(); f.button('[data-history-refresh]').click(); await flush();
        expect(document.activeElement).toBe(symbol); expect(symbol.checked).toBe(false);
        f.post.mockRejectedValueOnce(new Error('Local changes in progress. Retry later.')); f.plan(); await flush();
        expect(f.input('start').value).toBe('2021-04-01T00:00'); expect(f.input('end').value).toBe('2025-01-01T00:00');
        expect(f.host.textContent).toContain('Local changes in progress'); expect(symbol.checked).toBe(false);
        expect(f.button('[data-history-plan]').disabled).toBe(false);
    });
});

describe('history controls: owned request lifetime', () => {
    it('allows explicit recovery of recorded running jobs, leaving the live process lock authoritative', async () => {
        const f = fixture([job('running')]); await flush();
        f.post.mockRejectedValueOnce(new Error('This history job is active in another process.'));
        f.button('[data-history-run]').click(); await flush();
        expect(f.post).toHaveBeenCalledExactlyOnceWith(`/api/history/${id}/run`, {}, expect.any(AbortSignal));
        expect(f.host.textContent).toContain('active in another process'); expect(f.button('[data-history-cancel]').hidden).toBe(true);
        f.post.mockResolvedValueOnce(job('ready')); f.button('[data-history-run]').click(); await flush();
        expect(f.host.querySelectorAll('[data-history-import]')).toHaveLength(2);
    });

    it('runs all months with one explicit POST, polls at most once a second, and stops polling after completion', async () => {
        const f = fixture(); await flush(); const run = deferred<HistoryJobSummary>(); f.post.mockReturnValueOnce(run.promise);
        f.button('[data-history-run]').click(); f.button('[data-history-run]').click(); await flush();
        expect(f.post).toHaveBeenCalledExactlyOnceWith(`/api/history/${id}/run`, {}, expect.any(AbortSignal));
        expect(f.button('[data-history-cancel]').hidden).toBe(false);
        await vi.advanceTimersByTimeAsync(999); expect(f.get).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1); expect(f.get).toHaveBeenLastCalledWith(`/api/history/${id}`, expect.any(AbortSignal));
        run.resolve(job('ready')); await flush(); const reads = f.get.mock.calls.length;
        expect(f.host.textContent).toContain('246'); expect(f.host.textContent).toContain('SHA-256');
        await vi.advanceTimersByTimeAsync(5000); expect(f.get).toHaveBeenCalledTimes(reads);
        expect(f.post).toHaveBeenCalledTimes(1); expect(f.onImported).not.toHaveBeenCalled();
    });

    it('prepare aborts the run, waits for a cancellation-ignoring promise, and suppresses late success', async () => {
        const f = fixture(); await flush(); const run = deferred<HistoryJobSummary>(); f.post.mockReturnValueOnce(run.promise);
        f.button('[data-history-run]').click(); await flush(); const signal = f.post.mock.calls[0]![2]!;
        let drained = false; const prepare = f.controls.prepare().then(() => { drained = true; }); await flush();
        expect(signal.aborted).toBe(true); expect(drained).toBe(false);
        f.plan(); await vi.advanceTimersByTimeAsync(2000); expect(f.post).toHaveBeenCalledTimes(1);
        run.resolve(job('ready')); await prepare; expect(drained).toBe(true);
        expect(f.host.querySelector('[data-history-import]')).toBeNull(); expect(f.onImported).not.toHaveBeenCalled();
        expect(f.get).toHaveBeenCalledTimes(1);
    });

    it('preparing in the same turn as a click prevents the queued POST from starting', async () => {
        const f = fixture(); await flush(); f.button('[data-history-run]').click();
        await f.controls.prepare(); expect(f.post).not.toHaveBeenCalled();
        f.plan(); f.button('[data-history-refresh]').click(); await flush();
        expect(f.post).not.toHaveBeenCalled(); expect(f.get).toHaveBeenCalledTimes(1);
    });

    it('drains a pending plan and ignores its late completion without erasing newer input', async () => {
        const f = fixture([]); await flush(); const plan = deferred<HistoryJobSummary>(); f.post.mockReturnValueOnce(plan.promise);
        f.plan(); await flush(); f.input('end').value = '2025-01-01T00:00';
        let drained = false; const ready = f.controls.prepare().then(() => { drained = true; }); await flush();
        expect(f.post.mock.calls[0]![2]!.aborted).toBe(true); expect(drained).toBe(false);
        plan.resolve(job('ready')); await ready;
        expect(f.input('end').value).toBe('2025-01-01T00:00'); expect(f.host.querySelector('.history-job')).toBeNull();
    });

    it('cancel aborts only the pending owned request and allows a deliberate retry after it drains', async () => {
        const f = fixture(); await flush(); const run = deferred<HistoryJobSummary>(); f.post.mockReturnValueOnce(run.promise);
        f.button('[data-history-run]').click(); await flush(); f.button('[data-history-cancel]').click();
        expect(f.post.mock.calls[0]![2]!.aborted).toBe(true);
        run.reject(new DOMException('Aborted', 'AbortError')); await flush();
        expect(f.post).toHaveBeenCalledTimes(1); expect(f.button('[data-history-plan]').disabled).toBe(false);
        expect(f.button('[data-history-cancel]').hidden).toBe(true); f.plan(); await flush(); expect(f.post).toHaveBeenCalledTimes(2);
    });

    it('destroy removes listeners/pickers/timers, aborts reads and ignores every late completion', async () => {
        const f = fixture(); await flush(); const run = deferred<HistoryJobSummary>(); const read = deferred<HistoryJobSummary>();
        f.post.mockReturnValueOnce(run.promise); f.get.mockReturnValueOnce(read.promise);
        f.button('[data-history-run]').click(); await flush(); await vi.advanceTimersByTimeAsync(1000);
        const plan = f.button('[data-history-plan]'); const runButton = f.button('[data-history-run]');
        const refresh = f.button('[data-history-refresh]'); f.controls.destroy(); f.controls.destroy();
        expect(f.post.mock.calls[0]![2]!.aborted).toBe(true); expect(f.get.mock.calls.at(-1)![1]!.aborted).toBe(true);
        f.host.innerHTML = '<p>Replacement content</p>'; read.resolve(job('ready')); run.resolve(job('ready')); await flush();
        plan.click(); runButton.click(); refresh.click(); await vi.advanceTimersByTimeAsync(5000);
        expect(f.host.textContent).toBe('Replacement content'); expect(f.onImported).not.toHaveBeenCalled();
        expect(f.post).toHaveBeenCalledTimes(1); expect(f.get).toHaveBeenCalledTimes(2);
        await f.controls.prepare();
    });

    it('ignores a slow refresh after a newer operation result', async () => {
        const f = fixture(); await flush(); const refresh = deferred<HistoryJobSummary[]>(); f.get.mockReturnValueOnce(refresh.promise);
        f.button('[data-history-refresh]').click(); f.post.mockResolvedValueOnce(job('ready')); f.plan(); await flush();
        refresh.resolve([job()]); await flush(); expect(f.host.querySelectorAll('[data-history-import]')).toHaveLength(2);
    });

    it('keeps ready imports after a stale progress response and returns keyboard focus to the job', async () => {
        const f = fixture(); await flush(); const run = deferred<HistoryJobSummary>(); const progress = deferred<HistoryJobSummary>();
        f.post.mockReturnValueOnce(run.promise); f.get.mockReturnValueOnce(progress.promise);
        f.button('[data-history-run]').focus(); f.button('[data-history-run]').click(); await flush();
        await vi.advanceTimersByTimeAsync(1000); run.resolve(job('ready')); await flush();
        expect(document.activeElement?.tagName).toBe('H4');
        progress.resolve(job('running')); await flush(); expect(f.host.querySelectorAll('[data-history-import]')).toHaveLength(2);
    });

    it('keeps one progress read in flight and preserves expanded month details and keyboard focus', async () => {
        const f = fixture(); await flush(); const run = deferred<HistoryJobSummary>(); const read = deferred<HistoryJobSummary>();
        f.post.mockReturnValueOnce(run.promise); f.get.mockReturnValueOnce(read.promise); f.button('[data-history-run]').click(); await flush();
        const details = f.host.querySelector('details')!; details.open = true; details.querySelector('summary')!.focus();
        await vi.advanceTimersByTimeAsync(5000); expect(f.get).toHaveBeenCalledTimes(2);
        read.resolve(job('running')); await flush(); expect(f.host.querySelector('details')!.open).toBe(true);
        expect(document.activeElement?.tagName).toBe('SUMMARY'); run.resolve(job('ready')); await flush();
    });
});

describe('history controls: separate verified imports', () => {
    it.each(['planned', 'running', 'cancelled', 'failed'] as const)('never offers import for %s jobs', async state => {
        const f = fixture([job(state)]); await flush(); expect(f.host.querySelector('[data-history-import]')).toBeNull();
        expect(f.post).not.toHaveBeenCalled();
    });

    it('fails closed on incomplete or missing integrity receipts, and never constructs paths from invalid IDs', async () => {
        const missing = job('ready'); missing.chunks[0]!.mappingSha256 = null;
        const invalid = job('ready'); invalid.jobId = '../invalid';
        const f = fixture([missing, invalid]); await flush();
        expect(f.host.querySelector('[data-history-import]')).toBeNull(); expect(f.post).not.toHaveBeenCalled();
        expect(f.host.textContent).toContain('integrity');
    });

    it('imports one ready symbol only on click, then refreshes the catalog without replacing the form draft', async () => {
        const f = fixture([job('ready')]); await flush(); f.input('start').value = '2021-01-01T00:00';
        const result = { id: 'cached-nq', symbol: 'NQ.v.0' } as DatasetMeta; f.post.mockResolvedValueOnce(result);
        expect(f.post).not.toHaveBeenCalled(); f.button('[data-history-import][data-symbol="NQ.v.0"]').click(); await flush();
        expect(f.post).toHaveBeenCalledExactlyOnceWith(`/api/history/${id}/import`, { symbol: 'NQ.v.0' }, expect.any(AbortSignal));
        expect(f.onImported).toHaveBeenCalledExactlyOnceWith(); expect(f.input('start').value).toBe('2021-01-01T00:00');
    });

    it.each([409, 503])('preserves draft and ready jobs when import is rejected with %i', async code => {
        const f = fixture([job('ready')]); await flush(); f.input('end').value = '2025-01-01T00:00';
        f.post.mockRejectedValueOnce(new Error(`${code}: Wait for other local changes before importing history.`));
        f.button('[data-history-import]').click(); await flush();
        expect(f.input('end').value).toBe('2025-01-01T00:00'); expect(f.onImported).not.toHaveBeenCalled();
        expect(f.host.textContent).toContain('Wait for other local changes'); expect(f.button('[data-history-import]').disabled).toBe(false);
    });

    it('prepare aborts import and ignores its late result; it also drains an already-running catalog callback', async () => {
        const f = fixture([job('ready')]); await flush(); const imported = deferred<DatasetMeta>(); f.post.mockReturnValueOnce(imported.promise);
        f.button('[data-history-import]').click(); await flush(); let drained = false;
        const prepared = f.controls.prepare().then(() => { drained = true; }); await flush();
        expect(f.post.mock.calls[0]![2]!.aborted).toBe(true); expect(drained).toBe(false);
        imported.resolve({ id: 'late' } as DatasetMeta); await prepared; expect(f.onImported).not.toHaveBeenCalled();
        const second = fixture([job('ready')]); await flush(); const callback = deferred<void>();
        second.onImported.mockReturnValueOnce(callback.promise); second.post.mockResolvedValueOnce({ id: 'cached' } as DatasetMeta);
        second.button('[data-history-import]').click(); await flush(); expect(second.onImported).toHaveBeenCalledOnce();
        let callbackDrained = false; const ready = second.controls.prepare().then(() => { callbackDrained = true; }); await flush();
        expect(callbackDrained).toBe(false); callback.resolve(); await ready; expect(callbackDrained).toBe(true);
    });

    it('destroy aborts a pending import and suppresses its late catalog callback', async () => {
        const f = fixture([job('ready')]); await flush(); const imported = deferred<DatasetMeta>(); f.post.mockReturnValueOnce(imported.promise);
        f.button('[data-history-import]').click(); await flush(); f.controls.destroy();
        expect(f.post.mock.calls[0]![2]!.aborted).toBe(true);
        imported.resolve({ id: 'late' } as DatasetMeta); await flush();
        expect(f.onImported).not.toHaveBeenCalled(); expect(f.host.childElementCount).toBe(0);
    });

    it('retains the committed import status when only catalog refresh fails', async () => {
        const f = fixture([job('ready')]); await flush(); f.post.mockResolvedValueOnce({ id: 'cached' } as DatasetMeta);
        f.onImported.mockRejectedValueOnce(new Error('Catalog temporarily unavailable'));
        f.button('[data-history-import]').click(); await flush();
        expect(f.host.textContent).toContain('added to cached datasets'); expect(f.host.textContent).toContain('Catalog temporarily unavailable');
        expect(f.input('start').value).toBe('2020-01-01T00:00');
    });
});
