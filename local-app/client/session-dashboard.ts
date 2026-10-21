import './session-dashboard.css';
import type { DatasetMeta, SessionSummary } from '../shared/types';
import { mountDesktopUpdates } from './desktop-updates';

type DashboardSession = SessionSummary & { startIndex?: number; endIndex?: number; startTime?: number; endTime?: number };
export interface SessionDashboardCallbacks {
    newSession(): void;
    openSession(id: string): void;
    openChart(): void;
    openStats?(): void;
    openData(): void;
    importSession(): void;
}
export interface SessionDashboardSnapshot {
    sessions: DashboardSession[];
    datasets: DatasetMeta[];
    selectedId?: string;
    loading?: boolean;
    error?: string;
}
export interface SessionDashboard {
    update(snapshot: SessionDashboardSnapshot): void;
    destroy(): void;
}

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
const statusLabel: Record<SessionSummary['status'], string> = { paused: 'Paused', completed: 'Completed', passed: 'Passed', failed: 'Failed' };
const cash = (value: number): string => Number.isFinite(value) ? currency.format(value) : '—';
const utcDate = (value: number): string => Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? `${dateTime.format(value)} UTC` : '—';
const updatedTime = (session: DashboardSession): number => Date.parse(session.updatedAt) || 0;
let dashboardSequence = 0;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag); result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
}
function button(text: string, className: string, action: () => void): HTMLButtonElement {
    const result = node('button', className, text); result.type = 'button'; result.addEventListener('click', action); return result;
}
function total(sessions: DashboardSession[], field: 'netPnl' | 'trades'): number | null {
    let sum = 0;
    for (const session of sessions) {
        if (!Number.isFinite(session[field])) return null;
        sum += session[field];
    }
    return Number.isFinite(sum) ? sum : null;
}
function progress(session: DashboardSession): number | null {
    const start = session.startIndex ?? 0, end = session.endIndex ?? session.barCount;
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(session.cursor) || end <= start) return null;
    return Math.max(0, Math.min(100, (session.cursor - start + 1) / (end - start) * 100));
}

/** A session library using saved summaries only; navigation and mutations belong to the host. */
export function mountSessionDashboard(host: HTMLElement, callbacks: SessionDashboardCallbacks): SessionDashboard {
    const hadHostClass = host.classList.contains('session-dashboard-host'); host.classList.add('session-dashboard-host');
    let snapshot: SessionDashboardSnapshot = { sessions: [], datasets: [], loading: true };
    let disposed = false, query = '', mode = 'all', status = 'all', sort = 'updated';
    const root = node('section', 'session-dashboard'); root.setAttribute('aria-label', 'Backtesting Dashboard');
    const guarded = (action: () => void) => () => { if (!disposed) action(); };
    const topbar = node('header', 'sd-topbar');
    const brand = node('div', 'sd-brand'); brand.append(node('span', 'sd-brand-mark', 'V'), node('span', '', 'Vela'));
    const workspace = node('div', 'sd-workspace'); workspace.append(node('span', '', 'Local replay studio'), node('span', 'sd-workspace-note', 'Saved on this computer'));
    topbar.append(brand, workspace, node('span', 'sd-simulation', 'Simulated trading'));
    const sidebar = node('aside', 'sd-sidebar');
    const nav = node('nav', 'sd-nav'); nav.setAttribute('aria-label', 'Workspace modes');
    const home = node('span', 'sd-nav-current', 'Backtesting'); home.setAttribute('aria-current', 'page');
    nav.append(home, button('Chart mode ↗', 'sd-nav-button', guarded(() => callbacks.openChart())), button('Data & settings', 'sd-nav-button', guarded(() => callbacks.openData())));
    if (callbacks.openStats) nav.insertBefore(button('Market Stats', 'sd-nav-button', guarded(() => callbacks.openStats!())), nav.lastChild);
    const local = node('div', 'sd-sidebar-note'); local.append(node('span', 'sd-local-dot'), node('span', '', 'Local workspace'), node('small', '', 'Simulated trading'));
    const sidebarFooter = node('div', 'sd-sidebar-footer');
    const disposeUpdates = mountDesktopUpdates(sidebarFooter);
    sidebarFooter.append(local); sidebar.append(nav, sidebarFooter);

    const main = node('main', 'sd-main');
    const header = node('header', 'sd-heading');
    const intro = node('div', 'sd-intro'); intro.append(node('h1', '', 'Backtesting'));
    const chartContext = node('small', 'sd-chart-context');
    header.append(intro, chartContext);
    const tabs = node('div', 'sd-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Backtesting views');
    const dashboardPanel = node('div', 'sd-panel'), sessionsPanel = node('div', 'sd-panel');
    const panels = [dashboardPanel, sessionsPanel];
    const instance = ++dashboardSequence;
    const tabButtons = ['Dashboard', 'Sessions'].map((label, index) => {
        const tab = button(label, 'sd-tab', guarded(() => selectView(index)));
        tab.id = `sd-${instance}-tab-${index}`; tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', `sd-${instance}-panel-${index}`);
        const panel = panels[index]!; panel.id = `sd-${instance}-panel-${index}`;
        panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0;
        tabs.append(tab); return tab;
    });
    const welcome = node('section', 'sd-welcome'); welcome.setAttribute('aria-label', 'Get started');
    welcome.append(node('h2', '', 'Welcome to your workspace'), node('p', '', 'Start a backtest with your local data.'));
    const welcomeActions = node('div', 'sd-welcome-actions');
    welcomeActions.append(button('New session', 'sd-welcome-action sd-welcome-primary', guarded(() => callbacks.newSession())), button('Import session', 'sd-welcome-action', guarded(() => callbacks.importSession())));
    welcome.append(welcomeActions); welcome.hidden = true;
    const overview = node('section', 'sd-overview'); overview.setAttribute('aria-label', 'All saved attempts');
    const metrics = node('div', 'sd-metrics');
    const metricNodes = [
        ['Sessions', 'All saved attempts'], ['Active sessions', 'Paused and ready to resume'],
        ['Closed trades', 'Across all saved attempts'], ['Net account P&L', 'Includes open P&L · all saved attempts'],
    ].map(([title, hint]) => {
        const card = node('div', 'sd-metric'); const value = node('strong', 'sd-metric-value', '—');
        card.append(node('span', 'sd-metric-label', title), value, node('small', '', hint)); metrics.append(card); return value;
    });
    overview.append(metrics, node('p', 'sd-totals-note', 'Totals include every saved attempt, including copies. Filters change the session list only.'));

    const library = node('section', 'sd-library'); library.setAttribute('aria-label', 'Saved sessions');
    const libraryHeading = node('div', 'sd-library-heading');
    const title = node('h2', '', 'Your sessions'); const count = node('span', 'sd-count', '0'); title.append(count);
    const libraryActions = node('div', 'sd-library-actions');
    libraryActions.append(node('span', 'sd-library-hint', 'Saved on this computer'), button('+ New session', 'sd-button sd-primary', guarded(() => callbacks.newSession())));
    libraryHeading.append(title, libraryActions);
    const toolbar = node('div', 'sd-toolbar');
    const searchLabel = node('label', 'sd-search-label'); searchLabel.append(node('span', 'sd-sr-only', 'Search sessions by name or contract'));
    const search = node('input', 'sd-search'); search.type = 'search'; search.placeholder = 'Search sessions or contracts…'; search.maxLength = 200;
    searchLabel.append(search); toolbar.append(searchLabel);
    function select(label: string, entries: [string, string][]): HTMLSelectElement {
        const wrapper = node('label', 'sd-filter'); wrapper.append(node('span', 'sd-sr-only', label));
        const control = node('select', 'sd-select');
        for (const [value, text] of entries) { const option = node('option', '', text); option.value = value; control.append(option); }
        wrapper.append(control); toolbar.append(wrapper); return control;
    }
    const modeSelect = select('Filter sessions by mode', [['all', 'All modes'], ['practice', 'Practice'], ['prop', 'Evaluation']]);
    const statusSelect = select('Filter sessions by status', [['all', 'All statuses'], ['paused', 'Paused'], ['completed', 'Completed'], ['passed', 'Passed'], ['failed', 'Failed']]);
    const sortSelect = select('Sort sessions', [['updated', 'Last updated'], ['name', 'Name A–Z'], ['pnl', 'Net P&L']]);
    const message = node('div', 'sd-message'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); message.hidden = true;
    const resultsCount = node('p', 'sd-sr-only'); resultsCount.setAttribute('role', 'status'); resultsCount.setAttribute('aria-live', 'polite');
    const list = node('div', 'sd-session-list');
    library.append(libraryHeading, toolbar, message, resultsCount, list);
    const footer = node('footer', 'sd-footer');
    const tools = node('div', 'sd-footer-actions'); tools.append(button('Import session', 'sd-text-button', guarded(() => callbacks.importSession())), button('Data & settings', 'sd-text-button', guarded(() => callbacks.openData())));
    footer.append(node('span', '', 'Local data · Simulated trading'), tools);
    dashboardPanel.append(welcome, overview, library);
    main.append(header, tabs, dashboardPanel, sessionsPanel, footer); root.append(topbar, sidebar, main); host.append(root);

    function selectView(index: number): void {
        const panel = panels[index]; if (!panel) return;
        tabButtons.forEach((tab, tabIndex) => {
            tab.setAttribute('aria-selected', String(index === tabIndex)); tab.tabIndex = index === tabIndex ? 0 : -1;
            panels[tabIndex]!.hidden = index !== tabIndex;
        });
        panel.append(library);
    }
    tabButtons.forEach((tab, index) => tab.addEventListener('keydown', event => {
        if (disposed) return;
        const next = event.key === 'ArrowRight' ? (index + 1) % tabButtons.length
            : event.key === 'ArrowLeft' ? (index + tabButtons.length - 1) % tabButtons.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? tabButtons.length - 1 : undefined;
        if (next === undefined) return;
        event.preventDefault(); selectView(next); tabButtons[next]!.focus();
    }));
    selectView(0);

    function clearFilters(): void {
        query = ''; mode = 'all'; status = 'all'; search.value = ''; modeSelect.value = 'all'; statusSelect.value = 'all'; render(); search.focus();
    }
    function empty(heading: string, description: string, action?: HTMLButtonElement): void {
        const state = node('div', 'sd-empty'); state.append(node('div', 'sd-empty-glyph', '▤'), node('h3', '', heading), node('p', '', description));
        if (action) state.append(action);
        list.append(state);
    }
    function render(): void {
        if (disposed) return;
        const { sessions, datasets, selectedId, loading, error } = snapshot;
        const context = sessions.find(session => session.id === selectedId) ?? [...sessions].sort((a, b) => updatedTime(b) - updatedTime(a))[0];
        const contextDataset = context && datasets.find(dataset => dataset.id === context.datasetId);
        chartContext.textContent = context ? `Chart context: ${context.symbol} · ${contextDataset?.source === 'demo' ? 'synthetic data' : contextDataset ? 'cached data' : 'saved session'}` : 'Chart mode uses saved cached data';
        chartContext.title = context?.name ?? 'No saved session context yet';
        const unavailable = sessions.length === 0 && (loading || Boolean(error));
        welcome.hidden = sessions.length > 0 || Boolean(unavailable);
        root.setAttribute('aria-busy', loading ? 'true' : 'false');
        const sums = [total(sessions, 'trades'), total(sessions, 'netPnl')];
        const values = [integer.format(sessions.length), integer.format(sessions.filter(session => session.status === 'paused').length),
            sums[0] === null ? '—' : integer.format(sums[0]!), sessions.length && sums[1] !== null ? cash(sums[1]!) : '—'];
        metricNodes.forEach((element, index) => { element.textContent = unavailable ? '—' : values[index]!; element.classList.toggle('sd-positive', index === 3 && !unavailable && (sums[1] ?? 0) > 0); element.classList.toggle('sd-negative', index === 3 && !unavailable && (sums[1] ?? 0) < 0); });
        count.textContent = unavailable ? '—' : integer.format(sessions.length);
        message.hidden = !loading && !error; message.classList.toggle('sd-error', Boolean(error));
        message.textContent = error ? `${error}${sessions.length ? ' Showing the last loaded sessions.' : ''}` : loading ? sessions.length ? 'Updating sessions…' : 'Loading saved sessions…' : '';
        const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.sessionId : undefined;
        list.replaceChildren();
        const matching = sessions.filter(session => (mode === 'all' || session.mode === mode) && (status === 'all' || session.status === status)
            && `${session.name} ${session.symbol}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
        matching.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
            : sort === 'pnl' ? (Number.isFinite(b.netPnl) ? b.netPnl : -Infinity) - (Number.isFinite(a.netPnl) ? a.netPnl : -Infinity) || a.id.localeCompare(b.id)
                : updatedTime(b) - updatedTime(a) || a.id.localeCompare(b.id));
        resultsCount.textContent = `${matching.length} of ${sessions.length} saved sessions shown`;
        if (loading && !sessions.length) {
            const skeleton = node('div', 'sd-skeleton'); skeleton.setAttribute('aria-hidden', 'true');
            for (let index = 0; index < 3; index++) skeleton.append(node('div', 'sd-skeleton-row'));
            list.append(skeleton); return;
        }
        if (error && !sessions.length) { empty('Sessions are unavailable', 'Return to Backtesting after the connection is restored. Your saved sessions have not been removed.'); return; }
        if (!sessions.length) { empty('Start your first backtest', 'Choose a contract and dates, then practice in a saved replay session.', button('+ New session', 'sd-button sd-primary', guarded(() => callbacks.newSession()))); return; }
        if (!matching.length) { empty('No sessions match', 'Try a different name, contract, mode or status.', button('Clear filters', 'sd-button sd-secondary', clearFilters)); return; }
        const headings = node('div', 'sd-row sd-column-headings'); headings.setAttribute('aria-hidden', 'true');
        for (const [label, className] of [['Session', 'sd-session-name'], ['Progress', 'sd-progress-cell'], ['Net P&L', 'sd-pnl-cell'], ['Trades', 'sd-trades-cell'], ['Last updated', 'sd-updated-cell'], ['', 'sd-action-cell']]) headings.append(node('span', className!, label));
        list.append(headings);
        const rows = node('ul', 'sd-rows');
        for (const session of matching) {
            const row = node('li', 'sd-row'); row.classList.toggle('sd-current', selectedId === session.id);
            const identity = node('div', 'sd-session-name');
            const name = node('div', 'sd-name-line'); name.append(node('strong', 'sd-name', session.name));
            if (selectedId === session.id) name.append(node('span', 'sd-current-label', 'Current'));
            const metadata = node('div', 'sd-row-meta'); metadata.append(node('span', 'sd-contract', session.symbol), node('span', '', session.mode === 'prop' ? 'Evaluation' : 'Practice'));
            const badge = node('span', `sd-status sd-status-${session.status}`, statusLabel[session.status] ?? session.status); metadata.append(badge);
            const dataset = datasets.find(item => item.id === session.datasetId);
            if (dataset?.source === 'demo') metadata.append(node('span', 'sd-synthetic', 'Synthetic'));
            identity.append(name, metadata);
            const start = session.startTime ?? dataset?.start, end = session.endTime ?? dataset?.end;
            if (start !== undefined && end !== undefined) {
                const range = node('small', 'sd-date-range', `${session.startTime !== undefined || session.endTime !== undefined ? 'Session' : 'Cached data'}: ${utcDate(start)} – ${utcDate(end)}`);
                range.title = `${range.textContent} · end exclusive`; identity.append(range);
            }
            const progressCell = node('div', 'sd-progress-cell'); const amount = progress(session);
            const progressText = node('span', 'sd-mobile-label', 'Source bars replayed');
            progressCell.append(progressText, node('span', 'sd-progress-value', amount === null ? '—' : `${Math.round(amount)}%`));
            const track = node('div', 'sd-progress-track'); track.setAttribute('aria-hidden', 'true');
            const fill = node('span', ''); fill.style.width = `${amount ?? 0}%`; track.append(fill); progressCell.append(track);
            progressCell.setAttribute('aria-label', `Source bars replayed: ${amount === null ? 'unavailable' : `${Math.round(amount)} percent`}`);
            const pnl = node('div', 'sd-pnl-cell'); pnl.append(node('span', 'sd-mobile-label', 'Net P&L'), node('strong', session.netPnl > 0 ? 'sd-positive' : session.netPnl < 0 ? 'sd-negative' : '', cash(session.netPnl)));
            const trades = node('div', 'sd-trades-cell'); trades.append(node('span', 'sd-mobile-label', 'Closed trades'), node('span', '', Number.isFinite(session.trades) ? integer.format(session.trades) : '—'));
            const updated = node('div', 'sd-updated-cell'); updated.append(node('span', 'sd-mobile-label', 'Last updated'), node('span', '', utcDate(Date.parse(session.updatedAt))));
            const open = button(session.status === 'paused' ? 'Resume →' : 'Open session →', 'sd-button sd-resume', guarded(() => callbacks.openSession(session.id)));
            open.dataset.sessionId = session.id; open.setAttribute('aria-label', `${session.status === 'paused' ? 'Resume' : 'Open session'}: ${session.name}`);
            const action = node('div', 'sd-action-cell'); action.append(open);
            row.append(identity, progressCell, pnl, trades, updated, action); rows.append(row);
        }
        list.append(rows);
        if (focused) Array.from(rows.querySelectorAll<HTMLButtonElement>('button')).find(item => item.dataset.sessionId === focused)?.focus();
    }
    search.addEventListener('input', () => { query = search.value; render(); });
    modeSelect.addEventListener('change', () => { mode = modeSelect.value; render(); });
    statusSelect.addEventListener('change', () => { status = statusSelect.value; render(); });
    sortSelect.addEventListener('change', () => { sort = sortSelect.value; render(); });
    render();
    return {
        update(next) { if (disposed) return; snapshot = { ...next, sessions: [...next.sessions], datasets: [...next.datasets] }; render(); },
        destroy() { if (disposed) return; disposed = true; disposeUpdates(); root.remove(); if (!hadHostClass) host.classList.remove('session-dashboard-host'); },
    };
}
