// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ChartOrderLinesLayer, bindChartOrderLines, chartOrderLines, orderLineAmendment, refreshChartOrderLines, type ChartOrderLineBinding } from '../client/chart-order-lines';
import type { RendererLayerArgs } from '../../src/plugin';
import { DARK_THEME, LIGHT_THEME } from '../../src/core/theme';
import { CoordinateSystem } from '../../src/renderers/native/core/CoordinateSystem';
import { applyCommand, createSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS, type SessionView } from '../shared/types';
import type { TicketPriceSelection } from '../client/trade-ticket';

const cleanups: (() => void)[] = [];
beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
        setTransform: vi.fn(), clearRect: vi.fn(), setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    }) as unknown as CanvasRenderingContext2D);
});
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); document.body.replaceChildren(); vi.restoreAllMocks(); });

function fixture(plotSurface?: () => string) {
    const host = document.createElement('div'); const plot = document.createElement('div'); const canvas = document.createElement('canvas');
    canvas.width = 800; canvas.height = 200; plot.append(canvas); host.append(plot); document.body.append(host);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ top: 50, left: 0, width: 800, height: 200, right: 800, bottom: 250, x: 0, y: 50, toJSON: () => ({}) });
    const instrument = INSTRUMENTS[0]!;
    const session = createSession({ name: 'Order-line fixture', datasetId: 'data-fixture', mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES } }, instrument, 'line-fixture');
    session.cursor = 0;
    session.orders.push({ id: 'pending-fixture', type: 'limit', side: 'buy', qty: 1, price: 150, status: 'working', createdTime: 0 });
    let view: SessionView = { session, dataset: { id: 'data-fixture', name: 'Synthetic', symbol: 'NQM4', schema: 'ohlcv-1m', intervalMs: 60000,
        instrument, barCount: 10, start: 0, end: 600000, source: 'demo', createdAt: '', checksum: '' } };
    let blocked = false; let current = true; let preview: TicketPriceSelection | null = null;
    const command = vi.fn(); const selectPrice = vi.fn(); const selectBracket = vi.fn(); const clearPreview = vi.fn();
    const binding: ChartOrderLineBinding = { view: () => view, blocked: () => blocked, current: () => current, preview: () => preview, command, selectPrice, selectBracket, clearPreview,
        ...(plotSurface ? { plotSurface } : {}) };
    const off = bindChartOrderLines(host, binding);
    const layer = new ChartOrderLinesLayer(); layer.mount(canvas);
    const coords = new CoordinateSystem(); coords.setSize(800, 200, 1); coords.setBars([0]);
    const args = { coords, scale: { min: 100, max: 200 }, bounds: { top: 0, height: 200 }, bars: [], theme: LIGHT_THEME } as unknown as RendererLayerArgs;
    layer.render(args);
    cleanups.push(() => { off(); layer.destroy(); });
    const fire = (selector: string, type: string, clientY = 150): void => {
        const node = host.querySelector<HTMLElement>(selector)!;
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY });
        Object.defineProperty(event, 'pointerId', { value: 1 }); node.dispatchEvent(event);
    };
    const refresh = (): void => refreshChartOrderLines(host);
    return { host, canvas, layer, args, binding, command, selectPrice, selectBracket, clearPreview, fire, refresh, state: () => view,
        block: () => { blocked = true; }, stale: () => { current = false; },
        replace: (next: SessionView) => { view = next; }, preview: (next: TicketPriceSelection) => { preview = next; refresh(); } };
}
function deferredCommand() {
    let resolve!: () => void; let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

describe('simulated chart order lines', () => {
    it.each(['draft', 'working'] as const)('offers release-only exit drags on a %s limit for either side', stage => {
        for (const side of ['buy', 'sell'] as const) for (const kind of ['takeProfit', 'stopLoss'] as const) {
            const f = fixture(); f.state().session.orders[0]!.side = side;
            if (stage === 'draft') f.preview({ type: 'limit', side, qty: 2, price: 150 }); else f.refresh();
            const key = stage === 'draft' ? 'draft' : 'order:pending-fixture';
            const selector = `[data-order-line="${key}"] [data-order-add-exit="${kind}"]`;
            expect(f.host.querySelector<HTMLButtonElement>(selector)?.hidden).toBe(false);
            const higher = side === 'buy' ? kind === 'takeProfit' : kind === 'stopLoss';
            const y = higher ? 90.2 : 210.2, price = higher ? 180 : 120;
            f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', y);
            expect(f.command).not.toHaveBeenCalled(); expect(f.selectBracket).not.toHaveBeenCalled();
            expect(f.host.querySelector(`[data-order-price="${key}"]`)?.textContent).toBe('150.00');
            expect(f.host.querySelector(`[data-order-price="projection:${kind}"]`)?.textContent).toBe(price.toFixed(2));
            f.fire(selector, 'pointerup', y);
            if (stage === 'draft') {
                expect(f.selectBracket).toHaveBeenCalledExactlyOnceWith(kind, price);
                expect(f.selectPrice).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
            } else expect(f.command).toHaveBeenCalledExactlyOnceWith({ type: 'amend', orderId: 'pending-fixture', [kind]: price }, 'line-fixture', 0);
        }
    });

    it.each(['existing', 'changed', 'removed', 'cancelled'] as const)('preserves a working limit when an exit becomes %s during a drag', change => {
        const f = fixture(); const selector = '[data-order-line="order:pending-fixture"] [data-order-add-exit=takeProfit]';
        if (change === 'existing') { f.state().session.orders[0]!.takeProfit = 180; f.refresh(); }
        expect(f.host.querySelector<HTMLButtonElement>(selector)?.hidden).toBe(change === 'existing');
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', 90);
        if (change === 'changed') f.state().session.orders[0]!.takeProfit = 190;
        if (change === 'removed') f.state().session.orders.length = 0;
        if (change === 'cancelled') f.state().session.orders[0]!.status = 'cancelled';
        f.fire('.local-chart-orders', 'pointerup', 90);
        expect(f.command).not.toHaveBeenCalled();
    });

    it('retains a newer draft exit set while its chart drag is pending', () => {
        const f = fixture(); f.preview({ type: 'limit', side: 'buy', qty: 1, price: 150 });
        const selector = '[data-order-line=draft] [data-order-add-exit=stopLoss]';
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', 210);
        f.preview({ type: 'limit', side: 'buy', qty: 1, price: 150, stopLoss: 130 });
        f.fire('.local-chart-orders', 'pointerup', 210);
        expect(f.selectBracket).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
    });

    it.each(['takeProfit', 'stopLoss'] as const)('adds a missing position %s only after a tick-aligned drag finishes', kind => {
        const f = fixture();
        f.state().session.position = { side: 'buy', qty: 2, avgPrice: 150, entryTime: 0, entryFees: 0, mae: 0, mfe: 0 };
        f.refresh(); const selector = `[data-order-line=position] [data-order-add-exit="${kind}"]`;
        expect(f.host.querySelector(selector)).not.toBeNull();
        const y = kind === 'takeProfit' ? 90.2 : 210.2;
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', y);
        expect(f.command).not.toHaveBeenCalled(); expect(f.state().session.position![kind]).toBeUndefined();
        expect(f.host.querySelector('[data-order-price=position]')?.textContent).toBe('150.00');
        expect(f.host.querySelector(`[data-order-price="projection:${kind}"]`)?.textContent).toBe(kind === 'takeProfit' ? '180.00' : '120.00');
        f.fire(selector, 'pointerup', y);
        expect(f.command).toHaveBeenCalledExactlyOnceWith({ type: 'amend', [kind]: kind === 'takeProfit' ? 180 : 120 }, 'line-fixture', 0);
    });

    it.each(['escape', 'cancel', 'stale', 'revision', 'position', 'blocked', 'unchanged'] as const)('does not add an exit after %s interrupts its preview', change => {
        const f = fixture();
        f.state().session.position = { side: 'sell', qty: 1, avgPrice: 150, entryTime: 0, entryFees: 0, mae: 0, mfe: 0 };
        f.refresh(); const selector = '[data-order-line=position] [data-order-add-exit=takeProfit]';
        expect(f.host.querySelector(selector)).not.toBeNull();
        f.fire(selector, 'pointerdown'); if(change !== 'unchanged') f.fire(selector, 'pointermove', 210);
        if(change==='escape') f.host.querySelector(selector)!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        if(change==='cancel') f.fire(selector,'pointercancel');
        if(change==='stale') f.stale(); if(change==='revision') f.state().session.revision++;
        if(change==='position') f.state().session.position=null; if(change==='blocked') f.block();
        f.fire('.local-chart-orders','pointerup',210);
        expect(f.command).not.toHaveBeenCalled(); expect(f.host.querySelector('[data-order-price="projection:takeProfit"]')).toBeNull();
    });

    it('offers only missing exits and keeps settled projection controls inert', async () => {
        const f = fixture(); f.state().session.position = { side:'buy',qty:1,avgPrice:150,entryTime:0,entryFees:0,mae:0,mfe:0,stopLoss:120 };
        f.refresh(); expect(f.host.querySelector<HTMLButtonElement>('[data-order-line=position] [data-order-add-exit=stopLoss]')?.hidden).toBe(true);
        const pending=deferredCommand();f.command.mockReturnValue(pending.promise);
        const selector = '[data-order-line=position] [data-order-add-exit=takeProfit]';
        f.fire(selector,'pointerdown');f.fire(selector,'pointermove',90);f.fire(selector,'pointerup',90);
        expect(f.host.querySelector('[data-order-price="projection:takeProfit"]')).not.toBeNull();
        expect(f.host.querySelector<HTMLButtonElement>(selector)?.disabled).toBe(true);
        pending.reject(new Error('Owned rejection')); await pending.promise.catch(()=>undefined); await Promise.resolve();
        expect(f.host.querySelector('[data-order-price="projection:takeProfit"]')).toBeNull();
        expect(f.state().session.position!.takeProfit).toBeUndefined();
    });

    it.each([{ name: 'light', theme: LIGHT_THEME }, { name: 'dark', theme: DARK_THEME }])('distinguishes unplaced entry lines and borders on the $name plot', ({ theme }) => {
        const f = fixture(); const dashes: number[][] = [];
        const context = { setTransform() {}, clearRect() {}, setLineDash(dash: number[]) { dashes.push([...dash]); }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} };
        vi.spyOn(f.canvas, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
        f.args.theme = theme; f.preview({ type: 'limit', side: 'buy', qty: 1, price: 160 });
        expect(dashes).toEqual([[4, 4], [1, 2]]);
        const style = document.createElement('style'); style.textContent = readFileSync('local-app/client/chart-order-lines.css', 'utf8');
        document.head.append(style); cleanups.push(() => style.remove());
        expect(getComputedStyle(f.host.querySelector('[data-order-line=draft] .local-order-body')!).borderTopStyle).toBe('dotted');
        expect(getComputedStyle(f.host.querySelector('[data-order-price=draft]')!).borderTopStyle).toBe('dotted');
        expect(getComputedStyle(f.host.querySelector('[data-order-line="order:pending-fixture"] .local-order-body')!).borderTopStyle).not.toBe('dotted');
    });

    it.each(['close', 'reverse'] as const)('routes a position %s through the current revision command seam', action => {
        const f = fixture();
        f.state().session.position = { side: 'buy', qty: 2, avgPrice: 150, entryTime: 0, entryFees: 0, mae: 0, mfe: 0 };
        f.refresh();
        const selector = action === 'close' ? '[data-order-close=position]' : '[data-order-reverse=position]';
        const down = vi.fn(); const up = vi.fn(); f.host.addEventListener('pointerdown', down); f.host.addEventListener('pointerup', up);
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointerup'); f.fire(selector, 'click');
        expect(f.command).toHaveBeenCalledExactlyOnceWith({ type: action }, 'line-fixture', 0);
        expect(down).not.toHaveBeenCalled(); expect(up).not.toHaveBeenCalled();
        expect(f.state().session.position?.qty).toBe(2);
        f.block(); f.refresh(); f.command.mockClear(); f.fire(selector, 'click');
        expect(f.command).not.toHaveBeenCalled();
    });

    it('ignores position controls after their position disappears or their chart becomes stale', () => {
        const f = fixture();
        f.state().session.position = { side: 'sell', qty: 1, avgPrice: 150, entryTime: 0, entryFees: 0, mae: 0, mfe: 0 };
        f.refresh(); f.state().session.position = null;
        f.fire('[data-order-close=position]', 'click'); f.fire('[data-order-reverse=position]', 'click');
        expect(f.command).not.toHaveBeenCalled();
        f.state().session.position = { side: 'buy', qty: 1, avgPrice: 150, entryTime: 0, entryFees: 0, mae: 0, mfe: 0 };
        f.stale(); f.fire('[data-order-close=position]', 'click'); f.fire('[data-order-reverse=position]', 'click');
        expect(f.command).not.toHaveBeenCalled();
    });

    it('uses the actual plot surface for bodies and axis tags inside an independently themed shell', () => {
        let surface = '#ffffff'; const f = fixture(() => surface);
        f.host.style.setProperty('--vela-surface', '#080808');
        f.args.theme = DARK_THEME; f.layer.render(f.args);
        const overlay = f.host.querySelector<HTMLElement>('.local-chart-orders')!;
        const body = f.host.querySelector('.local-order-body'); const price = f.host.querySelector('.local-order-axis-price');
        expect(overlay.style.getPropertyValue('--local-order-surface')).toBe('#ffffff');
        const set = vi.spyOn(overlay.style, 'setProperty'); f.refresh();
        expect(set).not.toHaveBeenCalledWith('--local-order-surface', expect.anything());
        surface = '#131722'; f.refresh();
        expect(overlay.style.getPropertyValue('--local-order-surface')).toBe('#131722');
        expect(f.host.querySelector('.local-order-body')).toBe(body);
        expect(f.host.querySelector('.local-order-axis-price')).toBe(price);
        const style = document.createElement('style'); style.textContent = readFileSync('local-app/client/chart-order-lines.css', 'utf8');
        document.head.append(style); cleanups.push(() => style.remove());
        for (const selector of ['.local-order-body', '.local-order-axis-price']) {
            const rule = Array.from(style.sheet!.cssRules).find(item => (item as CSSStyleRule).selectorText === selector) as CSSStyleRule;
            expect(rule.style.getPropertyValue('background')).toBe('var(--local-order-surface)');
        }
    });

    it('follows the renderer theme surface when no plot-surface binding is supplied', () => {
        const f = fixture(); const overlay = f.host.querySelector<HTMLElement>('.local-chart-orders')!;
        expect(overlay.style.getPropertyValue('--local-order-surface')).toBe(LIGHT_THEME.background);
        f.args.theme = DARK_THEME; f.layer.render(f.args);
        expect(overlay.style.getPropertyValue('--local-order-surface')).toBe(DARK_THEME.background);
    });

    it('stacks the main entry above brackets, then selected, hovered and moving rows in that order', () => {
        const f = fixture(); Object.assign(f.state().session.orders[0]!, { takeProfit: 150.25, stopLoss: 149.75 }); f.refresh();
        const entry = f.host.querySelector<HTMLElement>('[data-order-line="order:pending-fixture"]')!;
        const tp = f.host.querySelector<HTMLElement>('[data-order-line="order:pending-fixture:takeProfit"]')!;
        const sl = f.host.querySelector<HTMLElement>('[data-order-line="order:pending-fixture:stopLoss"]')!;
        const entryLabel = entry.querySelector<HTMLButtonElement>('[data-order-drag]')!;
        const tpLabel = tp.querySelector<HTMLButtonElement>('[data-order-drag]')!;
        const capture = vi.fn(); const release = vi.fn();
        entryLabel.setPointerCapture = capture; entryLabel.releasePointerCapture = release;
        const level = (node: HTMLElement): number => Number(node.style.zIndex);
        expect(level(entry)).toBeGreaterThan(level(tp)); expect(level(entry)).toBeGreaterThan(level(sl));
        tpLabel.focus();
        expect(level(tp)).toBeGreaterThan(level(entry)); expect(tp.dataset.selected).toBe('true');
        f.fire('[data-order-drag="order:pending-fixture:stopLoss"]', 'pointerover');
        expect(level(sl)).toBeGreaterThan(level(tp)); expect(sl.dataset.hovered).toBe('true');
        f.fire('[data-order-drag="order:pending-fixture"]', 'pointerdown'); f.fire('[data-order-drag="order:pending-fixture"]', 'pointermove', 140);
        expect(level(entry)).toBeGreaterThan(level(sl)); expect(entry.dataset.moving).toBe('true');
        f.fire('[data-order-drag="order:pending-fixture:stopLoss"]', 'pointerout');
        f.fire('[data-order-drag="order:pending-fixture:stopLoss"]', 'pointerover');
        expect(f.host.querySelector('[data-order-drag="order:pending-fixture"]')).toBe(entryLabel);
        expect(capture).toHaveBeenCalledExactlyOnceWith(1); expect(release).not.toHaveBeenCalled();
        f.fire('[data-order-drag="order:pending-fixture"]', 'pointercancel');
        expect(release).toHaveBeenCalledExactlyOnceWith(1);
        expect(level(sl)).toBeGreaterThan(level(entry)); expect(entry.dataset.selected).toBe('true');
        f.fire('[data-order-drag="order:pending-fixture:stopLoss"]', 'pointerout');
        expect(level(entry)).toBeGreaterThan(level(sl)); expect(sl.dataset.hovered).toBe('false');
        f.fire('[data-order-drag="order:pending-fixture"]', 'pointerdown'); f.fire('[data-order-drag="order:pending-fixture"]', 'pointerup');
        expect(entry.dataset.selected).toBe('true'); expect(entry.dataset.moving).toBe('false');
        expect(level(entry)).toBeGreaterThan(level(tp)); expect(release).toHaveBeenCalledTimes(2);
        entryLabel.blur(); expect(entry.dataset.selected).toBe('false');
        expect(level(entry)).toBeGreaterThan(level(tp)); expect(f.command).not.toHaveBeenCalled();
    });

    it('cleans removed row hover and focus priority before recreating its target', () => {
        const f = fixture(); const selector = '[data-order-drag="order:pending-fixture"]';
        f.host.querySelector<HTMLButtonElement>(selector)!.focus(); f.fire(selector, 'pointerover');
        f.state().session.orders[0]!.status = 'cancelled'; f.refresh();
        expect(f.host.querySelector('[data-order-line]')).toBeNull();
        f.state().session.orders[0]!.status = 'working'; f.refresh();
        const row = f.host.querySelector<HTMLElement>('[data-order-line]')!;
        expect(row.dataset.hovered).toBe('false'); expect(row.dataset.selected).toBe('false');
    });

    it('shows only actual working pending prices and existing position exits, separate from drawings', () => {
        const f = fixture(); const view = f.state();
        view.session.orders.push({ id: 'filled-fixture', type: 'limit', side: 'sell', qty: 1, price: 180, status: 'filled', createdTime: 0 });
        view.session.position = { side: 'buy', qty: 1, avgPrice: 150, entryTime: 0, entryFees: 0, mae: 0, mfe: 0, takeProfit: 175, stopLoss: 125 };
        f.refresh();
        expect(chartOrderLines(view).map(item => item.kind)).toEqual(['order', 'position', 'takeProfit', 'stopLoss']);
        expect(f.host.querySelectorAll('[data-order-line]')).toHaveLength(4);
        expect(f.host.querySelectorAll('[data-order-cancel]')).toHaveLength(1);
        expect(f.host.querySelector('[data-order-drag=position]')?.hasAttribute('disabled')).toBe(true);
    });

    it('previews a tick-aligned drag without changing state and amends only on release', () => {
        const f = fixture(); const selector = '[data-order-drag="order:pending-fixture"]';
        const label = f.host.querySelector(selector);
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', 90.2);
        expect(f.command).not.toHaveBeenCalled();
        expect(f.state().session.orders[0]!.price).toBe(150);
        expect(f.host.querySelector(selector)).toBe(label);
        expect(f.host.querySelector('[data-order-price="order:pending-fixture"]')?.textContent).toBe('180.00');
        f.fire(selector, 'pointerup', 90.2);
        expect(f.command).toHaveBeenCalledExactlyOnceWith({ type: 'amend', orderId: 'pending-fixture', price: 180 }, 'line-fixture', 0);
    });

    it('retains the released price and moving priority until the canonical amendment view arrives', async () => {
        const f = fixture(); const pending = deferredCommand(); f.command.mockReturnValue(pending.promise);
        f.state().session.orders[0]!.takeProfit = 180.25; f.refresh();
        const selector = '[data-order-drag="order:pending-fixture"]';
        const row = f.host.querySelector<HTMLElement>('[data-order-line="order:pending-fixture"]')!;
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', 90); const movedTop = row.style.top; f.fire(selector, 'pointerup', 90);
        expect(row.style.top).toBe(movedTop); expect(row.dataset.moving).toBe('true');
        expect(f.host.querySelector('[data-order-price="order:pending-fixture"]')?.textContent).toBe('180.00');
        expect(f.state().session.orders[0]!.price).toBe(150);
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', 100); f.fire(selector, 'pointerup', 100);
        expect(f.command).toHaveBeenCalledTimes(1);
        f.block(); f.refresh(); f.fire('[data-order-drag="order:pending-fixture:takeProfit"]', 'pointerover');
        expect(row.style.top).toBe(movedTop);
        expect(Number(row.style.zIndex)).toBeGreaterThan(Number(f.host.querySelector<HTMLElement>('[data-order-line="order:pending-fixture:takeProfit"]')!.style.zIndex));
        const view = f.state();
        f.replace({ ...view, session: { ...view.session, revision: 1, orders: view.session.orders.map(order => ({ ...order, price: 180 })) } }); f.refresh();
        expect(row.style.top).toBe(movedTop); expect(row.dataset.moving).toBe('false');
        pending.resolve(); await pending.promise;
        expect(row.style.top).toBe(movedTop); expect(f.command).toHaveBeenCalledTimes(1);
    });

    it.each(['resolve', 'reject'] as const)('reverts an unaccepted pending preview when its command %ss', async outcome => {
        const f = fixture(); const pending = deferredCommand(); f.command.mockReturnValue(pending.promise);
        const selector = '[data-order-drag="order:pending-fixture"]';
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', 90); f.fire(selector, 'pointerup', 90);
        expect(f.host.querySelector('[data-order-price="order:pending-fixture"]')?.textContent).toBe('180.00');
        if (outcome === 'resolve') pending.resolve(); else pending.reject(new Error('Synthetic amendment failure'));
        await pending.promise.catch(() => undefined);
        expect(f.host.querySelector('[data-order-price="order:pending-fixture"]')?.textContent).toBe('150.00');
        expect(f.host.querySelector<HTMLElement>('[data-order-line="order:pending-fixture"]')!.dataset.moving).toBe('false');
        expect(f.command).toHaveBeenCalledTimes(1);
    });

    it.each(['revision', 'cursor', 'session', 'chart', 'binding'] as const)('drops a pending preview when %s changes and ignores its late completion', async kind => {
        const f = fixture(); const pending = deferredCommand(); f.command.mockReturnValue(pending.promise);
        const selector = '[data-order-drag="order:pending-fixture"]';
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', 90); f.fire(selector, 'pointerup', 90);
        if (kind === 'chart') f.stale();
        else if (kind === 'binding') cleanups.push(bindChartOrderLines(f.host, { ...f.binding }));
        else {
            const view = f.state();
            f.replace({ ...view, session: { ...view.session, ...(kind === 'session' ? { id: 'next-line-fixture' } : { [kind]: view.session[kind] + 1 }) } });
        }
        f.refresh();
        const tag = f.host.querySelector('[data-order-price="order:pending-fixture"]');
        expect(tag?.textContent ?? null).toBe(kind === 'chart' ? null : '150.00');
        pending.resolve(); await pending.promise;
        expect(f.host.querySelector('[data-order-price="order:pending-fixture"]')?.textContent ?? null).toBe(kind === 'chart' ? null : '150.00');
        expect(f.command).toHaveBeenCalledTimes(1);
    });

    it.each(['pointercancel', 'lostpointercapture'])('rolls back a %s without submitting an amendment', type => {
        const f = fixture(); const selector = '[data-order-drag="order:pending-fixture"]';
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', 90); f.fire(selector, type, 90); f.fire(selector, 'pointerup', 90);
        expect(f.command).not.toHaveBeenCalled();
        expect(f.host.querySelector('[data-order-price="order:pending-fixture"]')?.textContent).toBe('150.00');
    });

    it.each(['revision', 'cursor', 'blocked', 'chart'])('rejects a drag if %s changes before release', kind => {
        const f = fixture(); const selector = '[data-order-drag="order:pending-fixture"]';
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', 90);
        if (kind === 'blocked') f.block(); else if (kind === 'chart') f.stale(); else {
            const state = f.state(); f.replace({ ...state, session: { ...state.session, [kind]: state.session[kind as 'revision' | 'cursor'] + 1 } });
        }
        f.fire(selector, 'pointerup', 90);
        expect(f.command).not.toHaveBeenCalled();
    });

    it('cancel buttons address only a currently working order through the guarded command seam', () => {
        const f = fixture(); f.fire('[data-order-cancel]', 'click');
        expect(f.command).toHaveBeenCalledExactlyOnceWith({ type: 'cancel', orderId: 'pending-fixture' }, 'line-fixture', 0);
        f.block(); f.command.mockClear(); f.fire('[data-order-cancel]', 'click');
        expect(f.command).not.toHaveBeenCalled();
    });

    it.each([false, true])('keeps the full cancel pointer sequence out of native chart gestures (disabled=%s)', disabled => {
        const f = fixture(); const down = vi.fn(); const up = vi.fn();
        f.host.addEventListener('pointerdown', down); f.host.addEventListener('pointerup', up);
        if (disabled) { f.block(); f.refresh(); }
        f.fire('[data-order-cancel]', 'pointerdown'); f.fire('[data-order-cancel]', 'pointerup'); f.fire('[data-order-cancel]', 'click');
        expect(down).not.toHaveBeenCalled(); expect(up).not.toHaveBeenCalled();
        expect(f.command).toHaveBeenCalledTimes(disabled ? 0 : 1);
    });

    it.each([
        { qty: 2 },
        { qty: 1, takeProfit: 175 },
        { qty: 1, stopLoss: 125 },
        { qty: 1 },
    ])('keeps an active same-price draft separate from an accepted order: %j', edits => {
        const f = fixture();
        const bars = [0, 60000, 120000].map(time => ({ time, open: 150, high: 150, low: 150, close: 150, volume: 1 }));
        const created = createSession(f.state().session.config, f.state().dataset.instrument, 'submitted-fixture');
        const revealed = applyCommand(created, bars, { type: 'advance', count: 1 });
        const submitted = applyCommand(revealed, bars, { type: 'place', order: { type: 'limit', side: 'buy', price: 150, qty: 1 } });
        const order = submitted.orders[0]!;
        expect(order.status).toBe('working'); expect(submitted.fills).toHaveLength(0);
        f.replace({ ...f.state(), session: submitted });
        const preview = { type: 'limit', side: 'buy', price: 150, ...edits } as const;
        f.preview(preview);
        expect(chartOrderLines(f.state(), preview).find(line => line.key === 'draft')).toMatchObject({ price: 150, qty: edits.qty });
        expect(f.host.querySelector('[data-order-line=draft]')).not.toBeNull();
        if ('takeProfit' in edits) expect(f.host.querySelector('[data-order-line="draft:takeProfit"]')).not.toBeNull();
        if ('stopLoss' in edits) expect(f.host.querySelector('[data-order-line="draft:stopLoss"]')).not.toBeNull();
        expect(f.host.querySelector(`[data-order-drag="order:${order.id}"]`)).not.toBeNull();
        f.fire('[data-order-cancel]', 'click');
        expect(f.command).toHaveBeenCalledExactlyOnceWith({ type: 'cancel', orderId: order.id }, submitted.id, submitted.revision);
        expect(f.clearPreview).not.toHaveBeenCalled();
    });

    it('updates a draft price on finish without queuing an order', () => {
        const f = fixture(); f.preview({ type: 'stop', side: 'sell', price: 160 });
        f.fire('[data-order-drag=draft]', 'pointerdown'); f.fire('[data-order-drag=draft]', 'pointermove', 100);
        expect(f.selectPrice).not.toHaveBeenCalled();
        f.fire('[data-order-drag=draft]', 'pointerup', 100);
        expect(f.selectPrice).toHaveBeenCalledExactlyOnceWith(175, 'stop');
        expect(f.command).not.toHaveBeenCalled();
    });

    it('shows separate draft side, quantity/replay, type and price regions with enabled exit P&L', () => {
        const f = fixture(); f.preview({ type: 'limit', side: 'buy', price: 160, qty: 2, takeProfit: 180, stopLoss: 140 });
        const entry = f.host.querySelector<HTMLElement>('[data-order-line=draft]')!;
        expect(entry.querySelector('.local-order-side')?.textContent).toBe('Buy');
        expect(entry.querySelector('.local-order-quantity')?.textContent).toBe('2');
        expect(entry.querySelector('.local-order-replay path')).not.toBeNull();
        expect(entry.querySelector('.local-order-text')?.textContent).toBe('Limit');
        expect(entry.querySelector('.local-order-cancel svg')).not.toBeNull();
        expect(entry.textContent).not.toContain('preview');
        expect(f.host.querySelector('[data-order-price=draft]')?.textContent).toBe('160.00');
        expect(f.host.querySelector('[data-order-line="draft:takeProfit"] .local-order-text')?.textContent).toBe('+800.00 USD');
        expect(f.host.querySelector('[data-order-line="draft:stopLoss"] .local-order-text')?.textContent).toBe('−800.00 USD');
        expect(f.command).not.toHaveBeenCalled();
    });

    it('previews draft exit movement and changes only its ticket field on release', () => {
        const f = fixture(); f.preview({ type: 'limit', side: 'sell', price: 160, qty: 2, takeProfit: 140, stopLoss: 180 });
        const selector = '[data-order-drag="draft:takeProfit"]';
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', 190);
        expect(f.selectBracket).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
        expect(f.host.querySelector('[data-order-line="draft:takeProfit"] .local-order-text')?.textContent).toBe('+1,200.00 USD');
        f.fire(selector, 'pointerup', 190);
        expect(f.selectBracket).toHaveBeenCalledExactlyOnceWith('takeProfit', 130);
        expect(f.selectPrice).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
    });

    it('releases a draft drag if its ticket exit disappears before release', () => {
        const f = fixture(); f.preview({ type: 'limit', side: 'buy', price: 160, qty: 2, takeProfit: 180 });
        f.fire('[data-order-drag="draft:takeProfit"]', 'pointerdown'); f.fire('[data-order-drag="draft:takeProfit"]', 'pointermove', 90);
        f.preview({ type: 'limit', side: 'buy', price: 160, qty: 2, takeProfit: null });
        f.fire('.local-chart-orders', 'pointerup', 90);
        expect(f.selectBracket).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
        f.fire('[data-order-drag=draft]', 'pointerdown'); f.fire('[data-order-drag=draft]', 'pointermove', 90); f.fire('[data-order-drag=draft]', 'pointerup', 90);
        expect(f.selectPrice).toHaveBeenCalledExactlyOnceWith(180, 'limit');
    });

    it('keeps draft entry and exit clear actions separate and outside chart gestures', () => {
        const f = fixture(); f.preview({ type: 'limit', side: 'buy', price: 160, qty: 2, takeProfit: 180, stopLoss: 140 });
        const down = vi.fn(); const up = vi.fn();
        f.host.addEventListener('pointerdown', down); f.host.addEventListener('pointerup', up);
        for (const key of ['draft', 'draft:takeProfit', 'draft:stopLoss']) {
            const selector = `[data-order-close="${key}"]`;
            f.fire(selector, 'pointerdown'); f.fire(selector, 'pointerup'); f.fire(selector, 'click');
        }
        expect(f.clearPreview).toHaveBeenCalledExactlyOnceWith();
        expect(f.selectBracket.mock.calls).toEqual([['takeProfit', null], ['stopLoss', null]]);
        expect(down).not.toHaveBeenCalled(); expect(up).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
        f.block(); f.refresh(); f.fire('[data-order-close="draft:takeProfit"]', 'click');
        expect(f.selectBracket).toHaveBeenCalledTimes(2);
    });

    it('addresses attached working-order bracket removals without cancelling the order or other exit', () => {
        const f = fixture(); Object.assign(f.state().session.orders[0]!, { takeProfit: 175, stopLoss: 125 }); f.refresh();
        f.fire('[data-order-close="order:pending-fixture:takeProfit"]', 'click');
        expect(f.command).toHaveBeenCalledExactlyOnceWith({ type: 'amend', orderId: 'pending-fixture', takeProfit: null }, 'line-fixture', 0);
        expect(f.state().session.orders[0]!.status).toBe('working'); expect(f.state().session.orders[0]!.stopLoss).toBe(125);
        f.command.mockClear(); delete f.state().session.orders[0]!.takeProfit;
        f.fire('[data-order-close="order:pending-fixture:takeProfit"]', 'click');
        expect(f.command).not.toHaveBeenCalled();
    });

    it('calculates short-position exit P&L from point value and quantity and removes only the selected bracket', () => {
        const f = fixture(); f.state().session.config.commissionPerContractSide = 4;
        f.state().session.position = { side: 'sell', qty: 2, avgPrice: 150, entryTime: 0, entryFees: 8, mae: 0, mfe: 0, takeProfit: 125, stopLoss: 175 };
        f.refresh();
        expect(f.host.querySelector('[data-order-line=takeProfit] .local-order-text')?.textContent).toBe('+1,000.00 USD');
        expect(f.host.querySelector('[data-order-line=stopLoss] .local-order-text')?.textContent).toBe('−1,000.00 USD');
        expect(f.host.querySelector('[data-order-line=takeProfit] .local-order-quantity')?.textContent).toBe('−2');
        f.fire('[data-order-close=stopLoss]', 'click');
        expect(f.command).toHaveBeenCalledExactlyOnceWith({ type: 'amend', stopLoss: null }, 'line-fixture', 0);
    });

    it('rolls back an Escape drag and removes stale axis price tags with their rows', () => {
        const f = fixture(); const selector = '[data-order-drag="order:pending-fixture"]';
        f.fire(selector, 'pointerdown'); f.fire(selector, 'pointermove', 90);
        f.host.querySelector(selector)!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
        f.fire(selector, 'pointerup', 90);
        expect(f.command).not.toHaveBeenCalled();
        expect(f.host.querySelector('[data-order-price="order:pending-fixture"]')?.textContent).toBe('150.00');
        f.state().session.orders[0]!.status = 'cancelled'; f.refresh();
        expect(f.host.querySelector('[data-order-price="order:pending-fixture"]')).toBeNull();
    });

    it('uses only the requested bracket key and preserves order identity in amendments', () => {
        const f = fixture();
        f.state().session.position = { side: 'buy', qty: 1, avgPrice: 150, entryTime: 0, entryFees: 0, mae: 0, mfe: 0, takeProfit: 175, stopLoss: 125 };
        const lines = chartOrderLines(f.state());
        expect(orderLineAmendment(lines.find(item => item.kind === 'takeProfit')!, 180)).toEqual({ type: 'amend', takeProfit: 180 });
        expect(orderLineAmendment(lines.find(item => item.kind === 'stopLoss')!, 120)).toEqual({ type: 'amend', stopLoss: 120 });
        expect(orderLineAmendment(lines.find(item => item.kind === 'position')!, 180)).toBeNull();
    });

    it('hides all order prices before the first source bar and cleans up its overlay on destroy', () => {
        const f = fixture(); const state = f.state();
        f.replace({ ...state, session: { ...state.session, cursor: -1 } }); f.refresh();
        expect(f.host.querySelectorAll('[data-order-line]')).toHaveLength(0);
        f.layer.destroy();
        expect(f.host.querySelector('.local-chart-orders')).toBeNull();
    });
});
