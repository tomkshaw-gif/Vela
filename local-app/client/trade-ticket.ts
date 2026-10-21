import { validateDraft } from '../engine/validation';
import type { OrderDraft, SessionView, Side } from '../shared/types';

export interface TicketPriceSelection { side: Side; type: OrderDraft['type']; price: number | null; qty?: number; takeProfit?: number | null; stopLoss?: number | null }
export interface TradeTicketHooks { submit(side: Side): void; isBlocked?(): boolean }

function priceControl(id: string, title: string, showLabel = true): string {
    return `<div class="ticket-price-field" id="${id}-control-label">${showLabel ? `<label for="${id}" data-ticket-price-label>${title}</label>` : ''}<div class="ticket-input-row"><input id="${id}" type="number" inputmode="decimal" min="0.25" step="0.25" placeholder="Price" />${id === 'order-price' ? '<button type="button" data-ticket-pick aria-label="Pick entry price on chart" title="Pick entry price on chart" aria-pressed="false">⌖</button>' : `<span class="ticket-price-equivalent" data-ticket-equivalent="${id}">— ticks</span>`}<div class="ticket-steppers"><button type="button" data-ticket-step="${id}" data-direction="1" aria-label="Increase ${title.toLowerCase()}">+</button><button type="button" data-ticket-step="${id}" data-direction="-1" aria-label="Decrease ${title.toLowerCase()}">−</button></div></div></div>`;
}

function exitControl(id: string, enabledId: string, title: string): string {
    return `<div class="ticket-exit-field" data-exit="${id}"><div class="ticket-exit-heading"><label for="${id}">${title} price</label><label class="ticket-exit-toggle"><input type="checkbox" role="switch" id="${enabledId}" aria-label="${title}" /><span class="ticket-switch-track" aria-hidden="true"><span></span></span></label></div>${priceControl(id, `${title} price`, false)}</div>`;
}

export function tradeTicketMarkup(): string {
    return `<section class="ticket-panel local-order-ticket"><div class="panel-heading"><h2>Order ticket</h2><span class="simulation-badge">SIMULATED</span></div><form id="ticket-form" novalidate>
        <div class="ticket-symbol" hidden><span id="ticket-symbol">—</span><span class="ticket-last">Last <strong id="last-price">—</strong></span></div>
        <div class="ticket-side-control" aria-label="Order side"><button type="button" data-ticket-side="sell" aria-pressed="false"><span>Sell</span><small aria-label="Bid unavailable">—</small></button><button type="button" data-ticket-side="buy" aria-pressed="true"><span>Buy</span><small aria-label="Ask unavailable">—</small></button></div>
        <div class="ticket-type-tabs" role="tablist" aria-label="Order type"><button type="button" role="tab" id="ticket-market-tab" data-ticket-type="market" aria-selected="true" aria-controls="ticket-fields">Market</button><button type="button" role="tab" id="ticket-limit-tab" data-ticket-type="limit" aria-selected="false" aria-controls="ticket-fields" tabindex="-1">Limit</button><button type="button" role="tab" id="ticket-stop-tab" data-ticket-type="stop" aria-selected="false" aria-controls="ticket-fields" tabindex="-1">Stop</button></div>
        <select id="order-type" aria-label="Order type" hidden tabindex="-1"><option value="market">Market</option><option value="limit">Limit</option><option value="stop">Stop</option></select>
        <div id="ticket-fields" role="tabpanel" aria-labelledby="ticket-market-tab"><div class="ticket-entry-price" id="order-price-label" hidden>${priceControl('order-price', 'Price')}</div>
        <label class="ticket-quantity-field"><span>Contracts</span><div class="ticket-input-row"><input id="order-qty" type="number" inputmode="numeric" min="1" max="1000" step="1" value="1" required /><div class="ticket-steppers"><button type="button" data-ticket-step="order-qty" data-direction="1" aria-label="Increase contracts">+</button><button type="button" data-ticket-step="order-qty" data-direction="-1" aria-label="Decrease contracts">−</button></div></div></label>
        <div class="ticket-metadata"><span>Tick value</span><span class="ticket-tick-value"><strong id="ticket-tick-value">—</strong><small>USD</small></span></div>
        <div class="ticket-exits"><button class="ticket-exits-heading" type="button" data-ticket-exits aria-expanded="true" aria-controls="ticket-exit-fields"><span>Exits</span><svg aria-hidden="true" viewBox="0 0 18 18"><path d="m5 11 4-4 4 4" /></svg></button><div id="ticket-exit-fields">${exitControl('take-profit', 'ticket-tp-enabled', 'Take profit')}${exitControl('stop-loss', 'ticket-sl-enabled', 'Stop loss')}</div></div>
        <p id="ticket-error" class="ticket-error" role="alert" hidden></p></div>
        <div class="ticket-done"><button class="ticket-place" type="submit" id="ticket-place" disabled><strong>Buy</strong><small>1 contract · Market</small></button><p class="ticket-hint">Simulated · activates on the next source bar</p></div>
    </form></section>`;
}

/** Numeric prices stay tied to revealed source data; absent bid/ask quotes stay absent. */
export class TradeTicket {
    private side: Side = 'buy';
    private view: SessionView | null = null;
    private lastPrice: number | null = null;
    private sessionId: string | null = null;
    private picking = false;
    private exitsExpanded = true;
    private reportedQuantity: number | null = null;
    private waitingForEdit = false;
    private disposers: (() => void)[] = [];

    constructor(private readonly form: HTMLFormElement, private readonly hooks: TradeTicketHooks) {
        const click = (event: MouseEvent): void => {
            const button = (event.target as Element).closest<HTMLButtonElement>('button');
            if (!button || button.disabled) return;
            this.waitingForEdit = false;
            if (button.dataset.ticketSide === 'buy' || button.dataset.ticketSide === 'sell') this.side = button.dataset.ticketSide;
            if (button.dataset.ticketType) this.setType(button.dataset.ticketType as OrderDraft['type']);
            if (button.dataset.ticketStep) this.step(button.dataset.ticketStep, Number(button.dataset.direction));
            if (button.hasAttribute('data-ticket-pick')) this.picking = !this.picking;
            if (button.hasAttribute('data-ticket-exits')) this.exitsExpanded = !this.exitsExpanded;
            this.refresh();
        };
        const input = (): void => { this.waitingForEdit = false; this.refresh(); };
        const focus = (event: FocusEvent): void => {
            if (this.waitingForEdit && (event.target as Element).matches('input,select')) { this.waitingForEdit = false; this.refresh(); }
        };
        const submit = (event: SubmitEvent): void => {
            event.preventDefault(); event.stopPropagation();
            if (this.draft()) this.hooks.submit(this.side);
        };
        const keydown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape' && this.picking) { event.preventDefault(); event.stopPropagation(); this.picking = false; this.refresh(); return; }
            const tab = (event.target as Element).closest<HTMLElement>('[data-ticket-type]');
            if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            const types = ['market', 'limit', 'stop'] as const;
            const index = types.indexOf(tab.dataset.ticketType as OrderDraft['type']);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
            this.setType(types[next]!); this.refresh();
            this.form.querySelector<HTMLButtonElement>(`[data-ticket-type="${types[next]}"]`)?.focus();
        };
        for (const [type, listener] of [['click', click], ['input', input], ['change', input], ['focusin', focus], ['submit', submit], ['keydown', keydown]] as const) {
            this.form.addEventListener(type, listener as EventListener);
            this.disposers.push(() => this.form.removeEventListener(type, listener as EventListener));
        }
        this.refresh();
    }

    update(view: SessionView | null, lastPrice: number | null): void {
        const nextSession = view?.session.id ?? null;
        if (nextSession !== this.sessionId) {
            this.sessionId = nextSession;
            this.form.reset(); this.side = 'buy'; this.picking = false; this.exitsExpanded = true;
            this.reportedQuantity = null;
            this.waitingForEdit = false;
        }
        this.view = view;
        this.lastPrice = lastPrice !== null && Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : null;
        const tick = view?.dataset.instrument.tickSize ?? 0.25;
        for (const id of ['order-price', 'stop-loss', 'take-profit']) {
            this.field(id).step = String(tick); this.field(id).min = String(tick);
        }
        this.field('order-qty').max = String(view?.session.config.rules.maxContracts ?? 1000);
        const decimals = Math.min(8, String(tick).split('.')[1]?.length ?? 0);
        const quote = this.lastPrice === null ? '...' : this.lastPrice.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
        for (const side of ['sell', 'buy'] as const) {
            const value = this.node(`[data-ticket-side="${side}"] small`);
            value.textContent = quote;
            value.setAttribute('aria-label', this.lastPrice === null ? `${side === 'sell' ? 'Bid' : 'Ask'} unavailable` : `Simulated ${side === 'sell' ? 'bid' : 'ask'} ${quote}`);
        }
        this.refresh();
    }

    /** A chart price pick changes the entry field; it never submits an order. */
    selectPrice(price: number, type: 'limit' | 'stop' = 'limit'): void {
        const tick = this.view?.dataset.instrument.tickSize;
        if (!tick || !Number.isFinite(price) || price <= 0) return;
        this.field('order-price').value = this.aligned(price, tick);
        this.waitingForEdit = false;
        this.picking = false;
        this.setType(type); this.refresh();
        this.field('order-price').focus();
    }

    setQuantity(quantity: number): void {
        if (!this.view || !this.validQuantity(quantity) || this.hooks.isBlocked?.()) return;
        this.field('order-qty').value = String(quantity);
        this.waitingForEdit = false;
        this.refresh();
    }

    get quantity(): number {
        const quantity = Number(this.field('order-qty').value);
        return this.validQuantity(quantity) ? quantity : 1;
    }

    /** Chart draft controls edit the ticket only; working orders use session commands. */
    selectBracket(kind: 'takeProfit' | 'stopLoss', price: number | null): void {
        if (!this.view || this.hooks.isBlocked?.()) return;
        const tick = this.view.dataset.instrument.tickSize;
        if (price !== null && (!Number.isFinite(price) || price <= 0)) return;
        const id = kind === 'takeProfit' ? 'take-profit' : 'stop-loss';
        this.field(kind === 'takeProfit' ? 'ticket-tp-enabled' : 'ticket-sl-enabled').checked = price !== null;
        if (price !== null) this.field(id).value = this.aligned(price, tick);
        this.waitingForEdit = false;
        this.refresh();
    }

    clearPreview(): void {
        if (!this.view || this.hooks.isBlocked?.()) return;
        this.retireDraft(this.readDraft());
    }

    /** A submitted ticket leaves the chart; edits made during its save stay intact. */
    retireDraft(submitted: OrderDraft): void {
        const current = this.readDraft();
        if ((['side', 'type', 'qty', 'price', 'stopLoss', 'takeProfit'] as const).some(key => current[key] !== submitted[key])) return;
        this.field('order-price').value = '';
        this.field('ticket-tp-enabled').checked = false;
        this.field('ticket-sl-enabled').checked = false;
        this.picking = false;
        this.waitingForEdit = true;
        this.refresh();
    }

    refresh(): void {
        const type = this.type();
        if (type === 'market') this.picking = false;
        const price = this.field('order-price');
        this.node('#order-price-label').hidden = type === 'market'; price.required = type !== 'market'; price.disabled = type === 'market';
        this.node('#order-price-label [data-ticket-price-label]').textContent = type === 'stop' ? 'Stop price' : 'Limit price';
        for (const tab of this.form.querySelectorAll<HTMLButtonElement>('[data-ticket-type]')) {
            const selected = tab.dataset.ticketType === type;
            tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
        }
        this.node('#ticket-fields').setAttribute('aria-labelledby', `ticket-${type}-tab`);
        for (const button of this.form.querySelectorAll<HTMLButtonElement>('[data-ticket-side]')) button.setAttribute('aria-pressed', String(button.dataset.ticketSide === this.side));
        for (const [id, enabledId] of [['take-profit', 'ticket-tp-enabled'], ['stop-loss', 'ticket-sl-enabled']]) {
            const enabled = this.field(enabledId!).checked;
            this.field(id!).disabled = !enabled; this.field(id!).required = enabled;
            this.node(`[data-exit="${id}"]`).dataset.enabled = String(enabled);
            const base = type === 'market' ? this.lastPrice : Number(price.value);
            const value = this.field(id!).value;
            const tick = this.view?.dataset.instrument.tickSize;
            const distance = value && base && tick ? (Number(value) - base) / tick * (this.side === 'buy' ? 1 : -1) * (id === 'stop-loss' ? -1 : 1) : null;
            this.node(`[data-ticket-equivalent="${id}"]`).textContent = `${distance !== null && Number.isFinite(distance) ? this.formatNumber(distance) : '—'} ticks`;
        }
        this.node('#ticket-exit-fields').hidden = !this.exitsExpanded;
        this.node('[data-ticket-exits]').setAttribute('aria-expanded', String(this.exitsExpanded));
        for (const control of this.form.querySelectorAll<HTMLButtonElement>('[data-ticket-step], [data-ticket-pick]')) {
            control.disabled = this.field(control.dataset.ticketStep ?? 'order-price').disabled;
        }
        const instrument = this.view?.dataset.instrument;
        this.node('#ticket-tick-value').textContent = instrument ? this.formatNumber(instrument.tickSize * instrument.pointValue, 2) : '—';
        for (const field of this.form.querySelectorAll<HTMLInputElement>('input')) field.setCustomValidity('');
        const error = this.validationError();
        const errorNode = this.node('#ticket-error'); errorNode.textContent = error ?? ''; errorNode.hidden = !error || this.waitingForEdit;
        const button = this.node<HTMLButtonElement>('#ticket-place');
        button.dataset.side = this.side;
        button.disabled = this.waitingForEdit || !this.view || this.view.session.status !== 'paused' || !!this.hooks.isBlocked?.() || error !== null;
        button.querySelector('strong')!.textContent = this.side === 'buy' ? 'Buy' : 'Sell';
        const qty = this.field('order-qty').value;
        const entry = type === 'market' ? this.lastPrice : price.value ? Number(price.value) : null;
        button.querySelector('small')!.textContent = `${qty || '—'} ${this.view?.dataset.symbol ?? 'contracts'}${entry !== null ? ` @ ${this.formatNumber(entry)}` : ''} ${type.toUpperCase()}`;
        const quantity = Number(this.field('order-qty').value);
        const exit = (id: string): number | null => {
            const field = this.field(id); const value = Number(field.value);
            return !field.disabled && field.value !== '' && field.validity.valid && Number.isFinite(value) && value > 0 ? value : null;
        };
        const detail: TicketPriceSelection = { side: this.side, type, price: type === 'market' || !price.value || !price.validity.valid ? null : Number(price.value),
            qty: this.validQuantity(quantity) ? quantity : undefined, takeProfit: exit('take-profit'), stopLoss: exit('stop-loss') };
        this.form.dispatchEvent(new CustomEvent<TicketPriceSelection>('local-replay:ticket-price', { bubbles: true, detail }));
        this.form.querySelector('[data-ticket-pick]')?.setAttribute('aria-pressed', String(this.picking));
        this.form.dispatchEvent(new CustomEvent('local-replay:ticket-pick', { bubbles: true, detail: { active: this.picking, type } }));
        if (this.validQuantity(quantity) && quantity !== this.reportedQuantity) {
            this.reportedQuantity = quantity;
            this.form.dispatchEvent(new CustomEvent('local-replay:ticket-quantity', { bubbles: true, detail: { quantity } }));
        }
    }

    draft(side = this.side): OrderDraft | null {
        this.side = side; this.refresh();
        if (this.waitingForEdit || !this.view || this.view.session.status !== 'paused' || this.hooks.isBlocked?.()) return null;
        const error = this.validationError();
        if (error || !this.form.reportValidity()) return null;
        return this.readDraft();
    }

    destroy(): void { for (const dispose of this.disposers.splice(0)) dispose(); }

    private field(id: string): HTMLInputElement { return this.node<HTMLInputElement>(`#${id}`); }
    private validQuantity(quantity: number): boolean { return Number.isInteger(quantity) && quantity >= 1 && quantity <= (this.view?.session.config.rules.maxContracts ?? 1000); }
    private node<T extends HTMLElement = HTMLElement>(selector: string): T {
        const node = this.form.querySelector<T>(selector);
        if (!node) throw new Error(`Missing order-ticket control: ${selector}`);
        return node;
    }
    private type(): OrderDraft['type'] { return this.node<HTMLSelectElement>('#order-type').value as OrderDraft['type']; }
    private setType(type: OrderDraft['type']): void {
        this.waitingForEdit = false;
        this.node<HTMLSelectElement>('#order-type').value = type;
        if (type !== 'market' && !this.field('order-price').value && this.lastPrice !== null) this.field('order-price').value = this.aligned(this.lastPrice, this.view!.dataset.instrument.tickSize);
    }
    private aligned(value: number, tick: number): string { return String(Number((Math.round(value / tick) * tick).toFixed(8))); }
    private formatNumber(value: number, minimumFractionDigits = 0): string { return value.toLocaleString('en-US', { minimumFractionDigits, maximumFractionDigits: 8 }); }
    private step(id: string, direction: number): void {
        const input = this.field(id);
        if (input.disabled) return;
        const tick = id === 'order-qty' ? 1 : this.view?.dataset.instrument.tickSize ?? 0.25;
        const current = input.value ? Number(input.value) : id === 'order-qty' ? 0 : this.lastPrice;
        if (current === null || !Number.isFinite(current)) return;
        const next = Math.max(Number(input.min || tick), current + Math.sign(direction) * tick);
        input.value = this.aligned(id === 'order-qty' ? Math.min(Number(input.max), next) : next, tick);
    }
    private readDraft(): OrderDraft {
        const draft: OrderDraft = { side: this.side, type: this.type(), qty: Number(this.field('order-qty').value) };
        if (draft.type !== 'market') draft.price = Number(this.field('order-price').value);
        for (const [id, key] of [['stop-loss', 'stopLoss'], ['take-profit', 'takeProfit']] as const) if (!this.field(id).disabled) draft[key] = Number(this.field(id).value);
        return draft;
    }
    private validationError(): string | null {
        if (!this.view) return null;
        try {
            const draft = validateDraft(this.readDraft(), this.view.dataset.instrument, this.lastPrice ?? undefined);
            if (draft.qty > this.view.session.config.rules.maxContracts) return `Contracts cannot exceed ${this.view.session.config.rules.maxContracts}.`;
            return null;
        } catch (error) { return error instanceof Error ? error.message : 'Check the order fields.'; }
    }
}
