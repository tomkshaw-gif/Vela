// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { chartOrderLines, orderLineAmendment } from '../client/chart-order-lines';
import { TradeTicket, tradeTicketMarkup } from '../client/trade-ticket';
import { createSession } from '../engine';
import { mountPartialClose, partialCloseMarkup, percentageContracts, sameTakeProfitLegs, targetAllocationError } from '../client/partial-exit-controls';
import { DEFAULT_RULES, INSTRUMENTS, type SessionView } from '../shared/types';

const legs = [{ id: 'near', price: 110, qty: 2 }, { id: 'far', price: 120, qty: 1 }];
function state(): SessionView {
    const instrument = INSTRUMENTS[0]!;
    const session = createSession({ name: 'Partial target fixture', datasetId: 'synthetic', mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES } }, instrument, 'partials-ui');
    session.cursor = 0;
    return { session, dataset: { id: 'synthetic', name: 'Synthetic', symbol: 'NQZ6', schema: 'ohlcv-1m', intervalMs: 60000,
        instrument, barCount: 10, start: 0, end: 600000, source: 'demo', createdAt: '', checksum: '' } };
}
afterEach(() => document.body.replaceChildren());

function ticketFixture(quantity = 4) {
    document.body.innerHTML = tradeTicketMarkup();
    const form = document.querySelector<HTMLFormElement>('#ticket-form')!;
    const ticket = new TradeTicket(form, { submit() {} }); ticket.update(state(), 100);
    const field = (id: string): HTMLInputElement => form.querySelector(`#${id}`)!;
    const edit = (input: HTMLInputElement, value: string): void => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
    edit(field('order-qty'), String(quantity));
    ticket.selectPrice(99); ticket.selectBracket('takeProfit', 120);
    const add = (): void => form.querySelector<HTMLButtonElement>('[data-target-add]')!.click();
    const rows = (): HTMLElement[] => Array.from(form.querySelectorAll('[data-target-row]'));
    return { form, ticket, field, edit, add, rows };
}

describe('partial target UI capabilities', () => {
    it('offers an add-partial action under the existing ticket take-profit switch', () => {
        document.body.innerHTML = tradeTicketMarkup();
        const form = document.querySelector<HTMLFormElement>('#ticket-form')!;
        const ticket = new TradeTicket(form, { submit() {} }); ticket.update(state(), 100);
        try { expect(form.querySelector('[data-target-add]')).not.toBeNull(); }
        finally { ticket.destroy(); }
    });

    it('projects individual position targets with leg quantity and stable identity while the stop covers the remainder', () => {
        const view = state();
        view.session.position = { side: 'buy', qty: 5, avgPrice: 100, entryTime: 0, entryFees: 0, mae: 0, mfe: 0, stopLoss: 90, takeProfits: legs };
        const lines = chartOrderLines(view);
        expect(lines.filter(line => line.kind === 'takeProfit')).toMatchObject([
            { key: 'takeProfit:near', takeProfitLegId: 'near', text: 'TP1', qty: 2, price: 110 },
            { key: 'takeProfit:far', takeProfitLegId: 'far', text: 'TP2', qty: 1, price: 120 },
        ]);
        expect(lines.find(line => line.kind === 'stopLoss')?.qty).toBe(5);
    });

    it('amends or removes only the selected target using the whole atomic list', () => {
        const view = state();
        view.session.position = { side: 'buy', qty: 5, avgPrice: 100, entryTime: 0, entryFees: 0, mae: 0, mfe: 0, takeProfits: legs };
        const line = chartOrderLines(view).find(item => item.key === 'takeProfit:near');
        expect(line).toBeDefined();
        if (!line) return;
        expect(orderLineAmendment(line, 111)).toEqual({ type: 'amend', takeProfits: [{ ...legs[0]!, price: 111 }, legs[1]] });
        expect(orderLineAmendment(line, null)).toEqual({ type: 'amend', takeProfits: [legs[1]] });
        expect(legs[0]!.price).toBe(110);
    });
});

describe('whole-contract percentage controls', () => {
    it.each([[1, 25, 0], [3, 25, 0], [3, 50, 1], [3, 75, 2], [3, 100, 3], [5, 50, 2], [1000, 0.1, 1]])('converts %s contracts at %s%% into %s whole contracts', (qty, pct, expected) => {
        expect(percentageContracts(qty, pct)).toBe(expected);
    });

    it.each([NaN, Infinity, -1, 0, 1.5, 1001])('does not upsize invalid owner size %s', qty => {
        expect(percentageContracts(qty, 50)).toBe(0);
    });

    it.each([NaN, Infinity, -1, 100.1])('rejects invalid percentage %s', pct => {
        expect(percentageContracts(5, pct)).toBe(0);
    });

    it('uses remaining size and disables zero/fractional/oversized closes while leaving exact quantity editable', () => {
        document.body.innerHTML = `<form>${partialCloseMarkup(3)}<button class="primary">Submit</button></form>`;
        const form = document.querySelector('form')!; mountPartialClose(form, 3);
        const qty = form.querySelector<HTMLInputElement>('#close-qty')!, pct = form.querySelector<HTMLInputElement>('#close-percent')!;
        const submit = form.querySelector<HTMLButtonElement>('.primary')!;
        form.querySelector<HTMLButtonElement>('[data-close-percent="25"]')!.click();
        expect(qty.value).toBe('0'); expect(submit.disabled).toBe(true);
        expect(form.textContent).toContain('current remaining position: 3 contracts');
        expect(form.textContent).toContain('Submitting cancels working orders.');
        form.querySelector<HTMLButtonElement>('[data-close-percent="50"]')!.click();
        expect(qty.value).toBe('1'); expect(submit.disabled).toBe(false);
        expect(form.querySelector('[data-close-summary]')!.textContent).toContain('2 will remain after filling');
        for (const invalid of ['1.5', '4', '']) {
            qty.value = invalid; qty.dispatchEvent(new Event('input', { bubbles: true }));
            expect(qty.value).toBe(invalid); expect(submit.disabled).toBe(true);
        }
        qty.value = '2'; qty.dispatchEvent(new Event('input', { bubbles: true }));
        expect(Number(pct.value)).toBeCloseTo(66.66666667); expect(submit.disabled).toBe(false);
        pct.value = '100'; pct.dispatchEvent(new Event('input', { bubbles: true }));
        expect(qty.value).toBe('3'); expect(submit.disabled).toBe(false);
    });
});

describe('partial target ticket drafts', () => {
    it.each([2, 4, 5])('first Add partial preserves all %s contracts and the scalar price across two stable legs', quantity => {
        const f = ticketFixture(quantity);
        try {
            f.add(); const draft = f.ticket.draft()!;
            expect(draft.takeProfit).toBeUndefined();
            expect(draft.takeProfits?.map(leg => [leg.price, leg.qty])).toEqual([[120, Math.floor(quantity / 2)], [120, quantity - Math.floor(quantity / 2)]]);
            expect(new Set(draft.takeProfits!.map(leg => leg.id)).size).toBe(2);
            expect(f.form.querySelector('[data-target-summary]')!.textContent).toContain(`${quantity} / ${quantity} contracts allocated (100%)`);
            if (quantity === 5) expect(f.rows().map(row => row.querySelector('[data-target-allocation]')!.textContent)).toEqual(['2 contracts · 40% of current total', '3 contracts · 60% of current total']);
            f.ticket.update(state(), 101);
            expect(f.ticket.draft()?.takeProfits).toEqual(draft.takeProfits);
        } finally { f.ticket.destroy(); }
    });

    it.each(['1', '0', '1.5', ''])('does not split or erase the scalar for owner quantity %s', quantity => {
        const f = ticketFixture();
        try {
            f.edit(f.field('order-qty'), quantity);
            const add = f.form.querySelector<HTMLButtonElement>('[data-target-add]')!;
            expect(add.disabled).toBe(true); expect(add.title).toContain('At least 2 whole contracts');
            add.click(); expect(f.rows()).toHaveLength(0); expect(f.field('take-profit').value).toBe('120');
        } finally { f.ticket.destroy(); }
    });

    it('keeps exact allocations when size changes, rejects oversubscription and converts shortcuts only when clicked', () => {
        const f = ticketFixture(5);
        try {
            f.add(); const ids = f.ticket.draft()!.takeProfits!.map(leg => leg.id);
            f.edit(f.field('order-qty'), '4');
            expect(f.rows().map(row => row.querySelector<HTMLInputElement>('[data-target-qty]')!.value)).toEqual(['2', '3']);
            expect(f.ticket.draft()).toBeNull();
            expect(f.form.querySelector('#ticket-error')!.textContent).toContain('exceed');
            f.rows()[1]!.querySelector<HTMLButtonElement>('[data-target-percent="25"]')!.click();
            expect(f.ticket.draft()?.takeProfits?.map(leg => leg.qty)).toEqual([2, 1]);
            expect(f.ticket.draft()?.takeProfits?.map(leg => leg.id)).toEqual(ids);
            f.edit(f.field('order-qty'), '5');
            expect(f.ticket.draft()?.takeProfits?.map(leg => leg.qty)).toEqual([2, 1]);
            expect(f.form.querySelector('[data-target-summary]')!.textContent).toContain('2 runner contracts');
        } finally { f.ticket.destroy(); }
    });

    it('leaves newly added invalid rows editable without resizing existing allocations', () => {
        const f = ticketFixture(4);
        try {
            f.add(); f.add();
            expect(f.rows().map(row => row.querySelector<HTMLInputElement>('[data-target-qty]')!.value)).toEqual(['2', '2', '1']);
            expect(f.ticket.draft()).toBeNull();
            f.rows()[2]!.querySelector<HTMLButtonElement>('[data-target-remove]')!.click();
            expect(f.ticket.draft()?.takeProfits).toHaveLength(2);
            f.rows()[0]!.querySelector<HTMLButtonElement>('[data-target-remove]')!.click();
            expect(f.ticket.draft()?.takeProfits).toHaveLength(1);
            expect(f.form.querySelector('[data-target-summary]')!.textContent).toContain('2 runner contracts');
        } finally { f.ticket.destroy(); }
    });

    it.each(['price', 'qty', 'id', 'added', 'removed', 'unchanged'] as const)('retirement preserves a newer %s leg draft and retires structural equality', edit => {
        const f = ticketFixture();
        try {
            f.add(); const submitted = structuredClone(f.ticket.draft()!);
            if (edit === 'price') f.edit(f.rows()[0]!.querySelector('[data-target-price]')!, '121');
            if (edit === 'qty') f.edit(f.rows()[0]!.querySelector('[data-target-qty]')!, '1');
            if (edit === 'id') f.rows()[0]!.querySelector<HTMLInputElement>('[data-target-leg-id]')!.value = crypto.randomUUID();
            if (edit === 'added') f.add();
            if (edit === 'removed') f.rows()[0]!.querySelector<HTMLButtonElement>('[data-target-remove]')!.click();
            if (edit === 'unchanged') f.ticket.selectTakeProfits(submitted.takeProfits!.map(leg => ({ ...leg })));
            f.ticket.retireDraft(submitted);
            expect(f.field('order-price').value).toBe(edit === 'unchanged' ? '' : '99');
            expect(f.rows().length).toBe(edit === 'unchanged' ? 0 : edit === 'added' ? 3 : edit === 'removed' ? 1 : 2);
        } finally { f.ticket.destroy(); }
    });

    it('does not create a competing scalar target while legs are active', () => {
        const f = ticketFixture();
        try {
            f.add(); const before = f.ticket.draft(); f.ticket.selectBracket('takeProfit', 130);
            expect(f.ticket.draft()).toEqual(before); expect(f.field('take-profit').disabled).toBe(true);
        } finally { f.ticket.destroy(); }
    });

    it('bounds target count and validates whole quantities, uniqueness and allocation independently of prices', () => {
        expect(targetAllocationError(Array.from({ length: 11 }, (_, i) => ({ id: String(i), price: 120, qty: 1 })), 20, .25)).toContain('at most 10');
        expect(targetAllocationError([{ id: 'a', price: 120, qty: .5 }], 4, .25)).toContain('whole contract');
        expect(targetAllocationError([{ id: 'a', price: 120, qty: 4 }, { id: 'b', price: 121, qty: 1 }], 4, .25)).toContain('exceed');
        expect(targetAllocationError([{ id: 'a', price: 120, qty: 1 }, { id: 'a', price: 121, qty: 1 }], 4, .25)).toContain('unique');
        expect(sameTakeProfitLegs(legs, structuredClone(legs))).toBe(true);
        expect(sameTakeProfitLegs(legs, [...legs].reverse())).toBe(false);
    });
});
