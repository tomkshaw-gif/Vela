import { describe, expect, it } from 'vitest';
import { applyCommand, createSession, validateStoredSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS, type Bar, type Command, type PropRules, type Session, type SessionConfig, type Side } from '../shared/types';

const instrument = INSTRUMENTS[0]!;
const start = Date.parse('2026-06-01T14:00:00Z');
const bar = (index: number, open = 100, high = open, low = open, close = open): Bar => ({ time: start + index * 60000, open, high, low, close, volume: 100 });
function config(extra: Partial<SessionConfig> = {}, rules: Partial<PropRules> = {}): SessionConfig {
    return { name: 'Accounting fixture', datasetId: 'fixture', mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0,
        rules: { ...DEFAULT_RULES, maxContracts: 10, ...rules }, ...extra };
}
const run = (session: Session, bars: Bar[], ...commands: Command[]): Session => commands.reduce((state, command) => applyCommand(state, bars, command), session);
const enter = (side: Side, stopLoss?: number): Command => ({ type: 'place', order: { side, type: 'market', qty: 1, ...(stopLoss === undefined ? {} : { stopLoss }) } });
const step: Command = { type: 'advance', count: 1 };

describe('source-price account marking', () => {
    it.each(['buy', 'sell'] as const)('does not turn a %s scale-in execution cost into a fictional equity peak', (side) => {
        const bars = side === 'buy' ? [bar(0), bar(1, 101), bar(2, 100.75), bar(3, 100.75)] : [bar(0), bar(1, 99), bar(2, 99.25), bar(3, 99.25)];
        const result = run(createSession(config({ slippageTicks: 1 }), instrument), bars, enter(side), step, enter(side), step, step);
        expect(result.position?.qty).toBe(2);
        expect(result.account.equity).toBe(50000);
        expect(result.account.peakEquity).toBe(50015);
        expect(result.account.maxDrawdown).toBe(15);
        expect(validateStoredSession(result, bars, instrument)).toEqual(result);
    });
    it.each(['buy', 'sell'] as const)('keeps a %s evaluation active when the actual drawdown stays below its limit', (side) => {
        const bars = side === 'buy' ? [bar(0), bar(1, 101), bar(2, 100.75), bar(3, 100.75)] : [bar(0), bar(1, 99), bar(2, 99.25), bar(3, 99.25)];
        const result = run(createSession(config({ slippageTicks: 1, mode: 'prop' }, {
            drawdownType: 'trailing-intraday', drawdownLocksAtInitialBalance: false, maxDrawdownUsd: 17, maxDailyLossUsd: 1000,
        }), instrument), bars, enter(side), step, enter(side), step, step);
        expect(result.status).toBe('paused'); expect(result.prop.status).toBe('active');
        expect(result.prop.trailingPeak).toBe(50015); expect(result.prop.drawdownFloor).toBe(49998);
        expect(result.account.maxDrawdown).toBe(15); expect(result.position?.qty).toBe(2);
    });
});

describe('excursions end when exposure is liquidated', () => {
    it.each(['buy', 'sell'] as const)('clips %s adverse excursion to a risk boundary before the candle extreme', (side) => {
        const candle = side === 'buy' ? bar(1, 100, 100, 90, 100) : bar(1, 100, 110, 100, 100);
        const bars = [bar(0), candle, bar(2)];
        const result = run(createSession(config({ mode: 'prop' }, { maxDailyLossUsd: 100, maxDrawdownUsd: 1000 }), instrument), bars, enter(side), step, step);
        expect(result.status).toBe('failed'); expect(result.account.balance).toBe(49900);
        expect(result.trades[0]).toMatchObject({ netPnl: -100, mae: 100, mfe: 0, reason: 'Prop violation' });
    });
    it.each(['buy', 'sell'] as const)('records the actual %s stop gap, without later candle prices', (side) => {
        const bars = side === 'buy' ? [bar(0), bar(1, 90, 95, 80, 92), bar(2)] : [bar(0), bar(1, 110, 120, 105, 108), bar(2)];
        const result = run(createSession(config(), instrument), bars, enter(side, side === 'buy' ? 95 : 105), step, step);
        expect(result.trades[0]).toMatchObject({ netPnl: -200, mae: 200, mfe: 0, reason: 'Stop loss' });
        expect(result.position).toBeNull(); expect(validateStoredSession(result, bars, instrument)).toEqual(result);
    });
    it.each(['buy', 'sell'] as const)('uses a %s risk gap open rather than granting a boundary-price excursion', (side) => {
        const bars = [bar(0), side === 'buy' ? bar(1, 90) : bar(1, 110), bar(2)];
        const result = run(createSession(config({ mode: 'prop' }, { maxDailyLossUsd: 100, maxDrawdownUsd: 1000 }), instrument), bars, enter(side), step, step);
        expect(result.trades[0]).toMatchObject({ netPnl: -200, mae: 200, mfe: 0 }); expect(result.account.balance).toBe(49800);
    });
    it.each(['buy', 'sell'] as const)('records favorable %s target gaps only through the liquidation open', (side) => {
        const bars = [bar(0), side === 'buy' ? bar(1, 110, 120, 90, 105) : bar(1, 90, 110, 80, 95), bar(2)];
        const order: Command = { type: 'place', order: { side, type: 'market', qty: 1, takeProfit: side === 'buy' ? 105 : 95 } };
        const result = run(createSession(config(), instrument), bars, order, step, step);
        expect(result.trades[0]).toMatchObject({ netPnl: 200, mae: 0, mfe: 200, reason: 'Take profit' });
    });
});

describe('configured spread and separate slippage', () => {
    const cases = (['buy', 'sell'] as const).flatMap((side) => [0, 1, 2, 3, 4].flatMap((spread) => [0, 1, 2].map((slippage) => ({ side, spread, slippage }))));
    it.each(cases)('charges exactly $spread spread ticks and $slippage slippage ticks per side for $side', ({ side, spread, slippage }) => {
        const bars = [bar(0), bar(1), bar(2)];
        const result = run(createSession(config({ spreadTicks: spread, slippageTicks: slippage }), instrument), bars, enter(side), step, { type: 'close' }, step);
        const expectedTicks = spread + slippage * 2;
        expect(result.trades[0]!.netPnl).toBeCloseTo(-expectedTicks * instrument.tickSize * instrument.pointValue, 8);
        const ask = 100 + (Math.ceil(spread / 2) + slippage) * instrument.tickSize;
        const bid = 100 - (Math.floor(spread / 2) + slippage) * instrument.tickSize;
        expect(result.fills.map((fill) => fill.price)).toEqual(side === 'buy' ? [ask, bid] : [bid, ask]);
        expect(validateStoredSession(result, bars, instrument)).toEqual(result);
    });
    it('preserves recorded execution history when continuing a session made with an older spread calculation', () => {
        const bars = [bar(0), bar(1), bar(2), bar(3)];
        const legacy = run(createSession(config({ spreadTicks: 2 }), instrument), bars, enter('buy'), step, { type: 'close' }, step);
        // A former one-tick spread produced these two-tick round-trip executions.
        legacy.config.spreadTicks = 1;
        const before = JSON.stringify({ fills: legacy.fills, trades: legacy.trades, account: legacy.account });
        const renamed = applyCommand(legacy, bars, { type: 'rename', name: 'Preserved historical session' });
        expect(JSON.stringify({ fills: renamed.fills, trades: renamed.trades, account: renamed.account })).toBe(before);
        expect(validateStoredSession(renamed, bars, instrument)).toEqual(renamed);
    });
});
