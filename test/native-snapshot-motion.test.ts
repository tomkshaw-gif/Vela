import { describe, expect, it, vi } from 'vitest';
import { NativeRenderer } from '../src/renderers/native/NativeRenderer';

/* eslint-disable @typescript-eslint/no-explicit-any -- drive the actual unmounted animation and input seams. */
function fixture() {
    const renderer = new NativeRenderer();
    const state = renderer as any;
    state.coords.setSize(800, 200, 1);
    state.scheduler = { invalidate: vi.fn() };
    state.animator = { active: false, stop: vi.fn(), start: vi.fn() };
    state.introPlayed = true;
    renderer.applyFeature('gestureProfile', 'terminal');
    const bars = (start: number) => Array.from({ length: 5000 }, (_, i) => ({ time: (start + i) * 1000, open: 100, high: 102, low: 99, close: 101, volume: 1 }));
    renderer.setBars(bars(0));
    state.coords.setViewport({ barSpacing: 10, rightOffset: -60 });
    state.targetBarSpacing = 10;
    const pane = state.scene.ensurePane('price', 'price', 0);
    pane.scale = pane.manualScale = { min: 90, max: 110, log: true, invert: true };
    for (const key of ['computeScales', 'paintData', 'renderCrosshairLayer', 'updateLegendValues']) state[key] = () => {};
    state.easeScales = state.easeLiveBar = () => false;
    return { renderer, state, bars, pane };
}

describe('snapshot replacement during horizontal motion', () => {
    for (const offset of [-60, 400]) it(`clamps an idle empty/refill viewport from ${offset} without changing zoom or manual scales`, () => {
        const { renderer, state, bars, pane } = fixture();
        const manual = pane.manualScale;
        state.coords.setViewport({ barSpacing: 10, rightOffset: offset });
        renderer.setBars([], { preserveView: true });
        renderer.setBars(bars(5000).slice(0, 10), { preserveView: true });
        const viewport = state.coords.getViewport();
        expect(viewport.barSpacing).toBe(10);
        expect(viewport.rightOffset).toBe(state.clampViewport(10, offset).rightOffset);
        expect(state.bars.some((_: unknown, i: number) => state.coords.logicalToX(i) >= 0 && state.coords.logicalToX(i) <= 800)).toBe(true);
        state.animTick(16);
        expect(state.coords.getViewport()).toEqual(viewport);
        expect(pane.manualScale).toBe(manual);
    });

    for (const motion of ['cursor zoom', 'keyboard zoom', 'fling', 'scroll'] as const) {
        for (const start of [4945, 5000]) it(`cancels ${motion} after ${start === 5000 ? 'a disjoint window' : 'an overlapping window loses its anchor'}`, () => {
            const { renderer, state, bars, pane } = fixture();
            const manual = pane.manualScale;
            if (motion === 'cursor zoom') state.zoomTo(12, state.coords.xToLogical(400), 400);
            else if (motion === 'keyboard zoom') state.zoomByStep(1);
            else if (motion === 'fling') state.fling(-0.3, 300);
            else state.scrollTargetRO = 6;
            renderer.setBars(bars(start), { preserveView: true });
            const replaced = state.coords.getViewport();
            expect(replaced.barSpacing).toBe(10);
            for (let frame = 0; frame < 3; frame++) {
                state.animTick(16);
                expect(state.coords.getViewport()).toEqual(replaced);
            }
            expect(state.scene.panes.get('price')).toBe(pane);
            expect(pane.manualScale).toBe(manual);
            expect(state.panVelocity).toBe(0);
            expect(state.scrollTargetRO).toBeNull();
            expect(state.terminalPanRemainingMs).toBeNull();
            // A fresh terminal wheel step and keyboard step remain usable after cancellation.
            state.zoomTime(400, 1, false);
            const wheel = state.coords.getViewport();
            expect(wheel.barSpacing).toBeCloseTo(11);
            state.animTick(16);
            expect(state.coords.getViewport()).toEqual(wheel);
            state.zoomByStep(1); state.animTick(16);
            expect(state.coords.getViewport().barSpacing).toBeGreaterThan(wheel.barSpacing);
        });
    }

    it('cancels a lost cursor anchor even when the held right edge survives', () => {
        const { renderer, state, bars } = fixture();
        state.zoomTo(12, state.coords.xToLogical(400), 400);
        const time = state.coords.logicalToTime(state.coords.rightEdgeLogical);
        renderer.setBars(bars(4920), { preserveView: true });
        expect(state.coords.logicalToTime(state.coords.rightEdgeLogical)).toBe(time);
        const replaced = state.coords.getViewport();
        state.animTick(16);
        expect(state.coords.getViewport()).toEqual(replaced);
    });

    it('continues an overlapping zoom when its historical anchor survives', () => {
        const { renderer, state, bars } = fixture();
        const anchorTime = state.coords.logicalToTime(state.coords.xToLogical(400));
        state.zoomTo(12, state.coords.xToLogical(400), 400);
        renderer.setBars(bars(100), { preserveView: true });
        state.animTick(16);
        expect(state.coords.getViewport().barSpacing).toBeGreaterThan(10);
        expect(state.coords.logicalToX(state.coords.timeToLogical(anchorTime))).toBeCloseTo(400);
    });

    it('cannot revive horizontal motion after an empty snapshot and refill', () => {
        const { renderer, state, bars, pane } = fixture();
        const manual = pane.manualScale;
        state.zoomTo(12, state.coords.xToLogical(400), 400);
        renderer.setBars([], { preserveView: true });
        renderer.setBars(bars(5000), { preserveView: true });
        const replaced = state.coords.getViewport();
        state.animTick(16);
        expect(state.coords.getViewport()).toEqual(replaced);
        expect(pane.manualScale).toBe(manual);
    });
});
