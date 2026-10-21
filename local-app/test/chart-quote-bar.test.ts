// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChartQuoteBar, type ChartQuoteBarState } from '../client/chart-quote-bar';

(globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };

function fixture(initial: Partial<ChartQuoteBarState> = {}) {
    const onSide = vi.fn(); const onQuantity = vi.fn();
    const bar = createChartQuoteBar({ onSide, onQuantity });
    let state: ChartQuoteBarState = { bid: null, ask: null, quantity: 1, maxQuantity: 5, blocked: false, ...initial };
    document.body.append(bar.element); bar.update(state);
    const sell = bar.element.querySelector<HTMLButtonElement>('[data-chart-quote-side=sell]')!;
    const buy = bar.element.querySelector<HTMLButtonElement>('[data-chart-quote-side=buy]')!;
    const quantityButton = bar.element.querySelector<HTMLButtonElement>('[data-chart-quote-quantity]')!;
    const edit = (): HTMLInputElement => {
        if (quantityButton.getAttribute('aria-expanded') !== 'true') quantityButton.click();
        return document.querySelector<HTMLInputElement>('[data-chart-quote-quantity-input]')!;
    };
    const change = (value: string): HTMLInputElement => {
        const quantity = edit();
        quantity.value = value;
        quantity.dispatchEvent(new Event('input', { bubbles: true }));
        quantity.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return quantity;
    };
    return { bar, sell, buy, quantityButton, onSide, onQuantity, change, edit, update(next: Partial<ChartQuoteBarState>): void { state = { ...state, ...next }; bar.update(state); } };
}

afterEach(() => document.body.replaceChildren());

describe('per-chart quote bar', () => {
    it('keeps absent quotes absent, omits their side titles and does nothing on a click', () => {
        const f = fixture();
        for (const button of [f.sell, f.buy]) {
            expect(button.querySelector('.local-chart-quote-price')!.textContent).toBe('...');
            expect(button.querySelector<HTMLElement>('.local-chart-quote-title')!.hidden).toBe(true);
            expect(button.querySelector('.local-chart-quote-title')!.textContent).toBe('');
            expect(button.disabled).toBe(true);
            button.click(); button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
        expect(f.sell.getAttribute('aria-label')).toBe('Bid unavailable');
        expect(f.buy.getAttribute('aria-label')).toBe('Ask unavailable');
        expect(f.bar.element.querySelector('[data-chart-quote-spread]')!.textContent).toBe('');
        expect(f.onSide).not.toHaveBeenCalled();
        f.bar.destroy();
    });

    it('activates the quoted side once and rechecks the latest quote and blocked state', () => {
        const f = fixture({ ask: 100.25 });
        f.buy.click(); f.sell.click();
        expect(f.onSide).toHaveBeenCalledExactlyOnceWith('buy');
        expect(f.buy.querySelector<HTMLElement>('.local-chart-quote-title')!.hidden).toBe(false);
        f.update({ bid: 100, blocked: true });
        f.sell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(f.onSide).toHaveBeenCalledTimes(1);
        f.update({ blocked: false }); f.sell.click();
        expect(f.onSide).toHaveBeenNthCalledWith(2, 'sell');
        expect(f.bar.element.querySelector('[data-chart-quote-spread]')!.textContent).toBe('0.25');
        f.update({ ask: Number.NaN, bid: Number.POSITIVE_INFINITY });
        f.buy.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        f.sell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(f.onSide).toHaveBeenCalledTimes(2);
        f.bar.destroy();
    });

    it('preserves instrument price precision for equal simulated quotes and a zero spread', () => {
        const onSide = vi.fn();
        const bar = createChartQuoteBar({ onSide, onQuantity: vi.fn(),
            formatPrice: price => price.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
        document.body.append(bar.element);
        bar.update({ bid: 2187.4, ask: 2187.4, quantity: 1, maxQuantity: 5, blocked: false, showQuantity: true });
        expect([...bar.element.querySelectorAll('.local-chart-quote-price')].map(node => node.textContent)).toEqual(['2,187.4', '2,187.4']);
        expect([...bar.element.querySelectorAll<HTMLElement>('.local-chart-quote-title')].map(node => [node.textContent, node.hidden])).toEqual([['Sell', false], ['Buy', false]]);
        expect(bar.element.querySelector('[data-chart-quote-spread]')!.textContent).toBe('0.0');
        bar.element.querySelector<HTMLButtonElement>('[data-chart-quote-side=sell]')!.click();
        bar.element.querySelector<HTMLButtonElement>('[data-chart-quote-side=buy]')!.click();
        expect(onSide.mock.calls).toEqual([['sell'], ['buy']]);
        bar.destroy();
    });

    it('accepts whole contract counts within the current rules and rejects invalid edits', () => {
        const f = fixture();
        f.change('3'); f.change('3');
        expect(f.onQuantity).toHaveBeenCalledExactlyOnceWith(3);
        for (const value of ['', '0', '-1', '1.5', '6', '1e2', 'abc']) {
            const quantity = f.change(value);
            expect(quantity.getAttribute('aria-invalid')).toBe('true');
            expect(f.quantityButton.textContent).toBe('3');
        }
        expect(f.onQuantity).toHaveBeenCalledTimes(1);
        f.update({ quantity: 2, maxQuantity: 2 });
        expect(f.edit().max).toBe('2');
        f.change('3'); expect(f.quantityButton.textContent).toBe('2');
        expect(f.onQuantity).toHaveBeenCalledTimes(1);
        f.bar.destroy();
    });

    it('preserves pending edits across quote refreshes and commits Enter without bubbling chart shortcuts', () => {
        const f = fixture(); const keydown = vi.fn();
        document.body.addEventListener('keydown', keydown);
        const quantity = f.edit(); quantity.value = '4';
        f.update({ ask: 100.25, bid: 100 });
        expect(quantity.value).toBe('4');
        quantity.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(f.onQuantity).toHaveBeenCalledExactlyOnceWith(4);
        expect(keydown).not.toHaveBeenCalled();
        expect(f.quantityButton.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(f.quantityButton);
        f.edit().value = '1.5';
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(f.quantityButton.textContent).toBe('4');
        expect(f.quantityButton.getAttribute('aria-expanded')).toBe('false');
        document.body.removeEventListener('keydown', keydown); f.bar.destroy();
    });

    it('disables quantity while blocked and hides an unused center without manufacturing a spread', () => {
        const f = fixture({ blocked: true });
        expect(f.quantityButton.disabled).toBe(true);
        f.quantityButton.click(); expect(f.onQuantity).not.toHaveBeenCalled();
        expect(document.querySelector('[data-chart-quote-quantity-editor]')).toBeNull();
        expect(f.quantityButton.textContent).toBe('1');
        f.update({ blocked: false, showQuantity: false });
        expect(f.quantityButton.hidden).toBe(true);
        expect(f.bar.element.querySelector<HTMLElement>('.local-chart-quote-center')!.hidden).toBe(true);
        f.update({ bid: 100, ask: 100.25 });
        expect(f.bar.element.querySelector<HTMLElement>('.local-chart-quote-center')!.hidden).toBe(false);
        f.bar.destroy();
    });

    it('preserves an open quantity draft while a transient mutation blocks Apply', () => {
        const f = fixture();
        const quantity = f.edit(); quantity.value = '3';
        quantity.dispatchEvent(new Event('input', { bubbles: true }));
        const form = quantity.closest('form')!;
        const apply = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
        f.update({ blocked: true });
        expect(f.quantityButton.getAttribute('aria-expanded')).toBe('true');
        expect(quantity.isConnected).toBe(true);
        expect(quantity.value).toBe('3');
        expect(apply.disabled).toBe(true);
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(f.onQuantity).not.toHaveBeenCalled();
        expect(quantity.value).toBe('3');
        f.update({ blocked: false, maxQuantity: 4 });
        expect(quantity.value).toBe('3');
        expect(apply.disabled).toBe(false);
        apply.click();
        expect(f.onQuantity).toHaveBeenCalledExactlyOnceWith(3);
        expect(f.quantityButton.textContent).toBe('3');
        expect(f.quantityButton.getAttribute('aria-expanded')).toBe('false');
        f.bar.destroy();
        expect(document.querySelector('[data-chart-quote-quantity-editor]')).toBeNull();
    });

    it('does not mutate unchanged DOM and removes all actions on destruction', () => {
        const f = fixture({ bid: 100, ask: 100.25 });
        const observer = new MutationObserver(() => {});
        observer.observe(f.bar.element, { attributes: true, childList: true, characterData: true, subtree: true });
        f.update({});
        expect(observer.takeRecords()).toEqual([]);
        observer.disconnect(); const quantity = f.edit();
        f.bar.destroy(); f.bar.destroy();
        f.buy.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        quantity.value = '2'; quantity.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        f.quantityButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        f.update({ quantity: 3 });
        expect(f.onSide).not.toHaveBeenCalled(); expect(f.onQuantity).not.toHaveBeenCalled();
        expect(f.bar.element.isConnected).toBe(false);
        expect(document.querySelector('[data-chart-quote-quantity-editor]')).toBeNull();
        expect(quantity.value).toBe('2');
    });
});
