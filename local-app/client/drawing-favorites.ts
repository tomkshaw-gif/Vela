import type { VelaWorkspace } from '../../src/workspace';
import type { Vela } from '../../src/index';
import { getDrawingType, type DrawingTypeKey } from '../../src/plugin';

export const DRAWING_FAVORITES_KEY = 'vela.local.drawing-favorites.v1';
export const DRAWING_FAVORITES_POSITION_KEY = 'vela.local.drawing-favorites-position.v1';
export const DRAWING_FAVORITES_VISIBLE_KEY = 'vela.local.drawing-favorites-visible.v1';
const DEFAULTS: DrawingTypeKey[] = ['trendline', 'hline', 'box'];
const CSS = `
.local-drawing-favorites { position:absolute; top:58px; left:50%; transform:translateX(-50%); z-index:20;
 display:flex; align-items:center; gap:0; width:max-content; max-width:calc(100% - 112px); padding:2px; overflow-x:auto;
 color:var(--vela-fg); background:var(--vela-surface); border:1px solid var(--vela-border-strong);
 border-radius:6px; box-shadow:0 2px 4px rgba(0,0,0,.18); scrollbar-width:none; }
.local-drawing-favorites::-webkit-scrollbar { display:none; }
.local-drawing-favorites[hidden] { display:none !important; }
.local-drawing-favorites[data-placement='bottom'] { position:relative; top:auto; left:auto; transform:none;
 flex:0 1 auto; min-width:24px; max-width:100%; height:36px; padding:0; border:0; border-radius:4px; box-shadow:none; }
.local-drawing-favorites[data-placement='bottom'] > button { width:38px; height:36px; }
.local-drawing-favorites[data-placement='bottom'] > .local-drawing-grip { width:24px; }
.local-drawing-favorites > button { display:flex; align-items:center; justify-content:center; flex:none;
 width:38px; height:38px; min-height:0; padding:6px; border:0; border-radius:4px;
 background:transparent; color:inherit; cursor:pointer; }
.local-drawing-favorites > button:hover { background:var(--vela-hover); }
.local-drawing-favorites > button[aria-pressed='true'] { background:var(--vela-active); color:var(--vela-accent); }
.local-drawing-favorites > button:focus-visible { outline:2px solid var(--vela-focus); outline-offset:-2px; }
.local-drawing-favorites svg { width:26px; height:26px; pointer-events:none; }
.local-drawing-favorites > .local-drawing-grip { position:sticky; left:0; width:24px; padding:0;
 background:var(--vela-surface); color:var(--vela-fg-muted); cursor:grab; touch-action:none; }
.local-drawing-favorites > .local-drawing-grip:hover { background:var(--vela-hover); }
.local-drawing-favorites .local-drawing-grip svg { width:10px; height:20px; }
.local-drawing-favorites[data-dragging='true'] > .local-drawing-grip { cursor:grabbing; }
[data-layout='mobile'] .local-drawing-favorites { top:44px; max-width:calc(100% - 24px); }
`;

interface Position { x: number; y: number }
interface Bounds { minX: number; maxX: number; minY: number; maxY: number }
interface Drag { pointer: number; x: number; y: number; left: number; top: number }
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const DIRECTIONS: Record<string, readonly [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function decodePosition(raw: string | null): Position | null {
    if (raw === null) return null;
    try {
        const value = JSON.parse(raw) as { version?: unknown; x?: unknown; y?: unknown };
        return value?.version === 1 && typeof value.x === 'number' && Number.isFinite(value.x) && value.x >= 0 && value.x <= 1 &&
            typeof value.y === 'number' && Number.isFinite(value.y) && value.y >= 0 && value.y <= 1 ? { x: value.x, y: value.y } : null;
    } catch { return null; }
}

function decode(raw: string | null): DrawingTypeKey[] | null {
    if (raw === null) return null;
    try {
        const value = JSON.parse(raw) as { version?: unknown; tools?: unknown };
        if (!value || value.version !== 1 || !Array.isArray(value.tools)) return null;
        return [...new Set(value.tools.filter((type): type is DrawingTypeKey => typeof type === 'string' && !!getDrawingType(type)))];
    } catch { return null; }
}

/** One local preference across sessions; the native stars remain the editing surface. */
export function mountDrawingFavorites(workspace: Pick<VelaWorkspace, 'context' | 'on' | 'cells' | 'active'>): () => void {
    const ctx = workspace.context();
    const doc = ctx.host.ownerDocument;
    const win = doc.defaultView;
    let storage: Storage | undefined;
    let stored: DrawingTypeKey[] | null = null;
    let position: Position | null = null;
    let userVisible = true;
    try {
        storage = win?.localStorage; stored = decode(storage?.getItem(DRAWING_FAVORITES_KEY) ?? null);
        position = decodePosition(storage?.getItem(DRAWING_FAVORITES_POSITION_KEY) ?? null);
        userVisible = storage?.getItem(DRAWING_FAVORITES_VISIBLE_KEY) !== 'false';
    } catch { /* Storage can be unavailable in a private browser window. */ }
    let tools = stored ?? (ctx.chart.drawings.favorites().length ? ctx.chart.drawings.favorites() : DEFAULTS);
    let serialized = '';
    let applying = false;
    let disposed = false;
    let queued = false;
    const watches = new Map<Vela, () => void>();
    const buttons = new Map<DrawingTypeKey, HTMLButtonElement>();
    const style = doc.createElement('style'); style.textContent = CSS;
    const bar = doc.createElement('div');
    bar.className = 'local-drawing-favorites';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Favorite drawing tools');
    bar.title = 'Star tools in the drawing menus to customize this bar';
    const grip = doc.createElement('button');
    grip.type = 'button'; grip.className = 'local-drawing-grip';
    grip.setAttribute('aria-label', 'Move favorite drawing tools');
    grip.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight Home Enter');
    grip.title = 'Drag or use arrow keys to move. Shift + arrow moves farther. Enter or Home docks to the bottom.';
    grip.innerHTML = '<svg viewBox="0 0 10 20" fill="currentColor" aria-hidden="true"><circle cx="3" cy="5" r=".8"/><circle cx="7" cy="5" r=".8"/><circle cx="3" cy="10" r=".8"/><circle cx="7" cy="10" r=".8"/><circle cx="3" cy="15" r=".8"/><circle cx="7" cy="15" r=".8"/></svg>';
    ctx.host.append(style, bar);
    let drag: Drag | null = null;
    const measure = (): Bounds | null => {
        const host = ctx.host.getBoundingClientRect();
        if (!host.width || !host.height || bar.hidden) return null;
        const grid = ctx.host.querySelector('.vela-ws-grid')?.getBoundingClientRect();
        const area = grid?.width && grid.height ? grid : host;
        const width = Math.max(0, Math.min(host.right, area.right) - Math.max(host.left, area.left) - 16);
        bar.style.maxWidth = `${width}px`;
        const rect = bar.getBoundingClientRect();
        const minX = Math.max(0, area.left - host.left) + 8;
        const minY = Math.max(0, area.top - host.top) + 8;
        return { minX, minY, maxX: Math.max(minX, Math.min(host.width, area.right - host.left) - rect.width - 8),
            maxY: Math.max(minY, Math.min(host.height, area.bottom - host.top) - rect.height - 8) };
    };
    const place = (left: number, top: number, bounds: Bounds): void => {
        if (bar.parentElement !== ctx.host) ctx.host.append(bar);
        bar.dataset.placement = 'floating';
        bar.style.transform = 'none';
        bar.style.left = `${clamp(left, bounds.minX, bounds.maxX)}px`;
        bar.style.top = `${clamp(top, bounds.minY, bounds.maxY)}px`;
    };
    const renderPosition = (): void => {
        const bottom = ctx.host.querySelector<HTMLElement>('.vela-widget-bottombar');
        if (!position && bottom && ctx.host.dataset.layout !== 'mobile') {
            bar.dataset.placement = 'bottom';
            bar.style.removeProperty('left'); bar.style.removeProperty('top'); bar.style.removeProperty('transform');
            bar.style.removeProperty('max-width');
            bottom.insertBefore(bar, bottom.querySelector('.vela-bb-spacer'));
            return;
        }
        if (bar.parentElement !== ctx.host) ctx.host.append(bar);
        bar.dataset.placement = 'floating';
        const bounds = measure();
        if (!bounds) return;
        place(bounds.minX + (bounds.maxX - bounds.minX) * (position?.x ?? .5),
            position ? bounds.minY + (bounds.maxY - bounds.minY) * position.y : bounds.maxY, bounds);
    };
    const rememberPosition = (): void => {
        if (!position) return;
        try { storage?.setItem(DRAWING_FAVORITES_POSITION_KEY, JSON.stringify({ version: 1, ...position })); } catch { /* The bar remains movable without storage. */ }
    };
    const move = (left: number, top: number): void => {
        const bounds = measure();
        if (!bounds) return;
        const x = clamp(left, bounds.minX, bounds.maxX);
        const y = clamp(top, bounds.minY, bounds.maxY);
        place(x, y, bounds);
        position = { x: bounds.maxX === bounds.minX ? .5 : (x - bounds.minX) / (bounds.maxX - bounds.minX),
            y: bounds.maxY === bounds.minY ? 0 : (y - bounds.minY) / (bounds.maxY - bounds.minY) };
    };
    const endDrag = (persist: boolean): void => {
        if (!drag) return;
        const pointer = drag.pointer;
        drag = null; delete bar.dataset.dragging;
        win?.removeEventListener('pointermove', onPointerMove);
        win?.removeEventListener('pointerup', onPointerEnd);
        win?.removeEventListener('pointercancel', onPointerCancel);
        try { if (grip.hasPointerCapture?.(pointer)) grip.releasePointerCapture(pointer); } catch { /* Capture can end when a window loses focus. */ }
        if (persist) rememberPosition();
    };
    const onPointerMove = (event: PointerEvent): void => {
        if (!drag || event.pointerId !== drag.pointer) return;
        event.preventDefault(); event.stopPropagation();
        move(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
    };
    const onPointerEnd = (event: PointerEvent): void => {
        if (!drag || event.pointerId !== drag.pointer) return;
        event.preventDefault(); event.stopPropagation(); endDrag(true);
    };
    const onPointerCancel = (event: PointerEvent): void => {
        if (event.pointerId === drag?.pointer) endDrag(true);
    };
    const onPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0 || event.isPrimary === false || drag || !measure()) return;
        event.preventDefault(); event.stopPropagation();
        const rect = bar.getBoundingClientRect();
        const host = ctx.host.getBoundingClientRect();
        drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left - host.left, top: rect.top - host.top };
        bar.dataset.dragging = 'true'; grip.focus({ preventScroll: true });
        try { grip.setPointerCapture?.(event.pointerId); } catch { /* Window listeners also handle environments without pointer capture. */ }
        win?.addEventListener('pointermove', onPointerMove, { passive: false });
        win?.addEventListener('pointerup', onPointerEnd);
        win?.addEventListener('pointercancel', onPointerCancel);
    };
    const onGripKey = (event: KeyboardEvent): void => {
        if ((event.key === 'Home' || event.key === 'Enter') && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault(); event.stopPropagation(); endDrag(true); position = null;
            try { storage?.setItem(DRAWING_FAVORITES_POSITION_KEY, JSON.stringify({ version: 2, placement: 'bottom' })); } catch { /* Docking also works without storage. */ }
            renderPosition(); grip.focus({ preventScroll: true }); return;
        }
        const direction = DIRECTIONS[event.key];
        if (!direction || event.altKey || event.ctrlKey || event.metaKey || !measure()) return;
        event.preventDefault(); event.stopPropagation(); endDrag(true);
        const rect = bar.getBoundingClientRect();
        const host = ctx.host.getBoundingClientRect();
        const step = event.shiftKey ? 20 : 2;
        move(rect.left - host.left + direction[0]! * step, rect.top - host.top + direction[1]! * step);
        rememberPosition();
    };
    const onGripClick = (event: MouseEvent): void => { event.preventDefault(); event.stopPropagation(); };
    const onResize = (): void => { if (!disposed) { endDrag(true); renderPosition(); } };
    const onWindowLeave = (): void => { endDrag(true); };
    grip.addEventListener('pointerdown', onPointerDown);
    grip.addEventListener('keydown', onGripKey);
    grip.addEventListener('click', onGripClick);
    grip.addEventListener('lostpointercapture', onPointerCancel);
    win?.addEventListener('resize', onResize);
    win?.addEventListener('blur', onWindowLeave);
    win?.addEventListener('pagehide', onWindowLeave);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
    observer?.observe(ctx.host); observer?.observe(bar);
    const grid = ctx.host.querySelector('.vela-ws-grid');
    if (grid) observer?.observe(grid);

    const paintActive = (): void => {
        const active = ctx.chart.drawings.getTool();
        for (const [type, button] of buttons) button.setAttribute('aria-pressed', String(type === active));
    };
    const paintTools = (): void => {
        endDrag(true); bar.replaceChildren(grip); buttons.clear();
        for (const type of tools) {
            const meta = getDrawingType(type);
            if (!meta) continue;
            const button = doc.createElement('button');
            button.type = 'button'; button.innerHTML = meta.icon;
            button.setAttribute('aria-label', meta.label); button.title = meta.label;
            button.addEventListener('click', () => {
                const drawings = ctx.chart.drawings;
                drawings.setTool(drawings.getTool() === type ? null : type);
                workspace.active.host.focus({ preventScroll: true });
            });
            buttons.set(type, button); bar.append(button);
        }
        paintVisibility();
        paintActive(); renderPosition();
    };
    const paintVisibility = (): void => {
        bar.hidden = !userVisible || buttons.size === 0;
        ctx.host.dataset.localDrawingFavoritesVisible = String(!bar.hidden);
        ctx.host.dispatchEvent(new CustomEvent('local-drawing-favorites:visibility'));
    };
    const toggleVisibility = (): void => {
        userVisible = !userVisible;
        try { storage?.setItem(DRAWING_FAVORITES_VISIBLE_KEY, String(userVisible)); } catch { /* Visibility also works without storage. */ }
        paintVisibility(); renderPosition();
    };
    ctx.host.addEventListener('local-drawing-favorites:toggle', toggleVisibility);
    const remember = (): void => {
        const next = JSON.stringify({ version: 1, tools });
        if (next === serialized) return;
        serialized = next;
        try { storage?.setItem(DRAWING_FAVORITES_KEY, next); } catch { /* Session layouts also retain the native star set. */ }
    };
    const apply = (): void => {
        applying = true;
        try { for (const cell of workspace.cells()) cell.chart.drawings.setFavorites(tools); }
        finally { applying = false; }
    };
    const refresh = (): void => {
        if (disposed) return;
        const live = new Set(workspace.cells().map((cell) => cell.chart));
        for (const [chart, off] of watches) if (!live.has(chart)) { off(); watches.delete(chart); }
        for (const chart of live) if (!watches.has(chart)) {
            const offFavorites = chart.on('drawing:favorites', ({ favorites }) => {
                if (applying || disposed) return;
                const next = favorites.filter((type): type is DrawingTypeKey => !!getDrawingType(type));
                if (JSON.stringify(next) === JSON.stringify(tools)) return;
                tools = next; remember(); paintTools();
            });
            const offTool = chart.on('drawing:tool', () => { if (!disposed && chart === ctx.chart) paintActive(); });
            watches.set(chart, () => { offFavorites(); offTool(); });
        }
        apply(); paintActive();
    };
    const scheduleRefresh = (): void => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => { queued = false; refresh(); });
    };
    const onStorage = (event: StorageEvent): void => {
        if (event.storageArea && event.storageArea !== storage) return;
        if (event.key === DRAWING_FAVORITES_POSITION_KEY) {
            const next = decodePosition(event.newValue);
            let docked = false;
            try { const value = JSON.parse(event.newValue ?? 'null') as { version?: unknown; placement?: unknown } | null; docked = value?.version === 2 && value.placement === 'bottom'; } catch { /* Ignore malformed placement updates. */ }
            if (!drag && (next || event.newValue === null || docked)) { position = next; renderPosition(); }
            return;
        }
        if (event.key === DRAWING_FAVORITES_VISIBLE_KEY) {
            if (event.newValue === 'true' || event.newValue === 'false' || event.newValue === null) {
                userVisible = event.newValue !== 'false'; paintVisibility(); renderPosition();
            }
            return;
        }
        if (event.key !== DRAWING_FAVORITES_KEY) return;
        const next = decode(event.newValue);
        if (next === null) return;
        tools = next; serialized = JSON.stringify({ version: 1, tools });
        apply(); paintTools();
    };
    const offs = [workspace.on('cell:active', refresh), workspace.on('cell:created', scheduleRefresh), workspace.on('cell:destroyed', scheduleRefresh)];
    refresh(); paintTools(); remember();
    win?.addEventListener('storage', onStorage);
    return () => {
        if (disposed) return;
        disposed = true;
        offs.forEach((off) => off());
        watches.forEach((off) => off()); watches.clear();
        win?.removeEventListener('storage', onStorage);
        ctx.host.removeEventListener('local-drawing-favorites:toggle', toggleVisibility);
        delete ctx.host.dataset.localDrawingFavoritesVisible;
        endDrag(true); observer?.disconnect();
        win?.removeEventListener('resize', onResize);
        win?.removeEventListener('blur', onWindowLeave);
        win?.removeEventListener('pagehide', onWindowLeave);
        grip.removeEventListener('pointerdown', onPointerDown);
        grip.removeEventListener('keydown', onGripKey);
        grip.removeEventListener('click', onGripClick);
        grip.removeEventListener('lostpointercapture', onPointerCancel);
        bar.remove(); style.remove();
    };
}
