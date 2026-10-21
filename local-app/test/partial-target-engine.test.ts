import { describe, expect, it } from 'vitest';
import { analytics, applyCommand, createSession, validateStoredSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS, type Bar, type Command, type OrderDraft, type Session, type SessionConfig, type Side } from '../shared/types';

const instrument = INSTRUMENTS[0]!;
const start = Date.parse('2026-06-01T14:00:00Z');
const step: Command = { type: 'advance', count: 1 };
const bar = (index: number, open = 100, high = open, low = open, close = open): Bar => ({ time: start + index * 60000, open, high, low, close, volume: 100 });
const config = (extra: Partial<SessionConfig> = {}): SessionConfig => ({ name: 'Partial targets', datasetId: 'partial-target-fixture', mode: 'practice', initialBalance: 50000,
    commissionPerContractSide: 1.23, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES, maxContracts: 20 }, ...extra });
const run = (state: Session, bars: Bar[], ...commands: Command[]): Session => commands.reduce((s, command) => applyCommand(s, bars, command), state);
const place = (order: OrderDraft): Command => ({ type: 'place', order });
const legs = (side: Side) => [{ id: 'far', price: side === 'buy' ? 106 : 94, qty: 1 }, { id: 'near', price: side === 'buy' ? 102 : 98, qty: 1 }];
const enter = (bars: Bar[], side: Side = 'buy', extra: Partial<OrderDraft> = {}, settings: Partial<SessionConfig> = {}): Session =>
    run(createSession(config(settings), instrument, 'partial-targets'), bars, place({ side, type: 'market', qty: 3, stopLoss: side === 'buy' ? 95 : 105, takeProfits: legs(side), ...extra }), step);

describe('partial target execution', () => {
    it.each(['buy', 'sell'] as const)('fills %s targets nearest first, retains a protected runner and reconciles exact fees', side => {
        const bars = [bar(0), bar(1, 100, 107, 93, 100), bar(2), bar(3)];
        // Keep the stop outside this ambiguous bar so both targets can execute.
        const state = run(enter(bars, side, { stopLoss: side === 'buy' ? 90 : 110 }), bars, step);
        expect(state.trades.map(t => t.takeProfitLegId)).toEqual(['near', 'far']);
        expect(state.trades.map(t => t.grossPnl)).toEqual([40, 120]);
        expect(state.position).toMatchObject({ qty: 1, avgPrice: 100, entryFees: 1.23, stopLoss: side === 'buy' ? 90 : 110, takeProfits: [] });
        expect(state.account.fees).toBe(6.15);
        expect(state.trades.map(t => t.fees)).toEqual([2.46, 2.46]);
        expect(analytics(state).trades).toBe(2);
        expect(JSON.parse(JSON.stringify(validateStoredSession(JSON.parse(JSON.stringify(state)), bars, instrument)))).toEqual(JSON.parse(JSON.stringify(state)));
    });

    it.each(['buy', 'sell'] as const)('uses stop first for an ambiguous %s bar and closes all remaining contracts', side => {
        const bars = [bar(0), bar(1, 100, 107, 93), bar(2)];
        const state = run(enter(bars, side), bars, step);
        expect(state.trades).toEqual([expect.objectContaining({ qty: 3, reason: 'Stop loss' })]);
        expect(state.position).toBeNull();
        expect(state.trades[0]?.takeProfitLegId).toBeUndefined();
    });

    it.each(['buy', 'sell'] as const)('fills crossed %s gap targets before a capped queued close without reversal', side => {
        const gap = side === 'buy' ? 108 : 92;
        const bars = [bar(0), bar(1, gap), bar(2), bar(3)];
        const queued = run(enter(bars, side), bars, { type: 'close', qty: 3 });
        expect(queued.position?.takeProfits).toEqual(legs(side));
        expect(queued.fills).toHaveLength(1);
        const state = run(queued, bars, step);
        expect(state.trades.map(t => [t.qty, t.exitPrice, t.takeProfitLegId])).toEqual([[1, gap, 'near'], [1, gap, 'far'], [1, gap, undefined]]);
        expect(state.position).toBeNull();
        expect(state.orders.at(-1)).toMatchObject({ qty: 1, status: 'filled', intent: 'close' });
        expect(validateStoredSession(state, bars, instrument)).toEqual(state);
    });

    it('keeps target limits protected from configured costs and uses stable ties', () => {
        const bars = [bar(0), bar(1, 100, 103, 100, 102), bar(2)];
        const state = run(enter(bars, 'buy', { stopLoss: 90, takeProfits: [{ id: 'first', price: 102, qty: 1 }, { id: 'second', price: 102, qty: 1 }] }, { slippageTicks: 1 }), bars, step);
        expect(state.trades.map(t => [t.takeProfitLegId, t.exitPrice])).toEqual([['first', 102], ['second', 102]]);
        expect(state.position?.qty).toBe(1);
    });

    it.each(['buy', 'sell'] as const)('trims the farthest %s allocations only when any reducing fill executes', side => {
        const bars = [bar(0), bar(1), bar(2), bar(3)];
        const plan = [{ id: 'near', price: side === 'buy' ? 102 : 98, qty: 1 }, { id: 'far', price: side === 'buy' ? 106 : 94, qty: 2 }];
        const queued = run(enter(bars, side, { takeProfits: plan }), bars, { type: 'close', qty: 1 });
        expect(queued.position?.takeProfits).toEqual(plan);
        const state = run(queued, bars, step);
        expect(state.position?.takeProfits).toEqual([plan[0], { ...plan[1], qty: 1 }]);
        const reduced = run(state, bars, place({ side: side === 'buy' ? 'sell' : 'buy', type: 'market', qty: 1 }), step);
        expect(reduced.position?.takeProfits).toEqual([plan[0]]);
        expect(validateStoredSession(reduced, bars, instrument)).toEqual(reduced);
    });

    it('consumes the filled leg before reconciling allocations and later stops the runner', () => {
        const bars = [bar(0), bar(1, 100, 103, 99, 101), bar(2, 94), bar(3)];
        const partial = run(enter(bars), bars, step);
        expect(partial.position?.takeProfits).toEqual([legs('buy')[0]]);
        const stopped = run(partial, bars, step);
        expect(stopped.trades.map(t => [t.qty, t.reason])).toEqual([[1, 'Take profit'], [2, 'Stop loss']]);
        expect(stopped.position).toBeNull();
    });

    it('allocates initial risk and excursions proportionally without changing average cost', () => {
        const bars = [bar(0), bar(1, 100, 103, 99, 101), bar(2), bar(3)];
        const state = run(enter(bars), bars, step);
        expect(state.trades[0]).toMatchObject({ qty: 1, entryPrice: 100, initialRisk: 100, mae: 20, mfe: 40 });
        expect(state.position).toMatchObject({ qty: 2, avgPrice: 100, initialRisk: 200, mae: 40, mfe: 120, entryFees: 2.46 });
        const closed = run(state, bars, { type: 'close' }, step);
        expect(closed.position).toBeNull();
        expect(closed.trades.reduce((sum, trade) => sum + trade.fees, 0)).toBe(closed.account.fees);
        expect(validateStoredSession(closed, bars, instrument)).toEqual(closed);
    });

    it('retains conservative risk precedence before an intrabar target', () => {
        const bars = [bar(0), bar(1, 100, 103, 100, 90), bar(2)];
        bars[1]!.low = 90;
        const settings = config({ mode: 'prop', commissionPerContractSide: 0, rules: { ...DEFAULT_RULES, maxContracts: 20, maxDailyLossUsd: 50, maxDrawdownUsd: 1000 } });
        // A conservative adverse move precedes the target, so the loss rule wins.
        const state = run(createSession(settings, instrument, 'partial-risk'), bars, place({ side: 'buy', type: 'market', qty: 3, takeProfits: legs('buy') }), step, step);
        expect(state.status).toBe('failed');
        expect(state.trades).toEqual([expect.objectContaining({ qty: 3, reason: 'Prop violation' })]);
        expect(state.position).toBeNull();
    });

    it('continues trailing risk checks on the runner after a target', () => {
        const bars = [bar(0), bar(1, 100, 104, 100, 100), bar(2)];
        const settings = config({ mode: 'prop', commissionPerContractSide: 0, rules: { ...DEFAULT_RULES, maxContracts: 20, drawdownType: 'trailing-intraday', maxDailyLossUsd: 1000, maxDrawdownUsd: 100, drawdownLocksAtInitialBalance: false } });
        const state = run(createSession(settings, instrument, 'runner-risk'), bars, place({ side: 'buy', type: 'market', qty: 3, takeProfits: legs('buy') }), step, step);
        expect(state.trades.map(t => [t.qty, t.exitPrice, t.reason])).toEqual([[1, 102, 'Take profit'], [2, 101.5, 'Prop violation']]);
        expect(state.status).toBe('failed');
        expect(state.account.balance).toBe(50100);
        expect(validateStoredSession(state, bars, instrument)).toEqual(state);
    });

    it('rechecks loss limits immediately after partial target fees before any further target', () => {
        const bars = [bar(0), bar(1, 100, 102, 100, 101), bar(2)];
        const settings = config({ mode: 'prop', commissionPerContractSide: 1000, rules: { ...DEFAULT_RULES, maxContracts: 20, maxDailyLossUsd: 3500, maxDrawdownUsd: 10000 } });
        const state = run(createSession(settings, instrument, 'target-fee-risk'), bars,
            place({ side: 'buy', type: 'market', qty: 3, takeProfits: [{ id: 'first', price: 100.25, qty: 1 }, { id: 'later', price: 101, qty: 1 }] }), step, step);
        expect(state.trades.map(t => [t.qty, t.exitPrice, t.reason, t.takeProfitLegId])).toEqual([[1, 100.25, 'Take profit', 'first'], [2, 100.25, 'Prop violation', undefined]]);
        expect(state.status).toBe('failed');
        expect(state.position).toBeNull();
        expect(validateStoredSession(state, bars, instrument)).toEqual(state);
    });

    it('trims later allocations first at equal prices without reordering surviving IDs', () => {
        const bars = [bar(0), bar(1), bar(2)];
        const state = run(enter(bars, 'buy', { takeProfits: [{ id: 'first', price: 104, qty: 1 }, { id: 'second', price: 104, qty: 1 }, { id: 'near', price: 102, qty: 1 }] }),
            bars, { type: 'close', qty: 1 }, step);
        expect(state.position?.takeProfits).toEqual([{ id: 'first', price: 104, qty: 1 }, { id: 'near', price: 102, qty: 1 }]);
    });

    it.each(['buy', 'sell'] as const)('uses the trigger reference for %s pending-entry target legs, not the pre-entry open', side => {
        const bars = [bar(0), bar(1, 100, 106, 94, 100), bar(2)];
        const entryPrice = side === 'buy' ? 95 : 105;
        const target = side === 'buy' ? 98 : 102;
        const state = run(createSession(config(), instrument), bars, step, place({ side, type: 'limit', price: entryPrice, qty: 2,
            takeProfits: [{ id: 'trigger-target', price: target, qty: 1 }] }), step);
        expect(state.trades).toEqual([expect.objectContaining({ qty: 1, entryPrice, exitPrice: target, takeProfitLegId: 'trigger-target' })]);
        expect(state.position?.qty).toBe(1);
        expect(state.orders[0]?.takeProfits).toEqual([{ id: 'trigger-target', price: target, qty: 1 }]);
        expect(validateStoredSession(state, bars, instrument)).toEqual(state);
    });

    it('rejects a late scale-in collision before charging fees', () => {
        const bars = [bar(0), bar(1), bar(2)];
        const state = run(createSession(config(), instrument), bars,
            place({ side: 'buy', type: 'market', qty: 1, takeProfits: [{ id: 'shared', price: 102, qty: 1 }] }),
            place({ side: 'buy', type: 'market', qty: 1, takeProfits: [{ id: 'shared', price: 104, qty: 1 }] }), step);
        expect(state.orders[1]).toMatchObject({ status: 'rejected' });
        expect(state.account.fees).toBe(1.23);
        expect(state.position?.qty).toBe(1);
    });

    it('rejects a queued scalar/list conflict after an earlier entry executes', () => {
        const bars = [bar(0), bar(1), bar(2)];
        const state = run(createSession(config(), instrument), bars,
            place({ side: 'buy', type: 'market', qty: 1, takeProfit: 103 }),
            place({ side: 'buy', type: 'market', qty: 1, takeProfits: [{ id: 'new', price: 104, qty: 1 }] }), step);
        expect(state.orders[1]).toMatchObject({ status: 'rejected' });
        expect(state.position).toMatchObject({ qty: 1, takeProfit: 103 });
        expect(state.account.fees).toBe(1.23);
        expect(validateStoredSession(state, bars, instrument)).toEqual(state);
    });

    it('does not use a revealed bar retrospectively after a target amendment', () => {
        const bars = [bar(0, 100, 110, 99), bar(1), bar(2)];
        const entered = run(createSession(config(), instrument), bars, place({ side: 'buy', type: 'market', qty: 2 }), step);
        const amended = run(entered, bars, { type: 'amend', takeProfits: [{ id: 'new', price: 105, qty: 1 }] });
        expect(amended.trades).toHaveLength(0);
        expect(run(amended, bars, step).trades).toHaveLength(0);
    });

    it('merges same-side legs, retains them on unbracketed scale-in and preserves weighted cost basis', () => {
        const bars = [bar(0), bar(1, 101), bar(2, 101), bar(3)];
        const added = run(enter(bars), bars, place({ side: 'buy', type: 'market', qty: 1, takeProfits: [{ id: 'added', price: 108, qty: 1 }] }), step);
        expect(added.position?.takeProfits?.map(t => t.id)).toEqual(['far', 'near', 'added']);
        expect(added.position?.avgPrice).toBe(100.25);
        const plain = run(added, bars, place({ side: 'buy', type: 'market', qty: 1 }), step);
        expect(plain.position?.takeProfits).toEqual(added.position?.takeProfits);
        expect(plain.position?.qty).toBe(5);
        expect(validateStoredSession(plain, bars, instrument)).toEqual(plain);
    });

    it('installs reversal legs only on the newly opened residual quantity', () => {
        const bars = [bar(0), bar(1), bar(2), bar(3)];
        const state = run(enter(bars), bars, place({ side: 'sell', type: 'market', qty: 5, takeProfits: [{ id: 'short', price: 98, qty: 2 }], stopLoss: 105 }), step);
        expect(state.position).toMatchObject({ side: 'sell', qty: 2, takeProfits: [{ id: 'short', price: 98, qty: 2 }] });
        expect(state.trades[0]).toMatchObject({ side: 'buy', qty: 3 });
        expect(validateStoredSession(state, bars, instrument)).toEqual(state);
    });

    it('rejects a queued bracket if earlier fills make it a pure reduction', () => {
        const bars = [bar(0), bar(1), bar(2)];
        const state = run(createSession(config(), instrument), bars,
            place({ side: 'buy', type: 'market', qty: 3 }), place({ side: 'sell', type: 'market', qty: 1, takeProfits: [{ id: 'short', price: 98, qty: 1 }] }), step);
        expect(state.orders[1]).toMatchObject({ status: 'rejected' });
        expect(state.position).toMatchObject({ side: 'buy', qty: 3 });
        expect(state.fills).toHaveLength(1);
    });

    it('retains legacy scalar all-remaining behavior and never adds a version marker to legacy-only sessions', () => {
        const bars = [bar(0), bar(1), bar(2, 103), bar(3)];
        const state = run(createSession(config(), instrument), bars, place({ side: 'buy', type: 'market', qty: 2, takeProfit: 102 }), step,
            place({ side: 'buy', type: 'market', qty: 1 }), step, step);
        expect(state.trades).toEqual([expect.objectContaining({ qty: 3, reason: 'Take profit' })]);
        expect(state.executionVersion).toBeUndefined();
        expect(validateStoredSession(state, bars, instrument)).toEqual(state);
    });

    it.each(['buy', 'sell'] as const)('preserves legacy scalar reduction admission for a %s position without installing entry exits', side => {
        const bars = [bar(0), bar(1), bar(2), bar(3)];
        const d = side === 'buy' ? 1 : -1;
        const stopLoss = 100 - d * 5; const takeProfit = 100 + d * 10;
        const reducing = { side: side === 'buy' ? 'sell' : 'buy', type: 'market', qty: 1, stopLoss: 100 + d * 5, takeProfit: 100 - d * 10 } satisfies OrderDraft;
        const state = run(createSession(config(), instrument), bars, place({ side, type: 'market', qty: 3, stopLoss, takeProfit }), step, place(reducing), step);
        expect(state.orders.at(-1)?.status).toBe('filled');
        expect(state.position).toMatchObject({ side, qty: 2, stopLoss, takeProfit });
        expect(state.position?.takeProfits).toBeUndefined();
        expect(state.executionVersion).toBeUndefined();
        const flat = run(state, bars, place({ ...reducing, qty: 2 }), step);
        expect(flat.position).toBeNull();
        expect(flat.orders.at(-1)?.status).toBe('filled');
        expect(flat.executionVersion).toBeUndefined();
        expect(validateStoredSession(flat, bars, instrument)).toEqual(flat);
    });
});
