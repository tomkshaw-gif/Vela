import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vela } from '../src/Vela';
import { DemoEngine } from '../playground/demo-engine';

const BASE = Date.UTC(2024, 3, 8);
const source = 'title Public port\noverlay true\ninput length = 3\nplot sma(close, length) "Average"';
const charts = [];
afterEach(() => { charts.splice(0).forEach(chart => chart.destroy()); });

async function fixture(engine = new DemoEngine()) {
    const bars = Array.from({ length: 6 }, (_, index) => ({ time: BASE + index * 60000, open: 100 + index,
        high: 102 + index, low: 99 + index, close: 100 + index, volume: 10 }));
    let push;
    let viewport;
    let range = { from: BASE, to: bars.at(-1).time };
    const renderer = new Proxy({ name: 'public-port-test', features: [],
        capabilities: { panes: true, paneManagement: false, fills: 'primitive', bgcolor: 'primitive', hline: 'native',
            markers: true, barcolor: 'approximated', perPointColor: true, drawings: true, userDrawings: false, tables: true, inputsUI: true },
        getVisibleRange: () => range, setVisibleRange: next => { range = next; viewport?.(next); },
        onViewportChange: handler => { viewport = handler; return () => { viewport = undefined; }; },
        mountIndicator: model => ({ id: model.id }), readFeature: () => undefined,
    }, { get: (target, key) => key in target ? target[key] : () => () => {} });
    const feed = { load: async () => bars.map(bar => ({ ...bar })), subscribe: (_config, onBar) => { push = onBar; return () => { push = undefined; }; } };
    const chart = new Vela({}, { symbol: 'NQM4', timeframe: '1', data: bars, live: true, volume: false }, { renderer, dataFeed: feed, engines: [engine] });
    charts.push(chart); await chart.ready();
    const handle = chart.addIndicator(source, { language: 'demo' });
    await vi.waitFor(async () => expect((await handle.context())?.plots.Average?.at(-1)?.value).toBe(104));
    return { chart, handle, bars, tick: bar => push?.(bar) };
}

describe('optional computation identity on the public engine port', () => {
    it('preserves the existing demo engine input, bar, and viewport contexts without claiming verification', async () => {
        const { chart, handle, bars, tick } = await fixture();
        expect((await handle.context()).computation).toBeUndefined();
        handle.setInput('length', 2);
        expect((await handle.context()).plots.Average.at(-1).value).toBe(104.5);
        expect((await handle.context()).computation).toBeUndefined();
        tick({ ...bars.at(-1), high: 201, close: 200 });
        expect((await handle.context()).plots.Average.at(-1).value).toBe(152);
        chart.setVisibleRange({ from: BASE + 60000, to: BASE + 240000 });
        expect((await handle.context()).plots.Average.at(-1).value).toBe(152);
        expect((await handle.context()).computation).toBeUndefined();
    });

    it('preserves a viewport-capable legacy engine rerun without synthesizing completed identities', async () => {
        class ViewportDemo extends DemoEngine {
            viewportRuns = 0;
            async prepare(...args) { return { ...await super.prepare(...args), reactsToViewport: true }; }
            execute(request, handlers) {
                const session = super.execute(request, handlers);
                return { ...session, setVisibleRange: () => { this.viewportRuns += 1; session.notifyBars(); } };
            }
        }
        const engine = new ViewportDemo(); const { chart, handle } = await fixture(engine);
        chart.setVisibleRange({ from: BASE + 60000, to: BASE + 240000 });
        await vi.waitFor(() => expect(engine.viewportRuns).toBe(1));
        const context = await handle.context();
        expect(context.plots.Average.at(-1).value).toBe(104);
        expect(context.computation).toBeUndefined();
    });

    it('never verifies a delayed legacy read when an older completion arrives after settings change', async () => {
        let delayed = false; let releaseRead;
        const completions = [];
        class DelayedDemo extends DemoEngine {
            execute(request, handlers) {
                const session = super.execute(request, { ...handlers, onDone: () => completions.push(() => handlers.onDone?.()) });
                return { ...session, getContext: async select => {
                    const context = await session.getContext(select);
                    if (delayed) await new Promise(resolve => { releaseRead = resolve; });
                    return context;
                } };
            }
        }
        const { handle } = await fixture(new DelayedDemo());
        delayed = true; const reading = handle.context();
        await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
        handle.setInput('length', 2); completions.shift()(); releaseRead();
        const old = await reading;
        expect(old.plots.Average.at(-1).value).toBe(104);
        expect(old.computation).toBeUndefined();
        delayed = false; completions.shift()();
        const current = await handle.context();
        expect(current.plots.Average.at(-1).value).toBe(104.5);
        expect(current.computation).toBeUndefined();
    });
});
