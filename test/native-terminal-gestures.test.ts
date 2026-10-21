import { describe, expect, it, vi } from 'vitest';
import { InputController, terminalPanSpeed, type InputControllerDeps } from '../src/renderers/native/core/InputController';
import { CoordinateSystem } from '../src/renderers/native/core/CoordinateSystem';
import { NativeRenderer } from '../src/renderers/native/NativeRenderer';
import type { ViewportState } from '../src/renderers/native/core/ViewportState';

function harness(platform = 'Win32', profile: 'standard' | 'terminal' = 'terminal', native?: {
    coords: CoordinateSystem;
    applyViewport(vp: ViewportState): void;
    zoomTime(x: number, step: number, forceCursor: boolean): void;
}) {
    const coords = native?.coords ?? new CoordinateSystem();
    if (!native) {
        coords.setSize(800, 200, 1);
        coords.setBars(Array.from({ length: 200 }, (_, i) => i * 1000));
        coords.setViewport({ barSpacing: 10, rightOffset: 6 });
    }
    const listeners = new Map<string, (e: unknown) => void>();
    const deps = {
        getCoords: () => coords,
        apply: vi.fn((vp: ViewportState) => native ? native.applyViewport(vp) : coords.setViewport(vp)),
        zoomTo: vi.fn(),
        zoomTime: vi.fn((x: number, step: number, forceCursor: boolean) => native?.zoomTime(x, step, forceCursor)),
        fling: vi.fn(),
        onPointerMove: vi.fn(), onClick: vi.fn(),
        beginPriceScale: vi.fn(), priceScaleBy: vi.fn(),
        beginPricePan: vi.fn(() => false), pricePanBy: vi.fn(),
        beginPricePinch: vi.fn(), pricePinchTo: vi.fn(),
        resetPriceScale: vi.fn(), dataDblClick: vi.fn(),
        paneSeparatorAt: () => false, beginPaneResize: vi.fn(), paneResizeBy: vi.fn(),
        resetPaneSize: vi.fn(), resetView: vi.fn(), resetTimeScale: vi.fn(),
    } satisfies InputControllerDeps;
    const el = {
        ownerDocument: { defaultView: { navigator: { platform }, addEventListener() {}, removeEventListener() {} } },
        style: { setProperty() {} },
        addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
        removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }),
        setPointerCapture() {}, releasePointerCapture() {},
    };
    const input = new InputController(deps);
    input.gestureProfile = profile;
    input.attach(el as unknown as HTMLElement);
    const fire = (type: string, e: Record<string, unknown>) => listeners.get(type)?.({
        clientX: 400, clientY: 100, pointerId: 1, pointerType: 'mouse', button: 0,
        shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 1000, preventDefault() {}, ...e,
    });
    const wheel = (e: Record<string, unknown>) => fire('wheel', { deltaX: 0, deltaY: 0, deltaMode: 0, ...e });
    return { coords, input, deps, fire, wheel };
}

describe('terminal wheel gestures', () => {
    it('normalizes pixel, line and page deltas and caps each time zoom step', () => {
        const h = harness();
        h.wheel({ deltaY: -100 });
        expect(h.deps.zoomTime).toHaveBeenLastCalledWith(400, 1, false);
        h.wheel({ deltaY: 1, deltaMode: 1, timeStamp: 1200 });
        expect(h.deps.zoomTime).toHaveBeenLastCalledWith(400, -0.32, false);
        h.wheel({ deltaY: 1, deltaMode: 2, timeStamp: 1400 });
        expect(h.deps.zoomTime).toHaveBeenLastCalledWith(400, -1, false);
        expect(h.deps.zoomTo).not.toHaveBeenCalled();
    });

    it('rotates Shift-wheel on Windows and keeps Mac Shift-wheel vertical', () => {
        const win = harness();
        win.wheel({ deltaY: 100, shiftKey: true });
        expect(win.coords.getViewport().rightOffset).toBeCloseTo(-2);
        expect(win.deps.zoomTime).not.toHaveBeenCalled();
        const mac = harness('MacIntel');
        mac.wheel({ deltaY: 100, shiftKey: true });
        expect(mac.deps.zoomTime).toHaveBeenCalledWith(400, -1, false);
    });

    it('uses only the platform cursor-anchor modifier', () => {
        for (const [platform, ctrlKey, metaKey, expected] of [
            ['Win32', true, false, true], ['Win32', false, true, false],
            ['MacIntel', true, false, false], ['MacIntel', false, true, true],
        ] as const) {
            const h = harness(platform);
            h.wheel({ deltaY: -50, ctrlKey, metaKey });
            expect(h.deps.zoomTime).toHaveBeenCalledWith(400, 0.5, expected);
        }
    });

    it('filters the accumulated minor axis, resets after a pause, and retains balanced diagonal actions', () => {
        const h = harness();
        h.wheel({ deltaX: 30, deltaY: 5 });
        expect(h.deps.zoomTime).not.toHaveBeenCalled();
        h.wheel({ deltaX: 0, deltaY: 5, timeStamp: 1050 });
        expect(h.deps.zoomTime).not.toHaveBeenCalled();
        h.wheel({ deltaX: 0, deltaY: 5, timeStamp: 1200 });
        expect(h.deps.zoomTime).toHaveBeenCalledTimes(1);
        h.wheel({ deltaX: 20, deltaY: 20, timeStamp: 1400 });
        expect(h.deps.zoomTime).toHaveBeenLastCalledWith(400, -0.2, false);
        expect(h.coords.getViewport().rightOffset).toBeCloseTo(10);
    });

    it('filters raw totals before mixed deltaMode conversion and skips filtering at a zero total', () => {
        const h = harness();
        h.wheel({ deltaX: 3, deltaY: 0, deltaMode: 1 });
        h.wheel({ deltaX: 0, deltaY: 1, deltaMode: 2, timeStamp: 1100 });
        expect(h.deps.zoomTime).not.toHaveBeenCalled();
        h.wheel({ deltaX: -3, deltaY: 1, deltaMode: 0, timeStamp: 1150 });
        expect(h.deps.zoomTime).toHaveBeenCalledWith(400, -0.01, false);
        expect(h.deps.apply).toHaveBeenCalledTimes(2);
    });

    it('normalizes price-axis wheel and keeps the standard wheel contract', () => {
        const h = harness();
        h.wheel({ clientX: 820, deltaY: 100 });
        expect(h.deps.priceScaleBy).toHaveBeenCalledWith(15);
        const standard = harness('Win32', 'standard');
        standard.wheel({ clientX: 820, deltaY: 100 });
        expect(standard.deps.priceScaleBy).toHaveBeenCalledWith(25);
    });
});

describe('terminal pointer gestures', () => {
    it('waits for five Manhattan pixels before panning and stops without mouse inertia', () => {
        const h = harness();
        h.fire('pointerdown', {});
        h.deps.apply.mockClear();
        h.fire('pointermove', { clientX: 402, clientY: 102, timeStamp: 1010 });
        expect(h.deps.apply).not.toHaveBeenCalled();
        h.fire('pointermove', { clientX: 403, clientY: 102, timeStamp: 1020 });
        expect(h.deps.apply).not.toHaveBeenCalled();
        h.fire('pointermove', { clientX: 410, clientY: 102, timeStamp: 1030 });
        expect(h.deps.apply).not.toHaveBeenCalled();
        h.fire('pointermove', { clientX: 413, clientY: 102, timeStamp: 1040 });
        expect(h.coords.getViewport().rightOffset).toBeCloseTo(5.7);
        h.fire('pointerup', { clientX: 413, clientY: 102, timeStamp: 1050 });
        expect(h.deps.fling).not.toHaveBeenCalled();
    });

    it('zooms the time axis by right-edge distance and resets that axis alone', () => {
        const h = harness();
        h.fire('pointerdown', { clientX: 400, clientY: 210 });
        h.fire('pointermove', { clientX: 300, clientY: 210 });
        expect(h.coords.getViewport()).toEqual({ barSpacing: 12.5, rightOffset: 6 });
        h.fire('pointerup', { clientX: 300, clientY: 210 });
        h.fire('dblclick', { clientY: 210 });
        expect(h.deps.resetTimeScale).toHaveBeenCalledTimes(1);
        expect(h.deps.resetView).not.toHaveBeenCalled();
    });

    it('preserves drawing ownership before the movement gate', () => {
        const h = harness();
        const down = vi.fn();
        const move = vi.fn();
        Object.assign(h.deps, { drawingsClaim: () => true, drawingsPointerDown: down, drawingsPointerMove: move });
        h.fire('pointerdown', {});
        h.fire('pointermove', { clientX: 401 });
        expect(down).toHaveBeenCalledOnce();
        expect(move).toHaveBeenCalledOnce();
        expect(h.deps.apply).not.toHaveBeenCalled();
    });

    it('pinches incrementally around the frozen midpoint without translating the view', () => {
        const h = harness();
        h.fire('pointerdown', { pointerType: 'touch', clientX: 300 });
        h.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 500 });
        h.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 600 });
        h.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 700 });
        expect(h.deps.zoomTime.mock.calls).toEqual([[400, 5, true], [400, 5, true]]);
        h.fire('pointercancel', { pointerType: 'touch', pointerId: 2 });
        h.input.detach();
    });

    it('starts a two-anchor price-axis pinch on its first move and never time-zooms it', () => {
        const h = harness();
        h.fire('pointerdown', { pointerType: 'touch', clientX: 820, clientY: 60 });
        h.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 820, clientY: 140 });
        expect(h.deps.beginPricePinch).not.toHaveBeenCalled();
        h.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 820, clientY: 150 });
        expect(h.deps.beginPricePinch).toHaveBeenCalledWith(820, 60, 150);
        expect(h.deps.pricePinchTo).not.toHaveBeenCalled();
        h.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 820, clientY: 160 });
        expect(h.deps.pricePinchTo).toHaveBeenCalledWith(60, 160);
        expect(h.deps.zoomTime).not.toHaveBeenCalled();
        h.input.detach();
    });

    it('keeps a second contact from claiming a plot pinch after a drag has started', () => {
        const h = harness();
        h.fire('pointerdown', { pointerType: 'touch', clientX: 300 });
        h.fire('pointermove', { pointerType: 'touch', clientX: 310 });
        h.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 500 });
        h.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 600 });
        expect(h.deps.zoomTime).not.toHaveBeenCalled();
        h.input.detach();
    });

    it('suspends a pinch with three contacts and starts a fresh two-contact anchor after release', () => {
        const h = harness();
        h.fire('pointerdown', { pointerType: 'touch', clientX: 300 });
        h.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 500 });
        h.fire('pointerdown', { pointerType: 'touch', pointerId: 3, clientX: 700 });
        h.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 600 });
        expect(h.deps.zoomTime).not.toHaveBeenCalled();
        h.fire('pointerup', { pointerType: 'touch', pointerId: 3, clientX: 700 });
        h.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 750 });
        expect(h.deps.zoomTime).toHaveBeenCalledWith(450, 5, true);
        h.input.detach();
    });

    it('prevents pinch admission after even a sub-threshold first-contact move', () => {
        const h = harness();
        h.fire('pointerdown', { pointerType: 'touch', clientX: 300 });
        h.fire('pointermove', { pointerType: 'touch', clientX: 301 });
        h.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 500 });
        h.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 600 });
        expect(h.deps.zoomTime).not.toHaveBeenCalled();
        h.input.detach();
    });

    it('does not resume a price pinch with one remaining contact outside the price axis', () => {
        const h = harness();
        h.fire('pointerdown', { pointerType: 'touch', clientX: 820, clientY: 60 });
        h.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 820, clientY: 140 });
        h.fire('pointerdown', { pointerType: 'touch', pointerId: 3, clientX: 400, clientY: 100 });
        h.fire('pointermove', { pointerType: 'touch', pointerId: 3, clientX: 820, clientY: 100 });
        h.fire('pointerup', { pointerType: 'touch', pointerId: 1, clientX: 820, clientY: 60 });
        h.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 820, clientY: 160 });
        expect(h.deps.beginPricePinch).not.toHaveBeenCalled();
        expect(h.deps.zoomTime).not.toHaveBeenCalled();
        h.input.detach();
    });

    it('samples touch inertia at fifteen-pixel intervals and rejects stale releases', () => {
        for (const [releaseTime, expectedCalls] of [[1060, 1], [1100, 0]] as const) {
            const h = harness();
            h.fire('pointerdown', { pointerType: 'touch', clientX: 300 });
            for (const [clientX, timeStamp] of [[310, 1010], [320, 1020], [330, 1030], [340, 1040], [350, 1050]] as const) {
                h.fire('pointermove', { pointerType: 'touch', clientX, timeStamp });
            }
            h.fire('pointerup', { pointerType: 'touch', clientX: 350, timeStamp: releaseTime });
            expect(h.deps.fling).toHaveBeenCalledTimes(expectedCalls);
            if (expectedCalls) {
                expect(h.deps.fling.mock.calls[0]![0]).toBeCloseTo(-(20 / 30) / 10);
                expect(h.deps.fling.mock.calls[0]![1]).toBeCloseTo(Math.log(Math.log(0.997) / -(20 / 30)) / Math.log(0.997));
            }
            h.input.detach();
        }
    });

    it('uses a five-hundred-millisecond touch double-tap window and suppresses synthetic mouse presses', () => {
        const h = harness();
        h.fire('pointerdown', { pointerType: 'touch' });
        h.fire('pointerup', { pointerType: 'touch', timeStamp: 1020 });
        h.fire('pointerdown', { pointerType: 'touch', timeStamp: 1420 });
        h.fire('pointerup', { pointerType: 'touch', timeStamp: 1440 });
        expect(h.deps.dataDblClick).toHaveBeenCalledOnce();
        h.deps.apply.mockClear();
        h.fire('pointerdown', { pointerType: 'mouse', timeStamp: 1500 });
        expect(h.deps.apply).not.toHaveBeenCalled();
        h.fire('pointerdown', { pointerType: 'mouse', timeStamp: 2000 });
        expect(h.deps.apply).toHaveBeenCalledOnce();
    });

    it('enters touch inspection at 333ms while leaving the view stationary', () => {
        vi.useFakeTimers();
        try {
            const h = harness();
            h.fire('pointerdown', { pointerType: 'touch' });
            vi.advanceTimersByTime(332);
            expect(h.deps.onPointerMove).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(h.deps.onPointerMove).toHaveBeenCalledWith(400, 100);
            h.input.detach();
        } finally { vi.useRealTimers(); }
    });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- test the renderer's actual private gesture seams. */
function renderer() {
    const r = new NativeRenderer();
    const state = r as any;
    r.applyFeature('gestureProfile', 'terminal');
    state.coords.setSize(800, 200, 1);
    state.coords.setBars(Array.from({ length: 200 }, (_, i) => i * 1000));
    state.coords.setViewport({ barSpacing: 10, rightOffset: 6.3 });
    state.animator = { stop: vi.fn(), start: vi.fn() };
    state.scheduler = { invalidate: vi.fn() };
    state.emitViewportChange = vi.fn();
    return { r, state };
}

describe('terminal renderer authority', () => {
    it('routes cursor wheel zoom and horizontal wheel pan through the native half-bar coordinates', () => {
        const { state } = renderer();
        const h = harness('Win32', 'terminal', state);
        h.wheel({ clientX: 350, deltaY: -100, ctrlKey: true });
        expect(state.coords.getViewport().rightOffset).toBeCloseTo(2.409090909090909);
        expect(state.coords.logicalToX(161)).toBeCloseTo(350);
        h.wheel({ clientX: 350, deltaX: 25, timeStamp: 1200 });
        expect(state.coords.logicalToX(161)).toBeCloseTo(330); // terminal horizontal wheel normalization is 0.8
        h.input.detach();
    });

    it('defaults to standard and supports an opt-in profile without changing animation preferences', () => {
        const r = new NativeRenderer();
        expect(r.features).toContain('gestureProfile');
        expect(r.readFeature('gestureProfile')).toBe('standard');
        r.applyFeature('gestureProfile', 'terminal');
        expect(r.readFeature('gestureProfile')).toBe('terminal');
        expect(r.readFeature('animZoom')).toBe(70);
    });

    it('zooms instantly by ten percent, keeping right offset or restoring the rounded cursor bar', () => {
        const { state } = renderer();
        state.zoomTime(350, 1, false);
        expect(state.coords.getViewport()).toEqual({ barSpacing: 11, rightOffset: 6.3 });
        expect(state.animator.start).not.toHaveBeenCalled();
        const anchor = Math.round(Math.round(state.coords.xToLogical(350) * 1e6) / 1e6);
        state.zoomTime(350, -1, true);
        expect(state.coords.getViewport().barSpacing).toBeCloseTo(9.9);
        expect(state.coords.logicalToX(anchor)).toBeCloseTo(350);
        const leftAnchor = Math.round(state.coords.xToLogical(1));
        state.zoomTime(-100, 1, true);
        expect(state.coords.logicalToX(leftAnchor)).toBeCloseTo(1);
    });

    it('rescales price by its pane-local grab ratio and pans inverted manual scales over the projected height', () => {
        const { state } = renderer();
        const pane = state.scene.ensurePane('price', 'price', 0);
        pane.bounds = { top: 0, height: 200 };
        pane.scale = { min: 100, max: 200, invert: true };
        state.scene.invertScale = true;
        state.beginPriceScale(820, 100);
        state.priceScaleBy(20);
        expect(pane.manualScale.max - pane.manualScale.min).toBeCloseTo(100 * 139.8 / 119.8);
        pane.scale = { min: 100, max: 200, invert: true };
        pane.manualScale = { ...pane.scale };
        expect(state.beginPricePan(100)).toBe(true);
        state.pricePanBy(20);
        expect(pane.manualScale.min).toBeCloseTo(90);
        expect(pane.manualScale.max).toBeCloseTo(190);
    });

    it('time-axis reset restores six-pixel spacing without clearing a manual price scale', () => {
        const { state } = renderer();
        const pane = state.scene.ensurePane('price', 'price', 0);
        pane.manualScale = { min: 100, max: 200 };
        state.resetTimeScale();
        expect(state.coords.getViewport()).toEqual({ barSpacing: 6, rightOffset: 10 });
        expect(pane.manualScale).toEqual({ min: 100, max: 200 });
        state.scene.style.margins.right = 18;
        state.resetTimeScale();
        expect(state.coords.getViewport().rightOffset).toBe(18);
    });

    it('does not freeze an autoscaled pane on body grabs or percentage/indexed price-axis drags', () => {
        const { state } = renderer();
        const pane = state.scene.ensurePane('price', 'price', 0);
        pane.bounds = { top: 0, height: 200 };
        pane.scale = { min: 100, max: 200 };
        expect(state.beginPricePan(100)).toBe(false);
        expect(pane.manualScale).toBeNull();
        for (const mode of ['percent', 'indexed']) {
            state.scene.scaleMode = mode;
            state.beginPriceScale(820, 100);
            state.priceScaleBy(20);
            expect(pane.manualScale).toBeNull();
        }
    });

    it('uses pane-local axis grabs and clamps the per-gesture price span factor to one tenth', () => {
        const { state } = renderer();
        const pane = state.scene.ensurePane('study', 'study', 1);
        pane.bounds = { top: 100, height: 100 };
        pane.scale = { min: 100, max: 200 };
        state.beginPriceScale(820, 150);
        state.priceScaleBy(10);
        expect(pane.manualScale.max - pane.manualScale.min).toBeCloseTo(100 * 69.8 / 59.8);
        state.priceScaleBy(-10000);
        expect(pane.manualScale.max - pane.manualScale.min).toBeCloseTo(10);
    });

    it('keeps the terminal minimum spacing independent of loaded history and bounds future whitespace', () => {
        const { state } = renderer();
        expect(state.clampViewport(0.5, 0).barSpacing).toBe(0.5);
        expect(state.clampViewport(10, 1000).rightOffset).toBe(78);
        state.coords.setSize(4000, 200, 1);
        expect(state.clampViewport(2000, 0).barSpacing).toBe(2000);
    });

    it('keeps a one-bar replay head inside terminal spacing and placement bounds', () => {
        const { state } = renderer();
        state.coords.setBars([0]);
        expect(state.clampViewport(1000, -1000)).toEqual({ barSpacing: 400, rightOffset: 1 });
        expect(state.clampViewport(10, 1000)).toEqual({ barSpacing: 10, rightOffset: 78 });
    });

    it('fits the two price-pinch anchors in linear, inverted, and logarithmic native coordinates', () => {
        for (const scale of [{ min: 100, max: 200 }, { min: 100, max: 200, invert: true }, { min: 10, max: 1000, log: true }]) {
            const { state } = renderer();
            const pane = state.scene.ensurePane('price', 'price', 0);
            pane.bounds = { top: 0, height: 200 };
            pane.scale = scale;
            const a = state.coords.yToPrice(50, scale, pane.bounds);
            const b = state.coords.yToPrice(150, scale, pane.bounds);
            state.beginPricePinch(820, 50, 150);
            expect(pane.manualScale).toBeNull();
            state.pricePinchTo(25, 175);
            expect(state.coords.priceToY(a, pane.manualScale, pane.bounds)).toBeCloseTo(25);
            expect(state.coords.priceToY(b, pane.manualScale, pane.bounds)).toBeCloseTo(175);
            const last = { ...pane.manualScale };
            state.pricePinchTo(100, 100);
            expect(pane.manualScale).toEqual(last);
        }
    });

    it('integrates terminal momentum analytically and keeps it horizontal', () => {
        const { state } = renderer();
        state.targetBarSpacing = 10;
        state.computeScales = () => {};
        state.easeScales = () => false;
        state.easeLiveBar = () => false;
        state.paintData = () => {};
        state.renderCrosshairLayer = () => {};
        state.updateLegendValues = () => {};
        state.fling(0.05, 100);
        state.animTick(40);
        expect(state.coords.getViewport().rightOffset).toBeCloseTo(6.3 + 0.05 * (Math.pow(0.997, 40) - 1) / Math.log(0.997));
        state.animTick(60);
        expect(state.coords.getViewport().rightOffset).toBeCloseTo(6.3 + 0.05 * (Math.pow(0.997, 100) - 1) / Math.log(0.997));
        expect(state.panVelocity).toBe(0);
        expect(state.terminalPanRemainingMs).toBeNull();
    });
});

describe('terminal kinetic sampling', () => {
    it('weights matching segments by distance, caps speed, and discards pre-reversal history', () => {
        expect(terminalPanSpeed([{ x: 0, time: 0 }, { x: 20, time: 20 }, { x: 60, time: 40 }], 40)).toBeCloseTo(5 / 3);
        expect(terminalPanSpeed([{ x: 0, time: 0 }, { x: 200, time: 1 }], 1)).toBe(7);
        expect(terminalPanSpeed([{ x: 0, time: 0 }, { x: 20, time: 20 }, { x: 0, time: 40 }], 40)).toBe(-1);
        expect(terminalPanSpeed([{ x: 0, time: 0 }, { x: 15, time: 100 }], 100)).toBe(0);
        expect(terminalPanSpeed([{ x: 0, time: 0 }, { x: 20, time: 20 }], 71)).toBe(0);
    });
});
