// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScriptRunResult, StrategyState, StrategyTrade } from '../../src/index';
import type { VelaWorkspace } from '../../src/workspace';
import type { LocalApi } from '../client/api';
import type { PineEditorOptions } from '../client/pine-editor';
import type { StrategyResultsSnapshot } from '../shared/strategy-analysis';
import type { BacktestSnapshot, ScriptDocument, StoredBacktest } from '../shared/scripts';
import type { SessionView } from '../shared/types';
import type { PineBacktestOptions, PineBacktestResult } from '../scripting/backtest';
import type { DeepHistoryResponse, DeepSeriesResponse } from '../shared/deep-backtest';

const mocks = vi.hoisted(() => ({
    editorOptions: undefined as PineEditorOptions | undefined,
    editor: { open: vi.fn(), flush: vi.fn<() => Promise<void>>(), destroy: vi.fn() },
    results: { update: vi.fn<(value: StrategyResultsSnapshot) => void>(), destroy: vi.fn() },
    backtest: vi.fn<(options: PineBacktestOptions) => Promise<PineBacktestResult>>(), download: vi.fn(),
}));
vi.mock('../client/pine-editor', () => ({ mountPineEditor: (_host: HTMLElement, options: PineEditorOptions) => { mocks.editorOptions = options; return mocks.editor; } }));
vi.mock('../client/strategy-results', () => ({ mountStrategyResults: () => mocks.results }));
vi.mock('../scripting/backtest', () => ({ runPineBacktest: mocks.backtest }));
vi.mock('../client/util', () => ({ downloadJson: mocks.download }));
vi.mock('../../src/plugin', () => ({ registerIcon: vi.fn(), registerLegendAction: vi.fn(), iconMarkup: () => '<svg></svg>' }));
import { mountScriptWorkspace } from '../client/script-workspace';

const disposers: (() => void)[] = [];
const state = (netPnl: number): StrategyState => ({ position: 0, avgPrice: 0, equity: 50000 + netPnl, openPnl: 0, netPnl, grossProfit: netPnl, grossLoss: 0, wins: 1, losses: 0, even: 0, maxDrawdown: 10, maxRunup: netPnl, initialCapital: 50000 });
const doc = (id: string): ScriptDocument => ({ id: `script-${id}`, name: `Strategy ${id}`, source: `source-${id}`, revision: 1, versions: 1, archived: false, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' });
function stored(id: string): StoredBacktest {
    return { id: `run-${id}`, name: `Strategy ${id}`, createdAt: '2026-10-20T00:00:00Z', scriptVersion: 1, source: `source-${id}`, symbol: 'NQM4', timeframe: '1', datasetId: 'dataset', datasetChecksum: 'checksum', from: 0, to: 60000, inputs: {}, properties: {}, engine: {}, result: { state: state(id === 'A' ? 100 : 200), trades: [], warnings: [] } };
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
beforeEach(() => {
    vi.clearAllMocks(); mocks.backtest.mockReset(); mocks.editorOptions = undefined; mocks.editor.flush.mockResolvedValue();
    mocks.editor.open.mockReturnValue(true);
    mocks.backtest.mockImplementation(async (options) => ({ state: state(options.source === 'source-A' ? 100 : 200), trades: [], warnings: [] }));
});
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); });

async function fixture(initialOpen = true, openEditor = true) {
    const root = document.createElement('div'); root.innerHTML = '<div class="vela-widget-panels"></div>'; document.body.append(root);
    let onUpdate: ((run: NonNullable<ScriptRunResult['run']>) => void) | undefined;
    const chartRun = { id: 'chart-B', title: 'Chart B', kind: 'strategy', strategy: state(20), warnings: [], trades: vi.fn(async () => []) } as unknown as NonNullable<ScriptRunResult['run']>;
    const result = { ok: true, run: chartRun, error: null, onUpdate: (callback: typeof onUpdate) => { onUpdate = callback; return () => { onUpdate = undefined; }; }, remove: vi.fn() } as ScriptRunResult;
    const handle = { id: 'chart-B', title: 'Chart B', source: 'source-B', remove: vi.fn(), inputValues: () => ({}), propValues: () => ({}), updateCode: vi.fn(async (): Promise<{ ok: boolean; error: Error | null }> => ({ ok: true, error: null })), context: vi.fn(async () => ({ strategy: state(30), trades: [], warnings: [] })) };
    const chart = { market: { timeframe: '1' }, runScript: vi.fn(async () => result), indicators: () => [handle], setVisibleRange: vi.fn(), renderer: { supportsIndicatorSettings: true, openIndicatorSettings: vi.fn() } };
    const workspace = { root, chart, context: () => ({ dockStrip: (element: HTMLElement) => { root.append(element); return () => element.remove(); } }) } as unknown as VelaWorkspace;
    const series = { bars: [{ time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 }, { time: 60000, open: 101, high: 101, low: 101, close: 101, volume: 1 }], hasMore: false, cursorTime: 60000, symbolInfo: { ticker: 'NQM4', mintick: .25, pointvalue: 20 }, sourceDatasets: [{ id: 'dataset', checksum: 'checksum' }] };
    const get = vi.fn(async (path: string): Promise<unknown> => path.includes('/series?') ? series : [stored('A'), stored('B')]);
    const post = vi.fn(async (_path: string, payload: { name: string; snapshot: BacktestSnapshot }) => ({ ...payload.snapshot, name: payload.name, id: 'saved-new', createdAt: '2026-10-20T00:00:00Z' }));
    const api = { get, post } as unknown as LocalApi;
    const view = { session: { id: 'session', cursor: 1 }, dataset: { id: 'dataset', symbol: 'NQM4', start: 0, end: 180000, intervalMs: 60000, checksum: 'checksum' } } as SessionView;
    const onChange = vi.fn(async () => {}), onError = vi.fn();
    const app = mountScriptWorkspace({ workspace, api, session: () => view, initialOpen, cutoff: () => 60000, blocked: () => false, onChange, onError }); disposers.push(app.destroy);
    if (openEditor) {
        root.querySelector<HTMLButtonElement>('[aria-label="Pine Editor"]')!.click();
        await vi.waitFor(() => expect(mocks.editorOptions).toBeDefined());
    }
    return { root, app, get, post, chart, workspace, view, chartRun, handle, onChange, onError, series,
        emit: (run = chartRun) => onUpdate?.(run), editor: mocks.editorOptions! };
}
const latest = (): StrategyResultsSnapshot | undefined => mocks.results.update.mock.lastCall?.[0];
async function link(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
    f.root.dispatchEvent(new CustomEvent('local-pine:edit', { detail: { id: f.handle.id, source: f.handle.source, name: f.handle.title } }));
    await vi.waitFor(() => expect(mocks.editor.open).toHaveBeenCalled());
}

describe('chart execution ownership', () => {
    it('continues the previous live report when compiling a new chart script fails', async () => {
        const f = await fixture(); await f.editor.onRun('source-B');
        f.root.querySelector<HTMLButtonElement>('[aria-label="Strategy Tester"]')!.click();
        f.chart.runScript.mockResolvedValueOnce({ ok: false, run: null, error: new Error('Compile failed'), onUpdate: () => () => {}, remove: vi.fn() });
        await expect(f.editor.onRun('bad-new-source')).rejects.toThrow('Compile failed');
        f.emit({ ...f.chartRun, title: 'Previous live run' });
        await vi.waitFor(() => expect(latest()?.name).toBe('Previous live run'));
    });
    it('keeps the existing link when the editor refuses a chart-source switch', async () => {
        const f = await fixture(); await link(f);
        const other = { ...f.handle, updateCode: vi.fn(async () => ({ ok: true, error: null })), remove: vi.fn() };
        mocks.editor.open.mockReturnValueOnce(false);
        Object.defineProperty(f.workspace, 'chart', { value: { ...f.chart, indicators: () => [other] }, configurable: true });
        f.root.dispatchEvent(new CustomEvent('local-pine:edit', { detail: { id: other.id, source: other.source, name: 'Other' } }));
        await vi.waitFor(() => expect(mocks.editor.open).toHaveBeenCalledTimes(2));
        await expect(f.editor.onUpdate(f.handle.id, 'must stay with first')).rejects.toThrow(/chart|session/);
        expect(other.updateCode).not.toHaveBeenCalled();
    });
    it.each(['update', 'remove'] as const)('rechecks the linked owner after saving before %s mutates a handle', async action => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A')); await link(f);
        const pending = deferred<StoredBacktest>(); f.post.mockReturnValueOnce(pending.promise);
        const operation = action === 'update' ? f.editor.onUpdate(f.handle.id, 'new') : f.editor.onRemove!(f.handle.id);
        const rejected = expect(operation).rejects.toThrow(/chart|session/);
        await vi.waitFor(() => expect(f.post).toHaveBeenCalled());
        Object.defineProperty(f.workspace, 'chart', { value: { ...f.chart }, configurable: true }); pending.resolve(stored('A')); await rejected;
        expect(f.handle.updateCode).not.toHaveBeenCalled(); expect(f.handle.remove).not.toHaveBeenCalled();
        expect(latest()?.name).toBe('Strategy A');
    });
    it.each([true, false])('continues live report updates after an in-place compile (success=%s)', async success => {
        const f = await fixture(); await f.editor.onRun('source-B');
        f.root.querySelector<HTMLButtonElement>('[aria-label="Strategy Tester"]')!.click();
        f.handle.updateCode.mockResolvedValueOnce({ ok: success, error: success ? null : new Error('Compile failed') });
        if (success) await f.editor.onUpdate(f.handle.id, 'new');
        else await expect(f.editor.onUpdate(f.handle.id, 'new')).rejects.toThrow('Compile failed');
        f.emit({ ...f.chartRun, title: 'Latest live run' });
        await vi.waitFor(() => expect(latest()?.name).toBe('Latest live run'));
    });
    it('keeps separately created runs with identical chart-local IDs for owned disposal', async () => {
        const f = await fixture(); await f.editor.onRun('source-B');
        const first = await f.chart.runScript(); f.chart.runScript.mockClear();
        const second = { ...first, remove: vi.fn() };
        Object.defineProperty(f.workspace, 'chart', { value: { ...f.chart, runScript: async () => second }, configurable: true });
        await f.editor.onRun('source-B'); f.app.destroy();
        expect(first.remove).toHaveBeenCalledOnce(); expect(second.remove).toHaveBeenCalledOnce();
    });
    it.each(['update', 'remove'] as const)('rejects linked %s after another chart reuses the same script ID', async action => {
        const f = await fixture(); await link(f);
        const other = { ...f.handle, updateCode: vi.fn(async () => ({ ok: true, error: null })), remove: vi.fn() };
        Object.defineProperty(f.workspace, 'chart', { value: { ...f.chart, indicators: () => [other] }, configurable: true });
        await expect(action === 'update' ? f.editor.onUpdate(f.handle.id, 'new') : f.editor.onRemove!(f.handle.id)).rejects.toThrow(/chart|session/);
        expect(other.updateCode).not.toHaveBeenCalled(); expect(other.remove).not.toHaveBeenCalled();
        expect(f.handle.updateCode).not.toHaveBeenCalled(); expect(f.handle.remove).not.toHaveBeenCalled();
        expect(f.onChange).not.toHaveBeenCalled();
    });
    it.each(['chart', 'session', 'handle', 'timeframe'] as const)('rejects a delayed compilation when the %s owner changes', async change => {
        const f = await fixture(); await link(f);
        const pending = deferred<{ ok: boolean; error: Error | null }>(); f.handle.updateCode.mockReturnValueOnce(pending.promise);
        const operation = f.editor.onUpdate(f.handle.id, 'new'); const rejected = expect(operation).rejects.toThrow(/chart|session|script/);
        await vi.waitFor(() => expect(f.handle.updateCode).toHaveBeenCalledOnce());
        if (change === 'chart') Object.defineProperty(f.workspace, 'chart', { value: { ...f.chart }, configurable: true });
        if (change === 'session') f.view.session.id = 'next-session';
        if (change === 'handle') f.chart.indicators = () => [{ ...f.handle }];
        if (change === 'timeframe') f.chart.market.timeframe = '5';
        pending.resolve({ ok: true, error: null }); await rejected;
        expect(f.handle.context).not.toHaveBeenCalled(); expect(f.onChange).not.toHaveBeenCalled(); expect(latest()).toBeUndefined();
    });
    it('rechecks ownership after context retrieval and does not publish or persist a stale report', async () => {
        const f = await fixture(); await link(f);
        const pending = deferred<Awaited<ReturnType<typeof f.handle.context>>>(); f.handle.context.mockReturnValueOnce(pending.promise);
        const operation = f.editor.onUpdate(f.handle.id, 'new'); const rejected = expect(operation).rejects.toThrow(/chart|session/);
        await vi.waitFor(() => expect(f.handle.context).toHaveBeenCalled());
        Object.defineProperty(f.workspace, 'chart', { value: { ...f.chart }, configurable: true });
        pending.resolve({ strategy: state(999), trades: [], warnings: [] }); await rejected; await f.app.flush();
        expect(latest()).toBeUndefined(); expect(f.post).not.toHaveBeenCalled();
    });
    it('discards chart tick trades that resolve after switching charts', async () => {
        const f = await fixture(); await f.editor.onRun('source-B');
        f.root.querySelector<HTMLButtonElement>('[aria-label="Strategy Tester"]')!.click();
        const pending = deferred<readonly StrategyTrade[]>();
        f.emit({ ...f.chartRun, title: 'Stale chart', trades: () => pending.promise });
        Object.defineProperty(f.workspace, 'chart', { value: { ...f.chart }, configurable: true });
        pending.resolve([]); await vi.waitFor(() => expect(f.onError).toHaveBeenCalled());
        expect(latest()?.name).toBe('Chart B');
    });
    it('removes only the recorded active handle and invalidates its chart callbacks', async () => {
        const f = await fixture(); await f.editor.onRun('source-B');
        await f.editor.onRemove!(f.handle.id); expect(f.handle.remove).toHaveBeenCalledOnce();
        const calls = mocks.results.update.mock.calls.length; f.emit(); await Promise.resolve(); await Promise.resolve();
        expect(mocks.results.update).toHaveBeenCalledTimes(calls);
        await expect(f.editor.onUpdate(f.handle.id, 'new')).rejects.toThrow(/chart|session|script/);
    });
});

describe('script dock placement', () => {
    it('starts Chart mode closed while replay, editor and tester remain available', async () => {
        const f = await fixture(false, false); const dock = f.root.querySelector<HTMLElement>('.local-script-dock')!;
        expect(dock.hidden).toBe(true); expect(mocks.editorOptions).toBeUndefined();
        f.root.dispatchEvent(new CustomEvent('local-replay:chrome', { detail: { kind: 'replay-toggle' } }));
        expect(dock.hidden).toBe(false); expect(dock.dataset.activeTab).toBe('replay');
        dock.querySelector<HTMLButtonElement>('.local-script-close')!.click();
        f.root.querySelector<HTMLButtonElement>('[aria-label="Pine Editor"]')!.click();
        await vi.waitFor(() => expect(mocks.editorOptions).toBeDefined()); expect(dock.hidden).toBe(false);
        f.root.querySelector<HTMLButtonElement>('[aria-label="Strategy Tester"]')!.click();
        expect(dock.dataset.activeTab).toBe('tester'); expect(dock.hidden).toBe(false);
    });
    it('maximizes outside a positioned strip and restores its slot and resized height before close or disposal', async () => {
        const root = document.createElement('div'); root.style.position = 'relative';
        root.innerHTML = '<div class="vela-widget-panels"></div><div class="positioned-strip" style="position:relative;height:49px"><span>Before</span><span>After</span></div>';
        document.body.append(root);
        const strip = root.querySelector<HTMLElement>('.positioned-strip')!;
        const after = strip.lastChild!;
        const undock = vi.fn((element: HTMLElement) => { expect(element.parentElement).toBe(strip); element.remove(); });
        const workspace = { root, context: () => ({ dockStrip: (element: HTMLElement) => { strip.insertBefore(element, after); return () => undock(element); } }) } as unknown as VelaWorkspace;
        const api = { get: vi.fn(async () => []) } as unknown as LocalApi;
        const app = mountScriptWorkspace({ workspace, api, session: () => null, cutoff: () => null, blocked: () => false, onChange: async () => {}, onError: vi.fn() });
        disposers.push(app.destroy);
        root.querySelector<HTMLButtonElement>('[aria-label="Strategy Tester"]')!.click();
        const dock = strip.querySelector<HTMLElement>('.local-script-dock')!;
        const max = dock.querySelector<HTMLButtonElement>('.local-script-max')!;
        dock.style.height = '315px';
        max.click();
        expect(dock.parentElement).toBe(root); expect(dock.classList.contains('local-script-maximized')).toBe(true); expect(max.getAttribute('aria-pressed')).toBe('true');
        max.click();
        expect(dock.parentElement).toBe(strip); expect(dock.nextSibling).toBe(after); expect(dock.style.height).toBe('315px');
        max.click(); dock.querySelector<HTMLButtonElement>('.local-script-close')!.click();
        expect(dock.parentElement).toBe(strip); expect(dock.hidden).toBe(true); expect(dock.classList.contains('local-script-maximized')).toBe(false);
        root.querySelector<HTMLButtonElement>('[aria-label="Strategy Tester"]')!.click(); max.click();
        app.destroy(); disposers.splice(disposers.indexOf(app.destroy), 1);
        expect(undock).toHaveBeenCalledTimes(1); expect(root.querySelector('.local-script-dock')).toBeNull();
        expect([...strip.childNodes].some(node => node.nodeType === Node.COMMENT_NODE)).toBe(false);
        await Promise.resolve();
    });
});

describe('public strategy tester controller', () => {
    it('starts the exact indicator through the shared tester and returns copied result ownership', async () => {
        const f = await fixture();
        f.handle.inputValues = () => ({ length: 42 }); f.handle.propValues = () => ({ initial_capital: 25000 });
        f.chart.indicators = () => [{ ...f.handle, id: 'same-source-other', inputValues: () => ({ length: 2 }) }, f.handle];
        expect(f.app.readCurrentResult()).toBeNull();
        const assertCurrent = vi.fn();
        const completed = await f.app.startBacktestForIndicator(f.handle.id, { mode: 'replay', operationId: 'agent-run' }, assertCurrent);
        expect(mocks.backtest.mock.lastCall![0]).toMatchObject({ source: 'source-B', inputs: { length: 42 }, props: { initial_capital: 25000 }, cutoff: 60000 });
        expect(completed.snapshot).toMatchObject({ source: 'source-B', inputs: { length: 42 } });
        expect(completed.result.state.netPnl).toBe(200); expect(assertCurrent).toHaveBeenCalled();
        completed.result.state.netPnl = -999;
        expect(f.app.readCurrentResult()!.result.state.netPnl).toBe(200);
        await f.app.flush();
        expect(f.post.mock.lastCall![1].snapshot.source).toBe('source-B');
    });
    it('cancels only the agent operation that owns the shared worker and preserves the previous result', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A'));
        let signal: AbortSignal | undefined;
        mocks.backtest.mockImplementationOnce(options => new Promise((_resolve, reject) => { signal = options.signal;
            signal!.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }); }));
        const operation = f.app.startBacktestForIndicator(f.handle.id, { mode: 'replay', operationId: 'owned-run' });
        const rejected = expect(operation).rejects.toThrow('Cancelled');
        await vi.waitFor(() => expect(signal).toBeDefined());
        expect(f.app.cancelBacktest('different-run')).toBe(false); expect(signal!.aborted).toBe(false);
        expect(f.app.cancelBacktest('owned-run')).toBe(true); await rejected;
        expect(f.app.cancelBacktest('owned-run')).toBe(false);
        expect(f.app.readCurrentResult()?.snapshot?.source).toBe('source-A');
    });
    it('requires explicit deep dates and refuses date bounds on a normal replay run', async () => {
        const f = await fixture();
        await expect(f.app.startBacktestForIndicator(f.handle.id, { mode: 'deep' })).rejects.toThrow('UTC');
        await expect(f.app.startBacktestForIndicator(f.handle.id, { mode: 'replay', from: 0, to: 60000 })).rejects.toThrow('replay');
        expect(mocks.backtest).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
    });
    it('rechecks the external caller guard before publishing a completed result', async () => {
        const f = await fixture(); const pending = deferred<PineBacktestResult>(); mocks.backtest.mockReturnValueOnce(pending.promise);
        let current = true;
        const operation = f.app.startBacktestForIndicator(f.handle.id, { mode: 'replay', operationId: 'guarded-run' }, () => {
            if (!current) throw new Error('The caller changed.');
        });
        const rejected = expect(operation).rejects.toThrow('caller changed');
        await vi.waitFor(() => expect(mocks.backtest).toHaveBeenCalled()); current = false;
        pending.resolve({ state: state(999), trades: [], warnings: [] }); await rejected;
        expect(f.app.readCurrentResult()).toBeNull(); expect(f.post).not.toHaveBeenCalled();
    });
    it.each(['inputs', 'props'])('rejects an exact indicator whose %s change during the run', async field => {
        const f = await fixture(); const pending = deferred<PineBacktestResult>(); mocks.backtest.mockReturnValueOnce(pending.promise);
        f.root.dispatchEvent(new CustomEvent('local-pine:edit', { detail: { id: f.handle.id, source: f.handle.source, name: 'B' } }));
        await vi.waitFor(() => expect(mocks.editor.open).toHaveBeenCalled());
        const running = f.editor.onBacktest(f.handle.source, null, { instanceId: f.handle.id });
        const rejected = expect(running).rejects.toThrow('changed during the backtest');
        await vi.waitFor(() => expect(mocks.backtest).toHaveBeenCalled());
        if (field === 'inputs') f.handle.inputValues = () => ({ length: 99 }); else f.handle.propValues = () => ({ initial_capital: 999 });
        pending.resolve({ state: state(999), trades: [], warnings: [] }); await rejected;
        expect(latest()).toBeUndefined();
    });
    it('records exact normal-run secondary dataset checksums and refuses missing metadata', async () => {
        const f = await fixture();
        const secondary = { ...f.series, sourceDatasets: [{ id: 'secondary', checksum: 'secondary-checksum' }] };
        f.get.mockImplementation(async path => path.includes('/series?') ? path.includes('symbol=') ? secondary : f.series : []);
        mocks.backtest.mockImplementationOnce(async options => {
            await options.fetchSeriesAt!('replay:ESM4', '5', {}, 60000, options.signal!);
            return { state: state(250), trades: [], warnings: [] };
        });
        await f.editor.onBacktest('source-A', doc('A')); await f.app.flush();
        expect(f.post.mock.lastCall![1].snapshot).toMatchObject({ provenance: { version: 1, mode: 'replay', reportedBy: 'client', sessionId: 'session', cursor: 1, cutoff: 60000,
            primarySourceDatasets: f.series.sourceDatasets, secondarySourceDatasets: secondary.sourceDatasets } });
        f.get.mockImplementation(async path => path.includes('/series?') ? { ...f.series, sourceDatasets: undefined } : []);
        await expect(f.editor.onBacktest('source-B', doc('B'))).rejects.toThrow('provenance');
        expect(latest()?.state.netPnl).toBe(250);
    });
    it('rejects conflicting normal secondary dataset checksums rather than publishing a partial report', async () => {
        const f = await fixture();
        f.get.mockImplementation(async path => path.includes('/series?') ? path.includes('symbol=')
            ? { ...f.series, sourceDatasets: [{ id: 'dataset', checksum: 'changed-checksum' }] } : f.series : []);
        mocks.backtest.mockImplementationOnce(async options => {
            await options.fetchSeriesAt!('replay:NQM4', '5', {}, 60000, options.signal!);
            return { state: state(999), trades: [], warnings: [] };
        });
        await expect(f.app.startBacktestForIndicator(f.handle.id, { mode: 'replay' })).rejects.toThrow('secondary dataset changed');
        expect(f.app.readCurrentResult()).toBeNull(); expect(f.post).not.toHaveBeenCalled();
    });
});

describe('script workspace result ownership', () => {
    it('persists an unsaved result before opening a different saved run', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A'));
        f.get.mockImplementation(async (path) => path === '/api/backtests/run-B' ? stored('B') : [stored('A'), stored('B')]);
        const pending = deferred<StoredBacktest>(); f.post.mockReturnValueOnce(pending.promise);
        const select = f.root.querySelector<HTMLSelectElement>('.local-backtest-library')!;
        select.value = 'run-B'; select.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
        expect(latest()?.name).toBe('Strategy A'); expect(f.get).not.toHaveBeenCalledWith('/api/backtests/run-B');
        pending.resolve(stored('A'));
        await vi.waitFor(() => expect(latest()?.name).toBe('Strategy B'));
        await f.app.flush(); expect(f.post).toHaveBeenCalledOnce();
        expect(select.value).toBe('run-B');
    });
    it('keeps the current result when saving it before a library switch fails', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A'));
        f.post.mockRejectedValueOnce(new Error('Store is full'));
        const select = f.root.querySelector<HTMLSelectElement>('.local-backtest-library')!;
        select.value = 'run-B'; select.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(f.onError).toHaveBeenCalled());
        expect(latest()?.name).toBe('Strategy A'); expect(select.value).toBe('');
        f.root.querySelector<HTMLButtonElement>('.local-backtest-export')!.click();
        expect(mocks.download.mock.lastCall?.[1]).toMatchObject({ snapshot: { source: 'source-A' } });
    });
    it('recovers from permanent save failure only after exporting and explicitly discarding the pending snapshot', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A'));
        f.post.mockRejectedValue(new Error('Store is full'));
        await expect(f.app.prepareForUpdate()).rejects.toThrow('Store is full');
        const discard = f.root.querySelector<HTMLButtonElement>('.local-backtest-discard')!;
        expect(discard.hidden).toBe(false); expect(discard.disabled).toBe(true);
        discard.click(); expect(f.app.readCurrentResult()?.snapshot?.source).toBe('source-A');
        await expect(f.editor.onRun('source-B')).rejects.toThrow('Store is full');
        await link(f); await expect(f.editor.onUpdate('chart-B', 'changed')).rejects.toThrow('Store is full');
        await expect(f.app.startBacktestForIndicator(f.handle.id, { mode: 'replay' })).rejects.toThrow('Store is full');
        expect(f.chart.runScript).not.toHaveBeenCalled(); expect(f.handle.updateCode).not.toHaveBeenCalled();
        expect(latest()?.name).toBe('Strategy A'); expect(mocks.backtest).toHaveBeenCalledOnce();
        f.root.querySelector<HTMLButtonElement>('.local-backtest-export')!.click();
        expect(mocks.download.mock.lastCall?.[1]).toMatchObject({ snapshot: { source: 'source-A' } });
        expect(discard.disabled).toBe(false);
        await expect(f.app.prepareForUpdate()).rejects.toThrow('Store is full');
        expect(f.app.readCurrentResult()?.snapshot?.source).toBe('source-A');
        discard.click();
        expect(discard.hidden).toBe(true); expect(latest()?.name).toBe('Strategy A');
        expect(f.app.readCurrentResult()?.snapshot).toBeNull();
        const saves = f.post.mock.calls.length; await f.app.prepareForUpdate();
        expect(f.post).toHaveBeenCalledTimes(saves);
        f.chart.market.timeframe = 'D'; await f.app.startBacktestForIndicator(f.handle.id, { mode: 'replay' });
        expect(mocks.backtest.mock.lastCall![0].market.timeframe).toBe('D'); expect(latest()?.name).toBe('Chart B');
        expect(discard.hidden).toBe(true);
    });
    it('preserves recovery data when exporting fails and clears recovery controls after a successful save retry', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A'));
        f.post.mockRejectedValueOnce(new Error('Store is full'));
        await expect(f.app.flush()).rejects.toThrow('Store is full');
        const discard = f.root.querySelector<HTMLButtonElement>('.local-backtest-discard')!;
        mocks.download.mockImplementationOnce(() => { throw new Error('Export failed'); });
        f.root.querySelector<HTMLButtonElement>('.local-backtest-export')!.click();
        expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Export failed' }));
        expect(discard.disabled).toBe(true); expect(f.app.readCurrentResult()?.snapshot?.source).toBe('source-A');
        await f.app.flush();
        expect(discard.hidden).toBe(true); expect(f.app.readCurrentResult()?.savedRunId).toBe('saved-new');
    });
    it('opens saved runs after explicit export and discard despite continued storage failure', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A'));
        f.post.mockRejectedValue(new Error('Store is full'));
        f.get.mockImplementation(async path => path === '/api/backtests/run-B' ? stored('B') : [stored('A'), stored('B')]);
        const select = f.root.querySelector<HTMLSelectElement>('.local-backtest-library')!;
        select.value = 'run-B'; select.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(f.onError).toHaveBeenCalledOnce());
        expect(latest()?.name).toBe('Strategy A');
        f.root.querySelector<HTMLButtonElement>('.local-backtest-export')!.click();
        f.root.querySelector<HTMLButtonElement>('.local-backtest-discard')!.click();
        select.value = 'run-B'; select.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(latest()?.name).toBe('Strategy B'));
        expect(f.post).toHaveBeenCalledOnce();
        expect(f.app.readCurrentResult()).toMatchObject({ savedRunId: 'run-B', snapshot: { source: 'source-B' } });
    });
    it('persists the previous full-history run before a new full backtest replaces it', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A'));
        const saved = deferred<StoredBacktest>(); f.post.mockReturnValueOnce(saved.promise);
        const next = f.editor.onBacktest('source-B', doc('B'));
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
        expect(f.post.mock.lastCall?.[1]).toMatchObject({ name: 'Strategy A', snapshot: { source: 'source-A' } });
        expect(f.app.busy()).toBe(true); expect(mocks.backtest).toHaveBeenCalledOnce(); expect(latest()?.name).toBe('Strategy A');
        saved.resolve(stored('A')); await next;
        expect(latest()?.name).toBe('Strategy B'); expect(mocks.backtest).toHaveBeenCalledTimes(2);
        await f.app.flush();
        expect(f.post).toHaveBeenCalledTimes(2); expect(f.post.mock.lastCall?.[1]).toMatchObject({ name: 'Strategy B', snapshot: { source: 'source-B' } });
    });
    it('persists a full backtest before replacing its viewer with a different chart strategy', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A'));
        expect(latest()?.name).toBe('Strategy A');
        f.root.querySelector<HTMLButtonElement>('.local-backtest-export')!.click(); expect(mocks.download.mock.lastCall?.[1]).toMatchObject({ name: 'Strategy A', snapshot: { source: 'source-A' } });
        await f.editor.onRun('source-B');
        expect(f.post).toHaveBeenCalledWith('/api/backtests', expect.objectContaining({ name: 'Strategy A', snapshot: expect.objectContaining({ source: 'source-A' }) }));
        expect(f.post.mock.invocationCallOrder[0]).toBeLessThan(f.chart.runScript.mock.invocationCallOrder[0]!);
        expect(latest()?.name).toBe('Chart B'); expect(f.root.querySelector<HTMLButtonElement>('.local-backtest-save')!.disabled).toBe(true);
        expect(f.root.querySelector<HTMLButtonElement>('.local-backtest-export')!.disabled).toBe(true);
        f.root.querySelector<HTMLButtonElement>('.local-backtest-export')!.click(); expect(mocks.download).toHaveBeenCalledOnce();
    });
    it('editing a different chart strategy clears ownership of an older full-history snapshot', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A')); await link(f); await f.editor.onUpdate('chart-B', 'edited-B');
        expect(latest()).toMatchObject({ name: 'Chart B', state: { netPnl: 30 } });
        expect(f.post.mock.lastCall?.[1].snapshot.source).toBe('source-A');
        expect(f.root.querySelector<HTMLButtonElement>('.local-backtest-export')!.disabled).toBe(true);
    });
    it('does not let chart ticks overwrite a displayed full-history backtest', async () => {
        const f = await fixture(); await f.editor.onRun('source-B'); await f.editor.onBacktest('source-A', doc('A'));
        const calls = mocks.results.update.mock.calls.length; f.emit(); await Promise.resolve(); await Promise.resolve();
        expect(mocks.results.update).toHaveBeenCalledTimes(calls); expect(latest()?.name).toBe('Strategy A');
        f.root.querySelector<HTMLButtonElement>('.local-backtest-export')!.click(); expect(mocks.download.mock.lastCall?.[1]).toMatchObject({ snapshot: { source: 'source-A' } });
    });
    it('rejects a chart update whose trade read finishes after a full-history result takes ownership', async () => {
        const f = await fixture(); await f.editor.onRun('source-B');
        f.root.querySelector<HTMLButtonElement>('[aria-label="Strategy Tester"]')!.click();
        await vi.waitFor(() => expect(f.root.querySelector<HTMLElement>('[data-script-tab="tester"]')!.getAttribute('aria-selected')).toBe('true'));
        const pending = deferred<readonly StrategyTrade[]>();
        f.emit({ ...f.chartRun, title: 'Delayed chart B', trades: () => pending.promise });
        await f.editor.onBacktest('source-A', doc('A')); expect(latest()?.name).toBe('Strategy A');
        pending.resolve([]); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(latest()?.name).toBe('Strategy A');
        f.root.querySelector<HTMLButtonElement>('.local-backtest-export')!.click(); expect(mocks.download.mock.lastCall?.[1]).toMatchObject({ snapshot: { source: 'source-A' } });
    });
    it('ignores an older saved-library response after the user selects a different run', async () => {
        const f = await fixture(), first = deferred<StoredBacktest>(), second = deferred<StoredBacktest>();
        await f.editor.onBacktest('source-A', doc('A'));
        f.get.mockImplementation(async (path) => path === '/api/backtests/run-A' ? first.promise : path === '/api/backtests/run-B' ? second.promise : [stored('A'), stored('B')]);
        const select = f.root.querySelector<HTMLSelectElement>('.local-backtest-library')!;
        select.value = 'run-A'; select.dispatchEvent(new Event('change'));
        select.value = 'run-B'; select.dispatchEvent(new Event('change')); second.resolve(stored('B'));
        await vi.waitFor(() => expect(latest()?.name).toBe('Strategy B'));
        first.resolve(stored('A')); await Promise.resolve(); await Promise.resolve();
        expect(latest()?.name).toBe('Strategy B'); f.root.querySelector<HTMLButtonElement>('.local-backtest-export')!.click();
        expect(mocks.download.mock.lastCall?.[1]).toMatchObject({ name: 'Strategy B', snapshot: { source: 'source-B' } });
    });
});

describe('script workspace flush and update handoff', () => {
    it('saves a completed full-history run during flush and does not duplicate it', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A')); await f.app.flush(); await f.app.flush();
        expect(mocks.editor.flush).toHaveBeenCalledTimes(2); expect(f.post).toHaveBeenCalledOnce(); expect(f.post.mock.lastCall?.[1].snapshot.source).toBe('source-A');
    });
    it('ordinary flush leaves a running backtest active and saves it once complete', async () => {
        const f = await fixture(), pending = deferred<PineBacktestResult>(); mocks.backtest.mockReturnValueOnce(pending.promise);
        const done = f.editor.onBacktest('source-A', doc('A')); await vi.waitFor(() => expect(mocks.backtest).toHaveBeenCalled());
        const signal = mocks.backtest.mock.lastCall![0].signal!; await f.app.flush();
        expect(signal.aborted).toBe(false); expect(f.app.busy()).toBe(true); expect(f.post).not.toHaveBeenCalled();
        pending.resolve({ state: state(100), trades: [], warnings: [] }); await done; await f.app.flush();
        expect(f.post).toHaveBeenCalledOnce(); expect(f.app.busy()).toBe(false);
    });
    it('update preparation cancels an active run after the editor has safely flushed', async () => {
        const f = await fixture(); let signal: AbortSignal | undefined;
        mocks.backtest.mockImplementationOnce((options) => new Promise((_resolve, reject) => { signal = options.signal; signal!.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }); }));
        const done = f.editor.onBacktest('source-A', doc('A')).catch(() => undefined); await vi.waitFor(() => expect(signal).toBeDefined());
        await f.app.prepareForUpdate(); await done;
        expect(mocks.editor.flush).toHaveBeenCalledTimes(2); expect(signal!.aborted).toBe(true); expect(f.app.busy()).toBe(false);
    });
    it('does not acknowledge an update until a pending chart run has finished', async () => {
        const f = await fixture(); const result = await f.chart.runScript(); f.chart.runScript.mockClear();
        const pending = deferred<ScriptRunResult>(); f.chart.runScript.mockReturnValueOnce(pending.promise);
        const run = f.editor.onRun('source-B'); await vi.waitFor(() => expect(f.chart.runScript).toHaveBeenCalledOnce());
        let acknowledged = false; const prepared = f.app.prepareForUpdate().then(() => { acknowledged = true; });
        await Promise.resolve(); await Promise.resolve(); expect(acknowledged).toBe(false);
        pending.resolve(result); await run; await prepared;
        expect(acknowledged).toBe(true); expect(f.onChange).toHaveBeenCalledOnce(); expect(mocks.editor.flush).toHaveBeenCalledTimes(2);
    });
    it.each([true, false])('drains a pending source update before handoff (success=%s)', async (success) => {
        const f = await fixture(); const pending = deferred<{ ok: boolean; error: Error | null }>();
        await link(f);
        f.handle.updateCode.mockImplementationOnce(async () => {
            const value = await pending.promise; if (value.ok) f.handle.source = 'new-source'; return value;
        });
        const update = f.editor.onUpdate('chart-B', 'new-source').catch(() => undefined);
        await vi.waitFor(() => expect(f.handle.updateCode).toHaveBeenCalledOnce());
        let acknowledged = false; const prepared = f.app.prepareForUpdate().then(() => { acknowledged = true; });
        await Promise.resolve(); await Promise.resolve(); expect(acknowledged).toBe(false); expect(f.handle.source).toBe('source-B');
        pending.resolve({ ok: success, error: success ? null : new Error('Compile failed') }); await update; await prepared;
        expect(acknowledged).toBe(true); expect(f.handle.source).toBe(success ? 'new-source' : 'source-B');
    });
    it('a failed editor flush blocks update preparation and keeps the backtest running', async () => {
        const f = await fixture(), pending = deferred<PineBacktestResult>(); mocks.backtest.mockReturnValueOnce(pending.promise);
        const done = f.editor.onBacktest('source-A', doc('A')); await vi.waitFor(() => expect(mocks.backtest).toHaveBeenCalled());
        const signal = mocks.backtest.mock.lastCall![0].signal!; mocks.editor.flush.mockRejectedValueOnce(new Error('Draft could not save'));
        await expect(f.app.prepareForUpdate()).rejects.toThrow('Draft could not save'); expect(signal.aborted).toBe(false); expect(f.app.busy()).toBe(true);
        pending.resolve({ state: state(100), trades: [], warnings: [] }); await done;
    });
});

describe('full-history settings belong to the selected script instance', () => {
    it('uses the linked instance B settings when A has identical source, and saves those exact settings', async () => {
        const f = await fixture(); const source = 'source-B';
        const first = { ...f.handle, id: 'chart-A', inputValues: () => ({ length: 10 }), propValues: () => ({ initial_capital: 50000 }) };
        f.handle.inputValues = () => ({ length: 100 }); f.handle.propValues = () => ({ initial_capital: 100000 });
        f.chart.indicators = () => [first, f.handle];
        f.root.dispatchEvent(new CustomEvent('local-pine:edit', { detail: { id: f.handle.id, source, name: 'Configured B' } }));
        await vi.waitFor(() => expect(mocks.editor.open).toHaveBeenCalledWith(expect.objectContaining({ instanceId: f.handle.id })));
        await f.editor.onBacktest(source, doc('B'), { instanceId: f.handle.id });
        expect(mocks.backtest.mock.lastCall![0]).toMatchObject({ inputs: { length: 100 }, props: { initial_capital: 100000 } });
        await f.app.flush(); expect(f.post.mock.lastCall![1].snapshot).toMatchObject({ inputs: { length: 100 }, properties: { initial_capital: 100000 } });
    });
    it('uses source defaults for unlinked code even when an existing chart script has identical source', async () => {
        const f = await fixture(); f.handle.inputValues = () => ({ length: 100 }); f.handle.propValues = () => ({ initial_capital: 100000 });
        await f.editor.onBacktest('source-B', doc('B'), { instanceId: null });
        expect(mocks.backtest.mock.lastCall![0].inputs).toEqual({}); expect(mocks.backtest.mock.lastCall![0].props).toEqual({});
        await f.app.flush(); expect(f.post.mock.lastCall![1].snapshot.inputs).toEqual({}); expect(f.post.mock.lastCall![1].snapshot.properties).toEqual({});
    });
    it('dry-tests unapplied editor changes with source defaults and an explicit warning', async () => {
        const f = await fixture(); f.handle.inputValues = () => ({ length: 100 }); f.handle.propValues = () => ({ initial_capital: 100000 });
        f.root.dispatchEvent(new CustomEvent('local-pine:edit', { detail: { id: f.handle.id, source: f.handle.source, name: 'Configured B' } }));
        await vi.waitFor(() => expect(mocks.editor.open).toHaveBeenCalled());
        await f.editor.onBacktest('edited-source-B', null, { instanceId: f.handle.id });
        expect(mocks.backtest.mock.lastCall![0]).toMatchObject({ source: 'edited-source-B', inputs: {}, props: {} });
        expect(latest()!.warnings).toContain('Editor source differs from its chart instance; this backtest uses source-declared inputs and properties. Update the chart first to use its configured values.');
        await f.app.flush(); expect(f.post.mock.lastCall![1].snapshot).toMatchObject({ source: 'edited-source-B', inputs: {}, properties: {} });
    });
    it('rejects a linked instance after switching to another chart, even if its id and source are identical', async () => {
        const f = await fixture(); f.root.dispatchEvent(new CustomEvent('local-pine:edit', { detail: { id: f.handle.id, source: f.handle.source, name: 'Configured B' } }));
        await vi.waitFor(() => expect(mocks.editor.open).toHaveBeenCalled());
        Object.defineProperty(f.workspace, 'chart', { value: { ...f.chart, indicators: () => [{ ...f.handle }] }, configurable: true });
        await expect(f.editor.onBacktest(f.handle.source, null, { instanceId: f.handle.id })).rejects.toThrow('another chart or replay session');
        expect(mocks.backtest).not.toHaveBeenCalled(); expect(f.app.busy()).toBe(false);
    });
    it('rejects a chart switch while its cached source history is loading', async () => {
        const f = await fixture(); const history = deferred<typeof f.series>();
        f.root.dispatchEvent(new CustomEvent('local-pine:edit', { detail: { id: f.handle.id, source: f.handle.source, name: 'Configured B' } }));
        await vi.waitFor(() => expect(mocks.editor.open).toHaveBeenCalled());
        f.get.mockImplementation(async path => path.includes('/series?') ? history.promise : []);
        const done = f.editor.onBacktest(f.handle.source, null, { instanceId: f.handle.id }); const rejected = expect(done).rejects.toThrow('changed during the backtest');
        await vi.waitFor(() => expect(f.get.mock.calls.some(([path]) => path.includes('/series?'))).toBe(true));
        Object.defineProperty(f.workspace, 'chart', { value: { ...f.chart }, configurable: true }); history.resolve(f.series); await rejected;
        expect(mocks.backtest).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
    });
    it.each(['session', 'timeframe', 'source'])('discards a result when its %s owner changes while the worker is running', async change => {
        const f = await fixture(); const result = deferred<PineBacktestResult>();
        f.root.dispatchEvent(new CustomEvent('local-pine:edit', { detail: { id: f.handle.id, source: f.handle.source, name: 'Configured B' } }));
        await vi.waitFor(() => expect(mocks.editor.open).toHaveBeenCalled()); mocks.backtest.mockReturnValueOnce(result.promise);
        const done = f.editor.onBacktest(f.handle.source, null, { instanceId: f.handle.id }); const rejected = expect(done).rejects.toThrow('changed during the backtest');
        await vi.waitFor(() => expect(mocks.backtest).toHaveBeenCalled());
        if (change === 'session') f.view.session.id = 'another-session'; else if (change === 'timeframe') f.chart.market.timeframe = '5'; else f.handle.source = 'new source';
        result.resolve({ state: state(999), trades: [], warnings: [] }); await rejected;
        expect(mocks.results.update).not.toHaveBeenCalled(); await f.app.flush(); expect(f.post).not.toHaveBeenCalled();
    });
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
function deepResponse(f: Fixture): DeepHistoryResponse {
    return { ...f.series, bars: [...f.series.bars, { ...f.series.bars[1]!, time: 120000 }], cursorTime: 120000,
        timeframe: '1', intervalMs: 60000, baseIntervalMs: 60000, from: 0, to: 180000, hasMore: false,
        scopeId: 'ephemeral-scope', history: { mode: 'deep', requestedFrom: 0, requestedTo: 180000, barCount: 3, sourceDatasets: [{ id: 'dataset', checksum: 'checksum' }], checksum: 'deep-checksum' } };
}
function routeDeep(f: Fixture, data = deepResponse(f), secondary?: DeepSeriesResponse): void {
    f.post.mockImplementation(async (path, payload) => {
        if (path === '/api/deep-history') return data as unknown as StoredBacktest;
        if (path.endsWith('/series')) return secondary as unknown as StoredBacktest;
        if (path.endsWith('/release')) return {} as StoredBacktest;
        return { ...payload.snapshot, id: 'saved-new', name: payload.name, createdAt: '2026-10-20T00:00:00Z' };
    });
}
function enableDeep(f: Fixture): void {
    const toggle = f.root.querySelector<HTMLInputElement>('.local-deep-toggle')!;
    toggle.checked = true; toggle.dispatchEvent(new Event('change'));
}
function updateReport(f: Fixture): void { f.root.querySelector<HTMLButtonElement>('.local-backtest-update')!.click(); }

describe('deep cached-period reports', () => {
    it('keeps normal Backtest revealed-only and explicitly tests cached candles beyond replay in Deep mode', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-B', doc('B'));
        expect(mocks.backtest.mock.lastCall![0]).toMatchObject({ bars: f.series.bars, cutoff: 60000 });
        expect(f.get.mock.calls.find(([path]) => path.includes('/series?'))?.[0]).toContain('cursor=1');
        routeDeep(f); enableDeep(f);
        expect(f.root.querySelector<HTMLInputElement>('.local-deep-from')!.value).toBe('1970-01-01T00:00');
        expect(f.root.querySelector<HTMLInputElement>('.local-deep-to')!.value).toBe('1970-01-01T00:03');
        updateReport(f);
        await vi.waitFor(() => expect(f.app.busy()).toBe(false));
        expect(f.post).toHaveBeenCalledWith('/api/deep-history', { datasetId: 'dataset', timeframe: '1', from: 0, to: 180000 }, expect.any(AbortSignal));
        expect(mocks.backtest.mock.lastCall![0]).toMatchObject({ source: 'source-B', cutoff: 120000, bars: deepResponse(f).bars });
        expect(latest()).toMatchObject({ from: 0, to: 180000, history: { mode: 'deep' } });
        expect(latest()!.warnings!.some(text => text.startsWith('Deep backtest · selected cache range · not replay'))).toBe(true);
        expect(f.post).toHaveBeenCalledWith('/api/deep-history/ephemeral-scope/release', {}, expect.any(AbortSignal));
        expect(f.view.session.cursor).toBe(1); expect(f.chart.setVisibleRange).not.toHaveBeenCalled();
    });
    it('passes chosen exclusive UTC bounds, exact B inputs/properties, and scoped secondary provenance into persistence', async () => {
        const f = await fixture(); f.handle.inputValues = () => ({ length: 100 }); f.handle.propValues = () => ({ initial_capital: 100000 });
        f.chart.indicators = () => [{ ...f.handle, id: 'A', inputValues: () => ({ length: 10 }) }, f.handle];
        f.root.dispatchEvent(new CustomEvent('local-pine:edit', { detail: { id: f.handle.id, source: f.handle.source, name: 'B' } }));
        await vi.waitFor(() => expect(mocks.editor.open).toHaveBeenCalled());
        await f.editor.onBacktest('source-B', doc('B'), { instanceId: f.handle.id });
        const data = deepResponse(f); data.history.requestedFrom = 60000; data.from = 60000; data.history.barCount = 2; data.bars = data.bars.slice(1);
        routeDeep(f, data, { ...data, sourceDatasets: [{ id: 'secondary', checksum: 'secondary-checksum' }], cursorTime: 120000 });
        mocks.backtest.mockImplementationOnce(async options => {
            expect(options).toMatchObject({ inputs: { length: 100 }, props: { initial_capital: 100000 } });
            const bars = await options.fetchSeriesAt!('replay:ESM4', '5', { from: 0, to: 120000, limit: 50 }, 120000, options.signal!);
            expect(bars).toHaveLength(2);
            return { state: state(250), trades: [], warnings: [] };
        });
        enableDeep(f); f.root.querySelector<HTMLInputElement>('.local-deep-from')!.value = '1970-01-01T00:01'; updateReport(f);
        await vi.waitFor(() => expect(f.app.busy()).toBe(false));
        expect(f.onError).not.toHaveBeenCalled();
        expect(f.post).toHaveBeenCalledWith('/api/deep-history', { datasetId: 'dataset', timeframe: '1', from: 60000, to: 180000 }, expect.any(AbortSignal));
        expect(f.post).toHaveBeenCalledWith('/api/deep-history/ephemeral-scope/series', { symbol: 'replay:ESM4', timeframe: '5', cutoff: 120000, from: 0, limit: 50 }, expect.any(AbortSignal));
        await f.app.flush();
        const saved = f.post.mock.calls.filter(([path]) => path === '/api/backtests').at(-1)![1].snapshot;
        expect(saved).toMatchObject({ inputs: { length: 100 }, properties: { initial_capital: 100000 }, history: { mode: 'deep', requestedFrom: 60000, requestedTo: 180000, checksum: 'deep-checksum', secondarySourceDatasets: [{ id: 'secondary', checksum: 'secondary-checksum' }] } });
        expect(JSON.stringify(saved)).not.toContain('ephemeral-scope');
        f.root.querySelector<HTMLButtonElement>('.local-backtest-export')!.click();
        expect(mocks.download.mock.lastCall![1]).toMatchObject({ snapshot: saved });
    });
    it('rejects an empty or reversed UTC selection before any deep request', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A')); enableDeep(f);
        f.root.querySelector<HTMLInputElement>('.local-deep-from')!.value = '1970-01-01T00:03'; updateReport(f);
        await vi.waitFor(() => expect(f.onError).toHaveBeenCalled());
        expect(f.post.mock.calls.some(([path]) => path === '/api/deep-history')).toBe(false);
        expect(mocks.backtest).toHaveBeenCalledOnce(); expect(latest()?.name).toBe('Strategy A');
    });
    it('restores Deep mode, dates, and saved settings without borrowing the live chart instance', async () => {
        const f = await fixture(); const saved = { ...stored('B'), inputs: { length: 99 }, properties: { initial_capital: 99000 }, history: deepResponse(f).history };
        f.handle.inputValues = () => ({ length: 10 }); f.handle.propValues = () => ({ initial_capital: 50000 });
        f.get.mockImplementation(async path => path === '/api/backtests/run-B' ? saved : [saved]);
        f.root.querySelector<HTMLButtonElement>('[aria-label="Strategy Tester"]')!.click();
        const library = f.root.querySelector<HTMLSelectElement>('.local-backtest-library')!;
        await vi.waitFor(() => expect([...library.options].some(option => option.value === saved.id)).toBe(true));
        library.value = saved.id; library.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(latest()?.name).toBe(saved.name));
        expect(f.root.querySelector<HTMLInputElement>('.local-deep-toggle')!.checked).toBe(true);
        expect(f.root.querySelector<HTMLInputElement>('.local-deep-to')!.value).toBe('1970-01-01T00:03');
        routeDeep(f); updateReport(f); await vi.waitFor(() => expect(f.app.busy()).toBe(false));
        expect(mocks.backtest.mock.lastCall![0]).toMatchObject({ source: 'source-B', inputs: { length: 99 }, props: { initial_capital: 99000 } });
        expect(f.chart.renderer.openIndicatorSettings).not.toHaveBeenCalled();
    });
    it('cancels a deep worker, releases its scope, and retains the previous complete report and export', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A')); routeDeep(f); enableDeep(f);
        let signal: AbortSignal | undefined;
        mocks.backtest.mockImplementationOnce(options => new Promise((_resolve, reject) => { signal = options.signal; signal!.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }); }));
        updateReport(f); await vi.waitFor(() => expect(signal).toBeDefined());
        f.root.querySelector<HTMLButtonElement>('.local-backtest-cancel')!.click();
        await vi.waitFor(() => expect(f.app.busy()).toBe(false));
        expect(signal!.aborted).toBe(true); expect(latest()?.name).toBe('Strategy A');
        expect(f.post).toHaveBeenCalledWith('/api/deep-history/ephemeral-scope/release', {}, expect.any(AbortSignal));
        f.root.querySelector<HTMLButtonElement>('.local-backtest-export')!.click();
        expect(mocks.download.mock.lastCall![1]).toMatchObject({ snapshot: { source: 'source-A', to: 60000 } });
    });
    it('returns to a revealed-only report with Reset to replay', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A')); routeDeep(f); enableDeep(f); updateReport(f);
        await vi.waitFor(() => expect(f.app.busy()).toBe(false));
        f.root.querySelector<HTMLButtonElement>('.local-backtest-reset')!.click();
        await vi.waitFor(() => expect(mocks.backtest).toHaveBeenCalledTimes(3)); await vi.waitFor(() => expect(f.app.busy()).toBe(false));
        expect(latest()?.to).toBe(60000); expect(latest()?.history).toBeUndefined();
        expect(f.root.querySelector<HTMLInputElement>('.local-deep-toggle')!.checked).toBe(false);
        expect(mocks.backtest.mock.lastCall![0].cutoff).toBe(60000);
    });
    it('aborts deep work during handoff before acknowledging readiness', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A')); routeDeep(f); enableDeep(f);
        let signal: AbortSignal | undefined;
        mocks.backtest.mockImplementationOnce(options => new Promise((_resolve, reject) => { signal = options.signal; signal!.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }); }));
        updateReport(f); await vi.waitFor(() => expect(signal).toBeDefined()); await f.app.prepareForUpdate();
        expect(signal!.aborted).toBe(true); expect(f.app.busy()).toBe(false);
        expect(f.post).toHaveBeenCalledWith('/api/deep-history/ephemeral-scope/release', {}, expect.any(AbortSignal));
        expect(latest()?.name).toBe('Strategy A');
    });
    it('cancels a deep worker before a new chart run replaces the report', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A')); routeDeep(f); enableDeep(f);
        let signal: AbortSignal | undefined;
        mocks.backtest.mockImplementationOnce(options => new Promise((_resolve, reject) => { signal = options.signal; signal!.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }); }));
        updateReport(f); await vi.waitFor(() => expect(signal).toBeDefined());
        await f.editor.onRun('source-B');
        expect(signal!.aborted).toBe(true); expect(f.app.busy()).toBe(false); expect(latest()?.name).toBe('Chart B');
        expect(f.post.mock.invocationCallOrder[f.post.mock.calls.findIndex(([path]) => path.endsWith('/release'))]).toBeLessThan(f.chart.runScript.mock.invocationCallOrder[0]!);
    });
    it('releases a deep scope and rejects publication after switching charts during history loading', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A')); const data = deepResponse(f); routeDeep(f);
        const pending = deferred<DeepHistoryResponse>();
        f.post.mockImplementation(async (path, payload) => path === '/api/deep-history' ? await pending.promise as unknown as StoredBacktest : { ...payload.snapshot, id: 'saved', name: payload.name, createdAt: '2026-10-20T00:00:00Z' });
        enableDeep(f); updateReport(f);
        await vi.waitFor(() => expect(f.post.mock.calls.some(([path]) => path === '/api/deep-history')).toBe(true));
        Object.defineProperty(f.workspace, 'chart', { value: { ...f.chart }, configurable: true }); pending.resolve(data);
        await vi.waitFor(() => expect(f.app.busy()).toBe(false));
        expect(f.onError).toHaveBeenCalled(); expect(mocks.backtest).toHaveBeenCalledOnce(); expect(latest()?.name).toBe('Strategy A');
        expect(f.post).toHaveBeenCalledWith('/api/deep-history/ephemeral-scope/release', {}, expect.any(AbortSignal));
    });
    it('rejects incomplete secondary data rather than publishing a partial deep report', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A')); const data = deepResponse(f);
        routeDeep(f, data, { ...data, hasMore: true, sourceDatasets: [] });
        mocks.backtest.mockImplementationOnce(async options => {
            await options.fetchSeriesAt!('replay:NQM4', '1S', {}, 120000, options.signal!);
            return { state: state(999), trades: [], warnings: [] };
        });
        enableDeep(f); updateReport(f); await vi.waitFor(() => expect(f.app.busy()).toBe(false));
        expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('secondary series exceeds') }));
        expect(latest()?.name).toBe('Strategy A'); expect(f.post.mock.calls.some(([path]) => path.endsWith('/release'))).toBe(true);
    });
    it('rejects conflicting dataset checksums from secondary history', async () => {
        const f = await fixture(); await f.editor.onBacktest('source-A', doc('A')); const data = deepResponse(f);
        routeDeep(f, data, { ...data, sourceDatasets: [{ id: 'dataset', checksum: 'changed-checksum' }] });
        mocks.backtest.mockImplementationOnce(async options => {
            await options.fetchSeriesAt!('replay:NQM4', '5', {}, 120000, options.signal!);
            return { state: state(999), trades: [], warnings: [] };
        });
        enableDeep(f); updateReport(f); await vi.waitFor(() => expect(f.app.busy()).toBe(false));
        expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('dataset changed') }));
        expect(latest()?.name).toBe('Strategy A');
    });
    it('opens the exact linked native Properties dialog and shows truthful applied values', async () => {
        const f = await fixture(); f.handle.propValues = () => ({ initial_capital: 100000, commission_value: 2.5 });
        f.root.dispatchEvent(new CustomEvent('local-pine:edit', { detail: { id: f.handle.id, source: f.handle.source, name: 'B' } }));
        await vi.waitFor(() => expect(mocks.editor.open).toHaveBeenCalled());
        await f.editor.onBacktest('source-B', doc('B'), { instanceId: f.handle.id });
        f.root.querySelector<HTMLButtonElement>('.local-backtest-properties')!.click();
        expect(f.chart.renderer.openIndicatorSettings).toHaveBeenCalledExactlyOnceWith('chart-B');
        const summary = f.root.querySelector('.local-backtest-applied pre')!.textContent!;
        expect(JSON.parse(summary)).toMatchObject({ initialCapital: 50000, propertyOverrides: { initial_capital: 100000, commission_value: 2.5 } });
        expect(summary).not.toContain('margin_long');
    });
    it('offers Open Pine editor when no report source exists', async () => {
        const f = await fixture(); f.root.querySelector<HTMLButtonElement>('[aria-label="Strategy Tester"]')!.click();
        await vi.waitFor(() => expect(f.root.querySelector<HTMLButtonElement>('.local-backtest-open-editor')!.hidden).toBe(false));
        expect(f.root.querySelector<HTMLButtonElement>('.local-backtest-update')!.hidden).toBe(true);
        f.root.querySelector<HTMLButtonElement>('.local-backtest-open-editor')!.click();
        expect(f.root.querySelector('[data-script-tab="editor"]')!.getAttribute('aria-selected')).toBe('true');
    });
});
