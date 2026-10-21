import type { Side } from '../shared/types';
import { Popover, SURFACE_CLOSE_EVENT } from '../../src/ui';
import './chart-quote-bar.css';

export interface ChartQuoteBarState {
    bid: number | null;
    ask: number | null;
    quantity: number;
    maxQuantity: number;
    blocked: boolean;
    showQuantity?: boolean;
}

export interface ChartQuoteBarOptions {
    onSide(side: Side): void;
    onQuantity(quantity: number): void;
    formatPrice?(price: number): string;
}

export interface ChartQuoteBar {
    readonly element: HTMLDivElement;
    update(state: ChartQuoteBarState): void;
    destroy(): void;
}

const priceFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });

function quote(value: number | null): number | null {
    return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

function validQuantity(value: number, max: number): boolean {
    return Number.isSafeInteger(value) && value >= 1 && value <= max;
}

/** The application owns the effect of activating a quoted side. */
export function createChartQuoteBar(options: ChartQuoteBarOptions): ChartQuoteBar {
    const element = document.createElement('div');
    element.className = 'local-chart-quote-bar';
    element.dataset.chartQuoteBar = '';
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', 'Chart quotes');

    function sideButton(side: Side): { button: HTMLButtonElement; price: HTMLSpanElement; title: HTMLSpanElement } {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'local-chart-quote-button'; button.dataset.chartQuoteSide = side;
        const price = document.createElement('span'); price.className = 'local-chart-quote-price';
        const title = document.createElement('span'); title.className = 'local-chart-quote-title';
        title.textContent = side === 'sell' ? 'Sell' : 'Buy';
        button.append(price, title);
        return { button, price, title };
    }

    const sell = sideButton('sell'); const buy = sideButton('buy');
    const center = document.createElement('div'); center.className = 'local-chart-quote-center';
    const spread = document.createElement('span'); spread.className = 'local-chart-quote-spread';
    spread.dataset.chartQuoteSpread = ''; spread.setAttribute('aria-label', 'Spread unavailable');
    const quantityButton = document.createElement('button');
    quantityButton.type = 'button'; quantityButton.className = 'local-chart-quote-quantity'; quantityButton.dataset.chartQuoteQuantity = '';
    quantityButton.setAttribute('aria-label', 'Change contracts'); quantityButton.setAttribute('aria-haspopup', 'dialog');
    quantityButton.setAttribute('aria-expanded', 'false');
    center.append(spread, quantityButton); element.append(sell.button, center, buy.button);

    const editor = document.createElement('form'); editor.className = 'local-chart-quote-editor'; editor.noValidate = true;
    const label = document.createElement('label'); label.textContent = 'Contracts';
    const quantity = document.createElement('input');
    quantity.dataset.chartQuoteQuantityInput = ''; quantity.type = 'number'; quantity.inputMode = 'numeric';
    quantity.min = '1'; quantity.step = '1'; quantity.required = true;
    quantity.setAttribute('aria-label', 'Contracts'); quantity.autocomplete = 'off'; label.append(quantity);
    const actions = document.createElement('div'); actions.className = 'local-chart-quote-editor-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    const apply = document.createElement('button'); apply.type = 'submit'; apply.textContent = 'Apply';
    actions.append(cancel, apply); editor.append(label, actions);

    let state: ChartQuoteBarState = { bid: null, ask: null, quantity: 1, maxQuantity: 1000, blocked: true };
    let destroyed = false;
    let popover: Popover | null = null;
    const disposers: (() => void)[] = [];
    const formatPrice = options.formatPrice ?? ((price: number): string => priceFormat.format(price));
    const setText = (node: HTMLElement, value: string): void => { if (node.textContent !== value) node.textContent = value; };
    const setAttribute = (node: HTMLElement, name: string, value: string): void => {
        if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    };
    const setHidden = (node: HTMLElement, hidden: boolean): void => { if (node.hidden !== hidden) node.hidden = hidden; };
    const quantityLimit = (): number => Number.isSafeInteger(state.maxQuantity) && state.maxQuantity >= 1 ? state.maxQuantity : 0;
    const quantityEditable = (): boolean => !state.blocked && state.showQuantity !== false && quantityLimit() >= 1;

    function renderSide(side: Side, value: number | null, nodes: typeof sell): void {
        const price = quote(value);
        const unavailable = price === null;
        const formatted = unavailable ? null : formatPrice(price);
        setText(nodes.price, formatted ?? '...');
        setText(nodes.title, unavailable ? '' : side === 'sell' ? 'Sell' : 'Buy');
        setHidden(nodes.title, unavailable);
        setAttribute(nodes.button, 'aria-label', unavailable ? `${side === 'sell' ? 'Bid' : 'Ask'} unavailable` : `${side === 'sell' ? 'Sell' : 'Buy'} at ${formatted}`);
        const disabled = state.blocked || unavailable;
        if (nodes.button.disabled !== disabled) nodes.button.disabled = disabled;
    }

    function restoreQuantity(): void {
        const value = validQuantity(state.quantity, quantityLimit()) ? String(state.quantity) : '';
        if (quantity.value !== value) quantity.value = value;
        if (quantity.validationMessage) quantity.setCustomValidity('');
        if (quantity.hasAttribute('aria-invalid')) quantity.removeAttribute('aria-invalid');
    }

    function render(): void {
        renderSide('sell', state.bid, sell); renderSide('buy', state.ask, buy);
        const bid = quote(state.bid); const ask = quote(state.ask);
        const difference = bid !== null && ask !== null ? Number((ask - bid).toFixed(8)) : null;
        const formattedSpread = difference === null ? null : formatPrice(difference);
        setText(spread, formattedSpread ?? '');
        setAttribute(spread, 'aria-label', difference === null ? 'Spread unavailable' : `Spread ${formattedSpread}`);
        setHidden(center, state.showQuantity === false && difference === null);
        setHidden(quantityButton, state.showQuantity === false);
        setText(quantityButton, validQuantity(state.quantity, quantityLimit()) ? String(state.quantity) : '...');
        const max = String(quantityLimit());
        if (quantity.max !== max) quantity.max = max;
        const disabled = !quantityEditable();
        if (quantity.disabled !== disabled) quantity.disabled = disabled;
        if (quantityButton.disabled !== disabled) quantityButton.disabled = disabled;
        if (apply.disabled !== disabled) apply.disabled = disabled;
        if (state.showQuantity === false || quantityLimit() < 1) popover?.hide();
        // An open editor owns its draft while background mutations block committing.
        if (!popover?.open) restoreQuantity();
    }

    function readQuantity(): number | null {
        if (!/^\d+$/.test(quantity.value)) return null;
        const value = Number(quantity.value);
        return validQuantity(value, quantityLimit()) ? value : null;
    }

    function commitQuantity(): boolean {
        if (!quantityEditable()) return false;
        const value = readQuantity();
        if (value === null) {
            quantity.setCustomValidity(`Enter a whole number from 1 to ${quantityLimit()}.`);
            setAttribute(quantity, 'aria-invalid', 'true'); quantity.reportValidity(); return false;
        }
        if (value === state.quantity) { restoreQuantity(); return true; }
        state = { ...state, quantity: value };
        restoreQuantity(); setText(quantityButton, String(value)); options.onQuantity(value); return true;
    }

    function toggleQuantity(): void {
        if (destroyed || !quantityEditable()) return;
        if (popover?.open) { popover.hide(); return; }
        restoreQuantity();
        // Resolve the theme host after the trigger is mounted in its chart cell.
        if (!popover) {
            popover = new Popover({ trigger: quantityButton, content: editor, className: 'local-chart-quote-popover', align: 'center',
                onClose(): void {
                    setAttribute(quantityButton, 'aria-expanded', 'false');
                    restoreQuantity();
                } });
            popover.el.setAttribute('role', 'dialog'); popover.el.setAttribute('aria-label', 'Change contracts');
            popover.el.dataset.chartQuoteQuantityEditor = '';
            const closing = (): void => {
                if (editor.contains(document.activeElement)) quantityButton.focus({ preventScroll: true });
            };
            const shell = popover.el;
            shell.addEventListener(SURFACE_CLOSE_EVENT, closing);
            disposers.push(() => shell.removeEventListener(SURFACE_CLOSE_EVENT, closing));
        }
        setAttribute(quantityButton, 'aria-expanded', 'true'); popover.show(); quantity.focus(); quantity.select();
    }

    const click = (event: MouseEvent): void => {
        event.stopPropagation();
        if ((event.target as Element).closest('[data-chart-quote-quantity]')) { toggleQuantity(); return; }
        const button = (event.target as Element).closest<HTMLButtonElement>('[data-chart-quote-side]');
        if (!button || !element.contains(button) || destroyed || state.blocked) return;
        const side = button.dataset.chartQuoteSide as Side;
        if (quote(side === 'sell' ? state.bid : state.ask) === null) return;
        options.onSide(side);
    };
    const submit = (event: Event): void => {
        event.preventDefault(); event.stopPropagation();
        if (!destroyed && commitQuantity()) popover?.hide();
    };
    const cancelClick = (): void => { popover?.hide(); };
    const input = (event: Event): void => {
        event.stopPropagation();
        const invalid = readQuantity() === null;
        quantity.setCustomValidity(invalid ? `Enter a whole number from 1 to ${quantityLimit()}.` : '');
        if (invalid) setAttribute(quantity, 'aria-invalid', 'true'); else quantity.removeAttribute('aria-invalid');
    };
    const keydown = (event: KeyboardEvent): void => {
        event.stopPropagation();
        if (event.target !== quantity) return;
        if (event.key === 'Enter') { event.preventDefault(); if (commitQuantity()) popover?.hide(); }
    };
    const stop = (event: Event): void => event.stopPropagation();
    for (const [node, type, handler] of [
        [element, 'click', click], [element, 'keydown', keydown], [element, 'pointerdown', stop],
        [element, 'mousedown', stop], [element, 'dblclick', stop], [editor, 'input', input],
        [editor, 'keydown', keydown], [editor, 'submit', submit], [editor, 'click', stop],
        [editor, 'mousedown', stop], [editor, 'dblclick', stop], [cancel, 'click', cancelClick],
    ] as const) {
        node.addEventListener(type, handler as EventListener);
        disposers.push(() => node.removeEventListener(type, handler as EventListener));
    }

    render();
    return {
        element,
        update(next): void {
            if (destroyed) return;
            state = { ...next };
            render();
        },
        destroy(): void {
            if (destroyed) return;
            destroyed = true;
            popover?.destroy(); popover = null;
            for (const dispose of disposers.splice(0)) dispose();
            element.remove();
        },
    };
}
