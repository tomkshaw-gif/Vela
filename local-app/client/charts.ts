import { VelaWorkspace, sanitizeState, ensureLayout, syncTargets, type ChartCell, type WorkspaceState } from '../../src/workspace';
import type { Vela, BarRange, SymbolInfo, OHLCV } from '../../src/index';
import { iconMarkup, registerIcon, registerSidePanel, registerWidgetAction, registerWidgetAttachment, type WidgetContext } from '../../src/plugin';
import type { Bar, ChartView, SessionView } from '../shared/types';
import { LocalApi } from './api';
import { replaySnapshot, revealedWindow, serverTimeframe } from './chart-data';
import { sessionMarks } from './markers';
import { bindChartOrderLines, refreshChartOrderLines } from './chart-order-lines';
import type { TicketPriceSelection } from './trade-ticket';
import { blocksNativeMarketTyping } from './util';
import { mountDrawingFavorites } from './drawing-favorites';
import drawingIcons from 'virtual:local-drawing-icons';
import { CHART_THEME, applyLightPlotAppearance, configureChartAppearance, isDefaultPlotAppearance, needsPlotAppearanceMigration, nativeChartConfig } from './chart-appearance';
import { createChartAgentController, type ChartAgentController } from './chart-agent';
import { mountAiConnection, type AnalysisQuestion } from './ai-connection';
import { createAppAgentContext } from './app-agent-context';
import { ChartTemplateStore } from './chart-templates';
import { CHART_TOPBAR, mountChartChrome } from './chart-chrome';
import { timeframeSupported } from '../shared/timeframes';
import { replaySymbolInfo } from '../shared/symbol-info';
import { enableScriptPersistence } from './script-persistence';
import type { LocalPineEngine } from '../scripting/pine-runtime';
import { mountReferenceChrome } from './reference-chrome';
import './reference-chrome.css';
import { mountScriptWorkspace, type ScriptWorkspace } from './script-workspace';
import { mountChartTemplates } from './chart-templates';
import './chart-templates.css';
import { mountChartHeader, needsDesktopChromeMigration, withDesktopTimeframeFavorites, type LayoutSaveState } from './chart-header';
import { mountCachedWatchlist, type CachedWatchlist } from './cached-watchlist';
import { LOCAL_RANGE_PRESETS, mountDrawingUtilities } from './drawing-utilities';
import { queueFreshCellAppearance } from './chart-cell-appearance';
import { createChartQuoteBar } from './chart-quote-bar';
import './chart-quote-bar.css';
import { mountDesktopUpdates } from './desktop-updates';
import { mountResearchWorkbench, type ResearchWorkbench } from './research-workbench';

export { nativeChartConfig } from './chart-appearance';

const TIMEFRAMES = new Set(['1S', '5S', '15S', '30S', '1', '2', '3', '5', '10', '15', '30', '60', '240', 'D', 'W', 'M']);
const validLayout = (value: string): boolean => !!ensureLayout(value);

function chromeEvent(ctx: WidgetContext, kind: string, target?: HTMLElement): void {
    ctx.host.dispatchEvent(new CustomEvent('local-replay:chrome', { bubbles: true, detail: { kind, target } }));
}

registerIcon('local-sessions', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>');
registerIcon('local-trade', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 3v18M3 7l4-4 4 4M17 21V3M13 17l4 4 4-4"/></svg>');
registerIcon('local-assistant', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/></svg>');
registerWidgetAction({ id: 'local.sessions', target: 'topbar', label: 'Sessions & results', icon: 'local-sessions', iconOnly: true,
    run: (ctx) => chromeEvent(ctx, 'sessions') });
registerWidgetAction({ id: 'local.chart-mode', target: 'topbar', label: 'Chart', run: (ctx) => chromeEvent(ctx, 'chart') });
registerWidgetAction({ id: 'local.backtest-mode', target: 'topbar', label: 'Backtesting', run: (ctx) => chromeEvent(ctx, 'backtest') });
registerWidgetAttachment({ id: 'local.replay', mount: (ctx) => {
    const strip = ctx.host.ownerDocument.createElement('div'); strip.className = 'local-replay-strip';
    const undock = ctx.dockStrip(strip);
    chromeEvent(ctx, 'replay-mount', strip);
    return () => { chromeEvent(ctx, 'replay-unmount'); undock(); };
} });
registerWidgetAttachment({ id: 'local.desktop-updates', mount: (ctx) => {
    if (!window.velaDesktop?.getUpdateState) return () => {};
    const strip = ctx.host.ownerDocument.createElement('div');
    const dispose = mountDesktopUpdates(strip, window.velaDesktop, true);
    const undock = ctx.dockStrip(strip);
    return () => { dispose(); undock(); };
} });
registerSidePanel({ id: 'local.trade', title: 'Trade', icon: 'local-trade', width: 300, resizable: true,
    mount: (ctx, body, header) => {
        header.setTitle('');
        const heading = body.ownerDocument.createElement('div');
        heading.className = 'local-ticket-heading';
        const replayIcon = body.ownerDocument.createElement('span');
        replayIcon.className = 'local-ticket-replay-icon'; replayIcon.setAttribute('aria-hidden', 'true');
        replayIcon.innerHTML = iconMarkup('replay') ?? '';
        const symbol = body.ownerDocument.createElement('span');
        const refreshSymbol = (value: string): void => { symbol.textContent = value.replace(/^replay:/, '') || 'Order'; };
        refreshSymbol(ctx.symbol);
        heading.append(replayIcon, symbol); header.slot.append(heading);
        body.classList.add('local-trade-panel');
        queueMicrotask(() => { if (ctx.host.isConnected) chromeEvent(ctx, 'trade-mount', body); });
        let off = (): void => {};
        return { onChart: (chart) => {
            off(); refreshSymbol(ctx.symbol);
            off = chart.on('load:start', (market) => refreshSymbol(market.symbol));
        }, destroy: () => { off(); heading.remove(); chromeEvent(ctx, 'trade-unmount'); } };
    } });
registerSidePanel({ id: 'local.assistant', title: 'AI connection', icon: 'local-assistant', width: 480, resizable: true,
    mount: (ctx, body) => {
        body.classList.add('local-ai-panel');
        const destroy = mountAiConnection(body, (value) => new Promise((resolve, reject) => {
            ctx.host.dispatchEvent(new CustomEvent('local-replay:ask-ai', { bubbles: true, detail: { value, resolve, reject } }));
        }));
        queueMicrotask(() => { if (ctx.host.isConnected) chromeEvent(ctx, 'assistant-mount', body); });
        return { destroy: () => { chromeEvent(ctx, 'assistant-unmount'); destroy(); } };
    } });
if (!iconMarkup('local-templates')) registerIcon('local-templates', '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m14 3 11 6-11 6L3 9Zm-11 11 11 6 11-6M3 19l11 6 11-6"/></svg>');
registerSidePanel({ id: 'local.templates', title: 'Templates', icon: 'local-templates', width: 330, resizable: true,
    mount: (ctx, body) => {
        queueMicrotask(() => { if (ctx.host.isConnected) chromeEvent(ctx, 'templates-mount', body); });
        return { destroy: () => chromeEvent(ctx, 'templates-unmount') };
    } });
registerIcon('local-watchlist', '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M6 4h16v20l-8-5-8 5Z"/><path d="M10 9h8M10 13h8"/></svg>');
registerSidePanel({ id: 'local.watchlist', title: 'Cached watchlist', icon: 'local-watchlist', order: -10, width: 300, resizable: true,
    mount: (ctx, body) => {
        queueMicrotask(() => { if (ctx.host.isConnected) chromeEvent(ctx, 'watchlist-mount', body); });
        return { onOpen: () => body.dispatchEvent(new Event('local-watchlist:refresh')),
            destroy: () => chromeEvent(ctx, 'watchlist-unmount') };
    } });

export class ReplayCharts {
    private workspace: VelaWorkspace | null = null;
    private bars = new Map<string, Bar[]>();
    private generation = 0;
    private controller = new AbortController();
    private disposers: (() => void)[] = [];
    private saveTimer: ReturnType<typeof setTimeout> | undefined;
    private lastSaved = '';
    private restoring = false;
    private view: SessionView | null = null;
    private dataView: SessionView | null = null;
    private syncPromise = Promise.resolve();
    private savePromise = Promise.resolve();
    private persistenceSuspended = false;
    private writing = new Map<Vela, { symbol: string; timeframe: string }>();
    private cellWatches = new Map<string, { chart: Vela; off: () => void; refreshQuote: () => void }>();
    private appearanceKnownCells = new Set<string>();
    private appearanceGeneration = 0;
    private pineEngines = new Map<Vela, LocalPineEngine>();
    private pineFactory: ((chart: Vela) => LocalPineEngine) | null = null;
    private scriptWorkspace: ScriptWorkspace | null = null;
    private research: ResearchWorkbench | null = null;
    private researchPreparing = false;
    private validTimeframes = new Map<string, string>();
    private ticketPreview: TicketPriceSelection | null = null;
    private ticketPicking: 'limit' | 'stop' | null = null;
    private ticketQuantity = 1;
    lastPrice: number | null = null;
    cursorTime: number | null = null;

    constructor(private host: HTMLElement, private api: LocalApi, private onLayout: (state: WorkspaceState) => Promise<void>,
        private onError: (error: unknown) => void, private onActive: (timeframe: string) => void,
        private onPrice: (price: number | null, cursorTime: number | null) => void,
        private isAgentBlocked: () => boolean = () => false,
        private isTradingBlocked: () => boolean = isAgentBlocked) {}

    async mount(view: SessionView, options: { mode?: 'chart' | 'backtest' } = {}): Promise<void> {
        this.destroy();
        this.controller = new AbortController();
        this.view = view;
        this.ticketPreview = null; this.ticketPicking = null;
        this.ticketQuantity = 1;
        if (typeof document !== 'undefined') {
            const preview = (event: Event): void => {
                const detail = (event as CustomEvent<TicketPriceSelection>).detail;
                if (!detail || !['buy', 'sell'].includes(detail.side) || !['market', 'limit', 'stop'].includes(detail.type)) return;
                this.ticketPreview = detail.price === null || Number.isFinite(detail.price) && detail.price > 0 ? detail : null;
                refreshChartOrderLines(this.host);
            };
            const pick = (event: Event): void => {
                const detail = (event as CustomEvent<{ active: boolean; type: 'limit' | 'stop' }>).detail;
                this.ticketPicking = detail?.active && (detail.type === 'limit' || detail.type === 'stop') ? detail.type : null;
            };
            const quantity = (event: Event): void => {
                const detail = (event as CustomEvent<{ quantity: number }>).detail;
                if (!detail || !Number.isInteger(detail.quantity) || detail.quantity < 1 || detail.quantity > (this.view?.session.config.rules.maxContracts ?? 1000)) return;
                this.setTicketQuantity(detail.quantity);
            };
            document.addEventListener('local-replay:ticket-price', preview);
            document.addEventListener('local-replay:ticket-pick', pick);
            document.addEventListener('local-replay:ticket-quantity', quantity);
            this.disposers.push(() => document.removeEventListener('local-replay:ticket-price', preview), () => document.removeEventListener('local-replay:ticket-pick', pick));
            this.disposers.push(() => document.removeEventListener('local-replay:ticket-quantity', quantity));
        }
        this.restoring = true;
        const { LocalPineEngine } = await import('../scripting/pine-runtime');
        this.pineFactory = () => new LocalPineEngine({ workerUrl: '/local-pine-worker.js',
            cutoff: () => this.cursorTime,
            fetchSeriesAt: (symbol, timeframe, range, cutoff, signal) => this.fetchSeries(symbol, timeframe, range, cutoff, signal),
        });
        this.disposers.push(enableScriptPersistence((chart) => this.ensurePineEngine(chart)));
        let templates: ReturnType<typeof mountChartTemplates> | undefined;
        let watchlist: CachedWatchlist | undefined;
        let assistantHost: HTMLElement | undefined;
        let agent: ChartAgentController | undefined;
        const askAi = (event: Event): void => {
            const detail = (event as CustomEvent<{ value: AnalysisQuestion; resolve(value: unknown): void; reject(error: unknown): void }>).detail;
            if (!agent) { detail.reject(new Error('The chart is still loading. Try again once it is ready.')); return; }
            this.host.dispatchEvent(new CustomEvent('local-replay:chrome', { bubbles: true, detail: { kind: 'pause' } }));
            void agent.requestAnalysis(detail.value.question, detail.value.drawingId ? { drawingId: detail.value.drawingId } : {}).then(detail.resolve, detail.reject);
        };
        this.host.addEventListener('local-replay:ask-ai', askAi);
        this.disposers.push(() => this.host.removeEventListener('local-replay:ask-ai', askAi));
        const panel = (event: Event): void => {
            const detail = (event as CustomEvent<{ kind: string; target?: HTMLElement }>).detail;
            if (detail.kind === 'assistant-mount' && detail.target) { assistantHost = detail.target; this.research?.attach(detail.target); }
            if (detail.kind === 'assistant-unmount') { assistantHost = undefined; this.research?.park(); }
            if (detail.kind === 'templates-unmount') { templates?.destroy(); templates = undefined; }
            if (detail.kind === 'templates-mount' && detail.target && this.workspace) {
                templates?.destroy();
                templates = mountChartTemplates(detail.target, { workspace: this.workspace, onChange: () => this.flush(),
                    blocked: () => this.persistenceSuspended || this.restoring || this.isAgentBlocked(),
                    applyWorkspace: (state) => this.applyTemplate(state) });
            }
            if (detail.kind === 'watchlist-unmount') { watchlist?.destroy(); watchlist = undefined; }
            if (detail.kind === 'watchlist-mount' && detail.target && this.workspace) {
                watchlist?.destroy();
                watchlist = mountCachedWatchlist(detail.target, { api: this.api,
                    context: () => this.workspace!.context(), session: () => this.view });
            }
        };
        this.host.addEventListener('local-replay:chrome', panel);
        this.disposers.push(() => { this.host.removeEventListener('local-replay:chrome', panel); templates?.destroy(); watchlist?.destroy(); });
        configureChartAppearance(drawingIcons);
        const state = sanitizeState(view.session.layout);
        this.appearanceKnownCells = new Set(state?.charts.map((chart) => chart.id) ?? []);
        const needsInitialSave = !state || needsDesktopChromeMigration(state) || state.charts.some((chart) => needsPlotAppearanceMigration(chart.rendererConfig));
        this.workspace = new VelaWorkspace(this.host, {
            theme: CHART_THEME,
            layout: '1', symbol: `replay:${view.dataset.symbol}`, timeframe: '1', data: [], live: false, bars: 5000,
            persist: false, watermark: !!state, volume: !!state,
            layoutMode: 'auto', topbar: { ...CHART_TOPBAR, right: ['local.chart-mode', 'local.backtest-mode', ...CHART_TOPBAR.right] },
            rangePresets: LOCAL_RANGE_PRESETS, sessionControls: false,
            onDateJump: () => { if (this.workspace) chromeEvent(this.workspace.context(), 'date-jump'); },
            timeframes: [...TIMEFRAMES].filter((timeframe) => view.dataset.schema === 'ohlcv-1s' || !timeframe.endsWith('S')),
            providers: { replay: () => ({ getBars: (symbol, timeframe, range) => this.fetchSeries(symbol, timeframe, range),
                listSymbols: async () => [{ ticker: view.dataset.symbol, prefix: 'CME', description: `${view.dataset.symbol} · cached replay`, type: 'futures' }],
                getSymbolInfo: async () => this.symbolInfo(view),
            }) },
        });
        if (state) {
            const safeState: WorkspaceState = {
                ...withDesktopTimeframeFavorites(state, view.dataset.schema), layout: validLayout(state.layout) ? state.layout : '1',
                charts: state.charts.map((chart) => ({ ...chart, symbol: `replay:${view.dataset.symbol}`,
                    rendererConfig: nativeChartConfig(chart.rendererConfig),
                    ...(isDefaultPlotAppearance(chart.rendererConfig) ? { watermark: false, replayWatermark: false } : {}),
                    bars: 5000, timeframe: this.allowedTimeframe(chart.timeframe ?? '') ? chart.timeframe : '1' })),
            };
            this.workspace.applyState(safeState);
        } else {
            for (const cell of this.workspace.cells()) applyLightPlotAppearance(cell);
            this.workspace.applyState(withDesktopTimeframeFavorites(this.workspace.getState(), view.dataset.schema));
        }
        this.disposers.push(mountChartChrome(this.workspace.root));
        this.setSaveState(needsInitialSave ? 'pending' : 'saved');
        this.disposers.push(mountChartHeader(this.workspace.root, { name: () => this.view?.session.config.name ?? 'Replay layout',
            save: () => this.flush().catch((error: unknown) => { this.onError(error); throw error; }) }));
        this.disposers.push(mountReferenceChrome(this.workspace.root));
        this.disposers.push(mountDrawingFavorites(this.workspace));
        this.disposers.push(mountDrawingUtilities(this.workspace));
        this.disposers.push(this.workspace.on('state:changed', () => { this.research?.synchronize(); this.scheduleSave(); }));
        this.disposers.push(this.workspace.on('cell:active', () => { this.research?.synchronize(); this.onActive(this.timeframe); }));
        this.disposers.push(this.workspace.on('cell:created', () => this.watchCells()));
        this.disposers.push(this.workspace.on('cell:destroyed', () => this.watchCells()));
        this.disposers.push(this.workspace.on('layout:changed', ({ layout }) => {
            if (!validLayout(layout)) return;
            const current = this.view;
            if (current) void this.enqueue((generation) => this.renderData(current, generation)).catch((error: unknown) => this.onError(error));
        }));
        const guardTyping = (event: KeyboardEvent): void => {
            const target = event.target as Element | null;
            const editing = this.workspace?.keymap.activeScope === 'dialog' || !!target?.closest?.('input,select,textarea,summary,[contenteditable="true"],[role="textbox"],[role="dialog"],dialog,.local-script-dock,.local-chart-templates');
            if (!blocksNativeMarketTyping(event, editing)) return;
            this.workspace?.keymap.handleKeydown(event);
            event.preventDefault(); event.stopImmediatePropagation();
        };
        this.host.addEventListener('keydown', guardTyping, true);
        this.disposers.push(() => this.host.removeEventListener('keydown', guardTyping, true));
        this.watchCells();
        await this.sync(view);
        this.restoring = false;
        this.refreshQuoteBars();
        refreshChartOrderLines(this.host);
        this.lastSaved = needsInitialSave ? '' : JSON.stringify(this.workspace?.getState());
        this.onActive(this.timeframe);
        this.scriptWorkspace = mountScriptWorkspace({ workspace: this.workspace, api: this.api, session: () => this.view,
            initialOpen: options.mode !== 'chart',
            cutoff: () => this.cursorTime, blocked: () => this.persistenceSuspended || this.restoring || this.isAgentBlocked(),
            onChange: () => this.flush(), onError: this.onError });
        const appContext = createAppAgentContext({ api: this.api, getView: () => this.view, getCursorTime: () => this.cursorTime,
            workspace: () => this.workspace ? { layout: this.workspace.layout.id, activeCellId: this.workspace.context().activeCellId,
                sync: this.workspace.sync.state(), cells: this.workspace.cells().map(cell => ({ id: cell.id, symbol: cell.chart.market.symbol ?? '', timeframe: cell.chart.market.timeframe ?? '', priceStyle: String(cell.chart.renderer.get('priceStyle') ?? 'candles') })) } : null,
            templates: () => new ChartTemplateStore(localStorage, navigator.locks).read().templates,
            getCurrentResult: () => this.scriptWorkspace?.readCurrentResult() ?? null });
        agent = createChartAgentController({ api: this.api, workspace: this.workspace, appContext, strategy: this.scriptWorkspace,
            session: () => this.view, generation: () => this.generation, cursorTime: () => this.cursorTime,
            blocked: () => this.persistenceSuspended || this.restoring || this.isAgentBlocked(),
            setTimeframe: (cellId, timeframe, assertCurrent) => this.setTimeframe(timeframe, cellId, assertCurrent), flush: () => this.flush(),
            candleEvidence: (input, owner) => this.research ? this.research.readCandle(input, owner) : Promise.reject(new Error('The candle evidence panel is unavailable.')),
            proposeScenario: (input, owner) => this.research ? this.research.propose(input, owner) : Promise.reject(new Error('The scenario notebook is unavailable.')) });
        this.disposers.push(() => agent?.dispose());
        if (this.host.ownerDocument && typeof this.workspace.context === 'function') {
            this.research = mountResearchWorkbench(this.host, { api: this.api, session: () => this.view, cursorTime: () => this.cursorTime,
                generation: () => this.generation, activeCellId: () => this.workspace?.context().activeCellId ?? null,
                cell: id => { const cell = this.workspace?.cell(id); return cell ? { chart: cell.chart, bars: this.bars.get(cell.chart.market.timeframe ?? '1') ?? [] } : null; },
                agent: () => agent ?? null, blocked: () => this.researchPreparing || this.persistenceSuspended || this.restoring || this.isAgentBlocked() || this.writing.size > 0,
                drawingSync: () => this.workspace?.sync.get('drawings'),
                pause: () => this.host.dispatchEvent(new CustomEvent('local-replay:chrome', { bubbles: true, detail: { kind: 'pause' } })), flush: () => this.flush() });
            this.research.synchronize(); if (assistantHost) this.research.attach(assistantHost);
        }
        if (needsInitialSave) this.scheduleSave();
    }

    get timeframe(): string { return this.workspace?.chart.market.timeframe ?? '1'; }
    get layout(): string { return this.workspace?.layout.id ?? '1'; }

    async setTimeframe(value: string, targetCellId?: string, assertCurrent?: () => void): Promise<void> {
        if (!this.workspace || !this.view || !this.allowedTimeframe(value)) return;
        const cellId = targetCellId ?? this.workspace.active.id;
        return this.enqueue(async (generation) => {
            assertCurrent?.();
            const cell = this.workspace?.cell(cellId);
            if (!cell || !this.view) return;
            const view = this.view;
            this.validTimeframes.set(cellId, value);
            await this.writeMarket(cell.chart, value, this.bars.get(value) ?? []);
            if (generation !== this.generation) return;
            await this.renderData(view, generation);
            if (generation !== this.generation) return;
            this.onActive(this.timeframe); this.scheduleSave();
        });
    }

    async setLayout(value: string): Promise<void> {
        if (!this.workspace || !this.view || !validLayout(value)) return;
        return this.enqueue(async (generation) => {
            if (!this.workspace || !this.view) return;
            const view = this.view;
            this.workspace.setLayout(value); this.watchCells();
            await this.renderData(view, generation);
            if (generation !== this.generation) return;
            this.scheduleSave();
        });
    }

    sync(view: SessionView): Promise<void> {
        if (this.dataView && (view.session.id !== this.dataView.session.id || view.dataset.id !== this.dataView.dataset.id
            || view.dataset.checksum !== this.dataView.dataset.checksum || view.session.cursor < this.dataView.session.cursor)) this.bars.clear();
        this.dataView = view;
        this.view = view;
        this.research?.synchronize();
        const generation = this.generation;
        return this.enqueue(() => this.renderData(view, generation));
    }

    private enqueue(work: (generation: number) => Promise<void>): Promise<void> {
        const generation = this.generation;
        this.syncPromise = this.syncPromise.catch(() => undefined).then(async () => {
            if (generation === this.generation) await work(generation);
        });
        return this.syncPromise;
    }

    private async renderData(view: SessionView, generation: number): Promise<void> {
            const workspace = this.workspace;
            const current = (): boolean => generation === this.generation && this.view?.session.id === view.session.id
                && this.view.dataset.id === view.dataset.id && this.view.dataset.checksum === view.dataset.checksum
                && this.view.session.cursor === view.session.cursor;
            if (!workspace || !current()) return;
            const cells = workspace.cells();
            for (const cell of cells) {
                const market = cell.chart.market;
                if (market.symbol !== `replay:${view.dataset.symbol}` || !this.allowedTimeframe(market.timeframe ?? '1')) {
                    const valid = this.validTimeframes.get(cell.id) ?? '1';
                    await this.writeMarket(cell.chart, valid, this.bars.get(valid) ?? []);
                    if (!current()) return;
                }
            }
            const timeframes = [...new Set(cells.map((cell) => cell.chart.market.timeframe ?? '1'))];
            const nativeTimeframe = view.dataset.schema === 'ohlcv-1s' ? '1S' : '1';
            let nativeCursorTime: number | null = null;
            await Promise.all(timeframes.map(async (timeframe) => {
                const prior = this.bars.get(timeframe) ?? [];
                const result = await revealedWindow(this.api, view.session.id, timeframe, prior, this.controller.signal, view);
                if (!current()) return;
                const { bars } = result;
                this.cursorTime = result.cursorTime;
                if (timeframe === nativeTimeframe) nativeCursorTime = result.cursorTime;
                this.bars.set(timeframe, bars);
                await Promise.all(cells.filter((cell) => (cell.chart.market.timeframe ?? '1') === timeframe).map(async (cell) => {
                    await this.writeMarket(cell.chart, timeframe, bars);
                    if (!current()) return;
                }));
            }));
            if (!current()) return;
            let latest = this.bars.get(nativeTimeframe)?.at(-1);
            if (!timeframes.includes(nativeTimeframe)) {
                const query = new URLSearchParams({ timeframe: serverTimeframe(nativeTimeframe), limit: '1', snapshot: replaySnapshot(view) });
                const quote = await this.api.get<ChartView>(`/api/sessions/${encodeURIComponent(view.session.id)}/chart?${query}`, this.controller.signal);
                if (!current()) return;
                latest = quote.bars.at(-1);
                this.cursorTime = quote.cursorTime;
            } else this.cursorTime = nativeCursorTime;
            this.lastPrice = latest?.close ?? null;
            this.onPrice(this.lastPrice, this.cursorTime);
            this.updateMarkers(view);
    }

    private allowedTimeframe(value: string): boolean {
        return !!this.view && timeframeSupported(value, this.view.dataset.schema);
    }

    private async writeMarket(chart: Vela, timeframe: string, data: Bar[]): Promise<void> {
        if (!this.view) return;
        const market = { symbol: `replay:${this.view.dataset.symbol}`, timeframe };
        this.writing.set(chart, market);
        const preserveView = chart.market.offline && chart.market.symbol === market.symbol && chart.market.timeframe === timeframe;
        try { await chart.setMarket({ ...market, data, bars: 5000, preserveView }); }
        finally { if (this.writing.get(chart) === market) this.writing.delete(chart); }
    }

    private watchCells(): void {
        const live = new Map((this.workspace?.cells() ?? []).map((cell) => [cell.id, cell]));
        for (const [id, watch] of this.cellWatches) {
            if (live.get(id)?.chart === watch.chart) continue;
            watch.off(); this.pineEngines.get(watch.chart)?.dispose(); this.pineEngines.delete(watch.chart);
            this.cellWatches.delete(id); this.validTimeframes.delete(id);
        }
        for (const cell of live.values()) {
            if (this.cellWatches.has(cell.id)) continue;
            if (!this.appearanceKnownCells.has(cell.id) && this.workspace) {
                const workspace = this.workspace; const generation = this.generation; const appearanceGeneration = this.appearanceGeneration;
                queueFreshCellAppearance(workspace, cell, () => this.workspace === workspace && this.generation === generation && this.appearanceGeneration === appearanceGeneration);
            }
            this.appearanceKnownCells.add(cell.id);
            cell.chart.renderer.set('gestureProfile', 'terminal');
            cell.chart.renderer.set('candleRasterization', 'terminal');
            cell.chart.renderer.set('axisRendering', 'terminal');
            cell.setStatuslineAppearance('terminal');
            cell.setExternalReplaying(true);
            this.ensurePineEngine(cell.chart);
            this.validTimeframes.set(cell.id, this.allowedTimeframe(cell.chart.market.timeframe ?? '1') ? cell.chart.market.timeframe ?? '1' : '1');
            const generation = this.generation;
            const current = (): boolean => this.generation === generation && this.workspace?.cell(cell.id)?.chart === cell.chart;
            const blocked = (): boolean => this.persistenceSuspended || this.restoring || this.isAgentBlocked() || this.writing.size > 0;
            const tradingBlocked = (): boolean => this.persistenceSuspended || this.restoring || this.isTradingBlocked() || this.writing.size > 0;
            const ticketAction = (kind: 'quick-market-order' | 'ticket-quantity-select', quantity: number, side?: 'buy' | 'sell'): void => {
                if (!current() || tradingBlocked() || this.view?.session.status !== 'paused') return;
                if (kind === 'quick-market-order') {
                    this.workspace!.setActiveCell(cell.id);
                }
                this.host.dispatchEvent(new CustomEvent('local-replay:chrome', { bubbles: true,
                    detail: { kind, side, quantity, sessionId: this.view.session.id, revision: this.view.session.revision } }));
            };
            const quoteDecimals = Math.min(8, Math.max(0, String(this.view?.dataset.instrument.tickSize ?? 0.25).split('.')[1]?.length ?? 0));
            const quoteFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: quoteDecimals, maximumFractionDigits: quoteDecimals });
            const quoteBar = cell.host?.nodeType === 1 ? createChartQuoteBar({
                onSide: side => ticketAction('quick-market-order', this.ticketQuantity, side),
                onQuantity: quantity => ticketAction('ticket-quantity-select', quantity),
                formatPrice: price => quoteFormat.format(price),
            }) : null;
            if (quoteBar) quoteBar.element.title = 'Simulated replay quotes use the last revealed candle close. Quick orders execute on the next source bar.';
            const quoteOff = quoteBar ? cell.mountStatuslineAccessory(quoteBar.element) : () => {};
            const refreshQuote = (): void => quoteBar?.update({ bid: this.lastPrice, ask: this.lastPrice,
                quantity: this.ticketQuantity, maxQuantity: this.view?.session.config.rules.maxContracts ?? 1000,
                blocked: !current() || tradingBlocked() || this.view?.session.status !== 'paused', showQuantity: true });
            refreshQuote();
            const selectPrice = (price: number, orderType: 'limit' | 'stop'): void => {
                if (current() && !blocked()) this.host.dispatchEvent(new CustomEvent('local-replay:chrome', { bubbles: true, detail: { kind: 'ticket-price-select', price, orderType } }));
            };
            const readPlotSurface = (): string => {
                const config = cell.chart.renderer.getConfig() as { layout?: { background?: string } };
                return config.layout?.background ?? CHART_THEME.background;
            };
            let plotSurface = readPlotSurface();
            const surfaceOff = cell.chart.renderer.onConfigChanged?.(() => {
                plotSurface = readPlotSurface();
                this.research?.synchronize();
                if (current() && cell.host?.nodeType === 1) refreshChartOrderLines(cell.host);
            }) ?? (() => {});
            const styleOff = cell.chart.on('priceStyle:change', () => {
                this.research?.synchronize(true);
                queueMicrotask(() => { if (current()) this.research?.synchronize(); });
            });
            const crosshairOff = cell.chart.renderer.onCrosshairMove?.(event => {
                if (current() && !blocked()) this.research?.capture(cell.id, event);
            }) ?? (() => {});
            const draftOff = cell.chart.on('drawing:draft', () => {
                const workspace = this.workspace; if (!current() || !workspace) return;
                this.research?.preemptGhost(cell.id, syncTargets(cell.id, workspace.sync.get('drawings'), workspace.cells().map(item => item.id)));
            });
            const toolOff = cell.chart.on('drawing:tool', ({ type }) => { if (type && current()) this.research?.preemptGhost(cell.id, []); });
            const lineOff = cell.host?.nodeType === 1 ? bindChartOrderLines(cell.host, {
                view: () => this.view, current, blocked, preview: () => this.ticketPreview,
                plotSurface: () => plotSurface,
                selectBracket: (bracket, price) => {
                    if (current() && !blocked() && this.view) this.host.dispatchEvent(new CustomEvent('local-replay:chrome', { bubbles: true,
                        detail: { kind: 'ticket-bracket-select', bracket, price, sessionId: this.view.session.id, revision: this.view.session.revision } }));
                },
                selectTakeProfits: (takeProfits) => {
                    if (current() && !blocked() && this.view) this.host.dispatchEvent(new CustomEvent('local-replay:chrome', { bubbles: true,
                        detail: { kind: 'ticket-targets-select', takeProfits, sessionId: this.view.session.id, revision: this.view.session.revision } }));
                },
                clearPreview: () => {
                    if (current() && !blocked() && this.view) this.host.dispatchEvent(new CustomEvent('local-replay:chrome', { bubbles: true,
                        detail: { kind: 'ticket-clear-preview', sessionId: this.view.session.id, revision: this.view.session.revision } }));
                },
                selectPrice, command: (command, sessionId, revision) => {
                    if (!current() || blocked()) return Promise.resolve();
                    return new Promise<void>(complete => this.host.dispatchEvent(new CustomEvent('local-replay:chrome', { bubbles: true,
                        detail: { kind: 'order-command', command, sessionId, revision, complete } })));
                },
            }) : () => {};
            const clickOff = typeof cell.chart.renderer.onClick === 'function' ? cell.chart.renderer.onClick(event => {
                if (this.ticketPicking && event.price !== null && event.paneKind === 'price') {
                    const type = this.ticketPicking; this.ticketPicking = null; selectPrice(event.price, type);
                    return;
                }
                if (current() && !blocked() && event.paneKind === 'price') this.research?.select(cell.id, event.time);
            }) : () => {};
            const loadOff = cell.chart.on('load:start', (market) => this.onNativeMarket(cell, market));
            this.cellWatches.set(cell.id, { chart: cell.chart,
                refreshQuote, off: () => { quoteOff(); quoteBar?.destroy(); surfaceOff(); styleOff(); crosshairOff(); draftOff(); toolOff(); lineOff(); clickOff(); loadOff(); } });
        }
    }

    private ensurePineEngine(chart: Vela): void {
        if (this.pineEngines.has(chart)) return;
        const engine = this.pineFactory?.(chart);
        if (!engine) throw new Error('The Pine runtime is not ready.');
        this.pineEngines.set(chart, engine);
        chart.registerEngine('pine', engine);
    }

    private applyTemplate(state: WorkspaceState): Promise<void> {
        return this.enqueue(async (generation) => {
            const view = this.view; const workspace = this.workspace;
            if (!view || !workspace || !validLayout(state.layout)) throw new Error('The template is not a valid chart layout.');
            this.restoring = true;
            try {
                this.appearanceGeneration++;
                this.appearanceKnownCells = new Set(state.charts.map((chart) => chart.id));
                workspace.applyState({ ...state, charts: state.charts.map((chart) => ({ ...chart,
                    symbol: `replay:${view.dataset.symbol}`, bars: 5000,
                    timeframe: this.allowedTimeframe(chart.timeframe ?? '') ? chart.timeframe : '1',
                    rendererConfig: nativeChartConfig(chart.rendererConfig) })) });
                this.watchCells();
                await this.renderData(view, generation);
            } finally { this.restoring = false; this.refreshQuoteBars(); }
            this.lastSaved = ''; this.scheduleSave();
        });
    }

    private symbolInfo(view: SessionView): SymbolInfo {
        return replaySymbolInfo(view.dataset);
    }

    private async fetchSeries(symbol: string, timeframe: string, range: BarRange, cutoff?: number, signal?: AbortSignal): Promise<OHLCV[]> {
        const view = this.view;
        if (!view || view.session.cursor < 0) return [];
        const query = new URLSearchParams({ timeframe, limit: String(Math.min(range.limit ?? 5000, 250000)), snapshot: replaySnapshot(view) });
        query.set('symbol', symbol);
        query.set(cutoff === undefined ? 'cursor' : 'cutoff', String(cutoff ?? view.session.cursor));
        if (range.from !== undefined) query.set('from', String(Math.max(0, Math.floor(range.from))));
        const result = await this.api.get<{ bars: OHLCV[] }>(`/api/sessions/${encodeURIComponent(view.session.id)}/series?${query}`,
            signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal);
        return range.to === undefined ? result.bars : result.bars.filter((bar) => bar.time <= range.to!);
    }

    private onNativeMarket(cell: ChartCell, market: { symbol: string; timeframe: string }): void {
        if (!this.view) return;
        const expected = this.writing.get(cell.chart);
        if (expected?.symbol === market.symbol && expected.timeframe === market.timeframe) return;
        const valid = market.symbol === `replay:${this.view.dataset.symbol}` && this.allowedTimeframe(market.timeframe);
        const timeframe = valid ? market.timeframe : this.validTimeframes.get(cell.id) ?? '1';
        if (valid) this.validTimeframes.set(cell.id, timeframe);
        void this.enqueue(async (generation) => {
            if (!this.view || this.workspace?.cell(cell.id)?.chart !== cell.chart) return;
            const view = this.view;
            await this.writeMarket(cell.chart, timeframe, this.bars.get(timeframe) ?? []);
            if (generation !== this.generation) return;
            await this.renderData(view, generation);
            if (generation !== this.generation) return;
            this.onActive(this.timeframe); this.scheduleSave();
            if (!valid) this.onError(new Error('Replay charts stay on this session’s contract and supported resolution. Use the chart timeframe selector.'));
        }).catch((error: unknown) => this.onError(error));
    }

    snapshot(): WorkspaceState | null { return this.workspace?.getState() ?? null; }

    suspendPersistence(suspended: boolean): void {
        this.persistenceSuspended = suspended;
        this.refreshQuoteBars();
        if (suspended) { clearTimeout(this.saveTimer); this.setSaveState('paused'); }
        else this.scheduleSave();
    }

    /** Pull live drawings and indicator inputs directly, bypassing both debounce timers. */
    async prepareForUpdate(saveLayout = true): Promise<void> {
        this.researchPreparing = true;
        try { await this.research?.prepare(); await this.scriptWorkspace?.prepareForUpdate(); if (saveLayout) await this.flush(); }
        finally { this.researchPreparing = false; }
    }

    async flush(): Promise<void> {
        await this.scriptWorkspace?.flush();
        clearTimeout(this.saveTimer);
        await this.syncPromise;
        await this.savePromise.catch(() => undefined);
        clearTimeout(this.saveTimer);
        const workspace = this.workspace;
        if (!workspace) return;
        const generation = this.generation;
        const state = workspace.getState();
        const serialized = JSON.stringify(state);
        if (serialized === this.lastSaved) return;
        this.savePromise = this.persistLayout(state, serialized, generation);
        await this.savePromise;
    }

    updateMarkers(view: SessionView): void {
        if (this.view && (view.session.id !== this.view.session.id || view.dataset.id !== this.view.dataset.id
            || view.session.revision < this.view.session.revision)) return;
        this.view = view;
        this.research?.synchronize();
        this.refreshQuoteBars();
        refreshChartOrderLines(this.host);
        if (this.workspace?.root) this.workspace.root.dataset.localLayoutName = view.session.config.name;
        if (!this.workspace || this.cursorTime === null) return;
        for (const cell of this.workspace.cells()) {
            const bars = this.bars.get(cell.chart.market.timeframe ?? '1') ?? [];
            cell.chart.marks.defineGroup({ id: 'simulation', label: 'Simulated orders, positions and fills', visible: true });
            cell.chart.marks.set(sessionMarks(view.session, bars[0]?.time ?? this.cursorTime, this.cursorTime));
        }
    }

    refreshQuoteBars(): void { for (const watch of this.cellWatches.values()) watch.refreshQuote(); }

    setTicketQuantity(quantity: number): void {
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > (this.view?.session.config.rules.maxContracts ?? 1000)) return;
        this.ticketQuantity = quantity; this.refreshQuoteBars();
    }

    private scheduleSave(): void {
        if (this.persistenceSuspended || this.restoring || !this.workspace) return;
        clearTimeout(this.saveTimer);
        const current = JSON.stringify(this.workspace.getState());
        this.setSaveState(current === this.lastSaved ? 'saved' : 'pending');
        this.saveTimer = setTimeout(() => {
            const state = this.workspace?.getState();
            if (!state) return;
            const serialized = JSON.stringify(state);
            if (serialized === this.lastSaved) return;
            const generation = this.generation;
            this.savePromise = this.savePromise.catch(() => undefined).then(() => this.persistLayout(state, serialized, generation));
            void this.savePromise.catch((error: unknown) => this.onError(error));
        }, 250);
    }

    private setSaveState(state: LayoutSaveState): void {
        if (this.workspace?.root) this.workspace.root.dataset.localLayoutSave = state;
    }

    private async persistLayout(state: WorkspaceState, serialized: string, generation: number): Promise<void> {
        if (generation !== this.generation) return;
        this.setSaveState('saving');
        try {
            await this.onLayout(state);
            if (generation !== this.generation) return;
            this.lastSaved = serialized;
            this.setSaveState(this.persistenceSuspended ? 'paused' : JSON.stringify(this.workspace?.getState()) === serialized ? 'saved' : 'pending');
        } catch (error) {
            if (generation === this.generation) this.setSaveState('error');
            throw error;
        }
    }

    destroy(): void {
        this.generation++;
        this.controller.abort();
        this.research?.destroy(); this.research = null; this.researchPreparing = false;
        clearTimeout(this.saveTimer);
        this.disposers.splice(0).forEach((dispose) => dispose());
        for (const watch of this.cellWatches.values()) watch.off();
        this.cellWatches.clear();
        this.appearanceKnownCells.clear();
        this.scriptWorkspace?.destroy(); this.scriptWorkspace = null;
        this.workspace?.destroy();
        for (const engine of this.pineEngines.values()) engine.dispose();
        this.pineEngines.clear(); this.pineFactory = null;
        this.workspace = null;
        this.view = null;
        this.dataView = null;
        this.lastPrice = null;
        this.cursorTime = null;
        this.bars.clear();
        this.writing.clear(); this.validTimeframes.clear();
        this.syncPromise = Promise.resolve();
        this.savePromise = Promise.resolve();
    }
}
