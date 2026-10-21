import './replay-stats-dock.css';
import type { Analytics } from '../shared/types';
import { number, percent } from './util';

type DockMode = 'normal' | 'minimized' | 'maximized';
type PreferenceStore = Pick<Storage, 'getItem' | 'setItem'>;
interface DockState { height: number; mode: DockMode }
interface Options {
    root: HTMLElement; dock: HTMLElement; resize: HTMLElement;
    minimize: HTMLButtonElement; maximize: HTMLButtonElement;
    storage?: PreferenceStore;
}
const STORAGE_KEY = 'vela.bottom-panel.v1';
const HEADER_HEIGHT = 30;
const MIN_HEIGHT = 100;
const MIN_CHART_HEIGHT = 180;

const metricFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function replayKeyStatsMarkup(analysis: Analytics): string {
    const amount = (value: number): string => `${metricFormat.format(Math.abs(value) < .005 ? 0 : value)}<span class="local-stat-currency">USD</span>`;
    const stat = (label: string, value: string, tone = ''): string => `<div class="local-replay-stat"><span class="local-stat-label">${label}</span><div class="local-stat-value ${tone}">${value}</div></div>`;
    return `<h2 class="local-script-key-heading">Key stats</h2><div class="analytics-header"><div class="analytics-stats">${stat('Total PnL', amount(analysis.netPnl), analysis.netPnl < 0 ? 'negative' : analysis.netPnl > 0 ? 'positive' : '')}${stat('Max drawdown', amount(analysis.maxDrawdown))}${stat('Profitable trades', `${percent(analysis.winRate)}<span class="local-stat-secondary">${number(analysis.wins)}/${number(analysis.trades)}</span>`)}${stat('Profit factor', analysis.profitFactor === null ? '—' : number(analysis.profitFactor))}</div><button class="quiet" data-action="refresh-analytics">Refresh</button></div>`;
}

function readState(storage?: PreferenceStore): DockState {
    try {
        const value = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null') as Partial<DockState> | null;
        if (value && Number.isFinite(value.height) && value.height! >= MIN_HEIGHT && value.height! <= 10000
            && (value.mode === 'normal' || value.mode === 'minimized' || value.mode === 'maximized')) {
            return { height: value.height!, mode: value.mode };
        }
    } catch { /* A panel remains usable when saved preferences are unavailable. */ }
    return { height: 280, mode: 'normal' };
}

export function dockPreferenceStore(): PreferenceStore | undefined {
    try { return window.localStorage; } catch { return undefined; }
}

/** Shares one bottom region between replay results, source editing and backtests. */
export function mountReplayStatsDock(options: Options): { open(): void; close(): void; destroy(): void } {
    const { root, dock, resize, minimize, maximize, storage } = options;
    const state = readState(storage);
    const slot = document.createComment('Bottom panel slot'); dock.before(slot);
    let origin: { y: number; height: number; id: number } | null = null;
    let disposed = false;
    const maxHeight = (): number => {
        const height = root.clientHeight || root.getBoundingClientRect().height || window.innerHeight;
        const chrome = Array.from(root.children).filter(element => element !== dock && !element.contains(dock)
            && !element.classList.contains('vela-ws-main') && !element.classList.contains('vela-widget-panels'))
            .reduce((total, element) => total + element.getBoundingClientRect().height, 0);
        const transport = dock.parentElement?.querySelector<HTMLElement>('.local-replay-strip');
        return Math.max(MIN_HEIGHT, height - chrome - (transport && !transport.hidden ? transport.getBoundingClientRect().height : 0) - MIN_CHART_HEIGHT);
    };
    const save = (): void => { try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Live layout does not depend on storage. */ } };
    const sync = (): void => {
        if (disposed) return;
        const maximized = state.mode === 'maximized';
        if (maximized) { if (dock.parentElement !== root) root.append(dock); }
        else if (dock.previousSibling !== slot) slot.after(dock);
        dock.classList.toggle('local-script-maximized', maximized);
        dock.classList.toggle('local-script-minimized', state.mode === 'minimized');
        dock.style.height = `${state.mode === 'minimized' ? HEADER_HEIGHT : Math.min(state.height, maxHeight())}px`;
        minimize.setAttribute('aria-expanded', String(state.mode !== 'minimized'));
        minimize.setAttribute('aria-label', state.mode === 'minimized' ? 'Expand bottom panel' : 'Collapse bottom panel');
        minimize.title = state.mode === 'minimized' ? 'Expand panel' : 'Collapse panel';
        maximize.setAttribute('aria-pressed', String(maximized));
        maximize.setAttribute('aria-label', maximized ? 'Restore bottom panel' : 'Maximize bottom panel');
        maximize.title = maximized ? 'Restore panel' : 'Maximize panel';
        resize.setAttribute('aria-valuemin', String(HEADER_HEIGHT));
        resize.setAttribute('aria-valuemax', String(Math.round(maxHeight())));
        resize.setAttribute('aria-valuenow', String(state.mode === 'minimized' ? HEADER_HEIGHT : Math.round(Math.min(state.height, maxHeight()))));
        resize.setAttribute('aria-valuetext', state.mode === 'minimized' ? 'Collapsed' : maximized ? 'Maximized' : `${Math.round(Math.min(state.height, maxHeight()))} pixels`);
    };
    const rememberHeight = (): void => {
        if (state.mode !== 'normal') return;
        const height = dock.getBoundingClientRect().height || Number.parseFloat(dock.style.height);
        if (Number.isFinite(height)) state.height = Math.max(MIN_HEIGHT, height);
    };
    const changeHeight = (height: number): void => {
        state.mode = height <= HEADER_HEIGHT ? 'minimized' : 'normal';
        if (state.mode === 'normal') state.height = Math.max(MIN_HEIGHT, Math.min(height, maxHeight()));
        sync();
    };
    const down = (event: PointerEvent): void => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault(); event.stopPropagation();
        origin = { y: event.clientY, height: state.mode === 'minimized' ? HEADER_HEIGHT : dock.getBoundingClientRect().height || state.height, id: event.pointerId };
        resize.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent): void => {
        if (origin?.id !== event.pointerId) return;
        event.preventDefault(); changeHeight(origin.height + origin.y - event.clientY);
    };
    const up = (event: PointerEvent): void => {
        if (origin?.id !== event.pointerId) return;
        origin = null;
        if (resize.hasPointerCapture(event.pointerId)) resize.releasePointerCapture(event.pointerId);
        save();
    };
    const key = (event: KeyboardEvent): void => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Enter') { rememberHeight(); state.mode = state.mode === 'minimized' ? 'normal' : 'minimized'; sync(); }
        else if (event.key === 'Home') changeHeight(HEADER_HEIGHT);
        else if (event.key === 'End') changeHeight(maxHeight());
        else changeHeight((state.mode === 'minimized' ? HEADER_HEIGHT : Math.min(state.height, maxHeight())) + (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 50 : 20));
        save();
    };
    const collapse = (): void => { rememberHeight(); state.mode = state.mode === 'minimized' ? 'normal' : 'minimized'; sync(); save(); };
    const maximizePanel = (): void => { rememberHeight(); state.mode = state.mode === 'maximized' ? 'normal' : 'maximized'; sync(); save(); };
    resize.addEventListener('pointerdown', down); resize.addEventListener('pointermove', move);
    resize.addEventListener('pointerup', up); resize.addEventListener('pointercancel', up); resize.addEventListener('lostpointercapture', up);
    resize.addEventListener('keydown', key); minimize.addEventListener('click', collapse); maximize.addEventListener('click', maximizePanel);
    window.addEventListener('pointerup', up); window.addEventListener('resize', sync);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(sync); observer?.observe(root);
    if (slot.parentElement && slot.parentElement !== root) observer?.observe(slot.parentElement);
    sync();
    return {
        open: () => { dock.hidden = false; if (state.mode === 'minimized') state.mode = 'normal'; sync(); save(); },
        close: () => { if (state.mode === 'maximized') { state.mode = 'normal'; sync(); save(); } dock.hidden = true; },
        destroy: () => {
            disposed = true; observer?.disconnect();
            resize.removeEventListener('pointerdown', down); resize.removeEventListener('pointermove', move);
            resize.removeEventListener('pointerup', up); resize.removeEventListener('pointercancel', up); resize.removeEventListener('lostpointercapture', up);
            resize.removeEventListener('keydown', key); minimize.removeEventListener('click', collapse); maximize.removeEventListener('click', maximizePanel);
            window.removeEventListener('pointerup', up); window.removeEventListener('resize', sync);
            slot.after(dock); slot.remove();
        },
    };
}
