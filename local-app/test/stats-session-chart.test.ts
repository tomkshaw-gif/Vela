// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionBarsResult } from '@luxalgo/edge-stats/session-bars';
import { NativeRenderer, Vela, type VelaOptions } from '../../src/index';
import { mountStatsSessionChart } from '../client/stats-session-chart';

const start = Date.UTC(2024, 0, 2);
const snapshot: SessionBarsResult = { sessionId: 'TEST|short|2024-01-02', symbol: 'TEST', sessionKey: 'short', tradeDate: '2024-01-02', tf: '1m', tz: 'UTC', startTs: start, endTs: start + 180000, complete: true, isRollDay: false, isHalfDay: false,
    bars: [{ ts: start, open: 101, high: 104, low: 98, close: 100, volume: 2 }], context: { kind: 'prior-session', note: 'Returned context', bars: [{ ts: start - 60000, open: 99, high: 100, low: 98, close: 99, volume: 1 }] },
    levels: { prevClose: 99, prevHigh: 105, prevLow: 95, prevMid: 100, open: 101, high: 104, low: 98, close: 100, gapAbs: 2, gapPct: 2, gapDir: 'up', gapFilled: true, touchedPrevHigh: false, touchedPrevLow: false, ibBreak: null, ibWindow: 60, openingRanges: [{ window: 1, high: 104, low: 98, firstBreak: 'down', breakMin: 2 }] },
    times: { gapFillMin: 1, touchPrevHighMin: null, touchPrevLowMin: null, highTimeMin: 0, lowTimeMin: 2 }, disclaimer: 'Historical session context.' };
type Module = Awaited<ReturnType<NonNullable<Parameters<typeof mountStatsSessionChart>[3]>>>;
const controls: { destroy(): void }[] = [];
const initialAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
afterEach(() => { controls.splice(0).forEach(item => item.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    if (initialAnimate) Object.defineProperty(Element.prototype, 'animate', initialAnimate); else Reflect.deleteProperty(Element.prototype, 'animate'); });
function fixture(ready: Promise<void> = Promise.resolve()) {
    const host = document.createElement('div'); document.body.append(host); const abort = new AbortController();
    const destroy = vi.fn(), add = vi.fn((_type: string, _init: unknown) => ({ id: `level-${add.mock.calls.length}` })), lock = vi.fn(), marks = vi.fn();
    const constructor = vi.fn((_host: HTMLElement, _options: VelaOptions) => {});
    class Chart { constructor(element: HTMLElement, options: VelaOptions) { constructor(element, options); } ready = () => ready; destroy = destroy;
        drawings = { add, lock, showToolbar: vi.fn() }; renderer = { set: vi.fn() }; marks = { set: marks }; resize = vi.fn(); }
    const module = { Vela: Chart } as unknown as Module;
    return { host, abort, destroy, add, lock, marks, constructor, module };
}
it('maps exact returned ts to offline candles and adds only supplied levels, gap geometry and derived event minutes', async () => {
    const f = fixture(); const before = structuredClone(snapshot); const mounted = await mountStatsSessionChart(f.host, snapshot, f.abort.signal, async () => f.module); controls.push(mounted!);
    const options = f.constructor.mock.calls[0]![1];
    expect(options.data).toEqual([...snapshot.context.bars, ...snapshot.bars].map(({ ts, ...bar }) => ({ ...bar, time: ts })));
    expect(options).toMatchObject({ timeframe: '1m', live: false, priceStyle: 'candles' }); expect(options).not.toHaveProperty('attribution', false);
    expect(f.add.mock.calls.filter(([type]) => type === 'hline').map(([, init]) => (init as { anchors: { price: number }[] }).anchors[0]!.price)).toEqual([105, 95, 99, 101, 104, 98]);
    expect(f.add).toHaveBeenCalledWith('box', expect.objectContaining({ anchors: [{ time: start, price: 99 }, { time: start + 180000, price: 101 }] }));
    expect(f.marks.mock.calls[0]![0]).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Gap fill', time: start + 60000 }), expect.objectContaining({ title: 'Session high', time: start }), expect.objectContaining({ title: 'OR 1m first break · down', time: start + 120000 })]));
    expect(snapshot).toEqual(before); mounted!.destroy(); mounted!.destroy(); expect(f.destroy).toHaveBeenCalledOnce();
});
it('never constructs a renderer when its lazy import completes after cancellation', async () => {
    const f = fixture(); let finish!: (module: Module) => void; const pending = new Promise<Module>(done => { finish = done; });
    const loading = mountStatsSessionChart(f.host, snapshot, f.abort.signal, () => pending); f.abort.abort(); finish(f.module);
    expect(await loading).toBeNull(); expect(f.constructor).not.toHaveBeenCalled();
});
it('destroys an awaiting renderer promptly on cancellation instead of waiting for ready forever', async () => {
    const f = fixture(new Promise(() => {})); const loading = mountStatsSessionChart(f.host, snapshot, f.abort.signal, async () => f.module);
    await Promise.resolve(); expect(f.constructor).toHaveBeenCalledOnce(); f.abort.abort();
    expect(await loading).toBeNull(); expect(f.destroy).toHaveBeenCalledOnce();
});
it('leaves unavailable prior levels and unknown event times absent', async () => {
    const f = fixture(); const data = structuredClone(snapshot); Object.assign(data.levels, { prevClose: null, prevHigh: null, prevLow: null, open: null, openingRanges: [] });
    for (const name of Object.keys(data.times) as (keyof typeof data.times)[]) data.times[name] = null;
    const mounted = await mountStatsSessionChart(f.host, data, f.abort.signal, async () => f.module); controls.push(mounted!);
    expect(f.add).not.toHaveBeenCalled(); expect(f.marks).toHaveBeenCalledWith([]);
});

async function nativeFixture() {
    // Real Vela/native input/settings, with only browser layout and raster contexts supplied by the harness.
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400, toJSON() {} });
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: () => ({ cancel() {}, finish() {}, addEventListener() {} }) });
    const host = document.createElement('div'); document.body.append(host); const abort = new AbortController();
    const native = new NativeRenderer(); let chart!: Vela;
    class Chart extends Vela { constructor(element: HTMLElement, options: VelaOptions) { super(element, options, { renderer: native }); chart = this; } }
    const data = { ...snapshot, endTs: start + 90 * 60000, bars: Array.from({ length: 90 }, (_, i) => ({ ...snapshot.bars[0]!, ts: start + i * 60000 })) };
    const mounted = await mountStatsSessionChart(host, data, abort.signal, async () => ({ Vela: Chart })); controls.push(mounted!);
    chart.renderer.set({ animZoom: false, animPan: false });
    // A browser paint computes scales; jsdom has no raster surface. Use the real scale computation for hit geometry.
    Reflect.get(native, 'computeScales').call(native);
    const canvas = Reflect.get(native, 'dataCanvas') as HTMLCanvasElement;
    const projector = Reflect.get(native, 'drawingProjector').call(native) as { xOf(time: number): number; yOf(price: number, pane?: string): number };
    const pointer = (type: string, x: number, y: number, button = 0): void => {
        const event = new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true });
        Object.defineProperties(event, { pointerType: { value: 'mouse' }, pointerId: { value: 1 } }); canvas.dispatchEvent(event);
    };
    const clickLevel = (): void => { const x = projector.xOf(start), y = projector.yOf(105, 'price'); pointer('pointermove', x, y); pointer('pointerdown', x, y); pointer('pointerup', x, y); };
    return { host, native, chart, canvas, pointer, clickLevel };
}

it('negative control: the actual native editor can alter the price and text of a locked reference when interactions are enabled', async () => {
    const f = await nativeFixture(); f.chart.renderer.set({ drawingsInteractive: true, keyboard: true, historyChords: true });
    f.clickLevel();
    expect(f.host.querySelector('.vela-dpop')).not.toBeNull();
    f.host.querySelector<HTMLButtonElement>('[data-tip="Text"]')!.click();
    const text = f.host.querySelector<HTMLTextAreaElement>('textarea')!; text.value = 'Falsified prior high'; text.dispatchEvent(new Event('input'));
    expect(f.chart.drawings.all().some(d => d.text?.value === 'Falsified prior high')).toBe(true);
    f.host.querySelector<HTMLButtonElement>('[data-tip="Settings"]')!.click();
    await new Promise(resolve => setTimeout(resolve, 70));
    const points = [...f.host.querySelectorAll('.vela-dsp-fold')].find(fold => fold.querySelector('.vela-dsp-fold-t')?.textContent === 'Points')!;
    if (!points.hasAttribute('data-open')) points.querySelector<HTMLButtonElement>('.vela-dsp-fold-h')!.click();
    const price = points.querySelector<HTMLInputElement>('input')!; price.value = '999'; price.dispatchEvent(new Event('blur'));
    expect(f.chart.drawings.all().some(d => d.locked && d.anchors[0]?.price === 999)).toBe(true);
    const count = f.chart.drawings.all().length; f.chart.drawings.copyToClipboard([f.chart.drawings.all()[0]!.id]);
    f.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }));
    expect(f.chart.drawings.all()).toHaveLength(count + 1);
});

it('keeps actual native reference annotations unchanged through pointer, settings and mutating keyboard paths while retaining pointer navigation', async () => {
    const f = await nativeFixture(), before = f.chart.drawings.toJSON();
    f.clickLevel();
    expect(f.host.querySelector('.vela-dpop')).toBeNull();
    f.chart.drawings.copyToClipboard([f.chart.drawings.all()[0]!.id]);
    for (const key of ['z', 'y', 'v', 'd', 'Delete', 'Backspace', 'ArrowUp']) {
        f.canvas.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: key.length === 1, bubbles: true }));
    }
    expect(f.chart.drawings.toJSON()).toEqual(before);
    const range = f.chart.getVisibleRange(); f.pointer('pointerdown', 300, 150); f.pointer('pointermove', 360, 150); f.pointer('pointerup', 360, 150);
    expect(f.chart.getVisibleRange()).not.toEqual(range);
    const panned = f.chart.getVisibleRange(); f.canvas.dispatchEvent(new WheelEvent('wheel', { clientX: 300, clientY: 150, deltaY: -100, cancelable: true }));
    expect(f.chart.getVisibleRange()).not.toEqual(panned);
    const moves = vi.fn(), unsubscribe = f.chart.renderer.onCrosshairMove(moves);
    f.pointer('pointermove', 300, 150); expect(moves).toHaveBeenCalled(); unsubscribe();
    expect(f.host.querySelector('a[href*="velacharts"]')).not.toBeNull();
    expect(f.chart.drawings.toJSON()).toEqual(before);
});
