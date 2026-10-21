// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WidgetContext } from '../../src/plugin';
import type { DatasetMeta, SessionSummary, SessionView } from '../shared/types';
import { mountCachedWatchlist } from '../client/cached-watchlist';
import type { LocalApi } from '../client/api';

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); });
function fixture(): { body: HTMLElement; host: HTMLElement; datasets: DatasetMeta[]; sessions: SessionSummary[]; view: SessionView } {
    const host = document.createElement('div'); const body = document.createElement('section'); host.append(body); document.body.append(host);
    const base: Omit<SessionSummary, 'id' | 'name' | 'updatedAt'> = { datasetId: 'cached-a', symbol: 'NQZ6', mode: 'practice',
        status: 'paused', cursor: 1, barCount: 100, equity: 999, netPnl: 999, trades: 0, revision: 0 };
    return { host, body, datasets: [{ id: 'cached-a', symbol: 'NQZ6', name: 'Minute cache', schema: 'ohlcv-1m', source: 'csv' },
        { id: 'cached-b', symbol: 'ESZ6', name: 'Second cache', schema: 'ohlcv-1s', source: 'demo' }] as DatasetMeta[],
    sessions: [{ ...base, id: 'current', name: 'Practice A', updatedAt: '2026-01-01' },
        { ...base, id: 'other', name: 'Practice B', updatedAt: '2026-01-02' }],
    view: { session: { id: 'current' } } as SessionView };
}
describe('cached watchlist', () => {
    it('reads metadata only and opens real sessions without revealing future price or account results', async () => {
        const { host, body, datasets, sessions, view } = fixture();
        const get = vi.fn(async <T>(path: string): Promise<T> => (path === '/api/datasets' ? datasets : sessions) as T);
        const events: { kind: string; target: HTMLElement }[] = [];
        host.addEventListener('local-replay:chrome', (event) => events.push((event as CustomEvent).detail));
        const watchlist = mountCachedWatchlist(body, { api: { get: get as LocalApi['get'] }, context: () => ({ host }) as WidgetContext, session: () => view }); disposers.push(() => watchlist.destroy());
        await watchlist.refresh();
        expect(new Set(get.mock.calls.map(([path]) => path))).toEqual(new Set(['/api/datasets', '/api/sessions']));
        expect(body.textContent).toContain('NQZ6'); expect(body.textContent).toContain('synthetic'); expect(body.textContent).not.toContain('999');
        expect(body.querySelector<HTMLButtonElement>('[data-session-id="current"]')!.disabled).toBe(true);
        body.querySelector<HTMLButtonElement>('[data-session-id="other"]')!.click();
        expect(events[0]!.kind).toBe('open-session'); expect(events[0]!.target.dataset.sessionId).toBe('other');
        body.querySelector<HTMLButtonElement>('.local-watchlist-sessions')!.click(); expect(events[1]!.kind).toBe('sessions');
    });
    it('cancels stale work and removes refresh and selection handlers on destruction', async () => {
        const { host, body, view } = fixture(); let finish: (value: unknown) => void = () => {};
        const get = vi.fn(<T>(): Promise<T> => new Promise((resolve) => { finish = resolve as (value: unknown) => void; }));
        const watchlist = mountCachedWatchlist(body, { api: { get: get as LocalApi['get'] }, context: () => ({ host }) as WidgetContext, session: () => view });
        watchlist.destroy(); watchlist.destroy(); finish([]); await Promise.resolve();
        body.dispatchEvent(new Event('local-watchlist:refresh'));
        expect(body.childElementCount).toBe(0); expect(get).toHaveBeenCalledTimes(2);
    });
});
