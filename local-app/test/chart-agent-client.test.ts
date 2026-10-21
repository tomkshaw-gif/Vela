// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDrawing, registerNativeIndicator, unregisterNativeIndicator,
    type IndicatorHandle, type InputSchema, type InputValue, type SerializedDrawing, type Vela } from '../../src/index';
import type { VelaWorkspace } from '../../src/workspace';
import { createChartAgentController, type ChartAgentController, type ChartAgentControllerOptions } from '../client/chart-agent';
import { ApiError, type LocalApi } from '../client/api';
import { createSession } from '../engine';
import type { ChartAgentCompletion, ChartAgentExchangeInput, ChartAgentTask } from '../shared/chart-agent';
import { DEFAULT_RULES, INSTRUMENTS, type DatasetMeta, type SessionView } from '../shared/types';
import { ChartAgentBroker } from '../server/chart-agent';
import { createAppAgentContext } from '../client/app-agent-context';

const START = Date.parse('2024-04-08T07:00:00Z');
const SESSION_ID = '14da1ad3-7575-48c3-b48a-e02f3a5f52e5';
const STUDY = 'chart-agent-test-study';
const schema: InputSchema[] = [
    { key: 'length', title: 'Length', type: 'int', defval: 14, min: 1, max: 5000 },
    { key: 'source', title: 'Source', type: 'string', defval: 'Close', options: ['Close', 'Open'] },
    { key: 'color', title: 'Color', type: 'color', defval: '#ffffff' },
    { key: 'enabled', title: 'Enabled', type: 'bool', defval: true },
];

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const controllers: ChartAgentController[] = [];
afterEach(() => { controllers.splice(0).forEach((controller) => controller.dispose()); unregisterNativeIndicator(STUDY); vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture(extra: Partial<ChartAgentControllerOptions> = {}) {
    registerNativeIndicator({ type: STUDY, title: 'Test Average', paneHint: 'price', overlay: true,
        inputsSchema: () => schema, defaultInputs: () => ({ length: 14, source: 'Close', color: '#ffffff', enabled: true }),
        create: () => ({ start() {}, onBars() {}, onViewport() {}, setInputs() {}, suspend() {}, resume() {}, stop() {} }) });
    const instrument = INSTRUMENTS[0]!;
    const dataset: DatasetMeta = { id: 'test-data', name: 'Test dataset', symbol: 'NQM4', schema: 'ohlcv-1m', intervalMs: 60000,
        instrument, barCount: 100, start: START, end: START + 99 * 60000, source: 'databento', createdAt: '2024-04-08', checksum: 'test' };
    let view: SessionView | null = { dataset,
        session: { ...createSession({ name: 'Test session', datasetId: dataset.id, mode: 'practice', initialBalance: 50000,
            commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES } }, instrument, SESSION_ID), cursor: 9 } };
    let generation = 1;
    let blocked = false;
    const drawingMap = new Map<string, SerializedDrawing>();
    const handles: IndicatorHandle[] = [];
    const values = new Map<string, Record<string, InputValue>>();
    const readout = { date: '2024-04-08', time: '07:09', ohlc: { o: '18,000.00', h: '18,001.00', l: '17,999.00', c: '18,000.25', up: true },
        groups: [{ name: 'Average', rows: [{ label: 'Average', value: '17,999.75', color: '#ffffff' }] }] };
    let range = { from: START, to: START + 9 * 60000 };
    const nativeHandle = (id: string): IndicatorHandle => {
        values.set(id, { length: 14, source: 'Close', color: '#ffffff', enabled: true });
        const handle = { id, title: 'Test Average', nativeType: STUDY, inputs: schema, props: [], visible: true,
            inputValues: () => ({ ...values.get(id)! }), propValues: () => ({}),
            setInputs: vi.fn((inputs: Record<string, InputValue>) => values.set(id, { ...values.get(id)!, ...inputs })),
            setVisible: vi.fn((visible: boolean) => { (handle as { visible: boolean }).visible = visible; }),
            remove: vi.fn(() => { handles.splice(handles.indexOf(handle), 1); }),
        } as unknown as IndicatorHandle;
        return handle;
    };
    const chartStub = {
        market: { symbol: 'replay:NQM4', timeframe: '1' },
        drawings: {
            supported: true, all: () => [...drawingMap.values()],
            add: vi.fn((type: Parameters<typeof createDrawing>[0], init: Parameters<typeof createDrawing>[1]) => {
                const drawing = createDrawing(type, { ...init, id: `drawing-${drawingMap.size + 1}` });
                if (drawing) drawingMap.set(drawing.id, drawing.serialize());
                return drawing;
            }),
            update: vi.fn((id: string, patch: Partial<SerializedDrawing>) => { drawingMap.set(id, { ...drawingMap.get(id)!, ...patch }); }),
            remove: vi.fn((id: string) => { drawingMap.delete(id); }),
        },
        panes: { list: () => [{ id: 'price' }, { id: 'oscillator' }] },
        indicators: () => [...handles],
        availableNativeIndicators: vi.fn(async () => [{ type: STUDY, title: 'Test Average', supported: true, present: handles.length > 0 }]),
        addNativeIndicator: vi.fn((_type: string, options: { inputs: Record<string, InputValue> }) => {
            const handle = nativeHandle(`indicator-${handles.length + 1}`); handle.setInputs(options.inputs); handles.push(handle); return handle;
        }),
        renderer: { dataWindowReadout: () => readout, screenshotCanvas: vi.fn(() => null as HTMLCanvasElement | null) },
        getVisibleRange: () => range,
        setVisibleRange: vi.fn((next: typeof range) => { range = next; }),
        setVisibleRangePreset: vi.fn(() => { range = { from: START, to: START + 9 * 60000 }; }),
    };
    const chart = chartStub as unknown as Vela;
    const cells = [{ id: 'c1', chart }];
    const workspace = { cells: () => cells, cell: (id: string) => cells.find((cell) => cell.id === id),
        context: () => ({ activeCellId: cells[0]?.id ?? '' }) } as unknown as Pick<VelaWorkspace, 'context' | 'cells' | 'cell'>;
    const apiStub = { get: vi.fn(async (_path: string, _signal?: AbortSignal): Promise<unknown> => ({ bars: [], cursorTime: START + 9 * 60000, intervalMs: 60000, hasMore: false })),
        post: vi.fn(async (_path: string, _body: unknown, _signal?: AbortSignal): Promise<unknown> => ({ request: null })), postKeepalive: vi.fn() };
    const flush = vi.fn(async () => {});
    const setTimeframe = vi.fn(async (_id: string, timeframe: string) => { chartStub.market.timeframe = timeframe; });
    const onError = vi.fn();
    const controller = createChartAgentController({ api: apiStub as unknown as LocalApi, workspace, session: () => view,
        generation: () => generation, blocked: () => blocked, cursorTime: () => START + 9 * 60000,
        setTimeframe, flush, onError, autoStart: false, ...extra });
    controllers.push(controller);
    const task = (operation: ChartAgentTask['operation'], args: Record<string, unknown> = {}, patch: Partial<ChartAgentTask> = {}): ChartAgentTask => ({
        requestId: crypto.randomUUID(), deadline: Date.now() + 10000, operation,
        target: { clientId: controller.clientId, sessionId: SESSION_ID, generation: 1, cellId: 'c1' }, args, ...patch,
    });
    return { controller, task, chart: chartStub, nativeChart: chart, cells, api: apiStub, flush, setTimeframe, onError, handles, drawingMap,
        nativeHandle, view: () => view!, setSession: (next: SessionView | null) => { view = next; },
        setGeneration: (next: number) => { generation = next; }, setBlocked: (next: boolean) => { blocked = next; } };
}

describe('live chart assistant controller', () => {
    it.each(['capture_analysis_scope', 'list_indicators', 'list_scripts'] as const)('expires a stalled %s read without blocking later chart operations', async operation => {
        vi.useFakeTimers(); let signal: AbortSignal | undefined;
        const appContext = createAppAgentContext({ getView: () => null, api: { get: (_path, value) => { signal = value; return new Promise<never>(() => {}); } } });
        const f = fixture({ appContext });
        if (operation === 'capture_analysis_scope') f.api.get.mockImplementationOnce((_path, value) => { signal = value; return new Promise(() => {}); });
        else if (operation === 'list_indicators') f.chart.availableNativeIndicators.mockReturnValueOnce(new Promise(() => {}));
        const pending = f.controller.execute(f.task(operation, {}, { deadline: Date.now() + 20 }));
        const rejected = expect(pending).rejects.toThrow('expired');
        const next = f.controller.execute(f.task('read_chart'));
        await vi.advanceTimersByTimeAsync(21); await rejected;
        expect(await next).toHaveProperty('symbol', 'NQM4');
        if (operation !== 'list_indicators') expect(signal?.aborted).toBe(true);
    });
    it('queues a viewport question with an exact historical scope and refuses it after the session changes', async () => {
        const f = fixture();
        const bar = { time: START + 9 * 60000, open: 100, high: 101, low: 99, close: 100, volume: 1 };
        f.api.get.mockResolvedValueOnce({ bars: [bar], cursorTime: bar.time, baseIntervalMs: 60000, hasMore: false } as never);
        const request = await f.controller.requestAnalysis('Compare momentum in this region') as { target: ChartAgentTask['target']; scopeId: string };
        expect(request.target).toEqual(f.task('read_chart').target);
        const read = await f.controller.execute(f.task('read_analysis_request'));
        expect(read).toMatchObject({ request: { question: 'Compare momentum in this region', scope: { scopeId: request.scopeId, clock: { sourceCutoff: bar.time, availableUntil: bar.time + 60000 } } } });
        expect(f.chart.setVisibleRange).not.toHaveBeenCalled(); expect(f.flush).not.toHaveBeenCalled();
        f.setSession({ ...f.view(), session: { ...f.view().session, revision: f.view().session.revision + 1 } });
        await expect(f.controller.execute(f.task('read_analysis_request'))).rejects.toThrow('scope changed');
    });
    it('reads an explicit historical region without moving the viewport or exposing other candles', async () => {
        const f = fixture();
        const from = START + 2 * 60000, to = START + 4 * 60000;
        const bar = (time: number) => ({ time, open: 100, high: 101, low: 99, close: 100, volume: 1 });
        f.api.get.mockResolvedValueOnce({ bars: [bar(START), bar(from), bar(to), bar(START + 10 * 60000)], cursorTime: START + 9 * 60000, intervalMs: 60000, hasMore: false } as never);
        const result = await f.controller.execute(f.task('read_candles', { from, to, limit: 100 }));
        const query = new URL(f.api.get.mock.calls[0]![0], 'http://local');
        expect(query.pathname).toBe(`/api/sessions/${SESSION_ID}/series`);
        expect(Object.fromEntries(query.searchParams)).toMatchObject({ from: String(from), to: String(to), cursor: '9' });
        expect(result).toMatchObject({ bars: [bar(from), bar(to)], requestedRange: { from, to } });
        expect(f.chart.setVisibleRange).not.toHaveBeenCalled(); expect(f.flush).not.toHaveBeenCalled();
        await expect(f.controller.execute(f.task('read_candles', { from: to, to: from }))).rejects.toThrow('range');
    });
    it('reads the actual chart, native indicator inputs and formatted readout without exporting the account ledger', async () => {
        const f = fixture(); f.handles.push(f.nativeHandle('average'));
        const result = await f.controller.execute(f.task('read_chart')) as Record<string, unknown>;
        expect(result).toMatchObject({ sessionId: SESSION_ID, symbol: 'NQM4', cellId: 'c1', timeframe: '1',
            cursorTime: START + 9 * 60000, visibleRange: { from: START, to: START + 9 * 60000 },
            indicators: [{ id: 'average', nativeType: STUDY, inputs: { length: 14 } }],
            dataWindow: { groups: [{ rows: [{ value: '17,999.75' }] }] } });
        expect(result.dataWindowScope).toContain('Not numeric indicator history');
        expect(result).not.toHaveProperty('account'); expect(result).not.toHaveProperty('orders');
        expect(f.api.get).not.toHaveBeenCalled(); expect(f.flush).not.toHaveBeenCalled();
    });

    it('lists registered drawing tool labels and real anchor bounds without markup or factories', async () => {
        const f = fixture(); const task = f.task('list_drawing_tools'); delete task.target.cellId;
        const tools = await f.controller.execute(task) as Record<string, unknown>[];
        expect(tools).toContainEqual({ type: 'trendline', label: 'Trend Line', group: 'lines', anchors: { min: 2, max: 2 } });
        expect(tools.length).toBeGreaterThan(50);
        expect(JSON.stringify(tools)).not.toContain('<svg'); expect(JSON.stringify(tools)).not.toContain('create');
    });

    it('creates, edits and removes a native drawing and waits for durable layout saves', async () => {
        const f = fixture();
        const result = await f.controller.execute(f.task('add_drawing', { type: 'trendline',
            anchors: [{ time: START, price: 18000 }, { time: START + 60000, price: 18001 }],
            style: { lineColor: '#2962ff', lineWidth: 2, lineStyle: 'dashed', extendRight: true }, text: 'Support' })) as SerializedDrawing;
        expect(result).toMatchObject({ id: 'drawing-1', type: 'trendline', text: { value: 'Support' }, style: { extendRight: true } });
        expect(f.flush).toHaveBeenCalledTimes(1);
        await f.controller.execute(f.task('update_drawing', { id: result.id, style: { lineColor: '#f23645' }, text: { bold: true }, locked: true }));
        expect(f.drawingMap.get(result.id)).toMatchObject({ locked: true, text: { value: 'Support', bold: true },
            style: { lineColor: '#f23645', lineWidth: 2, lineStyle: 'dashed' } });
        await expect(f.controller.execute(f.task('remove_drawing', { id: result.id }))).resolves.toEqual({ removed: result.id });
        expect(f.drawingMap.size).toBe(0); expect(f.flush).toHaveBeenCalledTimes(3);
    });

    it.each([
        { type: 'trendline', anchors: [{ time: START, price: 18000 }], props: { code: 'run()' } },
        { type: 'unregistered', anchors: [{ time: START, price: 18000 }] },
        { type: 'hline', anchors: [{ time: START, price: Infinity }] },
        { type: 'hline', anchors: [{ time: NaN, price: 18000 }] },
        { type: 'trendline', anchors: [{ time: START, price: 18000 }] },
        { type: 'hline', anchors: [{ time: START, price: 18000, eval: 'run()' }] },
        { type: 'hline', anchors: [{ time: START, price: 18000 }], style: { lineColor: 'url(https://invalid.test)' } },
        { type: 'hline', anchors: [{ time: START, price: 18000 }], style: { lineWidth: 1000000 } },
        { type: 'hline', anchors: [{ time: START, price: 18000 }], text: { value: 'a', html: '<img>' } },
        { type: 'hline', anchors: [{ time: START, price: 18000 }], paneId: 'missing' },
    ])('rejects unsafe or malformed drawing arguments %# without touching the chart', async (args) => {
        const f = fixture(); await expect(f.controller.execute(f.task('add_drawing', args))).rejects.toThrow();
        expect(f.chart.drawings.add).not.toHaveBeenCalled(); expect(f.flush).not.toHaveBeenCalled();
    });

    it('rejects overlong freehand paths and does not copy arbitrary drawing properties into a patch', async () => {
        const f = fixture();
        await expect(f.controller.execute(f.task('add_drawing', { type: 'freehand', anchors: Array.from({ length: 129 }, () => ({ time: START, price: 1 })) }))).rejects.toThrow('128');
        await f.controller.execute(f.task('add_drawing', { type: 'hline', anchors: [{ time: START, price: 18000 }] }));
        await expect(f.controller.execute(f.task('update_drawing', { id: 'drawing-1', props: { shell: 'run' } }))).rejects.toThrow('Unsupported argument');
        expect(f.chart.drawings.update).not.toHaveBeenCalled();
    });

    it.each(['generation', 'session', 'client', 'cell', 'deadline', 'blocked', 'market', 'disposed'] as const)('rejects %s mismatches before doing any work', async (reason) => {
        const f = fixture(); const task = f.task('add_drawing', { type: 'hline', anchors: [{ time: START, price: 18000 }] });
        if (reason === 'generation') f.setGeneration(2);
        if (reason === 'session') f.setSession({ ...f.view(), session: { ...f.view().session, id: 'different-session' } });
        if (reason === 'client') task.target.clientId = crypto.randomUUID();
        if (reason === 'cell') f.cells.splice(0);
        if (reason === 'deadline') task.deadline = Date.now() - 1;
        if (reason === 'blocked') f.setBlocked(true);
        if (reason === 'market') f.chart.market.symbol = 'other:NQM4';
        if (reason === 'disposed') f.controller.dispose();
        await expect(f.controller.execute(task)).rejects.toThrow(); expect(f.chart.drawings.add).not.toHaveBeenCalled();
    });

    it('keeps queued operations pinned when the session changes during a pending candle request', async () => {
        const pending = deferred<unknown>(); const f = fixture();
        f.api.get.mockImplementationOnce(() => pending.promise as ReturnType<typeof f.api.get>);
        const first = f.controller.execute(f.task('read_candles'));
        const second = f.controller.execute(f.task('add_drawing', { type: 'hline', anchors: [{ time: START, price: 18000 }] }));
        const firstRejected = expect(first).rejects.toThrow('older workspace'); const secondRejected = expect(second).rejects.toThrow('older workspace');
        await Promise.resolve(); await Promise.resolve(); f.setGeneration(2);
        pending.resolve({ bars: [], cursorTime: START, intervalMs: 60000 });
        await Promise.all([firstRejected, secondRejected]); expect(f.chart.drawings.add).not.toHaveBeenCalled();
    });

    it('reads a bounded alternate timeframe from the revealed endpoint and drops future bars', async () => {
        const f = fixture();
        const bar = (time: number) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 });
        f.api.get.mockResolvedValueOnce({ bars: [bar(START), bar(START + 10 * 60000)], cursorTime: START + 9 * 60000, intervalMs: 300000, hasMore: true } as never);
        const result = await f.controller.execute(f.task('read_candles', { timeframe: '5', limit: 50 }));
        expect(f.api.get.mock.calls[0]?.[0]).toBe(`/api/sessions/${SESSION_ID}/chart?timeframe=5m&limit=50`);
        expect(result).toMatchObject({ timeframe: '5', intervalMs: 300000, hasMore: true, bars: [bar(START)] });
        expect(f.chart.market.timeframe).toBe('1');
        await expect(f.controller.execute(f.task('read_candles', { timeframe: '1S' }))).rejects.toThrow('not supported');
        await expect(f.controller.execute(f.task('read_candles', { limit: 1001 }))).rejects.toThrow();
        expect(f.api.get).toHaveBeenCalledTimes(1);
    });

    it('rejects a read after replay advanced instead of passing newer candles into an older analysis', async () => {
        const f = fixture(); const pending = deferred<unknown>();
        f.api.get.mockImplementationOnce(() => pending.promise as ReturnType<typeof f.api.get>);
        const request = f.controller.execute(f.task('read_candles')); const rejected = expect(request).rejects.toThrow('Replay advanced');
        await Promise.resolve(); await Promise.resolve();
        f.setSession({ ...f.view(), session: { ...f.view().session, cursor: 10 } });
        pending.resolve({ bars: [], cursorTime: START + 10 * 60000 }); await rejected;
    });

    it('rejects newer server aggregates even if another window advanced without updating this window', async () => {
        const f = fixture();
        f.api.get.mockResolvedValueOnce({ bars: [{ time: START, open: 1, high: 999, low: 1, close: 999, volume: 100 }],
            cursorTime: START + 10 * 60000, intervalMs: 300000, hasMore: false });
        await expect(f.controller.execute(f.task('read_candles', { timeframe: '5' }))).rejects.toThrow('differs from the loaded chart');
        expect(f.view().session.cursor).toBe(9);
    });

    it('uses the injected serialized timeframe path and persists the visible result', async () => {
        const f = fixture(); await expect(f.controller.execute(f.task('set_timeframe', { timeframe: '15' }))).resolves.toEqual({ cellId: 'c1', timeframe: '15' });
        expect(f.setTimeframe).toHaveBeenCalledWith('c1', '15', expect.any(Function)); expect(f.flush).toHaveBeenCalledOnce();
    });
    it('accepts native custom calendar resolutions and advertises all sixteen workspace cells', async () => {
        const f = fixture();
        await expect(f.controller.execute(f.task('set_timeframe', { timeframe: '3M' }))).resolves.toEqual({ cellId: 'c1', timeframe: '3M' });
        for (let index = 2; index <= 16; index++) f.cells.push({ id: `c${index}`, chart: f.nativeChart });
        await f.controller.poll();
        const body = f.api.post.mock.calls[0]![1] as unknown as { chart: { cells: unknown[] } }; expect(body.chart.cells).toHaveLength(16);
        f.api.get.mockResolvedValueOnce({ bars: [], cursorTime: START + 9 * 60000, intervalMs: 31 * 86400000, hasMore: false });
        await f.controller.execute(f.task('read_candles', { timeframe: 'M' })); expect(f.api.get.mock.calls[0]![0]).toContain('timeframe=1M');
    });

    it('validates native indicator input types, choices, bounds and unknown properties', async () => {
        const f = fixture();
        for (const inputs of [{ length: 0 }, { length: 3.5 }, { length: 6000 }, { source: 'code' }, { enabled: 'true' }, { color: 'var(--secret)' }, { script: 'run()' }]) {
            await expect(f.controller.execute(f.task('add_indicator', { type: STUDY, inputs }))).rejects.toThrow();
        }
        await expect(f.controller.execute(f.task('add_indicator', { type: STUDY, source: 'run()' }))).rejects.toThrow('Unsupported argument');
        await expect(f.controller.execute(f.task('add_indicator', { type: 'script', inputs: {} }))).rejects.toThrow('Use run_script');
        expect(f.chart.addNativeIndicator).not.toHaveBeenCalled(); expect(f.flush).not.toHaveBeenCalled();
    });

    it('adds, edits, hides and removes a supported native indicator, returning its actual inputs', async () => {
        const f = fixture();
        await expect(f.controller.execute(f.task('add_indicator', { type: STUDY, inputs: { length: 21, source: 'Open' } }))).resolves.toMatchObject({
            id: 'indicator-1', nativeType: STUDY, inputs: { length: 21, source: 'Open' } });
        await expect(f.controller.execute(f.task('update_indicator', { id: 'indicator-1', inputs: { length: 50 }, visible: false }))).resolves.toMatchObject({ visible: false, inputs: { length: 50 } });
        const catalog = await f.controller.execute(f.task('list_indicators')) as { instances: unknown[]; available: unknown[] };
        expect(catalog.instances).toHaveLength(1); expect(catalog.available).toMatchObject([{ type: STUDY, inputs: schema }]);
        await expect(f.controller.execute(f.task('remove_indicator', { id: 'indicator-1' }))).resolves.toEqual({ removed: 'indicator-1' });
        expect(f.handles).toHaveLength(0); expect(f.flush).toHaveBeenCalledTimes(3);
    });

    it('rechecks the live generation after asynchronous native capability checks', async () => {
        const f = fixture(); const pending = deferred<Awaited<ReturnType<typeof f.chart.availableNativeIndicators>>>();
        f.chart.availableNativeIndicators.mockReturnValueOnce(pending.promise);
        const request = f.controller.execute(f.task('add_indicator', { type: STUDY })); const rejected = expect(request).rejects.toThrow('older workspace');
        await Promise.resolve(); await Promise.resolve(); f.setGeneration(2); pending.resolve([{ type: STUDY, title: 'Average', supported: true, present: false }]);
        await rejected; expect(f.chart.addNativeIndicator).not.toHaveBeenCalled();
    });

    it('refuses arbitrary script handles and unsupported native types', async () => {
        const f = fixture(); f.handles.push({ id: 'script', nativeType: undefined } as IndicatorHandle);
        await expect(f.controller.execute(f.task('remove_indicator', { id: 'script' }))).rejects.toThrow('Indicator not found');
        f.chart.availableNativeIndicators.mockResolvedValueOnce([{ type: STUDY, title: 'Average', supported: false, present: false }]);
        await expect(f.controller.execute(f.task('add_indicator', { type: STUDY }))).rejects.toThrow('not supported');
        expect(f.chart.addNativeIndicator).not.toHaveBeenCalled();
    });

    it('reports persistence failures explicitly after a chart edit instead of claiming it was saved', async () => {
        const f = fixture(); f.flush.mockRejectedValueOnce(new Error('Revision conflict'));
        await expect(f.controller.execute(f.task('add_drawing', { type: 'hline', anchors: [{ time: START, price: 18000 }] }))).rejects.toThrow('chart changed, but saving failed: Revision conflict');
        expect(f.drawingMap.size).toBe(1);
    });

    it('sets or fits the public viewport and rejects infinite or inverted ranges', async () => {
        const f = fixture();
        await f.controller.execute(f.task('set_viewport', { from: START, to: START + 60000 }));
        expect(f.chart.setVisibleRange).toHaveBeenCalledWith({ from: START, to: START + 60000 });
        await f.controller.execute(f.task('set_viewport', { fit: true })); expect(f.chart.setVisibleRangePreset).toHaveBeenCalledWith('ALL');
        for (const args of [{ from: START, to: Infinity }, { from: START, to: START }, { fit: true, to: START }]) {
            await expect(f.controller.execute(f.task('set_viewport', args))).rejects.toThrow();
        }
        expect(f.flush).toHaveBeenCalledTimes(2);
    });

    it('returns a bounded, downscaled renderer screenshot with an accurate capture scope', async () => {
        const f = fixture(); const source = document.createElement('canvas'); source.width = 2560; source.height = 1600;
        f.chart.renderer.screenshotCanvas.mockReturnValueOnce(source);
        const drawImage = vi.fn(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
        vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,c2FmZQ==');
        await expect(f.controller.execute(f.task('screenshot'))).resolves.toEqual({ mimeType: 'image/jpeg', width: 1280, height: 800,
            data: 'c2FmZQ==', scope: 'Renderer capture with supported rasterized legends and overlays; excludes arbitrary app DOM and crosshair.' });
        expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 1280, 800);
        expect(f.flush).not.toHaveBeenCalled();
    });

    it('rejects missing screenshots, unknown arguments, and oversized chart responses', async () => {
        const f = fixture();
        await expect(f.controller.execute(f.task('screenshot'))).rejects.toThrow('unavailable');
        await expect(f.controller.execute(f.task('screenshot', { selector: 'body' }))).rejects.toThrow('Unsupported argument');
        for (let i = 0; i < 150; i++) {
            const drawing = createDrawing('text', { paneId: 'price', id: `large-${i}`, anchors: [{ time: START, price: 1 }],
                text: { value: 'a'.repeat(2000), size: 'normal', hAlign: 'left', vAlign: 'top' } })!;
            f.drawingMap.set(drawing.id, drawing.serialize());
        }
        await expect(f.controller.execute(f.task('read_chart', { drawingLimit: 500 }))).rejects.toThrow('too large');
    });

    it('publishes only lightweight chart metadata, executes once, and completes through authenticated exchange', async () => {
        const f = fixture(); const task = f.task('set_viewport', { fit: true });
        f.api.post.mockResolvedValueOnce({ request: task } as never);
        await f.controller.poll(); expect(f.chart.setVisibleRangePreset).toHaveBeenCalledTimes(1);
        const body = f.api.post.mock.calls[0]?.[1] as unknown as ChartAgentExchangeInput;
        expect(body).toMatchObject({ action: 'poll', clientId: f.controller.clientId, chart: { sessionId: SESSION_ID, generation: 1, symbol: 'NQM4',
            cells: [{ id: 'c1', timeframe: '1' }], cursorTime: START + 9 * 60000 } });
        expect(body).not.toHaveProperty('bars'); expect(body).not.toHaveProperty('account');
        expect(body).toHaveProperty('clientToken');
        await f.controller.poll();
        const completed = f.api.post.mock.calls[1]?.[1] as unknown as { completion: ChartAgentCompletion };
        expect(completed.completion).toMatchObject({ requestId: task.requestId, success: true });
        expect(f.api.get).not.toHaveBeenCalled(); expect(f.chart.setVisibleRangePreset).toHaveBeenCalledTimes(1);
    });

    it('keeps one exchange in flight and retries a lost completion without repeating the chart mutation', async () => {
        const f = fixture(); const response = deferred<unknown>(); const task = f.task('set_viewport', { fit: true });
        f.api.post.mockImplementationOnce(() => response.promise as ReturnType<typeof f.api.post>);
        const first = f.controller.poll(); const second = f.controller.poll(); expect(first).toBe(second); expect(f.api.post).toHaveBeenCalledTimes(1);
        response.resolve({ request: task }); await first;
        f.api.post.mockRejectedValueOnce(new Error('Temporary failure'));
        await f.controller.poll(); await f.controller.poll();
        const secondBody = f.api.post.mock.calls[1]?.[1] as unknown as { completion: ChartAgentCompletion };
        const thirdBody = f.api.post.mock.calls[2]?.[1] as unknown as { completion: ChartAgentCompletion };
        expect(secondBody.completion).toEqual(thirdBody.completion); expect(f.chart.setVisibleRangePreset).toHaveBeenCalledTimes(1);
    });
    it('replaces a permanently rejected success with a bounded failure and dispatches later tools', async () => {
        const f = fixture(); const broker = new ChartAgentBroker();
        const handle = f.nativeHandle('privacy-rejected'); Object.assign(handle, { inputValues: () => ({ token: 'benign-public-input' }) }); f.handles.push(handle);
        f.api.post.mockImplementation(async (_path, body) => {
            try { return broker.exchange(body); }
            catch (error) { throw new ApiError('Rejected chart response', (error as { status: number }).status); }
        });
        try {
            await f.controller.poll(); const firstTask = f.task('read_chart');
            const first = broker.call({ operation: 'read_chart', target: firstTask.target, args: {} }).catch(error => error as Error);
            await f.controller.poll(); await f.controller.poll(); await f.controller.poll();
            expect(await first).toMatchObject({ message: expect.stringContaining('local bridge validation') });
            const attempts = f.api.post.mock.calls.map(call => call[1] as ChartAgentExchangeInput).filter(body => body.action === 'poll' && body.completion);
            expect(attempts).toHaveLength(2);
            expect(attempts[0]).toMatchObject({ completion: { success: true } }); expect(attempts[1]).toMatchObject({ completion: { success: false } });
            const nextTask = f.task('set_viewport'); const next = broker.call({ operation: 'set_viewport', target: nextTask.target, args: { fit: true } });
            await f.controller.poll(); await f.controller.poll();
            expect(await next).toMatchObject({ visibleRange: expect.any(Object) }); expect(f.chart.setVisibleRangePreset).toHaveBeenCalledTimes(1);
        } finally { broker.close(); }
    });

    it.each(['set_viewport', 'set_timeframe'] as const)('keeps the authenticated chart lease alive while %s waits more than eight seconds for persistence', async operation => {
        vi.useFakeTimers(); const f = fixture(); const broker = new ChartAgentBroker(); const save = deferred<void>();
        f.flush.mockImplementationOnce(() => save.promise);
        f.api.post.mockImplementation(async (_path, body) => broker.exchange(body));
        try {
            await f.controller.poll();
            const source = f.task(operation, operation === 'set_timeframe' ? { timeframe: '5' } : { fit: true });
            const result = broker.call({ requestId: source.requestId, operation: source.operation, target: source.target, args: source.args }); const running = f.controller.poll();
            await vi.advanceTimersByTimeAsync(8501);
            expect(f.flush).toHaveBeenCalledTimes(1); expect(broker.list()).toHaveLength(1);
            const heartbeats = f.api.post.mock.calls.map(call => call[1] as ChartAgentExchangeInput).filter(body => body.action === 'heartbeat');
            expect(heartbeats).toHaveLength(4);
            expect(heartbeats.every(body => !('completion' in body))).toBe(true);
            expect(heartbeats[0]).toMatchObject({ chart: { timeframe: '1', cells: [{ id: 'c1', timeframe: '1' }] } });
            save.resolve(); await running; await f.controller.poll();
            await expect(result).resolves.toMatchObject(operation === 'set_timeframe' ? { timeframe: '5' } : { visibleRange: expect.any(Object) });
            const count = f.api.post.mock.calls.length; await vi.advanceTimersByTimeAsync(5000); expect(f.api.post).toHaveBeenCalledTimes(count);
            expect(operation === 'set_timeframe' ? f.setTimeframe : f.chart.setVisibleRangePreset).toHaveBeenCalledTimes(1);
        } finally { broker.close(); }
    });

    it('reconciles a successful late save after the tool deadline without repeating the mutation', async () => {
        vi.useFakeTimers(); const f = fixture(); const broker = new ChartAgentBroker(); const save = deferred<void>();
        f.flush.mockImplementationOnce(() => save.promise); f.api.post.mockImplementation(async (_path, body) => broker.exchange(body));
        try {
            await f.controller.poll(); const source = f.task('set_viewport', { fit: true });
            const result = broker.call({ requestId: source.requestId, operation: source.operation, target: source.target, args: source.args }).catch(error => error); const running = f.controller.poll();
            await vi.advanceTimersByTimeAsync(10500);
            expect(await result).toMatchObject({ code: 'CHART_REQUEST_TIMEOUT', message: expect.stringContaining(source.requestId) });
            const inspect = () => broker.call({ operation: 'read_operation', target: source.target, args: { requestId: source.requestId } });
            await expect(inspect()).resolves.toMatchObject({ state: 'unknown' });
            save.resolve(); await running; await f.controller.poll();
            await expect(inspect()).resolves.toMatchObject({ state: 'completed', value: { visibleRange: expect.any(Object) } });
            expect(f.chart.setVisibleRangePreset).toHaveBeenCalledTimes(1); expect(f.flush).toHaveBeenCalledTimes(1);
        } finally { broker.close(); }
    });

    it.each(['blocked', 'generation', 'session', 'cell', 'disposed'] as const)('tears down executing-operation heartbeats when %s makes the registration stale', async reason => {
        vi.useFakeTimers(); const f = fixture(); const save = deferred<void>(); const task = f.task('set_viewport', { fit: true });
        f.flush.mockImplementationOnce(() => save.promise); f.api.post.mockResolvedValueOnce({ request: task });
        const running = f.controller.poll(); await vi.advanceTimersByTimeAsync(2000);
        expect(f.api.post.mock.calls.filter(call => (call[1] as ChartAgentExchangeInput).action === 'heartbeat')).toHaveLength(1);
        if (reason === 'blocked') f.setBlocked(true);
        if (reason === 'generation') f.setGeneration(2);
        if (reason === 'session') f.setSession({ ...f.view(), session: { ...f.view().session, id: crypto.randomUUID() } });
        if (reason === 'cell') f.cells.splice(0);
        if (reason === 'disposed') f.controller.dispose();
        await vi.advanceTimersByTimeAsync(6500);
        expect(f.api.post.mock.calls.filter(call => (call[1] as ChartAgentExchangeInput).action === 'heartbeat')).toHaveLength(1);
        save.resolve(); await running;
        if (reason !== 'disposed') {
            f.setBlocked(false); f.setGeneration(1);
            if (reason === 'session') f.setSession({ ...f.view(), session: { ...f.view().session, id: SESSION_ID } });
        }
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps heartbeat requests serialized and cancels their current fetch on disposal', async () => {
        vi.useFakeTimers(); const f = fixture(); const save = deferred<void>(); const waiting = deferred<unknown>();
        f.flush.mockImplementationOnce(() => save.promise); f.api.post.mockResolvedValueOnce({ request: f.task('set_viewport', { fit: true }) });
        f.api.post.mockImplementationOnce(() => waiting.promise);
        const running = f.controller.poll(); await vi.advanceTimersByTimeAsync(2000);
        const heartbeatSignal = f.api.post.mock.calls[1]![2]!;
        await vi.advanceTimersByTimeAsync(3500); expect(heartbeatSignal.aborted).toBe(true);
        expect(f.api.post).toHaveBeenCalledTimes(2);
        f.controller.dispose(); expect(heartbeatSignal.aborted).toBe(true);
        waiting.resolve({ request: null }); save.resolve(); await running; await vi.advanceTimersByTimeAsync(5000);
        expect(f.api.post).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    });

    it.each([403, 409, 503])('stops renewing when heartbeat authentication or registration is rejected with %s', async status => {
        vi.useFakeTimers(); const f = fixture(); const save = deferred<void>();
        f.flush.mockImplementationOnce(() => save.promise); f.api.post.mockResolvedValueOnce({ request: f.task('set_viewport', { fit: true }) });
        f.api.post.mockRejectedValueOnce(new ApiError('Registration cannot be renewed.', status));
        const running = f.controller.poll(); await vi.advanceTimersByTimeAsync(8500);
        expect(f.api.post).toHaveBeenCalledTimes(2); save.resolve(); await running; expect(vi.getTimerCount()).toBe(0);
    });

    it('drops stale completions on conflict, deduplicates connection errors, and releases on dispose', async () => {
        const f = fixture(); const task = f.task('set_viewport', { fit: true });
        f.api.post.mockResolvedValueOnce({ request: task } as never); await f.controller.poll();
        f.api.post.mockRejectedValueOnce(new ApiError('Expired completion', 409)); await f.controller.poll();
        f.api.post.mockRejectedValueOnce(new ApiError('Expired completion', 409)); await f.controller.poll();
        const last = f.api.post.mock.calls[2]?.[1] as unknown as Record<string, unknown>;
        expect(last).not.toHaveProperty('completion'); expect(f.onError).toHaveBeenCalledTimes(1);
        f.controller.dispose(); f.controller.dispose(); expect(f.api.postKeepalive).toHaveBeenCalledTimes(1);
        expect(f.api.postKeepalive).toHaveBeenCalledWith('/api/assistant/exchange', expect.objectContaining({ action: 'release', clientId: f.controller.clientId }));
    });

    it('does not poll when blocked and cancels an in-flight fetch and timer on disposal', async () => {
        vi.useFakeTimers(); const f = fixture({ autoStart: true }); f.setBlocked(true);
        await vi.advanceTimersByTimeAsync(1000); expect(f.api.post).not.toHaveBeenCalled();
        f.setBlocked(false); const pending = deferred<unknown>();
        f.api.post.mockImplementationOnce(() => pending.promise as ReturnType<typeof f.api.post>);
        await vi.advanceTimersByTimeAsync(1000); expect(f.api.post).toHaveBeenCalledTimes(1);
        const signal = f.api.post.mock.calls[0]?.[2] as unknown as AbortSignal;
        f.controller.dispose(); expect(signal.aborted).toBe(true);
        pending.resolve({ request: null }); await vi.advanceTimersByTimeAsync(5000);
        expect(f.api.post).toHaveBeenCalledTimes(1); expect(f.onError).not.toHaveBeenCalled();
    });
});
