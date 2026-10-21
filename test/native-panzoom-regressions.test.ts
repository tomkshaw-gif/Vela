import { describe, expect, it, vi } from 'vitest';
import { NativeRenderer } from '../src/renderers/native/NativeRenderer';
import { computePaneScale } from '../src/renderers/native/core/autoscale';

/* eslint-disable @typescript-eslint/no-explicit-any -- exercise the renderer's actual gesture and animation seams. */
function renderer(width = 3000, spacingScale = 1, profile = 'terminal') {
    const r = new NativeRenderer();
    const state = r as any;
    state.coords.setSize(width, 200, 1);
    state.coords.setPitchScale(spacingScale);
    state.scheduler = { invalidate: vi.fn() };
    state.animator = { active: false, stop: vi.fn(), start: vi.fn() };
    state.introPlayed = true;
    r.applyFeature('gestureProfile', profile);
    const bars = Array.from({ length: 200 }, (_, i) => ({ time: i * 1000, open: 100, high: 200, low: 100, close: 150, volume: 1 }));
    r.setBars(bars);
    for (const key of ['computeScales', 'paintData', 'renderCrosshairLayer', 'updateLegendValues']) state[key] = () => {};
    state.easeScales = state.easeLiveBar = () => false;
    return { r, state, bars };
}

describe('profile-aware zoom limits', () => {
    for (const width of [2400, 3000, 4000]) for (const scale of [1, 0.75]) {
        it(`keeps wheel, keys, animations, range restore and replacement consistent at ${width}px / ${scale}`, () => {
            const { r, state, bars } = renderer(width, scale);
            const spacing = width / (2.1 * scale);
            state.coords.setViewport({ barSpacing: spacing / 1.1, rightOffset: 0 });
            state.zoomTime(width / 2, 1, false);
            expect(state.coords.getViewport().barSpacing).toBeCloseTo(spacing);
            state.zoomByStep(1);
            expect(state.targetBarSpacing).toBeGreaterThan(spacing);
            state.animTick(16);
            expect(state.coords.getViewport().barSpacing).toBeGreaterThan(spacing);
            for (let frame = 0; frame < 100; frame++) state.animTick(16);
            const zoomed = state.coords.getViewport().barSpacing;
            expect(zoomed).toBeLessThanOrEqual(width / (2 * scale));
            state.zoomByStep(-1);
            expect(state.targetBarSpacing).toBeLessThan(zoomed);
            const range = { from: (199 - width / (spacing * scale)) * 1000, to: 199000 };
            r.setVisibleRange(range);
            expect(state.coords.getViewport().barSpacing).toBeCloseTo(spacing);
            r.setBars(bars.slice(0, 20));
            expect(state.coords.getViewport().barSpacing).toBeCloseTo(spacing);
            r.setBars([]);
            r.setBars(bars);
            expect(state.coords.getViewport().barSpacing).toBeCloseTo(spacing);
        });
    }

    it('retains the standard ceiling and fit-all floor', () => {
        const { state } = renderer(4000, 1, 'standard');
        expect(state.clampViewport(2000, 0).barSpacing).toBe(1000);
        expect(state.clampViewport(0.5, 0).barSpacing).toBeGreaterThan(0.5);
    });

    it('settles a terminal animation after a resize reduces its reachable target', () => {
        const { state } = renderer(4000);
        state.coords.setViewport({ barSpacing: 1800, rightOffset: 0 });
        state.zoomByStep(1);
        state.coords.setSize(2400, 200, 1);
        let frames = 0;
        while (state.animTick(16) && frames < 100) frames++;
        expect(frames).toBeLessThan(100);
        expect(state.targetBarSpacing).toBe(1200);
        expect(state.coords.getViewport().barSpacing).toBe(1200);
    });
});

describe('manual body pan tracks screen motion', () => {
    for (const height of [100, 200]) for (const log of [false, true]) for (const invert of [false, true]) {
        it(`tracks dy with H=${height}, log=${log}, invert=${invert} and unequal margins`, () => {
            const { r, state } = renderer();
            const pane = state.scene.ensurePane('price', 'price', 0);
            pane.bounds = { top: 67, height };
            state.scene.style.margins.top = 23;
            state.scene.style.margins.bottom = 7;
            // Compute the initial window through the actual native margin projection.
            const scale = computePaneScale([], state.scene.bars, true, 0, 199, null, log, () => 0, state.scene.style.margins);
            pane.scale = { ...scale, invert };
            pane.manualScale = { ...pane.scale };
            const y = state.coords.priceToY(150, pane.scale, pane.bounds);
            expect(state.beginPricePan(67 + height / 2)).toBe(true);
            for (const dy of [20, -13]) {
                state.pricePanBy(dy);
                expect(state.coords.priceToY(150, pane.manualScale, pane.bounds) - y).toBeCloseTo(dy, 9);
            }
            expect(r.readFeature('gestureProfile')).toBe('terminal');
        });
    }
});
