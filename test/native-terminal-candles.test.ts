import { describe, expect, it, vi } from 'vitest';
import { terminalCandleWidth, terminalCandleGeometry, rasterizeTerminalCandles, type TerminalCandle, type TerminalCandleOptions } from '../src/renderers/native/backend/candle-lod';
import { Canvas2dBackend } from '../src/renderers/native/backend/Canvas2dBackend';
import { WebGL2Backend } from '../src/renderers/native/backend/WebGL2Backend';
import { CoordinateSystem } from '../src/renderers/native/core/CoordinateSystem';
import { SceneGraph, type PaneNode } from '../src/renderers/native/core/SceneGraph';
import { NativeRenderer } from '../src/renderers/native/NativeRenderer';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { VelaTheme } from '../src/core/options';
import type { Batch, RGBA } from '../src/renderers/native/backend/gl/Batch';

describe('terminal candle bitmap geometry', () => {
    const spacing = [0.5, 1, 2, 2.5, 3, 4, 5, 6, 8, 10, 20];
    it.each([
        [1, [1, 1, 1, 3, 3, 3, 3, 5, 5, 7, 15]],
        [1.25, [1, 1, 1, 3, 3, 3, 5, 5, 7, 9, 19]],
        [1.5, [1, 1, 3, 3, 3, 3, 5, 7, 9, 11, 23]],
        [2, [2, 2, 4, 6, 6, 6, 8, 10, 12, 16, 32]],
    ] as const)('matches the fixed width table at pixel ratio %s', (ratio, widths) => {
        expect(spacing.map((s) => terminalCandleWidth(s, ratio))).toEqual(widths);
        for (const s of spacing) {
            const g = terminalCandleGeometry(10.3, s, 8.2, 12.7, 3.1, 17.8, ratio);
            expect(g.wickWidth).toBe(Math.floor(ratio));
            expect(g.borderWidth).toBe(Math.floor(ratio));
            expect(g.right - g.left + 1).toBe(g.width);
            for (const v of [g.center, g.left, g.right, g.top, g.bottom, g.high, g.low]) expect(Number.isInteger(v)).toBe(true);
        }
    });

    it('keeps inclusive bounds, separate horizontal/vertical ratios, and unrounded doji height', () => {
        expect(terminalCandleGeometry(10.2, 6, 8.2, 8.7, 4, 16, 1.25, 1.5)).toEqual({
            center: 13, left: 11, right: 15, top: 12, bottom: 13, high: 6, low: 24,
            rawBodyHeight: 0.75, width: 5, wickWidth: 1, borderWidth: 1,
        });
    });
});

type Rect = [number, number, number, number, string, boolean];
const options: TerminalCandleOptions = { bodyVisible: true, borderVisible: true, wickVisible: true, inverted: false };
function candle(hollow = false): TerminalCandle<string> {
    return { geometry: terminalCandleGeometry(10.2, 6, 8, 12, 4, 16, 1),
        color: 'body', borderColor: 'border', wickColor: 'wick', hollow };
}
function rectangles(candles = [candle()], changes: Partial<TerminalCandleOptions> = {}): Rect[] {
    const out: Rect[] = [];
    rasterizeTerminalCandles(candles, { ...options, ...changes }, (...r) => out.push(r));
    return out;
}

describe('terminal candle rectangle passes', () => {
    it('paints integer wick rectangles, an inner border, then the inset body', () => {
        expect(rectangles()).toEqual([
            [10, 4, 1, 4, 'wick', false], [10, 13, 1, 3, 'wick', false],
            [9, 8, 3, 1, 'border', false], [9, 12, 3, 1, 'border', false],
            [8, 8, 1, 5, 'border', false], [12, 8, 1, 5, 'border', false],
            [9, 9, 3, 3, 'body', true],
        ]);
    });

    it('leaves the hollow interior clear and paints its outline with the body color', () => {
        expect(rectangles([candle(true)])).toEqual([
            [10, 4, 1, 4, 'wick', false], [10, 13, 1, 3, 'wick', false],
            [9, 8, 3, 1, 'body', false], [9, 12, 3, 1, 'body', false],
            [8, 8, 1, 5, 'body', false], [12, 8, 1, 5, 'body', false],
        ]);
        expect(rectangles([candle(true)], { bodyVisible: false, wickVisible: false }).every((r) => r[4] === 'border')).toBe(true);
    });

    it('retains thin candle bodies and flat dojis instead of dropping them at a spacing tier', () => {
        const thin = candle();
        thin.geometry = terminalCandleGeometry(10, 2, 8, 12, 4, 16, 1);
        expect(rectangles([thin], { wickVisible: false, borderVisible: false })).toEqual([[10, 8, 1, 5, 'body', true]]);
        const doji = candle();
        doji.geometry = terminalCandleGeometry(10, 6, 8, 8, 8, 8, 1);
        expect(rectangles([doji])).toEqual([[8, 8, 5, 1, 'border', false]]);
    });

    it('paints all wicks before any border or body and clips neighboring border columns', () => {
        const next = candle();
        next.geometry = terminalCandleGeometry(12.1, 6, 8, 12, 4, 16, 1);
        const out = rectangles([candle(), next]);
        expect(out.slice(0, 4).every((r) => r[4] === 'wick')).toBe(true);
        expect(out.slice(-2).every((r) => r[4] === 'body')).toBe(true);
        const nextBorder = out.filter((r) => r[4] === 'border').slice(4);
        expect(Math.min(...nextBorder.map((r) => r[0]))).toBe(13);
    });

    it('preserves the signed wick rectangles for an inverted scale', () => {
        const inverted = candle();
        inverted.geometry = terminalCandleGeometry(10, 6, 8, 12, 16, 4, 1);
        expect(rectangles([inverted], { inverted: true, bodyVisible: false, borderVisible: false })).toEqual([
            [10, 16, 1, -4, 'wick', false], [10, 9, 1, -5, 'wick', false],
        ]);
    });

    it('bounds rectangle work by visible candles at the minimum bar spacing', () => {
        const candles = Array.from({ length: 4096 }, (_, index) => ({ ...candle(),
            geometry: terminalCandleGeometry(index * 0.5, 0.5, 8, 12, 4, 16, 1), hollow: index % 2 === 0 }));
        let count = 0;
        rasterizeTerminalCandles(candles, options, () => { count += 1; });
        expect(count).toBeGreaterThan(candles.length);
        expect(count).toBeLessThanOrEqual(candles.length * 7);
    });
});

const theme: VelaTheme = { background: '#000000', textColor: '#cccccc', gridColor: '#222222', borderColor: '#333333',
    upColor: '#00aa00', downColor: '#aa0000', fontFamily: 'sans-serif' };

function backendFixture() {
    const scene = new SceneGraph();
    scene.candleRasterization = 'terminal';
    scene.style.candle.borderVisible = true;
    scene.style.candle.hollowUp = true;
    const bar: OHLCV = { time: 0, open: 100, high: 106, low: 99, close: 105, volume: 0 };
    const pane = scene.ensurePane('price', 'price', 0, 3);
    pane.bounds = { top: 0, height: 100 };
    pane.scale = { min: 95, max: 110 };
    const coords = new CoordinateSystem();
    coords.setSize(300, 100, 1.5);
    coords.setBars([bar.time]);
    coords.setViewport({ barSpacing: 6, rightOffset: 0 });
    return { scene, bar, pane, coords };
}

describe('terminal candle backend dispatch', () => {
    it('feeds the same filled bitmap rectangles to canvas and WebGL without outline strokes', () => {
        const { scene, bar, pane, coords } = backendFixture();
        const canvasRects: Array<[number, number, number, number]> = [];
        const ctx = { fillRect: (x: number, y: number, w: number, h: number) => canvasRects.push([x, y, w, h]) } as unknown as CanvasRenderingContext2D;
        const canvas = new Canvas2dBackend() as unknown as {
            drawCandles(ctx: CanvasRenderingContext2D, scene: SceneGraph, bars: OHLCV[], from: number, to: number, coords: CoordinateSystem, pane: PaneNode, theme: VelaTheme, colors: Map<number, string>): void;
        };
        canvas.drawCandles(ctx, scene, [bar], 0, 0, coords, pane, theme, new Map());
        const glRects: Array<[number, number, number, number]> = [];
        const batch = { rect: (x: number, y: number, w: number, h: number, _color: RGBA) => glRects.push([x, y, w, h]) } as unknown as Batch;
        const gl = new WebGL2Backend() as unknown as {
            emitCandles(batch: Batch, scene: SceneGraph, bars: OHLCV[], from: number, to: number, coords: CoordinateSystem, pane: PaneNode, theme: VelaTheme, colors: Map<number, string>): void;
        };
        vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
        try { gl.emitCandles(batch, scene, [bar], 0, 0, coords, pane, theme, new Map()); }
        finally { vi.unstubAllGlobals(); }
        expect(canvasRects.length).toBeGreaterThan(3);
        expect(glRects).toEqual(canvasRects);
        for (const rect of canvasRects) for (const edge of rect) expect(edge * coords.dpr).toBeCloseTo(Math.round(edge * coords.dpr), 10);
    });

    it('opts in through the runtime feature without changing the cosmetic config', () => {
        const renderer = new NativeRenderer();
        const before = renderer.getConfig();
        expect(renderer.readFeature('candleRasterization')).toBe('standard');
        expect(renderer.features).toContain('candleRasterization');
        renderer.applyFeature('candleRasterization', 'terminal');
        expect(renderer.readFeature('candleRasterization')).toBe('terminal');
        expect(renderer.getConfig()).toEqual(before);
        renderer.applyFeature('candleRasterization', 'unrecognized');
        expect(renderer.readFeature('candleRasterization')).toBe('standard');
    });
});
