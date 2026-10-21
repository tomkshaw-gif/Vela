import { describe, expect, it, vi } from 'vitest';
import { NativeRenderer } from '../src/renderers/native/NativeRenderer';

const bars = (n = 200, head = 0) => Array.from({ length: n }, (_, i) => ({
    time: head + i * 1000, open: 100, high: 110, low: 90, close: 105, volume: 1,
}));

/* eslint-disable @typescript-eslint/no-explicit-any -- drive the native coordinate and gesture seams without a DOM. */
function renderer(profile = 'terminal') {
    const r = new NativeRenderer();
    const state = r as any;
    state.scheduler = { invalidate: vi.fn() };
    state.animator = { stop: vi.fn(), start: vi.fn(), active: false };
    state.introPlayed = true;
    r.applyFeature('gestureProfile', profile);
    state.coords.setSize(800, 200, 1);
    r.setBars(bars());
    state.coords.setViewport({ barSpacing: 10, rightOffset: 6.3 });
    return { r, state };
}

function legacyConfig(right = 10) {
    const config = JSON.parse(JSON.stringify(new NativeRenderer().getConfig()));
    config.version = 1;
    delete config.timeScale.rightOffsetConvention;
    config.margins.right = right;
    return config;
}

describe('terminal uniform bar coordinates', () => {
    it('places centers half a bar inside the right-edge slot and inverts fractional positions', () => {
        const { state } = renderer();
        expect(state.coords.logicalToX(199)).toBeCloseTo(732);
        expect(state.coords.logicalToX(161)).toBeCloseTo(352);
        expect(state.coords.xToLogical(350)).toBeCloseTo(160.8);
        expect(state.coords.rightEdgeLogical).toBeCloseTo(205.8);
        for (const logical of [-2.25, 0, 160.8, 199, 210.75]) {
            expect(state.coords.xToLogical(state.coords.logicalToX(logical))).toBeCloseTo(logical, 10);
        }
        state.coords.setPitchScale(0.75);
        expect(state.coords.logicalToX(199)).toBeCloseTo(749);
        expect(state.coords.xToLogical(749)).toBeCloseTo(199);
    });

    it('selects bar 161 at x350 and restores that bar after a ten-percent cursor zoom', () => {
        const { state } = renderer();
        state.zoomTime(350, 1, true);
        expect(state.coords.getViewport().barSpacing).toBe(11);
        expect(state.coords.getViewport().rightOffset).toBeCloseTo(2.409090909090909);
        expect(state.coords.logicalToX(161)).toBeCloseTo(350);
    });

    it('starts with the half-bar fit and resets to a six-pixel pitch and ten-bar margin', () => {
        const { r, state } = renderer();
        state.didInitialFit = false;
        r.setBars(bars());
        expect(state.coords.logicalToX(199)).toBeCloseTo(760);
        const pane = state.scene.ensurePane('price', 'price', 0);
        pane.manualScale = { min: 90, max: 110 };
        state.resetTimeScale();
        expect(state.coords.logicalToX(199)).toBe(737);
        expect(state.coords.getViewport()).toEqual({ barSpacing: 6, rightOffset: 10 });
        expect(pane.manualScale).toEqual({ min: 90, max: 110 });
    });

    it('fits the full edge slots at both pan limits', () => {
        const { state } = renderer();
        state.applyViewport({ barSpacing: 10, rightOffset: 1000 });
        expect(state.coords.logicalToX(198)).toBe(5);
        expect(state.coords.logicalToX(199)).toBe(15);
        state.applyViewport({ barSpacing: 10, rightOffset: -1000 });
        expect(state.coords.logicalToX(0)).toBe(785);
        expect(state.coords.logicalToX(1)).toBe(795);
    });

    it('reports the candle under the crosshair and treats the zero-margin right boundary as whitespace', () => {
        const { r, state } = renderer();
        const events: any[] = [];
        r.onCrosshairMove((e) => events.push(e));
        state.handlePointerMove(350, 100);
        expect(events[events.length - 1].time).toBe(161000);
        expect(events[events.length - 1].ohlc.time).toBe(161000);
        state.coords.setViewport({ barSpacing: 10, rightOffset: 0 });
        state.handlePointerMove(795, 100);
        expect(events[events.length - 1].time).toBe(199000);
        state.handlePointerMove(800, 100);
        expect(events[events.length - 1].time).toBeNull();
        expect(events[events.length - 1].ohlc).toBeNull();
    });

    it('restores the public range endpoints and holds historical pixels on series replacement', () => {
        const { r, state } = renderer();
        r.setVisibleRange({ from: 100000, to: 180000 });
        expect(state.coords.logicalToX(100)).toBeCloseTo(0);
        expect(state.coords.logicalToX(180)).toBeCloseTo(800);
        expect(r.getVisibleRange()).toEqual({ from: 100000, to: 180000 });
        r.setBars(bars(200, 5000), { preserveView: true });
        expect(state.coords.timeToX(120000)).toBeCloseTo(200);
        expect(state.coords.timeToX(180000)).toBeCloseTo(800);
        r.setBars(bars(100, 1000000));
        expect(state.coords.logicalToX(99)).toBeCloseTo(695);
    });

    it('keeps keyboard zoom and pan tied to the same right edge', () => {
        const { r, state } = renderer();
        r.applyFeature('animZoom', false);
        r.applyFeature('animPan', false);
        state.zoomByStep(1);
        expect(state.coords.rightEdgeLogical).toBeCloseTo(205.8);
        const x = state.coords.logicalToX(190);
        r.panBy(0.1);
        expect(state.coords.logicalToX(190) - x).toBeCloseTo(-80);
    });
});

describe('serialized right-margin convention', () => {
    for (const order of ['before-profile', 'after-profile', 'before-data']) {
        it(`preserves legacy center framing when restored ${order}`, () => {
            const { r, state } = renderer(order === 'before-profile' ? 'standard' : 'terminal');
            r.applyConfig({ margins: { right: 6 } });
            if (order === 'before-data') {
                state.coords.setBars([]);
                r.applyConfig(legacyConfig());
                r.setBars(bars());
            } else {
                r.applyConfig(legacyConfig());
            }
            if (order === 'before-profile') r.applyFeature('gestureProfile', 'terminal');
            expect(state.coords.logicalToX(199)).toBeCloseTo(700);
            expect(state.coords.getViewport().rightOffset).toBeCloseTo(9.5);
            state.scrollToRealtime();
            expect(state.scrollTargetRO).toBe(9.5);
        });
    }

    it('keeps a legacy zero margin at the edge and follows appends there', () => {
        const { r, state } = renderer();
        r.applyConfig(legacyConfig(0));
        expect(state.coords.logicalToX(199)).toBe(800);
        state.layoutMode = 'mobile';
        state.scrollButton = { style: {} };
        state.updateScrollToRealtimeButton();
        expect(state.scrollButton.style.display).toBe('none');
        const appended = bars(201);
        r.updateBar(appended[appended.length - 1]!);
        expect(state.coords.logicalToX(200)).toBe(800);
    });

    it('preserves legacy pixel framing when the saved margin reaches a pan limit', () => {
        const { r, state } = renderer();
        r.applyConfig(legacyConfig(200));
        expect(state.coords.logicalToX(198)).toBeCloseTo(10);
        expect(state.coords.logicalToX(199)).toBeCloseTo(20);
        r.setBars(bars(1));
        r.applyConfig(legacyConfig(0));
        expect(state.coords.logicalToX(0)).toBeCloseTo(790);
        state.resetTimeScale();
        expect(state.coords.logicalToX(0)).toBeCloseTo(791);
    });

    it('exports an explicit convention and survives repeated JSON roundtrips in either profile order', () => {
        for (const legacy of [false, true]) {
            const { r, state } = renderer();
            r.applyConfig({ margins: { right: 6 } });
            if (legacy) r.applyConfig(legacyConfig());
            else r.applyConfig({ margins: { right: 10 } });
            const config = JSON.parse(JSON.stringify(r.getConfig()));
            expect(config.version).toBe(2);
            expect(config.timeScale.rightOffsetConvention).toBe(legacy ? 'bar-center' : 'bar-edge');
            const x = state.coords.logicalToX(199);
            for (const beforeProfile of [true, false]) {
                const target = renderer(beforeProfile ? 'standard' : 'terminal');
                target.r.applyConfig({ margins: { right: 6 } });
                target.r.applyConfig(config);
                target.r.applyFeature('gestureProfile', 'terminal');
                target.r.applyConfig(JSON.parse(JSON.stringify(target.r.getConfig())));
                expect(target.state.coords.logicalToX(199)).toBeCloseTo(x);
                expect(target.r.getConfig()).toEqual(config);
            }
        }
    });

    it('adopts current geometry on an explicit time reset after legacy restoration', () => {
        const { r, state } = renderer();
        r.applyConfig(legacyConfig());
        const changed = vi.fn();
        r.onConfigChanged(changed);
        state.resetTimeScale();
        expect(state.coords.logicalToX(199)).toBe(737);
        expect(r.getConfig().timeScale).toMatchObject({ rightOffsetConvention: 'bar-edge' });
        expect(changed).toHaveBeenCalledOnce();
    });

    it('uses the current convention for content and factory resets', () => {
        const { r, state } = renderer();
        const factory = new NativeRenderer().getConfig(); // captured before the profile is selected
        r.applyConfig(legacyConfig());
        r.applyConfig(state.factoryResetDocument(factory));
        expect(state.coords.logicalToX(199)).toBe(695);
        expect(r.getConfig().timeScale.rightOffsetConvention).toBe('bar-edge');
        r.applyConfig(legacyConfig());
        state.resetView();
        expect(state.coords.logicalToX(199)).toBeCloseTo(760);
        expect(r.getConfig().timeScale.rightOffsetConvention).toBe('bar-edge');
    });

    it('preserves live pixels and a running scroll target across profile switches', () => {
        const { r, state } = renderer('standard');
        const x = state.coords.logicalToX(160);
        state.scrollTargetRO = 10;
        r.applyFeature('gestureProfile', 'terminal');
        expect(state.coords.logicalToX(160)).toBeCloseTo(x);
        expect(state.scrollTargetRO).toBe(9.5);
        r.applyFeature('gestureProfile', 'standard');
        expect(state.coords.logicalToX(160)).toBeCloseTo(x);
        expect(state.scrollTargetRO).toBe(10);
    });

    it('leaves standard transforms, range endpoints, margin import and zoom anchors unchanged', () => {
        const { r, state } = renderer('standard');
        expect(state.coords.logicalToX(199)).toBeCloseTo(737);
        expect(state.coords.xToLogical(350)).toBeCloseTo(160.3);
        r.applyConfig({ margins: { right: 6 } });
        r.applyConfig(legacyConfig());
        expect(state.coords.logicalToX(199)).toBe(700);
        r.setVisibleRange({ from: 100000, to: 180000 });
        expect(state.coords.logicalToX(100)).toBeCloseTo(0);
        expect(state.coords.logicalToX(180)).toBeCloseTo(800);
        expect(r.getConfig().timeScale).toMatchObject({ rightOffsetConvention: 'bar-center' });
    });
});
