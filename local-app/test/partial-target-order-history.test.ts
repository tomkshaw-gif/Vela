import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyCommand, createSession, validateStoredSession } from '../engine';
import { ReplayStore } from '../server/store';
import { DEFAULT_RULES, type Bar, type Command, type SessionConfig } from '../shared/types';

describe('rejected position-intent order history', () => {
    it.each(['buy', 'sell'] as const)('keeps a rejected amended %s reverse valid across save/reopen and closes the survivor', side => {
        const d = side === 'buy' ? 1 : -1;
        const bars: Bar[] = [100, 100 + d * 3, 100 + d * 3, 100 + d * 3].map((price, index) => ({
            time: 1780322400000 + index * 60000, open: price, high: price, low: price, close: price, volume: 1,
        }));
        const temporaryRoot = realpathSync(tmpdir());
        const directory = mkdtempSync(join(temporaryRoot, 'vela-rejected-reverse-'));
        let store: ReplayStore | undefined;
        try {
            store = new ReplayStore(directory);
            const dataset = store.addDataset({ name: 'Rejected reverse fixture', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars });
            const config: SessionConfig = { name: 'Rejected amended reverse', datasetId: dataset.id, mode: 'practice', initialBalance: 50000,
                commissionPerContractSide: 1.23, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES, maxContracts: 20 } };
            let state = createSession(config, dataset.instrument);
            const commands: Command[] = [
                { type: 'place', order: { side, type: 'market', qty: 3, takeProfits: [{ id: 'entry-target', price: 100 + d * 2, qty: 2 }] } },
                { type: 'advance', count: 1 }, { type: 'reverse' },
            ];
            for (const command of commands) state = applyCommand(state, bars, command);
            const reverseId = state.orders.at(-1)!.id;
            state = applyCommand(state, bars, { type: 'amend', orderId: reverseId, takeProfits: [{ id: 'reverse-target', price: 100 - d * 2, qty: 3 }] });
            const submitted = structuredClone(state.orders.at(-1)!);
            const snapshot = structuredClone(state);
            expect(submitted.qty).toBe(6);
            store.createSession(state);

            const advanced = applyCommand(state, bars, { type: 'advance', count: 1 });
            store.saveSession(advanced, state.revision);
            expect(state).toEqual(snapshot);
            expect(advanced.position).toMatchObject({ side, qty: 1 });
            expect(advanced.account.balance).toBe(50113.85);
            expect(advanced.fills.map(fill => fill.qty)).toEqual([3, 2]);
            expect(advanced.orders.at(-1)).toEqual({ ...submitted, status: 'rejected', rejectReason: expect.any(String) });
            expect(advanced.orders.at(-1)?.filledTime).toBeUndefined();
            expect(advanced.orders.at(-1)?.fillPrice).toBeUndefined();
            store.close(); store = undefined;

            store = new ReplayStore(directory);
            const persisted = store.session(advanced.id);
            expect(validateStoredSession(persisted, bars, dataset.instrument)).toEqual(advanced);
            const queuedClose = applyCommand(persisted, bars, { type: 'close' });
            store.saveSession(queuedClose, persisted.revision);
            const closed = applyCommand(queuedClose, bars, { type: 'advance', count: 1 });
            store.saveSession(closed, queuedClose.revision);
            const restored = validateStoredSession(store.session(closed.id), bars, dataset.instrument);
            expect(restored.position).toBeNull();
            expect(restored.status).toBe('paused');
            expect(restored.prop.status).toBe('active');
            expect(restored.fills.map(fill => fill.qty)).toEqual([3, 2, 1]);
            expect(restored.trades.map(trade => [trade.qty, trade.reason])).toEqual([[2, 'Take profit'], [1, 'Close position']]);
            expect(restored.orders.find(order => order.id === reverseId)).toEqual(advanced.orders.at(-1));
        } finally {
            store?.close();
            if (dirname(realpathSync(directory)) !== temporaryRoot) throw new Error('Temporary fixture directory is outside its owned root');
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
