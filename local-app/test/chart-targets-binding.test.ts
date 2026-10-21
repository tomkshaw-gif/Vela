import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS, type SessionView, type TakeProfitLeg } from '../shared/types';
import type { ChartOrderLineBinding } from '../client/chart-order-lines';
import type { LocalApi } from '../client/api';

const bound = vi.hoisted(() => ({ bindings: [] as ChartOrderLineBinding[], refresh: vi.fn() }));
vi.mock('../client/chart-order-lines', () => ({
    bindChartOrderLines: (_host: unknown, binding: ChartOrderLineBinding) => { bound.bindings.push(binding); return () => {}; },
    refreshChartOrderLines: bound.refresh,
}));
vi.mock('../client/chart-quote-bar', () => ({ createChartQuoteBar: () => ({ element: { title: '' }, update: vi.fn(), destroy: vi.fn() }) }));

import { ReplayCharts } from '../client/charts';

const controllers: ReplayCharts[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.destroy(); bound.bindings.length = 0; bound.refresh.mockClear(); });

describe('atomic chart target selection binding', () => {
    it('forwards all legs with the current revision, keeps scalar bracket selection, and suppresses blocked or retired cell callbacks', () => {
        const instrument = INSTRUMENTS[0]!;
        const view: SessionView = { session: createSession({ name: 'Inert chart binding', datasetId: 'binding-data', mode: 'practice',
            initialBalance: 50000, commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES }, instrument, 'binding-session'),
            dataset: { id: 'binding-data', name: 'Synthetic binding', symbol: 'NQM4', schema: 'ohlcv-1m', intervalMs: 60000, instrument,
                barCount: 3, start: 0, end: 180000, source: 'csv', createdAt: '', checksum: 'binding-checksum' } };
        const host = new EventTarget() as HTMLElement;
        const events: unknown[] = [];
        host.addEventListener('local-replay:chrome', event => events.push((event as CustomEvent).detail));
        let blocked = false; let active = true;
        const controller = new ReplayCharts(host, {} as LocalApi, async () => {}, vi.fn(), vi.fn(), vi.fn(), () => blocked);
        controllers.push(controller);
        const chart = { market: { symbol: 'replay:NQM4', timeframe: '1' }, renderer: { set: vi.fn(), getConfig: () => ({}) }, on: () => () => {} };
        const cell = { id: 'binding-cell', host: { nodeType: 1 }, chart, setStatuslineAppearance: vi.fn(), setExternalReplaying: vi.fn(), mountStatuslineAccessory: () => () => {} };
        const internal = controller as unknown as { view: SessionView; workspace: unknown; appearanceKnownCells: Set<string>;
            pineEngines: Map<unknown, unknown>; ticketPreview: unknown; watchCells(): void };
        internal.view = view;
        internal.workspace = { cells: () => [cell], cell: () => active ? cell : undefined, destroy: () => {} };
        internal.appearanceKnownCells.add(cell.id); internal.pineEngines.set(chart, { dispose: () => {} });
        const takeProfits: TakeProfitLeg[] = [{ id: 'tp-one', price: 105, qty: 1 }, { id: 'tp-two', price: 110, qty: 1 }];
        internal.ticketPreview = { side: 'buy', type: 'limit', price: 100, takeProfits };
        internal.watchCells();
        const binding = bound.bindings[0]!;
        expect(binding.preview()?.takeProfits).toEqual(takeProfits);
        binding.selectTakeProfits!(takeProfits);
        expect(events).toEqual([{ kind: 'ticket-targets-select', takeProfits, sessionId: view.session.id, revision: 0 }]);
        const updated = { ...view, session: { ...view.session, revision: 1 } };
        controller.updateMarkers(updated); binding.selectTakeProfits!(takeProfits);
        expect(events.at(-1)).toEqual({ kind: 'ticket-targets-select', takeProfits, sessionId: view.session.id, revision: 1 });
        expect(bound.refresh).toHaveBeenCalledWith(host);
        binding.selectBracket!('stopLoss', 95);
        expect(events.at(-1)).toEqual({ kind: 'ticket-bracket-select', bracket: 'stopLoss', price: 95, sessionId: view.session.id, revision: 1 });
        blocked = true; binding.selectTakeProfits!(takeProfits); expect(events).toHaveLength(3);
        blocked = false; active = false; binding.selectTakeProfits!(takeProfits); expect(events).toHaveLength(3);
    });
});
