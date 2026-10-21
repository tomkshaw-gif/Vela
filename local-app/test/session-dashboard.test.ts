// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatasetMeta, SessionSummary } from '../shared/types';
import { mountSessionDashboard, type SessionDashboard, type SessionDashboardCallbacks, type SessionDashboardSnapshot } from '../client/session-dashboard';

const controllers: SessionDashboard[] = [];
const dataset: DatasetMeta = { id: 'cached-data', name: 'Cached contract', symbol: 'NQZ6', schema: 'ohlcv-1m', intervalMs: 60000,
    instrument: { root: 'NQ', tickSize: 0.25, pointValue: 20 }, barCount: 1000, start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 9, 2), source: 'csv', createdAt: '2026-10-01T00:00:00Z', checksum: 'fixture' };
function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
    return { id, name: `${id} practice`, datasetId: dataset.id, symbol: 'NQZ6', mode: 'practice', status: 'paused', cursor: 99, barCount: 1000,
        equity: 50100, netPnl: 100, trades: 2, updatedAt: '2026-10-21T00:00:00Z', revision: 1, ...overrides };
}
function setup(sessions: SessionDashboardSnapshot['sessions'] = [session('first')]) {
    const host = document.createElement('div'); document.body.append(host);
    const callbacks: SessionDashboardCallbacks = { newSession: vi.fn(), openSession: vi.fn(), openChart: vi.fn(), openStats: vi.fn(), openData: vi.fn(), importSession: vi.fn() };
    const controller = mountSessionDashboard(host, callbacks); controllers.push(controller);
    const update = (extra: Partial<SessionDashboardSnapshot> = {}) => controller.update({ sessions, datasets: [dataset], ...extra });
    update(); return { host, callbacks, controller, update };
}
function click(host: HTMLElement, text: string): void {
    const control = Array.from(host.querySelectorAll('button')).find(item => item.textContent === text);
    if (!control) throw new Error(`Missing button: ${text}`); control.click();
}
function search(host: HTMLElement, text: string): void {
    const input = host.querySelector<HTMLInputElement>('input[type=search]')!; input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }));
}
function filter(host: HTMLElement, label: string, value: string): void {
    const control = Array.from(host.querySelectorAll('label')).find(item => item.textContent?.startsWith(label))!.querySelector('select')!;
    control.value = value; control.dispatchEvent(new Event('change', { bubbles: true }));
}
const metrics = (host: HTMLElement): string[] => Array.from(host.querySelectorAll('.sd-metric-value'), item => item.textContent!);
const names = (host: HTMLElement): string[] => Array.from(host.querySelectorAll('.sd-name'), item => item.textContent!);
afterEach(() => { controllers.splice(0).forEach(item => item.destroy()); document.body.replaceChildren(); });

describe('saved-session dashboard', () => {
    it('offers Market Stats independently of saved sessions and ignores its callback after disposal', () => {
        const { host, callbacks, controller } = setup([]);
        const stats = Array.from(host.querySelectorAll('button')).find(item => item.textContent === 'Market Stats')!;
        expect(stats).toBeDefined(); stats.click(); expect(callbacks.openStats).toHaveBeenCalledOnce();
        controller.destroy(); stats.click(); expect(callbacks.openStats).toHaveBeenCalledOnce();
    });
    it('opens with both saved metrics and sessions, and preserves filters when switching the internal views', () => {
        const { host, update, callbacks } = setup([session('first', { name: 'Opening range' }), session('second', { name: 'Afternoon range' })]);
        const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role=tab]'));
        const overview = host.querySelector('.sd-overview')!;
        const dashboard = overview.closest<HTMLElement>('[role=tabpanel]')!;
        const library = host.querySelector('.sd-library')!;
        expect(tabs.map(tab => tab.textContent)).toEqual(['Dashboard', 'Sessions']);
        expect(tabs[0]!.getAttribute('aria-selected')).toBe('true'); expect(dashboard.hidden).toBe(false);
        expect(dashboard.contains(library)).toBe(true); expect(names(host)).toHaveLength(2);
        expect(metrics(host)).toEqual(['2', '2', '4', '$200.00']);
        search(host, 'Opening'); tabs[1]!.click();
        const sessionsPanel = library.closest<HTMLElement>('[role=tabpanel]')!;
        expect(sessionsPanel.hidden).toBe(false); expect(dashboard.hidden).toBe(true);
        expect(sessionsPanel.getAttribute('aria-labelledby')).toBe(tabs[1]!.id);
        expect(tabs[1]!.getAttribute('aria-controls')).toBe(sessionsPanel.id);
        expect(names(host)).toEqual(['Opening range']);
        update(); expect(sessionsPanel.hidden).toBe(false); expect(names(host)).toEqual(['Opening range']);
        click(host, 'Resume →'); expect(callbacks.openSession).toHaveBeenCalledExactlyOnceWith('first');
        tabs[0]!.click(); expect(dashboard.hidden).toBe(false); expect(dashboard.contains(library)).toBe(true);
        expect((host.querySelector('input') as HTMLInputElement).value).toBe('Opening');
        expect(host.textContent).toContain('Totals include every saved attempt, including copies.');
        expect(callbacks.openChart).not.toHaveBeenCalled(); expect(callbacks.newSession).not.toHaveBeenCalled();
    });

    it('supports keyboard tab navigation and unique accessible relationships across dashboard mounts', () => {
        const { host, controller } = setup(); const second = setup();
        const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role=tab]'));
        const key = (tab: HTMLButtonElement, value: string) => tab.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
        tabs[0]!.focus(); expect(key(tabs[0]!, 'ArrowRight')).toBe(false);
        expect(document.activeElement).toBe(tabs[1]); expect(tabs.map(tab => tab.tabIndex)).toEqual([-1, 0]);
        key(tabs[1]!, 'ArrowRight'); expect(document.activeElement).toBe(tabs[0]);
        key(tabs[0]!, 'ArrowLeft'); expect(document.activeElement).toBe(tabs[1]);
        key(tabs[1]!, 'Home'); expect(document.activeElement).toBe(tabs[0]);
        key(tabs[0]!, 'End'); expect(document.activeElement).toBe(tabs[1]);
        expect(key(tabs[1]!, 'Tab')).toBe(true);
        const allIds = Array.from(document.querySelectorAll('[id]'), element => element.id);
        expect(new Set(allIds).size).toBe(allIds.length);
        for (const tab of second.host.querySelectorAll('[role=tab]')) expect(document.getElementById(tab.getAttribute('aria-controls')!)).not.toBeNull();
        controller.destroy(); key(tabs[1]!, 'Home'); tabs[0]!.click();
        expect(host.children).toHaveLength(0);
    });

    it('offers real empty-workspace actions and keeps loading and errors visible in either view', () => {
        const { host, update, callbacks } = setup([]);
        const welcome = host.querySelector<HTMLElement>('.sd-welcome')!;
        const tabs = host.querySelectorAll<HTMLButtonElement>('[role=tab]');
        expect(welcome.hidden).toBe(false);
        const actions = welcome.querySelectorAll<HTMLButtonElement>('button');
        actions[0]!.click(); actions[1]!.click();
        expect(callbacks.newSession).toHaveBeenCalledTimes(1); expect(callbacks.importSession).toHaveBeenCalledTimes(1);
        tabs[1]!.click(); update({ loading: true });
        expect(welcome.hidden).toBe(true);
        expect(host.querySelector('.sd-message')!.closest<HTMLElement>('[role=tabpanel]')!.hidden).toBe(false);
        expect(host.querySelector('.sd-message')!.textContent).toBe('Loading saved sessions…');
        update({ error: 'Local connection unavailable' });
        expect(host.querySelector('.sd-message')!.textContent).toContain('Local connection unavailable');
        expect(host.textContent).toContain('Sessions are unavailable');
        tabs[0]!.click(); expect(welcome.hidden).toBe(true);
        update({ sessions: [session('recovered')] }); expect(welcome.hidden).toBe(true);
        expect(names(host)).toEqual(['recovered practice']);
    });

    it('keeps supplied text inert and dispatches the exact session identity through ordinary callbacks', () => {
        const id = '"><img src=x onerror=alert(1)>', name = '<script>bad()</script> & "session"';
        const { host, callbacks, controller } = setup([session(id, { name })]);
        expect(host.querySelector('img,script,[onclick],[onerror]')).toBeNull();
        expect(names(host)).toEqual([name]);
        const resume = host.querySelector<HTMLButtonElement>('.sd-resume')!;
        expect(resume.getAttribute('aria-label')).toBe(`Resume: ${name}`); resume.click();
        expect(callbacks.openSession).toHaveBeenCalledExactlyOnceWith(id);
        click(host, '+ New session'); click(host, 'Chart mode ↗'); click(host, 'Data & settings'); click(host, 'Import session');
        expect(callbacks.newSession).toHaveBeenCalledTimes(1); expect(callbacks.openChart).toHaveBeenCalledTimes(1);
        expect(callbacks.openData).toHaveBeenCalledTimes(1); expect(callbacks.importSession).toHaveBeenCalledTimes(1);
        controller.destroy(); resume.click(); expect(callbacks.openSession).toHaveBeenCalledTimes(1);
        expect(host.classList.contains('session-dashboard-host')).toBe(false);
        controller.update({ sessions: [session('later')], datasets: [] }); expect(host.children).toHaveLength(0);
    });

    it('filters locally across refreshes while keeping all-attempt totals independent of the filtered list', () => {
        const sessions = [session('first', { name: 'Opening range', netPnl: 250, trades: 3 }), session('second', { name: 'Evaluation range', symbol: 'MESZ6', mode: 'prop', netPnl: -50, trades: 4 }), session('third', { status: 'completed', netPnl: 0, trades: 0 })];
        const { host, update, callbacks } = setup(sessions);
        expect(metrics(host)).toEqual(['3', '2', '7', '$200.00']);
        expect(host.textContent).toContain('Includes open P&L');
        expect(host.querySelector('.sd-chart-context')!.textContent).toContain('NQZ6 · cached data');
        search(host, 'mesz6'); filter(host, 'Filter sessions by mode', 'prop');
        expect(names(host)).toEqual(['Evaluation range']);
        update({ sessions: sessions.map(item => ({ ...item, revision: 2 })) });
        expect(names(host)).toEqual(['Evaluation range']); expect(metrics(host)).toEqual(['3', '2', '7', '$200.00']);
        click(host, 'Resume →'); expect(callbacks.openSession).toHaveBeenCalledWith('second');
        filter(host, 'Filter sessions by status', 'passed'); expect(names(host)).toEqual([]); expect(host.textContent).toContain('No sessions match');
        click(host, 'Clear filters'); expect(names(host)).toHaveLength(3); expect(document.activeElement).toBe(host.querySelector('input'));
        expect(sessions.map(item => item.id)).toEqual(['first', 'second', 'third']);
    });

    it('uses the session window for progress, falls back for old summaries, and distinguishes terminal actions', () => {
        const windowed = { ...session('windowed'), startIndex: 100, endIndex: 200, cursor: 124, startTime: Date.UTC(2026, 9, 1, 13, 30), endTime: Date.UTC(2026, 9, 1, 20) };
        const { host, update } = setup([windowed, session('legacy', { status: 'passed' })]);
        update({ selectedId: 'windowed' });
        const rows = Array.from(host.querySelectorAll<HTMLLIElement>('.sd-rows>li'));
        const windowRow = rows.find(item => item.textContent?.includes('windowed practice'))!;
        const legacyRow = rows.find(item => item.textContent?.includes('legacy practice'))!;
        expect(windowRow.querySelector('.sd-progress-value')!.textContent).toBe('25%');
        expect(windowRow.querySelector('.sd-date-range')!.textContent).toContain('Session: 01 Oct 2026, 13:30 UTC');
        expect(windowRow.querySelector('.sd-current-label')!.textContent).toBe('Current');
        expect(legacyRow.querySelector('.sd-progress-value')!.textContent).toBe('10%');
        expect(legacyRow.querySelector('.sd-date-range')!.textContent).toContain('Cached data:');
        expect(legacyRow.querySelector('button')!.textContent).toBe('Open session →');
        update({ sessions: [{ ...windowed, cursor: 99 }, { ...session('finished'), startIndex: 100, endIndex: 200, cursor: 900 }, { ...session('invalid'), startIndex: 100, endIndex: 100 }] });
        expect(Array.from(host.querySelectorAll('.sd-progress-value'), item => item.textContent).sort()).toEqual(['0%', '100%', '—'].sort());
    });

    it('shows empty, loading, failed and stale states without inventing zero profit or losing the selected action focus', () => {
        const { host, update, callbacks } = setup([]);
        expect(host.textContent).toContain('Start your first backtest'); expect(metrics(host)).toEqual(['0', '0', '0', '—']);
        update({ loading: true }); expect(host.querySelector('[aria-busy=true]')).not.toBeNull(); expect(metrics(host)).toEqual(['—', '—', '—', '—']);
        expect(host.querySelectorAll('.sd-skeleton-row')).toHaveLength(3);
        update({ error: '<img src=x onerror=bad()> unavailable' });
        expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toContain('Sessions are unavailable'); expect(host.querySelector('.sd-empty .sd-primary')).toBeNull();
        const loaded = [session('saved', { netPnl: Number.NaN })]; update({ sessions: loaded, error: 'Refresh failed' });
        expect(host.textContent).toContain('Showing the last loaded sessions'); expect(metrics(host)).toEqual(['1', '1', '2', '—']);
        const resume = host.querySelector<HTMLButtonElement>('.sd-resume')!; resume.focus(); update({ sessions: loaded, loading: true });
        expect((document.activeElement as HTMLElement).dataset.sessionId).toBe('saved');
        click(host, 'Resume →'); expect(callbacks.openSession).toHaveBeenCalledExactlyOnceWith('saved');
    });

    it('sorts without mutating the input and labels synthetic data without exposing unsupported destinations', () => {
        const sessions = [session('z', { name: 'Z session', netPnl: -1 }), session('a', { name: 'A session', netPnl: 3 })];
        const { host, update } = setup(sessions); update({ datasets: [{ ...dataset, source: 'demo' }] });
        filter(host, 'Sort sessions', 'name'); expect(names(host)).toEqual(['A session', 'Z session']);
        filter(host, 'Sort sessions', 'pnl'); expect(names(host)).toEqual(['A session', 'Z session']);
        expect(sessions.map(item => item.id)).toEqual(['z', 'a']); expect(host.querySelectorAll('.sd-synthetic')).toHaveLength(2);
        expect(host.textContent).not.toMatch(/win rate|time invested|checklists|battles/i);
        for (const control of host.querySelectorAll('input,select')) expect(control.closest('label')).not.toBeNull();
    });
});
