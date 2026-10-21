import type { TakeProfitLeg } from '../shared/types';
import { escapeHtml } from './util';

export const MAX_TAKE_PROFIT_LEGS = 10;
const percentages = [25, 50, 75, 100];

/** Percentage shortcuts are a one-time conversion, never a fractional order size. */
export function percentageContracts(remaining: number, percentage: number): number {
    if (!Number.isSafeInteger(remaining) || remaining < 1 || remaining > 1000
        || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) return 0;
    return Math.floor(remaining * percentage / 100);
}

export function sameTakeProfitLegs(a?: readonly TakeProfitLeg[] | null, b?: readonly TakeProfitLeg[] | null): boolean {
    return (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((leg, i) =>
        leg.id === b![i]!.id && leg.price === b![i]!.price && leg.qty === b![i]!.qty);
}

export function targetAllocationError(legs: readonly TakeProfitLeg[], quantity: number, tick: number): string | null {
    if (legs.length > MAX_TAKE_PROFIT_LEGS) return 'Use at most 10 take-profit targets.';
    const ids = new Set<string>();
    for (const leg of legs) {
        if (!leg || typeof leg.id !== 'string' || !leg.id || leg.id.length > 128 || ids.has(leg.id)) return 'Each target needs a unique identity.';
        ids.add(leg.id);
        if (!Number.isSafeInteger(leg.qty) || leg.qty < 1) return 'Each partial target needs at least 1 whole contract. Percentage shortcuts round down.';
        if (!Number.isFinite(leg.price) || leg.price <= 0 || leg.price > 1e9
            || !Number.isFinite(tick) || tick <= 0 || Math.abs(leg.price / tick - Math.round(leg.price / tick)) > 1e-6) return 'Enter a positive, tick-aligned price for each target.';
    }
    if (legs.length && (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000)) return 'Enter a valid whole-contract position size.';
    if (legs.reduce((sum, leg) => sum + leg.qty, 0) > quantity) return 'Target contracts exceed the available contracts.';
    return null;
}

export function targetEditorMarkup(): string {
    return '<div class="partial-target-editor" data-target-editor><div data-target-rows></div><button type="button" class="quiet target-add" data-target-add>Add partial</button><p class="target-summary" data-target-summary hidden></p><p class="field-note target-rounding" data-target-rounding hidden>Percentages use the current total contracts and round down once. Edit exact contracts below; zero cannot be submitted.</p></div>';
}

export function readTargetLegs(host: ParentNode): TakeProfitLeg[] {
    return Array.from(host.querySelectorAll<HTMLElement>('[data-target-row]'), row => ({
        id: row.querySelector<HTMLInputElement>('[data-target-leg-id]')!.value,
        price: Number(row.querySelector<HTMLInputElement>('[data-target-price]')!.value),
        qty: Number(row.querySelector<HTMLInputElement>('[data-target-qty]')!.value),
    }));
}

interface TargetEditorOptions {
    quantity(): number;
    tick(): number;
    enabled?(): boolean;
    scalar: HTMLInputElement;
    scalarContainer: HTMLElement;
    scalarRequired?: boolean;
    changed?(): void;
}

/** Keeps raw input drafts in the DOM so ordinary refreshes never replace edits. */
export class TargetEditor {
    private readonly rows: HTMLElement;
    private readonly dispose: () => void;

    constructor(private readonly host: HTMLElement, private readonly options: TargetEditorOptions) {
        this.rows = host.querySelector('[data-target-rows]')!;
        const click = (event: MouseEvent): void => {
            const button = (event.target as Element).closest<HTMLButtonElement>('button');
            if (!button || !host.contains(button) || button.disabled) return;
            const row = button.closest<HTMLElement>('[data-target-row]');
            if (button.hasAttribute('data-target-add')) {
                if (this.rows.children.length >= MAX_TAKE_PROFIT_LEGS) return;
                const price = this.options.scalar.value;
                if (!this.hasLegs) {
                    const quantity = options.quantity();
                    if (!Number.isSafeInteger(quantity) || quantity < 2 || quantity > 1000) return;
                    const half = percentageContracts(quantity, 50);
                    this.append({ id: crypto.randomUUID(), price: Number(price), qty: half });
                    this.append({ id: crypto.randomUUID(), price: Number(price), qty: quantity - half });
                } else this.append({ id: crypto.randomUUID(), price: Number(price), qty: percentageContracts(options.quantity(), 25) });
                this.options.scalar.value = '';
            } else if (button.hasAttribute('data-target-remove')) row?.remove();
            else if (button.dataset.targetPercent && row) row.querySelector<HTMLInputElement>('[data-target-qty]')!.value = String(percentageContracts(options.quantity(), Number(button.dataset.targetPercent)));
            else return;
            this.refresh(); options.changed?.();
        };
        const input = (): void => { this.refresh(); options.changed?.(); };
        host.addEventListener('click', click); host.addEventListener('input', input);
        this.dispose = () => { host.removeEventListener('click', click); host.removeEventListener('input', input); };
        this.refresh();
    }

    get hasLegs(): boolean { return this.rows.children.length > 0; }
    get legs(): TakeProfitLeg[] { return readTargetLegs(this.host); }
    get error(): string | null { return this.options.enabled?.() === false ? null : targetAllocationError(this.legs, this.options.quantity(), this.options.tick()); }

    setLegs(legs: readonly TakeProfitLeg[]): void {
        this.rows.replaceChildren();
        for (const leg of legs) this.append(leg);
        this.refresh();
    }

    refresh(): void {
        const enabled = this.options.enabled?.() !== false;
        const quantity = this.options.quantity();
        const legs = this.legs;
        this.options.scalarContainer.hidden = this.hasLegs;
        this.options.scalar.disabled = !enabled || this.hasLegs;
        this.options.scalar.required = enabled && !this.hasLegs && !!this.options.scalarRequired;
        for (const input of this.rows.querySelectorAll<HTMLInputElement>('input:not([type=hidden])')) {
            input.disabled = !enabled; input.required = enabled;
            if (input.hasAttribute('data-target-qty')) input.max = String(quantity);
            if (input.hasAttribute('data-target-price')) { input.min = String(this.options.tick()); input.step = String(this.options.tick()); }
        }
        for (const button of this.host.querySelectorAll<HTMLButtonElement>('button')) {
            const cannotSplit = !this.hasLegs && (!Number.isSafeInteger(quantity) || quantity < 2 || quantity > 1000);
            button.disabled = !enabled || button.hasAttribute('data-target-add') && (legs.length >= MAX_TAKE_PROFIT_LEGS || cannotSplit);
            if (button.hasAttribute('data-target-add')) button.title = cannotSplit ? 'At least 2 whole contracts are needed to split a target.' : 'Add a partial take-profit target';
        }
        const allocated = legs.reduce((sum, leg) => sum + leg.qty, 0);
        const summary = this.host.querySelector<HTMLElement>('[data-target-summary]')!;
        summary.hidden = !this.hasLegs;
        summary.textContent = `${allocated} / ${Number.isFinite(quantity) ? quantity : 0} contracts allocated${quantity > 0 ? ` (${Number((allocated / quantity * 100).toFixed(2))}%)` : ''} · ${Math.max(0, quantity - allocated) || 0} runner contracts`;
        summary.dataset.invalid = String(this.error !== null);
        this.host.querySelector<HTMLElement>('[data-target-rounding]')!.hidden = !this.hasLegs;
        for (const [i, row] of Array.from(this.rows.children).entries()) {
            row.querySelector('[data-target-label]')!.textContent = `TP${i + 1}`;
            row.querySelector('[data-target-allocation]')!.textContent = `${legs[i]!.qty} contracts${quantity > 0 ? ` · ${Number((legs[i]!.qty / quantity * 100).toFixed(2))}% of current total` : ''}`;
        }
    }

    destroy(): void { this.dispose(); }

    private append(leg: TakeProfitLeg): void {
        const row = this.host.ownerDocument.createElement('div'); row.className = 'partial-target-row'; row.dataset.targetRow = '';
        row.innerHTML = `<div class="target-row-heading"><strong data-target-label></strong><button type="button" class="quiet" data-target-remove aria-label="Remove this take-profit target">Remove</button></div><input type="hidden" data-target-leg-id value="${escapeHtml(leg.id)}" /><div class="two-fields"><label>Target price<input type="number" inputmode="decimal" data-target-price value="${Number.isFinite(leg.price) && leg.price > 0 ? leg.price : ''}" /></label><label>Contracts<input type="number" inputmode="numeric" min="1" step="1" data-target-qty value="${leg.qty}" /></label></div><small data-target-allocation></small><div class="partial-percent-chips" aria-label="Target allocation shortcuts">${percentages.map(p => `<button type="button" class="quiet" data-target-percent="${p}">${p}%</button>`).join('')}</div>`;
        this.rows.append(row);
    }
}

export function partialCloseMarkup(quantity: number): string {
    return `<p class="muted">This simulated exit becomes eligible on the next source bar. Submitting cancels working orders. Percentages use the current remaining position: ${quantity} contracts.</p><div class="partial-percent-chips" aria-label="Close percentage shortcuts">${percentages.map(p => `<button type="button" class="quiet" data-close-percent="${p}">${p}%</button>`).join('')}</div><div class="two-fields"><label>Current remaining position · %<input id="close-percent" type="number" min="0" max="100" step="any" value="${100 / quantity}" /></label><label>Contracts to close<input id="close-qty" type="number" min="1" max="${quantity}" step="1" value="1" required /></label></div><p class="field-note">Percentage shortcuts round down to whole contracts. A result of zero disables submission; exact contracts stay editable.</p><p class="field-note" data-close-summary aria-live="polite"></p>`;
}

export function mountPartialClose(form: HTMLFormElement, quantity: number): void {
    const qty = form.querySelector<HTMLInputElement>('#close-qty')!;
    const pct = form.querySelector<HTMLInputElement>('#close-percent')!;
    const refresh = (): void => {
        const amount = Number(qty.value);
        const valid = qty.value !== '' && Number.isSafeInteger(amount) && amount > 0 && amount <= quantity;
        qty.setCustomValidity(valid ? '' : `Enter 1 to ${quantity} whole contracts. A rounded zero cannot be submitted.`);
        form.querySelector<HTMLElement>('[data-close-summary]')!.textContent = valid
            ? `Close ${amount} of ${quantity} remaining contracts; ${quantity - amount} will remain after filling.`
            : 'Choose at least 1 whole contract. The position size will never be rounded up.';
        form.querySelector<HTMLButtonElement>('.primary')!.disabled = !valid || form.dataset.exitSaving === 'true';
    };
    form.addEventListener('click', event => {
        const button = (event.target as Element).closest<HTMLButtonElement>('[data-close-percent]');
        if (!button || button.disabled) return;
        pct.value = button.dataset.closePercent!; qty.value = String(percentageContracts(quantity, Number(pct.value))); refresh();
    });
    form.addEventListener('input', event => {
        if (event.target === pct) qty.value = String(percentageContracts(quantity, Number(pct.value)));
        if (event.target === qty) pct.value = qty.value && Number.isFinite(Number(qty.value)) ? String(Number((Number(qty.value) / quantity * 100).toFixed(8))) : '';
        refresh();
    });
    form.addEventListener('local-replay:exit-refresh', refresh);
    refresh();
}
