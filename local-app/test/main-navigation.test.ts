// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReplayShell, controlIcon } from '../client/shell';
import * as util from '../client/util';
import * as times from '../client/replay-time';
import { rememberSession, selectedSession } from '../client/runtime';
import { ReplayPresentation } from '../client/replay-presentation';
import { ApiError } from '../client/api';
import { ReplayCharts } from '../client/charts';
import type { LocalApi } from '../client/api';
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
}
function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); document.body.replaceChildren(); sessionStorage.clear(); history.replaceState(null, '', '/'); vi.restoreAllMocks(); });

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
        if (path.startsWith('/api/sessions/')) return view;
        throw new Error(`Unexpected synthetic request: ${path}`);
    });
    const mount = vi.fn(async (_view: SessionView, _options?: unknown): Promise<void> => undefined);
    const prepare = vi.fn(async (_saveLayout = true): Promise<void> => undefined); const destroy = vi.fn(); const update = vi.fn();
    const charts = { mount, prepareForUpdate: prepare, destroy, flush: vi.fn(async (): Promise<void> => undefined), snapshot: () => null,
        setTicketQuantity: vi.fn(), refreshQuoteBars: vi.fn(), suspendPersistence: vi.fn(), setMode: vi.fn(), sync: vi.fn(), layout: '1', cursorTime: null, lastPrice: null };
    const ticket = { destroy: vi.fn(), refresh: vi.fn(), update: vi.fn(), quantity: 1 };
    const playback = { playing: false, start: vi.fn(), stop: vi.fn() };
    const Constructor = new Function('LocalApi', 'ReplayCharts', 'RuntimeCoordinator', 'ReplayPlayback', 'ReplayAnalyticsRefresh', 'TradeTicket',
        'mountSessionDashboard', 'buildReplayShell', 'controlIcon', 'ReplayPresentation', 'replayPreferenceStore', '$', 'value', 'selectedSession', 'rememberSession',
        ...Object.keys(util), ...Object.keys(times), 'DEFAULT_RULES', 'esc', 'pnlClass', 'replayIntervalCount', 'replayIntervalLabel', 'replayKeyStatsMarkup', 'ApiError', `${compiled}; return ReplayStudio;`)(
        class { get = get; post = post; setToken = vi.fn(); }, class { constructor() { return charts; } }, class { start = vi.fn(async () => undefined); dispose = vi.fn(); },
        class { constructor() { return playback; } }, class { reset = vi.fn(); wake = vi.fn(); invalidate = vi.fn(); destroy = vi.fn(); refresh = vi.fn(async () => undefined); },
        class { constructor() { return ticket; } }, vi.fn(() => ({ update, destroy: vi.fn() })), buildReplayShell, controlIcon, ReplayPresentation, () => undefined,
        (selector: string) => { const element = document.querySelector(selector); if (!element) throw new Error(`Missing ${selector}`); return element; },
        (id: string) => (document.getElementById(id) as HTMLInputElement).value, selectedSession, rememberSession,
        ...Object.values(util), ...Object.values(times), DEFAULT_RULES, util.escapeHtml, () => '', () => 1, () => '1m', () => '', ApiError,
    ) as new () => Studio;
    const app = new Constructor();
    Object.assign(app, { renderView: vi.fn(), activeTab: 'trades' });
    const modal = document.querySelector<HTMLDialogElement>('#modal')!;
    modal.showModal = () => modal.setAttribute('open', ''); modal.close = () => { modal.removeAttribute('open'); modal.dispatchEvent(new Event('close')); };
    cleanups.push(() => app.dispose());
    return { app, view, bootstrap, get, post, mount, prepare, destroy, update, charts, modal };
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
    it('keeps a rejected initial layout save honest and permits a later successful open', async () => {
        const f = fixture(); layoutPersistence(f); await f.app.start();
        f.post.mockRejectedValueOnce(new Error('Synthetic initial layout storage failure'));
        await expect(f.app.action('open-session', { id: f.view.session.id })).rejects.toThrow('Synthetic initial layout storage failure');
        expect(location.hash).toBe(''); expect(f.app.mode).toBe('sessions');
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
