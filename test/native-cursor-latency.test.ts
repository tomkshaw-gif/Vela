import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeRenderer } from '../src/renderers/native/NativeRenderer';
import { InputController, type InputControllerDeps } from '../src/renderers/native/core/InputController';
import { Scheduler, InvalidateLevel } from '../src/renderers/native/core/Scheduler';

// Separate event-loop tasks without advancing the controlled RAF or adding Node globals to library types.
const nextTask = () => new Promise<void>(resolve => {
    (globalThis as unknown as { setImmediate(callback: () => void): void }).setImmediate(resolve);
});

beforeEach(() => vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) }));
afterEach(() => vi.unstubAllGlobals());

/* eslint-disable @typescript-eslint/no-explicit-any -- exercise input, scheduling and actual cursor Canvas paints without browser-owned mounting. */
function fixture(active = false) {
    const renderer = new NativeRenderer(), state = renderer as any;
    state.coords.setSize(800, 200, 1);
    state.introPlayed = true;
    state.scheduler = { invalidate() {} };
    state.animator = { active, start: vi.fn(), stop: vi.fn() };
    renderer.setBars(Array.from({ length: 5000 }, (_, i) => ({ time: i * 60_000, open: 100, high: 102, low: 99, close: 101, volume: 1 })));
    state.coords.setViewport({ barSpacing: 10, rightOffset: 0 }); state.targetBarSpacing = 10;
    state.theme = { background: '#000000', textColor: '#cccccc', gridColor: '#222222', borderColor: '#333333', upColor: '#00aa00', downColor: '#aa0000', fontFamily: 'sans-serif' };
    const pane = state.scene.ensurePane('price', 'price', 0);
    pane.bounds = { top: 0, height: 200 }; pane.scale = { min: 90, max: 110 };
    state.paintedData = true;
    state.computeScales = vi.fn(); state.paintData = vi.fn(); state.updateLegendValues = vi.fn();
    state.easeScales = state.easeLiveBar = () => false;
    const paints: Array<{ x: number; y: number } | null> = [];
    const ctx = new Proxy({ globalAlpha: 1 } as CanvasRenderingContext2D, {
        get: (target, key) => key === 'stroke' ? () => paints.push(state.scene.crosshair && { ...state.scene.crosshair })
            : key === 'measureText' ? (text: string) => ({ width: text.length * 6 })
            : Reflect.has(target, key) ? Reflect.get(target, key) : () => undefined,
        set: (target, key, value) => Reflect.set(target, key, value),
    });
    state.crosshairLayer.mount({ width: 864, height: 222, getContext: () => ctx });
    state.chrome.prepare = vi.fn(); state.chrome.render = vi.fn(); state.trackMarkPopover = vi.fn();
    const frames = new Map<number, () => void>();
    let frameId = 0;
    const raf = vi.fn((callback: () => void) => { frames.set(++frameId, callback); return frameId; });
    const cancel = vi.fn((handle: number) => { frames.delete(handle); });
    const scheduler = new Scheduler((level) => state.renderFrame(level), raf, cancel);
    state.scheduler = scheduler;
    const noop = () => {};
    const onPointerMove = vi.fn((x: number | null, y: number | null) => state.handlePointerMove(x, y));
    const deps: InputControllerDeps = { getCoords: () => state.coords, apply: noop, zoomTo: noop, fling: noop,
        onPointerMove, onClick: noop, beginPriceScale: noop, priceScaleBy: noop, beginPricePan: () => false, pricePanBy: noop,
        resetPriceScale: noop, dataDblClick: noop, paneSeparatorAt: () => false, beginPaneResize: noop, paneResizeBy: noop,
        resetPaneSize: noop, resetView: noop };
    const listeners = new Map<string, (event: unknown) => void>();
    const element = { ownerDocument: { defaultView: { navigator: { platform: 'Win32' }, addEventListener() {}, removeEventListener() {} } },
        style: { setProperty() {} }, getBoundingClientRect: () => ({ left: 0, top: 0 }),
        addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
        removeEventListener: (type: string) => listeners.delete(type) };
    const input = new InputController(deps); input.attach(element as unknown as HTMLElement);
    const move = (x: number, y: number) => listeners.get('pointermove')!({ clientX: x, clientY: y, pointerType: 'mouse', timeStamp: 1000 });
    const frame = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); };
    const dispose = () => { input.detach(); scheduler.destroy(); state.crosshairLayer.destroy(); };
    return { renderer, state, scheduler, input, paints, move, frame, frames, raf, cancel, onPointerMove, dispose };
}

describe('native pointer frame coalescing', () => {
    for (const active of [false, true]) it(`paints the latest of 120 task-separated moves once per frame with animator ${active ? 'active' : 'idle'}`, async () => {
        const h = fixture(active);
        try {
            for (let i = 0; i < 120; i++) { h.move(300 + i, 80 + i / 4); await nextTask(); }
            expect(h.onPointerMove).toHaveBeenCalledTimes(120);
            expect(h.paints).toEqual([]);
            expect(h.raf).toHaveBeenCalledTimes(1);
            expect(h.frames.size).toBe(1);
            h.frame();
            expect(h.paints).toEqual([{ x: 419, y: 109.75 }]);
            expect(h.frames.size).toBe(0);
            expect(h.state.computeScales).not.toHaveBeenCalled();
            expect(h.state.paintData).not.toHaveBeenCalled();
            expect(h.state.chrome.render).not.toHaveBeenCalled();
            h.move(450, 110); h.frame();
            expect(h.paints).toEqual([{ x: 419, y: 109.75 }, { x: 450, y: 110 }]);
            expect(h.raf).toHaveBeenCalledTimes(2);
        } finally { h.dispose(); }
    });

    it('merges chrome work into the cursor frame and repaints only opted-in SDK cursor layers', async () => {
        const h = fixture();
        const cursor = vi.fn(), data = vi.fn();
        h.state.extLayers = [
            { owner: null, channel: 'cursor', def: { id: 'cursor', repaintOnCursor: true }, instance: { render: cursor } },
            { owner: null, channel: 'data', def: { id: 'data' }, instance: { render: data } },
        ];
        try {
            h.scheduler.invalidate(InvalidateLevel.Chrome); h.move(400, 90); h.move(410, 100);
            await nextTask();
            expect(h.paints).toEqual([]); expect(h.frames.size).toBe(1);
            h.frame();
            expect(h.paints).toHaveLength(1); expect(h.state.paintData).not.toHaveBeenCalled();
            expect(h.state.chrome.prepare).toHaveBeenCalledTimes(1); expect(h.state.chrome.render).toHaveBeenCalledTimes(1);
            expect(cursor).toHaveBeenCalledTimes(1); expect(data).not.toHaveBeenCalled();
            expect(cursor.mock.calls[0]![0].cursor).toEqual({ x: 410, y: 100 });
            expect(h.raf).toHaveBeenCalledTimes(1); expect(h.frames.size).toBe(0);
        } finally { h.dispose(); }
    });

    for (const level of [InvalidateLevel.Light, InvalidateLevel.Full]) for (const cursorFirst of [true, false])
        it(`atomically merges ${InvalidateLevel[level]} data and cursor with cursor ${cursorFirst ? 'first' : 'last'}`, async () => {
        const h = fixture();
        const crosshair = vi.spyOn(h.state.crosshairLayer, 'render');
        try {
            if (cursorFirst) h.move(400, 90);
            h.scheduler.invalidate(level); h.move(410, 100);
            await nextTask();
            expect(h.paints).toEqual([]);
            expect(h.frames.size).toBe(1); expect(h.raf).toHaveBeenCalledTimes(1);
            h.frame();
            expect(h.state.computeScales).toHaveBeenCalledTimes(1);
            expect(h.state.paintData).toHaveBeenCalledTimes(1);
            expect(h.paints).toEqual([{ x: 410, y: 100 }]);
            expect(crosshair).toHaveBeenCalledTimes(1);
            expect(h.state.paintData.mock.invocationCallOrder[0]).toBeLessThan(crosshair.mock.invocationCallOrder[0]!);
            expect(h.frames.size).toBe(0);
        } finally { h.dispose(); }
    });

    it('reads only the pointed bars and never walks history on a hover burst', () => {
        const h = fixture();
        let reads = 0;
        const bars = new Proxy(h.state.bars, { get: (target, key) => {
            if (key === Symbol.iterator) throw new Error('cursor paint must not walk history');
            if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
            return Reflect.get(target, key);
        } });
        h.state.bars = h.state.scene.bars = bars;
        try {
            for (let i = 0; i < 120; i++) h.move(400, 90);
            expect(reads).toBe(120); expect(h.paints).toEqual([]);
            h.frame();
            expect(reads).toBe(120); expect(h.paints).toHaveLength(1);
            expect(h.state.paintData).not.toHaveBeenCalled();
        } finally { h.dispose(); }
    });

    it('coalesces leave with pending moves and cancels the pending RAF on teardown', () => {
        const h = fixture();
        const crosshair = vi.spyOn(h.state.crosshairLayer, 'render');
        h.move(400, 90); h.state.handlePointerMove(null, null);
        expect(h.paints).toEqual([]); expect(h.state.scene.crosshair).toBeNull();
        expect(h.state.updateLegendValues).not.toHaveBeenCalled();
        expect(h.frames.size).toBe(1); h.frame();
        expect(crosshair).toHaveBeenCalledTimes(1);
        expect(h.state.updateLegendValues).toHaveBeenCalledTimes(1);
        h.move(450, 110); h.dispose();
        h.frame();
        expect(h.paints).toEqual([]); expect(h.frames.size).toBe(0);
    });
});
