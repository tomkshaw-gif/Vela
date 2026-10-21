import { describe, expect, it } from 'vitest';
import { applyCommand, createSession, validateStoredSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS, type Bar, type Command, type OrderDraft, type Session, type SessionConfig, type Side } from '../shared/types';

const instrument = INSTRUMENTS[0]!;
const start = Date.parse('2026-06-01T14:00:00Z');
const sides = ['buy', 'sell'] as const;
const step: Command = { type: 'advance', count: 1 };
const direction = (side: Side): number => side === 'buy' ? 1 : -1;
const candle = (index: number, open = 100, high = open, low = open, close = open, interval = 60000): Bar => ({
    time: start + index * interval, open, high, low, close, volume: 100,
});
const config = (costs: Partial<Pick<SessionConfig, 'slippageTicks' | 'spreadTicks'>> = {}): SessionConfig => ({
    name: 'Limit execution fixture', datasetId: 'limit-fixture', mode: 'practice', initialBalance: 50000,
    commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0,
    rules: { ...DEFAULT_RULES, maxContracts: 10 }, ...costs,
});
const run = (session: Session, bars: Bar[], ...commands: Command[]): Session => commands.reduce((state, command) => applyCommand(state, bars, command), session);
const place = (side: Side, price: number, extra: Partial<OrderDraft> = {}): Command => ({
    type: 'place', order: { side, type: 'limit', qty: 1, price, ...extra },
});
const revealed = (bars: Bar[], costs: Parameters<typeof config>[0] = {}): Session => run(createSession(config(costs), instrument), bars, step);

describe('pending limit source-bar contract', () => {
    it.each(sides.flatMap(side => [1000, 60000].map(interval => ({ side, interval }))))('leaves $side limits working until an exact touch on $interval-ms source bars', ({ side, interval }) => {
        const d = direction(side);
        const price = 100 - d;
        const untouched = side === 'buy' ? candle(1, 100, 102, 99.25, 100, interval) : candle(1, 100, 100.75, 98, 100, interval);
        const touched = side === 'buy' ? candle(2, 100, 101, price, 100, interval) : candle(2, 100, price, 99, 100, interval);
        const bars = [candle(0, 100, 100, 100, 100, interval), untouched, touched, candle(3, 100, 100, 100, 100, interval)];
        const queued = run(revealed(bars), bars, place(side, price));
        const waiting = run(queued, bars, step);
        expect(waiting.cursor).toBe(1);
        expect(waiting.orders[0]).toMatchObject({ status: 'working', price, createdTime: bars[0]!.time });
        expect(waiting.fills).toHaveLength(0);
        expect(waiting.position).toBeNull();
        const filled = run(waiting, bars, step);
        expect(filled.orders[0]).toMatchObject({ status: 'filled', fillPrice: price, filledTime: touched.time });
        expect(filled.fills).toEqual([expect.objectContaining({ orderId: queued.orders[0]!.id, side, qty: 1, price, time: touched.time })]);
        expect(filled.position).toMatchObject({ side, qty: 1, avgPrice: price });
        expect(queued.orders[0]!.status).toBe('working');
        expect(validateStoredSession(filled, bars, instrument)).toEqual(filled);
    });

    it.each(sides)('admits a marketable %s limit but waits for the next source bar', side => {
        const d = direction(side);
        const price = 100 + d;
        const nextOpen = 100 + d * 0.5;
        const bars = [candle(0, 100, 110, 90), candle(1, nextOpen), candle(2)];
        const before = revealed(bars);
        const queued = run(before, bars, place(side, price));
        expect(queued.revision).toBe(before.revision + 1);
        expect(queued.cursor).toBe(0);
        expect(queued.orders[0]).toMatchObject({ status: 'working', price });
        expect(queued.fills).toHaveLength(0);
        const filled = run(queued, bars, step);
        expect(filled.fills).toEqual([expect.objectContaining({ side, price: nextOpen, time: bars[1]!.time })]);
    });

    it.each(sides)('does not carry the displayed marketability of a %s limit into a later gap', side => {
        const d = direction(side);
        const price = 100 + d;
        const away = side === 'buy' ? candle(1, 103, 104, 102, 103) : candle(1, 97, 98, 96, 97);
        const touched = side === 'buy' ? candle(2, 103, 104, price, 102) : candle(2, 97, price, 96, 98);
        const bars = [candle(0), away, touched, candle(3)];
        const queued = run(revealed(bars), bars, place(side, price));
        const waiting = run(queued, bars, step);
        expect(waiting.orders[0]!.status).toBe('working');
        expect(waiting.fills).toHaveLength(0);
        const filled = run(waiting, bars, step);
        expect(filled.fills).toEqual([expect.objectContaining({ side, price, time: touched.time })]);
    });
});

describe('limit price protection', () => {
    it.each(sides.flatMap(side => [
        { slippageTicks: 0, spreadTicks: 0, expectedBuy: 96, expectedSell: 104 },
        { slippageTicks: 1, spreadTicks: 3, expectedBuy: 96.75, expectedSell: 103.5 },
        { slippageTicks: 100, spreadTicks: 100, expectedBuy: 99, expectedSell: 101 },
    ].map(costs => ({ side, ...costs }))))('improves a $side opening-gap fill while bounding $slippageTicks slippage and $spreadTicks spread ticks', ({ side, slippageTicks, spreadTicks, expectedBuy, expectedSell }) => {
        const price = side === 'buy' ? 99 : 101;
        const gap = side === 'buy' ? 96 : 104;
        const bars = [candle(0), candle(1, gap), candle(2)];
        const filled = run(revealed(bars, { slippageTicks, spreadTicks }), bars, place(side, price), step);
        const expected = side === 'buy' ? expectedBuy : expectedSell;
        expect(filled.orders[0]).toMatchObject({ price, status: 'filled', fillPrice: expected });
        expect(filled.fills[0]).toMatchObject({ side, price: expected, time: bars[1]!.time });
        expect(filled.fills[0]!.price / instrument.tickSize).toBe(Math.round(filled.fills[0]!.price / instrument.tickSize));
        expect(validateStoredSession(filled, bars, instrument)).toEqual(filled);
    });

    it.each(sides)('fills a touched %s limit at its price despite adverse execution costs', side => {
        const price = side === 'buy' ? 99 : 101;
        const touch = side === 'buy' ? candle(1, 100, 100, price, 100) : candle(1, 100, price, 100, 100);
        const bars = [candle(0), touch, candle(2)];
        const filled = run(revealed(bars, { slippageTicks: 100, spreadTicks: 100 }), bars, place(side, price), step);
        expect(filled.fills[0]).toMatchObject({ price, side, reason: 'Limit order' });
    });

    it.each(sides)('rejects off-tick %s placement and amendment without changing the prior ledger', side => {
        const bars = [candle(0), candle(1), candle(2)];
        const before = revealed(bars);
        expect(() => run(before, bars, place(side, 99.1))).toThrow(/tick size/);
        expect(before.orders).toHaveLength(0);
        const queued = run(before, bars, place(side, side === 'buy' ? 99 : 101));
        const snapshot = structuredClone(queued);
        expect(() => run(queued, bars, { type: 'amend', orderId: queued.orders[0]!.id, price: 99.1 })).toThrow(/tick size/);
        expect(queued).toEqual(snapshot);
    });
});

describe('pending limit lifecycle', () => {
    it.each(sides)('amends a %s order at a new revision without using an already revealed touch', side => {
        const original = side === 'buy' ? 80 : 120;
        const price = side === 'buy' ? 95 : 105;
        const untouched = side === 'buy' ? candle(1, 100, 101, 96, 100) : candle(1, 100, 104, 99, 100);
        const touched = side === 'buy' ? candle(2, 100, 101, price, 100) : candle(2, 100, price, 99, 100);
        const bars = [candle(0, 100, 110, 90), untouched, touched, candle(3)];
        const queued = run(revealed(bars), bars, place(side, original));
        const orderId = queued.orders[0]!.id;
        const amended = run(queued, bars, { type: 'amend', orderId, price });
        expect(amended.revision).toBe(queued.revision + 1);
        expect(amended.orders[0]).toMatchObject({ id: orderId, price, status: 'working' });
        expect(amended.fills).toHaveLength(0);
        expect(queued.orders[0]!.price).toBe(original);
        const waiting = run(amended, bars, step);
        expect(waiting.fills).toHaveLength(0);
        const filled = run(waiting, bars, step);
        expect(filled.fills).toEqual([expect.objectContaining({ orderId, side, price, time: touched.time })]);
        expect(() => run(filled, bars, { type: 'amend', orderId, price: original })).toThrow(/working order/);
        expect(() => run(filled, bars, { type: 'cancel', orderId })).toThrow(/working order/);
    });

    it.each(sides)('cancels only the selected %s limit before a future touch', side => {
        const d = direction(side);
        const first = 100 - d;
        const second = 100 - d * 2;
        const touched = side === 'buy' ? candle(1, 100, 100, 98, 100) : candle(1, 100, 102, 100, 100);
        const bars = [candle(0), touched, candle(2)];
        const queued = run(revealed(bars), bars, place(side, first), place(side, second));
        const orderId = queued.orders[0]!.id;
        const cancelled = run(queued, bars, { type: 'cancel', orderId });
        expect(cancelled.revision).toBe(queued.revision + 1);
        expect(cancelled.orders.map(order => order.status)).toEqual(['cancelled', 'working']);
        expect(cancelled.fills).toHaveLength(0);
        const filled = run(cancelled, bars, step);
        expect(filled.orders.map(order => order.status)).toEqual(['cancelled', 'filled']);
        expect(filled.fills).toEqual([expect.objectContaining({ orderId: queued.orders[1]!.id, side, price: second })]);
        expect(() => run(cancelled, bars, { type: 'cancel', orderId })).toThrow(/working order/);
        expect(() => run(cancelled, bars, { type: 'amend', orderId, price: first })).toThrow(/working order/);
        expect(queued.orders.every(order => order.status === 'working')).toBe(true);
    });

    it.each(sides)('retains each %s limit price, quantity and identity when several orders touch', side => {
        const d = direction(side);
        const farther = 100 - d * 2;
        const nearer = 100 - d;
        const outOfReach = 100 - d * 3;
        const touched = side === 'buy' ? candle(1, 100, 101, farther, 100) : candle(1, 100, farther, 99, 100);
        const bars = [candle(0), touched, candle(2)];
        const queued = run(revealed(bars), bars, place(side, farther, { qty: 2 }), place(side, nearer), place(side, outOfReach));
        expect(new Set(queued.orders.map(order => order.id)).size).toBe(3);
        const filled = run(queued, bars, step);
        expect(filled.orders.map(order => order.status)).toEqual(['filled', 'filled', 'working']);
        expect(filled.fills).toHaveLength(2);
        expect(filled.fills).toEqual(expect.arrayContaining([
            expect.objectContaining({ orderId: queued.orders[0]!.id, qty: 2, price: farther, side }),
            expect.objectContaining({ orderId: queued.orders[1]!.id, qty: 1, price: nearer, side }),
        ]));
        expect(new Set(filled.fills.map(fill => fill.id)).size).toBe(2);
        expect(filled.position).toMatchObject({ side, qty: 3 });
        expect(filled.position!.avgPrice).toBeCloseTo((farther * 2 + nearer) / 3, 8);
        expect(validateStoredSession(filled, bars, instrument)).toEqual(filled);
    });
});

describe('passive intrabar limit priority', () => {
    it.each(sides)('executes nearer %s prices before farther prices despite reversed submission', side => {
        const d = direction(side);
        const nearer = 100 - d;
        const farther = 100 - d * 2;
        const touch = side === 'buy' ? candle(1, 100, 100, farther, farther) : candle(1, 100, farther, 100, farther);
        const bars = [candle(0), touch, candle(2)];
        const queued = run(revealed(bars), bars, place(side, farther), place(side, nearer));
        const result = run(queued, bars, step);
        expect(result.fills.map(fill => fill.orderId)).toEqual([queued.orders[1]!.id, queued.orders[0]!.id]);
        expect(result.fills.map(fill => fill.price)).toEqual([nearer, farther]);
        expect(result.orders.map(order => order.price)).toEqual([farther, nearer]);
        expect(validateStoredSession(result, bars, instrument)).toEqual(result);
    });

    it.each(sides)('preserves submission order for equal %s limit prices within price priority', side => {
        const d = direction(side);
        const nearer = 100 - d;
        const farther = 100 - d * 2;
        const touch = side === 'buy' ? candle(1, 100, 100, farther, 100) : candle(1, 100, farther, 100, 100);
        const bars = [candle(0), touch, candle(2)];
        const queued = run(revealed(bars), bars, place(side, farther), place(side, nearer), place(side, nearer, { qty: 2 }), place(side, farther, { qty: 2 }));
        const result = run(queued, bars, step);
        expect(result.fills.map(fill => fill.orderId)).toEqual([1, 2, 0, 3].map(index => queued.orders[index]!.id));
        expect(result.fills.map(fill => fill.qty)).toEqual([1, 2, 1, 2]);
        expect(result.position).toMatchObject({ side, qty: 6 });
        expect(validateStoredSession(result, bars, instrument)).toEqual(result);
    });

    it('retains the interleaved trigger slots of opposite limits and both stop directions', () => {
        const bars = [candle(0), candle(1, 100, 104, 96, 100), candle(2)];
        const queued = run(revealed(bars), bars,
            place('buy', 98),
            place('sell', 102),
            place('buy', 103, { type: 'stop' }),
            place('buy', 99),
            place('sell', 101),
            place('sell', 97, { type: 'stop' }),
            place('buy', 101, { type: 'stop' }),
            place('sell', 99, { type: 'stop' }),
        );
        const result = run(queued, bars, step);
        expect(result.fills.map(fill => fill.orderId)).toEqual([3, 4, 2, 0, 1, 5, 6, 7].map(index => queued.orders[index]!.id));
        expect(result.fills.map(fill => [fill.side, fill.reason])).toEqual([
            ['buy', 'Limit order'], ['sell', 'Limit order'], ['buy', 'Stop order'], ['buy', 'Limit order'],
            ['sell', 'Limit order'], ['sell', 'Stop order'], ['buy', 'Stop order'], ['sell', 'Stop order'],
        ]);
        expect(validateStoredSession(result, bars, instrument)).toEqual(result);
    });

    it.each(sides)('does not use an untouched %s limit slot to move later limits ahead of a stop', side => {
        const d = direction(side);
        const farther = 100 - d * 2;
        const bars = [candle(0), candle(1, 100, 102, 98, 100), candle(2)];
        const queued = run(revealed(bars), bars,
            place(side, 100 - d * 3),
            place(side, 100 + d, { type: 'stop' }),
            place(side, farther),
            place(side, 100 - d),
        );
        const result = run(queued, bars, step);
        expect(result.fills.map(fill => fill.orderId)).toEqual([1, 3, 2].map(index => queued.orders[index]!.id));
        expect(result.orders[0]!.status).toBe('working');
        expect(validateStoredSession(result, bars, instrument)).toEqual(result);
    });

    it.each(sides)('retains submission order for %s limits executable at the open', side => {
        const d = direction(side);
        const bars = [candle(0), candle(1), candle(2)];
        const queued = run(revealed(bars), bars, place(side, 100 + d), place(side, 100 + d * 2));
        const result = run(queued, bars, step);
        expect(result.fills.map(fill => fill.orderId)).toEqual(queued.orders.map(order => order.id));
        expect(result.fills.map(fill => fill.price)).toEqual([100, 100]);
        expect(validateStoredSession(result, bars, instrument)).toEqual(result);
    });

    it.each(sides)('executes a nearer %s entry and its protective stop before the farther entry', side => {
        const d = direction(side);
        const nearer = 100 - d;
        const farther = 100 - d * 2;
        const stopLoss = nearer - d * 0.25;
        const touch = side === 'buy' ? candle(1, 100, 100, farther, farther) : candle(1, 100, farther, 100, farther);
        const bars = [candle(0), touch, candle(2)];
        const queued = run(revealed(bars), bars, place(side, farther), place(side, nearer, { stopLoss }));
        const result = run(queued, bars, step);
        expect(result.fills.map(fill => fill.reason)).toEqual(['Limit order', 'Stop loss', 'Limit order']);
        expect(result.fills[0]!.orderId).toBe(queued.orders[1]!.id);
        expect(result.fills[2]!.orderId).toBe(queued.orders[0]!.id);
        expect(result.trades).toEqual([expect.objectContaining({ side, qty: 1, entryPrice: nearer, exitPrice: stopLoss, netPnl: -5 })]);
        expect(result.position).toMatchObject({ side, qty: 1, avgPrice: farther });
        expect(validateStoredSession(result, bars, instrument)).toEqual(result);
    });

    it.each(sides)('cancels the farther %s entry when risk is breached before that price', side => {
        const d = direction(side);
        const nearer = 100 - d;
        const farther = 100 - d * 2;
        const touch = side === 'buy' ? candle(1, 100, 100, farther, farther) : candle(1, 100, farther, 100, farther);
        const bars = [candle(0), touch, candle(2)];
        const settings = config();
        const initial = createSession({ ...settings, mode: 'prop', rules: { ...settings.rules, maxDailyLossUsd: 15, maxDrawdownUsd: 1000 } }, instrument);
        const queued = run(initial, bars, step, place(side, farther), place(side, nearer));
        const result = run(queued, bars, step);
        expect(result.status).toBe('failed');
        expect(result.prop.reason).toBe('Maximum daily loss breached');
        expect(result.orders.map(order => order.status)).toEqual(['cancelled', 'filled']);
        expect(result.fills).toHaveLength(2);
        expect(result.fills[0]!.orderId).toBe(queued.orders[1]!.id);
        expect(result.trades).toEqual([expect.objectContaining({ side, qty: 1, entryPrice: nearer, exitPrice: nearer - d * 0.75, netPnl: -15, reason: 'Prop violation' })]);
        expect(result.position).toBeNull();
        expect(result.account.balance).toBe(49985);
        expect(validateStoredSession(result, bars, instrument)).toEqual(result);
    });
});

describe('protective exits for limit entries', () => {
    it.each(sides)('uses the conservative stop first after an intrabar %s entry touches both exits', side => {
        const d = direction(side);
        const price = 100 - d;
        const stopLoss = price - d;
        const takeProfit = price + d * 2;
        const bars = [candle(0), candle(1, 100, 103, 97, 100), candle(2)];
        const result = run(revealed(bars), bars, place(side, price, { stopLoss, takeProfit }), step);
        expect(result.fills).toHaveLength(2);
        expect(result.trades).toEqual([expect.objectContaining({ side, entryPrice: price, exitPrice: stopLoss, reason: 'Stop loss' })]);
        expect(result.position).toBeNull();
        expect(validateStoredSession(result, bars, instrument)).toEqual(result);
    });

    it.each(sides)('protects the %s take-profit limit from costs larger than its favorable opening gap', side => {
        const d = direction(side);
        const price = 100 - d;
        const takeProfit = price + d * 3;
        const gap = takeProfit + d * 3;
        const bars = [candle(0), candle(1, price), candle(2, gap), candle(3)];
        const entered = run(revealed(bars, { slippageTicks: 100, spreadTicks: 100 }), bars, place(side, price, { takeProfit }), step);
        expect(entered.position).toMatchObject({ side, avgPrice: price, takeProfit });
        const exited = run(entered, bars, step);
        expect(exited.trades).toEqual([expect.objectContaining({ side, entryPrice: price, exitPrice: takeProfit, reason: 'Take profit' })]);
        expect(exited.position).toBeNull();
        expect(validateStoredSession(exited, bars, instrument)).toEqual(exited);
    });
});
