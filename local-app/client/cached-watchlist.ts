import type { WidgetContext } from '../../src/plugin';
import type { DatasetMeta, SessionSummary, SessionView } from '../shared/types';
import type { LocalApi } from './api';

export interface CachedWatchlist { refresh(): Promise<void>; destroy(): void }

/** Metadata-only browsing keeps unrevealed bars and historical final prices out of the rail. */
export function mountCachedWatchlist(body: HTMLElement, options: {
    api: Pick<LocalApi, 'get'>; context(): WidgetContext; session(): SessionView | null;
}): CachedWatchlist {
    const doc = body.ownerDocument;
    const controller = new AbortController();
    const note = doc.createElement('p'); note.className = 'local-watchlist-note';
    note.textContent = 'Cached contracts · choose a session to open its replay. No live quotes.';
    const status = doc.createElement('p'); status.className = 'local-watchlist-status'; status.setAttribute('role', 'status');
    const list = doc.createElement('div'); list.className = 'local-watchlist-list';
    const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh cached list'; refresh.className = 'local-watchlist-refresh';
    body.classList.add('local-cached-watchlist'); body.append(note, refresh, status, list);
    let revision = 0; let destroyed = false;
    const load = async (): Promise<void> => {
        const current = ++revision;
        status.textContent = 'Loading cached contracts…'; refresh.disabled = true;
        try {
            const [datasets, sessions] = await Promise.all([
                options.api.get<DatasetMeta[]>('/api/datasets', controller.signal),
                options.api.get<SessionSummary[]>('/api/sessions', controller.signal),
            ]);
            if (destroyed || current !== revision) return;
            list.replaceChildren();
            const view = options.session();
            for (const dataset of datasets) {
                const section = doc.createElement('section'); section.className = 'local-watchlist-contract';
                const title = doc.createElement('strong'); title.textContent = dataset.symbol;
                const subtitle = doc.createElement('small'); subtitle.textContent = `${dataset.name} · ${dataset.schema} · ${dataset.source === 'demo' ? 'synthetic' : dataset.source}`;
                section.append(title, subtitle);
                const matches = sessions.filter((item) => item.datasetId === dataset.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
                for (const session of matches) {
                    const button = doc.createElement('button'); button.type = 'button'; button.className = 'local-watchlist-session';
                    button.dataset.sessionId = session.id; button.textContent = session.name;
                    const active = view?.session.id === session.id;
                    button.setAttribute('aria-current', active ? 'true' : 'false');
                    button.setAttribute('aria-label', `${active ? 'Current session' : 'Open session'} ${session.name} · ${dataset.symbol}`);
                    button.disabled = active; section.append(button);
                }
                if (!matches.length) {
                    const button = doc.createElement('button'); button.type = 'button'; button.className = 'local-watchlist-sessions';
                    button.textContent = 'Create a session…'; section.append(button);
                }
                list.append(section);
            }
            status.textContent = datasets.length ? `${datasets.length} cached ${datasets.length === 1 ? 'dataset' : 'datasets'}` : 'No cached contracts. Import data from Sessions & results.';
        } catch (error) {
            if (!destroyed && current === revision) status.textContent = error instanceof Error ? error.message : 'The cached list could not be loaded.';
        } finally { if (!destroyed && current === revision) refresh.disabled = false; }
    };
    const click = (event: Event): void => {
        const button = (event.target as Element).closest<HTMLButtonElement>('button');
        if (!button || button.disabled) return;
        if (button === refresh) { void load(); return; }
        if (!button.matches('.local-watchlist-session,.local-watchlist-sessions')) return;
        const context = options.context();
        context.host.dispatchEvent(new CustomEvent('local-replay:chrome', { bubbles: true,
            detail: { kind: button.dataset.sessionId ? 'open-session' : 'sessions', target: button } }));
    };
    const reopen = (): void => { void load(); };
    body.addEventListener('click', click); body.addEventListener('local-watchlist:refresh', reopen);
    void load();
    return { refresh: load, destroy: () => {
        if (destroyed) return;
        destroyed = true; revision++; controller.abort();
        body.removeEventListener('click', click); body.removeEventListener('local-watchlist:refresh', reopen);
        body.classList.remove('local-cached-watchlist'); note.remove(); refresh.remove(); status.remove(); list.remove();
    } };
}
