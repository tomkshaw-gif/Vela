import type { VelaWorkspace } from '../../src/workspace';
import type { ScriptRunResult, InputValue, OHLCV, SymbolInfo, Vela, IndicatorHandle } from '../../src/index';
import { iconMarkup, registerIcon, registerLegendAction } from '../../src/plugin';
import type { SessionView } from '../shared/types';
import type { BacktestSnapshot, BacktestSummary, ReplayBacktestProvenance, ScriptDocument, StoredBacktest } from '../shared/scripts';
import type { DeepSourceDataset } from '../shared/deep-backtest';
import type { StrategyResultsSnapshot } from '../shared/strategy-analysis';
import type { LocalApi } from './api';
import { downloadJson } from './util';
import { editorDraftStorageKey } from './editor-drafts';
import type { PineBacktestContext } from './pine-editor';
import './script-workspace.css';
import { dockPreferenceStore, mountReplayStatsDock } from './replay-stats-dock';

if (!iconMarkup('local-pine')) registerIcon('local-pine', '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m10 7-7 7 7 7m8-14 7 7-7 7m-3-17-3 24"/></svg>');
if (!iconMarkup('local-strategy')) registerIcon('local-strategy', '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 3v21h21M7 18l5-7 5 3 7-9M20 5h4v4"/></svg>');
registerLegendAction({ id: 'local.edit-pine', icon: 'local-pine', tooltip: 'Open Pine source', when: (indicator) => indicator.source !== undefined,
    run: (ctx, indicator) => ctx.host.dispatchEvent(new CustomEvent('local-pine:edit', { detail: { id: indicator.id, source: indicator.source, name: indicator.title } })) });

interface Options {
    workspace: VelaWorkspace; api: LocalApi; session: () => SessionView | null;
    initialOpen?: boolean;
    cutoff: () => number | null; blocked: () => boolean; onChange: () => Promise<void>; onError: (error: unknown) => void;
}
export interface ScriptWorkspaceResult {
    generation: number; name: string; result: StrategyResultsSnapshot; snapshot: BacktestSnapshot | null; savedRunId?: string;
}
export interface IndicatorBacktestOptions { mode: 'replay' | 'deep'; from?: number; to?: number; operationId?: string }
export interface ScriptWorkspace {
    flush(): Promise<void>; prepareForUpdate(): Promise<void>; busy(): boolean; destroy(): void;
    readCurrentResult(): ScriptWorkspaceResult | null;
    startBacktestForIndicator(id: string, options: IndicatorBacktestOptions, assertCurrent?: () => void): Promise<ScriptWorkspaceResult>;
    /** Cancels only the caller-supplied operation ID that currently owns the tester. */
    cancelBacktest(operationId: string): boolean;
}
type Editor = ReturnType<typeof import('./pine-editor')['mountPineEditor']>;
type Results = ReturnType<typeof import('./strategy-results')['mountStrategyResults']>;
interface ReportRequest {
    source: string; document: ScriptDocument | null; chart: Vela; sessionId: string;
    handle?: IndicatorHandle; fixed?: BacktestSnapshot; name?: string;
    operationId?: string; assertCurrent?: () => void;
}
interface ScriptOwner { chart: Vela; sessionId: string; handle: IndicatorHandle }

interface ReplaySeriesResponse {
    bars: OHLCV[]; symbolInfo: SymbolInfo; hasMore: boolean; cursorTime: number | null;
    sourceDatasets: DeepSourceDataset[]; history?: undefined; scopeId?: undefined;
}

function settingsKey(values: Record<string, InputValue>): string {
    return JSON.stringify(Object.keys(values).sort().map(key => [key, values[key]]));
}
function datasetReferences(value: unknown): DeepSourceDataset[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 200) throw new Error('Cached series provenance is unavailable. Reload the application before backtesting.');
    const references = new Map<string, string>();
    for (const row of value as DeepSourceDataset[]) {
        if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 80 || typeof row.checksum !== 'string' || !row.checksum || row.checksum.length > 128
            || references.has(row.id)) throw new Error('Cached series provenance is invalid. Run the backtest again.');
        references.set(row.id, row.checksum);
    }
    return [...references].sort(([a], [b]) => a.localeCompare(b)).map(([id, checksum]) => ({ id, checksum }));
}

function dateInput(time: number): string { return new Date(time).toISOString().slice(0, 19); }
function dateValue(value: string): number {
    const time = Date.parse(`${value}Z`);
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('Choose a valid UTC date and time.');
    return time;
}
function summaryValues(values: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    let count = 0;
    for (const key in values) {
        if (!Object.hasOwn(values, key)) continue;
        if (count++ === 200) { summary['Additional values'] = 'Open the source or exported snapshot to inspect the remaining settings.'; break; }
        const value = values[key];
        summary[key] = typeof value === 'string' ? value.slice(0, 2000) : typeof value === 'number' || typeof value === 'boolean' ? value : 'Unavailable';
    }
    return summary;
}

function plainJson(value: unknown): Record<string, unknown> {
    return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'number' && !Number.isFinite(item) ? null : item)) as Record<string, unknown>;
}

export function mountScriptWorkspace(options: Options): ScriptWorkspace {
    const { workspace, api } = options;
    const root = workspace.root;
    const dock = document.createElement('section'); dock.className = 'local-script-dock'; dock.hidden = true; dock.dataset.activeTab = 'replay';
    dock.setAttribute('aria-label', 'Replay trading, Pine editor and strategy tester');
    dock.innerHTML = '<div class="local-script-resize" role="separator" aria-label="Resize bottom panel" aria-orientation="horizontal" tabindex="0"></div><header class="local-script-tabs"><button type="button" data-script-tab="replay"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.67 6.67v10.66L5.33 12zM16 6.67v10.66L10.67 12z"/></svg>Replay Trading</button><button type="button" data-script-tab="editor">Pine Editor</button><button type="button" data-script-tab="tester">Strategy Tester</button><span class="local-script-status" role="status"></span><button type="button" class="local-script-min" aria-label="Collapse bottom panel"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3 12.5h12"/></svg></button><button type="button" class="local-script-max" aria-label="Maximize editor" title="Maximize / restore"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M2.5 7V2.5H7M11 2.5h4.5V7M15.5 11v4.5H11M7 15.5H2.5V11"/></svg></button><button type="button" class="local-script-close" aria-label="Close editor" title="Close">×</button></header><div class="local-script-replay"></div><div class="local-script-editor" hidden></div><div class="local-script-tester" hidden><div class="local-script-runbar"><button type="button" class="local-backtest-save" disabled>Save run</button><button type="button" class="local-backtest-export" disabled>Export</button><button type="button" class="local-backtest-cancel" hidden>Cancel</button><label>Saved strategies <select class="local-backtest-library"><option value="">Open a saved run…</option></select></label></div><div class="local-strategy-content"><p class="local-script-empty">Run a Pine strategy to inspect its performance, trades and simulations.</p></div></div>';
    const undock = workspace.context().dockStrip(dock);
    const resize = dock.querySelector<HTMLElement>('.local-script-resize')!;
    const panel = mountReplayStatsDock({ root, dock, resize, storage: dockPreferenceStore(),
        minimize: dock.querySelector<HTMLButtonElement>('.local-script-min')!, maximize: dock.querySelector<HTMLButtonElement>('.local-script-max')! });
    const replayHost = dock.querySelector<HTMLElement>('.local-script-replay')!;
    root.dispatchEvent(new CustomEvent('local-replay:chrome', { bubbles: true, detail: { kind: 'replay-stats-mount', target: replayHost } }));
    const editorHost = dock.querySelector<HTMLElement>('.local-script-editor')!;
    const testerHost = dock.querySelector<HTMLElement>('.local-script-tester')!;
    const resultHost = dock.querySelector<HTMLElement>('.local-strategy-content')!;
    const status = dock.querySelector<HTMLElement>('.local-script-status')!;
    const save = dock.querySelector<HTMLButtonElement>('.local-backtest-save')!;
    const exportButton = dock.querySelector<HTMLButtonElement>('.local-backtest-export')!;
    const cancel = dock.querySelector<HTMLButtonElement>('.local-backtest-cancel')!;
    const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'local-backtest-discard';
    discard.textContent = 'Discard unsaved result'; discard.hidden = true; cancel.after(discard);
    const library = dock.querySelector<HTMLSelectElement>('.local-backtest-library')!;
    const controls = document.createElement('div'); controls.className = 'local-deep-controls';
    controls.innerHTML = '<label class="local-deep-mode"><input type="checkbox" class="local-deep-toggle">Deep backtesting</label><span class="local-deep-range" hidden><label>From <input type="datetime-local" step="1" class="local-deep-from" aria-label="Deep backtest from UTC"></label><label>To <input type="datetime-local" step="1" class="local-deep-to" aria-label="Deep backtest to UTC"></label><span class="local-deep-hint">UTC · end excluded</span></span><button type="button" class="local-backtest-update">Update report</button><button type="button" class="local-backtest-reset" hidden>Reset to replay</button><button type="button" class="local-backtest-properties">Properties</button><button type="button" class="local-backtest-open-editor">Open Pine editor</button>';
    testerHost.insertBefore(controls, resultHost);
    const deep = controls.querySelector<HTMLInputElement>('.local-deep-toggle')!;
    const deepRange = controls.querySelector<HTMLElement>('.local-deep-range')!;
    const deepFrom = controls.querySelector<HTMLInputElement>('.local-deep-from')!;
    const deepTo = controls.querySelector<HTMLInputElement>('.local-deep-to')!;
    const updateReport = controls.querySelector<HTMLButtonElement>('.local-backtest-update')!;
    const resetReport = controls.querySelector<HTMLButtonElement>('.local-backtest-reset')!;
    const properties = controls.querySelector<HTMLButtonElement>('.local-backtest-properties')!;
    const openEditor = controls.querySelector<HTMLButtonElement>('.local-backtest-open-editor')!;
    const applied = document.createElement('details'); applied.className = 'local-backtest-applied'; applied.hidden = true;
    applied.innerHTML = '<summary>Applied inputs and properties</summary><pre></pre>';
    testerHost.insertBefore(applied, resultHost);
    let disposed = false; let editor: Editor | undefined; let results: Results | undefined;
    let editorPromise: Promise<Editor> | undefined; let resultsPromise: Promise<Results> | undefined;
    let activeTab: 'replay' | 'editor' | 'tester' = 'replay'; let working = false;
    let backtestController: AbortController | undefined;
    let backtestOperationId: string | undefined;
    let snapshot: BacktestSnapshot | undefined; let resultName = '';
    let persistedSnapshot: BacktestSnapshot | undefined;
    let failedSnapshot: BacktestSnapshot | undefined; let exportedSnapshot: BacktestSnapshot | undefined;
    let saving: Promise<void> | undefined; let backtestPending: Promise<ScriptWorkspaceResult> | undefined;
    let resultGeneration = 0;
    let currentResult: ScriptWorkspaceResult | null = null;
    const readCurrentResult = (): ScriptWorkspaceResult | null => disposed || !currentResult ? null : structuredClone(currentResult);
    let libraryRequest = 0; let displayedRunId = ''; let preparing = false;
    const scriptOperations = new Set<Promise<unknown>>();
    function track<T>(work: () => Promise<T>): Promise<T> {
        const operation = Promise.resolve().then(work); scriptOperations.add(operation);
        return operation.finally(() => { scriptOperations.delete(operation); });
    }
    let currentRun: ScriptRunResult | undefined; let offRun: (() => void) | undefined;
    let linkedOwner: ScriptOwner | undefined;
    let editRequest = 0;
    let chartExecution = 0;
    let codeUpdate = 0;
    let reportRequest: ReportRequest | undefined;
    let rangeDataset = '';
    const refreshRecovery = (): void => {
        discard.hidden = !snapshot || failedSnapshot !== snapshot;
        discard.disabled = working || !!saving || exportedSnapshot !== snapshot;
        discard.title = exportedSnapshot === snapshot ? 'Discard the unsaved snapshot and keep the displayed report.' : 'Export this result before discarding its unsaved snapshot.';
    };
    const refreshControls = (): void => {
        const view = options.session();
        if (view && view.dataset.id !== rangeDataset) {
            rangeDataset = view.dataset.id; deepFrom.value = dateInput(view.dataset.start);
            deepTo.value = dateInput(view.dataset.end);
        }
        deepRange.hidden = !deep.checked; resetReport.hidden = !deep.checked;
        for (const element of [deep, deepFrom, deepTo, updateReport, resetReport, properties]) element.disabled = working;
        updateReport.hidden = !reportRequest; properties.hidden = !reportRequest; openEditor.hidden = !!reportRequest;
        refreshRecovery();
    };
    const setApplied = (value: StrategyResultsSnapshot, owner?: BacktestSnapshot): void => {
        applied.hidden = false;
        applied.querySelector('pre')!.textContent = JSON.stringify({
            initialCapital: value.state.initialCapital,
            inputs: summaryValues(owner?.inputs ?? {}), propertyOverrides: summaryValues(owner?.properties ?? {}),
            defaults: 'Other values use the source declaration; unavailable defaults are not estimated.',
        }, null, 2);
    };
    const stopBacktest = async (): Promise<void> => { backtestController?.abort(); await backtestPending?.catch(() => undefined); };
    const runs = new Map<ScriptRunResult, { chart: Vela; handle?: IndicatorHandle }>();
    const rail = root.querySelector('.vela-widget-panels');
    const railButtons = (['editor', 'tester'] as const).map((tab) => {
        const button = document.createElement('button'); button.type = 'button';
        button.className = `vela-widget-tool vela-widget-panel-local.${tab === 'editor' ? 'pine' : 'strategy'}`;
        button.dataset.localPanel = tab === 'editor' ? 'local.pine' : 'local.strategy';
        button.setAttribute('aria-label', tab === 'editor' ? 'Pine Editor' : 'Strategy Tester'); button.title = button.getAttribute('aria-label')!;
        button.innerHTML = `<span class="vela-icon" aria-hidden="true">${iconMarkup(tab === 'editor' ? 'local-pine' : 'local-strategy') ?? ''}</span>`;
        button.addEventListener('click', () => { void open(tab).catch(options.onError); });
        rail?.append(button); return button;
    });

    const assertReady = (): SessionView => {
        if (disposed || preparing || options.blocked()) throw new Error('Pause replay and wait for the workspace to finish saving before running a script.');
        const view = options.session(); if (!view) throw new Error('Open a replay session first.');
        return view;
    };
    const assertLinked = (id: string): ScriptOwner => {
        const owner = linkedOwner;
        if (!owner || owner.handle.id !== id || owner.chart !== workspace.chart || owner.sessionId !== options.session()?.session.id
            || !owner.chart.indicators().includes(owner.handle) || owner.handle.source === undefined) {
            throw new Error('The linked script belongs to another chart or replay session. Open it from the active chart again.');
        }
        return owner;
    };
    const chartGuard = (chart: Vela, sessionId: string, execution: number, handle?: IndicatorHandle, freezeCursor = true, freezeScript = false): (() => SessionView) => {
        const view = options.session(); const datasetId = view?.dataset.id; const checksum = view?.dataset.checksum;
        const cursor = view?.session.cursor; const cutoff = options.cutoff(); const timeframe = chart.market.timeframe;
        const source = handle?.source; const inputs = freezeScript && handle ? settingsKey(handle.inputValues()) : undefined;
        const props = freezeScript && handle ? settingsKey(handle.propValues()) : undefined;
        return () => {
            const current = options.session();
            if (disposed || execution !== chartExecution || workspace.chart !== chart || !current || current.session.id !== sessionId
                || current.dataset.id !== datasetId || current.dataset.checksum !== checksum || freezeCursor && (current.session.cursor !== cursor || options.cutoff() !== cutoff)
                || chart.market.timeframe !== timeframe || handle && (!chart.indicators().includes(handle)
                    || freezeScript && (handle.source !== source || settingsKey(handle.inputValues()) !== inputs || settingsKey(handle.propValues()) !== props))) {
                throw new Error('The chart, script or replay session changed while the script was running. Open it from the intended chart again.');
            }
            return current;
        };
    };
    const refreshLibrary = async (): Promise<void> => {
        const saved = await api.get<BacktestSummary[]>('/api/backtests');
        if (disposed) return;
        library.replaceChildren(new Option('Open a saved run…', ''), ...saved.map((run) => new Option(`${run.name} · ${run.symbol} ${run.timeframe}`, run.id)));
        library.value = displayedRunId;
    };
    const persistRun = (): Promise<void> => {
        if (!snapshot || snapshot === persistedSnapshot) return Promise.resolve();
        if (saving) return saving;
        const pending = snapshot; const name = resultName;
        saving = api.post<StoredBacktest>('/api/backtests', { name, snapshot: pending }).then(async (saved) => {
            persistedSnapshot = pending; status.textContent = 'Strategy run saved locally';
            if (failedSnapshot === pending) failedSnapshot = undefined;
            if (snapshot === pending && currentResult) currentResult.savedRunId = saved.id;
            await refreshLibrary();
        }).catch((error: unknown) => {
            if (snapshot === pending && persistedSnapshot !== pending) {
                failedSnapshot = pending;
                status.textContent = 'Run could not be saved. Retry Save run, or export then discard the unsaved result to continue.';
            }
            throw error;
        }).finally(() => { saving = undefined; refreshRecovery(); });
        refreshRecovery();
        return saving;
    };
    const getResults = (): Promise<Results> => resultsPromise ??= import('./strategy-results').then(({ mountStrategyResults }) => {
        if (disposed) throw new Error('The workspace closed.');
        resultHost.replaceChildren();
        results = mountStrategyResults(resultHost, { onGoToTrade: (time) => {
            const cutoff = options.cutoff();
            if (cutoff !== null && time <= cutoff) workspace.chart.setVisibleRange({ from: Math.max(0, time - 30 * 60_000), to: time + 30 * 60_000 });
        } }); return results;
    });
    const showResult = async (value: StrategyResultsSnapshot, owner?: { snapshot: BacktestSnapshot; name: string; saved?: boolean; id?: string }, assertCurrent?: () => void): Promise<void> => {
        const generation = ++resultGeneration;
        const controller = await getResults();
        if (disposed || generation !== resultGeneration) return;
        assertCurrent?.();
        controller.update(value);
        snapshot = owner?.snapshot; resultName = owner?.name ?? value.name;
        failedSnapshot = undefined; exportedSnapshot = undefined; refreshRecovery();
        currentResult = { generation, name: resultName, result: structuredClone(value), snapshot: snapshot ? structuredClone(snapshot) : null,
            ...(owner?.id ? { savedRunId: owner.id } : {}) };
        setApplied(value, snapshot);
        if (owner?.saved) persistedSnapshot = owner.snapshot;
        save.disabled = !snapshot || snapshot === persistedSnapshot; exportButton.disabled = !snapshot;
        displayedRunId = owner?.id ?? ''; library.value = displayedRunId;
    };
    const run = async (source: string): Promise<{ id: string; name: string; warnings?: string[] }> => {
        const sessionId = assertReady().session.id; const chart = workspace.chart; let execution = chartExecution;
        const assertOwner = chartGuard(chart, sessionId, execution);
        await stopBacktest(); assertOwner(); await persistRun(); assertOwner();
        const result = await chart.runScript(source, { language: 'pine' });
        if (!result.ok || !result.run) throw result.error ?? new Error('The script could not run.');
        try { assertOwner(); } catch (error) { result.remove(); throw error; }
        execution = ++chartExecution;
        const handle = chart.indicators().find(handle => handle.id === result.run!.id);
        linkedOwner = handle ? { chart, sessionId, handle } : undefined;
        const assertRunOwner = chartGuard(chart, sessionId, execution, handle, false);
        reportRequest = { source, document: null, chart, sessionId, handle, name: result.run.title }; deep.checked = false; refreshControls();
        runs.set(result, { chart, handle }); currentRun = result;
        const update = async (item: NonNullable<ScriptRunResult['run']>, explicit = false): Promise<void> => {
            if (!item.strategy || disposed) return;
            const generation = resultGeneration;
            if (execution !== chartExecution || !runs.has(result)) return;
            assertRunOwner();
            const assertCurrent = chartGuard(chart, sessionId, execution, handle, true, true);
            const view = assertCurrent();
            const trades = [...await item.trades()];
            if (disposed || generation !== resultGeneration || !explicit && (working || snapshot)) return;
            assertCurrent();
            await showResult({ name: item.title, symbol: view.dataset.symbol, timeframe: chart.market.timeframe ?? '1',
                from: view.dataset.start, to: options.cutoff() ?? view.dataset.start, state: item.strategy, trades,
                warnings: [...item.warnings.map((warning) => warning.message), 'Chart execution uses the loaded chart window (up to 5,000 bars). Use Backtest for the complete revealed history.'] }, undefined, assertCurrent);
        };
        offRun?.(); offRun = result.onUpdate((item) => { if (!working && !snapshot && activeTab === 'tester') void update(item).catch(options.onError); });
        await options.onChange();
        assertRunOwner();
        if (result.run.kind === 'strategy') await update(result.run, true);
        return { id: result.run.id, name: result.run.title, warnings: result.run.warnings.map((warning) => warning.message) };
    };
    const update = async (id: string, source: string): Promise<void> => {
        assertReady(); const { chart, sessionId, handle } = assertLinked(id); const revision = ++codeUpdate;
        const assertChart = chartGuard(chart, sessionId, chartExecution, handle);
        const assertOwner = (): SessionView => {
            if (revision !== codeUpdate) throw new Error('The script update was superseded. Open it from the intended chart again.');
            return assertChart();
        };
        await stopBacktest(); assertOwner(); await persistRun(); assertOwner(); assertLinked(id);
        const result = await handle.updateCode(source); if (!result.ok) throw result.error ?? new Error('The edited script could not run.');
        assertOwner(); assertLinked(id);
        linkedOwner = { chart, sessionId, handle }; reportRequest = { source, document: null, chart, sessionId, handle, name: handle.title };
        deep.checked = false; refreshControls();
        await options.onChange();
        assertOwner();
        const assertContext = chartGuard(chart, sessionId, chartExecution, handle, true, true);
        const context = await handle.context(['strategy', 'trades', 'warnings']); const view = assertOwner();
        assertContext();
        if (context?.strategy) await showResult({ name: handle.title, symbol: view.dataset.symbol,
            timeframe: chart.market.timeframe ?? '1', from: view.dataset.start, to: options.cutoff() ?? view.dataset.start,
            state: context.strategy, trades: context.trades ?? [],
            warnings: [...context.warnings.map((warning) => warning.message), 'Chart execution uses up to 5,000 loaded candles. Backtest uses complete revealed history.'] }, undefined, () => { assertOwner(); assertContext(); });
    };
    const backtest = async (request: ReportRequest, mode: 'replay' | 'deep', range?: { from: number; to: number }): Promise<ScriptWorkspaceResult> => {
        const { source, document } = request;
        request.assertCurrent?.();
        const view = assertReady(); if (working) throw new Error('A backtest is already running.');
        const chart = workspace.chart; const chartTimeframe = chart.market.timeframe ?? '1'; const timeframe = request.fixed?.timeframe ?? chartTimeframe; const sourceCutoff = options.cutoff();
        const sessionId = view.session.id; const datasetId = view.dataset.id; const datasetChecksum = view.dataset.checksum; const cursor = view.session.cursor;
        if (request.chart !== chart || request.sessionId !== sessionId || request.fixed && (request.fixed.datasetId !== datasetId || request.fixed.datasetChecksum !== datasetChecksum)) throw new Error('This report belongs to another chart or replay dataset. Open its session or backtest the intended source again.');
        const linked = request.handle;
        if (linked && (!chart.indicators().includes(linked) || linked.source === undefined)) throw new Error('The linked script belongs to another chart or replay session. Open it from the active chart again.');
        const linkedSource = linked?.source;
        const linkedInputs = linked ? settingsKey(linked.inputValues()) : undefined;
        const linkedProps = linked ? settingsKey(linked.propValues()) : undefined;
        const configured = linked && linkedSource === source;
        const inputs: Record<string, InputValue> = request.fixed ? { ...request.fixed.inputs } as Record<string, InputValue> : configured ? { ...linked.inputValues() } : {};
        const props: Record<string, InputValue> = request.fixed ? { ...request.fixed.properties } as Record<string, InputValue> : configured ? { ...linked.propValues() } : {};
        const settingsWarning = linked && !configured ? 'Editor source differs from its chart instance; this backtest uses source-declared inputs and properties. Update the chart first to use its configured values.' : undefined;
        const assertOwnership = (): void => {
            request.assertCurrent?.();
            const current = options.session();
            if (disposed || workspace.chart !== chart || !current || current.session.id !== sessionId || current.dataset.id !== datasetId || current.dataset.checksum !== datasetChecksum || current.session.cursor !== cursor || options.cutoff() !== sourceCutoff || (chart.market.timeframe ?? '1') !== chartTimeframe) throw new Error('The chart or replay session changed during the backtest. Run it again on the intended chart.');
            if (linked && (!chart.indicators().includes(linked) || linked.source !== linkedSource
                || settingsKey(linked.inputValues()) !== linkedInputs || settingsKey(linked.propValues()) !== linkedProps)) throw new Error('The linked script changed during the backtest. Run it again.');
        };
        working = true; save.disabled = true; exportButton.disabled = true; cancel.hidden = false; library.disabled = true;
        refreshControls();
        const controller = new AbortController(); backtestController = controller;
        backtestOperationId = request.operationId;
        const query = new URLSearchParams({ cursor: String(cursor), timeframe, limit: '250000' });
        let scopeId: string | undefined;
        try {
            await persistRun();
            if (controller.signal.aborted) throw new Error('Backtest cancelled.');
            assertOwnership();
            await open('tester'); status.textContent = mode === 'deep' ? 'Loading selected cached history…' : 'Loading cached, revealed history…';
            assertOwnership();
            const data = mode === 'deep'
                ? await api.post<import('../shared/deep-backtest').DeepHistoryResponse>('/api/deep-history', { datasetId, timeframe, ...range }, controller.signal)
                : await api.get<ReplaySeriesResponse>(`/api/sessions/${encodeURIComponent(view.session.id)}/series?${query}`, controller.signal);
            scopeId = data.scopeId;
            assertOwnership();
            if (data.hasMore || data.bars.length > 250000) throw new Error('Choose a shorter history; the backtest exceeds 250,000 bars.');
            if (!data.bars.length) throw new Error(mode === 'deep' ? 'No cached candles exist in the selected UTC range.' : 'Reveal candles before backtesting this session.');
            const primarySources = data.history ? data.history.sourceDatasets : datasetReferences(data.sourceDatasets);
            if (!data.history && (data.cursorTime !== sourceCutoff || !primarySources.some(item => item.id === datasetId && item.checksum === datasetChecksum))) throw new Error('The replay data provenance changed during the backtest. Run it again.');
            const secondarySources = new Map<string, string>();
            const recordSources = (references: DeepSourceDataset[]): void => {
                for (const item of references) {
                    const primary = primarySources.find(dataset => dataset.id === item.id);
                    if (primary && primary.checksum !== item.checksum || secondarySources.has(item.id) && secondarySources.get(item.id) !== item.checksum) throw new Error('A cached secondary dataset changed during the backtest. Run it again.');
                    secondarySources.set(item.id, item.checksum);
                }
                if (secondarySources.size > 200) throw new Error('The backtest secondary provenance exceeds 200 datasets. Choose a shorter history.');
            };
            const { runPineBacktest } = await import('../scripting/backtest');
            assertOwnership();
            const result = await runPineBacktest({ source, bars: data.bars, market: { symbol: `replay:${view.dataset.symbol}`, timeframe, symbolInfo: data.symbolInfo },
                inputs, props, cutoff: data.cursorTime ?? undefined, signal: controller.signal, workerUrl: '/local-pine-worker.js',
                fetchSeriesAt: async (symbol, secondaryTimeframe, range, cutoff, signal) => {
                    assertOwnership();
                    if (scopeId) {
                        const series = await api.post<import('../shared/deep-backtest').DeepSeriesResponse>(`/api/deep-history/${encodeURIComponent(scopeId)}/series`, { symbol, timeframe: secondaryTimeframe,
                            cutoff: Math.min(cutoff, data.cursorTime ?? cutoff), from: range.from, limit: Math.min(range.limit ?? 250000, 250000) }, signal);
                        assertOwnership();
                        if (series.hasMore || series.bars.length > 250000) throw new Error('A secondary series exceeds 250,000 candles. Choose a shorter range.');
                        if (data.history) {
                            recordSources(datasetReferences(series.sourceDatasets));
                            data.history.secondarySourceDatasets = [...secondarySources].sort(([a], [b]) => a.localeCompare(b)).map(([id, checksum]) => ({ id, checksum }));
                        }
                        return range.to === undefined ? series.bars : series.bars.filter(bar => bar.time <= range.to!);
                    }
                    const args = new URLSearchParams({ timeframe: secondaryTimeframe, cutoff: String(Math.min(cutoff, data.cursorTime ?? cutoff)), limit: String(Math.min(range.limit ?? 250000, 250000)) });
                    args.set('symbol', symbol);
                    if (range.from !== undefined) args.set('from', String(Math.max(0, Math.floor(range.from))));
                    const series = await api.get<ReplaySeriesResponse>(`/api/sessions/${view.session.id}/series?${args}`, signal);
                    assertOwnership();
                    if (series.hasMore || series.bars.length > 250000) throw new Error('A secondary series exceeds 250,000 candles. Choose a shorter range.');
                    recordSources(datasetReferences(series.sourceDatasets));
                    return range.to === undefined ? series.bars : series.bars.filter((bar) => bar.time <= range.to!);
                },
                onProgress: (progress) => { if (!disposed) status.textContent = `${progress.phase} · ${progress.bars.toLocaleString()} candles`; },
            });
            if (disposed || controller.signal.aborted) throw new Error('Backtest cancelled.');
            assertOwnership();
            const from = data.history?.requestedFrom ?? data.bars[0]!.time; const to = data.history?.requestedTo ?? data.cursorTime ?? data.bars.at(-1)!.time;
            const name = document?.name ?? request.name ?? result.title ?? currentRun?.run?.title ?? 'Pine strategy';
            const provenance: ReplayBacktestProvenance | undefined = data.history ? undefined : { version: 1, mode: 'replay', reportedBy: 'client', sessionId, cursor, cutoff: to,
                primarySourceDatasets: primarySources, secondarySourceDatasets: [...secondarySources].sort(([a], [b]) => a.localeCompare(b)).map(([id, checksum]) => ({ id, checksum })) };
            const warnings = [...result.warnings, ...(settingsWarning ? [settingsWarning] : []), data.history ? `Deep backtest · selected cache range · not replay. Tested ${data.bars.length.toLocaleString()} candles from ${new Date(from).toISOString()} to ${new Date(to).toISOString()} (end excluded).` : `Tested ${data.bars.length.toLocaleString()} cached candles through ${new Date(to).toISOString()}. Future replay candles were excluded.`];
            const nextSnapshot: BacktestSnapshot = { ...(document && document.source === source ? { strategyId: document.id } : request.fixed?.strategyId ? { strategyId: request.fixed.strategyId } : {}), scriptVersion: document && document.source === source ? document.versions : request.fixed?.scriptVersion ?? 0,
                source, symbol: view.dataset.symbol, timeframe, datasetId: view.dataset.id, datasetChecksum: view.dataset.checksum, from, to,
                inputs, properties: props, ...(data.history ? { history: data.history } : {}), ...(provenance ? { provenance } : {}), engine: { vela: '0.8.5', addon: '0.2.17', pinets: '0.12.0' }, result: plainJson({ ...result, warnings }) };
            await showResult({ name, symbol: view.dataset.symbol, timeframe, from, to, ...result, warnings, ...(data.history ? { history: data.history } : {}) }, { snapshot: nextSnapshot, name }, assertOwnership);
            reportRequest = request; deep.checked = mode === 'deep';
            save.disabled = false; exportButton.disabled = false; status.textContent = data.history ? 'Deep backtest complete · selected cache range · not replay' : 'Backtest complete · cached, revealed history';
            const completed = readCurrentResult();
            if (!completed || snapshot !== nextSnapshot) throw new Error('The strategy result changed before publication.');
            return completed;
        } catch (error) {
            if (!snapshot || failedSnapshot !== snapshot) status.textContent = controller.signal.aborted ? 'Backtest cancelled' : 'Backtest failed';
            throw error;
        }
        finally {
            if (scopeId) await api.post(`/api/deep-history/${encodeURIComponent(scopeId)}/release`, {}, AbortSignal.timeout(5000)).catch(() => undefined);
            working = false; cancel.hidden = true; library.disabled = false; backtestController = undefined; backtestOperationId = undefined;
            save.disabled = !snapshot || snapshot === persistedSnapshot; exportButton.disabled = !snapshot; refreshControls();
        }
    };
    const startBacktest = (request: ReportRequest, mode: 'replay' | 'deep', range?: { from: number; to: number }): Promise<ScriptWorkspaceResult> => {
        if (working) return Promise.reject(new Error('A backtest is already running.'));
        const pending = backtest(request, mode, range); backtestPending = pending;
        return pending.finally(() => { if (backtestPending === pending) backtestPending = undefined; });
    };
    const startBacktestForIndicator = async (id: string, config: IndicatorBacktestOptions, assertCurrent?: () => void): Promise<ScriptWorkspaceResult> => {
        assertCurrent?.(); const view = assertReady();
        if (config.mode !== 'replay' && config.mode !== 'deep') throw new Error('Choose replay or deep backtesting explicitly.');
        if (config.mode === 'replay' && (config.from !== undefined || config.to !== undefined)) throw new Error('Normal replay backtests use the revealed history; date bounds require deep mode.');
        if (config.mode === 'deep' && (!Number.isSafeInteger(config.from) || !Number.isSafeInteger(config.to) || config.from! < 0 || config.to! > 8_640_000_000_000_000 || config.from! >= config.to!)) throw new Error('Supply valid UTC from and exclusive to dates for a deep backtest.');
        if (config.operationId !== undefined && !/^[a-z0-9][a-z0-9._:-]{0,119}$/i.test(config.operationId)) throw new Error('Invalid backtest operation ID.');
        const chart = workspace.chart; const handle = chart.indicators().find(item => item.id === id);
        if (!handle || handle.source === undefined) throw new Error('The exact Pine indicator is no longer on the active chart.');
        return startBacktest({ source: handle.source, document: null, chart, sessionId: view.session.id, handle, name: handle.title,
            operationId: config.operationId, assertCurrent }, config.mode, config.mode === 'deep' ? { from: config.from!, to: config.to! } : undefined);
    };
    const editorBacktest = async (source: string, document: ScriptDocument | null, context?: PineBacktestContext): Promise<void> => {
        if (working) throw new Error('A backtest is already running.');
        const view = assertReady(); const chart = workspace.chart;
        const handle = context?.instanceId ? chart.indicators().find(item => item.id === context.instanceId) : undefined;
        if (context?.instanceId && (!handle || linkedOwner?.handle !== handle || linkedOwner.chart !== chart || linkedOwner.sessionId !== view.session.id)) throw new Error('The linked script belongs to another chart or replay session. Open it from the active chart again.');
        const request = { source, document, chart, sessionId: view.session.id, handle };
        deep.checked = false; refreshControls();
        await startBacktest(request, 'replay');
    };
    const refreshReport = async (): Promise<void> => {
        if (!reportRequest) { await open('editor'); return; }
        const range = deep.checked ? { from: dateValue(deepFrom.value), to: dateValue(deepTo.value) } : undefined;
        if (range && range.from >= range.to) throw new Error('The UTC end must be after the start; the end is excluded.');
        await startBacktest(reportRequest, deep.checked ? 'deep' : 'replay', range);
    };
    const getEditor = (): Promise<Editor> => editorPromise ??= import('./pine-editor').then(async ({ mountPineEditor }) => {
        if (disposed) throw new Error('The workspace closed.');
        let storage: Storage | undefined;
        try { storage = window.sessionStorage; } catch { /* Recovery can use a document-scoped identity when session storage is unavailable. */ }
        const storageKey = await editorDraftStorageKey(storage);
        if (disposed) throw new Error('The workspace closed.');
        editor = mountPineEditor(editorHost, { api, storageKey,
            onRun: (source) => track(() => run(source)), onUpdate: (id, source) => track(() => update(id, source)), onBacktest: editorBacktest,
            onClose: () => { panel.close(); }, onRemove: (id: string) => track(async () => {
                assertReady(); const owner = assertLinked(id); const execution = chartExecution;
                const assertOwner = chartGuard(owner.chart, owner.sessionId, execution, owner.handle);
                await stopBacktest(); assertOwner(); await persistRun(); assertOwner(); assertLinked(id);
                chartExecution++; owner.handle.remove(); linkedOwner = undefined; offRun?.(); offRun = undefined;
                for (const [run, binding] of runs) if (binding.handle === owner.handle && binding.chart === owner.chart) {
                    runs.delete(run); if (currentRun === run) currentRun = undefined;
                }
                if (reportRequest?.handle === owner.handle) reportRequest = undefined;
                refreshControls(); await options.onChange();
            }) }); return editor;
    });
    async function open(tab: 'replay' | 'editor' | 'tester'): Promise<void> {
        if (disposed) return;
        root.dispatchEvent(new CustomEvent('local-replay:chrome', { bubbles: true, detail: { kind: 'pause' } }));
        panel.open(); activeTab = tab; dock.dataset.activeTab = tab; replayHost.hidden = tab !== 'replay'; editorHost.hidden = tab !== 'editor'; testerHost.hidden = tab !== 'tester';
        dock.querySelectorAll<HTMLElement>('[data-script-tab]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.scriptTab === tab)));
        railButtons.forEach((button, index) => button.setAttribute('data-active', String(index === (tab === 'editor' ? 0 : tab === 'tester' ? 1 : -1) ? 1 : 0)));
        if (tab === 'editor') await getEditor();
        else if (tab === 'tester') { refreshControls(); await refreshLibrary(); }
    }
    const click = (event: MouseEvent): void => {
        const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button) return;
        if (button.dataset.scriptTab) void open(button.dataset.scriptTab as 'replay' | 'editor' | 'tester').catch(options.onError);
        if (button.classList.contains('local-script-close')) { panel.close(); railButtons.forEach((item) => item.dataset.active = '0'); }
        if (button === cancel) backtestController?.abort();
        if (button === openEditor) void open('editor').catch(options.onError);
        if (button === updateReport) void refreshReport().catch(options.onError);
        if (button === resetReport) { deep.checked = false; refreshControls(); void refreshReport().catch(options.onError); }
        if (button === properties) {
            const request = reportRequest; const handle = request?.handle;
            if (request && handle && request.chart === workspace.chart && request.sessionId === options.session()?.session.id
                && request.source === handle.source && workspace.chart.indicators().includes(handle) && workspace.chart.renderer?.supportsIndicatorSettings) {
                workspace.chart.renderer.openIndicatorSettings(handle.id);
            } else { applied.open = !applied.open; }
        }
        if (button === exportButton && snapshot) {
            try {
                downloadJson(`${resultName.replace(/[^a-z0-9_-]/gi, '_')}-backtest.json`, { name: resultName, snapshot });
                exportedSnapshot = snapshot; refreshRecovery();
            } catch (error) { options.onError(error); }
        }
        if (button === discard && !working && !saving && snapshot && failedSnapshot === snapshot && exportedSnapshot === snapshot) {
            snapshot = undefined; failedSnapshot = undefined; exportedSnapshot = undefined;
            if (currentResult) currentResult.snapshot = null;
            save.disabled = true; exportButton.disabled = true; refreshRecovery();
            status.textContent = 'Unsaved result discarded. The report remains visible.';
        }
        if (button === save && snapshot && !options.blocked()) {
            save.disabled = true;
            void persistRun()
                .catch(options.onError).finally(() => { if (!disposed) save.disabled = !snapshot || snapshot === persistedSnapshot; });
        }
    };
    const change = (): void => {
        if (!library.value || working) return;
        const id = library.value; const request = ++libraryRequest; const generation = resultGeneration;
        void persistRun().then(() => api.get<StoredBacktest>(`/api/backtests/${encodeURIComponent(id)}`)).then(async (saved) => {
            if (disposed || request !== libraryRequest || generation !== resultGeneration || working) return;
            const result = saved.result as unknown as Pick<StrategyResultsSnapshot, 'state' | 'trades' | 'equity' | 'warnings'>;
            await showResult({ ...result, name: saved.name, symbol: saved.symbol, timeframe: saved.timeframe, from: saved.from, to: saved.to, ...(saved.history ? { history: saved.history } : {}) }, { snapshot: saved, name: saved.name, saved: true, id });
            if (disposed || snapshot !== saved || displayedRunId !== id) return;
            const view = options.session();
            reportRequest = view ? { source: saved.source, document: null, chart: workspace.chart, sessionId: view.session.id, fixed: saved, name: saved.name } : undefined;
            refreshControls(); deep.checked = !!saved.history;
            if (saved.history) { deepFrom.value = dateInput(saved.history.requestedFrom); deepTo.value = dateInput(saved.history.requestedTo); }
            refreshControls();
            exportButton.disabled = false; save.disabled = true; status.textContent = `Saved ${new Date(saved.createdAt).toLocaleString()}`;
        }).catch((error: unknown) => { if (!disposed && request === libraryRequest) library.value = displayedRunId; options.onError(error); });
    };
    const edit = (event: Event): void => {
        const value = (event as CustomEvent<{ id: string; source: string; name: string }>).detail;
        const chart = workspace.chart; const view = options.session(); const handle = chart.indicators().find(item => item.id === value.id);
        if (!view || !handle || handle.source !== value.source) { options.onError(new Error('This script is no longer on the active chart. Open it from its chart again.')); return; }
        const sessionId = view.session.id; const request = ++editRequest;
        void open('editor').then(async () => {
            const controller = await getEditor();
            if (request !== editRequest) return;
            if (disposed || workspace.chart !== chart || options.session()?.session.id !== sessionId || !chart.indicators().includes(handle) || handle.source !== value.source) throw new Error('The chart or replay session changed while opening the script.');
            if (controller.open({ source: value.source, name: value.name, instanceId: value.id })) linkedOwner = { chart, sessionId, handle };
        }).catch(options.onError);
    };
    const containKeys = (event: KeyboardEvent): void => { event.stopPropagation(); };
    const chrome = (event: Event): void => {
        const detail = (event as CustomEvent<{ kind: string }>).detail;
        if (detail.kind === 'replay-stats-open' || detail.kind === 'replay-toggle' && (dock.hidden || activeTab !== 'replay')) void open('replay').catch(options.onError);
    };
    const deepChange = (): void => { refreshControls(); };
    dock.addEventListener('click', click); dock.addEventListener('keydown', containKeys); deep.addEventListener('change', deepChange); library.addEventListener('change', change); root.addEventListener('local-pine:edit', edit); root.addEventListener('local-replay:chrome', chrome);
    if (options.session() && options.initialOpen !== false) { dock.hidden = false; dock.querySelector('[data-script-tab=replay]')!.setAttribute('aria-selected', 'true'); }
    return { flush: async () => { await editor?.flush(); await persistRun(); },
        prepareForUpdate: async () => {
            preparing = true;
            try {
                await editor?.flush(); backtestController?.abort();
                await backtestPending?.catch(() => undefined);
                await Promise.allSettled([...scriptOperations]);
                await editor?.flush(); await persistRun();
            } finally { preparing = false; }
        }, busy: () => working, readCurrentResult, startBacktestForIndicator,
        cancelBacktest: (operationId) => {
            if (!operationId || backtestOperationId !== operationId || !backtestController || backtestController.signal.aborted) return false;
            backtestController.abort(); return true;
        },
        destroy: () => { disposed = true; backtestController?.abort(); offRun?.(); for (const [value, binding] of runs) {
            if (!binding.handle || binding.chart.indicators().includes(binding.handle)) value.remove();
        }
            editor?.destroy(); results?.destroy(); railButtons.forEach((button) => button.remove()); dock.removeEventListener('click', click); dock.removeEventListener('keydown', containKeys); deep.removeEventListener('change', deepChange); library.removeEventListener('change', change);
            root.removeEventListener('local-pine:edit', edit); root.removeEventListener('local-replay:chrome', chrome);
            root.dispatchEvent(new CustomEvent('local-replay:chrome', { bubbles: true, detail: { kind: 'replay-stats-unmount' } })); panel.destroy(); undock(); },
    };
}
