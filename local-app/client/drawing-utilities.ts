import type { VelaWorkspace, DrawingToolbarUtility } from '../../src/workspace';
import type { Vela } from '../../src/index';
import { iconMarkup } from '../../src/plugin';
import { RANGE_PRESETS, type RangePreset } from '../../src/widget';
import './drawing-utilities.css';

/** Five elapsed calendar days, framed against revealed history at five-minute resolution. */
export const LOCAL_RANGE_PRESETS: readonly RangePreset[] = RANGE_PRESETS.map((range) => range.id === '7D'
    ? { id: '5D', tf: '5', preset: '5D', bars: 1500 }
    : range.id === 'ALL' ? { ...range, id: 'All' } : range);

const zoomIcon = '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12.5" cy="12.5" r="8"/><path d="m18.2 18.2 6.3 6.3M12.5 8.5v8M8.5 12.5h8"/></svg>';
const utilityIcon = (name: string): string => iconMarkup(name) ?? '';

type UtilityWorkspace = Pick<VelaWorkspace, 'context' | 'active' | 'cells' | 'on' | 'setDrawingToolbarUtilities' | 'refreshDrawingToolbarUtilities'>;

/** Scope every mutation to the active chart, preserving the core's single-step history. */
export function mountDrawingUtilities(workspace: UtilityWorkspace): () => void {
    const ctx = workspace.context();
    const all = () => ctx.chart.drawings.all();
    const refocus = (): void => workspace.active.host.focus({ preventScroll: true });
    const updateFlag = (key: 'locked' | 'visible', value: boolean): void => {
        const drawings = ctx.chart.drawings;
        drawings.updateMany(drawings.all().filter((drawing) => drawing[key] !== value)
            .map((drawing) => ({ id: drawing.id, patch: { [key]: value } })));
        refocus();
    };
    const empty = (): boolean => all().length === 0;
    const utilities: DrawingToolbarUtility[] = [
        { id: 'zoom-in', label: 'Zoom in on visible chart', icon: zoomIcon, group: 'navigation',
            run: () => {
                const chart = ctx.chart;
                const range = chart.getVisibleRange();
                if (range && range.to > range.from) {
                    const inset = (range.to - range.from) / 4;
                    chart.setVisibleRange({ from: range.from + inset, to: range.to - inset });
                }
                refocus();
            } },
        { id: 'lock-all', label: 'Lock all drawings on active chart', icon: utilityIcon('unlock'), group: 'drawing',
            pressed: () => !empty() && all().every((drawing) => drawing.locked), disabled: empty,
            run: () => updateFlag('locked', !all().every((drawing) => drawing.locked)) },
        { id: 'hide-all', label: 'Hide all drawings on active chart', icon: utilityIcon('eye-off'), group: 'drawing',
            pressed: () => !empty() && all().every((drawing) => !drawing.visible), disabled: empty,
            run: () => updateFlag('visible', all().every((drawing) => !drawing.visible)) },
        { id: 'delete-all', label: 'Delete all drawings on active chart (undo available)', icon: utilityIcon('trash'), group: 'remove',
            eraserInMenu: true, disabled: empty, run: () => { ctx.chart.drawings.removeMany(all().map((drawing) => drawing.id)); refocus(); } },
        { id: 'drawing-favorites', label: 'Show favorite drawing tools', icon: utilityIcon('star'), group: 'footer',
            pressed: () => ctx.host.dataset.localDrawingFavoritesVisible === 'true',
            disabled: () => ctx.chart.drawings.favorites().length === 0,
            run: () => ctx.host.dispatchEvent(new CustomEvent('local-drawing-favorites:toggle')) },
    ];
    workspace.setDrawingToolbarUtilities(utilities);
    let disposed = false;
    let queued = false;
    const watches = new Map<Vela, () => void>();
    const paint = (): void => { if (!disposed) workspace.refreshDrawingToolbarUtilities(); };
    const refresh = (): void => {
        if (disposed) return;
        const live = new Set(workspace.cells().map((cell) => cell.chart));
        for (const [chart, off] of watches) if (!live.has(chart)) { off(); watches.delete(chart); }
        for (const chart of live) if (!watches.has(chart)) {
            const offs = [chart.on('drawing:changed', paint), chart.on('drawing:favorites', paint)];
            watches.set(chart, () => offs.forEach((off) => off()));
        }
        paint();
    };
    const schedule = (): void => {
        if (queued) return;
        queued = true; queueMicrotask(() => { queued = false; refresh(); });
    };
    const offs = [workspace.on('cell:active', refresh), workspace.on('cell:created', schedule), workspace.on('cell:destroyed', schedule)];
    ctx.host.addEventListener('local-drawing-favorites:visibility', paint);
    refresh();
    return () => {
        if (disposed) return;
        disposed = true; offs.forEach((off) => off()); watches.forEach((off) => off()); watches.clear();
        ctx.host.removeEventListener('local-drawing-favorites:visibility', paint);
        workspace.setDrawingToolbarUtilities([]);
    };
}
