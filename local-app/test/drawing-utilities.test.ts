// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingToolbarUtility } from '../../src/workspace';
import type { IChartRenderer } from '../../src/core/ports/IChartRenderer';
import type { VelaEventMap } from '../../src/core/events/types';
import { TypedEventBus } from '../../src/core/events/EventBus';
import { DrawingController } from '../../src/core/drawings/DrawingController';
import { DrawingsControl } from '../../src/core/DrawingsControl';
import { presetToRange } from '../../src/core/visible-range';
import { LOCAL_RANGE_PRESETS, mountDrawingUtilities } from '../client/drawing-utilities';

function chart() {
    const events = new TypedEventBus<VelaEventMap>();
    const renderer = { capabilities: { userDrawings: true }, userDrawingsPort: {
        setToolbar() {}, showToolbar() {}, onDrawingIntent: () => () => {}, syncDrawings() {}, setActiveTool() {}, setSelection() {},
    } } as unknown as IChartRenderer;
    const ctrl = new DrawingController(renderer, events, false);
    const drawings = new DrawingsControl(ctrl);
    drawings.add('hline', { anchors: [{ time: 1000, price: 100 }] });
    drawings.add('hline', { anchors: [{ time: 2000, price: 110 }] });
    drawings.fromJSON(drawings.toJSON());
    return { drawings, on: events.on.bind(events), getVisibleRange: () => ({ from: 1000, to: 5000 }), setVisibleRange: vi.fn(),
        dispose: () => ctrl.destroy() };
}

function fixture() {
    const host = document.createElement('div'); document.body.append(host);
    const focus = document.createElement('div'); focus.tabIndex = 0; host.append(focus);
    const charts = [chart(), chart()]; let active = 0;
    const handlers = new Map<string, Set<() => void>>();
    let utilities: readonly DrawingToolbarUtility[] = [];
    const refresh = vi.fn();
    const emit = (event: string): void => { for (const handler of handlers.get(event) ?? []) handler(); };
    const workspace = {
        context: () => ({ host, get chart() { return charts[active]!; } }),
        get active() { return { host: focus }; }, cells: () => charts.map((value) => ({ chart: value })),
        setDrawingToolbarUtilities: (value: readonly DrawingToolbarUtility[]) => { utilities = value; },
        refreshDrawingToolbarUtilities: refresh,
        on: (event: string, handler: () => void) => {
            const set = handlers.get(event) ?? new Set(); set.add(handler); handlers.set(event, set);
            return () => set.delete(handler);
        },
    } as unknown as Parameters<typeof mountDrawingUtilities>[0];
    const dispose = mountDrawingUtilities(workspace);
    return { host, charts, refresh, handlers, dispose,
        get utilities() { return utilities; },
        action: (id: string) => utilities.find((utility) => utility.id === id)!,
        activate: (index: number) => { active = index; emit('cell:active'); },
        destroy: () => { dispose(); charts.forEach((value) => value.dispose()); host.remove(); },
    };
}

const fixtures: ReturnType<typeof fixture>[] = [];
const setup = () => { const value = fixture(); fixtures.push(value); return value; };
afterEach(() => { fixtures.splice(0).forEach((value) => value.destroy()); vi.restoreAllMocks(); });

describe('drawing rail utilities', () => {
    it('locks the active chart as one undo step, with state following undo and replacement', () => {
        const value = setup(); const current = value.charts[0]!.drawings; const other = value.charts[1]!.drawings;
        const lock = value.action('lock-all'); lock.run();
        expect(current.all().every((drawing) => drawing.locked)).toBe(true);
        expect(other.all().every((drawing) => !drawing.locked)).toBe(true);
        expect(lock.pressed?.()).toBe(true);
        value.refresh.mockClear(); current.undo();
        expect(current.all().every((drawing) => !drawing.locked)).toBe(true);
        expect(current.canUndo()).toBe(false); expect(lock.pressed?.()).toBe(false);
        expect(value.refresh).toHaveBeenCalled();
        current.fromJSON({ version: 1, drawings: [] });
        expect(lock.disabled?.()).toBe(true); expect(lock.pressed?.()).toBe(false);
    });

    it('hides and restores all drawing visibility, independently from indicator content', () => {
        const value = setup(); const drawings = value.charts[0]!.drawings;
        drawings.show(drawings.all()[0]!.id, false); drawings.fromJSON(drawings.toJSON());
        const before = drawings.all().map((drawing) => drawing.visible);
        const hide = value.action('hide-all'); hide.run();
        expect(drawings.all().map((drawing) => drawing.visible)).toEqual([false, false]);
        expect(hide.pressed?.()).toBe(true);
        drawings.undo(); expect(drawings.all().map((drawing) => drawing.visible)).toEqual(before);
        expect(drawings.canUndo()).toBe(false);
        hide.run(); hide.run(); expect(drawings.all().every((drawing) => drawing.visible)).toBe(true);
    });

    it('deletes locked and hidden drawings on only the current chart and undo restores them together', () => {
        const value = setup(); const drawings = value.charts[0]!.drawings;
        drawings.lock(drawings.all()[0]!.id); drawings.show(drawings.all()[1]!.id, false);
        const before = drawings.toJSON(); drawings.fromJSON(before);
        value.action('delete-all').run(); expect(drawings.all()).toEqual([]);
        expect(value.action('delete-all').disabled?.()).toBe(true);
        expect(value.charts[1]!.drawings.all()).toHaveLength(2);
        drawings.undo(); expect(drawings.toJSON()).toEqual(before); expect(drawings.canUndo()).toBe(false);
        value.activate(1); value.action('lock-all').run();
        expect(value.charts[1]!.drawings.all().every((drawing) => drawing.locked)).toBe(true);
        expect(drawings.toJSON()).toEqual(before);
    });

    it('zooms only the visible chart range without loading or advancing replay data', () => {
        const value = setup(); value.action('zoom-in').run();
        expect(value.charts[0]!.setVisibleRange).toHaveBeenCalledWith({ from: 2000, to: 4000 });
        expect(value.charts[1]!.setVisibleRange).not.toHaveBeenCalled();
    });

    it('toggles the real favorites surface and removes subscriptions and actions on disposal', () => {
        const value = setup(); const listener = vi.fn();
        value.host.addEventListener('local-drawing-favorites:toggle', listener);
        value.action('drawing-favorites').run(); expect(listener).toHaveBeenCalledOnce();
        value.host.dataset.localDrawingFavoritesVisible = 'true';
        expect(value.action('drawing-favorites').pressed?.()).toBe(true);
        value.dispose(); expect(value.utilities).toEqual([]);
        expect([...value.handlers.values()].every((set) => set.size === 0)).toBe(true);
        value.refresh.mockClear(); value.charts[0]!.drawings.add('hline');
        value.host.dispatchEvent(new CustomEvent('local-drawing-favorites:visibility'));
        expect(value.refresh).not.toHaveBeenCalled();
    });
});

describe('local date ranges', () => {
    it('uses an actual five-day visible range with sufficient five-minute history and an All label', () => {
        expect(LOCAL_RANGE_PRESETS.map((range) => range.id)).toEqual(['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'All']);
        const range = LOCAL_RANGE_PRESETS.find((value) => value.id === '5D')!;
        expect(range.tf).toBe('5'); expect(range.bars).toBeGreaterThanOrEqual(5 * 24 * 12);
        const latest = Date.UTC(2026, 9, 20);
        const bar = (time: number) => ({ time, open: 1, high: 2, low: 0, close: 1, volume: 0 });
        expect(presetToRange(range.preset, [bar(latest - 10 * 86400000), bar(latest)]))
            .toEqual({ from: latest - 5 * 86400000, to: latest });
    });
});
