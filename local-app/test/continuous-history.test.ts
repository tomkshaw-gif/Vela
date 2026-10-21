import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCommand, createSession, validateStoredSession } from '../engine';
import { validateExecutionVersion } from '../engine/validation';
import { continuousInstrument, instrumentFor, parseContinuousBar, validateBars } from '../server/data';
import { ReplayStore } from '../server/store';
import { DEFAULT_RULES, type Bar, type SessionConfig } from '../shared/types';

const BASE = Date.UTC(2024, 0, 2); const directories: string[] = []; const stores: ReplayStore[] = [];
afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0)) {
        if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('vela-continuous-proof-')) throw new Error('Unexpected fixture path.');
        rmSync(directory, { recursive: true, force: true });
    }
});
function bar(index: number, price = 100, instrumentId = '1001', contract = 'NQH4'): Bar {
    return { time: BASE + index * 60_000, open: price, high: price, low: price, close: price, volume: 1, instrumentId, contract };
}
function config(): SessionConfig {
    return { name: 'Continuous fixture', datasetId: 'continuous_fixture', mode: 'practice', initialBalance: 50_000, commissionPerContractSide: 2,
        slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES };
}
function raw(contract: string, id: number, price: string, time = BASE) {
    return { hd: { ts_event: String(BigInt(time) * 1_000_000n), instrument_id: id }, symbol: contract, open: price, high: price, low: price, close: price, volume: 1 };
}

describe('continuous futures identity and execution', () => {
    it('accepts GC tenth-dollar nanoprices while preserving exact-contract ID rejection', () => {
        expect(instrumentFor('GCZ4')).toEqual({ root: 'GC', tickSize: 0.1, pointValue: 100 });
        const first = raw('GCZ4', 1, '2350100000000');
        expect(validateBars([first], 'ohlcv-1m', 'GCZ4')[0]!.close).toBeCloseTo(2350.1, 8);
        expect(() => validateBars([first, raw('GCZ4', 2, '2350100000000', BASE + 60_000)], 'ohlcv-1m', 'GCZ4')).toThrow(/instrument IDs/);
        expect(() => validateBars([raw('GCZ4', 1, '2350050000000')], 'ohlcv-1m', 'GCZ4')).toThrow(/ticks/);
    });
    it('requires canonical continuous IDs and actual matching contract identities', () => {
        expect(continuousInstrument('NQ.v.0').root).toBe('NQ'); expect(continuousInstrument('GC.v.0').root).toBe('GC');
        for (const symbol of ['NQ', 'NQ.c.0', 'NQ.v.1', 'GC.V.0', '../NQ.v.0']) expect(() => continuousInstrument(symbol)).toThrow();
        expect(() => instrumentFor('NQ.v.0')).toThrow();
        expect(parseContinuousBar(raw('NQH4', 1, '100000000000'), 'NQ.v.0', { start: BASE, end: BASE + 60_000 })).toMatchObject({ instrumentId: '1', contract: 'NQH4' });
        expect(() => parseContinuousBar(raw('GCZ4', 1, '100000000000'), 'NQ.v.0', { start: BASE, end: BASE + 60_000 })).toThrow();
        expect(() => parseContinuousBar({ ...raw('NQH4', 1, '100000000000'), symbol: 'NQ.v.0' }, 'NQ.v.0', { start: BASE, end: BASE + 60_000 })).toThrow();
    });
    it('flattens at the last revealed old-contract close, cancels orders and never realizes the roll gap', () => {
        const bars = [bar(0), bar(1), bar(2, 101), bar(3, 1000, '2002', 'NQM4'), bar(4, 1000, '2002', 'NQM4')];
        let session = createSession(config(), continuousInstrument('NQ.v.0'));
        session = applyCommand(session, bars, { type: 'advance', count: 1 });
        session = applyCommand(session, bars, { type: 'place', order: { type: 'market', side: 'buy', qty: 1 } });
        session = applyCommand(session, bars, { type: 'advance', count: 2 });
        session = applyCommand(session, bars, { type: 'place', order: { type: 'limit', side: 'buy', qty: 1, price: 100 } });
        const old = session; const future = bars[3]!; let validatedAfterClose = false; const reads: string[] = [];
        Object.defineProperty(bars[2]!, 'close', { get() { reads.push('old-close'); return 101; }, enumerable: true });
        Object.defineProperty(future, 'open', { get() { reads.push('new-open'); validatedAfterClose = true; return 1000; }, enumerable: true });
        session = applyCommand(session, bars, { type: 'advance', count: 1 });
        expect(validatedAfterClose).toBe(true); expect(session.position).toBeNull();
        expect(session.trades).toHaveLength(1); expect(session.trades[0]).toMatchObject({ exitTime: bars[2]!.time, exitPrice: 101, grossPnl: 20, netPnl: 16, reason: 'Continuous contract roll' });
        expect(session.orders.find(order => order.status === 'working')).toBeUndefined();
        expect(session.account.balance).toBe(50_016); expect(old.position?.qty).toBe(1);
        expect(reads.lastIndexOf('old-close')).toBeLessThan(reads.indexOf('new-open'));
        expect(session.executionVersion).toBe(3); expect(validateExecutionVersion(session)).toBe(3);
        expect(validateStoredSession(session, bars, continuousInstrument('NQ.v.0')).executionVersion).toBe(3);
    });
    it('preserves version 3 when target legs are submitted after a roll-aware session starts', () => {
        const bars = [bar(0), bar(1), bar(2)]; let session = createSession(config(), continuousInstrument('NQ.v.0'));
        session = applyCommand(session, bars, { type: 'advance', count: 1 });
        session = applyCommand(session, bars, { type: 'place', order: { type: 'market', side: 'buy', qty: 1, takeProfits: [{ id: 'target', price: 102, qty: 1 }] } });
        expect(session.executionVersion).toBe(3);
        expect(() => validateExecutionVersion({ ...session, executionVersion: 4 })).toThrow(/version/);
    });
    it('preserves exposure when a publisher remaps the ID of the same raw contract', () => {
        const bars = [bar(0), bar(1), bar(2, 101, '2002', 'NQH4'), bar(3, 101, '2002', 'NQH4')];
        let session = createSession(config(), continuousInstrument('NQ.v.0'));
        session = applyCommand(session, bars, { type: 'advance', count: 1 });
        session = applyCommand(session, bars, { type: 'place', order: { type: 'market', side: 'buy', qty: 1 } });
        session = applyCommand(session, bars, { type: 'advance', count: 2 });
        expect(session.position?.qty).toBe(1); expect(session.trades).toEqual([]); expect(session.account.unrealizedPnl).toBe(20);
    });
    it('fetches only a bounded source window for a command and never materializes large history', () => {
        const directory = mkdtempSync(join(tmpdir(), 'vela-continuous-proof-')); directories.push(directory);
        const store = new ReplayStore(directory); stores.push(store);
        const dataset = store.addDataset({ name: 'Fixture', symbol: 'NQH4', schema: 'ohlcv-1m', source: 'csv', bars: [bar(0), bar(1), bar(2)] });
        const readAll = vi.spyOn(store, 'readBars').mockImplementation(() => { throw new Error('Full history reads are forbidden.'); });
        const bars = store.commandBars(dataset.id, 0); expect(Array.isArray(bars)).toBe(true); expect(bars.length).toBe(3);
        expect(bars[1]!.close).toBe(100); expect(readAll).not.toHaveBeenCalled();
    });
});
