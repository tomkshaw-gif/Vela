import { describe, expect, it } from 'vitest';
import { runReplayJump } from '../client/replay-jump';
import { applyCommand, createSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS } from '../shared/types';
import type { Bar, Session, SessionConfig } from '../shared/types';

const instrument = INSTRUMENTS[0]!;
const bar = (index: number, open = 100, high = open, low = open, close = open): Bar => ({
    time: Date.parse('2024-04-08T00:00:00Z') + index * 60000, open, high, low, close, volume: 10,
});
const config = (extra: Partial<SessionConfig> = {}): SessionConfig => ({
    name: 'Jump test', datasetId: 'jump-data', mode: 'practice', initialBalance: 50000,
    commissionPerContractSide: 1.25, slippageTicks: 0, spreadTicks: 0, startIndex: 0,
    rules: { ...DEFAULT_RULES }, ...extra,
});
function runner(initial: Session, bars: Bar[]) {
    let session = initial;
    const counts: number[] = [];
    return {
        current: () => session,
        shouldStop: () => false,
        advance: async (count: number) => { counts.push(count); session = applyCommand(session, bars, { type: 'advance', count }); },
        counts,
    };
}
function ledger(session: Session) {
    return {
        cursor: session.cursor, status: session.status, account: session.account, position: session.position,
        orders: session.orders, days: session.days, prop: session.prop, equityCurve: session.equityCurve,
        // IDs encode command revisions, while the financial ledger must be independent of chunk size.
        fills: session.fills.map(({ id: _id, orderId: _orderId, ...fill }) => fill),
        trades: session.trades.map(({ id: _id, ...trade }) => trade),
    };
}

describe('replay jump orchestration', () => {
    it('matches single-bar replay through a pending entry and protective exit, including fees and risk statistics', async () => {
        const bars = [bar(0), bar(1), bar(2, 100, 100, 98, 99), bar(3, 99), bar(4, 99, 102, 99, 101), ...Array.from({ length: 10 }, (_, i) => bar(i + 5))];
        const revealed = applyCommand(createSession(config(), instrument, 'jump-ledger'), bars, { type: 'advance', count: 1 });
        const initial = applyCommand(revealed, bars, { type: 'place', order: { side: 'buy', type: 'limit', qty: 1, price: 99, stopLoss: 97, takeProfit: 102 } });
        const jump = runner(initial, bars);
        expect(await runReplayJump(12, jump)).toBe('reached');
        let manual = initial;
        while (manual.cursor < 12) manual = applyCommand(manual, bars, { type: 'advance', count: 1 });
        expect(ledger(jump.current())).toEqual(ledger(manual));
        expect(jump.current().trades[0]).toMatchObject({ entryPrice: 99, exitPrice: 102, fees: 2.5, netPnl: 57.5, reason: 'Take profit' });
        expect(jump.current().position).toBeNull();
    });

    it('spans more than 5,000 bars with bounded commands and reports each persisted cursor', async () => {
        const bars = Array.from({ length: 6004 }, (_, i) => bar(i));
        const jump = runner(createSession(config(), instrument, 'jump-long'), bars);
        const progress: number[] = [];
        expect(await runReplayJump(6002, { ...jump, progress: cursor => progress.push(cursor) })).toBe('reached');
        expect(jump.counts).toEqual([5000, 1003]);
        expect(progress).toEqual([4999, 6002]);
        expect(jump.current().cursor).toBe(6002);
        expect(jump.current().status).toBe('paused');
        expect(jump.current().equityCurve).toHaveLength(6003);
    });

    it('stops before the target when an intervening bar breaches prop risk', async () => {
        const bars = [bar(0), bar(1, 100, 100, 90), bar(2), bar(3), bar(4)];
        const prop = createSession(config({ mode: 'prop', commissionPerContractSide: 0, rules: { ...DEFAULT_RULES, maxDailyLossUsd: 100 } }), instrument, 'jump-risk');
        const initial = applyCommand(prop, bars, { type: 'place', order: { side: 'buy', type: 'market', qty: 1 } });
        const jump = runner(initial, bars);
        expect(await runReplayJump(4, jump)).toBe('stopped');
        expect(jump.counts).toEqual([5]);
        expect(jump.current()).toMatchObject({ cursor: 1, status: 'failed', position: null, account: { balance: 49900 } });
        expect(jump.current().trades[0]?.reason).toBe('Prop violation');
        expect(jump.current().prop.reason).toBe('Maximum daily loss breached');
    });

    it('stops before the target when a queued close passes an evaluation', async () => {
        const bars = [bar(0), bar(1, 110), bar(2), bar(3), bar(4)];
        let initial = createSession(config({ mode: 'prop', commissionPerContractSide: 0, rules: { ...DEFAULT_RULES, profitTargetUsd: 100, minTradingDays: 1 } }), instrument, 'jump-pass');
        initial = applyCommand(initial, bars, { type: 'place', order: { side: 'buy', type: 'market', qty: 1 } });
        initial = applyCommand(initial, bars, { type: 'advance', count: 1 });
        initial = applyCommand(initial, bars, { type: 'close' });
        const jump = runner(initial, bars);
        expect(await runReplayJump(4, jump)).toBe('stopped');
        expect(jump.current()).toMatchObject({ cursor: 1, status: 'passed', position: null, account: { balance: 50200 } });
        expect(jump.counts).toEqual([4]);
    });

    it('reports reaching the final bar even though replay completes there', async () => {
        const bars = [bar(0), bar(1), bar(2)];
        const jump = runner(createSession(config(), instrument, 'jump-final'), bars);
        expect(await runReplayJump(2, jump)).toBe('reached');
        expect(jump.current()).toMatchObject({ cursor: 2, status: 'completed' });
    });

    it('yields between chunks so cancellation can stop after the first completed command', async () => {
        const bars = Array.from({ length: 6004 }, (_, i) => bar(i));
        const jump = runner(createSession(config(), instrument, 'jump-cancel'), bars);
        let stopped = false;
        expect(await runReplayJump(6002, { ...jump, shouldStop: () => stopped, progress: () => { setTimeout(() => { stopped = true; }, 0); } })).toBe('stopped');
        expect(jump.counts).toEqual([5000]);
        expect(jump.current().cursor).toBe(4999);
    });

    it('does not issue a command when cancellation is already requested', async () => {
        const jump = runner(createSession(config(), instrument), [bar(0), bar(1)]);
        expect(await runReplayJump(1, { ...jump, shouldStop: () => true })).toBe('stopped');
        expect(jump.counts).toEqual([]);
    });

    it.each(['completed', 'failed', 'passed'] as const)('does not advance an already %s session', async status => {
        let calls = 0;
        expect(await runReplayJump(10, { current: () => ({ cursor: 1, status }), advance: async () => { calls++; }, shouldStop: () => false })).toBe('stopped');
        expect(calls).toBe(0);
    });

    it('does not issue a command when the target has already been reached', async () => {
        let calls = 0;
        expect(await runReplayJump(0, { current: () => ({ cursor: 0, status: 'paused' }), advance: async () => { calls++; }, shouldStop: () => false })).toBe('reached');
        expect(calls).toBe(0);
    });

    it.each([NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid target %s before issuing a command', async target => {
        let calls = 0;
        await expect(runReplayJump(target, { current: () => ({ cursor: -1, status: 'paused' }), advance: async () => { calls++; }, shouldStop: () => false })).rejects.toThrow(/nonnegative integer/);
        expect(calls).toBe(0);
    });

    it.each(['Command rejected', 'Network connection lost'])('propagates %s and preserves the preceding successful chunk', async message => {
        const bars = Array.from({ length: 6004 }, (_, i) => bar(i));
        const jump = runner(createSession(config(), instrument, 'jump-error'), bars);
        let calls = 0;
        const failure = new Error(message);
        await expect(runReplayJump(6002, { ...jump, advance: async count => { if (++calls === 2) throw failure; await jump.advance(count); } })).rejects.toBe(failure);
        expect(calls).toBe(2);
        expect(jump.current().cursor).toBe(4999);
        expect(jump.current().status).toBe('paused');
    });

    it('rejects a response that made no progress instead of retrying forever', async () => {
        let calls = 0;
        await expect(runReplayJump(10, { current: () => ({ cursor: 1, status: 'paused' }), advance: async () => { calls++; }, shouldStop: () => false })).rejects.toThrow(/did not advance/);
        expect(calls).toBe(1);
    });
});
