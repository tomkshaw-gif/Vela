// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Vela, CrosshairEvent } from '../../src/index';
import type { LocalApi } from '../client/api';
import type { ChartAgentController } from '../client/chart-agent';
import type { SessionView, Bar } from '../shared/types';
import type { AnalysisScopeSummary } from '../shared/chart-analysis';
import { emptyScenarioContent, type ScenarioDocument, type SaveScenarioInput } from '../shared/scenarios';
import { mountResearchWorkbench, type ResearchOwner } from '../client/research-workbench';
const binding = vi.hoisted(() => ({ workspaces: [] as any[], agents: [] as import('../client/chart-agent').ChartAgentControllerOptions[] }));
vi.mock('../client/chart-agent', () => ({ createChartAgentController: (options: import('../client/chart-agent').ChartAgentControllerOptions) => {
    binding.agents.push(options); return { clientId: 'client', dispose: vi.fn(), execute: vi.fn(), requestAnalysis: vi.fn() };
} }));
vi.mock('../client/script-workspace', () => ({ mountScriptWorkspace: () => ({ flush: async () => {}, prepareForUpdate: async () => {}, destroy() {} }) }));
vi.mock('../client/script-persistence', () => ({ enableScriptPersistence: () => () => {} }));
vi.mock('../client/chart-chrome', () => ({ CHART_TOPBAR: { right: [] }, mountChartChrome: () => () => {} }));
vi.mock('../client/reference-chrome', () => ({ mountReferenceChrome: () => () => {} }));
vi.mock('../client/drawing-favorites', () => ({ mountDrawingFavorites: () => () => {} }));
vi.mock('../client/drawing-utilities', () => ({ LOCAL_RANGE_PRESETS: [], mountDrawingUtilities: () => () => {} }));
vi.mock('../client/chart-order-lines', () => ({ bindChartOrderLines: () => () => {}, refreshChartOrderLines() {} }));
vi.mock('../client/chart-appearance', () => ({ CHART_THEME: {}, applyLightPlotAppearance() {}, configureChartAppearance() {}, isDefaultPlotAppearance: () => false, needsPlotAppearanceMigration: () => false, nativeChartConfig: (value: unknown) => value }));
vi.mock('../../src/workspace', async importOriginal => {
    const actual = await importOriginal<typeof import('../../src/workspace')>();
    class Workspace {
        root: HTMLElement; active: any; layout = { id: '1' }; keymap = { activeScope: 'chart', handleKeydown() {} }; sync = { state: () => ({}), get: () => false };
        events = new Map<string, Set<() => void>>();
        constructor(host: HTMLElement) {
            actual.registerBuiltinLayouts(); this.root = host;
            const crosshairs = new Set<(event: CrosshairEvent) => void>(), clicks = new Set<(event: { time: number; paneKind: string; price: number }) => void>(), styles = new Set<() => void>();
            let style = 'candles', ghost: unknown = null; const chartEvents = new Map<string, Set<(value: any) => void>>();
            const chart = { market: { symbol: 'replay:TEST', timeframe: '1' }, registerEngine() {},
                renderer: { get: () => style, set() {}, getConfig: () => ({}), onConfigChanged: (callback: () => void) => { styles.add(callback); return () => styles.delete(callback); },
                    onPriceStyleChange: (callback: () => void) => { styles.add(callback); return () => styles.delete(callback); }, onCrosshairMove: (callback: (event: CrosshairEvent) => void) => { crosshairs.add(callback); return () => crosshairs.delete(callback); },
                    onClick: (callback: (event: { time: number; paneKind: string; price: number }) => void) => { clicks.add(callback); return () => clicks.delete(callback); } },
                marks: { defineGroup() {}, set() {} }, drawings: { toJSON: () => ({ version: 1, drawings: [] }), remove: vi.fn(), add: vi.fn(), setExternalGhost: vi.fn((value: unknown) => { ghost = value; }) },
                setMarket: async (market: { symbol: string; timeframe: string }) => { chart.market = { symbol: market.symbol, timeframe: market.timeframe }; },
                on: (name: string, callback: (value: any) => void) => { const handlers = chartEvents.get(name) ?? new Set(); handlers.add(callback); chartEvents.set(name, handlers); return () => handlers.delete(callback); },
                fire: (name: string, value: unknown) => chartEvents.get(name)?.forEach(callback => callback(value)), ghost: () => ghost,
                hover: (event: CrosshairEvent) => crosshairs.forEach(callback => callback(event)), click: (time: number) => clicks.forEach(callback => callback({ time, price: 100, paneKind: 'price' })),
                style: (value: string) => { chartEvents.get('priceStyle:change')?.forEach(callback => callback({ from: style, to: value })); style = value; styles.forEach(callback => callback()); }, getVisibleRange: () => ({ from: 0, to: 120000 }) };
            this.active = { id: 'cell', chart, setStatuslineAppearance() {}, setExternalReplaying() {} }; binding.workspaces.push(this);
        }
        get chart() { return this.active.chart; }
        context() { return { activeCellId: 'cell', chart: this.chart, host: this.root }; }
        cell(id: string) { return id === 'cell' ? this.active : undefined; } cells() { return [this.active]; }
        applyState() {} getState() { return { version: 1, layout: '1', charts: [{ id: 'cell', symbol: 'replay:TEST', timeframe: '1', drawings: this.chart.drawings.toJSON() }] }; }
        on(name: string, callback: () => void) { const callbacks = this.events.get(name) ?? new Set(); callbacks.add(callback); this.events.set(name, callbacks); return () => callbacks.delete(callback); }
        destroy() {}
    }
    return { ...actual, VelaWorkspace: Workspace, sanitizeState: () => null };
});
const sessionId = '11111111-1111-4111-8111-111111111111', datasetId = '22222222-2222-4222-8222-222222222222';
const bars: Bar[] = [0, 60000, 120000].map((time, index) => ({ time, open: 100 + index, high: 106 + index, low: 98 + index, close: 104 + index, volume: 10 + index }));
const owner = (): ResearchOwner => ({ signal: new AbortController().signal, assertCurrent: vi.fn(), commitDraft: vi.fn(async change => change()) });
const cleanups: (() => void)[] = [];
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function settle() { await new Promise(resolve => setTimeout(resolve, 0)); }
function button(host: HTMLElement, label: string) { const value = [...host.querySelectorAll('button')].find(button => button.textContent === label); expect(value, label).toBeDefined(); return value!; }
function field(host: HTMLElement, label: string) { const value = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`); expect(value, label).not.toBeNull(); return value!; }
function fixture(sourceBars: readonly Bar[] = bars) {
    let style = 'candles', generation = 1, activeCell = 'cell', cutoff = 120000;
    const view = { session: { id: sessionId, cursor: 2, revision: 0, config: { datasetId, startIndex: 0 } }, dataset: { id: datasetId, checksum: 'a'.repeat(64), symbol: 'TEST', schema: 'ohlcv-1m', intervalMs: 60000 } } as SessionView;
    const context = () => ({ sessionId, datasetId, datasetChecksum: view.dataset.checksum, cursor: view.session.cursor, cutoff });
    const records: { id: string }[] = []; let ghost: import('../../src/core/drawings/Drawing').SerializedDrawing | null = null;
    const chart = { market: { symbol: 'replay:TEST', timeframe: '1' }, renderer: { get: () => style }, drawings: {
        add: vi.fn((_type, _init) => { const result = { id: crypto.randomUUID() }; records.push(result); return result; }), remove: vi.fn(id => { const index = records.findIndex(item => item.id === id); if (index >= 0) records.splice(index, 1); }),
        setExternalGhost: vi.fn(value => { ghost = value; }),
    } } as unknown as Vela;
    const get = vi.fn<(path: string, signal?: AbortSignal) => Promise<unknown>>(async path => {
        if (path.includes('/scenarios/context')) return context(); if (path.endsWith('/scenarios')) return [];
        const query = new URL(path, 'http://local').searchParams;
        const at = Number(query.get('cutoff')), from = Number(query.get('from')), to = Number(query.get('to'));
        return { bars: sourceBars.filter(bar => bar.time >= from && bar.time <= to && bar.time <= at), cursorTime: at, baseIntervalMs: 60000, intervalMs: 60000, hasMore: false,
            datasetId, checksum: view.dataset.checksum, sourceDatasets: [{ id: datasetId, checksum: view.dataset.checksum }] };
    });
    const post = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async (_path, raw) => {
        const input = raw as SaveScenarioInput; return { id: '33333333-3333-4333-8333-333333333333', revision: 0, title: input.content.title, content: input.content,
            context: input.context, archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    });
    const flush = vi.fn(async () => {}), pause = vi.fn();
    const host = document.createElement('section'), panel = document.createElement('section'); document.body.append(host, panel);
    const execute = vi.fn(), requestAnalysis = vi.fn<(question: string, args?: Record<string, unknown>, owner?: ResearchOwner) => Promise<unknown>>(async () => ({})); const agent = { clientId: 'client', execute, requestAnalysis } as unknown as ChartAgentController;
    const workbench = mountResearchWorkbench(host, { api: { get, post } as unknown as LocalApi, session: () => view, cursorTime: () => cutoff, generation: () => generation,
        activeCellId: () => activeCell, cell: id => id === 'cell' ? { chart, bars: sourceBars } : null, agent: () => agent, blocked: () => false, pause, flush });
    workbench.attach(panel); workbench.synchronize(); cleanups.push(() => workbench.destroy());
    const scope = (selected = 120000): AnalysisScopeSummary => ({ scopeId: 'scope', target: { clientId: 'client', sessionId, generation, cellId: 'cell' }, createdAt: Date.now(), expiresAt: Date.now() + 290000,
        cursorTime: cutoff, chart: { symbol: 'replay:TEST', timeframe: '1', intervalMs: 60000 }, dataset: { id: datasetId, checksum: view.dataset.checksum, symbol: 'TEST', schema: 'ohlcv-1m', intervalMs: 60000 },
        clock: { sourceCutoff: selected, availableUntil: selected + 60000, sourceIntervalMs: 60000, label: 'Exact historical clock' }, region: { from: 0, to: selected, requestedFrom: 0, requestedTo: selected, clamped: false, origin: 'range' } });
    execute.mockImplementation(async task => {
        if (task.operation === 'capture_analysis_scope') return scope();
        if (Object.keys(task.args).some(key => key !== 'selectedTime')) throw new Error('Unsupported candle evidence argument.');
        return workbench.readCandle({ cellId: 'cell', selectedTime: task.args.selectedTime, scope: scope() }, owner());
    });
    return { workbench, host, panel, view, chart, records, get, post, context, scope, execute, requestAnalysis, flush, pause, ghost: () => ghost,
        style(value: string) { style = value; workbench.synchronize(); }, advance() { view.session.cursor++; view.session.revision++; cutoff += 60000; workbench.synchronize(); },
        switchCell() { activeCell = 'elsewhere'; workbench.synchronize(); }, generation() { generation++; workbench.synchronize(); },
        clock(value: number) { cutoff = value; view.session.cursor = Math.floor(value / 60000); workbench.synchronize(); } };
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('mounted research workbench public behavior', () => {
    it('mounts real notebook controls beside candle evidence and moves the same persistent draft across panel closes', async () => {
        const f = fixture(); await settle(); button(f.panel, 'Scenarios').click(); field(f.panel, 'Notes').value = 'Persistent panel notes'; field(f.panel, 'Notes').dispatchEvent(new Event('input'));
        f.workbench.park(); expect(f.panel.querySelector('[aria-label="Notes"]')).toBeNull(); f.workbench.attach(f.panel); expect(field(f.panel, 'Notes').value).toBe('Persistent panel notes');
        await f.workbench.prepare(); expect(f.post).not.toHaveBeenCalled();
    });
    it('handles an MCP proposal callback as a draft and saves only after the explicit button', async () => {
        const f = fixture(); await settle(); const input = { cellId: 'cell', context: f.context(), content: { ...emptyScenarioContent(), notes: 'AI draft to review' } };
        expect(await f.workbench.propose(input, owner())).toEqual({ draftOnly: true, context: f.context() }); expect(f.post).not.toHaveBeenCalled();
        expect(field(f.panel, 'Notes').value).toBe('AI draft to review'); button(f.panel, 'Save').click(); await settle(); expect(f.post).toHaveBeenCalledTimes(1);
    });
    it('retains prepared evidence and renderer capture when the same ready panel is attached repeatedly', async () => {
        const f = fixture(); await settle(); f.style('heikinashi'); await settle();
        const displayed = { ...bars[2]!, open: 101.25, high: 108.5, low: 100, close: 104.25 };
        f.workbench.capture('cell', { time: 120000, ohlc: displayed, paneKind: 'price', price: 104, values: new Map() }); f.workbench.select('cell', 120000);
        button(f.panel, 'Explain selected candle').click(); await settle(); const evidence = f.panel.querySelector('.candle-evidence-pin'); expect(evidence).not.toBeNull();
        const count = f.get.mock.calls.filter(([path]) => path.endsWith('/scenarios/context')).length;
        f.workbench.park(); f.workbench.attach(f.panel); f.workbench.attach(f.panel); await settle();
        expect(f.panel.querySelector('.candle-evidence-pin')).toBe(evidence); expect(f.get.mock.calls.filter(([path]) => path.endsWith('/scenarios/context'))).toHaveLength(count);
        expect((await f.workbench.readCandle({ cellId: 'cell', selectedTime: 120000, scope: f.scope() }, owner())).displayed).toEqual(displayed);
    });
    it('keeps the local-panel no-gate path and refuses a denied defined gate without a fallback mutation', async () => {
        const f = fixture(); await settle(); const local = owner(); delete local.commitDraft;
        await f.workbench.propose({ cellId: 'cell', context: f.context(), content: { ...emptyScenarioContent(), notes: 'Local panel draft' } }, local);
        const denied = owner(); denied.commitDraft = vi.fn(async () => false);
        await expect(f.workbench.propose({ cellId: 'cell', context: f.context(), content: { ...emptyScenarioContent(), notes: 'Unaccepted proposal' } }, denied)).rejects.toThrow('The scenario draft was not retained.');
        expect(denied.commitDraft).toHaveBeenCalledTimes(1); expect(field(f.panel, 'Notes').value).toBe('Local panel draft'); expect(f.post).not.toHaveBeenCalled();
    });
    it('does not restore retired readiness after a granted local draft is followed immediately by a replay change', async () => {
        const f = fixture(); await settle(); const granted = owner();
        granted.commitDraft = async change => { const retained = change(); f.get.mockRejectedValueOnce(new Error('Synthetic new-context failure')); f.clock(60000); return retained; };
        await f.workbench.propose({ cellId: 'cell', context: f.context(), content: { ...emptyScenarioContent(), notes: 'Prior cursor hypothesis' } }, granted); await settle();
        expect(button(f.panel, 'New').disabled).toBe(true); f.workbench.attach(f.panel); await settle(); expect(button(f.panel, 'New').disabled).toBe(false);
        expect(field(f.panel, 'Notes').value).toBe(''); expect(f.post).not.toHaveBeenCalled(); await f.workbench.prepare();
    });
    it('captures actual Heikin Ashi renderer OHLCV and never substitutes the raw candle', async () => {
        const f = fixture(); await settle(); f.style('heikinashi'); await settle();
        const displayed = { ...bars[2]!, open: 101.25, high: 108.5, low: 100, close: 104.25, volume: 12 };
        f.workbench.capture('cell', { time: 120000, ohlc: displayed, paneKind: 'price', price: 104, values: new Map() }); f.workbench.select('cell', 120000);
        const report = await f.workbench.readCandle({ cellId: 'cell', selectedTime: 120000, scope: f.scope() }, owner());
        expect(report.displayed).toEqual(displayed); expect(report.raw).toEqual(bars[2]); expect(report.scope.chart.symbol).toBe('replay:TEST');
        f.advance(); await expect(f.workbench.readCandle({ cellId: 'cell', selectedTime: 120000, scope: f.scope() }, owner())).rejects.toThrow(/display|capture|select/i);
    });
    it('pins exact native raw queries to an earlier scope cutoff and preserves paired contract identity', async () => {
        const source = bars.map(bar => ({ ...bar, instrumentId: 'synthetic-instrument', contract: 'TESTZ6' }));
        const f = fixture(source); await settle(); const old = f.scope(60000);
        const report = await f.workbench.readCandle({ cellId: 'cell', selectedTime: 60000, scope: old }, owner()); expect(report.raw.time).toBe(60000);
        expect(report.raw.instrumentId).toBe('synthetic-instrument'); expect(report.raw.contract).toBe('TESTZ6');
        const path = f.get.mock.calls.find(([path]) => path.includes('/series?'))![0], query = new URL(path, 'http://local').searchParams;
        expect(query.get('cutoff')).toBe('60000'); expect(query.get('timeframe')).toBe('1m'); expect(query.get('snapshot')).toContain('"revision":0'); expect(Number(query.get('limit'))).toBeLessThanOrEqual(10000);
        expect(report.evidence.flatMap(ref => ref.inputs).every(input => input.bar.time <= 60000)).toBe(true);
    });
    it('bounds an old selection before the loaded scope cutoff without rewriting its clock or reading the later prefix', async () => {
        const f = fixture(); await settle(); const pinned = f.scope(); const report = await f.workbench.readCandle({ cellId: 'cell', selectedTime: 60000, scope: pinned }, owner());
        const path = f.get.mock.calls.find(([path]) => path.includes('/series?'))![0], query = new URL(path, 'http://local').searchParams;
        expect(query.get('cutoff')).toBe('60000'); expect(query.get('to')).toBe('119999'); expect(report.scope).toEqual(pinned); expect(report.scope.clock.sourceCutoff).toBe(120000);
        expect(report.coverage.to).toBe(120000); expect(report.raw.time).toBe(60000); expect(report.evidence.flatMap(ref => ref.inputs).every(input => input.bar.time <= 60000)).toBe(true);
    });
    it('rejects incomplete, mixed-dataset, oversized and mismatched-resolution raw answers', async () => {
        const f = fixture(); await settle(); const reply = { bars, cursorTime: 120000, baseIntervalMs: 60000, hasMore: false, datasetId, checksum: 'a'.repeat(64), sourceDatasets: [{ id: datasetId, checksum: 'a'.repeat(64) }] };
        for (const invalid of [{ hasMore: true }, { baseIntervalMs: 1000 }, { checksum: 'b'.repeat(64) }, { sourceDatasets: [] }, { bars: Array.from({ length: 10001 }, () => bars[0]!) }]) {
            f.get.mockResolvedValueOnce({ ...reply, ...invalid }); await expect(f.workbench.readCandle({ cellId: 'cell', selectedTime: 120000, scope: f.scope() }, owner())).rejects.toThrow();
        }
        expect(f.post).not.toHaveBeenCalled();
    });
    it('rejects a wide candle before any raw read and cancels a pending owner request immediately', async () => {
        const f = fixture(); await settle(); f.chart.market.timeframe = 'M'; f.clock(10001 * 60000); await settle(); const scope = f.scope(10001 * 60000); scope.chart.timeframe = 'M'; scope.chart.intervalMs = null;
        const before = f.get.mock.calls.length; await expect(f.workbench.readCandle({ cellId: 'cell', selectedTime: 0, scope }, owner())).rejects.toThrow(/budget/); expect(f.get.mock.calls.length).toBe(before);
        f.chart.market.timeframe = '1'; f.clock(120000); await settle(); const request = deferred<unknown>(); f.get.mockReturnValueOnce(request.promise); const abort = new AbortController();
        const reading = f.workbench.readCandle({ cellId: 'cell', selectedTime: 120000, scope: f.scope() }, { signal: abort.signal, assertCurrent: vi.fn() }); const rejected = expect(reading).rejects.toThrow(); abort.abort(); await rejected;
        expect(f.get.mock.calls.at(-1)![1]?.aborted).toBe(true);
    });
    it('routes user candle explanation through execute and ownership-checked existing question handoff', async () => {
        const f = fixture(); await settle(); f.workbench.select('cell', 120000); button(f.panel, 'Explain selected candle').click(); await settle();
        expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ operation: 'read_candle_evidence', args: expect.objectContaining({ selectedTime: 120000 }) }));
        expect(f.panel.textContent).toContain('Untransformed candle facts'); button(f.panel, 'Ask connected AI about this candle').click(); await settle();
        expect(f.requestAnalysis).toHaveBeenCalledWith(expect.stringContaining('vela_read_candle_evidence'), expect.objectContaining({ from: 0, to: 120000 }), expect.objectContaining({ assertCurrent: expect.any(Function), signal: expect.anything() })); expect(f.post).not.toHaveBeenCalled();
        expect(f.requestAnalysis.mock.calls[0]![0]).not.toMatch(/with.*scopeId|and the queued scopeId/);
    });
    it('retains chart-owned evidence after its collection request deadline and cancels an Ask when selection changes', async () => {
        const f = fixture(); await settle(); let expired = false;
        f.execute.mockImplementation(task => f.workbench.readCandle({ cellId: 'cell', selectedTime: task.args.selectedTime, scope: f.scope() }, { signal: new AbortController().signal, assertCurrent() { if (expired) throw new Error('Collection deadline expired.'); } }));
        f.workbench.select('cell', 120000); button(f.panel, 'Explain selected candle').click(); await settle(); expired = true;
        const queued = deferred<unknown>(); f.requestAnalysis.mockReturnValueOnce(queued.promise); button(f.panel, 'Ask connected AI about this candle').click(); await settle(); expect(f.requestAnalysis).toHaveBeenCalledTimes(1);
        const ownership = f.requestAnalysis.mock.calls[0]![2] as ResearchOwner; f.workbench.select('cell', 60000); expect(ownership.signal.aborted).toBe(true); expect(() => ownership.assertCurrent()).toThrow(); queued.resolve({}); await settle();
        expect(f.panel.textContent).not.toContain('Candle question prepared for your connected AI.');
    });
    it('rejects stale context replies before proposing and aborts pending work when destroyed', async () => {
        const f = fixture(); await settle(); const late = deferred<unknown>(); f.get.mockReturnValueOnce(late.promise);
        const result = f.workbench.propose({ cellId: 'cell', content: { ...emptyScenarioContent(), notes: 'Stale proposal' }, context: f.context() }, owner()); const rejected = expect(result).rejects.toThrow();
        f.advance(); late.resolve({ ...f.context(), cursor: 2, cutoff: 120000 }); await rejected; expect(f.panel.textContent).not.toContain('Stale proposal');
        const pending = deferred<unknown>(); f.get.mockReturnValueOnce(pending.promise); const reading = f.workbench.readCandle({ cellId: 'cell', selectedTime: 120000, scope: f.scope() }, owner()); const cancelled = expect(reading).rejects.toThrow();
        f.workbench.destroy(); await cancelled;
    });
    it('drains explicit notebook saves and blocks the desktop barrier on a save failure', async () => {
        const f = fixture(); await settle(); await f.workbench.propose({ cellId: 'cell', context: f.context(), content: { ...emptyScenarioContent(), notes: 'Retain me' } }, owner());
        const pending = deferred<ScenarioDocument>(); f.post.mockReturnValueOnce(pending.promise); button(f.panel, 'Save').click(); let done = false; const ready = f.workbench.prepare().then(() => { done = true; }); const rejected = expect(ready).rejects.toThrow();
        await settle(); expect(done).toBe(false); pending.reject(new Error('Synthetic failure')); await rejected; expect(field(f.panel, 'Notes').value).toBe('Retain me');
    });
    it('previews explicit selectable hypothesis ghosts without adding persisted drawings', async () => {
        const f = fixture(); await settle(); const content = emptyScenarioContent(); content.bull.triggerPrice = 150; content.bear.invalidationPrice = 160;
        await f.workbench.propose({ cellId: 'cell', context: f.context(), content }, owner()); expect(f.chart.drawings.add).not.toHaveBeenCalled(); button(f.panel, 'Preview levels').click(); await settle();
        expect(f.chart.drawings.add).not.toHaveBeenCalled(); expect(f.chart.drawings.setExternalGhost).toHaveBeenCalledTimes(1); expect(f.ghost()?.anchors[0]!.price).toBe(150); expect(f.flush).toHaveBeenCalled();
        button(f.panel, 'Bear hypothesis: invalidation · 160').click(); await settle(); expect(f.ghost()?.anchors[0]!.price).toBe(160);
        f.advance(); expect(f.ghost()).toBeNull(); expect(f.chart.drawings.remove).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
    });
    it('yields to a newer linked native ghost and never clears or reasserts over it after context change or stale clicks', async () => {
        const f = fixture(); await settle(); const content = emptyScenarioContent(); content.bull.triggerPrice = 150;
        await f.workbench.propose({ cellId: 'cell', context: f.context(), content }, owner()); button(f.panel, 'Preview levels').click(); await settle();
        const oldButton = button(f.panel, 'Bull hypothesis: trigger · 150'), native = { ...f.ghost()!, id: 'native-user-ghost', text: { ...f.ghost()!.text!, value: 'Native drawing draft' } };
        f.chart.drawings.setExternalGhost(native); f.workbench.preemptGhost('peer', ['cell']); expect(f.ghost()).toEqual(native); expect(oldButton.isConnected).toBe(false);
        f.advance(); oldButton.click(); await settle(); f.workbench.destroy(); expect(f.ghost()).toEqual(native);
    });
    it('rejects time-remapped chart styles without fetching or fabricating displayed data', async () => {
        const f = fixture(); await settle(); f.style('renko'); await settle(); const before = f.get.mock.calls.length;
        await expect(f.workbench.readCandle({ cellId: 'cell', selectedTime: 120000, scope: f.scope() }, owner())).rejects.toThrow(); expect(f.get.mock.calls.length).toBe(before);
    });
});

async function publicDrawings() {
    const { DrawingController } = await import('../../src/core/drawings/DrawingController'), { DrawingsControl } = await import('../../src/core/DrawingsControl'), { TypedEventBus } = await import('../../src/core/events/EventBus');
    let ghost: import('../../src/core/drawings/Drawing').SerializedDrawing | null = null, rendered: readonly import('../../src/core/drawings/Drawing').SerializedDrawing[] = [], intent: (value: import('../../src/core/drawings/port').DrawingIntent) => void = () => {};
    const port = { setToolbar() {}, showToolbar() {}, setActiveTool() {}, setSelection() {},
        syncDrawings(docs: typeof rendered) { rendered = docs; }, setExternalGhost(doc: typeof ghost) { ghost = doc; },
        onDrawingIntent(callback: typeof intent) { intent = callback; return () => {}; } };
    const controller = new DrawingController({ capabilities: { userDrawings: true }, userDrawingsPort: port } as any, new TypedEventBus(), undefined);
    cleanups.push(() => controller.destroy());
    return { api: new DrawingsControl(controller), ghost: () => ghost, rendered: () => rendered, fire: (value: Parameters<typeof intent>[0]) => intent(value) };
}
describe('actual public drawing history and settings seam', () => {
    it('cannot resurrect retired hypothesis previews through native undo/redo or clipboard while retaining user history', async () => {
        const f = fixture(); await settle(); const drawings = await publicDrawings(); Object.assign(f.chart, { drawings: drawings.api });
        const user = drawings.api.add('hline', { anchors: [{ time: 0, price: 90 }] })!; drawings.api.update(user.id, { anchors: [{ time: 0, price: 95 }] }); drawings.api.copyToClipboard([user.id]);
        const content = emptyScenarioContent(); content.bull.triggerPrice = 150; await f.workbench.propose({ cellId: 'cell', context: f.context(), content }, owner()); button(f.panel, 'Preview levels').click(); await settle();
        const preview = drawings.ghost() ?? drawings.api.all().find(doc => doc.text?.value.includes('hypothesis'))!; expect(preview).toBeDefined(); drawings.api.copyToClipboard([preview.id]);
        expect(JSON.stringify(drawings.api.toJSON())).not.toContain('scenario-preview-');
        f.advance(); drawings.api.undo();
        expect(drawings.api.all().some(doc => doc.text?.value.includes('hypothesis'))).toBe(false); expect(drawings.api.all().find(doc => doc.id === user.id)!.anchors[0]!.price).toBe(90);
        drawings.api.redo(); expect(drawings.api.all().find(doc => doc.id === user.id)!.anchors[0]!.price).toBe(95); drawings.api.paste();
        expect(drawings.api.all().some(doc => doc.text?.value.includes('hypothesis'))).toBe(false); expect(drawings.rendered().some(doc => doc.text?.value.includes('hypothesis'))).toBe(false); expect(drawings.ghost()).toBeNull();
    });
    it('does not let native settings Points/Text edits change a preview independently of the notebook', async () => {
        const f = fixture(); await settle(); const drawings = await publicDrawings(); Object.assign(f.chart, { drawings: drawings.api }); const content = emptyScenarioContent(); content.bull.triggerPrice = 150;
        const user = drawings.api.add('hline', { anchors: [{ time: 0, price: 90 }] })!, userDoc = drawings.api.all().find(doc => doc.id === user.id)!;
        drawings.fire({ kind: 'edit', doc: { ...userDoc, anchors: [{ time: 0, price: 95 }], text: { value: 'User settings', size: 'normal', hAlign: 'left', vAlign: 'top' } } });
        expect(drawings.api.all().find(doc => doc.id === user.id)!.anchors[0]!.price).toBe(95);
        await f.workbench.propose({ cellId: 'cell', context: f.context(), content }, owner()); button(f.panel, 'Preview levels').click(); await settle();
        const preview = drawings.ghost() ?? drawings.api.all().find(doc => doc.text?.value.includes('hypothesis'))!; expect(preview).toBeDefined();
        drawings.fire({ kind: 'edit', doc: { ...preview, anchors: [{ time: 0, price: 999 }], text: { ...preview.text!, value: 'Changed from native settings' } } });
        expect(drawings.api.all().some(doc => doc.id === preview.id)).toBe(false); expect(drawings.ghost()?.anchors[0]!.price).toBe(150); expect(drawings.ghost()?.text?.value).toContain('hypothesis'); expect(field(f.panel, 'Bull trigger price').value).toBe('150');
    });
});

async function mountedCharts(initiallyBlocked = false, initialContext?: Promise<unknown>) {
    let blocked = initiallyBlocked, firstContext = initialContext;
    const { ReplayCharts } = await import('../client/charts'), { sidePanels } = await import('../../src/plugin'), { createSession } = await import('../engine/index'), { DEFAULT_RULES } = await import('../shared/types');
    const instrument = { root: 'NQ', tickSize: .25, pointValue: 20 }, session = createSession({ name: 'Research binding', datasetId, mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, spreadTicks: 0, slippageTicks: 0, startIndex: 0, rules: DEFAULT_RULES }, instrument, sessionId);
    session.cursor = 2;
    const view: SessionView = { session, dataset: { id: datasetId, name: 'Synthetic', symbol: 'TEST', schema: 'ohlcv-1m', intervalMs: 60000, barCount: 100, start: 0, end: 6000000, source: 'demo', checksum: 'a'.repeat(64), createdAt: new Date().toISOString(), instrument } };
    const context = { sessionId, datasetId, datasetChecksum: view.dataset.checksum, cursor: 2, cutoff: 120000 };
    const get = vi.fn(async (path: string) => {
        if (path.endsWith('/scenarios/context')) { const pending = firstContext; firstContext = undefined; return pending ?? context; } if (path.endsWith('/scenarios')) return [];
        const query = new URL(path, 'http://local').searchParams, cutoff = query.has('cutoff') ? Number(query.get('cutoff')) : 120000;
        return { bars: bars.filter(bar => bar.time <= cutoff && (!query.has('from') || bar.time >= Number(query.get('from'))) && (!query.has('to') || bar.time <= Number(query.get('to')))),
            cursorTime: cutoff, hasMore: false, timeframe: '1m', intervalMs: 60000, baseIntervalMs: 60000,
            datasetId, checksum: view.dataset.checksum, sourceDatasets: [{ id: datasetId, checksum: view.dataset.checksum }] };
    });
    const post = vi.fn(async (_path: string, body: unknown) => { const input = body as SaveScenarioInput; return { id: '33333333-3333-4333-8333-333333333333', revision: 0, context: input.context, content: input.content, title: input.content.title, archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; });
    const host = document.createElement('section'), panel = document.createElement('section'); document.body.append(host); host.append(panel);
    const controller = new ReplayCharts(host, { get, post } as unknown as LocalApi, async () => {}, vi.fn(), vi.fn(), vi.fn(), () => blocked); await controller.mount(view); cleanups.push(() => controller.destroy());
    const workspace = binding.workspaces.at(-1)!, options = binding.agents.at(-1)!;
    const sidePanel = sidePanels().find(item => item.id === 'local.assistant')!; const handle = initiallyBlocked ? undefined : sidePanel.mount(workspace.context(), panel, {} as any); cleanups.push(() => handle?.destroy?.()); await settle();
    const open = async () => { const next = sidePanel.mount(workspace.context(), panel, {} as any); cleanups.push(() => next?.destroy?.()); await settle(); return next; };
    return { controller, workspace, options, host, panel, view, context, get, post, handle, sidePanel, open, setBlocked(value: boolean) { blocked = value; } };
}
describe('ReplayCharts research bindings', () => {
    it('recovers blocked startup on the public assistant mount with unchanged replay identity', async () => {
        const f = await mountedCharts(true), before = JSON.stringify(f.view);
        expect(f.options.blocked()).toBe(true); expect(f.get.mock.calls.filter(([path]) => path.endsWith('/scenarios/context'))).toHaveLength(0);
        await f.open(); button(f.panel, 'Scenarios').click(); await settle(); expect(button(f.panel, 'New').disabled).toBe(true);
        f.setBlocked(false); await f.open(); button(f.panel, 'Scenarios').click(); await settle();
        expect(JSON.stringify(f.view)).toBe(before); expect(button(f.panel, 'New').disabled).toBe(false);
        expect(f.get.mock.calls.filter(([path]) => path.endsWith('/scenarios/context'))).toHaveLength(1); expect(f.post).not.toHaveBeenCalled();
    }, 15000);
    it('enables an initially unblocked notebook through the same public assistant entry', async () => {
        const f = await mountedCharts(); button(f.panel, 'Scenarios').click(); await settle();
        expect(button(f.panel, 'New').disabled).toBe(false); expect(f.get.mock.calls.filter(([path]) => path.endsWith('/scenarios/context'))).toHaveLength(1); expect(f.post).not.toHaveBeenCalled();
    });
    it('retries a delayed context failure on reopen and preserves ready dirty drafts without refetching', async () => {
        const first = deferred<unknown>(), f = await mountedCharts(false, first.promise);
        expect(button(f.panel, 'New').disabled).toBe(true); await f.open();
        expect(f.get.mock.calls.filter(([path]) => path.endsWith('/scenarios/context'))).toHaveLength(1);
        first.reject(new Error('Synthetic delayed context failure')); await settle();
        f.controller.updateMarkers(f.view); await settle(); expect(f.get.mock.calls.filter(([path]) => path.endsWith('/scenarios/context'))).toHaveLength(1);
        await f.open(); button(f.panel, 'Scenarios').click(); await settle(); expect(button(f.panel, 'New').disabled).toBe(false);
        field(f.panel, 'Notes').value = 'Keep my startup recovery draft'; field(f.panel, 'Notes').dispatchEvent(new Event('input'));
        await f.open(); button(f.panel, 'Scenarios').click(); await settle();
        expect(field(f.panel, 'Notes').value).toBe('Keep my startup recovery draft'); expect(f.get.mock.calls.filter(([path]) => path.endsWith('/scenarios/context'))).toHaveLength(2); expect(f.post).not.toHaveBeenCalled();
    });
    it('does not accept a startup context that completes during the desktop preparation barrier', async () => {
        const first = deferred<unknown>(), f = await mountedCharts(false, first.promise); f.setBlocked(true);
        await f.controller.prepareForUpdate(false); first.resolve(f.context); await settle(); await f.open();
        expect(button(f.panel, 'New').disabled).toBe(true); expect(f.get.mock.calls.filter(([path]) => path.endsWith('/scenarios/context'))).toHaveLength(1);
        f.setBlocked(false); await f.open(); await settle(); expect(button(f.panel, 'New').disabled).toBe(false); expect(f.post).not.toHaveBeenCalled();
    });
    it('recovers a style change during an actual native market write and preserves draft and HA capture across reopen', async () => {
        const f = await mountedCharts(), write = deferred<void>(), chart = f.workspace.chart, nativeSetMarket = chart.setMarket;
        field(f.panel, 'Notes').value = 'Keep notes through style write'; field(f.panel, 'Notes').dispatchEvent(new Event('input'));
        vi.spyOn(chart, 'setMarket').mockImplementationOnce(async (market: unknown) => { await nativeSetMarket(market); await write.promise; });
        const writing = f.controller.setTimeframe('1'); await settle(); chart.style('heikinashi'); await settle(); await f.open();
        expect(button(f.panel, 'New').disabled).toBe(true); expect(f.get.mock.calls.filter(([path]) => path.endsWith('/scenarios/context'))).toHaveLength(1);
        write.resolve(); await writing; await f.open(); button(f.panel, 'Scenarios').click(); await settle(); expect(button(f.panel, 'New').disabled).toBe(false);
        expect(field(f.panel, 'Notes').value).toBe('Keep notes through style write');
        const displayed = { ...bars[2]!, open: 101.25, low: 100, high: 108.5, close: 104.25 };
        chart.hover({ time: 120000, price: 104, paneKind: 'price', ohlc: displayed, values: new Map() }); chart.click(120000);
        const count = f.get.mock.calls.filter(([path]) => path.endsWith('/scenarios/context')).length; await f.open(); await f.open();
        const scope: AnalysisScopeSummary = { scopeId: 'ready-ha-scope', target: { clientId: 'client', sessionId, generation: f.options.generation(), cellId: 'cell' }, createdAt: Date.now(), expiresAt: Date.now() + 290000,
            cursorTime: 120000, clock: { sourceCutoff: 120000, availableUntil: 180000, sourceIntervalMs: 60000, label: 'Clock' }, chart: { symbol: 'replay:TEST', timeframe: '1', intervalMs: 60000 },
            dataset: { id: datasetId, checksum: f.view.dataset.checksum, symbol: 'TEST', schema: 'ohlcv-1m', intervalMs: 60000 }, region: { from: 0, to: 120000, requestedFrom: 0, requestedTo: 120000, clamped: false, origin: 'range' } };
        expect((await f.options.candleEvidence!({ cellId: 'cell', selectedTime: 120000, scope }, owner())).displayed).toEqual(displayed);
        expect(field(f.panel, 'Notes').value).toBe('Keep notes through style write'); expect(f.get.mock.calls.filter(([path]) => path.endsWith('/scenarios/context'))).toHaveLength(count); expect(f.post).not.toHaveBeenCalled();
    });
    it('waits for the proposal draft grant after context loading and mutates only inside that grant', async () => {
        const f = await mountedCharts(), grant = deferred<void>(), granted = owner(); let apply!: () => boolean;
        granted.commitDraft = vi.fn(async change => { apply = change; await grant.promise; return change(); });
        const result = f.options.proposeScenario!({ cellId: 'cell', context: f.context, content: { ...emptyScenarioContent(), notes: 'Granted MCP draft' } }, granted);
        await settle(); expect(granted.commitDraft).toHaveBeenCalledTimes(1); expect(apply).toBeTypeOf('function'); expect(field(f.panel, 'Notes').value).not.toBe('Granted MCP draft'); expect(f.post).not.toHaveBeenCalled();
        grant.resolve(); expect(await result).toEqual({ draftOnly: true, context: f.context }); expect(field(f.panel, 'Notes').value).toBe('Granted MCP draft'); expect(f.post).not.toHaveBeenCalled();
        button(f.panel, 'Save').click(); await settle(); expect(f.post).toHaveBeenCalledTimes(1);
    });
    it('preserves a local draft when cancellation denies commit and does not retry the rejected gate', async () => {
        const f = await mountedCharts(), gate = deferred<void>(), abort = new AbortController(), granted = owner();
        field(f.panel, 'Notes').value = 'Existing local notes'; field(f.panel, 'Notes').dispatchEvent(new Event('input'));
        granted.signal = abort.signal; granted.assertCurrent = () => abort.signal.throwIfAborted();
        granted.commitDraft = vi.fn(async change => { await gate.promise; abort.signal.throwIfAborted(); return change(); });
        const result = f.options.proposeScenario!({ cellId: 'cell', context: f.context, content: { ...emptyScenarioContent(), notes: 'Cancelled draft' } }, granted).then(() => null, error => error);
        await settle(); abort.abort(); gate.resolve(); expect(await result).toBeInstanceOf(Error);
        expect(field(f.panel, 'Notes').value).toBe('Existing local notes'); expect(granted.commitDraft).toHaveBeenCalledTimes(1); expect(f.post).not.toHaveBeenCalled();
    });
    it('rechecks local replay ownership inside the synchronous granted draft closure', async () => {
        const f = await mountedCharts(), gate = deferred<void>(), granted = owner(); granted.commitDraft = vi.fn(async change => { await gate.promise; return change(); });
        const result = f.options.proposeScenario!({ cellId: 'cell', context: f.context, content: { ...emptyScenarioContent(), notes: 'Retired replay draft' } }, granted).then(() => null, error => error);
        await settle(); f.controller.updateMarkers({ ...f.view, session: { ...f.view.session, revision: 1 } }); gate.resolve(); expect(await result).toBeInstanceOf(Error);
        expect(granted.commitDraft).toHaveBeenCalledTimes(1); expect(f.panel.textContent).not.toContain('Retired replay draft'); expect(f.post).not.toHaveBeenCalled();
    });
    it('binds the real sidepanel and controller proposal callback to an explicit notebook save', async () => {
        const f = await mountedCharts(); expect(f.options.proposeScenario).toBeTypeOf('function'); expect(f.options.candleEvidence).toBeTypeOf('function');
        expect(await f.options.proposeScenario!({ cellId: 'cell', context: f.context, content: { ...emptyScenarioContent(), notes: 'MCP proposal' } }, owner())).toEqual({ draftOnly: true, context: f.context });
        expect(field(f.panel, 'Notes').value).toBe('MCP proposal'); expect(f.post).not.toHaveBeenCalled(); button(f.panel, 'Save').click(); await settle(); expect(f.post).toHaveBeenCalledTimes(1);
    }, 15000);
    it('captures the real renderer public crosshair/click values and clears them after style changes', async () => {
        const f = await mountedCharts(); f.workspace.chart.style('heikinashi'); await settle();
        const displayed = { ...bars[2]!, open: 101.25, low: 100, high: 108.5, close: 104.25 };
        f.workspace.chart.hover({ time: 120000, price: 104, paneKind: 'price', ohlc: displayed, values: new Map() }); f.workspace.chart.click(120000);
        const scope: AnalysisScopeSummary = { scopeId: 'binding-scope', target: { clientId: 'client', sessionId, generation: f.options.generation(), cellId: 'cell' }, createdAt: Date.now(), expiresAt: Date.now() + 290000,
            cursorTime: 120000, clock: { sourceCutoff: 120000, availableUntil: 180000, sourceIntervalMs: 60000, label: 'Clock' }, chart: { symbol: 'replay:TEST', timeframe: '1', intervalMs: 60000 },
            dataset: { id: datasetId, checksum: f.view.dataset.checksum, symbol: 'TEST', schema: 'ohlcv-1m', intervalMs: 60000 }, region: { from: 0, to: 120000, requestedFrom: 0, requestedTo: 120000, clamped: false, origin: 'range' } };
        expect((await f.options.candleEvidence!({ cellId: 'cell', selectedTime: 120000, scope }, owner())).displayed).toEqual(displayed);
        f.workspace.chart.style('candles'); f.workspace.chart.style('heikinashi');
        await expect(f.options.candleEvidence!({ cellId: 'cell', selectedTime: 120000, scope }, owner())).rejects.toThrow(/capture|display|select/i);
    });
    it('preserves the notebook across actual sidepanel destruction/remount and drains saves through the chart update barrier', async () => {
        const f = await mountedCharts(); await f.options.proposeScenario!({ cellId: 'cell', context: f.context, content: { ...emptyScenarioContent(), notes: 'Retained across sidebar' } }, owner());
        f.handle?.destroy?.(); expect(f.panel.querySelector('[aria-label="Notes"]')).toBeNull(); const next = f.sidePanel.mount(f.workspace.context(), f.panel, {} as any); cleanups.push(() => next?.destroy?.()); await settle();
        expect(field(f.panel, 'Notes').value).toBe('Retained across sidebar'); const pending = deferred<any>(); f.post.mockReturnValueOnce(pending.promise); button(f.panel, 'Save').click();
        let acknowledged = false; const preparation = f.controller.prepareForUpdate(false).then(() => { acknowledged = true; }); const rejected = expect(preparation).rejects.toThrow(); await settle(); expect(acknowledged).toBe(false);
        pending.reject(new Error('Synthetic scenario save failure')); await rejected; expect(acknowledged).toBe(false); expect(field(f.panel, 'Notes').value).toBe('Retained across sidebar');
    });
    it('binds native drawing lifecycle preemption without reasserting or clearing the newer ghost later', async () => {
        const f = await mountedCharts(), content = emptyScenarioContent(); content.bull.triggerPrice = 150;
        await f.options.proposeScenario!({ cellId: 'cell', context: f.context, content }, owner()); button(f.panel, 'Preview levels').click(); await settle(); expect(f.workspace.chart.ghost()).toBeTruthy();
        f.workspace.chart.fire('drawing:tool', { type: 'hline' }); expect(f.workspace.chart.ghost()).toBeNull();
        const native = { id: 'native-user-ghost' }; f.workspace.chart.drawings.setExternalGhost(native);
        f.controller.updateMarkers({ ...f.view, session: { ...f.view.session, revision: 1 } }); expect(f.workspace.chart.ghost()).toEqual(native);
    });
});
