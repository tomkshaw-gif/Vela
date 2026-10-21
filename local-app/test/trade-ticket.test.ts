// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TradeTicket, tradeTicketMarkup, type TicketPriceSelection } from '../client/trade-ticket';
import { createSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS, type SessionView } from '../shared/types';

const instrument = INSTRUMENTS[0]!;
function view(id = 'ticket-fixture'): SessionView {
    const session = createSession({ name: 'Ticket fixture', datasetId: 'data-fixture', mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES } }, instrument, id);
    return { session, dataset: { id: 'data-fixture', name: 'Synthetic test', symbol: 'NQM4', schema: 'ohlcv-1m', intervalMs: 60000,
        instrument, barCount: 10, start: 0, end: 600000, source: 'demo', createdAt: '', checksum: '' } };
}
function fixture() {
    document.body.innerHTML = tradeTicketMarkup();
    const form = document.querySelector<HTMLFormElement>('#ticket-form')!;
    const submit = vi.fn(); let blocked = false;
    const ticket = new TradeTicket(form, { submit, isBlocked: () => blocked });
    const state = view(); ticket.update(state, 100);
    const input = (id: string, value: string): void => {
        const control = form.querySelector<HTMLInputElement>(`#${id}`)!;
        control.value = value; control.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const click = (selector: string): void => form.querySelector<HTMLButtonElement>(selector)!.click();
    return { form, submit, ticket, state, input, click, block: () => { blocked = true; ticket.refresh(); } };
}
afterEach(() => document.body.replaceChildren());

describe('local order ticket', () => {
    it('uses side selection, order-type tabs, one submit and revealed-close replay quotes', () => {
        const f = fixture();
        expect([...f.form.querySelectorAll('[data-ticket-side]')].map(node => node.getAttribute('data-ticket-side'))).toEqual(['sell', 'buy']);
        expect([...f.form.querySelectorAll('[role=tab]')].map(node => node.textContent)).toEqual(['Market', 'Limit', 'Stop']);
        expect(f.form.querySelectorAll('button[type=submit]')).toHaveLength(1);
        expect([...f.form.querySelectorAll('[id]')].map(node => node.id).length).toBe(new Set([...f.form.querySelectorAll('[id]')].map(node => node.id)).size);
        expect(f.form.querySelector('[aria-label="Simulated bid 100.00"]')!.textContent).toBe('100.00');
        expect(f.form.querySelector('[aria-label="Simulated ask 100.00"]')!.textContent).toBe('100.00');
        f.ticket.update(f.state, null);
        expect(f.form.querySelector('[aria-label="Bid unavailable"]')!.textContent).toBe('...');
        expect(f.form.querySelector('[aria-label="Ask unavailable"]')!.textContent).toBe('...');
        f.ticket.destroy();
    });

    it('side selection never places an order and submit uses the selected side exactly once', () => {
        const f = fixture();
        f.click('[data-ticket-side=sell]');
        expect(f.submit).not.toHaveBeenCalled();
        expect(f.form.querySelector('[data-ticket-side=sell]')!.getAttribute('aria-pressed')).toBe('true');
        f.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(f.submit).toHaveBeenCalledExactlyOnceWith('sell');
        expect(f.ticket.draft()).toEqual({ side: 'sell', type: 'market', qty: 1 });
        f.ticket.destroy();
    });

    it('seeds a limit from the revealed last price and retains it across stop/limit changes and source updates', () => {
        const f = fixture();
        f.click('[data-ticket-type=limit]');
        expect(f.ticket.draft()).toEqual({ side: 'buy', type: 'limit', qty: 1, price: 100 });
        f.input('order-price', '99.5');
        f.click('[data-ticket-type=stop]');
        expect(f.ticket.draft()).toEqual({ side: 'buy', type: 'stop', qty: 1, price: 99.5 });
        f.ticket.update({ ...f.state, session: { ...f.state.session, revision: 2 } }, 120);
        expect(f.form.querySelector<HTMLInputElement>('#order-price')!.value).toBe('99.5');
        expect(f.form.querySelector('[data-ticket-type=stop]')!.getAttribute('aria-selected')).toBe('true');
        f.ticket.destroy();
    });

    it('steps prices by the instrument tick and rejects off-tick input without changing it', () => {
        const f = fixture();
        f.click('[data-ticket-type=limit]');
        f.click('[data-ticket-step=order-price][data-direction="1"]');
        expect(f.ticket.draft()!.price).toBe(100.25);
        f.input('order-price', '100.1');
        expect(f.ticket.draft()).toBeNull();
        expect(f.form.querySelector<HTMLInputElement>('#order-price')!.value).toBe('100.1');
        expect(f.form.querySelector('#ticket-error')!.textContent).toMatch(/tick size/);
        f.ticket.destroy();
    });

    it('uses optional protective exits, validates their side, and omits unchecked retained values', () => {
        const f = fixture();
        for (const id of ['stop-loss', 'take-profit']) {
            expect(f.form.querySelector<HTMLElement>(`[data-exit="${id}"]`)!.hidden).toBe(false);
            expect(f.form.querySelector<HTMLInputElement>(`#${id}`)!.disabled).toBe(true);
            expect(f.form.querySelector<HTMLInputElement>(`#${id}`)!.value).toBe('');
            expect(f.form.querySelector<HTMLButtonElement>(`[data-ticket-step="${id}"]`)!.disabled).toBe(true);
        }
        f.click('#ticket-sl-enabled');
        f.input('stop-loss', '95');
        f.click('#ticket-tp-enabled');
        f.input('take-profit', '105');
        expect(f.ticket.draft()).toEqual({ side: 'buy', type: 'market', qty: 1, stopLoss: 95, takeProfit: 105 });
        expect(f.form.querySelector('[data-ticket-equivalent="take-profit"]')!.textContent).toBe('20 ticks');
        expect(f.ticket.draft('sell')).toBeNull();
        f.click('#ticket-sl-enabled'); f.click('#ticket-tp-enabled');
        expect(f.ticket.draft()).toEqual({ side: 'sell', type: 'market', qty: 1 });
        expect(f.form.querySelector<HTMLInputElement>('#stop-loss')!.value).toBe('95');
        expect(f.form.querySelector<HTMLInputElement>('#take-profit')!.value).toBe('105');
        f.ticket.destroy();
    });

    it('rejects an enabled empty exit and preserves enabled bracket values through disclosure changes', () => {
        const f = fixture();
        f.click('#ticket-tp-enabled');
        expect(f.ticket.draft()).toBeNull();
        expect(f.form.querySelector<HTMLButtonElement>('#ticket-place')!.disabled).toBe(true);
        f.input('take-profit', '105');
        f.click('[data-ticket-exits]');
        expect(f.form.querySelector('[data-ticket-exits]')!.getAttribute('aria-expanded')).toBe('false');
        expect(f.form.querySelector<HTMLElement>('#ticket-exit-fields')!.hidden).toBe(true);
        expect(f.ticket.draft()).toEqual({ side: 'buy', type: 'market', qty: 1, takeProfit: 105 });
        f.click('[data-ticket-exits]');
        expect(f.form.querySelector<HTMLElement>('#ticket-exit-fields')!.hidden).toBe(false);
        expect(f.form.querySelector<HTMLInputElement>('#take-profit')!.value).toBe('105');
        expect(f.submit).not.toHaveBeenCalled();
        f.ticket.destroy();
    });

    it('uses instrument metadata for tick value and formats the actual selected entry on the submit button', () => {
        const f = fixture();
        expect(f.form.querySelector('#ticket-tick-value')!.textContent).toBe('5.00');
        f.ticket.update(f.state, 18340);
        f.click('[data-ticket-type=limit]');
        expect(f.form.querySelector('#ticket-place small')!.textContent).toBe('1 NQM4 @ 18,340 LIMIT');
        f.input('order-price', '18340.25');
        expect(f.form.querySelector('#ticket-place small')!.textContent).toBe('1 NQM4 @ 18,340.25 LIMIT');
        f.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(f.submit).toHaveBeenCalledExactlyOnceWith('buy');
        f.ticket.update({ ...f.state, dataset: { ...f.state.dataset, symbol: 'MNQM4', instrument: INSTRUMENTS[1]! } }, 18340);
        expect(f.form.querySelector('#ticket-tick-value')!.textContent).toBe('0.50');
        f.ticket.destroy();
    });

    it('announces chart entry-price selection without submitting or revealing future data', () => {
        const f = fixture(); const updates: TicketPriceSelection[] = [];
        f.form.addEventListener('local-replay:ticket-price', event => updates.push((event as CustomEvent<TicketPriceSelection>).detail));
        f.ticket.selectPrice(98.62);
        expect(f.ticket.draft()!.price).toBe(98.5);
        expect(updates.at(-1)).toEqual({ side: 'buy', type: 'limit', price: 98.5, qty: 1, takeProfit: null, stopLoss: null });
        expect(f.submit).not.toHaveBeenCalled();
        f.ticket.destroy();
    });

    it('synchronizes valid chart quantities without submitting or changing the selected order', () => {
        const f = fixture(); const quantities: number[] = [];
        f.form.addEventListener('local-replay:ticket-quantity', event => quantities.push((event as CustomEvent<{ quantity: number }>).detail.quantity));
        f.click('[data-ticket-type=limit]');
        f.click('[data-ticket-side=sell]'); f.ticket.setQuantity(2);
        expect(f.ticket.draft()).toEqual({ side: 'sell', type: 'limit', qty: 2, price: 100 });
        expect(quantities.at(-1)).toBe(2);
        f.ticket.setQuantity(3);
        expect(f.ticket.draft()!.qty).toBe(3);
        for (const invalid of [0, 1.5, Infinity, f.state.session.config.rules.maxContracts + 1]) f.ticket.setQuantity(invalid);
        expect(f.ticket.draft()!.qty).toBe(3);
        f.block(); f.ticket.setQuantity(1);
        expect(f.form.querySelector<HTMLInputElement>('#order-qty')!.value).toBe('3');
        expect(f.form.querySelector('[data-ticket-side=sell]')!.getAttribute('aria-pressed')).toBe('true');
        expect(f.submit).not.toHaveBeenCalled();
        f.ticket.destroy();
    });

    it('edits and removes draft brackets and entry from chart controls without commands', () => {
        const f = fixture(); const updates: TicketPriceSelection[] = [];
        f.form.addEventListener('local-replay:ticket-price', event => updates.push((event as CustomEvent<TicketPriceSelection>).detail));
        f.ticket.selectPrice(100);
        f.ticket.selectBracket('takeProfit', 102.62); f.ticket.selectBracket('stopLoss', 99.1);
        expect(updates.at(-1)).toMatchObject({ price: 100, qty: 1, takeProfit: 102.5, stopLoss: 99 });
        f.ticket.selectBracket('stopLoss', null);
        expect(updates.at(-1)!.stopLoss).toBeNull();
        expect(f.form.querySelector<HTMLInputElement>('#stop-loss')!.value).toBe('99');
        f.ticket.clearPreview();
        expect(updates.at(-1)!.price).toBeNull(); expect(f.ticket.draft()).toBeNull();
        expect(f.submit).not.toHaveBeenCalled(); f.ticket.destroy();
    });

    it('retires a submitted draft and exits without discarding a newer ticket edit', () => {
        const f = fixture();
        f.ticket.selectPrice(100); f.ticket.selectBracket('takeProfit', 105); f.ticket.selectBracket('stopLoss', 95);
        const submitted = f.ticket.draft()!;
        f.input('order-price', '99'); f.ticket.retireDraft(submitted);
        expect(f.form.querySelector<HTMLInputElement>('#order-price')!.value).toBe('99');
        f.input('order-price', '100'); f.ticket.retireDraft(submitted);
        expect(f.form.querySelector<HTMLInputElement>('#order-price')!.value).toBe('');
        expect(f.form.querySelector<HTMLInputElement>('#ticket-tp-enabled')!.checked).toBe(false);
        expect(f.form.querySelector<HTMLInputElement>('#ticket-sl-enabled')!.checked).toBe(false);
        expect(f.form.querySelector<HTMLElement>('#ticket-error')!.hidden).toBe(true);
        expect(f.form.querySelector<HTMLButtonElement>('#ticket-place')!.disabled).toBe(true);
        f.input('order-price', '99');
        expect(f.ticket.draft()).toMatchObject({ type: 'limit', price: 99 });
        expect(f.submit).not.toHaveBeenCalled(); f.ticket.destroy();
    });

    it('reactivates a retired ticket when its order type changes by keyboard', () => {
        const f = fixture(); f.ticket.selectPrice(100); f.ticket.retireDraft(f.ticket.draft()!);
        expect(f.form.querySelector<HTMLButtonElement>('#ticket-place')!.disabled).toBe(true);
        f.form.querySelector<HTMLButtonElement>('[data-ticket-type=limit]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        expect(f.ticket.draft()).toEqual({ side: 'buy', type: 'market', qty: 1 });
        expect(f.form.querySelector<HTMLButtonElement>('#ticket-place')!.disabled).toBe(false);
        expect(f.submit).not.toHaveBeenCalled(); f.ticket.destroy();
    });

    it('arms chart price picking explicitly and disarms it on a price selection or Escape', () => {
        const f = fixture(); const picks: { active: boolean; type: string }[] = [];
        f.form.addEventListener('local-replay:ticket-pick', event => picks.push((event as CustomEvent<{ active: boolean; type: string }>).detail));
        f.click('[data-ticket-type=limit]'); f.click('[data-ticket-pick]');
        expect(picks.at(-1)).toEqual({ active: true, type: 'limit' });
        f.ticket.selectPrice(99);
        expect(picks.at(-1)).toEqual({ active: false, type: 'limit' });
        f.click('[data-ticket-pick]');
        f.form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(picks.at(-1)).toEqual({ active: false, type: 'limit' });
        expect(f.submit).not.toHaveBeenCalled();
        f.ticket.destroy();
    });

    it('resets drafts only when sessions change and blocks stale submit callbacks during runtime changes', () => {
        const f = fixture();
        f.click('[data-ticket-side=sell]'); f.input('order-qty', '2'); f.click('[data-ticket-type=limit]');
        f.ticket.update(f.state, 105);
        expect(f.ticket.draft()).toMatchObject({ side: 'sell', qty: 2, type: 'limit', price: 100 });
        f.ticket.update(view('new-ticket-fixture'), 110);
        expect(f.ticket.draft()).toEqual({ side: 'buy', type: 'market', qty: 1 });
        f.block();
        f.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(f.submit).not.toHaveBeenCalled();
        expect(f.form.querySelector<HTMLButtonElement>('#ticket-place')!.disabled).toBe(true);
        f.ticket.destroy();
    });

    it('navigates type tabs by keyboard and removes handlers on destruction', () => {
        const f = fixture();
        const tab = f.form.querySelector<HTMLButtonElement>('[data-ticket-type=market]')!;
        tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(f.ticket.draft()!.type).toBe('limit');
        expect(document.activeElement?.id).toBe('ticket-limit-tab');
        f.ticket.destroy();
        f.click('[data-ticket-side=sell]');
        expect(f.form.querySelector('[data-ticket-side=buy]')!.getAttribute('aria-pressed')).toBe('true');
    });
});
