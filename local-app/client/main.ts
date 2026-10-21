import './styles.css';
import { DEFAULT_RULES, type Analytics, type Bootstrap, type Command, type DatasetMeta, type MonteCarlo,
    type ProviderQuote, type ProviderRequest, type SessionConfig, type SessionCreateConfig, type SessionNavigation, type SessionSummary, type SessionView } from '../shared/types';
import { LocalApi, ApiError } from './api';
import { ReplayCharts } from './charts';
import { RuntimeCoordinator, rememberSession, selectedSession, type RuntimeNotice } from './runtime';
import { nextSessionTime, parseWallTime, REPLAY_ZONES, wallTimeInput, type JumpPreset } from './replay-time';
import { runReplayJump } from './replay-jump';
import { ReplayPlayback } from './replay-playback';
import { ReplayAnalyticsRefresh } from './replay-analytics';
import { ReplayPresentation, replayIntervalCount, replayIntervalLabel, replayPreferenceStore } from './replay-presentation';
import './replay-presentation.css';
import { buildReplayShell, controlIcon } from './shell';
import { replayKeyStatsMarkup } from './replay-stats-dock';
import { mountReplayEquityChart, type ReplayEquityChart } from './replay-equity-chart';
import { TradeTicket } from './trade-ticket';
import { persistDesktopSession } from './desktop-session';
import type {} from './desktop-bridge';
import './trade-ticket.css';
import { clampPercent, downloadJson, escapeHtml as esc, keyboardAction, replayShortcutTargetIsEditing, linePath, MAX_BACKUP_BYTES, money, number, percent, signedMoney, utc } from './util';

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Missing application element: ${selector}`);
    return element;
};
const value = (id: string): string => $<HTMLInputElement>(`#${id}`).value;
const numeric = (id: string): number => {
    const result = Number(value(id));
    if (!Number.isFinite(result)) throw new Error('Enter a finite number for each field.');
    return result;
};
const optionalNumber = (id: string): number | undefined => value(id).trim() ? numeric(id) : undefined;
const pnlClass = (amount: number): string => amount < 0 ? 'negative' : amount > 0 ? 'positive' : '';


class ReplayStudio {
    private desktopPreparing = false;
    private api = new LocalApi();
    private bootstrap: Bootstrap | null = null;
    private view: SessionView | null = null;
    private sessionGeneration = 0;
    private sessionController = new AbortController();
    private commandQueue = Promise.resolve();
    private playback = new ReplayPlayback({ advance: () => this.command({ type: 'advance', count: replayIntervalCount(value('replay-interval')) }),
        delay: () => Math.max(40, 1000 / Number(value('speed'))),
        canPlay: () => !this.runtimeBlocked && !this.disposed && !this.jumping && this.view?.session.status === 'paused',
        onError: (error) => this.error(error) });
    private get playing(): boolean { return this.playback.playing; }
    private replayPresentation = new ReplayPresentation(() => this.pause(), replayPreferenceStore());
    private toastTimer: ReturnType<typeof setTimeout> | undefined;
    private charts: ReplayCharts;
    private tradeTicket: TradeTicket;
    private replayEquityChart: ReplayEquityChart | null = null;
    private activeTab = 'analytics';
    private analytics: Analytics | null = null;
    private analyticsVersion = 0;
    private analyticsRefresh = new ReplayAnalyticsRefresh({
        target: () => this.view && !this.mutationBusy && !this.runtimeBlocked && !this.disposed ? { sessionId: this.view.session.id, version: this.analyticsVersion } : null,
        enabled: () => this.activeTab === 'analytics' && !this.disposed && !this.runtimeBlocked && !this.mutationBusy,
        load: (target, signal) => this.api.get<Analytics>(`/api/sessions/${encodeURIComponent(target.sessionId)}/analytics`, signal),
        apply: (analysis) => { this.analytics = analysis; if (this.activeTab === 'analytics') this.renderAnalytics(); },
        onError: (error) => {
            $('#results').setAttribute('aria-busy', 'false');
            const refresh = $('#results').querySelector('[data-action=refresh-analytics]'); if (refresh) refresh.textContent = 'Retry refresh';
            this.error(error);
        },
    });
    private monteCarlo: MonteCarlo | null = null;
    private quote: ProviderQuote | null = null;
    private quoteGeneration = 0;
    private modalGeneration = 0;
    private disposed = false;
    private disposers: (() => void)[] = [];
    private mutationBusy = false;
    private runtime: RuntimeCoordinator;
    private runtimeBlocked = false;
    private starting = true;
    private replayZone = 'UTC';
    private jumping = false;
    private jumpGeneration = 0;
    private activeTasks = new Set<Promise<unknown>>();
    private runtimeMessage: HTMLElement;

    constructor() {
        $('#app').innerHTML = this.shell();
        this.tradeTicket = new TradeTicket($<HTMLFormElement>('#ticket-form'), { submit: (side) => this.run(() => this.place(side)),
            isBlocked: () => this.runtimeBlocked || this.starting || this.disposed || this.mutationBusy || this.jumping });
        this.disposers.push(() => this.tradeTicket.destroy());
        const transport = $('.transport');
        const replayLabel = document.createElement('span');
        replayLabel.className = 'local-replay-label'; replayLabel.textContent = 'Replay · simulated'; transport.prepend(replayLabel);
        const trading = $('.trading-column');
        const sessionResults = $('.results-panel');
        const resultsSlot = document.createComment('Session results home'); sessionResults.before(resultsSlot);
        const chrome = (event: Event): void => {
            const detail = (event as CustomEvent<{ kind: string; target?: HTMLElement; command?: Command; sessionId?: string; revision?: number; price?: number | null; orderType?: 'limit' | 'stop'; side?: 'buy' | 'sell'; quantity?: number; bracket?: 'takeProfit' | 'stopLoss'; complete?: () => void }>).detail;
            if (detail.kind === 'sessions') this.run(() => this.action('sessions', {}));
            if (detail.kind === 'pause') this.pause();
            if (detail.kind === 'replay-toggle') this.replayPresentation.toggle();
            if (detail.kind === 'replay-close') this.replayPresentation.setOpen(false);
            if (detail.kind === 'date-jump' || detail.kind === 'go-to') this.run(() => this.action('go-to', {}));
            if (detail.kind === 'open-session' && detail.target?.dataset.sessionId) this.run(() => this.action('open-session', { id: detail.target!.dataset.sessionId }));
            if (detail.kind === 'replay-mount' && detail.target) {
                detail.target.append(transport); this.replayPresentation.mount(detail.target);
            }
            if (detail.kind === 'replay-unmount') {
                this.replayPresentation.unmount(); $('#replay-home').append(transport);
            }
            if (detail.kind === 'replay-stats-mount' && detail.target) detail.target.append(sessionResults);
            if (detail.kind === 'replay-stats-unmount') resultsSlot.after(sessionResults);
            if (detail.kind === 'ticket-price-select' && Number.isFinite(detail.price)) this.tradeTicket.selectPrice(detail.price!, detail.orderType ?? 'limit');
            if ((detail.kind === 'ticket-bracket-select' || detail.kind === 'ticket-clear-preview') && this.view
                && this.view.session.id === detail.sessionId && this.view.session.revision === detail.revision
                && !this.runtimeBlocked && !this.starting && !this.disposed && !this.mutationBusy && !this.playing && !this.jumping) {
                if (detail.kind === 'ticket-clear-preview') this.tradeTicket.clearPreview();
                if (detail.kind === 'ticket-bracket-select' && (detail.bracket === 'takeProfit' || detail.bracket === 'stopLoss')
                    && (detail.price === null || Number.isFinite(detail.price))) this.tradeTicket.selectBracket(detail.bracket, detail.price!);
            }
            if (detail.kind === 'ticket-quantity-select' && this.view
                && this.view.session.id === detail.sessionId && this.view.session.revision === detail.revision
                && !this.runtimeBlocked && !this.starting && !this.disposed && !this.mutationBusy && !this.jumping
                && Number.isInteger(detail.quantity) && detail.quantity! >= 1 && detail.quantity! <= this.view.session.config.rules.maxContracts) {
                this.tradeTicket.setQuantity(detail.quantity!);
            }
            if (detail.kind === 'quick-market-order' && (detail.side === 'buy' || detail.side === 'sell') && this.view
                && this.view.session.id === detail.sessionId && this.view.session.revision === detail.revision
                && !this.runtimeBlocked && !this.starting && !this.disposed && !this.mutationBusy && !this.jumping
                && Number.isInteger(detail.quantity) && detail.quantity! >= 1 && detail.quantity! <= this.view.session.config.rules.maxContracts) {
                const order = { side: detail.side, type: 'market' as const, qty: detail.quantity! };
                const sessionId = this.view.session.id; const generation = this.sessionGeneration; const revision = this.view.session.revision;
                this.pause();
                this.run(async () => {
                    if (generation !== this.sessionGeneration || this.view?.session.id !== sessionId || this.view.session.revision !== revision
                        || this.runtimeBlocked || this.starting || this.disposed || this.mutationBusy || this.jumping) return;
                    await this.command({ type: 'place', order }, false, revision);
                });
            }
            if (detail.kind === 'order-command' && detail.command && (detail.command.type === 'amend' || detail.command.type === 'cancel')) {
                const command = detail.command;
                const complete = (): void => detail.complete?.();
                void this.run(async () => {
                    if (!this.view || this.view.session.id !== detail.sessionId || this.view.session.revision !== detail.revision
                        || this.runtimeBlocked || this.starting || this.disposed || this.mutationBusy || this.playing || this.jumping) return;
                    await this.command(command, false, detail.revision);
                }).then(complete, complete);
            }
            if (detail.kind === 'trade-mount' && detail.target) detail.target.append(trading);
            if (detail.kind === 'trade-unmount') $('#trade-home').append(trading);
        };
        const route = (): void => {
            const manager = location.hash === '#sessions';
            $('#session-manager').hidden = !manager;
            $('#standard-workspace').hidden = manager;
            if (manager) this.pause();
        };
        document.addEventListener('local-replay:chrome', chrome);
        window.addEventListener('hashchange', route);
        this.disposers.push(() => document.removeEventListener('local-replay:chrome', chrome), () => window.removeEventListener('hashchange', route));
        this.charts = new ReplayCharts($('#chart'), this.api,
            (layout) => this.command({ type: 'layout', layout }, true),
            (error) => this.error(error), (timeframe) => { $<HTMLSelectElement>('#timeframe').value = timeframe; },
            (price, time) => { $('#last-price').textContent = price === null ? '—' : number(price); $('#cursor-time').textContent = time === null ? 'Before first source bar' : utc(time); this.tradeTicket.update(this.view, price); },
            () => this.starting || this.disposed || this.runtimeBlocked || this.mutationBusy || this.playing || this.jumping || location.hash === '#sessions',
            () => this.starting || this.disposed || this.runtimeBlocked || this.mutationBusy || this.jumping || location.hash === '#sessions');
        this.runtimeMessage = document.createElement('div');
        this.runtimeMessage.id = 'runtime-message'; this.runtimeMessage.hidden = true;
        this.runtimeMessage.setAttribute('role', 'status'); this.runtimeMessage.setAttribute('aria-live', 'polite');
        document.body.append(this.runtimeMessage);
        this.runtime = new RuntimeCoordinator(this.api, { notice: (notice) => this.runtimeNotice(notice),
            prepare: () => this.prepareUpdate(), reconnect: () => this.reconnectRuntime(), reload: () => location.reload() });
        const click = (event: MouseEvent): void => {
            if (this.runtimeBlocked) return;
            const button = (event.target as Element).closest<HTMLElement>('[data-action]');
            const navigation = $<HTMLDetailsElement>('#replay-navigation');
            if (button || !navigation.contains(event.target as Node)) navigation.open = false;
            if (!button || button instanceof HTMLButtonElement && button.disabled) return;
            this.run(() => this.action(button.dataset.action!, button.dataset));
        };
        const keydown = (event: KeyboardEvent): void => {
            if (this.runtimeBlocked) { event.preventDefault(); event.stopImmediatePropagation(); return; }
            if (location.hash === '#sessions') return;
            if (event.key === 'Escape' && $<HTMLDetailsElement>('#replay-navigation').open) {
                $<HTMLDetailsElement>('#replay-navigation').open = false; return;
            }
            const target = event.target as Element | null;
            if (event.code === 'Space' && target?.closest('button')) return;
            const editing = replayShortcutTargetIsEditing(target)
                || !!document.querySelector('dialog[open],[role="dialog"][data-state="open"],.vela-dialog-overlay');
            const action = keyboardAction(event, editing);
            if (!action || !this.view || event.repeat) return;
            if (this.jumping && action !== 'play') return;
            event.preventDefault(); event.stopPropagation();
            this.run(() => this.action(action, {}));
        };
        const change = (event: Event): void => {
            if (this.runtimeBlocked) return;
            const target = event.target as HTMLInputElement;
            const dialogError = document.querySelector<HTMLElement>('#dialog-error'); if (dialogError) dialogError.hidden = true;
            if (target.id === 'timeframe') this.run(() => this.charts.setTimeframe(target.value));
            if (target.id === 'chart-layout') this.run(() => this.charts.setLayout(target.value));
            if (target.id === 'order-type') this.updatePriceVisibility();
            if (target.id === 'speed') this.updateControls();
            if (target.id === 'preset') this.applyPreset(target.value);
            if (target.id === 'new-dataset' || target.id === 'new-zone') this.updateStartTime(target.id === 'new-dataset');
            if (target.id === 'go-to-zone') this.updateGoToZone();
            if (target.closest('#provider-quote-form')) this.invalidateQuote();
        };
        const submit = (event: SubmitEvent): void => {
            const form = event.target as HTMLFormElement;
            event.preventDefault();
            if (this.runtimeBlocked) return;
            if (!form.reportValidity()) return;
            this.run(() => this.submit(form));
        };
        const unload = (): void => this.dispose();
        const modal = $<HTMLDialogElement>('#modal');
        const close = (): void => { this.modalGeneration++; this.invalidateQuote(); const key = document.querySelector<HTMLInputElement>('#provider-key'); if (key) key.value = ''; };
        document.addEventListener('click', click);
        document.addEventListener('keydown', keydown, true);
        document.addEventListener('change', change);
        document.addEventListener('submit', submit);
        window.addEventListener('pagehide', unload);
        modal.addEventListener('close', close);
        this.disposers.push(() => document.removeEventListener('click', click), () => document.removeEventListener('keydown', keydown, true),
            () => document.removeEventListener('change', change), () => document.removeEventListener('submit', submit),
            () => window.removeEventListener('pagehide', unload), () => modal.removeEventListener('close', close));
        route();
    }

    async start(): Promise<void> {
        this.bootstrap = await this.api.get<Bootstrap>('/api/bootstrap');
        this.api.setToken(this.bootstrap.token);
        this.renderSessions();
        $('#connection').innerHTML = '<span class="status-dot"></span> Local workspace';
        await this.runtime.start();
        if (this.disposed) return;
        this.starting = false;
        const id = selectedSession(sessionStorage, this.bootstrap.sessions);
        if (id) await this.openSession(id);
        else this.renderEmpty();
        if (window.velaDesktop) this.disposers.push(window.velaDesktop.onPrepare(request => {
            this.desktopPreparing = true;
            this.runtimeNotice({ mode: 'run', blocked: true, message: 'Saving your workspace before closing Vela…' });
            void this.prepareUpdate().then(() => {
                persistDesktopSession(localStorage, sessionStorage);
                window.velaDesktop!.prepared(request.requestId);
            }).catch(() => {
                this.desktopPreparing = false;
                this.runtimeNotice({ mode: 'run', blocked: false, error: true, message: 'Vela could not save your workspace. Resolve the save error and try closing again.' });
                window.velaDesktop!.prepared(request.requestId, 'Save failed');
            });
        }));
    }

    private shell(): string { return buildReplayShell(); }



    private run(task: () => Promise<unknown> | void): Promise<unknown> {
        if (this.starting || this.runtimeBlocked || this.disposed) return Promise.resolve();
        const work = Promise.resolve().then(() => { if (!this.disposed) return task(); });
        this.activeTasks.add(work);
        void work.catch((error: unknown) => this.error(error)).finally(() => this.activeTasks.delete(work));
        return work;
    }

    private runtimeNotice(notice: RuntimeNotice): void {
        if (this.disposed) return;
        if (this.desktopPreparing && !notice.blocked) return;
        this.runtimeBlocked = notice.blocked;
        if (notice.blocked) {
            this.pause();
            const key = document.querySelector<HTMLInputElement>('#provider-key'); if (key) key.value = '';
            const modal = $<HTMLDialogElement>('#modal'); if (modal.open) modal.close();
        }
        this.charts.suspendPersistence(notice.blocked);
        $('#app').inert = notice.blocked;
        $('#app').setAttribute('aria-busy', String(notice.blocked));
        const badge = $('#runtime-badge'); badge.hidden = notice.mode === null;
        badge.textContent = notice.mode === 'develop' ? 'Develop Vela' : 'Run Vela';
        this.runtimeMessage.textContent = notice.message;
        this.runtimeMessage.className = `${notice.blocked ? 'runtime-blocking' : ''}${notice.error ? ' runtime-error' : ''}`;
        this.runtimeMessage.hidden = !notice.message;
        this.updateControls();
        if (!notice.blocked) this.analyticsRefresh.wake();
    }

    private async prepareUpdate(): Promise<void> {
        this.pause();
        // Already-started dialogs/provider requests must settle before the snapshot.
        await Promise.allSettled([...this.activeTasks]);
        await this.commandQueue;
        if (this.disposed) throw new Error('The workspace closed before it could be saved.');
        const key = document.querySelector<HTMLInputElement>('#provider-key'); if (key) key.value = '';
        const modal = $<HTMLDialogElement>('#modal'); if (modal.open) modal.close();
        (document.activeElement as HTMLElement | null)?.blur();
        if (this.view) {
            rememberSession(sessionStorage, this.view.session.id);
            await this.charts.prepareForUpdate();
            await this.commandQueue;
        }
    }

    private async reconnectRuntime(): Promise<void> {
        const fresh = await this.api.get<Bootstrap>('/api/bootstrap');
        this.api.setToken(fresh.token);
        // Keep the old view's revision: newer work in another window must not be overwritten.
        await this.prepareUpdate();
    }

    private error(error: unknown): void {
        if (error instanceof DOMException && error.name === 'AbortError' || this.disposed) return;
        this.pause();
        const message = error instanceof Error ? error.message : 'The local request could not be completed.';
        const dialogError = document.querySelector<HTMLElement>('#dialog-error');
        if ($<HTMLDialogElement>('#modal').open && dialogError) { dialogError.textContent = message; dialogError.hidden = false; }
        else this.toast(message, true);
    }

    private toast(message: string, error = false): void {
        const toast = $('#toast'); toast.textContent = message; toast.className = error ? 'error' : ''; toast.hidden = false;
        clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 8500 : 4000);
    }

    private async refreshIndex(): Promise<void> {
        const [sessions, datasets] = await Promise.all([
            this.api.get<SessionSummary[]>('/api/sessions'), this.api.get<DatasetMeta[]>('/api/datasets'),
        ]);
        if (!this.bootstrap) return;
        this.bootstrap.sessions = sessions; this.bootstrap.datasets = datasets; this.renderSessions();
    }

    private renderSessions(): void {
        const sessions = this.bootstrap?.sessions ?? [];
        $('#session-count').textContent = String(sessions.length);
        $('#sessions').innerHTML = sessions.length ? sessions.map((session) => `<button class="session-card ${session.id === this.view?.session.id ? 'selected' : ''}" data-action="open-session" data-id="${esc(session.id)}"><div class="session-card-top"><span class="session-icon">${session.mode === 'prop' ? '◈' : '⌁'}</span><strong>${esc(session.name)}</strong><span class="session-status ${esc(session.status)}"></span></div><div class="session-card-meta"><span>${esc(session.symbol)} <i>·</i> ${session.mode === 'prop' ? 'Evaluation' : 'Practice'}</span><span class="${pnlClass(session.netPnl)}">${signedMoney(session.netPnl)}</span></div><div class="session-card-progress"><span style="width:${clampPercent((session.cursor + 1) / session.barCount * 100)}%"></span></div></button>`).join('')
            : '<div class="sidebar-empty">A fresh start.<br>Your saved sessions will live here.</div>';
    }

    private renderEmpty(): void {
        $('#chart-empty').hidden = false;
        this.updateControls();
    }

    private async openSession(id: string, saveLayout = true): Promise<void> {
        this.pause();
        if (saveLayout) await this.charts.prepareForUpdate();
        const current = this.view;
        const layout = this.charts.snapshot();
        if (saveLayout && current && layout && JSON.stringify(current.session.layout) !== JSON.stringify(layout)) {
            await this.command({ type: 'layout', layout });
        }
        this.sessionController.abort(); this.sessionController = new AbortController();
        this.analyticsRefresh.reset(); this.analyticsVersion++;
        this.replayEquityChart?.destroy(); this.replayEquityChart = null; $('#results').replaceChildren();
        const generation = ++this.sessionGeneration;
        this.charts.destroy();
        this.view = null; this.analytics = null; this.monteCarlo = null;
        this.commandQueue = Promise.resolve(); this.mutationBusy = false;
        $('#save-status').textContent = 'Opening session…';
        this.updateControls();
        const view = await this.api.get<SessionView>(`/api/sessions/${encodeURIComponent(id)}`, this.sessionController.signal);
        if (generation !== this.sessionGeneration) return;
        this.view = view; this.renderView();
        rememberSession(sessionStorage, view.session.id);
        $('#chart-empty').hidden = true;
        await this.charts.mount(view);
        if (generation !== this.sessionGeneration) return;
        this.charts.setTicketQuantity(this.tradeTicket.quantity);
        $<HTMLSelectElement>('#chart-layout').value = this.charts.layout;
        $('#save-status').innerHTML = '<i></i> Saved locally';
        this.renderSessions();
        if (this.activeTab === 'analytics') await this.loadAnalytics();
    }

    private command(command: Command, strict = false, expectedRevision?: number): Promise<void> {
        const generation = this.sessionGeneration;
        const id = this.view?.session.id;
        if (!id) return Promise.resolve();
        const work = this.commandQueue.catch(() => undefined).then(async () => {
            if (generation !== this.sessionGeneration || this.view?.session.id !== id) {
                if (strict) throw new Error('The session changed before its chart state could be saved.');
                return;
            }
            if (expectedRevision !== undefined && (this.view.session.revision !== expectedRevision || this.runtimeBlocked
                || this.starting || this.disposed || this.mutationBusy || this.playing || this.jumping)) return;
            this.mutationBusy = true; this.updateControls();
            $('#save-status').textContent = 'Saving…';
            try {
                const view = await this.api.post<SessionView>(`/api/sessions/${encodeURIComponent(id)}/command`,
                    { expectedRevision: this.view.session.revision, command }, this.sessionController.signal);
                if (generation !== this.sessionGeneration) {
                    if (strict) throw new Error('The session changed while its chart state was saving.');
                    return;
                }
                this.view = view;
                const metricsChanged = !['layout', 'rename', 'bookmark'].includes(command.type);
                if (metricsChanged) { this.analytics = null; this.monteCarlo = null; this.analyticsVersion++; }
                this.renderView();
                if (metricsChanged) this.analyticsRefresh.invalidate();
                if (command.type === 'advance' || command.type === 'advanceTo') await this.charts.sync(view);
                this.updateSummary();
                $('#save-status').innerHTML = '<i></i> Saved locally';
            } catch (error) {
                if (error instanceof ApiError && error.status === 409 && generation === this.sessionGeneration) {
                    if (strict) throw new Error('This session changed in another window. The pending chart snapshot was not saved.');
                    await this.openSession(id, false);
                    this.toast('This session changed in another window. Refreshed; please retry your action.', true);
                } else throw error;
            } finally {
                if (generation === this.sessionGeneration) { this.mutationBusy = false; this.updateControls(); this.analyticsRefresh.wake(); }
            }
        });
        this.commandQueue = work.catch(() => undefined);
        return work;
    }

    private updateSummary(): void {
        if (!this.view || !this.bootstrap) return;
        const { session, dataset } = this.view;
        const summary = this.bootstrap.sessions.find((item) => item.id === session.id);
        if (summary) Object.assign(summary, { name: session.config.name, status: session.status, cursor: session.cursor,
            equity: session.account.equity, netPnl: session.account.netPnl, trades: session.trades.length,
            revision: session.revision, updatedAt: session.updatedAt, barCount: dataset.barCount });
        this.renderSessions();
    }

    private renderView(): void {
        if (!this.view) return;
        const { session: session, dataset } = this.view;
        const { account } = session;
        $('#session-name').textContent = session.config.name;
        $('#session-kicker').textContent = `${session.config.mode === 'prop' ? 'EVALUATION' : 'PRACTICE'} / ${dataset.symbol} / ${dataset.schema}`;
        $('#balance').textContent = money(account.balance); $('#equity').textContent = money(account.equity);
        $('#unrealized').textContent = signedMoney(account.unrealizedPnl); $('#unrealized').className = pnlClass(account.unrealizedPnl);
        $('#net-pnl').textContent = signedMoney(account.netPnl); $('#net-pnl').className = pnlClass(account.netPnl);
        $('#attempt-status').textContent = session.status === 'paused' ? 'In progress' : session.status[0]!.toUpperCase() + session.status.slice(1);
        $('#attempt-status').className = `attempt-${session.status}`;
        $('#chart-symbol').textContent = dataset.symbol; $('#ticket-symbol').textContent = dataset.symbol;
        $('#source-badge').textContent = `${dataset.source === 'demo' ? 'SYNTHETIC DEMO' : dataset.source === 'databento' ? 'DATABENTO' : 'IMPORTED'} · ${dataset.intervalMs / 1000}s source`;
        $('#source-badge').classList.toggle('synthetic', dataset.source === 'demo');
        $('#cursor-time').textContent = this.charts.cursorTime === null ? 'Before first source bar' : utc(this.charts.cursorTime);
        for (const option of $<HTMLSelectElement>('#replay-interval').options) {
            option.textContent = replayIntervalLabel(dataset.intervalMs, replayIntervalCount(option.value));
        }
        for (const option of $<HTMLSelectElement>('#timeframe').options) option.disabled = dataset.schema !== 'ohlcv-1s' && option.value.endsWith('S');
        $('#bar-progress').textContent = `${number(Math.max(0, session.cursor + 1))} / ${number(dataset.barCount)} source bars revealed`;
        $('#replay-progress-fill').style.width = `${clampPercent((session.cursor + 1) / dataset.barCount * 100)}%`;
        $('#cost-footnote').textContent = `${money(session.config.commissionPerContractSide)} / contract / side · ${session.config.slippageTicks} tick slippage · ${session.config.spreadTicks} tick spread`;
        $('#trade-count').textContent = String(session.trades.length);
        this.renderPosition(); this.renderOrders(); this.renderRules(); this.renderResults(); this.updateControls(); this.charts.updateMarkers(this.view);
        $('#last-price').textContent = this.charts.lastPrice === null ? '—' : number(this.charts.lastPrice);
        this.tradeTicket.update(this.view, this.charts.lastPrice);
        if (session.status !== 'paused') this.pause();
    }

    private updateControls(): void {
        const active = !!this.view;
        const tradable = this.view?.session.status === 'paused';
        $('#session-actions').hidden = !active;
        for (const element of document.querySelectorAll<HTMLButtonElement>('[data-action="buy"],[data-action="sell"],[data-action="step"],[data-action="skip"],[data-action="go-to"],[data-action="replay-jump-preset"],[data-action="play"],[data-action="fast-forward"],[data-action="amend-order"],[data-action="cancel-order"]')) element.disabled = !tradable || this.mutationBusy || this.jumping;
        for (const element of document.querySelectorAll<HTMLButtonElement>('[data-action="close"],[data-action="reverse"],[data-action="partial-close"],[data-action="amend-position"]')) element.disabled = !tradable || this.mutationBusy || this.jumping || !this.view?.session.position;
        for (const element of document.querySelectorAll<HTMLSelectElement>('#timeframe,#chart-layout')) element.disabled = !active;
        $('#play').innerHTML = `${controlIcon(this.playing ? 'pause' : 'play')}<span>${this.playing ? 'Pause' : 'Play'}</span>`;
        $('#play').setAttribute('aria-label', this.playing ? 'Pause replay' : 'Play replay');
        if (this.playing) $<HTMLButtonElement>('#play').disabled = false;
        $<HTMLButtonElement>('#stop').disabled = !this.playing && !this.jumping;
        $<HTMLSelectElement>('#replay-interval').disabled = !tradable || this.mutationBusy || this.jumping;
        $('#fast-forward').setAttribute('aria-pressed', String(this.playing && Number(value('speed')) >= 10));
        $('#jump-status').hidden = !this.jumping;
        this.tradeTicket.refresh();
        this.charts?.refreshQuoteBars();
    }

    private renderPosition(): void {
        const position = this.view?.session.position;
        $('#position-badge').textContent = position ? `${position.side === 'buy' ? 'LONG' : 'SHORT'} ${position.qty}` : 'FLAT';
        $('#position-badge').className = position ? position.side === 'buy' ? 'positive' : 'negative' : 'muted';
        $('#position-content').innerHTML = position ? `<div class="position-pnl ${pnlClass(this.view!.session.account.unrealizedPnl)}">${signedMoney(this.view!.session.account.unrealizedPnl)}<small>Unrealized P&L</small></div><div class="detail-row"><span>Average entry</span><strong>${number(position.avgPrice)}</strong></div><div class="detail-row"><span>Stop loss / target</span><strong>${position.stopLoss ? number(position.stopLoss) : '—'} / ${position.takeProfit ? number(position.takeProfit) : '—'}</strong></div><div class="position-actions"><button class="quiet" data-action="partial-close">Partial close</button><button class="quiet" data-action="reverse">Reverse</button><button class="quiet" data-action="amend-position">Edit exits</button></div><button class="close-position" data-action="close">Close simulated position <kbd>X</kbd></button>` : '<div class="empty-position">No open simulated position</div>';
    }

    private renderOrders(): void {
        const working = this.view?.session.orders.filter((order) => order.status === 'working') ?? [];
        $('#working-count').textContent = String(working.length);
        $('#orders-content').innerHTML = working.length ? working.map((order) => `<div class="working-order"><div><strong class="${order.side === 'buy' ? 'positive' : 'negative'}">${order.side.toUpperCase()} ${order.qty}</strong> <span>${esc(order.type)}</span><small>${order.price ? number(order.price) : 'Next source bar'} · simulated</small></div><div><button class="quiet icon-button" data-action="amend-order" data-id="${esc(order.id)}" aria-label="Amend simulated order">✎</button><button class="quiet icon-button" data-action="cancel-order" data-id="${esc(order.id)}" aria-label="Cancel simulated order">×</button></div></div>`).join('') : '<div class="empty-position">No working simulated orders</div>';
    }

    private renderRules(): void {
        if (!this.view) return;
        const { session } = this.view;
        $('#rules-title').textContent = session.config.mode === 'prop' ? 'Evaluation rules' : 'Practice account';
        $('#rules-state').textContent = session.config.mode === 'prop' ? session.prop.status.toUpperCase() : 'FREE PRACTICE';
        $('#rules-state').className = `status-label ${session.prop.status === 'failed' ? 'negative' : 'positive'}`;
        const { rules } = session.config;
        const progress = (label: string, current: string, used: number, danger = false): string => `<div class="rule-meter"><div><span>${label}</span><strong>${current}</strong></div><div class="meter ${danger ? 'danger' : ''}"><span style="width:${clampPercent(used)}%"></span></div></div>`;
        $('#rules-content').innerHTML = session.config.mode === 'prop' ? `${session.prop.reason ? `<div class="breach-message">${esc(session.prop.reason)}<button class="text-button" data-action="restart">Start a fresh attempt ↗</button></div>` : ''}
            ${progress('Profit target', `${money(Math.max(0, session.account.netPnl))} / ${money(rules.profitTargetUsd)}`, session.account.netPnl / rules.profitTargetUsd * 100)}
            ${progress('Daily loss', `${money(session.prop.dailyLoss)} / ${money(rules.maxDailyLossUsd)}`, session.prop.dailyLoss / rules.maxDailyLossUsd * 100, true)}
            ${progress('Drawdown cushion', money(Math.max(0, session.account.equity - session.prop.drawdownFloor)), (session.account.equity - session.prop.drawdownFloor) / rules.maxDrawdownUsd * 100)}
            <div class="detail-row"><span>Drawdown floor</span><strong>${money(session.prop.drawdownFloor)}</strong></div><div class="detail-row"><span>Trading days</span><strong>${session.prop.tradingDays} / ${rules.minTradingDays}</strong></div><div class="detail-row"><span>Contract limit</span><strong>${rules.maxContracts}</strong></div><div class="detail-row"><span>Consistency</span><strong>${rules.consistencyPct === null ? 'Off' : `${number(session.prop.consistencyPct)}% / ${rules.consistencyPct}%`}</strong></div><p class="rule-model">${esc(rules.drawdownType.replaceAll('-', ' '))} · ${rules.drawdownLocksAtInitialBalance ? 'locks at initial balance' : 'no lock'}<br>Reset ${String(rules.dayResetHour).padStart(2, '0')}:00 ${esc(rules.dayResetTimezone)}</p>`
            : `<p class="practice-copy">Build your process without evaluation limits.</p><div class="detail-row"><span>Starting balance</span><strong>${money(session.config.initialBalance)}</strong></div><div class="detail-row"><span>Fees paid</span><strong>${money(session.account.fees)}</strong></div><div class="detail-row"><span>Max drawdown</span><strong>${money(session.account.maxDrawdown)}</strong></div><p class="rule-model">Simulated fills use source OHLC bars.<br>Ambiguous protective exits use stop first.</p>`;
    }

    private renderResults(): void {
        const session = this.view?.session;
        if (!session) return;
        const results = $('#results');
        $('#trading-details').hidden = this.activeTab !== 'trading';
        $('#account-details').hidden = this.activeTab !== 'rules';
        results.hidden = this.activeTab === 'trading';
        if (this.activeTab !== 'analytics') { this.replayEquityChart?.destroy(); this.replayEquityChart = null; results.setAttribute('aria-busy', 'false'); }
        if (this.activeTab === 'trading') {
            results.replaceChildren();
        } else if (this.activeTab === 'trades') {
            results.innerHTML = session.trades.length ? `<table class="trade-table"><thead><tr><th>Direction</th><th>Qty</th><th>Entry → exit</th><th>Exit time · UTC</th><th>Fees</th><th>Net P&L</th><th>Exit reason</th></tr></thead><tbody>${session.trades.slice(-500).reverse().map((trade) => `<tr><td><span class="direction-pill ${trade.side === 'buy' ? 'long' : 'short'}">${trade.side === 'buy' ? 'LONG' : 'SHORT'}</span></td><td>${trade.qty}</td><td>${number(trade.entryPrice)} <span class="muted">→</span> ${number(trade.exitPrice)}</td><td class="muted">${utc(trade.exitTime).replace(' UTC', '')}</td><td>${money(trade.fees)}</td><td class="${pnlClass(trade.netPnl)}">${signedMoney(trade.netPnl)}</td><td class="muted">${esc(trade.reason)}</td></tr>`).join('')}</tbody></table>`
                : '<div class="empty-small"><span class="empty-icon">⌁</span><strong>Every trade is a lesson.</strong>Your completed simulated trades will appear here.</div>';
        } else if (this.activeTab === 'bookmarks') {
            results.innerHTML = `<div class="bookmarks-heading"><p class="muted">Bookmark a decision point. Replay moves forward only; use a fresh attempt to revisit earlier bars.</p><button class="quiet" data-action="bookmark">＋ Add bookmark</button></div>${session.bookmarks.length ? session.bookmarks.map((bookmark) => `<div class="bookmark-row"><span>⚑</span><strong>${esc(bookmark.label)}</strong><time>${utc(bookmark.time)}</time></div>`).join('') : '<div class="empty-small">Save a moment worth revisiting.</div>'}`;
        } else if (this.activeTab === 'rules') {
            const rules = session.config.rules;
            results.innerHTML = `<div class="rule-summary"><div><span>Source data</span><strong>${esc(this.view!.dataset.source === 'demo' ? 'Synthetic seeded demo' : this.view!.dataset.source)} · ${esc(this.view!.dataset.symbol)}</strong><small>${esc(this.view!.dataset.schema)} · ${number(this.view!.dataset.barCount)} bars</small></div><div><span>Execution model</span><strong>Closed OHLC source bars</strong><small>Next-bar eligibility · ambiguous SL/TP: stop first</small></div><div><span>Round-trip commission</span><strong>${money(session.config.commissionPerContractSide * 2)} / contract</strong><small>${session.config.slippageTicks} tick slippage · ${session.config.spreadTicks} tick spread</small></div><div><span>Risk model</span><strong>${session.config.mode === 'prop' ? esc(rules.drawdownType.replaceAll('-', ' ')) : 'Unrestricted practice'}</strong><small>${session.config.mode === 'prop' ? `${money(rules.maxDrawdownUsd)} drawdown · ${money(rules.maxDailyLossUsd)} daily loss` : 'No evaluation pass / fail limits'}</small></div></div><p class="simulation-note">Bar simulation cannot reconstruct the tick path within a candle. Intrabar uncertainty uses the conservative stop-first model. Evaluation presets are generic editable examples.</p>`;
        } else this.renderAnalytics();
    }

    private renderAnalytics(): void {
        const session = this.view?.session;
        if (!session) return;
        if (!this.analytics && $('#results').querySelector('.local-replay-equity')) {
            $('#results').setAttribute('aria-busy', 'true');
            const refresh = $('#results').querySelector('[data-action=refresh-analytics]'); if (refresh) refresh.textContent = 'Updating\u2026';
            return;
        }
        const equityHost = $('#results').querySelector<HTMLElement>('.local-replay-equity');
        if (!equityHost) { this.replayEquityChart?.destroy(); this.replayEquityChart = null; }
        $('#results').setAttribute('aria-busy', 'false');
        if (!this.analytics) { $('#results').innerHTML = '<div class="empty-small">Advance the replay, then refresh your analytics.<button class="quiet" data-action="refresh-analytics">Calculate analytics</button></div>'; return; }
        const analysis = this.analytics;
        const curve = analysis.equityCurve.slice(-1000);
        $('#results').innerHTML = `${replayKeyStatsMarkup(analysis)}<div class="analytics-grid"><div><div class="plot-heading"><span>Equity curve</span><span>${money(session.account.equity)}</span></div><div class="local-replay-equity"><svg class="equity-chart" viewBox="0 0 700 110" role="img" aria-label="Revealed simulated account equity curve" preserveAspectRatio="none"><path d="${linePath(curve.map((point) => point.equity))}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" /></svg></div><div class="plot-labels"><span>${curve.length ? utc(curve[0]!.time).slice(0, 10) : 'No history'}</span><span>${curve.length ? utc(curve.at(-1)!.time).slice(0, 10) : ''}</span></div></div><div><div class="plot-heading"><span>Daily performance</span><span>UTC / trading days</span></div><div class="daily-bars">${analysis.byDay.length ? analysis.byDay.slice(-30).map((day) => `<div class="daily-row"><span>${esc(day.day)}</span><div class="daily-track"><i class="${day.pnl < 0 ? 'loss' : ''}" style="width:${clampPercent(Math.abs(day.pnl) / Math.max(1, ...analysis.byDay.map((item) => Math.abs(item.pnl))) * 100)}%"></i></div><strong class="${pnlClass(day.pnl)}">${signedMoney(day.pnl)}</strong></div>`).join('') : '<p class="muted">No closed trades yet.</p>'}</div></div></div>
            <div class="monte-carlo-header"><div><strong>Monte Carlo</strong><span>Seeded resampling of completed trades · not a forecast</span></div><button class="quiet" data-action="monte-carlo">${this.monteCarlo ? 'Rerun simulation' : 'Run 500 simulations'}</button></div>${this.monteCarlo ? this.renderMonteCarlo(this.monteCarlo) : ''}`;
        if (equityHost && this.replayEquityChart) {
            $('.local-replay-equity').replaceWith(equityHost); this.replayEquityChart.update(curve, session.config.initialBalance);
        } else this.replayEquityChart = mountReplayEquityChart($('.local-replay-equity'), curve, session.config.initialBalance);
    }

    private renderMonteCarlo(result: MonteCarlo): string {
        const paths = result.paths;
        const values = paths.flatMap((point) => [point.p05, point.median, point.p95]);
        const low = Math.min(...values); const span = Math.max(...values) - low || 1;
        const line = (field: 'p05' | 'median' | 'p95'): string => paths.map((point, index) => `${index ? 'L' : 'M'}${(index / Math.max(1, paths.length - 1) * 700).toFixed(2)},${(105 - ((point[field] - low) / span) * 95).toFixed(2)}`).join(' ');
        return `<div class="mc-results"><div class="mc-stats"><span>Median final <strong>${money(result.medianFinalBalance)}</strong></span><span>5th–95th final <strong>${money(result.p05FinalBalance)} – ${money(result.p95FinalBalance)}</strong></span><span>Profit probability <strong>${percent(result.probabilityOfProfit)}</strong></span><span>Ruin probability <strong>${percent(result.probabilityOfRuin)}</strong></span><span>95th drawdown <strong>${money(result.p95Drawdown)}</strong></span></div><svg class="mc-chart" viewBox="0 0 700 110" preserveAspectRatio="none" role="img" aria-label="Monte Carlo fifth percentile, median and ninety-fifth percentile balance paths"><path d="${line('p05')}" class="mc-bound" /><path d="${line('p95')}" class="mc-bound" /><path d="${line('median')}" class="mc-median" /></svg><p class="muted">${result.runs} runs · ${result.tradesPerRun} trades / run · seed ${result.seed}. Resamples closed trades only. Ruin means a sampled cash balance at or below zero. Intrabar drawdown is not modeled; these paths do not certify evaluation-rule passage.</p></div>`;
    }

    private loadAnalytics(): Promise<void> { return this.analyticsRefresh.refresh(); }

    private play(): void {
        if (this.runtimeBlocked || this.jumping || !this.view || this.view.session.status !== 'paused' || this.playing) return;
        this.replayPresentation.setOpen(true);
        this.playback.start(); this.updateControls();
    }

    private pause(): void { this.playback.stop(); this.jumping = false; this.jumpGeneration++; this.updateControls(); }

    private async action(action: string, data: DOMStringMap): Promise<void> {
        switch (action) {
            case 'sessions': this.pause(); await this.charts.flush(); location.hash = 'sessions'; break;
            case 'chart': this.pause(); await this.charts.flush(); location.hash = ''; break;
            case 'data': this.pause(); this.dataDialog(); break;
            case 'reload': location.reload(); break;
            case 'new-session': this.pause(); this.newSessionDialog(); break;
            case 'close-modal': $<HTMLDialogElement>('#modal').close(); break;
            case 'open-session': if (data.id) { await this.openSession(data.id); location.hash = ''; } break;
            case 'play': if (this.playing || this.jumping) this.pause(); else this.play(); break;
            case 'stop': this.pause(); break;
            case 'replay-close': this.replayPresentation.setOpen(false); break;
            case 'fast-forward':
                if (!this.jumping) { $<HTMLSelectElement>('#speed').value = this.playing && Number(value('speed')) >= 10 ? '1' : '10'; this.play(); this.updateControls(); } break;
            case 'step': this.replayPresentation.setOpen(true); this.pause(); await this.command({ type: 'advance', count: replayIntervalCount(value('replay-interval')) }); break;
            case 'skip': this.replayPresentation.setOpen(true); this.pause(); await this.command({ type: 'advance', count: 10 }); break;
            case 'buy': case 'sell': await this.place(action); break;
            case 'close': this.pause(); await this.command({ type: 'close' }); break;
            case 'reverse': this.pause(); await this.command({ type: 'reverse' }); break;
            case 'partial-close': this.pause(); this.partialCloseDialog(); break;
            case 'amend-position': this.pause(); this.amendDialog(); break;
            case 'amend-order': this.pause(); this.amendDialog(data.id); break;
            case 'cancel-order': this.pause(); if (data.id) await this.command({ type: 'cancel', orderId: data.id }); break;
            case 'rename': this.simpleDialog('Rename session', 'rename-form', 'Session name', this.view?.session.config.name ?? '', 'Save name'); break;
            case 'save': { await this.charts.flush(); this.toast('Chart layout, indicators and drawings saved with this session.'); break; }
            case 'bookmark': this.pause(); if (this.view) this.simpleDialog('Bookmark this moment', 'bookmark-form', 'A short label', '', 'Save bookmark'); break;
            case 'go-to': this.replayPresentation.setOpen(true); this.pause(); this.goToDialog(); break;
            case 'replay-jump-preset':
                if (data.preset === 'london' || data.preset === 'new-york' || data.preset === 'next-day') {
                    this.replayPresentation.setOpen(true); this.pause(); this.goToDialog(); await this.jumpToPreset(data.preset);
                } break;
            case 'jump-preset': if (data.preset === 'london' || data.preset === 'new-york' || data.preset === 'next-day') await this.jumpToPreset(data.preset); break;
            case 'clone': case 'restart': await this.clone(action === 'restart'); break;
            case 'export': await this.exportSession(); break;
            case 'import-session': this.importSession(); break;
            case 'demo': await this.createDemo(); break;
            case 'quote-download': await this.downloadQuote(); break;
            case 'tab': this.activeTab = data.tab ?? 'trades'; this.updateTabs(); this.renderResults(); if (this.activeTab === 'analytics') await this.loadAnalytics(); break;
            case 'refresh-analytics': await this.loadAnalytics(); break;
            case 'monte-carlo': await this.calculateMonteCarlo(); break;
        }
    }

    private updateTabs(): void {
        for (const tab of document.querySelectorAll<HTMLElement>('.results-tabs [data-tab]')) {
            const active = tab.dataset.tab === this.activeTab; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active));
        }
    }

    private updatePriceVisibility(): void { this.tradeTicket.refresh(); }

    private async place(side: 'buy' | 'sell'): Promise<void> {
        if (!this.view) return;
        const order = this.tradeTicket.draft(side); if (!order) return;
        const generation = this.sessionGeneration; const sessionId = this.view.session.id;
        this.pause();
        await this.command({ type: 'place', order });
        if (generation === this.sessionGeneration && this.view?.session.id === sessionId) this.tradeTicket.retireDraft(order);
        this.toast(`Simulated ${side} order submitted. Advance a source bar to execute.`);
    }

    private async clone(restart: boolean): Promise<void> {
        if (!this.view) return;
        this.pause(); await this.commandQueue;
        const id = this.view.session.id; const generation = this.sessionGeneration;
        const layout = this.charts.snapshot();
        if (layout) await this.command({ type: 'layout', layout });
        if (generation !== this.sessionGeneration) return;
        const view = await this.api.post<SessionView>(`/api/sessions/${encodeURIComponent(id)}/clone`, {
            name: `${this.view.session.config.name} ${restart ? '· fresh attempt' : '· copy'}`, restart,
        }, this.sessionController.signal);
        if (generation !== this.sessionGeneration) return;
        await this.refreshIndex(); await this.openSession(view.session.id);
        this.toast(restart ? 'Fresh attempt created. Your previous attempt is preserved.' : 'Session cloned with its current replay state.');
    }

    private async exportSession(): Promise<void> {
        if (!this.view) return;
        this.pause(); await this.commandQueue;
        const id = this.view.session.id; const generation = this.sessionGeneration;
        const layout = this.charts.snapshot(); if (layout) await this.command({ type: 'layout', layout });
        if (generation !== this.sessionGeneration) return;
        const backup: unknown = await this.api.get(`/api/sessions/${encodeURIComponent(id)}/export`, this.sessionController.signal);
        if (generation !== this.sessionGeneration) return;
        downloadJson(`replay-${id}.json`, backup); this.toast('Session backup exported without provider credentials.');
    }

    private importSession(): void {
        const input = $<HTMLInputElement>('#session-import');
        input.value = '';
        input.onchange = (): void => { this.run(async () => {
            const file = input.files?.[0]; if (!file) return;
            if (file.size > MAX_BACKUP_BYTES) throw new Error('Session backup is too large. Maximum: 64 MiB.');
            const backup: unknown = JSON.parse(await file.text());
            const view = await this.api.post<SessionView>('/api/sessions/import', backup);
            await this.refreshIndex(); await this.openSession(view.session.id); this.toast('Backup imported as a separate session.');
        }); };
        input.click();
    }

    private async calculateMonteCarlo(): Promise<void> {
        if (!this.view) return;
        this.pause(); const generation = this.sessionGeneration; const revision = this.view.session.revision;
        const result = await this.api.post<MonteCarlo>(`/api/sessions/${encodeURIComponent(this.view.session.id)}/monte-carlo`, { runs: 500, seed: 42 }, this.sessionController.signal);
        if (generation !== this.sessionGeneration || revision !== this.view?.session.revision) return;
        this.monteCarlo = result; if (this.activeTab === 'analytics') this.renderAnalytics();
    }

    private showDialog(title: string, body: string, wide = false): void {
        const modal = $<HTMLDialogElement>('#modal');
        if (modal.open) modal.close();
        this.modalGeneration++;
        modal.classList.toggle('wide-modal', wide);
        $('#modal-content').innerHTML = `<div class="modal-heading"><div><span class="eyebrow">LOCAL REPLAY STUDIO</span><h2 id="modal-title">${esc(title)}</h2></div><button class="quiet icon-button" data-action="close-modal" aria-label="Close dialog">×</button></div><div id="dialog-error" class="dialog-error" role="alert" hidden></div>${body}`;
        modal.showModal();
    }

    private simpleDialog(title: string, formId: string, label: string, initial: string, button: string): void {
        this.showDialog(title, `<form id="${formId}" class="modal-form"><label>${esc(label)}<input id="simple-value" maxlength="120" value="${esc(initial)}" required autofocus /></label><div class="modal-actions"><button type="button" class="quiet" data-action="close-modal">Cancel</button><button class="primary" type="submit">${esc(button)}</button></div></form>`);
    }

    private partialCloseDialog(): void {
        const qty = this.view?.session.position?.qty; if (!qty) return;
        this.showDialog('Close part of your position', `<form id="partial-close-form" class="modal-form"><p class="muted">This simulated exit becomes eligible on the next source bar.</p><label>Contracts to close<input id="close-qty" type="number" min="1" max="${qty}" step="1" value="1" required /></label><div class="modal-actions"><button type="button" class="quiet" data-action="close-modal">Cancel</button><button class="primary">Submit simulated close</button></div></form>`);
    }

    private amendDialog(orderId?: string): void {
        const order = orderId ? this.view?.session.orders.find((item) => item.id === orderId) : undefined;
        const source = order ?? this.view?.session.position; if (!source) return;
        this.showDialog(order ? 'Amend simulated order' : 'Edit protective exits', `<form id="amend-form" data-order-id="${esc(orderId ?? '')}" class="modal-form"><p class="muted">Leave an exit blank to remove it. Changes cannot fill retrospectively.</p>${order && order.type !== 'market' ? `<label>Order price<input id="amend-price" type="number" min="0.25" step="0.25" value="${order.price ?? ''}" required /></label>` : ''}<div class="two-fields"><label>Stop loss<input id="amend-stop" type="number" step="0.25" min="0.25" value="${source.stopLoss ?? ''}" /></label><label>Take profit<input id="amend-take" type="number" step="0.25" min="0.25" value="${source.takeProfit ?? ''}" /></label></div><div class="modal-actions"><button type="button" class="quiet" data-action="close-modal">Cancel</button><button class="primary">Save simulated exits</button></div></form>`);
    }

    private goToDialog(): void {
        if (!this.view) return;
        const { dataset } = this.view;
        const last = dataset.end - dataset.intervalMs;
        const next = Math.min(last, this.charts.cursorTime === null ? dataset.start : this.charts.cursorTime + dataset.intervalMs);
        this.showDialog('Go to', `<form id="go-to-form" class="modal-form"><div class="session-jumps"><button type="button" class="quiet" data-action="jump-preset" data-preset="london">London <small>08:00 local</small></button><button type="button" class="quiet" data-action="jump-preset" data-preset="new-york">New York <small>09:30 local</small></button><button type="button" class="quiet" data-action="jump-preset" data-preset="next-day">Next day <small>Same local time</small></button></div><p class="field-note">London and New York use the next weekday opening, with daylight saving. Next day uses the selected time zone. Missing candles land on the next available candle.</p><div class="two-fields"><label>Destination · date & time<input id="go-to-time" type="datetime-local" step="1" required min="${wallTimeInput(next, this.replayZone)}" max="${wallTimeInput(last, this.replayZone)}" value="${wallTimeInput(next, this.replayZone)}" data-zone="${this.replayZone}" /></label><label>Time zone<select id="go-to-zone">${this.zoneOptions()}</select></label></div><p class="muted">Every skipped candle still processes orders, stops and account rules. Long jumps run in small batches; press Stop or Space to pause. Choose a new session to start earlier.</p><div class="modal-actions"><button type="button" class="quiet" data-action="close-modal">Cancel</button><button class="primary">Go to time</button></div></form>`);
    }

    private zoneOptions(): string {
        return REPLAY_ZONES.map(({ id, label }) => `<option value="${id}"${id === this.replayZone ? ' selected' : ''}>${label}</option>`).join('');
    }

    private updateStartTime(reset: boolean): void {
        const dataset = this.bootstrap?.datasets.find((item) => item.id === value('new-dataset'));
        if (!dataset) return;
        const input = $<HTMLInputElement>('#new-start-time'); const zone = value('new-zone');
        let time = dataset.start;
        if (!reset && input.value) {
            try { time = parseWallTime(input.value, input.dataset.zone ?? this.replayZone); } catch { /* A zone change resets an invalid wall time. */ }
        }
        this.replayZone = zone; input.dataset.zone = zone;
        input.min = wallTimeInput(dataset.start, zone); input.max = wallTimeInput(dataset.end - dataset.intervalMs, zone);
        input.value = wallTimeInput(time, zone);
        $('#new-data-range').textContent = `Cached: ${input.min.replace('T', ' ')} to ${input.max.replace('T', ' ')} (${REPLAY_ZONES.find(item => item.id === zone)?.label}). Replay starts at the first available candle at or after your chosen time.`;
    }

    private updateGoToZone(): void {
        if (!this.view) return;
        const input = $<HTMLInputElement>('#go-to-time'); const zone = value('go-to-zone');
        const time = parseWallTime(input.value, input.dataset.zone ?? this.replayZone);
        this.replayZone = zone; input.dataset.zone = zone;
        const { dataset } = this.view;
        const next = Math.min(dataset.end - dataset.intervalMs, this.charts.cursorTime === null ? dataset.start : this.charts.cursorTime + dataset.intervalMs);
        input.min = wallTimeInput(next, zone); input.max = wallTimeInput(dataset.end - dataset.intervalMs, zone);
        input.value = wallTimeInput(time, zone);
    }

    private async jumpToPreset(preset: JumpPreset): Promise<void> {
        if (!this.view) return;
        const zone = value('go-to-zone'); this.replayZone = zone;
        const after = this.charts.cursorTime ?? this.view.dataset.start - this.view.dataset.intervalMs;
        const target = nextSessionTime(after, preset, zone);
        await this.jumpToTime(target.time);
    }

    /** Resolve cached timestamps first, then retain normal order and account processing. */
    private async jumpToTime(time: number): Promise<void> {
        if (!this.view || this.view.session.status !== 'paused' || this.jumping) return;
        this.pause();
        const view = this.view; const sessionGeneration = this.sessionGeneration;
        const jumpGeneration = ++this.jumpGeneration;
        if (time < view.dataset.start || time >= view.dataset.end) throw new Error('That time is outside this cached dataset. Choose a cached date or add that range in Data & settings.');
        $<HTMLDialogElement>('#modal').close();
        this.jumping = true; this.updateControls();
        $('#jump-status').textContent = 'Finding time…';
        const stopped = (): boolean => this.disposed || this.runtimeBlocked || jumpGeneration !== this.jumpGeneration || sessionGeneration !== this.sessionGeneration;
        try {
            await this.charts.flush(); await this.commandQueue;
            if (stopped()) return;
            const target = await this.api.get<SessionNavigation>(`/api/sessions/${encodeURIComponent(view.session.id)}/navigation?time=${time}`, this.sessionController.signal);
            if (stopped()) return;
            const result = await runReplayJump(target.targetIndex, {
                current: () => this.view?.session ?? view.session,
                shouldStop: stopped,
                advance: (count) => this.command({ type: 'advance', count }),
                progress: (cursor) => { if (!stopped()) $('#jump-status').textContent = `Jumping ${number(cursor - target.currentIndex)} / ${number(target.targetIndex - target.currentIndex)} bars`; },
            });
            if (sessionGeneration === this.sessionGeneration && !this.disposed && !this.runtimeBlocked) {
                this.toast(result === 'reached' ? `Replay moved to ${utc(target.targetTime)}.` : 'Jump stopped. Processed candles and account changes are saved.');
            }
        } finally {
            if (jumpGeneration === this.jumpGeneration) { this.jumping = false; this.updateControls(); }
        }
    }

    private newSessionDialog(): void {
        const datasets = this.bootstrap?.datasets ?? [];
        if (!datasets.length) {
            this.showDialog('Choose your starting point', `<div class="modal-form"><p class="modal-lead">Every good session starts with the right data.</p><p class="muted">Import a contract's OHLCV file, request a data cost estimate, or explore with deterministic synthetic demo data.</p><button class="primary" data-action="demo">Create synthetic demo data</button><button class="quiet" data-action="data">Open data & settings ↗</button></div>`); return;
        }
        this.showDialog('Create a session', `<form id="new-session-form" class="modal-form"><div class="two-fields"><label>Session name<input id="new-name" value="${esc(`Morning practice ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)}" maxlength="120" required /></label><label>Account preset<select id="preset"><option value="50">Generic 50K</option><option value="100">Generic 100K</option><option value="custom">Custom</option></select></label></div><label>Cached dataset<select id="new-dataset">${datasets.map((dataset) => `<option value="${esc(dataset.id)}">${esc(dataset.name)} · ${esc(dataset.symbol)} · ${dataset.schema} · ${dataset.source === 'demo' ? 'SYNTHETIC' : dataset.source}</option>`).join('')}</select></label><div class="two-fields"><label>Replay start: date & time<input id="new-start-time" type="datetime-local" step="1" required /></label><label>Time zone<select id="new-zone">${this.zoneOptions()}</select></label></div><p id="new-data-range" class="field-note"></p><div class="two-fields"><label>Session mode<select id="new-mode"><option value="practice">Free practice</option><option value="prop">Prop evaluation</option></select></label><label>Initial balance · USD<input id="new-balance" type="number" min="1" step="1" value="50000" required /></label></div><details open><summary>Evaluation rules <span>Generic editable example</span></summary><div class="three-fields"><label>Profit target · USD<input id="rule-target" type="number" min="0" value="3000" required /></label><label>Daily loss · USD<input id="rule-daily" type="number" min="0" value="1000" required /></label><label>Max drawdown · USD<input id="rule-drawdown" type="number" min="0" value="2000" required /></label></div><div class="two-fields"><label>Drawdown model<select id="rule-type"><option value="trailing-eod">Trailing · end of day</option><option value="trailing-intraday">Trailing · intraday</option><option value="static">Static</option></select></label><label>Consistency limit · %<input id="rule-consistency" type="number" min="1" max="100" placeholder="Off" /></label></div><div class="three-fields"><label>Minimum trading days<input id="rule-days" type="number" min="0" max="365" value="5" required /></label><label>Max contracts<input id="rule-contracts" type="number" min="1" max="1000" value="5" required /></label><label>Reset hour · 0–23<input id="rule-hour" type="number" min="0" max="23" value="17" required /></label></div><label>Trading day timezone<input id="rule-zone" value="America/Chicago" required /></label><div class="check-row"><label><input id="rule-lock" type="checkbox" checked /> Lock drawdown at initial balance</label><label><input id="rule-flat" type="checkbox" checked /> Require flat to pass</label></div></details><details><summary>Fill costs</summary><div class="three-fields"><label>Commission / side · USD<input id="new-fee" type="number" min="0" step="0.01" value="2.50" required /></label><label>Slippage · ticks<input id="new-slippage" type="number" min="0" step="0.5" value="1" required /></label><label>Spread · ticks<input id="new-spread" type="number" min="0" step="0.5" value="0" required /></label></div></details><div class="modal-actions"><button type="button" class="quiet" data-action="close-modal">Cancel</button><button class="primary">Open practice workspace ↗</button></div></form>`, true);
        const preferred = this.view?.dataset.id ?? datasets.find(dataset => dataset.source === 'databento')?.id ?? datasets[0]!.id;
        $<HTMLSelectElement>('#new-dataset').value = preferred;
        this.updateStartTime(true);
    }

    private applyPreset(preset: string): void {
        if (preset === 'custom') return;
        const large = preset === '100';
        for (const [id, next] of Object.entries({ 'new-balance': large ? 100000 : 50000, 'rule-target': large ? 6000 : 3000,
            'rule-daily': large ? 2000 : 1000, 'rule-drawdown': large ? 3000 : 2000, 'rule-contracts': large ? 10 : 5 })) $<HTMLInputElement>(`#${id}`).value = String(next);
    }

    private dataDialog(): void {
        this.showDialog('Data & settings', `<div class="data-settings"><div class="provider-heading"><span class="provider-logo">D</span><div><h3>Databento</h3><p>Exact futures contracts · official historical API</p></div><span id="provider-status" class="configured-badge ${this.bootstrap?.provider.configured ? 'configured' : ''}">${this.bootstrap?.provider.configured ? 'KEY CONFIGURED' : 'NO KEY'}</span></div><form id="provider-key-form"><label>API key<div class="key-row"><input id="provider-key" type="password" autocomplete="off" spellcheck="false" placeholder="Enter key to store securely on this computer" required /><button class="quiet" type="submit">Save key</button></div></label><p class="field-note">Protected for your Windows user. Never included in session exports.</p></form><hr /><form id="provider-quote-form"><div class="subheading"><h3>Request a cost preview</h3><span class="zero-budget">$0 ESTIMATE REQUIRED</span></div><p class="muted">Only an estimated $0 quote enables a separate download. The server re-quotes the exact scope first. The provider has no atomic billing cap: a $0 estimate cannot guarantee a zero invoice. No automatic downloads, continuous contracts or rolls.</p><div class="two-fields"><label>Raw contract symbol<input id="provider-symbol" value="NQZ6" placeholder="e.g. NQZ6" pattern="(?:MNQ|MES|NQ|ES)[FGHJKMNQUVXZ][0-9]{1,2}" required /></label><label>Native OHLCV schema<select id="provider-schema"><option value="ohlcv-1m">ohlcv-1m · one-minute bars</option><option value="ohlcv-1s">ohlcv-1s · one-second bars</option></select></label></div><div class="two-fields"><label>Start · UTC<input id="provider-start" type="datetime-local" value="2026-10-01T13:30" required /></label><label>End · UTC<input id="provider-end" type="datetime-local" value="2026-10-01T20:00" required /></label></div><div class="preview-actions"><span>GLBX.MDP3 · raw symbol</span><button class="quiet" type="submit">Preview cost estimate</button></div></form><div id="quote-result"></div><hr /><div class="subheading"><h3>Import your own data</h3><span class="muted">CSV / JSONL</span></div><form id="dataset-import-form"><div class="two-fields"><label>Dataset name<input id="import-name" placeholder="My replay data" maxlength="120" /></label><label>Raw contract symbol<input id="import-symbol" value="NQZ6" pattern="(?:MNQ|MES|NQ|ES)[FGHJKMNQUVXZ][0-9]{1,2}" required /></label></div><div class="two-fields"><label>Schema<select id="import-schema"><option value="ohlcv-1m">ohlcv-1m</option><option value="ohlcv-1s">ohlcv-1s</option></select></label><label>File format<select id="import-format"><option value="csv">CSV</option><option value="jsonl">JSONL</option></select></label></div><label>Choose a file<input id="dataset-file" type="file" accept=".csv,.jsonl,.ndjson,.json,.txt" /></label><label>Or paste OHLCV data<textarea id="import-text" rows="3" placeholder="time,open,high,low,close,volume&#10;2026-10-01T13:30:00Z,25000,25001,24999,25000.5,100"></textarea></label><p class="field-note">UTC timestamps or epoch milliseconds. Required: time, open, high, low, close and volume.</p><div class="preview-actions"><button class="text-button" type="button" data-action="demo">Use seeded synthetic demo ↗</button><button class="primary">Import & cache data</button></div></form><div class="cached-data"><div class="subheading"><h3>Cached datasets</h3><span class="muted">${this.bootstrap?.datasets.length ?? 0}</span></div>${(this.bootstrap?.datasets ?? []).map((dataset) => `<div class="dataset-row"><div><strong>${esc(dataset.name)}</strong><small>${esc(dataset.symbol)} · ${esc(dataset.schema)} · ${number(dataset.barCount)} bars</small></div><span class="source-badge ${dataset.source === 'demo' ? 'synthetic' : ''}">${dataset.source === 'demo' ? 'SYNTHETIC' : esc(dataset.source.toUpperCase())}</span></div>`).join('') || '<p class="muted">No cached datasets yet.</p>'}</div></div>`, true);
    }

    private invalidateQuote(): void {
        this.quote = null; this.quoteGeneration++;
        const result = document.querySelector('#quote-result'); if (result) result.innerHTML = '';
    }

    private providerRequest(): ProviderRequest {
        return { dataset: 'GLBX.MDP3', symbol: value('provider-symbol').trim().toUpperCase(),
            schema: value('provider-schema') as ProviderRequest['schema'],
            start: new Date(`${value('provider-start')}Z`).toISOString(), end: new Date(`${value('provider-end')}Z`).toISOString() };
    }

    private async previewQuote(): Promise<void> {
        this.invalidateQuote();
        const generation = this.quoteGeneration;
        const result = await this.api.post<ProviderQuote>('/api/provider/quote', this.providerRequest());
        if (generation !== this.quoteGeneration || !$<HTMLDialogElement>('#modal').open) return;
        if (result.estimatedCostUsd !== 0 || result.maxCostUsd !== 0) throw new Error('Download blocked: this cost estimate is not exactly $0.');
        this.quote = result;
        $('#quote-result').innerHTML = `<div class="quote-card"><div><strong>Estimated cost: $0.00</strong><span>${esc(result.request.symbol)} · ${esc(result.request.schema)}<br>${esc(result.request.start)} → ${esc(result.request.end)}</span><small>Expires ${esc(result.expiresAt)}. Exact scope is re-quoted before download. The provider has no atomic billing cap; a zero invoice is not guaranteed.</small></div><button class="primary" data-action="quote-download">Download after $0 re-quote</button></div>`;
    }

    private async downloadQuote(): Promise<void> {
        const quote = this.quote; if (!quote) return;
        this.invalidateQuote();
        const dataset = await this.api.post<DatasetMeta>('/api/provider/download', { quoteId: quote.quoteId });
        await this.refreshIndex(); this.toast(`Cached ${dataset.name}. Create a session to replay it.`);
        this.newSessionDialog();
    }

    private async createDemo(): Promise<void> {
        await this.api.post<DatasetMeta>('/api/datasets/demo', {});
        await this.refreshIndex(); this.newSessionDialog();
        this.toast('Deterministic synthetic demo cached. This is not recorded market data.');
    }

    private async submit(form: HTMLFormElement): Promise<void> {
        const submit = form.querySelector<HTMLButtonElement>('[type="submit"],button:not([type])');
        if (submit?.disabled) return;
        if (submit) submit.disabled = true;
        try {
            switch (form.id) {
                case 'new-session-form': await this.createSession(); break;
                case 'provider-key-form': {
                    const input = $<HTMLInputElement>('#provider-key');
                    const request = this.api.post<{ configured: boolean }>('/api/provider/settings', { apiKey: input.value });
                    input.value = '';
                    await request;
                    if (this.bootstrap) this.bootstrap.provider.configured = true;
                    const status = document.querySelector('#provider-status'); if (status) { status.textContent = 'KEY CONFIGURED'; status.classList.add('configured'); }
                    this.toast('API key protected for your current Windows user.'); break;
                }
                case 'provider-quote-form': await this.previewQuote(); break;
                case 'dataset-import-form': await this.importDataset(); break;
                case 'rename-form': await this.command({ type: 'rename', name: value('simple-value').trim() }); $<HTMLDialogElement>('#modal').close(); break;
                case 'bookmark-form': await this.command({ type: 'bookmark', label: value('simple-value').trim() }); $<HTMLDialogElement>('#modal').close(); this.toast('Replay bookmark saved.'); break;
                case 'partial-close-form': await this.command({ type: 'close', qty: numeric('close-qty') }); $<HTMLDialogElement>('#modal').close(); break;
                case 'amend-form': {
                    const command: Command = { type: 'amend', stopLoss: optionalNumber('amend-stop') ?? null, takeProfit: optionalNumber('amend-take') ?? null };
                    if (form.dataset.orderId) command.orderId = form.dataset.orderId;
                    if (document.querySelector('#amend-price')) command.price = numeric('amend-price');
                    await this.command(command); $<HTMLDialogElement>('#modal').close(); break;
                }
                case 'go-to-form': await this.jumpToTime(parseWallTime(value('go-to-time'), value('go-to-zone'))); break;
            }
        } finally { if (submit?.isConnected) submit.disabled = false; }
    }

    private async createSession(): Promise<void> {
        const dataset = this.bootstrap?.datasets.find((item) => item.id === value('new-dataset'));
        if (!dataset) throw new Error('Choose a cached dataset.');
        const config: SessionCreateConfig = {
            name: value('new-name').trim(), datasetId: dataset.id, mode: value('new-mode') as SessionConfig['mode'],
            initialBalance: numeric('new-balance'), commissionPerContractSide: numeric('new-fee'),
            slippageTicks: numeric('new-slippage'), spreadTicks: numeric('new-spread'),
            startTime: parseWallTime(value('new-start-time'), value('new-zone')),
            rules: { ...DEFAULT_RULES, profitTargetUsd: numeric('rule-target'), maxDailyLossUsd: numeric('rule-daily'),
                maxDrawdownUsd: numeric('rule-drawdown'), drawdownType: value('rule-type') as SessionConfig['rules']['drawdownType'],
                consistencyPct: optionalNumber('rule-consistency') ?? null, minTradingDays: numeric('rule-days'),
                maxContracts: numeric('rule-contracts'), dayResetHour: numeric('rule-hour'), dayResetTimezone: value('rule-zone').trim(),
                drawdownLocksAtInitialBalance: $<HTMLInputElement>('#rule-lock').checked, requireFlatToPass: $<HTMLInputElement>('#rule-flat').checked },
        };
        const view = await this.api.post<SessionView>('/api/sessions', config);
        $<HTMLDialogElement>('#modal').close(); await this.refreshIndex(); await this.openSession(view.session.id); location.hash = '';
    }

    private async importDataset(): Promise<void> {
        const file = $<HTMLInputElement>('#dataset-file').files?.[0];
        if (file && file.size > 16 * 1024 * 1024) throw new Error('Data file is too large. Maximum: 16 MB.');
        const request = { name: value('import-name').trim() || undefined, symbol: value('import-symbol').trim().toUpperCase(),
            schema: value('import-schema'), format: value('import-format'), text: file ? await file.text() : value('import-text') };
        if (!request.text.trim()) throw new Error('Choose a data file or paste OHLCV data.');
        await this.api.post<DatasetMeta>('/api/datasets/import', request); await this.refreshIndex();
        this.newSessionDialog(); this.toast('Data imported and cached locally.');
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true; this.pause(); clearTimeout(this.toastTimer);
        this.runtime.dispose(); this.runtimeMessage.remove();
        this.sessionController.abort(); this.sessionGeneration++; this.analyticsRefresh.destroy();
        this.replayEquityChart?.destroy(); this.replayEquityChart = null;
        this.charts.destroy(); this.disposers.splice(0).forEach((dispose) => dispose());
        $<HTMLInputElement>('#session-import').onchange = null;
    }
}

export function startReplayStudio(): void {
    const studio = new ReplayStudio();
    void studio.start().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Could not start the local application.';
        $('#connection').textContent = 'Local server unavailable';
        $('#chart-empty').innerHTML = `<h2>Could not open your workspace.</h2><p>${esc(message)}</p><p>Start the local launcher, then reload this page.</p><button class="primary" data-action="reload">Reload workspace</button>`;
    });
}
