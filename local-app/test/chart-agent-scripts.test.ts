// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddIndicatorOptions, EngineContextSnapshot, IndicatorEventMap, IndicatorHandle, InputSchema, InputValue, Vela } from '../../src/index';
import type { VelaWorkspace } from '../../src/workspace';
import { createChartAgentController, type ChartAgentController, type ChartAgentControllerOptions } from '../client/chart-agent';
import type { LocalApi } from '../client/api';
import { chartScripts } from '../client/script-persistence';
import type { ChartAgentTask } from '../shared/chart-agent';
import { createSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS, type SessionView } from '../shared/types';

const START = Date.UTC(2024, 3, 8);
const SESSION = '9e42b33b-7bae-4338-8629-55d076fc1175';
const controllers: ChartAgentController[] = [];
const INPUTS: InputSchema[] = [{ key: 'length', title: 'Length', type: 'int', defval: 14, min: 1, max: 5000 }];
const PROPS: InputSchema[] = [{ key: 'initial_capital', title: 'Initial capital', type: 'float', defval: 50000, min: 0 }];
function fixture(extra: Partial<ChartAgentControllerOptions> = {}) {
    const instrument = INSTRUMENTS[0]!; let generation = 1; let blocked = false; let cutoff = START + 9 * 60000;
    let view: SessionView = { session: { ...createSession({ name: 'Pine tools', datasetId: 'fixture', mode: 'practice', initialBalance: 50000, commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES }, instrument, SESSION), cursor: 9 },
        dataset: { id: 'fixture', name: 'Local fixture', symbol: 'NQM4', schema: 'ohlcv-1m', intervalMs: 60000, instrument, barCount: 100, start: START, end: START + 100 * 60000, source: 'csv', checksum: 'fixture', createdAt: '2024-04-08' } };
    const handles = new Map<string, ReturnType<typeof makeHandle>>();
    const makeHandle = (id: string, source: string, initial: AddIndicatorOptions = {}) => {
        let inputs = { length: 14, ...initial.inputs } as Record<string, InputValue>; let props = { ...initial.props };
        const listeners = new Map<keyof IndicatorEventMap, Set<(value: unknown) => void>>();
        const handle = { id, source, title: 'Pine tool fixture', nativeType: undefined, visible: true, inputs: INPUTS, props: PROPS,
            inputValues: () => ({ ...inputs }), propValues: () => ({ ...props }),
            setInputs: vi.fn((next: Record<string, InputValue>) => { inputs = { ...inputs, ...next }; }),
            setProps: vi.fn((next: Record<string, InputValue>) => { props = { ...props, ...next }; }),
            setVisible: vi.fn((visible: boolean) => { handle.visible = visible; }), moveTo: vi.fn(),
            context: vi.fn(async (_select?: readonly string[]): Promise<EngineContextSnapshot | null> => ({ language: 'pine', phase: 'idle', barIndex: 9, meta: { title: 'Pine tool fixture', overlay: true }, plots: {}, variables: {}, warnings: [] })),
            remove: vi.fn(() => { handles.delete(id); }),
            on: <K extends keyof IndicatorEventMap>(event: K, callback: (value: IndicatorEventMap[K]) => void) => {
                let listenersForEvent = listeners.get(event); if (!listenersForEvent) { listenersForEvent = new Set(); listeners.set(event, listenersForEvent); }
                listenersForEvent.add(callback as (value: unknown) => void); return () => listenersForEvent!.delete(callback as (value: unknown) => void);
            },
            emit: <K extends keyof IndicatorEventMap>(event: K, value: IndicatorEventMap[K]) => { for (const callback of [...(listeners.get(event) ?? [])]) callback(value); },
        };
        handles.set(id, handle); return handle;
    };
    const chart = { market: { symbol: 'replay:NQM4', timeframe: '1' }, indicators: () => [...handles.values()],
        addIndicator: vi.fn((source: string, options: AddIndicatorOptions) => makeHandle(options.id!, source, options)),
        panes: { list: () => [{ id: 'price', kind: 'price', indicators: [...handles.values()].map(handle => ({ id: handle.id })) }] },
    };
    const cells = [{ id: 'one', chart: chart as unknown as Vela }];
    const workspace = { cells: () => cells, cell: (id: string) => cells.find(cell => cell.id === id), context: () => ({ activeCellId: 'one' }) } as unknown as Pick<VelaWorkspace, 'context' | 'cells' | 'cell'>;
    const api = { get: vi.fn(), post: vi.fn(async () => ({ request: null })), postKeepalive: vi.fn() };
    const flush = vi.fn(async () => {});
    const controller = createChartAgentController({ api: api as unknown as LocalApi, workspace, session: () => view, generation: () => generation, blocked: () => blocked,
        cursorTime: () => cutoff, setTimeframe: vi.fn(async () => {}), flush, autoStart: false, ...extra }); controllers.push(controller);
    const task = (operation: ChartAgentTask['operation'], args: Record<string, unknown> = {}): ChartAgentTask => ({ requestId: crypto.randomUUID(), deadline: Date.now() + 10000, operation, args,
        target: { clientId: controller.clientId, sessionId: SESSION, generation: 1, cellId: 'one' } });
    const call = (operation: ChartAgentTask['operation'], args: Record<string, unknown> = {}) => controller.execute(task(operation, args));
    return { controller, call, task, chart, handles, makeHandle, flush, cells, api, setGeneration: (next: number) => { generation = next; }, setBlocked: (next: boolean) => { blocked = next; },
        advance: () => { view = { ...view, session: { ...view.session, cursor: view.session.cursor + 1 } }; cutoff += 60000; } };
}
interface Job { jobId: string; indicatorId: string; replacesId?: string; state: string; deadline: number; saved: boolean; error?: string }
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); vi.useRealTimers(); });

describe('Pine assistant jobs', () => {
    it('starts the shared tester for the exact strategy and reconciles only its owned job', async () => {
        type Result = Awaited<ReturnType<NonNullable<ChartAgentControllerOptions['strategy']>['startBacktestForIndicator']>>;
        let finish!: (result: Result) => void;
        const start = vi.fn(() => new Promise<Result>(resolve => { finish = resolve; })); const cancel = vi.fn(() => true);
        const f = fixture({ strategy: { startBacktestForIndicator: start, cancelBacktest: cancel } });
        const handle = f.makeHandle('strategy', 'strategy("Exact")');
        await expect(f.call('backtest_indicator', { id: handle.id, mode: 'deep' })).rejects.toThrow('explicit UTC');
        const job = await f.call('backtest_indicator', { id: handle.id }) as { jobId: string };
        expect(start).toHaveBeenCalledWith(handle.id, { mode: 'replay', operationId: job.jobId }, expect.any(Function));
        finish({ generation: 7, name: 'Exact', result: { from: START, to: START + 60000, symbol: 'NQM4', timeframe: '1', state: { netPnl: 13 }, trades: [] }, snapshot: null } as unknown as Result);
        await settle();
        expect(await f.call('read_backtest_job', { jobId: job.jobId })).toMatchObject({ state: 'completed', value: { generation: 7, state: { netPnl: 13 }, tradeCount: 0, saved: false } });
        await f.call('cancel_backtest_job', { jobId: job.jobId }); expect(cancel).not.toHaveBeenCalled();
        const running = await f.call('backtest_indicator', { id: handle.id, mode: 'deep', from: START, to: START + 3600000 }) as { jobId: string };
        expect(await f.call('cancel_backtest_job', { jobId: running.jobId })).toMatchObject({ state: 'cancelled' });
        expect(cancel).toHaveBeenCalledWith(running.jobId);
        finish({} as Result); await settle();
        expect(await f.call('read_backtest_job', { jobId: running.jobId })).toMatchObject({ state: 'cancelled' });
    });
    it('excludes pending and failed replacements from saved layouts and persists only successful replacements', async () => {
        const f = fixture(); const original = f.makeHandle('original', 'indicator("Original")'); const chart = f.cells[0]!.chart;
        const failed = await f.call('update_script', { id: original.id, source: 'invalid Pine' }) as Job;
        expect(chartScripts(chart).map(script => script.id)).toEqual([original.id]);
        f.handles.get(failed.indicatorId)!.emit('error', { error: new Error('Compilation failed') });
        expect(chartScripts(chart).map(script => script.id)).toEqual([original.id]);
        const success = await f.call('update_script', { id: original.id, source: 'indicator("New")' }) as Job;
        expect(chartScripts(chart).map(script => script.id)).toEqual([original.id]);
        f.handles.get(success.indicatorId)!.emit('ready', undefined); await settle();
        expect(chartScripts(chart)).toMatchObject([{ id: success.indicatorId, script: 'indicator("New")' }]);
        const cancelled = await f.call('run_script', { source: 'indicator("Cancelled")' }) as Job;
        expect(chartScripts(chart).map(script => script.id)).toEqual([success.indicatorId]);
        await f.call('cancel_script_job', { jobId: cancelled.jobId });
        expect(chartScripts(chart).map(script => script.id)).toEqual([success.indicatorId]);
    });
    it('starts immediately, reports the real first-ready state, and persists its result', async () => {
        const f = fixture(); const job = await f.call('run_script', { source: 'indicator("Study")\nplot(close)', inputs: { length: 21 }, properties: { initial_capital: 100000 } }) as Job;
        expect(job).toMatchObject({ state: 'running', saved: false }); expect(job.jobId).toMatch(/^[a-f0-9-]{36}$/);
        expect(f.chart.addIndicator).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ id: job.indicatorId, language: 'pine', inputs: { length: 21 }, props: { initial_capital: 100000 } }));
        expect(f.flush).not.toHaveBeenCalled(); f.handles.get(job.indicatorId)!.emit('ready', undefined); await settle();
        expect(await f.call('read_script_job', { jobId: job.jobId })).toMatchObject({ state: 'completed', saved: true, indicator: { id: job.indicatorId, kind: 'script', inputs: { length: 21 }, properties: { initial_capital: 100000 } } });
        expect(f.flush).toHaveBeenCalledOnce(); expect(f.handles.has(job.indicatorId)).toBe(true);
    });
    it('removes failed compilation instances and reports a bounded failure without persisting them', async () => {
        const f = fixture(); const job = await f.call('run_script', { source: 'invalid Pine' }) as Job;
        f.handles.get(job.indicatorId)!.emit('error', { error: new Error('Syntax error on line 2') });
        expect(await f.call('read_script_job', { jobId: job.jobId })).toMatchObject({ state: 'failed', error: 'Syntax error on line 2' });
        expect(f.handles.size).toBe(0); expect(f.flush).not.toHaveBeenCalled();
    });
    it('uses the explicit thirty-second job lifetime rather than the ten-second request deadline', async () => {
        vi.useFakeTimers(); const f = fixture(); const job = await f.call('run_script', { source: 'indicator("Slow study")' }) as Job;
        await vi.advanceTimersByTimeAsync(12000); expect(f.handles.has(job.indicatorId)).toBe(true);
        f.handles.get(job.indicatorId)!.emit('ready', undefined); await settle();
        expect(await f.call('read_script_job', { jobId: job.jobId })).toMatchObject({ state: 'completed', saved: true });
    });
    it('cancels timed-out work and ignores a late ready event without resurrecting the script', async () => {
        vi.useFakeTimers(); const f = fixture(); const job = await f.call('run_script', { source: 'indicator("Too slow")' }) as Job;
        const handle = f.handles.get(job.indicatorId)!; await vi.advanceTimersByTimeAsync(30000);
        expect(await f.call('read_script_job', { jobId: job.jobId })).toMatchObject({ state: 'failed', error: 'Chart request has expired.' });
        expect(handle.remove).toHaveBeenCalledOnce(); handle.emit('ready', undefined); await settle(); expect(f.handles.size).toBe(0); expect(f.flush).not.toHaveBeenCalled();
    });
    it('stages replacement code, preserves placement, and replaces the old instance only after success', async () => {
        const f = fixture(); const original = f.makeHandle('original', 'indicator("Old")', { inputs: { length: 50 }, props: { initial_capital: 75000 } });
        const job = await f.call('update_script', { id: 'original', source: 'indicator("New")', inputs: { length: 21 } }) as Job;
        expect(job.replacesId).toBe('original'); expect(original.remove).not.toHaveBeenCalled();
        const replacement = f.handles.get(job.indicatorId)!; expect(replacement.propValues()).toEqual({ initial_capital: 75000 });
        replacement.emit('ready', undefined); await settle(); expect(original.remove).toHaveBeenCalledOnce(); expect(replacement.moveTo).toHaveBeenCalledWith('price');
        expect(await f.call('read_script_job', { jobId: job.jobId })).toMatchObject({ state: 'completed', saved: true, replacesId: 'original', indicatorId: replacement.id });
        expect(f.handles.has('original')).toBe(false);
    });
    it('keeps the original script when cancelling or rejecting invalid replacement inputs', async () => {
        const f = fixture(); const original = f.makeHandle('original', 'indicator("Keep me")');
        const cancelled = await f.call('update_script', { id: original.id, source: 'indicator("Cancelled")' }) as Job;
        expect(await f.call('cancel_script_job', { jobId: cancelled.jobId })).toMatchObject({ state: 'cancelled' });
        const invalid = await f.call('update_script', { id: original.id, source: 'indicator("Invalid")', inputs: { length: 0 } }) as Job;
        f.handles.get(invalid.indicatorId)!.emit('ready', undefined); await settle();
        expect(await f.call('read_script_job', { jobId: invalid.jobId })).toMatchObject({ state: 'failed' });
        expect(original.remove).not.toHaveBeenCalled(); expect(f.handles.size).toBe(1); expect(f.flush).not.toHaveBeenCalled();
    });
    it('preserves user changes made to the original while replacement compilation is pending', async () => {
        const f = fixture(); const original = f.makeHandle('original', 'indicator("Original")');
        const job = await f.call('update_script', { id: original.id, source: 'indicator("Replacement")' }) as Job;
        original.setInputs({ length: 99 }); f.handles.get(job.indicatorId)!.emit('ready', undefined); await settle();
        expect(await f.call('read_script_job', { jobId: job.jobId })).toMatchObject({ state: 'failed', error: expect.stringContaining('original script changed') });
        expect(original.inputValues().length).toBe(99); expect(original.remove).not.toHaveBeenCalled(); expect(f.handles.size).toBe(1);
    });
    it('cancels pending work when replay advances, generation changes, updates block the chart, or it closes', async () => {
        vi.useFakeTimers();
        for (const change of ['advance', 'generation', 'blocked', 'dispose']) {
            const f = fixture(); const original = f.makeHandle('original', 'indicator("Original")'); const job = await f.call('update_script', { id: original.id, source: 'indicator("New")' }) as Job;
            if (change === 'advance') f.advance(); else if (change === 'generation') f.setGeneration(2); else if (change === 'blocked') f.setBlocked(true); else f.controller.dispose();
            await vi.advanceTimersByTimeAsync(250); expect(f.handles.has(job.indicatorId), change).toBe(false); expect(original.remove, change).not.toHaveBeenCalled();
        }
    });
    it('reports save failures after a successful computation and keeps the running script', async () => {
        const f = fixture(); f.flush.mockRejectedValueOnce(new Error('Revision conflict')); const job = await f.call('run_script', { source: 'indicator("Saved?")' }) as Job;
        f.handles.get(job.indicatorId)!.emit('ready', undefined); await settle();
        expect(await f.call('read_script_job', { jobId: job.jobId })).toMatchObject({ state: 'completed', saved: false, error: expect.stringContaining('saving failed: Revision conflict') });
        expect(f.handles.has(job.indicatorId)).toBe(true); expect(await f.call('cancel_script_job', { jobId: job.jobId })).toMatchObject({ state: 'completed' });
    });
    it('cancels a pending job on timeframe changes and expires metadata without removing completed scripts', async () => {
        vi.useFakeTimers(); const f = fixture(); const original = f.makeHandle('original', 'indicator("Original")');
        const pending = await f.call('update_script', { id: original.id, source: 'indicator("New")' }) as Job;
        f.chart.market.timeframe = '5'; await vi.advanceTimersByTimeAsync(250);
        expect(await f.call('read_script_job', { jobId: pending.jobId })).toMatchObject({ state: 'failed', error: expect.stringContaining('timeframe changed') });
        expect(original.remove).not.toHaveBeenCalled();
        const completed = await f.call('run_script', { source: 'indicator("Kept")' }) as Job;
        f.handles.get(completed.indicatorId)!.emit('ready', undefined); await settle(); await vi.advanceTimersByTimeAsync(300001);
        await expect(f.call('read_script_job', { jobId: completed.jobId })).rejects.toThrow('metadata expired');
        expect(f.handles.has(completed.indicatorId)).toBe(true);
    });
    it('bounds job concurrency, source, settings and the exact originating chart target', async () => {
        const f = fixture();
        for (const args of [{ source: '' }, { source: 'x'.repeat(60001) }, { source: 'plot(close)', eval: true }, { source: 'plot(close)', inputs: { length: Infinity } }, { source: 'plot(close)', properties: { secret: 'private' } }]) await expect(f.call('run_script', args)).rejects.toThrow();
        expect(f.chart.addIndicator).not.toHaveBeenCalled();
        const jobs: Job[] = []; for (let i = 0; i < 4; i++) jobs.push(await f.call('run_script', { source: `indicator("${i}")` }) as Job);
        await expect(f.call('run_script', { source: 'indicator("Fifth")' })).rejects.toThrow('Four Pine jobs');
        f.cells.push({ id: 'two', chart: f.cells[0]!.chart }); const task = f.task('read_script_job', { jobId: jobs[0]!.jobId }); task.target.cellId = 'two';
        await expect(f.controller.execute(task)).rejects.toThrow('not found for this chart target');
        expect(f.handles.size).toBe(4);
    });
    it('updates Pine inputs/properties/visibility and removes the exact script through indicator controls', async () => {
        const f = fixture(); const handle = f.makeHandle('pine', 'strategy("Study")');
        expect(await f.call('update_indicator', { id: handle.id, inputs: { length: 21 }, properties: { initial_capital: 100000 }, visible: false })).toMatchObject({ inputs: { length: 21 }, properties: { initial_capital: 100000 }, visible: false });
        expect(handle.setProps).toHaveBeenCalledWith({ initial_capital: 100000 });
        expect(await f.call('remove_indicator', { id: handle.id })).toEqual({ removed: handle.id }); expect(f.handles.size).toBe(0); expect(f.flush).toHaveBeenCalledTimes(2);
    });
});

describe('bounded Pine context reads', () => {
    it('withholds stale numeric results and attaches only acknowledged completed settings', async () => {
        const f = fixture(); const handle = f.makeHandle('pending', 'indicator("Pending")', { inputs: { length: 21 } });
        const requested = { id: 'new', source: handle.source, inputs: { length: 21 }, props: {}, market: f.chart.market,
            bars: { revision: 2, count: 10, firstTime: START, lastTime: START + 9 * 60000 } };
        const old = { ...requested, id: 'old', inputs: { length: 14 } };
        const context: EngineContextSnapshot = { language: 'pine', phase: 'idle', barIndex: 9, meta: { title: 'Pending', overlay: true },
            plots: { Value: [{ time: START, value: 123 }] }, variables: {}, warnings: [], computation: { state: 'pending', requested, completed: old } };
        handle.context.mockResolvedValue(context);
        expect(await f.call('read_script_context', { id: handle.id })).toMatchObject({ calculationState: 'pending', context: null,
            computation: { requestedId: 'new', completedId: 'old' } });
        expect(await f.call('read_script_context', { id: handle.id })).not.toHaveProperty('plots');
        handle.context.mockResolvedValue({ ...context, computation: { state: 'ready', requested, completed: requested } });
        expect(await f.call('read_script_context', { id: handle.id })).toMatchObject({ calculationState: 'ready', indicator: { inputs: { length: 21 } }, computation: { id: 'new' }, plots: { Value: [{ time: START, value: 123 }] } });
        handle.context.mockResolvedValue({ ...context, computation: undefined });
        const legacy = await f.call('read_script_context', { id: handle.id });
        expect(legacy).toMatchObject({ calculationState: 'unverified', requestedIndicator: { inputs: { length: 21 } } });
        expect(legacy).not.toHaveProperty('indicator');
    });
    it('reads native numeric history without pretending it has Pine source', async () => {
        const f = fixture(); const handle = f.makeHandle('native', 'unused');
        Object.assign(handle, { source: undefined, nativeType: 'ma' });
        const requested = { id: 'native-1', source: '', inputs: { length: 14 }, props: {}, market: f.chart.market,
            bars: { revision: 1, count: 10, firstTime: START, lastTime: START + 9 * 60000 } };
        handle.context.mockResolvedValue({ language: 'native', phase: 'idle', barIndex: 9, meta: { title: 'Average', overlay: true },
            native: { type: 'ma', outputKind: 'series', unsupportedSeries: 0, hidden: false },
            computation: { state: 'ready', requested, completed: requested }, plots: { average: [{ time: START, value: 42 }] }, variables: {}, warnings: [] });
        const result = await f.call('read_indicator_context', { id: handle.id, includeSource: true });
        expect(result).toMatchObject({ calculationState: 'ready', language: 'native', native: { outputKind: 'series' }, plots: { average: [{ time: START, value: 42 }] } });
        expect(result).not.toHaveProperty('source');
        await expect(f.call('read_script_context', { id: handle.id })).rejects.toThrow('Pine script');
    });
    it('retains source and settings when a hidden instance has no active calculation', async () => {
        const f = fixture(); const handle = f.makeHandle('hidden-pine', 'indicator("Hidden")', { inputs: { length: 21 } });
        handle.visible = false; handle.context.mockResolvedValue(null);
        const result = await f.call('read_script_context', { id: handle.id, includeSource: true, trades: false, plotKeys: [] });
        expect(result).toMatchObject({ context: null, calculationState: 'hidden', source: handle.source, indicator: { inputs: { length: 21 }, visible: false } });
        expect(f.flush).not.toHaveBeenCalled();
    });
    it('reads numeric plots, selected variables, strategy and trades while filtering future timestamps', async () => {
        const f = fixture(); const handle = f.makeHandle('pine', 'strategy("Study")');
        const points = Array.from({ length: 600 }, (_, index) => ({ time: START - (599 - index) * 60000, value: index === 599 ? Infinity : index }));
        points.push({ time: START + 10 * 60000, value: 99999 });
        const trade = { id: 'closed', side: 'long' as const, qty: 1, entry: { id: 'L', time: START, price: 20000 }, exit: { id: 'X', time: START + 60000, price: 20001 }, open: false, pnl: 15, commission: 5 };
        handle.context.mockResolvedValueOnce({ language: 'pine', phase: 'idle', barIndex: 9, meta: { title: 'Study', overlay: true }, plots: { Average: points }, variables: { length: 21, unselected: 'private to the script', array: [1, 2], notFinite: Infinity },
            strategy: { position: 0, avgPrice: 0, equity: 50015, openPnl: 0, netPnl: 15, grossProfit: 20, grossLoss: 0, wins: 1, losses: 0, even: 0, maxDrawdown: 5, maxRunup: 20, initialCapital: 50000 },
            trades: [trade, { ...trade, id: 'future', exit: { ...trade.exit, time: START + 10 * 60000 } }], warnings: [{ message: 'Example', bar: 9 }] });
        const result = await f.call('read_script_context', { id: handle.id, plotKeys: ['Average'], variableKeys: ['length', 'array', 'notFinite'], limit: 500, includeSource: true }) as { plots: { Average: { time: number; value: number | null }[] }; trades: unknown[] };
        expect(result).toMatchObject({ id: handle.id, source: handle.source, strategy: { equity: 50015 }, variables: { length: 21, array: null, notFinite: null }, warnings: [{ message: 'Example' }], plotsTruncated: true });
        expect(result.plots.Average).toHaveLength(500); expect(result.plots.Average.at(-1)).toEqual({ time: START, value: null }); expect(result.trades).toEqual([trade]);
        expect(handle.context).toHaveBeenCalledWith(expect.arrayContaining(['plots', 'variables', 'trades', 'strategy'])); expect(f.flush).not.toHaveBeenCalled();
    });
    it('returns historical plot points for a requested region rather than only the latest values', async () => {
        const f = fixture(); const handle = f.makeHandle('region-pine', 'indicator("Region")');
        const points = Array.from({ length: 10 }, (_, index) => ({ time: START + index * 60000, value: index }));
        handle.context.mockResolvedValue({ language: 'pine', phase: 'idle', barIndex: 9, meta: { title: 'Region', overlay: true }, plots: { Value: points }, variables: {}, warnings: [] });
        const from = START + 2 * 60000, to = START + 4 * 60000;
        const result = await f.call('read_script_context', { id: handle.id, from, to, plotKeys: ['Value'] });
        expect(result).toMatchObject({ plots: { Value: points.slice(2, 5) }, requestedRange: { from, to }, strategyScope: 'Complete loaded chart history, not recalculated for the requested region.' });
        expect(f.flush).not.toHaveBeenCalled();
    });
    it('selects no large histories for lightweight reads and bounds total plot points', async () => {
        const f = fixture(); const handle = f.makeHandle('pine', 'indicator("Study")');
        const points = Array.from({ length: 500 }, (_, index) => ({ time: START - index * 60000, value: index }));
        const context: EngineContextSnapshot = { language: 'pine', phase: 'idle', barIndex: 9, meta: { title: 'Study', overlay: true }, plots: { one: points, two: points, three: points }, variables: {}, warnings: [] };
        handle.context.mockResolvedValue(context);
        const light = await f.call('read_script_context', { id: handle.id, plotKeys: [], trades: false, includeSource: true });
        expect(light).toMatchObject({ plots: {}, trades: [], source: handle.source }); const selection = handle.context.mock.calls[0]![0]!;
        expect(selection).not.toContain('plots'); expect(selection).not.toContain('trades'); expect(selection).not.toContain('variables');
        const result = await f.call('read_script_context', { id: handle.id, plotKeys: ['one', 'two', 'three'], limit: 500 }) as { plots: Record<string, unknown[]> };
        expect(Object.values(result.plots).reduce((total, series) => total + series.length, 0)).toBeLessThanOrEqual(1000);
        await expect(f.call('read_script_context', { id: handle.id, limit: 501 })).rejects.toThrow();
    });
    it('rejects a stale context that arrives after replay moves and times out an unresponsive engine', async () => {
        const f = fixture(); const handle = f.makeHandle('pine', 'indicator("Study")'); let resolve!: (value: EngineContextSnapshot | null) => void;
        handle.context.mockReturnValueOnce(new Promise(done => { resolve = done; }));
        const read = f.call('read_script_context', { id: handle.id }); const rejected = expect(read).rejects.toThrow('Replay advanced'); await settle(); f.advance(); resolve(null); await rejected;
        vi.useFakeTimers(); handle.context.mockReturnValueOnce(new Promise(() => {}));
        const stuck = f.call('read_script_context', { id: handle.id }); const timeout = expect(stuck).rejects.toThrow('did not arrive'); await settle(); await vi.advanceTimersByTimeAsync(6000); await timeout;
    });
    it('rejects context snapshots when source settings or the chart timeframe change while awaiting the worker', async () => {
        for (const change of ['settings', 'timeframe']) {
            const f = fixture(); const handle = f.makeHandle('pine', 'indicator("Study")'); let resolve!: (value: EngineContextSnapshot | null) => void;
            handle.context.mockReturnValueOnce(new Promise(done => { resolve = done; }));
            const read = f.call('read_script_context', { id: handle.id }); const rejected = expect(read).rejects.toThrow(change === 'settings' ? 'script changed' : 'timeframe changed');
            await settle(); if (change === 'settings') handle.setInputs({ length: 21 }); else f.chart.market.timeframe = '5'; resolve(null); await rejected;
        }
    });
});
