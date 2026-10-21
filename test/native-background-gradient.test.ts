import { afterEach, describe, expect, it } from 'vitest';
import { NativeRenderer } from '../src/renderers/native/NativeRenderer';
import { backgroundCss, backgroundPaint } from '../src/renderers/native/core/background';
import { ChromeRenderer } from '../src/renderers/native/chrome/ChromeRenderer';
import { CoordinateSystem } from '../src/renderers/native/core/CoordinateSystem';
import { SceneGraph } from '../src/renderers/native/core/SceneGraph';
import { DARK_THEME } from '../src/core/theme';

const gradient = { topColor: '#ffffff', bottomColor: '#d9d9d9' };
const originalDocument = (globalThis as { document?: unknown }).document;
afterEach(() => { (globalThis as { document?: unknown }).document = originalDocument; });

function recordingCanvas(width = 800, height = 600) {
    const stops: Array<[number, string]> = [];
    const gradients: number[][] = [];
    const fills: Array<{ style: unknown; rect: number[] }> = [];
    const fill = { addColorStop: (position: number, color: string) => { stops.push([position, color]); } };
    const ctx = {
        fillStyle: null as unknown,
        createLinearGradient: (...coordinates: number[]) => { gradients.push(coordinates); return fill; },
        fillRect: (...rect: number[]) => { fills.push({ style: ctx.fillStyle, rect }); },
        setTransform() {}, clearRect() {}, drawImage() {},
    };
    const canvas = { width, height, getContext: () => ctx } as unknown as HTMLCanvasElement;
    return { ctx, canvas, gradients, stops, fills, fill };
}

describe('native plot background gradient', () => {
    it.each([null, '<b style="color:#f00000">Custom attribution</b>'])('keeps built-in and custom bottom-corner attribution readable: %s', (markup) => {
        const renderer = new NativeRenderer();
        const mark = { style: { color: '', setProperty() {} }, innerHTML: markup ?? '<svg>Attribution</svg>' };
        const original = mark.innerHTML;
        const internal = renderer as unknown as Record<string, unknown>;
        internal.attributionEl = mark;
        internal.attributionHtml = markup;
        renderer.applyConfig({ layout: { background: '#ffffff', backgroundGradient: { topColor: '#ffffff', bottomColor: '#000000' } } });
        expect(mark.style.color).toBe('#ffffff');
        expect(mark.innerHTML).toBe(original);
        renderer.applyConfig({ layout: { backgroundGradient: gradient } });
        expect(mark.style.color).toBe('#000000');
        expect(mark.innerHTML).toBe(original);
    });

    it('round trips the public config, rejects malformed stops and selects solid when a solid color is edited', () => {
        const renderer = new NativeRenderer();
        renderer.applyConfig({ layout: { background: '#ffffff', textColor: '#777777', backgroundGradient: gradient }, candles: { hollowUp: true } });
        const saved = renderer.getConfig();
        expect(saved.layout.backgroundGradient).toEqual(gradient);
        expect(saved.candles.hollowUp).toBe(true);
        gradient.topColor = '#eeeeee';
        expect(renderer.getConfig().layout.backgroundGradient?.topColor).toBe('#ffffff');
        gradient.topColor = '#ffffff';
        const restored = new NativeRenderer(); restored.applyConfig(JSON.parse(JSON.stringify(saved)));
        expect(restored.getConfig()).toEqual(saved);
        restored.applyConfig({ layout: { backgroundGradient: { topColor: 'url(unsafe)', bottomColor: '#123456' } } });
        expect(restored.getConfig().layout.backgroundGradient).toEqual(gradient);
        restored.applyConfig({ layout: { background: '#abcdef' } });
        expect(restored.getConfig().layout.backgroundGradient).toBeNull();
    });

    it('uses the same stops for live CSS and a real canvas gradient', () => {
        const { ctx, gradients, stops, fill } = recordingCanvas();
        expect(backgroundCss('#fff', gradient)).toBe('linear-gradient(to bottom, #ffffff, #d9d9d9)');
        expect(backgroundPaint(ctx as unknown as CanvasRenderingContext2D, '#fff', gradient, 600)).toBe(fill);
        expect(gradients).toEqual([[0, 0, 0, 600]]);
        expect(stops).toEqual([[0, '#ffffff'], [1, '#d9d9d9']]);
        expect(backgroundPaint(ctx as unknown as CanvasRenderingContext2D, '#123456', null, 600)).toBe('#123456');
    });

    it('paints a continuous full-height gradient in the price and time gutters', () => {
        const { canvas, gradients, stops, fills, fill } = recordingCanvas();
        const coords = new CoordinateSystem(); coords.setSize(736, 578, 1);
        const chrome = new ChromeRenderer(); chrome.mount(canvas);
        chrome.render(new SceneGraph(), coords, DARK_THEME, { background: '#fff', textColor: '#777', backgroundGradient: gradient });
        expect(gradients).toEqual([[0, 0, 0, 600]]);
        expect(stops).toEqual([[0, '#ffffff'], [1, '#d9d9d9']]);
        expect(fills).toEqual([{ style: fill, rect: [736, 0, 64, 600] }, { style: fill, rect: [0, 578, 736, 22] }]);
    });

    it('fills the PNG composite with a native gradient at the export pixel height', () => {
        const { canvas, gradients, stops, fills, fill } = recordingCanvas(1600, 1200);
        const renderer = new NativeRenderer();
        renderer.applyConfig({ layout: { background: '#ffffff', backgroundGradient: gradient } });
        const internal = renderer as unknown as Record<string, unknown>;
        internal.dataCanvas = { width: 1600, height: 1200 };
        internal.computeScales = () => {}; internal.paintData = () => {};
        (globalThis as { document?: unknown }).document = { createElement: () => canvas };
        expect(renderer.screenshotCanvas()).toBe(canvas);
        expect(gradients).toEqual([[0, 0, 0, 1200]]);
        expect(stops).toEqual([[0, '#ffffff'], [1, '#d9d9d9']]);
        expect(fills[0]).toEqual({ style: fill, rect: [0, 0, 1600, 1200] });
    });
});
