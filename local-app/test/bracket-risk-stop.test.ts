import { describe, expect, it } from 'vitest';
import { applyCommand, createSession, validateStoredSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS, type Bar, type Command, type Session, type Side } from '../shared/types';

const START = Date.UTC(2024, 3, 8, 13, 30);
const ENTRY = 20000;
const instrument = INSTRUMENTS[0]!;
function scenario(side: Side, bracket: 'stop' | 'target', dailyLoss = 100) {
    const direction = side === 'buy' ? 1 : -1;
    const exit = ENTRY + direction * (bracket === 'stop' ? -4.75 : 0.25);
    const commission = bracket === 'stop' ? 2.5 : 60;
    const candles: Bar[] = [
        { time: START, open: ENTRY, high: ENTRY, low: ENTRY, close: ENTRY, volume: 100 },
        { time: START + 60000, open: ENTRY, high: Math.max(ENTRY, exit), low: Math.min(ENTRY, exit), close: ENTRY, volume: 100 },
        { time: START + 120000, open: ENTRY, high: ENTRY, low: ENTRY, close: ENTRY, volume: 100 },
    ];
    let state = createSession({ name: 'Bracket liquidation risk', datasetId: 'bracket-fixture', mode: 'prop', initialBalance: 50000,
        commissionPerContractSide: commission, slippageTicks: 0, spreadTicks: 0, startIndex: 0,
        rules: { ...DEFAULT_RULES, maxDailyLossUsd: dailyLoss, maxDrawdownUsd: 2000 } }, instrument);
    const command = (value: Command): void => { state = applyCommand(state, candles, value); };
    command({ type: 'place', order: { side, type: 'market', qty: 1, ...(bracket === 'stop' ? { stopLoss: exit } : { takeProfit: exit }) } });
    command({ type: 'advance', count: 1 });
    const queuedSide = bracket === 'stop' ? side : side === 'buy' ? 'sell' : 'buy';
    command({ type: 'place', order: { side: queuedSide, type: 'limit', qty: 1, price: exit } });
    command({ type: 'place', order: { side: queuedSide, type: 'limit', qty: 1, price: exit + (queuedSide === 'buy' ? -0.5 : 0.5) } });
    const queuedIds = state.orders.slice(1).map(order => order.id);
    const before = state;
    command({ type: 'advance', count: 1 });
    return { state, before, candles, exit, queuedIds };
}
function failedAtBracket(state: Session, balance: number, fees: number): void {
    expect(state.status).toBe('failed'); expect(state.prop.status).toBe('failed'); expect(state.prop.reason).toBe('Maximum daily loss breached');
    expect(state.position).toBeNull(); expect(state.cursor).toBe(1);
    expect(state.account).toMatchObject({ balance, equity: balance, netPnl: balance - 50000, fees, unrealizedPnl: 0, maxDrawdown: 50000 - balance });
    expect(state.prop.dailyLoss).toBe(50000 - balance);
    expect(state.fills).toHaveLength(2); expect(state.trades).toHaveLength(1);
    expect(state.orders.map(order => order.status)).toEqual(['filled', 'cancelled', 'cancelled']);
}

describe('prop risk after protective liquidation', () => {
    it.each(['buy', 'sell'] as const)('fails immediately after %s stop exit fees reach the daily loss limit', side => {
        const { state, before, candles, exit, queuedIds } = scenario(side, 'stop');
        failedAtBracket(state, 49900, 5);
        expect(state.trades[0]).toMatchObject({ side, entryPrice: ENTRY, exitPrice: exit, grossPnl: -95, fees: 5, netPnl: -100, reason: 'Stop loss' });
        expect(state.fills[1]).toMatchObject({ price: exit, reason: 'Stop loss', fees: 2.5 });
        expect(state.fills.every(fill => !queuedIds.includes(fill.orderId))).toBe(true);
        expect(before.orders.slice(1).every(order => order.status === 'working')).toBe(true);
        expect(validateStoredSession(state, candles, instrument)).toEqual(state);
    });
    it.each(['buy', 'sell'] as const)('fails immediately after %s target exit fees breach the daily loss limit', side => {
        const { state, candles, exit, queuedIds } = scenario(side, 'target');
        failedAtBracket(state, 49885, 120);
        expect(state.trades[0]).toMatchObject({ side, entryPrice: ENTRY, exitPrice: exit, grossPnl: 5, fees: 120, netPnl: -115, reason: 'Take profit' });
        expect(state.fills[1]).toMatchObject({ price: exit, reason: 'Take profit', fees: 60 });
        expect(state.fills.every(fill => !queuedIds.includes(fill.orderId))).toBe(true);
        expect(validateStoredSession(state, candles, instrument)).toEqual(state);
    });
    it.each(['buy', 'sell'] as const)('keeps queued %s entries eligible when stop liquidation remains within the daily limit', side => {
        const { state, candles, queuedIds } = scenario(side, 'stop', 200);
        expect(state.status).toBe('paused'); expect(state.prop.status).toBe('active');
        expect(state.position).toMatchObject({ side, qty: 1 }); expect(state.fills).toHaveLength(3);
        expect(state.orders.map(order => order.status)).toEqual(['filled', 'filled', 'working']);
        expect(state.fills[2]!.orderId).toBe(queuedIds[0]);
        expect(validateStoredSession(state, candles, instrument)).toEqual(state);
    });
});
