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
import { mountDateTimePickers } from '../client/date-time-picker';
import { DEFAULT_RULES, INSTRUMENTS, type Bootstrap, type Command, type SessionSummary, type SessionView } from '../shared/types';
import { createSession } from '../engine';

const source = ts.createSourceFile('main.ts', readFileSync('local-app/client/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const studio = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ReplayStudio')!;
const compiled = ts.transpileModule(`${studio.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
interface Studio {
    start(): Promise<void>; dispose(): void; action(action: string, data: DOMStringMap): Promise<void>;
    renderResults(): void; renderOrders(): void; exportSession(): Promise<void>; clone(restart: boolean): Promise<void>; updateControls(): void; activeTab: string; prepareUpdate(): Promise<void>; mode: string; view: SessionView | null; navigationGeneration: number;
    startupError(error: unknown): void; renderSessions(): void;
    command(command: Command, strict?: boolean): Promise<string>;
}
function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); document.body.replaceChildren(); sessionStorage.clear(); history.replaceState(null, '', '/'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(hash = '#backtest', empty = false) {
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
        ...Object.keys(util), ...Object.keys(times), 'DEFAULT_RULES', 'esc', 'pnlClass', 'replayIntervalCount', 'replayIntervalLabel', 'replayKeyStatsMarkup', 'ApiError', 'mountDateTimePickers', `${compiled}; return ReplayStudio;`)(
        class { get = get; post = post; setToken = vi.fn(); }, class { constructor() { return charts; } }, class { start = vi.fn(async () => undefined); dispose = vi.fn(); },
        class { constructor() { return playback; } }, class { reset = vi.fn(); wake = vi.fn(); invalidate = vi.fn(); destroy = vi.fn(); refresh = vi.fn(async () => undefined); },
        class { constructor() { return ticket; } }, vi.fn(() => ({ update, destroy: vi.fn() })), buildReplayShell, controlIcon, ReplayPresentation, () => undefined,
        (selector: string) => { const element = document.querySelector(selector); if (!element) throw new Error(`Missing ${selector}`); return element; },
        (id: string) => (document.getElementById(id) as HTMLInputElement).value, selectedSession, rememberSession,
        ...Object.values(util), ...Object.values(times), DEFAULT_RULES, util.escapeHtml, () => '', () => 1, () => '1m', () => '', ApiError, mountDateTimePickers,
    ) as new () => Studio;
    const app = new Constructor();
    Object.assign(app, { renderView: vi.fn(), activeTab: 'trades' });
    const modal = document.querySelector<HTMLDialogElement>('#modal')!;
    modal.showModal = () => modal.setAttribute('open', ''); modal.close = () => { modal.removeAttribute('open'); modal.dispatchEvent(new Event('close')); };
    cleanups.push(() => app.dispose());
    return { app, view, bootstrap, get, post, mount, prepare, destroy, update, charts, modal };
}

async function opened() { const f = fixture(); await f.app.start(); return f; }
const button = (action: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;

describe('reachable saved session actions', () => {
    it.each(['#chart', '#backtest'])('exposes existing actions outside hidden management controls in %s', async hash => {
        const f = fixture(hash); await f.app.start();
        for (const action of ['rename', 'clone', 'restart', 'export']) {
            expect(button(action).closest('[hidden]'), action).toBeNull();
            expect(button(action).closest('#standard-workspace')).not.toBeNull();
        }
        const rename = vi.spyOn(f.app as unknown as { simpleDialog(): void }, 'simpleDialog').mockImplementation(() => undefined);
        button('rename').click(); await vi.waitFor(() => expect(rename).toHaveBeenCalledOnce());
        const clone = vi.spyOn(f.app, 'clone').mockResolvedValue();
        button('clone').click(); await vi.waitFor(() => expect(clone).toHaveBeenCalledWith(false));
        button('restart').click(); await vi.waitFor(() => expect(clone).toHaveBeenCalledWith(true));
        const exportSession = vi.spyOn(f.app, 'exportSession').mockResolvedValue();
        button('export').click(); await vi.waitFor(() => expect(exportSession).toHaveBeenCalledOnce());
        await f.app.action('sessions', {});
        expect(button('export').closest('[hidden]')).not.toBeNull();
    });
    it('blocks session commands while a mutation is in flight and restores menu focus on Escape', async () => {
        const f = await opened(); const clone = vi.spyOn(f.app, 'clone').mockResolvedValue();
        Object.assign(f.app, { mutationBusy: true }); f.app.updateControls();
        expect(button('clone').disabled).toBe(true); button('clone').click();
        await f.app.action('clone', {}); expect(clone).not.toHaveBeenCalled();
        Object.assign(f.app, { mutationBusy: false }); f.app.updateControls();
        const menu = document.querySelector<HTMLDetailsElement>('#session-actions')!;
        menu.open = true; button('export').focus();
        button('export').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(menu.open).toBe(false); expect(document.activeElement).toBe(menu.querySelector('summary'));
    });
    it('coalesces repeated session actions and makes a failed action retryable', async () => {
        const f = await opened(); const pending = deferred<void>();
        const clone = vi.spyOn(f.app, 'clone').mockReturnValueOnce(pending.promise).mockResolvedValue();
        button('clone').click(); button('clone').click(); await vi.waitFor(() => expect(clone).toHaveBeenCalledOnce());
        await f.app.action('restart', {});
        expect(clone).toHaveBeenCalledOnce(); expect(button('clone').disabled).toBe(true);
        pending.reject(new Error('Inert clone failure')); await vi.waitFor(() => expect(button('clone').disabled).toBe(false));
        button('clone').click(); await vi.waitFor(() => expect(clone).toHaveBeenCalledTimes(2));
    });
    it('keeps replay and trading shortcuts out of the session action menu', async () => {
        const f = await opened(); const key = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
        button('export').focus(); button('export').dispatchEvent(key);
        expect(key.defaultPrevented).toBe(false); await Promise.resolve(); await Promise.resolve();
        expect(f.post).not.toHaveBeenCalled();
    });
    it('does not export a replacement session after navigation begins while queued writes settle', async () => {
        const f = await opened(); const queue = deferred<void>();
        Object.assign(f.app, { commandQueue: queue.promise });
        const task = f.app.exportSession(); f.app.navigationGeneration++;
        Object.assign(f.app, { view: { ...f.view, session: { ...f.view.session, id: 'replacement' } } });
        queue.resolve(); await task;
        expect(f.get.mock.calls.filter(([path]) => path.endsWith('/export'))).toHaveLength(0);
    });
});

describe('selected dataset date discoverability', () => {
    it('explains the selected cache, updates coverage and preserves typed fields without navigating away', async () => {
        const f = await opened();
        f.view.dataset.start = Date.parse('2024-04-08T00:00:00Z'); f.view.dataset.end = Date.parse('2024-04-10T00:00:00Z');
        f.bootstrap.datasets.push({ ...f.view.dataset, id: 'other-cache', name: 'May dataset', start: Date.parse('2024-05-01T00:00:00Z'), end: Date.parse('2024-05-02T00:00:00Z') });
        await f.app.action('new-session', {});
        const coverage = document.querySelector('#new-dataset-coverage')!;
        expect(coverage.textContent).toContain('2024-04-08'); expect(coverage.textContent).toContain('2024-04-10');
        const form = document.querySelector<HTMLFormElement>('#new-session-form')!;
        expect(form.querySelector('#new-data-help')!.textContent).toContain('Finish or cancel this form');
        expect(form.querySelector('#new-data-help')!.textContent).toContain('Data & settings');
        const name = form.querySelector<HTMLInputElement>('#new-name')!; name.value = 'Keep my draft';
        const balance = form.querySelector<HTMLInputElement>('#new-balance')!; balance.value = '67890';
        const dataset = form.querySelector<HTMLSelectElement>('#new-dataset')!;
        expect(dataset.getAttribute('aria-describedby')).toContain(coverage.id);
        dataset.value = 'other-cache'; dataset.dispatchEvent(new Event('change', { bubbles: true }));
        expect(coverage.textContent).toContain('May dataset'); expect(coverage.textContent).toContain('2024-05-01');
        expect(name.value).toBe('Keep my draft'); expect(balance.value).toBe('67890');
        expect(form.isConnected).toBe(true); expect(f.post).not.toHaveBeenCalled();
    });
});

describe('manual execution review', () => {
    it('retains an actual next-bar rejection reason without changing the surviving position', async () => {
        const f = await opened(); const bars = [0, 1, 2].map(i => ({ time: 1780322400000 + i * 60000, open: 100, high: 100, low: 100, close: 100, volume: 1 }));
        let session = createSession({ ...f.view.session.config, startIndex: 0, endIndex: 3 }, INSTRUMENTS[0]!);
        const { applyCommand } = await import('../engine');
        for (const command of [
            { type: 'advance', count: 1 }, { type: 'place', order: { side: 'buy', type: 'market', qty: 3 } },
            { type: 'place', order: { side: 'sell', type: 'market', qty: 1, takeProfits: [{ id: 'short', price: 98, qty: 1 }] } },
            { type: 'advance', count: 1 },
        ] as Command[]) session = applyCommand(session, bars, command);
        const before = structuredClone(session); Object.assign(f.app, { view: { ...f.view, session } });
        f.app.renderOrders();
        const rejected = document.querySelector<HTMLElement>('#rejected-orders')!;
        expect(rejected).not.toBeNull(); expect(rejected.hidden).toBe(false);
        expect(rejected.textContent).toContain(session.orders[1]!.rejectReason);
        expect(rejected.textContent).toContain('SELL 1');
        expect(document.querySelector('#rejected-count')!.textContent).toBe('1 rejected');
        f.app.renderOrders(); expect(rejected.textContent).toContain(session.orders[1]!.rejectReason);
        expect(session).toEqual(before); expect(session.position).toMatchObject({ side: 'buy', qty: 3 });
    });
    it('pages retained rejections, keeps focus usable and treats rejection text as text', async () => {
        const f = await opened(); f.view.session.orders = Array.from({ length: 61 }, (_, i) => ({
            id: `rejected-${i}`, side: 'sell', type: 'market', qty: 1, createdTime: i * 60000, status: 'rejected', rejectReason: `<b>reason-${i}</b>`,
        }));
        f.app.renderOrders();
        expect(document.querySelectorAll('.rejected-order')).toHaveLength(25);
        expect(document.querySelector('#rejected-orders b')).toBeNull();
        button('rejections-older').focus(); button('rejections-older').click();
        await vi.waitFor(() => expect(document.querySelector('#rejected-orders')!.textContent).toContain('reason-35'));
        expect(document.activeElement).toBe(button('rejections-older'));
        button('rejections-older').click(); await vi.waitFor(() => expect(document.querySelectorAll('.rejected-order')).toHaveLength(11));
        expect(document.querySelector('#rejected-orders')!.textContent).toContain('reason-0');
        expect(document.activeElement?.isConnected).toBe(true);
    });
    it('navigates all manual exits with bounded DOM and truthful coverage while preserving focus', async () => {
        const f = await opened(); f.view.session.trades = Array.from({ length: 501 }, (_, i) => ({
            id: `exit-${i}`, side: 'buy', qty: 1, entryTime: 1700000000000, exitTime: 1700000060000 + i * 60000,
            entryPrice: 100, exitPrice: 101, grossPnl: 20, fees: 1, netPnl: 19, reason: `slice-${i}`, mae: 0, mfe: 20,
        }));
        f.app.activeTab = 'trades'; f.app.renderResults();
        expect(document.querySelectorAll('.trade-table tbody tr')).toHaveLength(50);
        expect(document.querySelector('#results')!.textContent).toContain('1–50 of 501');
        button('trades-older').focus();
        for (let page = 1; page <= 10; page++) { button('trades-older').click(); await vi.waitFor(() => expect(document.querySelector('#results')!.textContent).toContain(`${page * 50 + 1}–${Math.min(501, (page + 1) * 50)} of 501`)); }
        expect(document.querySelectorAll('.trade-table tbody tr')).toHaveLength(1);
        expect(document.querySelector('#results')!.textContent).toContain('slice-0');
        expect(button('trades-older').disabled).toBe(true); expect(document.activeElement?.isConnected).toBe(true);
        expect(f.post).not.toHaveBeenCalled();
    });
    it('exports the full retained manual ledger with exact numeric values, escaping and original order', async () => {
        const f = await opened(); f.app.activeTab = 'trades'; f.view.session.trades = Array.from({ length: 501 }, (_, i) => ({
            id: `exit-${i}`, side: 'buy', qty: 1, entryTime: 1700000000000, exitTime: 1700000060000 + i * 60000,
            entryPrice: 100, exitPrice: 101, grossPnl: 20.123456, fees: 1.23, netPnl: 18.893456, reason: i ? 'Take profit' : 'Comma, "quote"', mae: 0, mfe: 20,
        }));
        f.app.renderResults(); let blob: Blob | undefined;
        vi.stubGlobal('URL', { createObjectURL: vi.fn((value: Blob) => { blob = value; return 'blob:inert'; }), revokeObjectURL: vi.fn() });
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        button('trades-csv').click(); await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
        const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = () => reject(reader.error); reader.readAsText(blob!); });
        const lines = text.trimEnd().split('\r\n'); expect(lines).toHaveLength(502);
        expect(lines[1]).toContain('exit-0'); expect(lines[501]).toContain('exit-500');
        expect(lines[1]).toContain('20.123456'); expect(lines[1]).toContain('18.893456'); expect(lines[1]).toContain('"Comma, ""quote"""');
        expect(f.post).not.toHaveBeenCalled();
    });
});
