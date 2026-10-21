// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VelaWorkspace } from '../../src/workspace';
import type { DrawingTypeKey } from '../../src/plugin';
import { DRAWING_FAVORITES_KEY, DRAWING_FAVORITES_POSITION_KEY, DRAWING_FAVORITES_VISIBLE_KEY, mountDrawingFavorites } from '../client/drawing-favorites';

class Chart {
    tool: DrawingTypeKey | null = null;
    favorites: DrawingTypeKey[] = [];
    events = new Map<string, Set<(value: never) => void>>();
    drawings = {
        favorites: (): DrawingTypeKey[] => [...this.favorites],
        getTool: (): DrawingTypeKey | null => this.tool,
        setTool: (type: DrawingTypeKey | null): void => { this.tool = type; this.emit('drawing:tool', { type }); },
        setFavorites: (types: DrawingTypeKey[]): void => {
            if (JSON.stringify(types) === JSON.stringify(this.favorites)) return;
            this.favorites = [...types]; this.emit('drawing:favorites', { favorites: this.favorites });
        },
    };
    emit(event: string, value: unknown): void { for (const handler of this.events.get(event) ?? []) handler(value as never); }
    on(event: string, handler: (value: never) => void): () => void {
        if (!this.events.has(event)) this.events.set(event, new Set());
        this.events.get(event)!.add(handler);
        return () => this.events.get(event)!.delete(handler);
    }
}

function fixture(initial: DrawingTypeKey[] = []): {
    workspace: Parameters<typeof mountDrawingFavorites>[0]; host: HTMLElement; charts: Chart[];
    activate: (index: number) => void; add: () => Chart; remove: (index: number) => void;
} {
    const host = document.createElement('div'); document.body.append(host);
    const charts = [new Chart()]; charts[0]!.favorites = initial;
    const cellHost = document.createElement('div'); cellHost.tabIndex = 0; host.append(cellHost);
    let active = 0;
    const events = new Map<string, Set<() => void>>();
    const emit = (event: string): void => { for (const handler of events.get(event) ?? []) handler(); };
    const workspace = {
        context: () => ({ host, get chart() { return charts[active]!; } }),
        cells: () => charts.map((chart) => ({ chart })),
        get active() { return { chart: charts[active]!, host: cellHost }; },
        on: (event: string, handler: () => void) => {
            if (!events.has(event)) events.set(event, new Set());
            events.get(event)!.add(handler); return () => events.get(event)!.delete(handler);
        },
    } as unknown as Pick<VelaWorkspace, 'context' | 'on' | 'cells' | 'active'>;
    return { workspace, host, charts,
        activate: (index) => { active = index; emit('cell:active'); },
        add: () => { const chart = new Chart(); charts.push(chart); emit('cell:created'); return chart; },
        remove: (index) => { charts.splice(index, 1); if (active >= charts.length) active = 0; emit('cell:destroyed'); },
    };
}

const disposers: (() => void)[] = [];
function mount(workspace: Parameters<typeof mountDrawingFavorites>[0]): () => void {
    const dispose = mountDrawingFavorites(workspace); disposers.push(dispose); return dispose;
}
const labels = (host: HTMLElement): (string | null)[] => [...host.querySelectorAll('.local-drawing-favorites button[aria-pressed]')].map((button) => button.getAttribute('aria-label'));

function measured(host: HTMLElement, initialWidth = 1000, initialHeight = 600): { resize: (width: number, height: number) => void } {
    let width = initialWidth;
    let height = initialHeight;
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => new DOMRect(100, 50, width, height));
    const native = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (!this.classList.contains('local-drawing-favorites')) return native.call(this);
        const buttons = this.querySelectorAll('button').length;
        const barWidth = Math.min(30 + Math.max(0, buttons - 1) * 38, Number.parseFloat(this.style.maxWidth) || width - 16);
        const left = this.style.left ? Number.parseFloat(this.style.left) : (width - barWidth) / 2;
        const top = this.style.top ? Number.parseFloat(this.style.top) : 58;
        return new DOMRect(100 + left, 50 + top, barWidth, 44);
    });
    return { resize: (nextWidth, nextHeight) => { width = nextWidth; height = nextHeight; window.dispatchEvent(new Event('resize')); } };
}

function pointer(type: string, x: number, y: number, pointerId = 1): Event {
    return Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }), { pointerId, isPrimary: true });
}

beforeEach(() => { localStorage.clear(); document.body.replaceChildren(); });
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('favorite drawing bar', () => {
    it('starts with native tool icons and arms or disarms the active chart on click', () => {
        const { workspace, host, charts } = fixture(); mount(workspace);
        expect(labels(host)).toEqual(['Trend Line', 'Horizontal Line', 'Rectangle']);
        const line = host.querySelector<HTMLButtonElement>('button[aria-label="Trend Line"]')!;
        expect(line.querySelector('svg')).not.toBeNull();
        line.click(); expect(charts[0]!.tool).toBe('trendline'); expect(line.getAttribute('aria-pressed')).toBe('true');
        line.click(); expect(charts[0]!.tool).toBeNull(); expect(line.getAttribute('aria-pressed')).toBe('false');
    });

    it('uses native favorite changes and remembers an intentionally emptied bar across sessions', () => {
        const first = fixture(); const dispose = mount(first.workspace);
        first.charts[0]!.drawings.setFavorites(['ray']);
        expect(labels(first.host)).toEqual(['Ray']);
        first.charts[0]!.drawings.setFavorites([]);
        expect(first.host.querySelector<HTMLElement>('[role="toolbar"]')!.hidden).toBe(true);
        expect(JSON.parse(localStorage.getItem(DRAWING_FAVORITES_KEY)!)).toEqual({ version: 1, tools: [] });
        dispose();
        const second = fixture(['hline']); mount(second.workspace);
        expect(second.charts[0]!.favorites).toEqual([]);
        expect(labels(second.host)).toEqual([]);
    });

    it('restores a saved local preference ahead of older session favorites and drops unknown keys', () => {
        localStorage.setItem(DRAWING_FAVORITES_KEY, JSON.stringify({ version: 1, tools: ['ray', 'unknown', 'ray', 'hline'] }));
        const { workspace, host, charts } = fixture(['box']); mount(workspace);
        expect(labels(host)).toEqual(['Ray', 'Horizontal Line']);
        expect(charts[0]!.favorites).toEqual(['ray', 'hline']);
    });

    it('adopts existing native session stars when there is no valid local preference', () => {
        localStorage.setItem(DRAWING_FAVORITES_KEY, '{bad');
        const { workspace, host } = fixture(['fibfan']); mount(workspace);
        expect(labels(host)).toEqual(['Fib Fan']);
    });

    it('follows active cells and initializes newly created cells without leaving old listeners', async () => {
        const { workspace, host, charts, activate, add, remove } = fixture(); mount(workspace);
        const second = add(); await Promise.resolve();
        expect(second.favorites).toEqual(['trendline', 'hline', 'box']);
        activate(1);
        host.querySelector<HTMLButtonElement>('button[aria-label="Horizontal Line"]')!.click();
        expect(second.tool).toBe('hline'); expect(charts[0]!.tool).toBeNull();
        expect(host.querySelector('button[aria-label="Horizontal Line"]')!.getAttribute('aria-pressed')).toBe('true');
        activate(0);
        expect(host.querySelector('button[aria-label="Horizontal Line"]')!.getAttribute('aria-pressed')).toBe('false');
        remove(1); await Promise.resolve();
        expect([...second.events.values()].every((handlers) => handlers.size === 0)).toBe(true);
    });

    it('shares preference changes between windows at the same local address', () => {
        const { workspace, host, charts } = fixture(); mount(workspace);
        window.dispatchEvent(new StorageEvent('storage', { key: DRAWING_FAVORITES_KEY,
            newValue: JSON.stringify({ version: 1, tools: ['vline'] }), storageArea: localStorage }));
        expect(charts[0]!.favorites).toEqual(['vline']); expect(labels(host)).toEqual(['Vertical Line']);
        window.dispatchEvent(new StorageEvent('storage', { key: DRAWING_FAVORITES_KEY, newValue: 'bad' }));
        expect(labels(host)).toEqual(['Vertical Line']);
    });

    it('remains usable when browser storage is unavailable', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled'); });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled'); });
        const { workspace, host, charts } = fixture(); mount(workspace);
        charts[0]!.drawings.setFavorites(['ray']);
        expect(labels(host)).toEqual(['Ray']);
    });

    it('disposes listeners, style and toolbar even with a cell refresh pending', async () => {
        const { workspace, host, charts, add } = fixture(); const dispose = mount(workspace); add(); dispose();
        await Promise.resolve();
        expect(host.querySelector('[role="toolbar"]')).toBeNull(); expect(host.querySelector('style')).toBeNull();
        for (const chart of charts) expect([...chart.events.values()].every((handlers) => handlers.size === 0)).toBe(true);
    });

    it('moves by its six-dot grip, clamps to the workspace, and persists only a completed drag', () => {
        const { workspace, host, charts } = fixture(); measured(host); mount(workspace);
        const bar = host.querySelector<HTMLElement>('.local-drawing-favorites')!;
        const grip = bar.querySelector<HTMLButtonElement>('.local-drawing-grip')!;
        expect(grip.querySelectorAll('circle')).toHaveLength(6);
        expect(Number.parseFloat(bar.style.left)).toBe(428);
        expect(Number.parseFloat(bar.style.top)).toBe(548);
        const chartPointer = vi.fn(); host.addEventListener('pointerdown', chartPointer);
        grip.dispatchEvent(pointer('pointerdown', 500, 80));
        expect(chartPointer).not.toHaveBeenCalled();
        expect(bar.dataset.dragging).toBe('true');
        window.dispatchEvent(pointer('pointermove', 2000, 2000, 2));
        expect(Number.parseFloat(bar.style.left)).toBe(428);
        window.dispatchEvent(pointer('pointermove', 2000, 2000));
        expect(Number.parseFloat(bar.style.left)).toBe(848);
        expect(Number.parseFloat(bar.style.top)).toBe(548);
        expect(localStorage.getItem(DRAWING_FAVORITES_POSITION_KEY)).toBeNull();
        window.dispatchEvent(pointer('pointerup', 2000, 2000));
        expect(JSON.parse(localStorage.getItem(DRAWING_FAVORITES_POSITION_KEY)!)).toEqual({ version: 1, x: 1, y: 1 });
        expect(bar.dataset.dragging).toBeUndefined();
        grip.click(); expect(charts[0]!.tool).toBeNull();
    });

    it('restores a normalized position and reflows proportionally when the workspace size changes', () => {
        localStorage.setItem(DRAWING_FAVORITES_POSITION_KEY, JSON.stringify({ version: 1, x: .25, y: .75 }));
        const { workspace, host } = fixture(); const { resize } = measured(host); mount(workspace);
        const bar = host.querySelector<HTMLElement>('.local-drawing-favorites')!;
        expect(Number.parseFloat(bar.style.left)).toBe(218);
        expect(Number.parseFloat(bar.style.top)).toBe(413);
        resize(500, 300);
        expect(Number.parseFloat(bar.style.left)).toBe(93);
        expect(Number.parseFloat(bar.style.top)).toBe(188);
        expect(JSON.parse(localStorage.getItem(DRAWING_FAVORITES_POSITION_KEY)!)).toEqual({ version: 1, x: .25, y: .75 });
        expect(JSON.parse(localStorage.getItem(DRAWING_FAVORITES_KEY)!).tools).toEqual(['trendline', 'hline', 'box']);
    });

    it('lets the focused grip move with arrow keys without triggering chart shortcuts', () => {
        const { workspace, host, charts } = fixture(); measured(host); mount(workspace);
        const bar = host.querySelector<HTMLElement>('.local-drawing-favorites')!;
        const grip = bar.querySelector<HTMLButtonElement>('.local-drawing-grip')!;
        const chartKey = vi.fn(); host.addEventListener('keydown', chartKey);
        const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }); grip.dispatchEvent(left);
        expect(left.defaultPrevented).toBe(true); expect(chartKey).not.toHaveBeenCalled();
        expect(Number.parseFloat(bar.style.left)).toBe(426);
        grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
        expect(Number.parseFloat(bar.style.left)).toBe(446);
        expect(JSON.parse(localStorage.getItem(DRAWING_FAVORITES_POSITION_KEY)!)).toMatchObject({ version: 1 });
        grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', ctrlKey: true, bubbles: true, cancelable: true }));
        expect(Number.parseFloat(bar.style.left)).toBe(446); expect(chartKey).toHaveBeenCalledOnce();
        expect(charts[0]!.tool).toBeNull();
    });

    it('keeps the bar inside the chart grid and re-clamps it when the favorite count grows', () => {
        localStorage.setItem(DRAWING_FAVORITES_POSITION_KEY, JSON.stringify({ version: 1, x: 1, y: 0 }));
        const { workspace, host, charts } = fixture(); measured(host, 400, 240);
        const grid = document.createElement('div'); grid.className = 'vela-ws-grid'; host.append(grid);
        Object.defineProperty(grid, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(144, 90, 356, 160) });
        mount(workspace);
        const bar = host.querySelector<HTMLElement>('.local-drawing-favorites')!;
        expect(bar.getBoundingClientRect().left).toBe(348);
        expect(bar.getBoundingClientRect().top).toBe(98);
        charts[0]!.drawings.setFavorites(['trendline', 'hline', 'box', 'ray', 'fibfan', 'circle', 'text', 'arrow', 'ellipse']);
        expect(bar.getBoundingClientRect().left).toBe(152);
        expect(bar.getBoundingClientRect().right).toBe(492);
        expect(labels(host)).toHaveLength(9);
    });

    it('shares valid position updates between windows and ignores invalid or conflicting drag updates', () => {
        const { workspace, host } = fixture(); measured(host); mount(workspace);
        const bar = host.querySelector<HTMLElement>('.local-drawing-favorites')!;
        const notify = (newValue: string | null): void => { window.dispatchEvent(new StorageEvent('storage', { key: DRAWING_FAVORITES_POSITION_KEY, newValue, storageArea: localStorage })); };
        notify(JSON.stringify({ version: 1, x: 0, y: 1 }));
        expect(Number.parseFloat(bar.style.left)).toBe(8); expect(Number.parseFloat(bar.style.top)).toBe(548);
        notify(JSON.stringify({ version: 1, x: -1, y: .5 }));
        expect(Number.parseFloat(bar.style.left)).toBe(8);
        bar.querySelector<HTMLElement>('.local-drawing-grip')!.dispatchEvent(pointer('pointerdown', 110, 610));
        notify(JSON.stringify({ version: 1, x: 1, y: 0 }));
        expect(Number.parseFloat(bar.style.left)).toBe(8);
        window.dispatchEvent(pointer('pointercancel', 110, 610));
        notify(null);
        expect(Number.parseFloat(bar.style.left)).toBe(428); expect(Number.parseFloat(bar.style.top)).toBe(548);
    });

    it('finishes a drag when the app window loses focus and leaves no stuck movement', () => {
        const { workspace, host } = fixture(); measured(host); mount(workspace);
        const bar = host.querySelector<HTMLElement>('.local-drawing-favorites')!;
        bar.querySelector<HTMLElement>('.local-drawing-grip')!.dispatchEvent(pointer('pointerdown', 500, 80));
        window.dispatchEvent(pointer('pointermove', 520, 100));
        window.dispatchEvent(new Event('blur'));
        expect(bar.dataset.dragging).toBeUndefined();
        expect(JSON.parse(localStorage.getItem(DRAWING_FAVORITES_POSITION_KEY)!)).toMatchObject({ version: 1 });
        const left = bar.style.left;
        window.dispatchEvent(pointer('pointermove', 800, 500)); expect(bar.style.left).toBe(left);
    });

    it('disconnects resize observation and in-progress pointer listeners when disposed', () => {
        const callbacks: ResizeObserverCallback[] = [];
        const observe = vi.fn(); const disconnect = vi.fn();
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
            observe = observe; disconnect = disconnect;
        });
        const { workspace, host } = fixture(); measured(host); const dispose = mount(workspace);
        const bar = host.querySelector<HTMLElement>('.local-drawing-favorites')!;
        bar.querySelector<HTMLElement>('.local-drawing-grip')!.dispatchEvent(pointer('pointerdown', 500, 80));
        expect(observe).toHaveBeenCalledTimes(2);
        dispose(); expect(disconnect).toHaveBeenCalledOnce();
        const previous = bar.style.cssText;
        window.dispatchEvent(pointer('pointermove', 1000, 500)); window.dispatchEvent(new Event('resize'));
        callbacks[0]!([], {} as ResizeObserver);
        expect(bar.style.cssText).toBe(previous);
        expect(host.querySelector('[role="toolbar"]')).toBeNull();
    });

    it('docks new preferences into the actual bottom bar, and keeps the saved tool list', () => {
        localStorage.setItem(DRAWING_FAVORITES_KEY, JSON.stringify({ version: 1, tools: ['ray', 'fibfan'] }));
        const { workspace, host } = fixture(); measured(host);
        const bottom = document.createElement('div'); bottom.className = 'vela-widget-bottombar';
        const spacer = document.createElement('span'); spacer.className = 'vela-bb-spacer'; bottom.append(spacer); host.append(bottom);
        mount(workspace);
        const bar = host.querySelector<HTMLElement>('.local-drawing-favorites')!;
        expect(bar.parentElement).toBe(bottom); expect(bar.nextElementSibling).toBe(spacer);
        expect(bar.dataset.placement).toBe('bottom'); expect(labels(host)).toEqual(['Ray', 'Fib Fan']);
        expect(localStorage.getItem(DRAWING_FAVORITES_POSITION_KEY)).toBeNull();
    });

    it('preserves a custom floating position and redocks only on an explicit grip command', () => {
        localStorage.setItem(DRAWING_FAVORITES_POSITION_KEY, JSON.stringify({ version: 1, x: .25, y: .75 }));
        const { workspace, host } = fixture(); measured(host);
        const bottom = document.createElement('div'); bottom.className = 'vela-widget-bottombar'; host.append(bottom);
        mount(workspace);
        const bar = host.querySelector<HTMLElement>('.local-drawing-favorites')!;
        expect(bar.parentElement).toBe(host); expect(bar.dataset.placement).toBe('floating');
        const grip = bar.querySelector<HTMLElement>('.local-drawing-grip')!;
        grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
        expect(bar.parentElement).toBe(bottom); expect(bar.dataset.placement).toBe('bottom');
        expect(JSON.parse(localStorage.getItem(DRAWING_FAVORITES_POSITION_KEY)!)).toEqual({ version: 2, placement: 'bottom' });
        expect(document.activeElement).toBe(grip);
        grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
        expect(bar.parentElement).toBe(host); expect(bar.dataset.placement).toBe('floating');
        expect(JSON.parse(localStorage.getItem(DRAWING_FAVORITES_POSITION_KEY)!)).toMatchObject({ version: 1 });
    });

    it('toggles actual visibility without deleting favorite tools or changing placement', () => {
        const { workspace, host, charts } = fixture(); mount(workspace);
        const bar = host.querySelector<HTMLElement>('.local-drawing-favorites')!;
        host.dispatchEvent(new CustomEvent('local-drawing-favorites:toggle'));
        expect(bar.hidden).toBe(true); expect(host.dataset.localDrawingFavoritesVisible).toBe('false');
        expect(localStorage.getItem(DRAWING_FAVORITES_VISIBLE_KEY)).toBe('false');
        expect(charts[0]!.favorites).toEqual(['trendline', 'hline', 'box']);
        expect(localStorage.getItem(DRAWING_FAVORITES_POSITION_KEY)).toBeNull();
        host.dispatchEvent(new CustomEvent('local-drawing-favorites:toggle'));
        expect(bar.hidden).toBe(false); expect(host.dataset.localDrawingFavoritesVisible).toBe('true');
    });
});
