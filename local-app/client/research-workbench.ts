import type { Vela } from '../../src/index';
import type { CrosshairEvent } from '../../src/core/ports/IChartRenderer';
import type { Bar, SessionView } from '../shared/types';
import type { AnalysisScopeSummary } from '../shared/chart-analysis';
import { buildCandleEvidence, CANDLE_EVIDENCE_LIMITS, type CandleEvidence, type CandleEvidenceSnapshot } from '../shared/candle-evidence';
import { parseScenarioContent, parseScenarioContext, type ScenarioContent, type ScenarioContext, type ScenarioAnnotation } from '../shared/scenarios';
import { parseTimeframe, nextTimeframeBucket } from '../shared/timeframes';
import type { LocalApi } from './api';
import type { ChartAgentController, ResearchOwner } from './chart-agent';
import { replaySnapshot, serverTimeframe } from './chart-data';
import { mountScenarioNotebook } from './scenario-notebook';
import { mountCandleEvidence } from './candle-evidence';
import './research-workbench.css';
export type { ResearchOwner } from './chart-agent';
export interface ResearchCell { chart: Vela; bars: readonly Bar[] }
export interface ResearchWorkbenchOptions {
    api: LocalApi; session(): SessionView | null; cursorTime(): number | null; generation(): number;
    activeCellId(): string | null; cell(id: string): ResearchCell | null; agent(): ChartAgentController | null;
    drawingSync?(): unknown;
    blocked(): boolean; pause(): void; flush(): Promise<void>;
}
export interface ResearchWorkbench {
    attach(host: HTMLElement): void; park(): void; synchronize(force?: boolean): void;
    capture(cellId: string, event: CrosshairEvent): void; select(cellId: string, time: number | null): void;
    preemptGhost(originId: string, followers: readonly string[]): void;
    readCandle(input: { cellId: string; selectedTime?: number; scope: AnalysisScopeSummary }, owner: ResearchOwner): Promise<CandleEvidence>;
    propose(input: { cellId: string; content: ScenarioContent; context: ScenarioContext }, owner: ResearchOwner): Promise<{ draftOnly: true; context: ScenarioContext }>;
    prepare(): Promise<void>; destroy(): void;
}
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Research request cancelled.')); };
        signal.addEventListener('abort', abort, { once: true });
        promise.then(value => { signal.removeEventListener('abort', abort); if (!signal.aborted) resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
        if (signal.aborted) abort();
    });
}
const copyBar = (bar: Bar): Bar => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
    ...(bar.instrumentId === undefined ? {} : { instrumentId: bar.instrumentId, contract: bar.contract }) });
const equal = (a: ScenarioContext, b: ScenarioContext) => JSON.stringify(a) === JSON.stringify(b);
export function mountResearchWorkbench(host: HTMLElement, options: ResearchWorkbenchOptions): ResearchWorkbench {
    const doc = host.ownerDocument, root = doc.createElement('section'), tabs = doc.createElement('div'), evidenceHost = doc.createElement('div'), scenarioHost = doc.createElement('div');
    root.className = 'local-research-workbench'; tabs.className = 'research-tabs'; root.hidden = true;
    const status = doc.createElement('p'); status.className = 'research-status'; status.setAttribute('role', 'status');
    const previewHost = doc.createElement('section'); previewHost.className = 'research-preview'; previewHost.hidden = true;
    const selectedLabel = doc.createElement('p'); selectedLabel.textContent = 'Click a price candle, then explain its revealed evidence.';
    const explain = doc.createElement('button'); explain.type = 'button'; explain.textContent = 'Explain selected candle';
    const evidenceTab = doc.createElement('button'), scenarioTab = doc.createElement('button'); evidenceTab.type = scenarioTab.type = 'button';
    evidenceTab.textContent = 'Candle evidence'; scenarioTab.textContent = 'Scenarios'; tabs.append(evidenceTab, scenarioTab); root.append(tabs, status, previewHost, evidenceHost, scenarioHost); host.append(root);
    let disposed = false, preparing = false, stamp = '', controller = new AbortController(), selection: { cellId: string; time: number } | null = null;
    let readyContext: ScenarioContext | null = null;
    let contextLoad: Promise<ScenarioContext> | null = null, contextFailed = false;
    const captures = new Map<string, Map<number, Bar>>(), snapshots = new Map<string, CandleEvidenceSnapshot>();
    let previewChart: Vela | null = null, previewCellId: string | null = null, previewSequence = 0, sharing = '';
    const tasks = new Set<Promise<unknown>>();
    function track<T>(promise: Promise<T>): Promise<T> { tasks.add(promise); void promise.then(() => tasks.delete(promise), () => tasks.delete(promise)); return promise; }
    function tab(scenarios: boolean): void { evidenceHost.hidden = scenarios; scenarioHost.hidden = !scenarios; evidenceTab.setAttribute('aria-pressed', String(!scenarios)); scenarioTab.setAttribute('aria-pressed', String(scenarios)); }
    evidenceTab.addEventListener('click', () => tab(false)); scenarioTab.addEventListener('click', () => { tab(true); synchronize(); loadContext(true); }); tab(false);
    function token(): string {
        const view = options.session(), cellId = options.activeCellId(), cell = cellId ? options.cell(cellId) : null;
        return JSON.stringify([options.generation(), view?.session.id, view?.session.cursor, view?.session.revision, view?.dataset.id, view?.dataset.checksum,
            options.cursorTime(), cellId, cell?.chart.market.symbol, cell?.chart.market.timeframe, cell?.chart.renderer.get?.('priceStyle') ?? 'candles', options.drawingSync?.()]);
    }
    function guard(cellId: string, owner?: ResearchOwner) {
        owner?.assertCurrent();
        const captured = token(), view = options.session(), cell = options.cell(cellId), cursor = options.cursorTime();
        if (disposed || preparing || options.blocked() || !view || !cell || options.activeCellId() !== cellId || cursor === null) throw new Error('Research chart context is unavailable.');
        const signal = owner ? AbortSignal.any([controller.signal, owner.signal]) : controller.signal;
        const assertCurrent = () => {
            signal.throwIfAborted(); owner?.assertCurrent();
            if (disposed || preparing || options.blocked() || token() !== captured || options.cell(cellId)?.chart !== cell.chart) throw new Error('Research chart, replay or selection changed.');
        };
        assertCurrent(); return { view, cell, cursor, signal, assertCurrent };
    }
    function clearPreview(clearOwned = true): void {
        previewSequence++;
        if (clearOwned && previewChart) previewChart.drawings.setExternalGhost(null);
        previewChart = null; previewCellId = null; previewHost.replaceChildren(); previewHost.hidden = true;
    }
    async function currentContext(cellId: string, owner?: ResearchOwner): Promise<ScenarioContext> {
        const captured = guard(cellId, owner), { view } = captured;
        const result = parseScenarioContext(await wait(options.api.get<unknown>(`/api/sessions/${encodeURIComponent(view.session.id)}/scenarios/context`, captured.signal), captured.signal));
        captured.assertCurrent();
        if (result.sessionId !== view.session.id || result.datasetId !== view.dataset.id || result.datasetChecksum !== view.dataset.checksum
            || result.cursor !== view.session.cursor || result.cutoff !== captured.cursor) throw new Error('Scenario context differs from the loaded replay.');
        return result;
    }
    const notebook = mountScenarioNotebook(scenarioHost, { api: options.api, onPreview: (annotations, context) => track((async () => {
        const request = ++previewSequence;
        const cellId = options.activeCellId(); if (!cellId) throw new Error('Select a chart cell.');
        const captured = guard(cellId); const actual = await currentContext(cellId); captured.assertCurrent();
        if (request !== previewSequence || !equal(actual, context)) throw new Error('Recapture the current replay candle before previewing this scenario.');
        if (captured.cell.chart.drawings.getTool?.() || captured.cell.chart.drawings.getMode?.()) throw new Error('Finish the current drawing tool before previewing a hypothesis.');
        clearPreview();
        const selectedRequest = previewSequence;
        const show = async (annotation: ScenarioAnnotation): Promise<void> => {
            captured.assertCurrent(); if (selectedRequest !== previewSequence) throw new Error('Hypothesis preview was replaced.');
            previewChart = captured.cell.chart; previewCellId = cellId;
            captured.cell.chart.drawings.setExternalGhost({ id: `scenario-preview-${crypto.randomUUID()}`, type: 'hline', paneId: 'price', anchors: [{ time: annotation.time ?? context.cutoff, price: annotation.price }],
                    style: { lineColor: annotation.case === 'bull' ? '#248565' : '#b74e65', lineWidth: 1, lineStyle: annotation.kind === 'invalidation' ? 'dotted' : 'dashed' },
                    text: { value: annotation.label, size: 'small', hAlign: 'left', vAlign: 'top' }, locked: true, visible: true, zIndex: 0, createdAt: Date.now() });
            await options.flush(); captured.assertCurrent();
        };
        const note = doc.createElement('p'); note.textContent = 'Choose a hypothesis level to preview. One level appears at a time and clears when the chart or replay changes.'; previewHost.append(note);
        for (const annotation of annotations) {
            const button = doc.createElement('button'); button.type = 'button'; button.textContent = `${annotation.label} · ${annotation.price}`;
            button.addEventListener('click', () => { void track(show(annotation)).catch(() => { if (!disposed) status.textContent = 'Hypothesis preview changed. Preview the notebook levels again.'; }); }); previewHost.append(button);
        }
        const clear = doc.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear hypothesis preview'; clear.addEventListener('click', () => clearPreview()); previewHost.append(clear); previewHost.hidden = false;
        try { if (annotations[0]) await show(annotations[0]); }
        catch (error) { if (selectedRequest === previewSequence) clearPreview(); throw error; }
    })()) });
    const candle = mountCandleEvidence(evidenceHost, { prepareQuestion: async (question, owner) => {
        const cellId = question.scope.target.cellId; if (!cellId) throw new Error('Select a chart cell.');
        const captured = guard(cellId, owner), agent = options.agent(); if (!agent) throw new Error('The AI chart connection is still loading.');
        options.pause(); captured.assertCurrent();
        const instruction = `${question.question}\nRead vela_read_analysis_request to verify the queued target and historical clock. Call vela_read_candle_evidence on that exact target with selectedTime=${question.selectedTime} only. Preserve the verified source clock.`;
        await agent.requestAnalysis(instruction, { from: question.scope.region.requestedFrom, to: question.scope.region.requestedTo }, { signal: captured.signal, assertCurrent: captured.assertCurrent });
        captured.assertCurrent();
    } });
    evidenceHost.prepend(selectedLabel, explain);
    function loadContext(retry = false): void {
        if (disposed || preparing || options.blocked() || readyContext || contextLoad || contextFailed && !retry) return;
        const cellId = options.activeCellId(); if (!cellId || !options.session() || options.cursorTime() === null) return;
        const capturedStamp = stamp, capturedController = controller, pending = currentContext(cellId);
        contextLoad = pending;
        const current = () => !disposed && !preparing && controller === capturedController && !capturedController.signal.aborted && token() === capturedStamp;
        void track(pending).then(value => {
            if (contextLoad !== pending) return; contextLoad = null;
            if (!current() || options.blocked()) return;
            contextFailed = false; readyContext = value; notebook.setContext(value); status.textContent = '';
        }, () => {
            if (contextLoad !== pending) return; contextLoad = null;
            if (!current()) return;
            contextFailed = true; status.textContent = 'Research context is unavailable. Open Scenarios to retry. Local scenario drafts are retained.';
        });
    }
    function synchronize(force = false): void {
        if (disposed) return; const next = token(); if (!force && next === stamp) { loadContext(); return; }
        const nextSharing = JSON.stringify(options.drawingSync?.());
        const sharingChanged = sharing !== nextSharing; sharing = nextSharing;
        stamp = next; controller.abort(); controller = new AbortController(); contextLoad = null; contextFailed = false; captures.clear(); snapshots.clear(); selection = null; readyContext = null;
        clearPreview(!sharingChanged); candle.update(null); notebook.setContext(null); selectedLabel.textContent = 'Click a price candle, then explain its revealed evidence.';
        loadContext();
    }
    async function snapshot(input: { cellId: string; selectedTime?: number; scope: AnalysisScopeSummary }, owner: ResearchOwner): Promise<CandleEvidenceSnapshot> {
        const captured = guard(input.cellId, owner), { view, cell, cursor } = captured, scope = input.scope;
        const selectedTime = input.selectedTime ?? (selection?.cellId === input.cellId ? selection.time : undefined);
        if (selectedTime === undefined || !Number.isSafeInteger(selectedTime)) throw new Error('Select the exact displayed candle.');
        const period = parseTimeframe(cell.chart.market.timeframe ?? ''), style = String(cell.chart.renderer.get?.('priceStyle') ?? 'candles');
        if (!period || !['candles', 'bars', 'heikinashi'].includes(style)) throw new Error('Candle evidence requires a time-preserving candle chart.');
        if (scope.target.sessionId !== view.session.id || scope.target.generation !== options.generation() || scope.target.cellId !== input.cellId
            || scope.dataset.id !== view.dataset.id || scope.dataset.checksum !== view.dataset.checksum || scope.cursorTime !== cursor
            || scope.chart.timeframe !== period.native || scope.chart.symbol !== cell.chart.market.symbol) throw new Error('Candle scope differs from the displayed chart.');
        if (Math.min(nextTimeframeBucket(selectedTime, period), cursor + view.dataset.intervalMs) > scope.clock.availableUntil) throw new Error('Displayed forming candle includes values after this historical scope clock.');
        const available = style === 'heikinashi' ? [...(captures.get(input.cellId)?.values() ?? [])] : [...cell.bars];
        let displayed = available.filter(bar => bar.time <= selectedTime).sort((a,b) => a.time - b.time).slice(-21).map(copyBar);
        const selected = displayed.find(bar => bar.time === selectedTime);
        if (!selected) throw new Error('Capture the actual displayed candle with the renderer crosshair before explaining it.');
        if (selected.instrumentId !== undefined) displayed = displayed.filter(bar => bar.instrumentId === selected.instrumentId && bar.contract === selected.contract);
        const to = Math.min(nextTimeframeBucket(selectedTime, period), scope.clock.availableUntil);
        while (displayed.length > 1 && Math.ceil((to - displayed[0]!.time) / view.dataset.intervalMs) > CANDLE_EVIDENCE_LIMITS.rawBars) displayed.shift();
        const from = displayed[0]!.time;
        if (from >= to || Math.ceil((to - from) / view.dataset.intervalMs) > CANDLE_EVIDENCE_LIMITS.rawBars) throw new Error('This candle exceeds the 10,000-source-bar evidence budget. Choose a finer timeframe.');
        const readCutoff = Math.min(scope.clock.sourceCutoff, to - view.dataset.intervalMs);
        const query = new URLSearchParams({ timeframe: serverTimeframe(view.dataset.schema === 'ohlcv-1s' ? '1S' : '1'), limit: String(CANDLE_EVIDENCE_LIMITS.rawBars),
            cutoff: String(readCutoff), from: String(from), to: String(to - 1), snapshot: replaySnapshot(view) });
        const reply = await wait(options.api.get<{ bars: Bar[]; cursorTime: number; baseIntervalMs: number; hasMore: boolean; datasetId: string; checksum: string; sourceDatasets: { id: string; checksum: string }[] }>(
            `/api/sessions/${encodeURIComponent(view.session.id)}/series?${query}`, captured.signal), captured.signal);
        captured.assertCurrent();
        if (!Number.isSafeInteger(reply.cursorTime) || reply.cursorTime > readCutoff || reply.cursorTime < from || reply.baseIntervalMs !== view.dataset.intervalMs || reply.hasMore || reply.datasetId !== view.dataset.id || reply.checksum !== view.dataset.checksum
            || !Array.isArray(reply.bars) || reply.bars.length > CANDLE_EVIDENCE_LIMITS.rawBars || !Array.isArray(reply.sourceDatasets)
            || reply.bars.at(-1)?.time !== reply.cursorTime
            || reply.sourceDatasets.length !== 1 || reply.sourceDatasets[0]?.id !== view.dataset.id || reply.sourceDatasets[0]?.checksum !== view.dataset.checksum
            || view.dataset.continuous && reply.bars.some(bar => !bar.instrumentId || !bar.contract)) throw new Error('Complete pinned raw source coverage and dataset identity are required.');
        const envelope = { dataset: scope.dataset, cursorTime: scope.cursorTime, sourceCutoff: scope.clock.sourceCutoff };
        return { scope, selectedTime, raw: { ...envelope, from, to, bars: reply.bars.map(copyBar) }, displayed: { ...envelope, bars: displayed },
            transform: { kind: style === 'heikinashi' ? 'heikinashi' : 'none' }, assertCurrent: captured.assertCurrent };
    }
    explain.addEventListener('click', () => {
        if (!selection || disposed || preparing) { status.textContent = 'Click a price candle first.'; return; }
        const selected = { ...selection }, agent = options.agent(); if (!agent) { status.textContent = 'The chart connection is still loading.'; return; }
        let captured: ReturnType<typeof guard>;
        try { captured = guard(selected.cellId); } catch { status.textContent = 'Research is paused while the chart context updates.'; return; }
        options.pause();
        void track(candle.prepare(async owner => {
            captured.assertCurrent(); owner.assertCurrent();
            const target = { clientId: agent.clientId, sessionId: captured.view.session.id, generation: options.generation(), cellId: selected.cellId };
            const report = await wait(agent.execute({ operation: 'read_candle_evidence', target, args: { selectedTime: selected.time }, requestId: crypto.randomUUID(), deadline: Date.now() + 10000 }) as Promise<CandleEvidence>, captured.signal);
            captured.assertCurrent(); owner.assertCurrent();
            const result = snapshots.get(`${report.scope.scopeId}:${selected.time}`); if (!result) throw new Error('The candle callback did not provide the selected snapshot.'); return result;
        })).catch(() => { if (!disposed && !captured.signal.aborted) status.textContent = 'Candle evidence is unavailable. Select the current candle and prepare it again.'; });
    });
    return {
        attach(target) { if (disposed) return; target.append(root); root.hidden = false; synchronize(); loadContext(true); },
        park() { if (disposed) return; root.hidden = true; host.append(root); }, synchronize,
        capture(cellId, event) {
            if (disposed || preparing) return; synchronize();
            if (event.paneKind !== 'price' || !event.ohlc || event.time !== event.ohlc.time) return;
            try {
                const captured = guard(cellId), value = event.ohlc, raw = captured.cell.bars.find(bar => bar.time === value.time);
                if (value.volume === undefined || ![value.open, value.high, value.low, value.close, value.volume].every(Number.isFinite)) return;
                let items = captures.get(cellId); if (!items) { items = new Map(); captures.set(cellId, items); }
                items.set(value.time, { time: value.time, open: value.open, high: value.high, low: value.low, close: value.close, volume: value.volume,
                    ...(raw?.instrumentId === undefined ? {} : { instrumentId: raw.instrumentId, contract: raw.contract }) });
                if (items.size > CANDLE_EVIDENCE_LIMITS.displayedBars) items.delete(items.keys().next().value!);
            } catch { /* A crosshair from a replaced cell cannot become evidence. */ }
        },
        select(cellId, time) {
            if (disposed || preparing || time === null || !Number.isSafeInteger(time)) return; synchronize();
            try { guard(cellId); } catch { return; }
            selection = { cellId, time }; candle.update(null); selectedLabel.textContent = `Selected candle: ${new Date(time).toISOString()}.`; tab(false);
        },
        preemptGhost(originId, followers) {
            const target = previewCellId ?? options.activeCellId();
            if (!target || target !== originId && !followers.includes(target)) return;
            // A follower already received the native ghost before this lifecycle notification.
            clearPreview(target === originId); status.textContent = 'Hypothesis preview yielded to the drawing tool. Preview levels again after finishing the drawing.';
        },
        readCandle(input, owner) {
            synchronize();
            return track((async () => { const value = await snapshot(input, owner); owner.assertCurrent(); value.assertCurrent();
                const report = buildCandleEvidence(value);
                // The request deadline bounds collection; retained UI evidence owns its live chart and scope TTL.
                const retained = { ...value, assertCurrent: guard(input.cellId).assertCurrent };
                snapshots.set(`${value.scope.scopeId}:${value.selectedTime}`, retained);
                if (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!); return report; })());
        },
        propose(input, owner) {
            synchronize();
            return track((async () => {
                const captured = guard(input.cellId, owner), content = parseScenarioContent(input.content), requested = parseScenarioContext(input.context);
                const actual = await currentContext(input.cellId, owner); captured.assertCurrent();
                if (!equal(actual, requested)) throw new Error('Scenario proposal context is stale.');
                const apply = (): boolean => {
                    owner.assertCurrent(); captured.assertCurrent(); notebook.setContext(actual);
                    if (!notebook.propose(content)) return false;
                    readyContext = actual; tab(true); return true;
                };
                const retained = owner.commitDraft ? await owner.commitDraft(apply) : apply();
                if (!retained) throw new Error('The scenario draft was not retained.');
                return { draftOnly: true as const, context: actual };
            })());
        },
        async prepare() {
            if (disposed) return; preparing = true; contextLoad = null; contextFailed = false; controller.abort(); clearPreview(); candle.update(null);
            try { await Promise.allSettled([...tasks]); await notebook.prepare(); }
            finally { preparing = false; controller = new AbortController(); }
        },
        destroy() {
            if (disposed) return; disposed = true; controller.abort(); clearPreview(); captures.clear(); snapshots.clear(); readyContext = null;
            candle.destroy(); notebook.destroy(); root.remove();
        },
    };
}
