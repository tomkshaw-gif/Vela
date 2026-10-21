import { iconMarkup, registerIcon, registerWidgetAction } from '../../src/plugin';
import type { Schema } from '../shared/types';
import { timeframeSupported } from '../shared/timeframes';
import type { WorkspaceState } from '../../src/workspace';

export type LayoutSaveState = 'saved' | 'pending' | 'saving' | 'error' | 'paused';

/** Offer only resolutions the cached source can actually provide. */
export function defaultTimeframeFavorites(schema: Schema): string[] {
    return ['15S', '30S', '1', '2', '3', '5', '10', '15', '30', '60', '240', 'D', 'W', 'M'].filter((value) => timeframeSupported(value, schema));
}

export function needsDesktopChromeMigration(state: WorkspaceState): boolean {
    const marker = state.ext?.['local.desktopChrome'];
    return !marker || typeof marker !== 'object' || !('version' in marker) || typeof marker.version !== 'number' || marker.version < 1;
}

/** Mark the first desktop upgrade so a later intentional empty star list stays empty. */
export function withDesktopTimeframeFavorites(state: WorkspaceState, schema: Schema): WorkspaceState {
    const favorites = state.timeframeFavorites ?? [];
    return { ...state,
        timeframeFavorites: (needsDesktopChromeMigration(state) && !favorites.length ? defaultTimeframeFavorites(schema) : favorites)
            .filter((timeframe) => timeframeSupported(timeframe, schema)),
        ext: { ...state.ext, 'local.desktopChrome': { version: 1 } },
    };
}

registerIcon('local-replay-toggle', '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.3"><path d="m13 7-8 7 8 7V7Zm10 0-8 7 8 7V7Z"/></svg>');
registerIcon('local-fullscreen', '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M10 5H5v5M18 5h5v5M5 18v5h5M23 18v5h-5"/></svg>');
registerWidgetAction({ id: 'local.templatesShortcut', target: 'topbar', label: 'Templates', icon: 'local-templates', iconOnly: true,
    run: (ctx) => ctx.togglePanel('local.templates') });
registerWidgetAction({ id: 'local.replayToggle', target: 'topbar', label: 'Replay', icon: 'local-replay-toggle',
    run: (ctx) => ctx.host.dispatchEvent(new CustomEvent('local-replay:chrome', { bubbles: true, detail: { kind: 'replay-toggle' } })) });
registerWidgetAction({ id: 'local.tradeShortcut', target: 'topbar', label: 'Trade',
    run: (ctx) => ctx.togglePanel('local.trade') });
registerWidgetAction({ id: 'local.fullscreen', target: 'topbar', label: 'Fullscreen', icon: 'local-fullscreen', iconOnly: true,
    when: (ctx) => typeof ctx.host.requestFullscreen === 'function',
    run: (ctx) => {
        const doc = ctx.host.ownerDocument;
        const operation = doc.fullscreenElement ? doc.exitFullscreen() : ctx.host.requestFullscreen();
        void operation.catch(() => ctx.toast('Fullscreen could not be opened in this browser.', 'error'));
    } });

export interface ChartHeaderOptions { name(): string; save(): Promise<void> }

/** Enhance native controls while retaining their event paths and mobile projection. */
export function mountChartHeader(root: HTMLElement | undefined, options: ChartHeaderOptions): () => void {
    const header = root?.querySelector<HTMLElement>('.vela-widget-topbar');
    if (!root || !header) return () => {};
    const doc = root.ownerDocument;
    const added = new Set<HTMLElement>();
    const prior = new Map<HTMLElement, Map<string, string | null>>();
    const saveState = doc.createElement('button');
    saveState.className = 'local-layout-save'; saveState.type = 'button';
    const save = (): void => { void options.save().catch(() => undefined); };
    saveState.addEventListener('click', save);
    let disposed = false;
    const remember = (element: HTMLElement, name: string, value: string): void => {
        const attrs = prior.get(element) ?? new Map<string, string | null>();
        if (!attrs.has(name)) attrs.set(name, element.getAttribute(name));
        prior.set(element, attrs);
        if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    };
    const append = (element: HTMLElement, className: string, text: string): HTMLElement => {
        let child = element.querySelector<HTMLElement>(`:scope > .${className}`);
        if (!child) { child = doc.createElement('span'); child.className = className; element.append(child); added.add(child); }
        if (child.textContent !== text) child.textContent = text;
        return child;
    };
    const sync = (): void => {
        if (disposed) return;
        for (const button of header.querySelectorAll<HTMLElement>('.vela-widget-action-left,.vela-widget-action,.vela-widget-tool')) {
            const label = button.getAttribute('aria-label') ?? button.textContent?.trim();
            const id = label === 'Replay' ? 'local.replayToggle' : label === 'Fullscreen' ? 'local.fullscreen'
                : label === 'Templates' ? 'local.templatesShortcut' : label === 'Trade' ? 'local.tradeShortcut'
                    : label === 'Sessions & results' ? 'local.sessions' : null;
            if (id) remember(button, 'data-local-action', id);
        }
        const symbol = header.querySelector<HTMLElement>('.vela-widget-symbol');
        if (symbol) {
            const ticker = [...symbol.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join('').trim();
            remember(symbol, 'aria-label', `Search cached symbol${ticker ? ` — ${ticker}` : ''}`);
            const glyph = append(symbol, 'local-symbol-glyph', '');
            if (!glyph.childElementCount) glyph.innerHTML = iconMarkup('search') || '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="12" cy="12" r="6"/><path d="m17 17 6 6"/></svg>';
            if (symbol.firstChild !== glyph) symbol.prepend(glyph);
        }
        const alerts = header.querySelector<HTMLElement>('.vela-widget-alerts');
        if (alerts) append(alerts, 'local-alert-label', 'Alert');
        for (const chip of header.querySelectorAll<HTMLElement>('.vela-widget-tf')) {
            const text = chip.textContent;
            if (text === '1D' || text === '1W' || text === '1M') chip.textContent = text.slice(1);
        }
        const replay = header.querySelector<HTMLElement>('[data-local-action="local.replayToggle"]');
        if (replay) remember(replay, 'aria-pressed', root.dataset.localReplayOpen === 'true' ? 'true' : 'false');
        const fullscreen = header.querySelector<HTMLElement>('[data-local-action="local.fullscreen"]');
        if (fullscreen) remember(fullscreen, 'aria-pressed', doc.fullscreenElement === root ? 'true' : 'false');
        const layout = header.querySelector<HTMLElement>('.vela-topbar-right > .vela-widget-style');
        if (layout) {
            remember(layout, 'data-local-layout', 'true');
            const name = options.name();
            const label = append(layout, 'local-layout-name', name); label.title = name;
            const caret = append(layout, 'local-layout-caret', '⌄'); caret.setAttribute('aria-hidden', 'true');
            remember(layout, 'aria-label', `Chart layout — ${name}`);
            if (saveState.parentElement !== layout.parentElement || layout.nextSibling !== saveState) layout.after(saveState);
        }
        const state = root.dataset.localLayoutSave ?? 'pending';
        const label = state === 'saved' ? 'Local saved' : state === 'saving' ? 'Saving…' : state === 'error' ? 'Retry save' : state === 'paused' ? 'Save paused' : 'Save';
        if (saveState.textContent !== label) saveState.textContent = label;
        saveState.disabled = state === 'saving' || state === 'paused';
        saveState.dataset.state = state;
        saveState.setAttribute('aria-label', state === 'error' ? 'Layout save failed. Retry local save' : `${label} — workspace on this computer`);
    };
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(sync) : null;
    observer?.observe(header, { childList: true, subtree: true });
    observer?.observe(root, { attributes: true, attributeFilter: ['data-local-replay-open', 'data-local-layout-save', 'data-local-layout-name'] });
    doc.addEventListener('fullscreenchange', sync);
    sync();
    return () => {
        if (disposed) return;
        disposed = true; observer?.disconnect(); doc.removeEventListener('fullscreenchange', sync);
        saveState.removeEventListener('click', save); saveState.remove();
        for (const element of added) element.remove();
        for (const [element, attrs] of prior) for (const [name, value] of attrs) {
            if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
        }
    };
}
