import { describe, expect, it } from 'vitest';
import { applyCommand, createSession, validateStoredSession } from '../engine';
import { validateDraft, validateExecutionVersion } from '../engine/validation';
import { DEFAULT_RULES, INSTRUMENTS, type Bar, type Command, type OrderDraft, type SessionConfig } from '../shared/types';

const instrument = INSTRUMENTS[0]!;
const bars: Bar[] = Array.from({ length: 4 }, (_, i) => ({ time: 1780322400000 + i * 60000, open: 100, high: 100, low: 100, close: 100, volume: 1 }));
const config: SessionConfig = { name: 'Target validation', datasetId: 'target-validation', mode: 'practice', initialBalance: 50000, commissionPerContractSide: 1.23,
    slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES, maxContracts: 20 } };
const plan = [{ id: 'one', price: 102, qty: 1 }, { id: 'two', price: 104, qty: 2 }];
const order: OrderDraft = { side: 'buy', type: 'market', qty: 3, takeProfits: plan };
const initial = () => createSession(config, instrument, 'validation-targets');
const entered = () => applyCommand(applyCommand(initial(), bars, { type: 'place', order }), bars, { type: 'advance', count: 1 });

describe('target contract validation', () => {
    it.each([
        ['duplicate IDs', [{ ...plan[0] }, { ...plan[0] }]],
        ['invalid ID', [{ id: 'bad id', price: 102, qty: 1 }]],
        ['fractional contracts', [{ id: 'one', price: 102, qty: 0.5 }]],
        ['zero contracts', [{ id: 'one', price: 102, qty: 0 }]],
        ['off-tick price', [{ id: 'one', price: 102.1, qty: 1 }]],
        ['nonfinite price', [{ id: 'one', price: Infinity, qty: 1 }]],
        ['over-allocation', [{ id: 'one', price: 102, qty: 4 }]],
        ['eleven legs', Array.from({ length: 11 }, (_, i) => ({ id: `leg-${i}`, price: 102 + i, qty: 1 }))],
        ['loss-side target', [{ id: 'one', price: 99, qty: 1 }]],
    ])('rejects %s', (_, takeProfits) => {
        expect(() => validateDraft({ ...order, takeProfits }, instrument, 100)).toThrow();
    });

    it('rejects simultaneous scalar/list authorities, including an empty list', () => {
        expect(() => validateDraft({ ...order, takeProfit: 105 }, instrument, 100)).toThrow(/take profit|target/i);
        expect(() => validateDraft({ ...order, takeProfit: 105, takeProfits: [] }, instrument, 100)).toThrow(/take profit|target/i);
    });

    it('validates pending brackets against entry price and detached brackets against stop ordering', () => {
        expect(() => validateDraft({ ...order, type: 'limit', price: 103 }, instrument, 100)).toThrow();
        expect(() => validateDraft({ ...order, stopLoss: 103 }, instrument)).toThrow();
        expect(validateDraft({ ...order, type: 'limit', price: 99 }, instrument, 100)).toEqual({ ...order, type: 'limit', price: 99 });
    });

    it('rejects scale-in collisions and scalar/list conflicts atomically at admission', () => {
        const state = entered(); const snapshot = structuredClone(state);
        for (const next of [
            { side: 'buy', type: 'market', qty: 1, takeProfits: [plan[0]] },
            { side: 'buy', type: 'market', qty: 1, takeProfit: 105 },
        ]) expect(() => applyCommand(state, bars, { type: 'place', order: next } as Command)).toThrow();
        expect(state).toEqual(snapshot);
        const legacy = applyCommand(applyCommand(initial(), bars, { type: 'place', order: { side: 'buy', type: 'market', qty: 3, takeProfit: 105 } }), bars, { type: 'advance', count: 1 });
        expect(() => applyCommand(legacy, bars, { type: 'place', order: { side: 'buy', type: 'market', qty: 1, takeProfits: [{ id: 'new', price: 106, qty: 1 }] } })).toThrow();
    });

    it('rejects target legs on pure reductions and bounds reversal legs to new exposure', () => {
        const state = entered();
        for (const bracket of [{ takeProfits: [{ id: 'short', price: 98, qty: 1 }] }, { takeProfits: [] }]) {
            expect(() => applyCommand(state, bars, { type: 'place', order: { side: 'sell', type: 'market', qty: 1, ...bracket } })).toThrow(/reduc/i);
        }
        expect(() => applyCommand(state, bars, { type: 'place', order: { side: 'sell', type: 'market', qty: 4, takeProfits: [{ id: 'short', price: 98, qty: 2 }] } })).toThrow(/quant|exposure|contracts/i);
    });

    it('supports explicit atomic authority switches and rejects an ambiguous amendment', () => {
        const state = entered();
        expect(() => applyCommand(state, bars, { type: 'amend', takeProfit: 106 })).toThrow();
        const scalar = applyCommand(state, bars, { type: 'amend', takeProfits: null, takeProfit: 106 });
        expect(scalar.position?.takeProfits).toBeUndefined();
        expect(scalar.position?.takeProfit).toBe(106);
        const listed = applyCommand(scalar, bars, { type: 'amend', takeProfit: null, takeProfits: plan });
        expect(listed.position?.takeProfits).toEqual(plan);
        expect(listed.position?.takeProfit).toBeUndefined();
        expect(listed.executionVersion).toBe(2);
    });

    it('amends working entry legs and preserves them through JSON and command normalization', () => {
        const pending = applyCommand(initial(), bars, { type: 'place', order: { ...order, type: 'limit', price: 99 } });
        const amended = applyCommand(pending, bars, { type: 'amend', orderId: pending.orders[0]!.id, takeProfits: [{ id: 'replacement', price: 103, qty: 2 }] });
        expect(amended.executionVersion).toBe(2);
        expect(amended.orders[0]?.takeProfits).toEqual([{ id: 'replacement', price: 103, qty: 2 }]);
        expect(validateStoredSession(JSON.parse(JSON.stringify(amended)), bars, instrument)).toEqual(amended);
        expect(applyCommand(amended, bars, { type: 'rename', name: 'Preserved' }).orders[0]?.takeProfits).toEqual(amended.orders[0]?.takeProfits);
    });

    it('fails closed on unknown execution versions and malformed stored legs', () => {
        const state = entered();
        for (const executionVersion of [1, 3, null, '2']) expect(() => validateStoredSession({ ...state, executionVersion }, bars, instrument)).toThrow(/version/i);
        expect(() => validateStoredSession({ ...state, position: { ...state.position, takeProfits: [{ id: 'bad', price: 102, qty: 4 }] } }, bars, instrument)).toThrow();
        expect(() => validateStoredSession({ ...state, position: { ...state.position, takeProfit: 105 } }, bars, instrument)).toThrow();
    });

    it('requires version 2 for every new-field location, even an empty list, and retains the marker after removal', () => {
        expect(validateExecutionVersion({})).toBe(1);
        expect(validateExecutionVersion({ executionVersion: 2 })).toBe(2);
        for (const fields of [{ position: { takeProfits: [] } }, { orders: [{ takeProfits: [] }] }, { fills: [{ takeProfitLegId: 'one' }] }, { trades: [{ takeProfitLegId: 'one' }] }]) {
            expect(() => validateExecutionVersion(fields)).toThrow(/version/i);
            expect(validateExecutionVersion({ ...fields, executionVersion: 2 })).toBe(2);
        }
        const cleared = applyCommand(entered(), bars, { type: 'amend', takeProfits: null });
        expect(cleared.executionVersion).toBe(2);
        expect(cleared.position?.takeProfits).toBeUndefined();
        expect(() => validateStoredSession({ ...entered(), executionVersion: undefined }, bars, instrument)).toThrow(/version/i);
    });

    it('bounds the merged position to ten legs and retains input ownership on amendments', () => {
        const ten = Array.from({ length: 10 }, (_, i) => ({ id: `leg-${i}`, price: 102 + i, qty: 1 }));
        const state = applyCommand(applyCommand(initial(), bars, { type: 'place', order: { ...order, qty: 10, takeProfits: ten } }), bars, { type: 'advance', count: 1 });
        expect(() => applyCommand(state, bars, { type: 'place', order: { ...order, qty: 1, takeProfits: [{ id: 'extra', price: 115, qty: 1 }] } })).toThrow(/10/);
        const replacement = [{ id: 'replacement', price: 110, qty: 2 }];
        const amended = applyCommand(state, bars, { type: 'amend', takeProfits: replacement });
        replacement[0]!.qty = 10;
        expect(amended.position?.takeProfits?.[0]?.qty).toBe(2);
        expect(state.position?.takeProfits).toEqual(ten);
    });

    it('rejects forged target provenance on an entry or mismatched closing trade', () => {
        const source = [bars[0]!, { ...bars[1]!, high: 103, close: 102 }, bars[2]!, bars[3]!];
        const state = applyCommand(entered(), source, { type: 'advance', count: 1 });
        expect(() => validateStoredSession({ ...state, fills: state.fills.map((fill, i) => i === 0 ? { ...fill, takeProfitLegId: 'one' } : fill) }, source, instrument)).toThrow(/target|provenance/i);
        expect(() => validateStoredSession({ ...state, trades: state.trades.map(trade => ({ ...trade, takeProfitLegId: 'forged' })) }, source, instrument)).toThrow(/target|provenance/i);
    });
});
