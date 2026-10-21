import { describe, expect, it, vi } from 'vitest';
import { createAppAgentContext } from '../client/app-agent-context';
import { createSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS, type SessionView } from '../shared/types';

function fixture() {
    const instrument = INSTRUMENTS[0]!;
    const session = createSession({ name: 'Read-only target fixture', datasetId: 'synthetic', mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES } }, instrument, 'target-context');
    session.cursor = 0;
    session.position = { side: 'buy', qty: 4, avgPrice: 100, entryTime: 0, entryFees: 0, mae: 0, mfe: 0,
        takeProfits: [{ id: 'target', price: 120, qty: 1 }] };
    session.orders = [{ id: 'order', type: 'limit', side: 'buy', qty: 4, price: 99, createdTime: 0, status: 'working',
        takeProfits: [{ id: 'pending-target', price: 125, qty: 2 }] }];
    session.fills = [{ id: 'fill', orderId: 'order', time: 0, side: 'sell', qty: 1, price: 120, fees: 1, reason: 'take-profit', takeProfitLegId: 'target' }];
    session.trades = [{ id: 'trade', side: 'buy', qty: 1, entryTime: 0, exitTime: 0, entryPrice: 100, exitPrice: 120, grossPnl: 400,
        fees: 2, netPnl: 398, reason: 'take-profit', mae: 0, mfe: 400, takeProfitLegId: 'target' }];
    const view: SessionView = { session, dataset: { id: 'synthetic', name: 'Synthetic', symbol: 'NQZ6', schema: 'ohlcv-1m', intervalMs: 60000,
        instrument, barCount: 10, start: 0, end: 600000, source: 'demo', createdAt: '', checksum: '' } };
    const get = vi.fn(async () => { throw new Error('This context must not fetch data.'); });
    const context = createAppAgentContext({ api: { get }, getView: () => view, getCursorTime: () => 0 });
    return { session, context, get };
}

describe('read-only target context projection', () => {
    it('projects bounded target fields and fill/trade leg provenance without introducing trading capabilities', async () => {
        const { session, context, get } = fixture();
        Object.assign(session.position!.takeProfits![0]!, { unrelated: 'not-public', source: 'not-public' });
        const output = await context.readSession();
        expect(output.position).toMatchObject({ takeProfits: [{ id: 'target', price: 120, qty: 1 }] });
        expect(output.orders).toMatchObject({ items: [{ takeProfits: [{ id: 'pending-target', price: 125, qty: 2 }] }] });
        expect(output.fills).toMatchObject({ items: [{ takeProfitLegId: 'target', qty: 1 }] });
        expect(output.trades).toMatchObject({ items: [{ takeProfitLegId: 'target', netPnl: 398 }] });
        expect(JSON.stringify(output)).not.toContain('not-public');
        const projected = (output.position as { takeProfits: { qty: number }[] }).takeProfits;
        projected[0]!.qty = 999; expect(session.position!.takeProfits![0]!.qty).toBe(1);
        expect(get).not.toHaveBeenCalled(); expect(Object.keys(context).some(key => /place|close|amend|cancel/i.test(key))).toBe(false);
    });

    it('keeps target projections capped and filters future owners/provenance with the existing replay horizon', async () => {
        const { session, context } = fixture();
        session.position!.takeProfits = Array.from({ length: 20 }, (_, i) => ({ id: `leg-${i}`, price: 120, qty: 1 }));
        session.orders[0]!.createdTime = 1; session.fills[0]!.time = 1; session.trades[0]!.exitTime = 1;
        const output = await context.readSession();
        expect((output.position as { takeProfits: unknown[] }).takeProfits).toHaveLength(10);
        expect(output.orders).toMatchObject({ total: 0 }); expect(output.fills).toMatchObject({ total: 0 }); expect(output.trades).toMatchObject({ total: 0 });
        session.position!.entryTime = 1;
        expect((await context.readSession()).position).toBeNull();
    });
});
