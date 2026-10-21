import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChromeRenderer } from '../src/renderers/native/chrome/ChromeRenderer';
import { PriceAxisTickSource } from '../src/renderers/native/chrome/priceAxisTicks';
import { CoordinateSystem } from '../src/renderers/native/core/CoordinateSystem';
import { SceneGraph } from '../src/renderers/native/core/SceneGraph';
import { NativeRenderer } from '../src/renderers/native/NativeRenderer';
import { DARK_THEME } from '../src/core/theme';
import type { PriceAxisTick } from '../src/core/options';
import type { IndicatorModel } from '../src/core/model/indicator';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function paint(mode: 'standard' | 'terminal', fontSize = 12, ratio = 1, log = false, glyphMetrics = true,
    ticks: PriceAxisTick[] = [{ price: 150, label: 'major', major: true }, { price: 140, label: 'minor', major: false }]) {
    const texts: Array<{ text: string; x: number; y: number; font: string; alpha: number; color: string }> = [];
    const fills: Array<{ x: number; y: number; w: number; h: number; color: string }> = [];
    const strokes: unknown[] = [];
    const ctx = {
        font: '', textBaseline: 'middle', textAlign: '', fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1,
        setTransform() {}, clearRect() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
        rect() {}, clip() {}, setLineDash() {},
        stroke() { strokes.push(ctx.strokeStyle); },
        fillRect(x: number, y: number, w: number, h: number) { fills.push({ x, y, w, h, color: ctx.fillStyle }); },
        fillText(text: string, x: number, y: number) { texts.push({ text, x, y, font: ctx.font, alpha: ctx.globalAlpha, color: ctx.fillStyle }); },
        measureText(text: string) { return { width: text.length * 6,
            ...(glyphMetrics ? { actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 1 } : {}) }; },
    };
    const canvas = { width: 364 * ratio, height: 225 * ratio, getContext: () => ctx } as unknown as HTMLCanvasElement;
    const coords = new CoordinateSystem();
    coords.setSize(300, 200, ratio);
    const times = Array.from({ length: 30 }, (_, i) => Date.UTC(2026, 0, 1) + i * 3_600_000);
    coords.setBars(times);
    coords.setViewport({ barSpacing: 20, rightOffset: 0 });
    const scene = new SceneGraph();
    scene.axisRendering = mode;
    scene.style.fontSize = fontSize;
    scene.style.borderColor = '#123456';
    scene.showPriceLine = false;
    scene.showPriceLabel = false;
    scene.showCountdown = false;
    scene.bars = times.map((time) => ({ time, open: 145, high: 155, low: 140, close: 150, volume: 0 }));
    const pane = scene.ensurePane('price', 'price', 0, 3);
    pane.bounds = { top: 0, height: 200 };
    pane.scale = { min: 100, max: 200, log };
    const source = new PriceAxisTickSource();
    source.setHook(() => ticks);
    const chrome = new ChromeRenderer(source);
    chrome.mount(canvas);
    chrome.render(scene, coords, DARK_THEME, { background: '#ffffff', textColor: '#765432' });
    return { texts, fills, strokes, coords, scene, chrome, ctx };
}

describe('terminal axis label painting', () => {
    it('uses font-scaled price padding and measured glyph centering without muting minor ticks', () => {
        const { texts } = paint('terminal');
        expect(texts.find((t) => t.text === 'major')).toMatchObject({ x: 308, y: 102, font: `bold 12px ${DARK_THEME.fontFamily}`, alpha: 1, color: '#765432' });
        expect(texts.find((t) => t.text === 'minor')).toMatchObject({ x: 308, y: 122, font: `12px ${DARK_THEME.fontFamily}`, alpha: 1 });
    });

    it('preserves the standard padding, major weight, minor alpha, and uncorrected baseline', () => {
        const { texts } = paint('standard');
        expect(texts.find((t) => t.text === 'major')).toMatchObject({ x: 306, y: 100, font: `600 12px ${DARK_THEME.fontFamily}`, alpha: 1 });
        expect(texts.find((t) => t.text === 'minor')).toMatchObject({ x: 306, y: 120, font: `12px ${DARK_THEME.fontFamily}`, alpha: 0.5 });
    });

    it('uses the normal font for emphasized log ticks and tolerates absent bounding-box metrics', () => {
        const { texts } = paint('terminal', 12, 1, true, false);
        const major = texts.find((t) => t.text === 'major')!;
        expect(major.font).toBe(`12px ${DARK_THEME.fontFamily}`);
        expect(major.y).toBeCloseTo(200 * (1 - Math.log(1.5) / Math.log(2)));
    });

    it('rounds padding at fractional ratios and fits the whole font height inside the pane', () => {
        const { texts } = paint('terminal', 16, 1.25, false, true, [
            { price: 104, label: 'inside' }, { price: 103.5, label: 'clipped' }, { price: 196, label: 'top' },
        ]);
        expect(texts.find((t) => t.text === 'inside')).toMatchObject({ x: 310.4, y: 194 });
        expect(texts.find((t) => t.text === 'top')?.x).toBe(310.4);
        expect(texts.find((t) => t.text === 'top')?.y).toBeCloseTo(10, 10);
        expect(texts.find((t) => t.text === 'clipped')).toBeUndefined();
    });

    it.each([[12, 215], [16, 218]])('places time labels from the font metrics at size %s', (fontSize, y) => {
        const { texts } = paint('terminal', fontSize);
        const time = texts.filter((t) => t.x < 300);
        expect(time.length).toBeGreaterThan(0);
        expect(time.every((t) => t.y === y)).toBe(true);
    });

    it('applies the same scale padding and glyph centering to a merged scale column', () => {
        const f = paint('terminal');
        f.texts.length = 0;
        vi.spyOn(f.scene, 'ownScaleIndicatorsForPane').mockReturnValue([{ id: 'merged' } as IndicatorModel]);
        f.scene.indicatorScales.set('merged', { scale: { min: 100, max: 200 }, scaleTarget: { min: 100, max: 200 }, initialized: true, manualScale: null });
        const renderer = f.chrome as unknown as { drawMergedScaleColumns(ctx: CanvasRenderingContext2D, scene: SceneGraph, coords: CoordinateSystem, width: number): void };
        renderer.drawMergedScaleColumns(f.ctx as unknown as CanvasRenderingContext2D, f.scene, f.coords, 300);
        expect(f.texts.length).toBeGreaterThan(0);
        expect(f.texts.every((t) => t.x === 372)).toBe(true);
        const positions = f.texts.map((t) => t.y).sort((a, b) => a - b);
        expect(positions).toHaveLength(4);
        for (let i = 0; i < positions.length; i += 1) expect(positions[i]).toBeCloseTo([42, 82, 122, 162][i]!, 10);
    });
});

describe('terminal axis bitmap dividers', () => {
    it.each([[1, 1], [1.25, 0.8], [1.5, 2 / 3], [2, 1]])('fills physical-pixel strips at ratio %s', (ratio, width) => {
        const { fills, strokes } = paint('terminal', 12, ratio);
        const lines = fills.filter((r) => r.color === '#123456');
        expect(lines).toEqual([{ x: 300, y: 0, w: width, h: 200, color: '#123456' }, { x: 0, y: 200, w: 300, h: width, color: '#123456' }]);
        expect(strokes).toEqual([]);
        for (const line of lines) for (const value of [line.x, line.y, line.w, line.h]) expect(value * ratio).toBeCloseTo(Math.round(value * ratio), 10);
    });

    it('retains standard stroke dividers', () => {
        expect(paint('standard').strokes).toHaveLength(2);
    });
});

function sizingHarness(fontSize = 12, initialHeight = 300) {
    vi.stubGlobal('window', { devicePixelRatio: 1.25 });
    const renderer = new NativeRenderer();
    renderer.applyConfig({ layout: { fontSize }, priceScale: { countdown: false } });
    const r = renderer as unknown as Record<string, any>;
    let height = initialHeight;
    const canvas = () => ({ width: 0, height: 0, style: {} });
    r.wrapper = { clientWidth: 400, clientHeight: initialHeight, style: { setProperty() {} } };
    r.plot = { style: {}, getBoundingClientRect: () => ({ width: 400, height }) };
    for (const name of ['dataCanvas', 'backdropCanvas', 'volumeCanvas', 'vpvrCanvas', 'chromeCanvas', 'drawingsCanvas', 'cursorCanvas']) r[name] = canvas();
    const styles = new Map<string, string>();
    r.mountContainer = { style: { setProperty: (key: string, value: string) => styles.set(key, value) } };
    r.settingsButton = { style: {} };
    r.didInitialFit = true;
    r.scheduler = { flushNow() {}, invalidate() {} };
    r.animator = { active: false };
    return { renderer, r, styles, resize: (next: number) => { height = next; r.wrapper.clientHeight = next; renderer.resize(); } };
}

describe('terminal axis runtime gutter', () => {
    it('changes the live coordinate height and overlay gutter while preserving cosmetic settings', () => {
        const { renderer, r, styles } = sizingHarness();
        const before = renderer.getConfig();
        r.syncSize();
        expect(r.coords.height).toBe(278);
        expect(renderer.readFeature('axisRendering')).toBe('standard');
        renderer.applyFeature('axisRendering', 'terminal');
        expect(r.coords.height).toBe(272);
        expect(styles.get('--vela-bottom-gutter')).toBe('28px');
        expect(renderer.readFeature('axisRendering')).toBe('terminal');
        expect(renderer.getConfig()).toEqual(before);
        renderer.applyFeature('axisRendering', 'standard');
        expect(r.coords.height).toBe(278);
        expect(styles.get('--vela-bottom-gutter')).toBe('22px');
    });

    it('reflows coordinates and bottom overlays on live font config updates', () => {
        const { renderer, r, styles } = sizingHarness();
        renderer.applyFeature('axisRendering', 'terminal');
        expect(r.coords.height).toBe(272);
        renderer.applyConfig({ layout: { fontSize: 16 } });
        expect(r.coords.height).toBe(264);
        expect(styles.get('--vela-bottom-gutter')).toBe('36px');
        expect(r.settingsButton.style.bottom).toBe('46px');
        expect(styles.get('--vela-price-pane-bottom')).toBe('36px');
        renderer.applyConfig({ layout: { fontSize: 12 } });
        expect(r.coords.height).toBe(272);
        expect(styles.get('--vela-bottom-gutter')).toBe('28px');
        renderer.applyFeature('axisRendering', 'standard');
        renderer.applyConfig({ layout: { fontSize: 16 } });
        expect(r.coords.height).toBe(278);
        expect(styles.get('--vela-bottom-gutter')).toBe('22px');
    });

    it.each([[11, 87, 0], [11, 88, 28], [12, 88, 0], [12, 89, 28], [16, 96, 0], [16, 97, 36]])(
        'admits the optimal height before even rounding at font %s and available height %s', (fontSize, height, reserved) => {
            const { renderer, r, styles } = sizingHarness(fontSize, height);
            renderer.applyFeature('axisRendering', 'terminal');
            expect(r.coords.height).toBeCloseTo(Math.round(height * 1.25) / 1.25 - reserved, 10);
            expect(styles.get('--vela-bottom-gutter')).toBe(`${reserved}px`);
        });

    it('restores a hidden gutter when the chart grows and when a smaller font fits', () => {
        const { renderer, r, styles, resize } = sizingHarness(16, 96);
        renderer.applyFeature('axisRendering', 'terminal');
        expect(r.coords.height).toBe(96);
        resize(100);
        expect(r.coords.height).toBe(64);
        expect(styles.get('--vela-bottom-gutter')).toBe('36px');
        resize(96);
        renderer.applyConfig({ layout: { fontSize: 12 } });
        expect(r.coords.height).toBe(68);
        expect(styles.get('--vela-bottom-gutter')).toBe('28px');
    });
});
