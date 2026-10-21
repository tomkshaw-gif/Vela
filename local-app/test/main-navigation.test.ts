// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReplayShell, controlIcon } from '../client/shell';
import * as util from '../client/util';
import * as times from '../client/replay-time';
import { rememberSession, selectedSession } from '../client/runtime';
import { ReplayPresentation } from '../client/replay-presentation';
import { ApiError, LocalApi } from '../client/api';
import { startReplayStudio } from '../client/main';
import { ReplayCharts } from '../client/charts';
import { mountMarketStatsPage } from '../client/market-stats-page';
import type { SessionDashboardCallbacks } from '../client/session-dashboard';
import type { DesktopBridge } from '../client/desktop-bridge';
import { persistDesktopSession } from '../client/desktop-session';
import type { WorkspaceState } from '../../src/state/document';
import { DEFAULT_RULES, INSTRUMENTS, type Bootstrap, type Command, type SessionSummary, type SessionView } from '../shared/types';
import { createSession } from '../engine';

const source = ts.createSourceFile('main.ts', readFileSync('local-app/client/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const studio = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ReplayStudio')!;
const compiled = ts.transpileModule(`${studio.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
interface Studio {
    start(): Promise<void>; dispose(): void; action(action: string, data: DOMStringMap): Promise<void>;
    prepareUpdate(): Promise<void>; mode: string; view: SessionView | null; navigationGeneration: number;
    startupError(error: unknown): void; renderSessions(): void;
    command(command: Command, strict?: boolean): Promise<string>;
    run(task: () => Promise<unknown>): Promise<unknown>;
}
function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
const cleanups: (() => void)[] = [];
afterEach(() => { window.dispatchEvent(new Event('pagehide')); cleanups.splice(0).forEach(cleanup => cleanup()); delete window.velaDesktop; document.body.replaceChildren(); sessionStorage.clear(); history.replaceState(null, '', '/'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function publicStartup() {
    history.replaceState(null, '', '/#stats'); document.body.innerHTML = '<div id="app"></div>';
    const dataset = { id: 'inert-public', name: 'Cached public fixture', symbol: 'NQM4', schema: 'ohlcv-1m' as const, intervalMs: 60_000,
        instrument: INSTRUMENTS[0]!, barCount: 240, start: Date.UTC(2024, 3, 8), end: Date.UTC(2024, 3, 8, 4), source: 'demo' as const, createdAt: '', checksum: '' };
    const session = createSession({ name: 'Public saved session', datasetId: dataset.id, mode: 'practice', initialBalance: 50_000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES } }, dataset.instrument, 'inert-public-session');
    const view: SessionView = { session, dataset };
    const bootstrap = { token: 'inert-token', datasets: [dataset], sessions: [{ id: session.id, datasetId: dataset.id, name: session.config.name, symbol: dataset.symbol, mode: 'practice', status: 'paused', cursor: -1, barCount: 240, equity: 50_000, netPnl: 0, trades: 0, revision: 0, updatedAt: '' }], provider: { configured: false }, instruments: INSTRUMENTS, dataDirectory: 'inert' } satisfies Bootstrap;
    const catalog = { datasets: [dataset], sessions: bootstrap.sessions, registry: [], limits: { bars: 250_000, spanMs: 315_360_000_000 } };
    const get = vi.spyOn(LocalApi.prototype, 'get').mockImplementation(path => Promise.resolve(path === '/api/bootstrap' ? bootstrap : path === '/api/runtime' ? { managed: false } : path === '/api/market-stats' ? catalog : view) as Promise<never>);
    const post = vi.spyOn(LocalApi.prototype, 'post');
    let prepare!: () => void; const prepared = vi.fn();
    window.velaDesktop = { onPrepare: vi.fn((callback: Parameters<DesktopBridge['onPrepare']>[0]) => { prepare = () => callback({ requestId: 'public-prepare', reason: 'update' }); return vi.fn(); }), prepared } as unknown as DesktopBridge;
    return { get, post, view, catalog, prepared, prepare: () => prepare() };
}

function fixture(hash = '', empty = false) {
    history.replaceState(null, '', `/${hash}`); document.body.innerHTML = '<div id="app"></div>';
    const dataset = { id: 'inert-data', name: 'Synthetic', symbol: 'NQM4', schema: 'ohlcv-1m' as const, intervalMs: 60000,
        instrument: INSTRUMENTS[0]!, barCount: 240, start: Date.parse('2026-11-01T04:00:00Z'), end: Date.parse('2026-11-01T08:00:00Z'), source: 'demo' as const, createdAt: '', checksum: '' };
    const session = createSession({ name: 'Inert saved session', datasetId: dataset.id, mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 30, endIndex: 120, rules: { ...DEFAULT_RULES } }, dataset.instrument, 'inert-session');
    const view: SessionView = { session, dataset };
    const summary = { id: session.id, name: session.config.name, symbol: dataset.symbol, mode: 'practice', status: 'paused', cursor: 29,
        barCount: 240, equity: 50000, netPnl: 0, trades: 0, revision: 0, updatedAt: '', startIndex: 30, endIndex: 120 } as SessionSummary;
    const bootstrap = { token: 'inert-token', datasets: empty ? [] : [dataset], sessions: empty ? [] : [summary], provider: { configured: false } } as unknown as Bootstrap;
    const post = vi.fn(async (_path: string, _body?: unknown): Promise<unknown> => view);
    const get = vi.fn(async (path: string): Promise<unknown> => {
        if (path === '/api/bootstrap') return bootstrap;
        if (path === '/api/sessions') return bootstrap.sessions;
        if (path === '/api/datasets') return bootstrap.datasets;
        if (path === '/api/market-stats') return { datasets: bootstrap.datasets, sessions: bootstrap.sessions, registry: [], limits: { bars: 250000 } };
        if (path.startsWith('/api/sessions/')) return view;
        throw new Error(`Unexpected synthetic request: ${path}`);
    });
    const mount = vi.fn(async (_view: SessionView, _options?: unknown): Promise<void> => undefined);
    const prepare = vi.fn(async (_saveLayout = true): Promise<void> => undefined); const destroy = vi.fn(); const update = vi.fn();
    const charts = { mount, prepareForUpdate: prepare, destroy, flush: vi.fn(async (): Promise<void> => undefined), snapshot: () => null,
        setTicketQuantity: vi.fn(), refreshQuoteBars: vi.fn(), suspendPersistence: vi.fn(), setMode: vi.fn(), sync: vi.fn(), layout: '1', cursorTime: null, lastPrice: null };
    const ticket = { destroy: vi.fn(), refresh: vi.fn(), update: vi.fn(), quantity: 1 };
    const playback = { playing: false, start: vi.fn(), stop: vi.fn() };
    const dashboard = vi.fn((_host: HTMLElement, _callbacks: SessionDashboardCallbacks) => ({ update, destroy: vi.fn() }));
    const historyController = { cancel: vi.fn(), destroy: vi.fn(), prepare: vi.fn(async () => {}) };
    const mountHistoryControls = vi.fn(() => historyController);
    const Constructor = new Function('LocalApi', 'ReplayCharts', 'RuntimeCoordinator', 'ReplayPlayback', 'ReplayAnalyticsRefresh', 'TradeTicket',
        'mountSessionDashboard', 'mountMarketStatsPage', 'mountHistoryControls', 'persistDesktopSession', 'buildReplayShell', 'controlIcon', 'ReplayPresentation', 'replayPreferenceStore', '$', 'value', 'selectedSession', 'rememberSession',
        ...Object.keys(util), ...Object.keys(times), 'DEFAULT_RULES', 'esc', 'pnlClass', 'replayIntervalCount', 'replayIntervalLabel', 'replayKeyStatsMarkup', 'ApiError', `${compiled}; return ReplayStudio;`)(
        class { get = get; post = post; setToken = vi.fn(); }, class { constructor() { return charts; } }, class { start = vi.fn(async () => undefined); dispose = vi.fn(); },
        class { constructor() { return playback; } }, class { reset = vi.fn(); wake = vi.fn(); invalidate = vi.fn(); destroy = vi.fn(); refresh = vi.fn(async () => undefined); },
        class { constructor() { return ticket; } }, dashboard, mountMarketStatsPage, mountHistoryControls, persistDesktopSession, buildReplayShell, controlIcon, ReplayPresentation, () => undefined,
        (selector: string) => { const element = document.querySelector(selector); if (!element) throw new Error(`Missing ${selector}`); return element; },
        (id: string) => (document.getElementById(id) as HTMLInputElement).value, selectedSession, rememberSession,
        ...Object.values(util), ...Object.values(times), DEFAULT_RULES, util.escapeHtml, () => '', () => 1, () => '1m', () => '', ApiError,
    ) as new () => Studio;
    const app = new Constructor();
    Object.assign(app, { renderView: vi.fn(), activeTab: 'trades' });
    const modal = document.querySelector<HTMLDialogElement>('#modal')!;
    modal.showModal = () => modal.setAttribute('open', ''); modal.close = () => { modal.removeAttribute('open'); modal.dispatchEvent(new Event('close')); };
    cleanups.push(() => app.dispose());
    return { app, view, bootstrap, get, post, mount, prepare, destroy, update, charts, modal, dashboard, playback, historyController, mountHistoryControls };
}

function layoutPersistence(f: ReturnType<typeof fixture>) {
    const root = document.createElement('div'); document.querySelector('#chart')!.append(root);
    const layout: WorkspaceState = { version: 1, layout: '1', charts: [] };
    const scriptPrepare = vi.fn(async (): Promise<void> => undefined);
    const controller = new ReplayCharts(root, { get: f.get, post: f.post } as unknown as LocalApi,
        async state => { await f.app.command({ type: 'layout', layout: state }, true); }, vi.fn(), vi.fn(), vi.fn());
    f.mount.mockImplementation(async () => {
        Object.assign(controller, { workspace: { root, getState: () => layout, destroy: vi.fn() }, view: f.view, lastSaved: '',
            scriptWorkspace: { prepareForUpdate: scriptPrepare, flush: vi.fn(async () => undefined), destroy: vi.fn() } });
        (controller as unknown as { scheduleSave(): void }).scheduleSave();
    });
    f.charts.flush.mockImplementation(() => controller.flush());
    f.prepare.mockImplementation(saveLayout => (controller.prepareForUpdate as (saveLayout?: boolean) => Promise<void>)(saveLayout));
    f.destroy.mockImplementation(() => controller.destroy());
    cleanups.push(() => controller.destroy());
    return { controller, root, scriptPrepare };
}

describe('dashboard and chart route ownership', () => {
    it.each(['query', 'catalog', 'superseded query'])('public desktop preparation drains the pending %s before ACK', async kind => {
        const f = publicStartup(); const pending = deferred<never>();
        if (kind === 'catalog') f.get.mockImplementation(path => (path === '/api/market-stats' ? pending.promise : Promise.resolve(path === '/api/bootstrap' ? { token: 'inert-token', datasets: [], sessions: [], provider: { configured: false } } : { managed: false })) as Promise<never>);
        else f.post.mockImplementation(() => pending.promise);
        startReplayStudio();
        await vi.waitFor(() => expect(f.get).toHaveBeenCalledWith('/api/market-stats', expect.any(AbortSignal)));
        if (kind !== 'catalog') {
            await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-stats-run]')!.disabled).toBe(false));
            document.querySelector('.ms-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
            if (kind === 'superseded query') {
                const draft = document.querySelector<HTMLTextAreaElement>('.ms-page [name=dsl]')!;
                draft.value = 'gapFill'; draft.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        const signal = kind === 'catalog' ? f.get.mock.calls.find(([path]) => path === '/api/market-stats')![1]! : f.post.mock.calls[0]![2]!;
        f.prepare(); await new Promise(resolve => setTimeout(resolve, 0));
        expect(signal.aborted).toBe(true); expect(f.prepared).not.toHaveBeenCalled();
        pending.reject(new DOMException('Cancelled after transport settled', 'AbortError'));
        await vi.waitFor(() => expect(f.prepared).toHaveBeenCalledExactlyOnceWith('public-prepare'));
        expect(document.querySelector('.ms-results')!.textContent).toBe('');
    });
    it('public navigation retains a visible unsaved destination after its initial chart save fails', async () => {
        const f = publicStartup(); const marker = document.createElement('textarea'); marker.value = 'Unsaved destination editor draft';
        const destroy = vi.spyOn(ReplayCharts.prototype, 'destroy').mockImplementation(() => marker.remove());
        vi.spyOn(ReplayCharts.prototype, 'mount').mockImplementation(async () => { document.querySelector('#chart')!.append(marker); });
        vi.spyOn(ReplayCharts.prototype, 'flush').mockRejectedValueOnce(new Error('Public initial chart save failed'));
        const prepare = vi.spyOn(ReplayCharts.prototype, 'prepareForUpdate').mockResolvedValue();
        startReplayStudio(); await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-stats-run]')!.disabled).toBe(false));
        const statsDraft = document.querySelector<HTMLTextAreaElement>('.ms-page [name=dsl]')!; statsDraft.value = 'gapFill';
        document.dispatchEvent(new CustomEvent('local-replay:chrome', { detail: { kind: 'chart' } }));
        await vi.waitFor(() => expect(document.querySelector('#toast')!.textContent).toContain('Public initial chart save failed'));
        expect(location.hash).toBe('#chart'); expect(document.querySelector<HTMLElement>('#standard-workspace')!.hidden).toBe(false);
        expect(document.querySelector<HTMLElement>('#market-stats-page')!.hidden).toBe(true);
        expect(marker.isConnected).toBe(true); expect(marker.value).toBe('Unsaved destination editor draft');
        expect(document.querySelector<HTMLButtonElement>('[data-action=step]')!.disabled).toBe(true);
        const destroys = destroy.mock.calls.length;
        prepare.mockRejectedValueOnce(new Error('Unsaved destination still blocked'));
        history.replaceState(null, '', '/#stats'); window.dispatchEvent(new HashChangeEvent('hashchange'));
        await vi.waitFor(() => expect(document.querySelector('#toast')!.textContent).toContain('Unsaved destination still blocked'));
        expect(location.hash).toBe('#chart'); expect(marker.isConnected).toBe(true); expect(destroy).toHaveBeenCalledTimes(destroys);
        history.replaceState(null, '', '/#stats'); window.dispatchEvent(new HashChangeEvent('hashchange'));
        await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#market-stats-page')!.hidden).toBe(false));
        expect(marker.isConnected).toBe(false); expect(statsDraft.isConnected).toBe(true); expect(statsDraft.value).toBe('gapFill');
        expect(f.post).not.toHaveBeenCalled();
    });
    it('public desktop preparation drains a query from an already retired Stats page', async () => {
        const f = publicStartup(); const pending = deferred<never>(); f.post.mockImplementation(() => pending.promise);
        startReplayStudio(); await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-stats-run]')!.disabled).toBe(false));
        document.querySelector('.ms-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
        document.querySelector<HTMLButtonElement>('[data-stats-home]')!.click(); await vi.waitFor(() => expect(location.hash).toBe('#sessions'));
        expect(f.post.mock.calls[0]![2]!.aborted).toBe(true); expect(document.querySelector('#market-stats-page')!.children).toHaveLength(0);
        f.prepare(); await new Promise(resolve => setTimeout(resolve, 0)); expect(f.prepared).not.toHaveBeenCalled();
        pending.reject(new DOMException('Retired request settled', 'AbortError'));
        await vi.waitFor(() => expect(f.prepared).toHaveBeenCalledExactlyOnceWith('public-prepare'));
    });
    it('public desktop ACK follows real LocalApi cancellation settlement over an isolated loopback request', async () => {
        const f = publicStartup(); f.post.mockRestore();
        const received = deferred<void>(), disconnected = deferred<void>(); const events: string[] = [];
        const server = createServer((request, response) => {
            request.resume(); response.on('close', () => { events.push('server-disconnect'); disconnected.resolve(); }); received.resolve();
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing isolated loopback address.');
        const fetch = globalThis.fetch, post = LocalApi.prototype.post;
        vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => fetch(new URL(String(input), `http://127.0.0.1:${address.port}`), init));
        vi.spyOn(LocalApi.prototype, 'post').mockImplementation(function (this: LocalApi, ...args) {
            return (post.apply(this, args) as Promise<never>).finally(() => { events.push('api-settled'); });
        });
        f.prepared.mockImplementation(() => { events.push('desktop-ack'); });
        try {
            startReplayStudio(); await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-stats-run]')!.disabled).toBe(false));
            document.querySelector('.ms-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            await received.promise; f.prepare();
            await vi.waitFor(() => expect(f.prepared).toHaveBeenCalledExactlyOnceWith('public-prepare'));
            expect(events.indexOf('api-settled')).toBeGreaterThanOrEqual(0);
            expect(events.indexOf('api-settled')).toBeLessThan(events.indexOf('desktop-ack'));
            await disconnected.promise; expect(events).toContain('server-disconnect');
        } finally {
            server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
    it('opens #stats without a session or chart and exposes it from the dashboard callback', async () => {
        const f = fixture('#stats', true); await f.app.start();
        expect(f.app.mode).toBe('stats'); expect(location.hash).toBe('#stats'); expect(f.mount).not.toHaveBeenCalled();
        expect(document.querySelector<HTMLElement>('#market-stats-page')!.hidden).toBe(false);
        expect(document.querySelector<HTMLElement>('#session-manager')!.hidden).toBe(true);
        expect(document.querySelector<HTMLElement>('#standard-workspace')!.hidden).toBe(true);
        await f.app.action('sessions', {}); f.dashboard.mock.calls[0]![1].openStats!();
        await vi.waitFor(() => expect(location.hash).toBe('#stats'));
        expect(document.querySelector('#market-stats-page')!.textContent).toContain('Market Stats');
    });
    it('honours hash navigation to Stats and aborts its worker when the studio is disposed', async () => {
        const f = fixture(); await f.app.start(); history.replaceState(null, '', '/#stats');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        await vi.waitFor(() => expect(f.app.mode).toBe('stats'));
        f.post.mockImplementationOnce(() => new Promise(() => {}));
        document.querySelector('.ms-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
        const signal = (f.post.mock.calls[0] as unknown[])[2] as AbortSignal;
        f.app.dispose(); expect(signal.aborted).toBe(true); expect(f.mount).not.toHaveBeenCalled();
        expect(document.querySelector('#market-stats-page')!.children).toHaveLength(0);
    });
    it('waits for chart preparation and queued commands before destroying the chart for stats', async () => {
        const f = fixture('#backtest'); await f.app.start(); f.destroy.mockClear();
        const preparing = deferred<void>(); const saving = deferred<SessionView>();
        f.prepare.mockImplementationOnce(() => preparing.promise); f.post.mockImplementationOnce(() => saving.promise);
        const command = f.app.command({ type: 'bookmark', label: 'Pending chart save' });
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
        const stats = f.app.action('stats', {}); await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
        preparing.resolve(); await Promise.resolve(); expect(f.destroy).not.toHaveBeenCalled();
        saving.resolve(f.view); await Promise.all([command, stats]);
        expect(f.destroy).toHaveBeenCalledOnce(); expect(location.hash).toBe('#stats');
        expect(f.get.mock.calls.filter(([path]) => path.startsWith('/api/sessions/'))).toHaveLength(1);
        await f.app.action('play', {}); await f.app.action('step', {});
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
        expect(f.playback.start).not.toHaveBeenCalled(); expect(f.post).toHaveBeenCalledOnce();
    });
    it('keeps the chart and the error visible if preparing for stats fails', async () => {
        const f = fixture('#chart'); await f.app.start(); f.destroy.mockClear();
        f.prepare.mockRejectedValueOnce(new Error('Unsaved editor draft'));
        await expect(f.app.action('stats', {})).rejects.toThrow('Unsaved editor draft');
        expect(f.app.mode).toBe('chart'); expect(location.hash).toBe('#chart'); expect(f.destroy).not.toHaveBeenCalled();
        expect(document.querySelector<HTMLElement>('#market-stats-page')!.hidden).toBe(true);
    });
    it.each([false, true])('a newer stats request owns a slow session open (failure=%s)', async failure => {
        const f = fixture(); await f.app.start(); const pending = deferred<SessionView>(); f.get.mockImplementationOnce(() => pending.promise);
        const open = f.app.action('open-session', { id: f.view.session.id }); await vi.waitFor(() => expect(f.get).toHaveBeenCalledTimes(2));
        const stats = f.app.action('stats', {});
        if (failure) pending.reject(new Error('Stale open error')); else pending.resolve(f.view);
        await Promise.all([open, stats]); expect(location.hash).toBe('#stats'); expect(f.mount).not.toHaveBeenCalled();
        expect(f.update.mock.lastCall?.[0].error).toBeUndefined();
    });
    it('aborts stats on leaving and preserves the page draft if the destination fails', async () => {
        const f = fixture('#stats'); await f.app.start();
        await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-stats-run]')!.disabled).toBe(false));
        const query = document.querySelector<HTMLTextAreaElement>('.ms-page [name=dsl]')!; query.value = 'gapFill';
        const pending = deferred<unknown>(); f.post.mockImplementationOnce(() => pending.promise);
        document.querySelector('.ms-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
        const signal = (f.post.mock.calls[0] as unknown[])[2] as AbortSignal;
        f.get.mockRejectedValueOnce(new Error('Destination failed'));
        await expect(f.app.run(() => f.app.action('chart', {}))).rejects.toThrow('Destination failed');
        expect(signal.aborted).toBe(true); expect(f.app.mode).toBe('stats'); expect(location.hash).toBe('#stats');
        expect(document.querySelector('.ms-page [name=dsl]')).toBe(query); expect(query.value).toBe('gapFill');
        expect(document.querySelector('#toast')!.textContent).toBe('Destination failed');
        await f.app.action('sessions', {}); expect(document.querySelector('#market-stats-page')!.children).toHaveLength(0);
        pending.resolve({ result: { n: 999 } }); await Promise.resolve();
        expect(document.querySelector('#app')!.textContent).not.toContain('999');
    });
    it('cancels and drains a pending stats worker before desktop preparation ACK', async () => {
        let prepare!: (request: { requestId: string }) => void;
        const prepared = vi.fn();
        window.velaDesktop = { onPrepare: vi.fn((callback: (request: { requestId: string; reason: 'quit' | 'update' }) => void) => { prepare = request => callback({ ...request, reason: 'update' }); return vi.fn(); }), prepared } as unknown as DesktopBridge;
        const f = fixture('#stats'); await f.app.start();
        await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-stats-run]')!.disabled).toBe(false));
        const pending = deferred<unknown>(); f.post.mockImplementationOnce(() => pending.promise);
        document.querySelector('.ms-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
        const signal = (f.post.mock.calls[0] as unknown[])[2] as AbortSignal;
        prepared.mockImplementation(() => expect(signal.aborted).toBe(true));
        prepare({ requestId: 'inert-prepare' });
        expect(signal.aborted).toBe(true);
        await Promise.resolve(); expect(prepared).not.toHaveBeenCalled();
        pending.reject(new DOMException('Request settled', 'AbortError'));
        await vi.waitFor(() => expect(prepared).toHaveBeenCalledExactlyOnceWith('inert-prepare'));
    });
    it('mounts history controls in Data & settings and drains retired work before desktop ACK', async () => {
        let prepare!: () => void; const prepared = vi.fn();
        window.velaDesktop = { onPrepare: vi.fn((callback: Parameters<DesktopBridge['onPrepare']>[0]) => { prepare = () => callback({ requestId: 'history-prepare', reason: 'quit' }); return vi.fn(); }), prepared } as unknown as DesktopBridge;
        const f = fixture(); await f.app.start(); await f.app.action('data', {});
        expect(f.mountHistoryControls).toHaveBeenCalledOnce(); expect(document.querySelector('.data-settings')).not.toBeNull();
        for (const id of ['provider-symbol', 'import-symbol']) {
            const input = document.getElementById(id) as HTMLInputElement; input.value = 'GCZ6'; expect(input.checkValidity()).toBe(true);
        }
        expect(document.querySelector('#provider-quote-form')!.textContent).toContain('exact raw contracts only');
        expect(document.querySelector('#provider-quote-form')!.textContent).toContain('zero invoice');
        const pending = deferred<void>(); f.historyController.prepare.mockImplementation(() => pending.promise);
        prepare(); expect(f.historyController.cancel).toHaveBeenCalledOnce(); expect(f.historyController.destroy).toHaveBeenCalledOnce();
        await Promise.resolve(); expect(prepared).not.toHaveBeenCalled();
        pending.resolve(); await vi.waitFor(() => expect(prepared).toHaveBeenCalledExactlyOnceWith('history-prepare'));
    });
    it('destroys each history mount on dialog replacement, close and disposal', async () => {
        const f = fixture(); await f.app.start(); await f.app.action('data', {}); await f.app.action('data', {});
        expect(f.historyController.destroy).toHaveBeenCalledOnce(); expect(f.mountHistoryControls).toHaveBeenCalledTimes(2);
        f.modal.close(); expect(f.historyController.destroy).toHaveBeenCalledTimes(2);
        await f.app.action('data', {}); f.app.dispose(); f.app.dispose();
        expect(f.historyController.destroy).toHaveBeenCalledTimes(3); expect(f.historyController.prepare).toHaveBeenCalledTimes(3);
    });
    it.each(['', '#sessions'])('boots %s into the dashboard without mounting a chart despite remembered context', async hash => {
        rememberSession(sessionStorage, 'inert-session');
        const f = fixture(hash); await f.app.start();
        expect(f.mount).not.toHaveBeenCalled(); expect(f.get).toHaveBeenCalledExactlyOnceWith('/api/bootstrap');
        expect(document.querySelector<HTMLElement>('#standard-workspace')!.hidden).toBe(true);
        expect(document.querySelector<HTMLElement>('#session-manager')!.hidden).toBe(false);
        expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ sessions: f.bootstrap.sessions, datasets: f.bootstrap.datasets }));
    });
    it('resumes the chosen session in Backtesting', async () => {
        const f = fixture(); await f.app.start(); await f.app.action('open-session', { id: f.view.session.id });
        expect(location.hash).toBe('#backtest'); expect(f.mount).toHaveBeenCalledOnce();
        expect(f.app.view?.session.id).toBe(f.view.session.id);
    });
    it('opens explicit Chart mode with initial replay panels closed and a cached context label', async () => {
        const f = fixture('#chart'); await f.app.start();
        expect(f.mount).toHaveBeenCalledWith(f.view, { mode: 'chart' });
        expect(document.querySelector('#workspace-mode-note')!.textContent).toMatch(/cached.*saved|saved.*cached/i);
        expect(location.hash).toBe('#chart');
    });
    it('waits for chart/editor preparation before returning home and saves on a dashboard-only update', async () => {
        const f = fixture('#backtest'); await f.app.start(); f.destroy.mockClear();
        const pending = deferred<void>(); f.prepare.mockImplementationOnce(() => pending.promise);
        const home = f.app.action('sessions', {}); await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
        expect(location.hash).toBe('#backtest'); expect(f.destroy).not.toHaveBeenCalled();
        pending.resolve(); await home;
        expect(location.hash).toBe('#sessions'); expect(f.destroy).toHaveBeenCalledOnce();
        const count = f.prepare.mock.calls.length; await f.app.prepareUpdate(); expect(f.prepare).toHaveBeenCalledTimes(count);
    });
    it('retains the route and mounted work if preparing the chart fails', async () => {
        const f = fixture('#chart'); await f.app.start(); f.destroy.mockClear();
        f.prepare.mockRejectedValueOnce(new Error('Synthetic draft conflict'));
        await expect(f.app.action('sessions', {})).rejects.toThrow('Synthetic draft conflict');
        expect(location.hash).toBe('#chart'); expect(f.destroy).not.toHaveBeenCalled();
    });
    it('does not let a slow open steal navigation back from a later home request', async () => {
        const f = fixture(); await f.app.start(); const pending = deferred<SessionView>();
        f.get.mockImplementationOnce(() => pending.promise);
        const open = f.app.action('open-session', { id: f.view.session.id });
        await vi.waitFor(() => expect(f.get).toHaveBeenCalledTimes(2));
        const home = f.app.action('sessions', {}); pending.resolve(f.view); await Promise.all([open, home]);
        expect(location.hash).toBe('#sessions'); expect(f.mount).not.toHaveBeenCalled();
    });
    it('keeps the dashboard and opens setup when Chart has no saved context', async () => {
        const f = fixture('', true); await f.app.start(); await f.app.action('chart', {});
        expect(f.mount).not.toHaveBeenCalled(); expect(f.modal.open).toBe(true); expect(location.hash).not.toBe('#chart');
        expect(f.modal.textContent).toMatch(/data/i);
    });
    it('keeps the dashboard on a rejected resume request', async () => {
        const f = fixture(); await f.app.start(); f.get.mockRejectedValueOnce(new Error('Synthetic missing cache'));
        await expect(f.app.action('open-session', { id: 'missing' })).rejects.toThrow('Synthetic missing cache');
        expect(f.mount).not.toHaveBeenCalled(); expect(location.hash).toBe('');
    });
    it('can reopen after returning home without using an aborted session signal', async () => {
        const f = fixture('#backtest'); await f.app.start(); await f.app.action('sessions', {});
        f.get.mockImplementationOnce(async (_path: string, ...args: unknown[]) => {
            expect((args[0] as AbortSignal).aborted).toBe(false); return f.view;
        });
        await f.app.action('open-session', { id: f.view.session.id }); expect(location.hash).toBe('#backtest');
    });
    it('recovers a command conflict without waiting on its own queue', async () => {
        const f = fixture('#backtest'); await f.app.start(); f.post.mockRejectedValueOnce(new ApiError('Synthetic conflict', 409));
        expect(await f.app.command({ type: 'advance', count: 1 })).toBe('conflict'); expect(f.mount).toHaveBeenCalledTimes(2);
        expect(location.hash).toBe('#backtest');
    }, 1000);
    it('saves an unsaved report before conflict recovery destroys its workspace and drains chart operations', async () => {
        const f = fixture('#backtest'); const persistence = layoutPersistence(f); await f.app.start();
        const report = deferred<void>(); let saved = false; let destroyedUnsaved = false;
        const destroy = f.destroy.getMockImplementation()!;
        f.destroy.mockImplementation(() => { if (!saved) destroyedUnsaved = true; destroy(); });
        persistence.scriptPrepare.mockImplementation(async () => {
            await f.app.command({ type: 'bookmark', label: 'Finishing chart operation' });
            await f.post('/api/backtests', { snapshot: { source: 'synthetic unsaved strategy' } });
            await report.promise; saved = true;
        });
        f.post.mockRejectedValueOnce(new ApiError('Synthetic conflict', 409));
        const command = f.app.command({ type: 'advance', count: 1 });
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledWith('/api/backtests', expect.anything()));
        expect(destroyedUnsaved).toBe(false); report.resolve();
        expect(await command).toBe('conflict'); expect(destroyedUnsaved).toBe(false);
        expect(location.hash).toBe('#backtest');
    }, 1500);
    it('keeps an unsaved report mounted when saving it during conflict recovery fails', async () => {
        const f = fixture('#backtest'); const persistence = layoutPersistence(f); await f.app.start();
        f.destroy.mockClear(); f.mount.mockClear();
        persistence.scriptPrepare.mockRejectedValueOnce(new Error('Synthetic report storage failure'));
        f.post.mockRejectedValueOnce(new ApiError('Synthetic conflict', 409));
        await expect(f.app.command({ type: 'advance', count: 1 })).rejects.toThrow('Synthetic report storage failure');
        expect(f.destroy).not.toHaveBeenCalled(); expect(f.mount).not.toHaveBeenCalled(); expect(location.hash).toBe('#backtest');
    });
    it('does not let a clone take navigation back after its index refresh settles', async () => {
        const f = fixture('#backtest'); await f.app.start();
        const pending = deferred<SessionSummary[]>();
        f.get.mockImplementationOnce(() => pending.promise);
        const clone = f.app.action('clone', {});
        await vi.waitFor(() => expect(f.get).toHaveBeenCalledWith('/api/sessions'));
        await f.app.action('sessions', {}); const mounts = f.mount.mock.calls.length;
        pending.resolve(f.bootstrap.sessions); await clone;
        expect(location.hash).toBe('#sessions'); expect(f.mount).toHaveBeenCalledTimes(mounts);
    });
    it('retires the clone when home is requested even before the session generation changes', async () => {
        const f = fixture('#backtest'); await f.app.start();
        const index = deferred<SessionSummary[]>(); const preparing = deferred<void>();
        f.get.mockImplementationOnce(() => index.promise); f.prepare.mockImplementationOnce(() => preparing.promise);
        const clone = f.app.action('clone', {});
        await vi.waitFor(() => expect(f.get).toHaveBeenCalledWith('/api/sessions'));
        const home = f.app.action('sessions', {});
        await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
        const navigation = f.app.navigationGeneration; index.resolve(f.bootstrap.sessions); await clone;
        expect(f.app.navigationGeneration).toBe(navigation);
        preparing.resolve(); await home; expect(location.hash).toBe('#sessions');
    });
    it('does not remount a conflicted command after a newer home request', async () => {
        const f = fixture('#backtest'); await f.app.start();
        const pending = deferred<SessionView>(); f.post.mockImplementationOnce(() => pending.promise);
        const command = f.app.command({ type: 'advance', count: 1 });
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
        const home = f.app.action('sessions', {}); pending.reject(new ApiError('Stale synthetic conflict', 409));
        await Promise.all([command, home]);
        expect(location.hash).toBe('#sessions'); expect(f.mount).toHaveBeenCalledOnce();
    });
    it('holds navigation and transport until the scheduled initial layout save completes', async () => {
        const f = fixture(); const persistence = layoutPersistence(f); await f.app.start();
        const pending = deferred<SessionView>(); f.post.mockImplementationOnce(() => pending.promise);
        let opened = false;
        const open = f.app.action('open-session', { id: f.view.session.id }).then(() => { opened = true; });
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
        const step = document.querySelector<HTMLButtonElement>('[data-action=step]')!;
        expect(opened).toBe(false); expect(step.disabled).toBe(true);
        expect(document.querySelector('#save-status')!.textContent).not.toContain('Saved locally');
        expect(persistence.root.dataset.localLayoutSave).toBe('saving');
        pending.resolve(f.view); await open;
        expect(persistence.root.dataset.localLayoutSave).toBe('saved'); expect(step.disabled).toBe(false);
        expect(document.querySelector('#save-status')!.textContent).toContain('Saved locally');
        step.click(); await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(2));
        expect(f.post.mock.calls.map(([, body]) => (body as { command: Command }).command.type)).toEqual(['layout', 'advance']);
    });
    it('keeps a rejected initial layout save visible and permits a later successful open', async () => {
        const f = fixture(); layoutPersistence(f); await f.app.start();
        f.post.mockRejectedValueOnce(new Error('Synthetic initial layout storage failure'));
        await expect(f.app.action('open-session', { id: f.view.session.id })).rejects.toThrow('Synthetic initial layout storage failure');
        expect(location.hash).toBe('#backtest'); expect(f.app.mode).toBe('backtest');
        expect(document.querySelector<HTMLElement>('#standard-workspace')!.hidden).toBe(false);
        expect(document.querySelector<HTMLButtonElement>('[data-action=step]')!.disabled).toBe(true);
        expect(document.querySelector('#save-status')!.textContent).not.toContain('Saved locally');
        await f.app.action('open-session', { id: f.view.session.id }); expect(location.hash).toBe('#backtest');
    });
    it('keeps transport blocked if a replacement workspace fails its initial save', async () => {
        const f = fixture('#backtest'); layoutPersistence(f); await f.app.start(); f.post.mockClear();
        f.post.mockRejectedValueOnce(new Error('Synthetic replacement layout storage failure'));
        await expect(f.app.action('open-session', { id: f.view.session.id })).rejects.toThrow('Synthetic replacement layout storage failure');
        expect(f.app.mode).toBe('backtest'); expect(location.hash).toBe('#backtest');
        expect(document.querySelector<HTMLButtonElement>('[data-action=step]')!.disabled).toBe(true);
        expect(document.querySelector('#save-status')!.textContent).toContain('could not be saved');
        await f.app.action('step', {}); expect(f.post).toHaveBeenCalledOnce();
    });
    it.each([false, true])('does not let a late initial save steal a newer home request (failure=%s)', async failure => {
        const f = fixture(); layoutPersistence(f); await f.app.start();
        const pending = deferred<SessionView>(); f.post.mockImplementationOnce(() => pending.promise);
        const open = f.app.action('open-session', { id: f.view.session.id });
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
        const home = f.app.action('sessions', {});
        if (failure) pending.reject(new Error('Stale synthetic initial save')); else pending.resolve(f.view);
        await Promise.all([open, home]);
        expect(location.hash).toBe('#sessions'); expect(f.app.mode).toBe('sessions');
        expect(f.update.mock.lastCall?.[0].error).toBeUndefined();
    });
    it('waits for an in-flight mount before destroying it for a later home request', async () => {
        const f = fixture(); await f.app.start(); const pending = deferred<void>(); f.mount.mockImplementationOnce(() => pending.promise);
        const open = f.app.action('open-session', { id: f.view.session.id }); await vi.waitFor(() => expect(f.mount).toHaveBeenCalledOnce());
        f.destroy.mockClear(); const home = f.app.action('sessions', {}); await Promise.resolve();
        expect(f.destroy).not.toHaveBeenCalled(); pending.resolve(); await Promise.all([open, home]);
        expect(location.hash).toBe('#sessions'); expect(f.destroy).toHaveBeenCalledOnce();
    });
    it('keeps stale errors from an old open out of a newer dashboard request', async () => {
        const f = fixture(); await f.app.start(); const pending = deferred<SessionView>(); f.get.mockImplementationOnce(() => pending.promise);
        const open = f.app.action('open-session', { id: f.view.session.id }); await vi.waitFor(() => expect(f.get).toHaveBeenCalledTimes(2));
        const home = f.app.action('sessions', {}); pending.reject(new Error('Stale synthetic open'));
        await Promise.all([open, home]); expect(location.hash).toBe('#sessions');
        expect(f.update.mock.lastCall?.[0].error).toBeUndefined();
    });
    it('shows startup failures in the dashboard and keeps reload usable without a chart', async () => {
        const f = fixture(); const error = new Error('Synthetic bootstrap failure'); f.get.mockRejectedValueOnce(error);
        await f.app.start().catch(failure => f.app.startupError(failure));
        expect(f.mount).not.toHaveBeenCalled(); expect(f.update).toHaveBeenLastCalledWith(expect.objectContaining({ loading: false, error: error.message }));
        expect(document.querySelector<HTMLElement>('#standard-workspace')!.hidden).toBe(true);
    });
    it('uses the selected source range for summary progress and supports older summaries', async () => {
        const f = fixture(); f.bootstrap.sessions[0]!.cursor = 74; await f.app.start();
        expect(document.querySelector<HTMLElement>('.session-card-progress span')!.style.width).toBe('50%');
        delete f.bootstrap.sessions[0]!.startIndex; delete f.bootstrap.sessions[0]!.endIndex; f.bootstrap.sessions[0]!.cursor = 119; f.app.renderSessions();
        expect(document.querySelector<HTMLElement>('.session-card-progress span')!.style.width).toBe('50%');
    });
    it('ignores replay action dispatch on the homepage', async () => {
        const f = fixture(); await f.app.start();
        await f.app.action('go-to', {}); await f.app.action('step', {}); expect(f.modal.open).toBe(false);
        expect(f.get).toHaveBeenCalledExactlyOnceWith('/api/bootstrap');
        const key = new KeyboardEvent('keydown', { code: 'ArrowRight', key: 'ArrowRight', bubbles: true });
        document.dispatchEvent(key); expect(key.defaultPrevented).toBe(false); expect(f.modal.open).toBe(false);
    });
});
