import { describe, expect, it } from 'vitest';
import { analytics, applyCommand, createSession, monteCarlo, validateSessionConfig, validateStoredSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS } from '../shared/types';
import type { Bar, Command, PropRules, Session, SessionConfig } from '../shared/types';

const instrument = INSTRUMENTS[0]!;
const baseTime = Date.parse('2026-06-01T14:00:00Z');
const bar = (index: number, open = 100, high = open, low = open, close = open): Bar => ({ time: baseTime + index * 60000, open, high, low, close, volume: 100 });
const config = (extra: Partial<SessionConfig> = {}, rules: Partial<PropRules> = {}): SessionConfig => ({ name: 'Practice', datasetId: 'data-1', mode: 'practice', initialBalance: 50000, commissionPerContractSide: 1.23, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES, maxContracts: 10, ...rules }, ...extra });
const run = (session: Session, bars: Bar[], ...commands: Command[]): Session => commands.reduce((s, command) => applyCommand(s, bars, command), session);
const buy: Command = { type: 'place', order: { side: 'buy', type: 'market', qty: 1 } };

describe('futures execution', () => {
    it('uses point economics, next-bar execution, per-side cents, and never mutates prior state', () => {
        const bars = [bar(0), bar(1, 101), bar(2, 103), bar(3, 104)];
        const initial = createSession(config(), instrument, 'roundtrip');
        const queued = applyCommand(initial, bars, buy);
        expect(initial.orders).toHaveLength(0);
        expect(queued.fills).toHaveLength(0);
        const entered = run(queued, bars, { type: 'advance', count: 1 });
        expect(entered.position?.avgPrice).toBe(100);
        const closed = run(entered, bars, { type: 'close' }, { type: 'advance', count: 1 });
        expect(closed.trades[0]).toMatchObject({ grossPnl: 20, fees: 2.46, netPnl: 17.54 });
        expect(closed.account.balance).toBe(50017.54);
        expect(closed.account.fees).toBe(2.46);
        expect(validateStoredSession(closed, bars, instrument)).toEqual(closed);
    });
    it('cannot fill on a candle already revealed', () => {
        const bars = [bar(0, 100, 110, 90), bar(1, 105), bar(2, 104)];
        const s = run(createSession(config(), instrument), bars, { type: 'advance', count: 1 }, { type: 'place', order: { side: 'buy', type: 'limit', qty: 1, price: 95 } }, { type: 'advance', count: 1 });
        expect(s.position).toBeNull(); expect(s.orders[0]?.status).toBe('working');
    });
    it('handles adverse stop gaps, favorable limit gaps, and price protection', () => {
        const bars = [bar(0), bar(1, 105), bar(2), bar(3)];
        const stopped = run(createSession(config({ slippageTicks: 1, spreadTicks: 2 }), instrument), bars,
            { type: 'advance', count: 1 }, { type: 'place', order: { side: 'buy', type: 'stop', qty: 1, price: 102 } }, { type: 'advance', count: 1 });
        expect(stopped.fills[0]?.price).toBe(105.5);
        const limited = run(createSession(config({ slippageTicks: 10 }), instrument), bars,
            { type: 'advance', count: 1 }, { type: 'place', order: { side: 'sell', type: 'limit', qty: 1, price: 102 } }, { type: 'advance', count: 1 });
        expect(limited.fills[0]?.price).toBe(102.5);
    });
    it('resolves an ambiguous bracket stop first and removes both exits', () => {
        const bars = [bar(0), bar(1, 100, 103, 97, 101), bar(2), bar(3)];
        const s = run(createSession(config(), instrument), bars,
            { type: 'advance', count: 1 }, { type: 'place', order: { side: 'buy', type: 'market', qty: 1, stopLoss: 98, takeProfit: 102 } }, { type: 'advance', count: 1 });
        expect(s.trades).toHaveLength(1); expect(s.trades[0]).toMatchObject({ exitPrice: 98, reason: 'Stop loss' }); expect(s.position).toBeNull();
        const later = applyCommand(s, bars, { type: 'advance', count: 1 }); expect(later.trades).toHaveLength(1);
    });
    it('gaps through a protective stop at the open, and queued close cannot reopen', () => {
        const bars = [bar(0), bar(1, 95), bar(2), bar(3)];
        const s = run(createSession(config(), instrument), bars, { type: 'place', order: { side: 'buy', type: 'market', qty: 1, stopLoss: 98 } }, { type: 'advance', count: 1 }, { type: 'close' }, { type: 'advance', count: 1 });
        expect(s.trades[0]?.exitPrice).toBe(95); expect(s.position).toBeNull(); expect(s.fills).toHaveLength(2); expect(s.orders[1]?.status).toBe('cancelled');
    });
    it('scales, partially closes, and reverses with exact fee allocation', () => {
        const bars = [bar(0), bar(1, 102), bar(2, 104), bar(3, 103), bar(4, 102), bar(5)];
        let s = run(createSession(config(), instrument), bars, { type: 'place', order: { side: 'buy', type: 'market', qty: 2 } }, { type: 'advance', count: 1 }, buy, { type: 'advance', count: 1 });
        expect(s.position?.qty).toBe(3); expect(s.position?.avgPrice).toBeCloseTo(100 + 2 / 3);
        s = run(s, bars, { type: 'close', qty: 1 }, { type: 'advance', count: 1 });
        expect(s.position?.qty).toBe(2); expect(s.trades[0]?.fees).toBe(2.46); expect(s.position?.entryFees).toBe(2.46);
        s = run(s, bars, { type: 'reverse' }, { type: 'advance', count: 1 });
        expect(s.position).toMatchObject({ qty: 2, side: 'sell', avgPrice: 103, entryFees: 2.46 });
        s = run(s, bars, { type: 'close' }, { type: 'advance', count: 1 });
        expect(s.position).toBeNull(); expect(s.account.fees).toBe(12.3);
        expect(s.trades.reduce((sum, t) => sum + t.fees, 0)).toBeCloseTo(s.account.fees);
        expect(validateStoredSession(s, bars, instrument).account.balance).toBe(s.account.balance);
    });
    it('does not turn a reverse into a new double-sized entry after a gap stop', () => {
        const bars = [bar(0), bar(1, 90), bar(2)];
        const s = run(createSession(config(), instrument), bars, { type: 'place', order: { side: 'buy', type: 'market', qty: 1, stopLoss: 98 } }, { type: 'advance', count: 1 }, { type: 'reverse' }, { type: 'advance', count: 1 });
        expect(s.position).toBeNull(); expect(s.fills).toHaveLength(2);
    });
    it('supports short bracket economics', () => {
        const bars = [bar(0), bar(1, 100, 101, 95), bar(2)];
        const s = run(createSession(config(), instrument), bars, { type: 'advance', count: 1 }, { type: 'place', order: { side: 'sell', type: 'market', qty: 2, stopLoss: 102, takeProfit: 96 } }, { type: 'advance', count: 1 });
        expect(s.trades[0]).toMatchObject({ side: 'sell', grossPnl: 160, netPnl: 155.08 });
    });
    it.each([
        { side: 'buy', type: 'limit', price: 95, takeProfit: 98, candle: bar(1, 100, 110, 90, 105), exit: 98, reason: 'Take profit' },
        { side: 'sell', type: 'limit', price: 105, takeProfit: 102, candle: bar(1, 100, 110, 90, 95), exit: 102, reason: 'Take profit' },
        { side: 'buy', type: 'stop', price: 105, stopLoss: 104, candle: bar(1, 100, 110, 99, 106), exit: 104, reason: 'Stop loss' },
        { side: 'sell', type: 'stop', price: 95, stopLoss: 96, candle: bar(1, 100, 101, 90, 94), exit: 96, reason: 'Stop loss' },
    ] as const)('does not treat the pre-entry candle open as an exit gap for $side $type', scenario => {
        const bars = [bar(0), scenario.candle, bar(2)];
        const order = { side: scenario.side, type: scenario.type, qty: 1, price: scenario.price, ...('stopLoss' in scenario ? { stopLoss: scenario.stopLoss } : { takeProfit: scenario.takeProfit }) };
        const s = run(createSession(config({ commissionPerContractSide: 0 }), instrument), bars, { type: 'advance', count: 1 }, { type: 'place', order }, { type: 'advance', count: 1 });
        expect(s.trades[0]).toMatchObject({ entryPrice: scenario.price, exitPrice: scenario.exit, reason: scenario.reason });
        expect(s.position).toBeNull();
        expect(validateStoredSession(s, bars, instrument)).toEqual(s);
    });
});

describe('prop evaluation', () => {
    it('breaches daily floating loss intrabar, cancels orders, flattens, and freezes execution', () => {
        const bars = [bar(0), bar(1, 100, 101, 90, 100), bar(2)];
        const initial = createSession(config({ mode: 'prop', commissionPerContractSide: 0 }, { maxDailyLossUsd: 100, maxDrawdownUsd: 1000 }), instrument);
        const s = run(initial, bars, { type: 'advance', count: 1 }, buy, { type: 'place', order: { side: 'buy', type: 'limit', qty: 1, price: 80 } }, { type: 'advance', count: 1 });
        expect(s.status).toBe('failed'); expect(s.prop.reason).toMatch(/daily/); expect(s.position).toBeNull(); expect(s.account.balance).toBe(49900); expect(s.orders[1]?.status).toBe('cancelled');
        expect(() => applyCommand(s, bars, buy)).toThrow(/finished/);
        const named = applyCommand(s, bars, { type: 'rename', name: 'Saved failed attempt' }); expect(named.status).toBe('failed');
    });
    it('a protective stop can prevent a lower prop boundary from being touched', () => {
        const bars = [bar(0), bar(1, 100, 101, 80), bar(2)];
        const s = run(createSession(config({ mode: 'prop', commissionPerContractSide: 0 }, { maxDailyLossUsd: 100 }), instrument), bars, { type: 'advance', count: 1 }, { type: 'place', order: { side: 'buy', type: 'market', qty: 1, stopLoss: 98 } }, { type: 'advance', count: 1 });
        expect(s.status).toBe('paused'); expect(s.account.balance).toBe(49960);
    });
    it('fails a gap at the gap open rather than granting a fictional boundary fill', () => {
        const bars = [bar(0), bar(1, 80), bar(2)];
        const s = run(createSession(config({ mode: 'prop', commissionPerContractSide: 0 }, { maxDailyLossUsd: 100 }), instrument), bars, buy, { type: 'advance', count: 1 }, { type: 'advance', count: 1 });
        expect(s.account.balance).toBe(49600); expect(s.trades[0]?.exitPrice).toBe(80);
    });
    it('raises and locks an intraday trailing floor and checks a permitted high-to-low path', () => {
        const bars = [bar(0), bar(1, 100, 110, 99, 108), bar(2)];
        const s = run(createSession(config({ mode: 'prop', commissionPerContractSide: 0 }, { drawdownType: 'trailing-intraday', maxDrawdownUsd: 100, maxDailyLossUsd: 1000 }), instrument), bars, { type: 'advance', count: 1 }, buy, { type: 'advance', count: 1 });
        expect(s.prop.drawdownFloor).toBe(50000); expect(s.status).toBe('failed'); expect(s.account.balance).toBe(50000);
    });
    it('trails only realized end-of-day balance for the EOD model', () => {
        const bars = [bar(0), bar(1, 110), { ...bar(2, 110), time: Date.parse('2026-06-01T23:00:00Z') }, { ...bar(3, 110), time: Date.parse('2026-06-02T00:00:00Z') }];
        const s = run(createSession(config({ mode: 'prop', commissionPerContractSide: 0 }, { drawdownType: 'trailing-eod', maxDrawdownUsd: 100 }), instrument), bars, buy, { type: 'advance', count: 1 }, { type: 'close' }, { type: 'advance', count: 1 }, { type: 'advance', count: 1 });
        expect(s.account.balance).toBe(50200); expect(s.prop.trailingPeak).toBe(50200); expect(s.prop.drawdownFloor).toBe(50000);
    });
    it('uses the reset-zone calendar across DST instead of subtracting 24-hour offsets', () => {
        const times = ['2026-03-07T22:59:00Z', '2026-03-07T23:00:00Z', '2026-03-08T21:59:00Z', '2026-03-08T22:00:00Z', '2026-03-08T22:01:00Z'];
        const bars = times.map((time, i) => ({ ...bar(i), time: Date.parse(time) }));
        const s = run(createSession(config(), instrument), bars, { type: 'advance', count: 4 });
        expect(s.days.map(d => d.day)).toEqual(['2026-03-06', '2026-03-07', '2026-03-08']);
    });
    it('requires minimum trading days and a flat account, then passes only at a realized target', () => {
        const bars = [bar(0), bar(1, 110), bar(2, 110), bar(3)];
        let s = run(createSession(config({ mode: 'prop', commissionPerContractSide: 0 }, { profitTargetUsd: 100, minTradingDays: 1 }), instrument), bars, buy, { type: 'advance', count: 2 });
        expect(s.status).toBe('paused'); expect(s.account.netPnl).toBe(200);
        s = run(s, bars, { type: 'close' }, { type: 'advance', count: 1 }); expect(s.status).toBe('passed'); expect(s.position).toBeNull();
    });
    it('blocks one-day windfalls when a consistency limit applies', () => {
        const bars = [bar(0), bar(1, 110), bar(2, 110), bar(3)];
        const s = run(createSession(config({ mode: 'prop', commissionPerContractSide: 0 }, { profitTargetUsd: 100, minTradingDays: 1, consistencyPct: 50 }), instrument), bars, buy, { type: 'advance', count: 1 }, { type: 'close' }, { type: 'advance', count: 1 });
        expect(s.prop.consistencyPct).toBe(100); expect(s.status).toBe('paused');
    });
    it('resets floating-loss accounting to the new cash balance at the local reset', () => {
        const times = ['2026-06-01T20:00:00Z', '2026-06-01T20:01:00Z', '2026-06-01T23:00:00Z', '2026-06-01T23:01:00Z', '2026-06-01T23:02:00Z'];
        const bars = [100, 96, 96, 92, 92].map((price, i) => ({ ...bar(i, price), time: Date.parse(times[i]!) }));
        const s = run(createSession(config({ mode: 'prop', commissionPerContractSide: 0 }, { maxDailyLossUsd: 100 }), instrument), bars,
            buy, { type: 'advance', count: 1 }, { type: 'close' }, { type: 'advance', count: 1 }, buy, { type: 'advance', count: 1 }, { type: 'close' }, { type: 'advance', count: 1 });
        expect(s.status).toBe('paused'); expect(s.account.netPnl).toBe(-160); expect(s.prop.dailyLoss).toBe(80); expect(s.days.map(d => d.realizedPnl)).toEqual([-80, -80]);
    });
    it('satisfies minimum trading days and consistency only after a second balanced trading day', () => {
        const times = ['2026-06-01T20:00:00Z', '2026-06-01T20:01:00Z', '2026-06-01T23:00:00Z', '2026-06-01T23:01:00Z', '2026-06-01T23:02:00Z'];
        const bars = [100, 105, 105, 110, 110].map((price, i) => ({ ...bar(i, price), time: Date.parse(times[i]!) }));
        let s = run(createSession(config({ mode: 'prop', commissionPerContractSide: 0 }, { profitTargetUsd: 100, minTradingDays: 2, consistencyPct: 50 }), instrument), bars,
            buy, { type: 'advance', count: 1 }, { type: 'close' }, { type: 'advance', count: 1 });
        expect(s.status).toBe('paused'); expect(s.prop.tradingDays).toBe(1);
        s = run(s, bars, buy, { type: 'advance', count: 1 }, { type: 'close' }, { type: 'advance', count: 1 });
        expect(s.status).toBe('passed'); expect(s.prop.tradingDays).toBe(2); expect(s.prop.consistencyPct).toBe(50);
    });
    it.each(['buy', 'sell'] as const)('fails after profit-target liquidation fees breach the intraday floor for %s', side => {
        const second = side === 'buy' ? bar(1, 101, 101, 100.75, 100.75) : bar(1, 99, 99.25, 99, 99.25);
        const bars = [bar(0), second, bar(2)];
        const s = run(createSession(config({ mode: 'prop', commissionPerContractSide: 6 }, { maxDrawdownUsd: 10, maxDailyLossUsd: 1000, profitTargetUsd: 1, minTradingDays: 0, requireFlatToPass: false, drawdownType: 'trailing-intraday', drawdownLocksAtInitialBalance: false }), instrument), bars,
            { type: 'place', order: { side, type: 'market', qty: 1 } }, { type: 'advance', count: 1 }, { type: 'advance', count: 1 });
        expect(s.account.balance).toBe(50003); expect(s.prop.drawdownFloor).toBe(50004);
        expect(s.status).toBe('failed'); expect(s.prop.status).toBe('failed'); expect(s.prop.reason).toBe('Maximum drawdown breached'); expect(s.position).toBeNull();
        expect(s.fills).toHaveLength(2); expect(validateStoredSession(s, bars, instrument)).toEqual(s);
    });
});

describe('validation and bounds', () => {
    it('rejects invalid ticks, sizes, brackets, amendments and contingent exposure atomically', () => {
        const bars = [bar(0), bar(1), bar(2)]; const s = createSession(config({}, { maxContracts: 1 }), instrument);
        for (const order of [ { side: 'buy', type: 'limit', qty: 1, price: 100.1 }, { side: 'buy', type: 'market', qty: 0 }, { side: 'buy', type: 'market', qty: 2 } ]) expect(() => applyCommand(s, bars, { type: 'place', order } as Command)).toThrow();
        const queued = applyCommand(s, bars, buy); expect(() => applyCommand(queued, bars, buy)).toThrow(/contract/);
        expect(() => applyCommand(queued, bars, { type: 'amend', orderId: queued.orders[0]!.id, price: 100 })).toThrow(/market/);
        expect(() => applyCommand(s, bars, { type: 'place', order: { side: 'buy', type: 'limit', qty: 1, price: 100, stopLoss: 101 } })).toThrow(/loss side/);
        expect(s.orders).toHaveLength(0);
    });
    it('validates timezone, finite settings, identifiers and JSON-safe layouts', () => {
        expect(() => validateSessionConfig(config({ initialBalance: NaN }))).toThrow();
        expect(() => validateSessionConfig(config({}, { dayResetTimezone: 'Not/AZone' }))).toThrow();
        expect(() => createSession(config(), instrument, '../unsafe')).toThrow(/ID/);
        const bars = [bar(0), bar(1)]; const s = createSession(config(), instrument);
        const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
        expect(() => applyCommand(s, bars, { type: 'layout', layout: cyclic })).toThrow(/deeply/);
        expect(() => applyCommand(s, bars, { type: 'layout', layout: { scale: Infinity } })).toThrow();
    });
    it('removes order brackets with an explicit null amendment', () => {
        const bars = [bar(0), bar(1), bar(2)];
        let s = run(createSession(config(), instrument), bars, { type: 'advance', count: 1 }, { type: 'place', order: { side: 'buy', type: 'limit', qty: 1, price: 99, stopLoss: 98, takeProfit: 102 } });
        s = applyCommand(s, bars, { type: 'amend', orderId: s.orders[0]!.id, stopLoss: null, takeProfit: null });
        expect(s.orders[0]?.stopLoss).toBeUndefined(); expect(s.orders[0]?.takeProfit).toBeUndefined();
    });
    it('caps forward advancement, forbids backward seek and checks every intermediate bar', () => {
        const bars = Array.from({ length: 5010 }, (_, i) => bar(i));
        let s = createSession(config(), instrument);
        expect(() => applyCommand(s, bars, { type: 'advance', count: 5001 })).toThrow();
        s = applyCommand(s, bars, { type: 'advanceTo', time: bars.at(-1)!.time }); expect(s.cursor).toBe(4999);
        expect(() => applyCommand(s, bars, { type: 'advanceTo', time: bars[1]!.time })).toThrow(/forward/);
        const lossBars = [bar(0), bar(1, 100, 100, 90), bar(2, 110)];
        const risk = run(createSession(config({ mode: 'prop', commissionPerContractSide: 0 }, { maxDailyLossUsd: 100 }), instrument), lossBars, buy, { type: 'advanceTo', time: lossBars.at(-1)!.time });
        expect(risk.status).toBe('failed'); expect(risk.cursor).toBe(1);
    });
    it('bounds the equity curve and keeps independently accumulated risk statistics', () => {
        const bars = Array.from({ length: 12000 }, (_, i) => bar(i));
        const s = run(createSession(config(), instrument), bars, { type: 'advance', count: 5000 }, { type: 'advance', count: 5000 }, { type: 'advance', count: 1500 });
        expect(s.equityCurve.length).toBeLessThanOrEqual(10000); expect(s.equityCurve[0]?.time).toBe(bars[0]!.time); expect(s.equityCurve.at(-1)?.time).toBe(bars[11499]!.time);
    });
    it('rejects nonreconciling or future-filled persisted state and preserves terminal attempts', () => {
        const bars = [bar(0), bar(1)]; const s = run(createSession(config(), instrument), bars, buy, { type: 'advance', count: 2 });
        expect(s.status).toBe('completed'); expect(s.position).toBeNull();
        const corrupt = structuredClone(s); corrupt.account.balance += 1;
        expect(() => validateStoredSession(corrupt, bars, instrument)).toThrow(/reconcile/);
        const future = structuredClone(s); future.fills[0]!.time = bars[1]!.time + 1;
        expect(() => validateStoredSession(future, bars, instrument)).toThrow(/time/);
        const allocation = structuredClone(s); allocation.trades[0]!.fees = 0; allocation.trades[0]!.netPnl = allocation.trades[0]!.grossPnl;
        expect(() => validateStoredSession(allocation, bars, instrument)).toThrow(/cost basis/);
        expect(() => applyCommand(s, bars, { type: 'advance', count: 1 })).toThrow(/finished/);
    });
});

describe('performance analysis', () => {
    it('guards empty samples and deterministically bootstraps net trades with a seed', () => {
        const empty = createSession(config(), instrument);
        expect(analytics(empty)).toMatchObject({ trades: 0, winRate: null, expectancy: null, avgR: null, profitFactor: null });
        expect(monteCarlo(empty)).toMatchObject({ runs: 0, medianFinalBalance: 50000, probabilityOfProfit: 0 });
        const bars = [bar(0), bar(1, 102), bar(2, 100), bar(3, 99), bar(4, 100), bar(5)];
        const s = run(empty, bars, buy, { type: 'advance', count: 1 }, { type: 'close' }, { type: 'advance', count: 1 }, buy, { type: 'advance', count: 1 }, { type: 'close' }, { type: 'advance', count: 1 });
        const a = analytics(s); expect(a).toMatchObject({ trades: 2, wins: 1, losses: 1, winRate: 0.5 });
        expect(a.netPnl).toBeCloseTo(s.trades.reduce((sum, t) => sum + t.netPnl, 0));
        const options = { runs: 100, tradesPerRun: 10, seed: 123 };
        expect(monteCarlo(s, options)).toEqual(monteCarlo(s, options));
        expect(monteCarlo(s, options)).not.toEqual(monteCarlo(s, { ...options, seed: 124 }));
        expect(() => monteCarlo(s, { runs: 5000, tradesPerRun: 5000 })).toThrow(/limited/);
    });
    it('defines ruin as depletion of the account rather than crossing a prop drawdown proxy', () => {
        const losing = (entry: number, exit: number): Session => {
            const bars = [bar(0, entry), bar(1, exit), bar(2, exit)];
            return run(createSession(config({ commissionPerContractSide: 0 }), instrument), bars, buy, { type: 'advance', count: 1 }, { type: 'close' }, { type: 'advance', count: 1 });
        };
        expect(monteCarlo(losing(1000, 850), { runs: 10, tradesPerRun: 1 })).toMatchObject({ medianFinalBalance: 47000, probabilityOfRuin: 0 });
        expect(monteCarlo(losing(2600, 100), { runs: 10, tradesPerRun: 1 })).toMatchObject({ medianFinalBalance: 0, probabilityOfRuin: 1 });
    });
});
