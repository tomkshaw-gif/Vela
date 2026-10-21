import { describe, expect, it } from 'vitest';
import { applyCommand, createSession, validateSessionConfig, validateStoredSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS } from '../shared/types';
import type { Bar, Command, Session, SessionConfig } from '../shared/types';

const instrument = INSTRUMENTS[0]!;
const START = Date.UTC(2024, 10, 3, 5);
const source: Bar[] = [0, 1, 5, 6, 10, 11].map((minute, index) => ({ time: START + minute * 60_000, open: 100 + index, high: 100 + index, low: 100 + index, close: 100 + index, volume: 1 }));
const config = (extra: Partial<SessionConfig> & { endIndex?: number } = {}): SessionConfig => ({ name: 'Selected range', datasetId: 'source-1', mode: 'practice', initialBalance: 50_000, commissionPerContractSide: 1.23, slippageTicks: 0, spreadTicks: 0, startIndex: 1, rules: { ...DEFAULT_RULES }, ...extra });
const run = (session: Session, bars: Bar[], ...commands: Command[]): Session => commands.reduce((state, command) => applyCommand(state, bars, command), session);
const buy: Command = { type: 'place', order: { side: 'buy', type: 'market', qty: 1 } };
function guardedSource(endIndex: number): Bar[] {
    return new Proxy(source, { get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) >= endIndex) throw new Error(`Future source bar ${key} was read`);
        return Reflect.get(target, key, receiver) as unknown;
    } });
}

describe('exclusive session end boundary', () => {
    it('validates the exclusive end against the start and source count while retaining legacy absence', () => {
        expect(validateSessionConfig(config(), source.length)).not.toHaveProperty('endIndex');
        expect(validateSessionConfig(config({ endIndex: source.length }), source.length)).toHaveProperty('endIndex', source.length);
        for (const endIndex of [-1, 0, 1, 2.5, source.length + 1, null, '4', NaN]) {
            expect(() => validateSessionConfig({ ...config(), endIndex }, source.length), String(endIndex)).toThrow(/end index/i);
        }
        expect(() => createSession(config({ endIndex: 1 }), instrument)).toThrow(/end index/i);
    });

    it('keeps legacy full-dataset completion and optional full-span boundaries equivalent', () => {
        for (const extra of [{}, { endIndex: source.length }]) {
            const result = run(createSession(config(extra), instrument), source, buy, { type: 'advance', count: 5000 });
            expect(result.cursor).toBe(source.length - 1);
            expect(result.status).toBe('completed');
            expect(result.trades[0]).toMatchObject({ exitTime: source.at(-1)!.time, exitPrice: source.at(-1)!.close, reason: 'End of data' });
            expect(validateStoredSession(result, source, instrument)).toEqual(result);
        }
    });

    it.each(['advance', 'advanceTo'] as const)('completes %s at the selected last bar without reading an excluded source getter', (type) => {
        const bars = guardedSource(4);
        const pending: Command = { type: 'place', order: { side: 'buy', type: 'limit', qty: 1, price: 90 } };
        const result = run(createSession(config({ endIndex: 4, slippageTicks: 1, spreadTicks: 2 }), instrument), bars,
            buy, pending, type === 'advance' ? { type, count: 5000 } : { type, time: START + 100 * 60_000 });
        expect(result.config).toHaveProperty('endIndex', 4);
        expect(result.cursor).toBe(3); expect(result.status).toBe('completed');
        expect(result.position).toBeNull(); expect(result.orders.map(order => order.status)).toEqual(['filled', 'cancelled']);
        expect(result.trades[0]).toMatchObject({ entryTime: source[1]!.time, exitTime: source[3]!.time, entryPrice: 101.5, exitPrice: 102.5, fees: 2.46, netPnl: 17.54, reason: 'End of data' });
        expect(result.equityCurve.map(point => point.time)).toEqual(source.slice(1, 4).map(bar => bar.time));
        expect(validateStoredSession(result, bars, instrument)).toEqual(result);
        expect(() => applyCommand(result, bars, { type: 'advance', count: 1 })).toThrow(/finished/);
    });

    it.each(['completed', 'passed', 'failed'] as const)('reuses dataset terminal policies for a ranged %s result', (status) => {
        const extra: Partial<SessionConfig> = status === 'completed' ? {} : {
            mode: 'prop', commissionPerContractSide: status === 'failed' ? 2 : 0,
            rules: { ...DEFAULT_RULES, minTradingDays: 0, profitTargetUsd: status === 'passed' ? 10 : 3000, maxDailyLossUsd: status === 'failed' ? 3 : 1000 },
        };
        const endIndex = status === 'failed' ? 2 : 4;
        const bounded = run(createSession(config({ ...extra, endIndex }), instrument, 'terminal'), source, buy, { type: 'advance', count: 5000 });
        const prefix = run(createSession(config(extra), instrument, 'terminal'), source.slice(0, endIndex), buy, { type: 'advance', count: 5000 });
        expect(bounded.status).toBe(status);
        expect({ ...bounded, config: prefix.config, createdAt: prefix.createdAt, updatedAt: prefix.updatedAt }).toEqual(prefix);
        expect(validateStoredSession(bounded, source, instrument)).toEqual(bounded);
    });

    it('advances across in-range gaps and refuses a target containing no new source bar', () => {
        const bars = guardedSource(4);
        const first = applyCommand(createSession(config({ endIndex: 4 }), instrument), bars, { type: 'advanceTo', time: START + 2 * 60_000 });
        expect(first.cursor).toBe(1); expect(first.status).toBe('paused');
        expect(() => applyCommand(first, bars, { type: 'advanceTo', time: START + 4 * 60_000 })).toThrow(/new source bar/);
        const next = applyCommand(first, bars, { type: 'advanceTo', time: START + 5 * 60_000 });
        expect(next.cursor).toBe(2); expect(next.status).toBe('paused');
        const done = applyCommand(next, bars, { type: 'advanceTo', time: START + 10 * 60_000 });
        expect(done.cursor).toBe(3); expect(done.status).toBe('completed');
    });

    it('preserves serialized boundaries and rejects cursors at or beyond the exclusive end before reading them', () => {
        const bars = guardedSource(4);
        const saved = run(createSession(config({ endIndex: 4 }), instrument), bars, buy, { type: 'advance', count: 1 });
        const restored = validateStoredSession(JSON.parse(JSON.stringify(saved)) as unknown, bars, instrument);
        expect(restored.config).toHaveProperty('endIndex', 4);
        const done = applyCommand(restored, bars, { type: 'advance', count: 5000 });
        expect(done.cursor).toBe(3); expect(done.status).toBe('completed');
        for (const cursor of [4, 5]) expect(() => validateStoredSession({ ...saved, cursor }, bars, instrument)).toThrow(/cursor/i);
        expect(() => validateStoredSession({ ...saved, config: { ...saved.config, endIndex: 7 } }, bars, instrument)).toThrow(/end index/i);
    });
});
