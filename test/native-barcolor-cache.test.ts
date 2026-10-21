import { describe, expect, it } from 'vitest';
import { Canvas2dBackend } from '../src/renderers/native/backend/Canvas2dBackend';
import { BarColorCache } from '../src/renderers/native/backend/BarColorCache';
import { CoordinateSystem } from '../src/renderers/native/core/CoordinateSystem';
import { SceneGraph } from '../src/renderers/native/core/SceneGraph';
import { NativeRenderer } from '../src/renderers/native/NativeRenderer';
import type { IndicatorModel } from '../src/core/model/indicator';
import type { VelaTheme } from '../src/core/options';

const theme: VelaTheme = { background: '#000000', textColor: '#cccccc', gridColor: '#222222', borderColor: '#333333',
    upColor: '#00aa00', downColor: '#aa0000', fontFamily: 'sans-serif' };

function fixture() {
    const scene = new SceneGraph();
    scene.candleRasterization = 'terminal';
    scene.bars = Array.from({ length: 100_000 }, (_, i) => ({ time: i * 60000, open: 100, high: 102, low: 99, close: 101, volume: 50 }));
    const pane = scene.ensurePane('price', 'price', 0);
    pane.bounds = { top: 0, height: 200 }; pane.scale = { min: 95, max: 105 };
    const coords = new CoordinateSystem(); coords.setSize(800, 200, 1);
    coords.setBars(scene.bars.map(bar => bar.time)); coords.setViewport({ barSpacing: 10, rightOffset: 0 });
    let visits = 0;
    const colors = scene.bars.map(bar => ({ time: bar.time, color: '#123456' }));
    colors[Symbol.iterator] = function* () { for (let i = 0; i < this.length; i++) { visits++; yield this[i]!; } return undefined; };
    const model: IndicatorModel = { id: 'colors', title: 'Colors', overlay: true, paneHint: 'price', paneId: 'price', series: [], fills: [],
        backgrounds: [], priceLines: [], inputs: [], inputValues: {}, barColors: colors };
    scene.indicators.set(model.id, model);
    const paints = new Set<string>();
    const ctx = new Proxy({ globalAlpha: 1 } as CanvasRenderingContext2D, {
        get: (target, key) => key === 'fillRect' ? () => paints.add(String(Reflect.get(target, 'fillStyle')))
            : Reflect.has(target, key) ? Reflect.get(target, key) : () => undefined,
        set: (target, key, value) => Reflect.set(target, key, value),
    });
    const backend = new Canvas2dBackend();
    backend.mount({ width: 800, height: 200, getContext: () => ctx } as unknown as HTMLCanvasElement);
    return { scene, coords, colors, backend, paints, visits: () => visits, resetVisits: () => { visits = 0; } };
}

describe('native bar-color viewport repaint work', () => {
    it('does not revisit historical indicator colors when only panning or zooming', () => {
        const f = fixture();
        f.backend.render(f.scene, f.coords, theme);
        expect(f.visits()).toBe(100_000);
        f.resetVisits();
        f.coords.setViewport({ barSpacing: 10, rightOffset: -10 }); f.backend.render(f.scene, f.coords, theme);
        f.coords.setViewport({ barSpacing: 12, rightOffset: -20 }); f.backend.render(f.scene, f.coords, theme);
        expect(f.visits()).toBe(0);
        f.backend.destroy();
    });

    it('paints an accepted same-array indicator edit and then reuses the refreshed colors', () => {
        const f = fixture(); f.backend.render(f.scene, f.coords, theme); f.resetVisits(); f.paints.clear();
        const renderer = Object.assign(Object.create(NativeRenderer.prototype) as Pick<NativeRenderer, 'updateIndicator'>,
            { scene: f.scene, scheduler: { invalidate: () => undefined } });
        f.colors[f.colors.length - 1]!.color = '#654321';
        renderer.updateIndicator({ id: 'colors' }, { kind: 'value', indicatorId: 'colors', dirty: { from: 0, to: 100_000 * 60000 }, series: [] });
        f.backend.render(f.scene, f.coords, theme);
        expect(f.visits()).toBe(100_000); expect(f.paints.has('#654321')).toBe(true);
        f.resetVisits(); f.backend.render(f.scene, f.coords, theme);
        expect(f.visits()).toBe(0);
        f.backend.destroy();
    });

    it('keeps resolved colors when an unrelated indicator publishes a value patch', () => {
        const f = fixture();
        f.scene.indicators.set('unrelated', indicator('unrelated', []));
        f.backend.render(f.scene, f.coords, theme); f.resetVisits();
        const renderer = Object.assign(Object.create(NativeRenderer.prototype) as Pick<NativeRenderer, 'updateIndicator'>,
            { scene: f.scene, scheduler: { invalidate: () => undefined } });
        renderer.updateIndicator({ id: 'unrelated' }, { kind: 'value', indicatorId: 'unrelated', dirty: { from: 0, to: 60000 }, series: [] });
        f.backend.render(f.scene, f.coords, theme);
        expect(f.visits()).toBe(0);
        f.backend.destroy();
    });
});

function indicator(id: string, colors: NonNullable<IndicatorModel['barColors']>): IndicatorModel {
    return { id, title: id, overlay: true, paneHint: 'price', paneId: 'price', series: [], fills: [], backgrounds: [], priceLines: [],
        inputs: [], inputValues: {}, barColors: colors };
}

describe('resolved bar-color changes', () => {
    it('keeps the last duplicate timestamp and later indicator precedence', () => {
        const first = indicator('first', [{ time: 1, color: '#111111' }, { time: 1, color: '#222222' }, { time: 2, color: '#333333' }]);
        const last = indicator('last', [{ time: 1, color: '#444444' }]);
        const sources = new Map([[first.id, first], [last.id, last]]);
        const cache = new BarColorCache();
        expect([...cache.get(sources, 0)]).toEqual([[1, '#444444'], [2, '#333333']]);
        sources.delete(first.id); sources.set(first.id, first);
        expect([...cache.get(sources, 0)]).toEqual([[1, '#222222'], [2, '#333333']]);
    });

    it('reuses the empty result until colors are published', () => {
        const model = indicator('first', []); const sources = new Map([[model.id, model]]); const cache = new BarColorCache();
        const empty = cache.get(sources, 0);
        expect(empty.size).toBe(0); expect(cache.get(sources, 0)).toBe(empty);
        model.barColors!.push({ time: 1, color: '#111111' });
        expect(cache.get(sources, 0).get(1)).toBe('#111111');
    });

    it('refreshes same-array edits when an indicator mutation is accepted', () => {
        const model = indicator('first', [{ time: 1, color: '#111111' }]);
        const sources = new Map([[model.id, model]]); const cache = new BarColorCache();
        cache.get(sources, 0);
        model.barColors![0]!.color = '#222222';
        expect(cache.get(sources, 1).get(1)).toBe('#222222');
        model.barColors![0]!.time = 2;
        const changed = cache.get(sources, 2);
        expect(changed.has(1)).toBe(false); expect(changed.get(2)).toBe('#222222');
    });

    it('refreshes replacement arrays, removed models and cleared colors without stale entries', () => {
        const first = indicator('first', [{ time: 1, color: '#111111' }]);
        const second = indicator('second', [{ time: 2, color: '#222222' }]);
        const sources = new Map([[first.id, first], [second.id, second]]); const cache = new BarColorCache();
        cache.get(sources, 0);
        first.barColors = [{ time: 3, color: '#333333' }]; sources.delete(second.id);
        expect([...cache.get(sources, 0)]).toEqual([[3, '#333333']]);
        first.barColors = [];
        expect(cache.get(sources, 0).size).toBe(0);
    });

    it('handles another scene and model replacement with the same id', () => {
        const first = indicator('first', [{ time: 1, color: '#111111' }]);
        const sources = new Map([[first.id, first]]); const cache = new BarColorCache();
        cache.get(sources, 0);
        sources.set(first.id, indicator(first.id, [{ time: 2, color: '#222222' }]));
        expect([...cache.get(sources, 0)]).toEqual([[2, '#222222']]);
        expect([...cache.get(new Map([[first.id, first]]), 0)]).toEqual([[1, '#111111']]);
    });

    it('rebuilds after disposal instead of retaining the previous resolved result', () => {
        const model = indicator('first', [{ time: 1, color: '#111111' }]);
        const sources = new Map([[model.id, model]]); const cache = new BarColorCache();
        const before = cache.get(sources, 0); cache.clear();
        const after = cache.get(sources, 0);
        expect(after).not.toBe(before); expect([...after]).toEqual([...before]);
    });
});
