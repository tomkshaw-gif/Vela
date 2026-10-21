// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ChartOrderLinesLayer, bindChartOrderLines, chartOrderLines, refreshChartOrderLines, type ChartOrderLineBinding } from '../client/chart-order-lines';
import type { TicketPriceSelection } from '../client/trade-ticket';
import { createSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS, type SessionView } from '../shared/types';
import { CoordinateSystem } from '../../src/renderers/native/core/CoordinateSystem';
import { LIGHT_THEME } from '../../src/core/theme';
import type { RendererLayerArgs } from '../../src/plugin';

const cleanups: (() => void)[] = [];
beforeEach(() => vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: vi.fn(), clearRect: vi.fn(), setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
} as unknown as CanvasRenderingContext2D));
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); });
function fixture() {
    const host = document.createElement('div'), canvas = document.createElement('canvas');
    host.append(canvas); document.body.append(host); canvas.width = 800; canvas.height = 200;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ top: 50, left: 0, width: 800, height: 200, right: 800, bottom: 250, x: 0, y: 50, toJSON: () => ({}) });
    const instrument = INSTRUMENTS[0]!;
    const session = createSession({ name: 'Partial chart fixture', datasetId: 'synthetic', mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES } }, instrument, 'partial-chart');
    session.cursor = 0;
    session.position = { side: 'buy', qty: 5, avgPrice: 150, entryTime: 0, entryFees: 0, mae: 0, mfe: 0, stopLoss: 120,
        takeProfits: [{ id: 'near', price: 180, qty: 2 }, { id: 'far', price: 190, qty: 1 }] };
    const view: SessionView = { session, dataset: { id: 'synthetic', name: 'Synthetic', symbol: 'NQZ6', schema: 'ohlcv-1m', intervalMs: 60000,
        instrument, barCount: 10, start: 0, end: 600000, source: 'demo', createdAt: '', checksum: '' } };
    let blocked = false, current = true; let preview: TicketPriceSelection | null = null;
    const command = vi.fn(), selectBracket = vi.fn(), selectTakeProfits = vi.fn();
    const binding: ChartOrderLineBinding = { view: () => view, preview: () => preview, blocked: () => blocked, current: () => current,
        command, selectBracket, selectTakeProfits, selectPrice: vi.fn() };
    const off = bindChartOrderLines(host, binding); const layer = new ChartOrderLinesLayer(); layer.mount(canvas);
    const coords = new CoordinateSystem(); coords.setSize(800, 200, 1); coords.setBars([0]);
    layer.render({ coords, scale: { min: 100, max: 200 }, bounds: { top: 0, height: 200 }, bars: [], theme: LIGHT_THEME } as unknown as RendererLayerArgs);
    cleanups.push(() => { off(); layer.destroy(); });
    const fire = (selector: string, type: string, clientY = 150, pointerId = 1): void => {
        const node = host.querySelector(selector); if (!node) throw new Error(`Missing ${selector}`);
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY }); Object.defineProperty(event, 'pointerId', { value: pointerId }); node.dispatchEvent(event);
    };
    return { host, view, command, binding, selectBracket, selectTakeProfits, fire, refresh: () => refreshChartOrderLines(host),
        block: () => { blocked = true; }, stale: () => { current = false; },
        preview: (value: TicketPriceSelection) => { preview = value; refreshChartOrderLines(host); } };
}
const near = '[data-order-line="takeProfit:near"] [data-order-drag]';

describe('individual target chart interactions', () => {
    it.each(['revision', 'cursor', 'session', 'position'] as const)('rejects stale %s after completed pointerup then lost capture', change => {
        const f = fixture(); const remove = '[data-order-line="takeProfit:near"] [data-order-close]';
        f.fire(remove, 'pointerdown', 150, 7);
        if (change === 'revision') f.view.session.revision++;
        if (change === 'cursor') f.view.session.cursor++;
        if (change === 'session') f.view.session.id = 'replacement-session';
        if (change === 'position') f.view.session.position!.entryTime++;
        f.fire(remove, 'pointerup', 150, 7); f.fire(remove, 'lostpointercapture', 150, 7);
        f.host.querySelector(remove)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
        expect(f.command).not.toHaveBeenCalled();
    });

    it('allows a valid completed captured pointer click and consumes its guard normally', () => {
        const f = fixture(); const remove = '[data-order-line="takeProfit:near"] [data-order-close]';
        f.fire(remove, 'pointerdown', 150, 7); f.fire(remove, 'pointerup', 150, 7); f.fire(remove, 'lostpointercapture', 150, 7);
        f.host.querySelector(remove)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
        expect(f.command).toHaveBeenCalledExactlyOnceWith({ type: 'amend', takeProfits: [{ id: 'far', price: 190, qty: 1 }] }, 'partial-chart', 0);
        const open = vi.fn(); f.host.addEventListener('local-replay:chart-partial-close', open);
        f.host.querySelector<HTMLButtonElement>('[data-order-line="position"] [data-order-partial]')!.click();
        expect(open).toHaveBeenCalledOnce();
    });

    it('retains cross-button rejection when pointerup targets another action before lost capture', () => {
        const f = fixture(); const partial = '[data-order-line="position"] [data-order-partial]';
        const reverse = '[data-order-line="position"] [data-order-reverse]';
        f.fire(partial, 'pointerdown', 150, 7); f.fire(reverse, 'pointerup', 150, 7); f.fire(reverse, 'lostpointercapture', 150, 7);
        f.host.querySelector(reverse)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
        expect(f.command).not.toHaveBeenCalled();
    });

    it.each(['Enter', ' '])('allows fresh keyboard %s after pointerup outside with no pointer click', key => {
        const f = fixture(); const remove = '[data-order-line="takeProfit:near"] [data-order-close]';
        const open = vi.fn(); f.host.addEventListener('local-replay:chart-partial-close', open);
        f.fire(remove, 'pointerdown', 150, 7); f.fire('.local-chart-orders', 'pointerup', 150, 7);
        f.fire(remove, 'lostpointercapture', 150, 7);
        const partial = f.host.querySelector<HTMLButtonElement>('[data-order-line="position"] [data-order-partial]')!;
        partial.focus(); partial.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); partial.click();
        expect(open).toHaveBeenCalledOnce(); expect(f.command).not.toHaveBeenCalled();
    });

    it('does not treat an unrelated pointerup as completion of the captured action', () => {
        const f = fixture(); const remove = '[data-order-line="takeProfit:near"] [data-order-close]';
        const open = vi.fn(); f.host.addEventListener('local-replay:chart-partial-close', open);
        f.fire(remove, 'pointerdown', 150, 7); f.fire(remove, 'pointerup', 150, 23); f.fire(remove, 'lostpointercapture', 150, 7);
        f.host.querySelector<HTMLButtonElement>('[data-order-line="position"] [data-order-partial]')!.click();
        expect(open).toHaveBeenCalledOnce(); expect(f.command).not.toHaveBeenCalled();
    });

    it('always retires a matching cancelled pointer even after its pointerup', () => {
        const f = fixture(); const remove = '[data-order-line="takeProfit:near"] [data-order-close]';
        const open = vi.fn(); f.host.addEventListener('local-replay:chart-partial-close', open);
        f.fire(remove, 'pointerdown', 150, 7); f.fire(remove, 'pointerup', 150, 7); f.fire(remove, 'pointercancel', 150, 7);
        f.host.querySelector<HTMLButtonElement>('[data-order-line="position"] [data-order-partial]')!.click();
        expect(open).toHaveBeenCalledOnce(); expect(f.command).not.toHaveBeenCalled();
    });

    it.each(['pointercancel', 'lostpointercapture'])('rearms the first keyboard partial-close activation after matching %s', type => {
        const f = fixture(); const open = vi.fn(); f.host.addEventListener('local-replay:chart-partial-close', open);
        const remove = '[data-order-line="takeProfit:near"] [data-order-close]';
        f.fire(remove, 'pointerdown', 150, 7); f.fire(remove, type, 150, 7);
        const partial = f.host.querySelector<HTMLButtonElement>('[data-order-line="position"] [data-order-partial]')!;
        const click = vi.fn(); partial.addEventListener('click', click);
        partial.focus(); partial.click();
        expect((click.mock.calls[0]![0] as MouseEvent).detail).toBe(0);
        expect(open).toHaveBeenCalledOnce(); expect(f.command).not.toHaveBeenCalled();
    });

    it.each(['pointercancel', 'lostpointercapture'])('keeps cross-button rejection after unrelated %s and rearms after consuming the rejected click', type => {
        const f = fixture(); const open = vi.fn(); f.host.addEventListener('local-replay:chart-partial-close', open);
        const remove = '[data-order-line="takeProfit:near"] [data-order-close]';
        f.fire(remove, 'pointerdown', 150, 7); f.fire(remove, type, 150, 23);
        const partial = f.host.querySelector<HTMLButtonElement>('[data-order-line="position"] [data-order-partial]')!;
        partial.focus(); partial.click();
        expect(open).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
        partial.click(); expect(open).toHaveBeenCalledOnce(); expect(f.command).not.toHaveBeenCalled();
    });

    it.each(['revision', 'cursor', 'position'] as const)('retains stale %s rejection when an unrelated pointer is cancelled', change => {
        const f = fixture(); const remove = '[data-order-line="takeProfit:near"] [data-order-close]';
        f.fire(remove, 'pointerdown', 150, 7); f.fire(remove, 'pointercancel', 150, 23);
        if (change === 'revision') f.view.session.revision++;
        if (change === 'cursor') f.view.session.cursor++;
        if (change === 'position') f.view.session.position!.entryTime++;
        f.host.querySelector<HTMLButtonElement>(remove)!.click(); expect(f.command).not.toHaveBeenCalled();
        f.fire(remove, 'pointerdown', 150, 8); f.fire(remove, 'pointerup', 150, 8);
        f.host.querySelector<HTMLButtonElement>(remove)!.click(); expect(f.command).toHaveBeenCalledOnce();
    });

    it('does not retire a new pointer activation when the previously cancelled pointer loses capture', () => {
        const f = fixture(); const remove = '[data-order-line="takeProfit:near"] [data-order-close]';
        const partial = '[data-order-line="position"] [data-order-partial]';
        const reverse = '[data-order-line="position"] [data-order-reverse]';
        f.fire(remove, 'pointerdown', 150, 7); f.fire(remove, 'pointercancel', 150, 7);
        f.fire(partial, 'pointerdown', 150, 8); f.fire(remove, 'lostpointercapture', 150, 7);
        f.fire(reverse, 'pointerup', 150, 8); f.host.querySelector<HTMLButtonElement>(reverse)!.click();
        expect(f.command).not.toHaveBeenCalled();
    });

    it('reserves stable hover geometry for the reverse action instead of changing the body width', () => {
        const style = document.createElement('style'); style.textContent = readFileSync('local-app/client/chart-order-lines.css', 'utf8'); document.head.append(style);
        try {
            const f = fixture();
            const row = f.host.querySelector<HTMLElement>('[data-order-line="position"]')!;
            const reverse = row.querySelector<HTMLElement>('[data-order-reverse]')!;
            row.dataset.hovered = 'false'; row.dataset.selected = 'false';
            const before = getComputedStyle(reverse);
            expect(before.display).not.toBe('none'); expect(before.visibility).toBe('hidden'); expect(before.pointerEvents).toBe('none');
            row.dataset.hovered = 'true';
            expect(getComputedStyle(reverse).visibility).toBe('visible');
        } finally { style.remove(); }
    });

    it.each(['reverse', 'close'] as const)('does not execute a different action (%s) after pointerdown on partial close', action => {
        const f = fixture(); const open = vi.fn(); f.host.addEventListener('local-replay:chart-partial-close', open);
        f.fire('[data-order-line="position"] [data-order-partial]', 'pointerdown');
        const selector = `[data-order-line="position"] [data-order-${action}]`;
        f.fire(selector, 'pointerup'); f.host.querySelector<HTMLButtonElement>(selector)!.click();
        expect(f.command).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    });

    it('displays each target label, its own contract quantity and projected PnL while keeping the stop on all remaining contracts', () => {
        const f = fixture();
        expect(f.host.querySelector('[data-order-line="takeProfit:near"] .local-order-quantity')!.textContent).toBe('2');
        expect(f.host.querySelector('[data-order-line="takeProfit:near"] .local-order-text')!.textContent).toBe('TP1 · +1,200.00 USD');
        expect(f.host.querySelector('[data-order-line="takeProfit:far"] .local-order-text')!.textContent).toBe('TP2 · +800.00 USD');
        expect(f.host.querySelector('[data-order-line="stopLoss"] .local-order-quantity')!.textContent).toBe('5');
    });

    it('commits only the dragged leg on release using an atomic list and the captured session revision', () => {
        const f = fixture(); f.fire(near, 'pointerdown'); f.fire(near, 'pointermove', 110);
        expect(f.command).not.toHaveBeenCalled();
        expect(f.host.querySelector('[data-order-price="takeProfit:near"]')!.textContent).toBe('170.00');
        expect(f.host.querySelector('[data-order-price="takeProfit:far"]')!.textContent).toBe('190.00');
        f.fire(near, 'pointerup', 110);
        expect(f.command).toHaveBeenCalledExactlyOnceWith({ type: 'amend', takeProfits: [{ id: 'near', price: 170, qty: 2 }, { id: 'far', price: 190, qty: 1 }] }, 'partial-chart', 0);
        expect(f.view.session.position!.takeProfits![0]!.price).toBe(180);
    });

    it.each(['escape', 'cancel', 'cursor', 'revision', 'quantity', 'entry', 'blocked', 'stale', 'sibling'] as const)('discards the target drag after %s changes its ownership', change => {
        const f = fixture(); f.fire(near, 'pointerdown'); f.fire(near, 'pointermove', 110);
        if (change === 'escape') f.host.querySelector(near)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        if (change === 'cancel') f.fire(near, 'pointercancel');
        if (change === 'cursor') f.view.session.cursor++;
        if (change === 'revision') f.view.session.revision++;
        if (change === 'quantity') f.view.session.position!.takeProfits![0]!.qty = 1;
        if (change === 'entry') f.view.session.position!.entryTime++;
        if (change === 'blocked') f.block();
        if (change === 'stale') f.stale();
        if (change === 'sibling') f.view.session.position!.takeProfits![1]!.price = 195;
        f.fire('.local-chart-orders', 'pointerup', 110);
        expect(f.command).not.toHaveBeenCalled(); expect(f.selectTakeProfits).not.toHaveBeenCalled();
    });

    it('removes only the selected leg without touching its sibling or stop', () => {
        const f = fixture(); f.host.querySelector<HTMLButtonElement>('[data-order-line="takeProfit:near"] [data-order-close]')!.click();
        expect(f.command).toHaveBeenCalledExactlyOnceWith({ type: 'amend', takeProfits: [{ id: 'far', price: 190, qty: 1 }] }, 'partial-chart', 0);
    });

    it('edits draft legs atomically and rejects a newer sibling edit even at the same session revision', () => {
        const f = fixture(); const legs = structuredClone(f.view.session.position!.takeProfits!);
        const preview: TicketPriceSelection = { type: 'limit', side: 'buy', qty: 5, price: 150, takeProfits: legs };
        f.preview(preview); const selector = '[data-order-line="draft:takeProfit:near"] [data-order-drag]';
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', 110);
        f.preview({ ...preview, takeProfits: [legs[0]!, { ...legs[1]!, qty: 2 }] });
        f.fire('.local-chart-orders', 'pointerup', 110); expect(f.selectTakeProfits).not.toHaveBeenCalled();
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', 110); f.fire(selector, 'pointerup', 110);
        expect(f.selectTakeProfits).toHaveBeenCalledExactlyOnceWith([{ id: 'near', price: 170, qty: 2 }, { id: 'far', price: 190, qty: 2 }]);
        expect(f.selectBracket).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
    });

    it('removes a draft target using the draft callback without a trading command', () => {
        const f = fixture(); f.preview({ type: 'limit', side: 'buy', qty: 5, price: 150, takeProfits: structuredClone(f.view.session.position!.takeProfits!) });
        f.host.querySelector<HTMLButtonElement>('[data-order-line="draft:takeProfit:far"] [data-order-close]')!.click();
        expect(f.selectTakeProfits).toHaveBeenCalledExactlyOnceWith([{ id: 'near', price: 180, qty: 2 }]);
        expect(f.selectBracket).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
    });

    it('offers a guarded partial-close affordance and rejects a stale pointer activation', () => {
        const f = fixture(); const open = vi.fn(); f.host.addEventListener('local-replay:chart-partial-close', open);
        const selector = '[data-order-line="position"] [data-order-partial]';
        f.fire(selector, 'pointerdown'); f.view.session.revision++; f.fire(selector, 'pointerup');
        f.host.querySelector<HTMLButtonElement>(selector)!.click(); expect(open).not.toHaveBeenCalled();
        f.host.querySelector<HTMLButtonElement>(selector)!.click();
        expect(open).toHaveBeenCalledOnce();
        expect((open.mock.calls[0]![0] as CustomEvent).detail).toEqual({ sessionId: 'partial-chart', revision: 1, cursor: 0, side: 'buy', qty: 5, avgPrice: 150, entryTime: 0 });
        expect(f.command).not.toHaveBeenCalled();
    });

    it.each(['position', 'order'] as const)('routes existing %s targets to the editor rather than constructing a scalar target', owner => {
        const f = fixture();
        if (owner === 'order') f.view.session.orders.push({ id: 'working', type: 'limit', side: 'buy', qty: 5, price: 150,
            takeProfits: structuredClone(f.view.session.position!.takeProfits!), status: 'working', createdTime: 0 });
        f.refresh(); const open = vi.fn(); f.host.addEventListener('local-replay:chart-edit-exits', open);
        const key = owner === 'order' ? 'order:working' : 'position';
        const selector = `[data-order-line="${key}"] [data-order-edit-targets]`;
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', 110); f.fire(selector, 'pointerup', 110);
        expect(f.command).not.toHaveBeenCalled();
        f.host.querySelector<HTMLButtonElement>(selector)!.click(); expect(open).toHaveBeenCalledOnce();
        if (owner === 'order') expect((open.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({ orderId: 'working', qty: 5, createdTime: 0 });
        expect(f.command).not.toHaveBeenCalled();
    });

    it('projects working-order leg identity and a detached allocation snapshot', () => {
        const f = fixture();
        f.view.session.orders.push({ id: 'working', type: 'stop', side: 'buy', qty: 5, price: 160,
            takeProfits: structuredClone(f.view.session.position!.takeProfits!), status: 'working', createdTime: 0 });
        const line = chartOrderLines(f.view).find(line => line.key === 'order:working:takeProfit:near')!;
        expect(line).toMatchObject({ orderId: 'working', takeProfitLegId: 'near', qty: 2 });
        f.view.session.orders[0]!.takeProfits![0]!.qty = 1;
        expect(line.takeProfits![0]!.qty).toBe(2);
    });
});
