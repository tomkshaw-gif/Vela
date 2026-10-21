import { getNativeIndicator, type DrawingPoint, type DrawingStyle, type DrawingText,
    type IndicatorHandle, type InputSchema, type InputValue, type SerializedDrawing, type Vela, type ContextSelect, type EngineContextSnapshot } from '../../src/index';
import { drawingTypes, getDrawingType } from '../../src/plugin';
import type { VelaWorkspace } from '../../src/workspace';
import type { ChartAgentClient, ChartAgentCompletion, ChartAgentExchangeInput, ChartAgentExchangeResult,
    ChartAgentTask } from '../shared/chart-agent';
import type { ChartView, SessionView } from '../shared/types';
import { ApiError, type LocalApi } from './api';
import { markTransientScript } from './script-persistence';
import { parseTimeframe, timeframeSupported, toServerTimeframe } from '../shared/timeframes';
import { createChartAnalysis } from './chart-analysis';
import type { AppAgentContext } from './app-agent-context';
import type { ScriptWorkspace } from './script-workspace';
import { sameTarget } from '../shared/chart-analysis';

const JSON_LIMIT = 256 * 1024;
const SCREENSHOT_LIMIT = 1.5 * 1024 * 1024;
const MAX_TIME = 4_102_444_800_000;
const PRIVATE_FIELD = /^(?:__proto__|constructor|prototype|api[_-]?key|authorization|cookie|password|secret|token|credentials?)$/i;
const SCRIPT_JOB_MS = 30_000;

export interface ChartAgentControllerOptions {
    api: Pick<LocalApi, 'get' | 'post' | 'postKeepalive'>;
    workspace: Pick<VelaWorkspace, 'context' | 'cells' | 'cell'>;
    session: () => SessionView | null;
    generation: () => number;
    blocked: () => boolean;
    cursorTime?: () => number | null;
    setTimeframe: (cellId: string, timeframe: string, assertCurrent: () => void) => Promise<void>;
    flush: () => Promise<void>;
    onError?: (error: unknown) => void;
    autoStart?: boolean;
    appContext?: AppAgentContext;
    strategy?: Pick<ScriptWorkspace, 'startBacktestForIndicator' | 'cancelBacktest'>;
}

export interface ChartAgentController {
    readonly clientId: string;
    poll(): Promise<void>;
    execute(task: ChartAgentTask): Promise<unknown>;
    requestAnalysis(question: string, args?: Record<string, unknown>): Promise<unknown>;
    dispose(): void;
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
    return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported argument: ${key}.`);
}

function text(value: unknown, label: string, max = 128, empty = false): string {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.length) || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) {
        throw new Error(`${label} must be plain text of at most ${max} characters.`);
    }
    return value;
}

function finite(value: unknown, label: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`);
    return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
    const result = finite(value, label, min, max);
    if (!Number.isSafeInteger(result)) throw new Error(`${label} must be an integer.`);
    return result;
}

function boolean(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
    return value;
}

function requestedRange(args: Record<string, unknown>): { from?: number; to?: number } {
    const from = args.from === undefined ? undefined : integer(args.from, 'Range start', 0, MAX_TIME);
    const to = args.to === undefined ? undefined : integer(args.to, 'Range end', 0, MAX_TIME);
    if (from !== undefined && to !== undefined && from > to) throw new Error('The requested range start must not exceed its end.');
    return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

function choice<T extends string>(value: unknown, label: string, values: readonly T[]): T {
    if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${label} must be one of: ${values.join(', ')}.`);
    return value as T;
}

function color(value: unknown): string {
    const result = text(value, 'Color', 64);
    if (!/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|transparent|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0(?:\.\d+)?|1(?:\.0+)?))?\s*\))$/i.test(result)) {
        throw new Error('Color must be a hexadecimal color, rgb(), rgba(), or transparent.');
    }
    return result;
}

function anchors(value: unknown, type: string): DrawingPoint[] {
    if (!Array.isArray(value) || value.length > 128) throw new Error('Drawing anchors must contain at most 128 points.');
    const meta = getDrawingType(type);
    if (!meta) throw new Error('Unknown drawing tool.');
    const bounds = meta.create({ paneId: 'price' }).anchorSchema();
    if (value.length < bounds.min || value.length > Math.min(128, bounds.max)) throw new Error(`This drawing requires ${bounds.min} to ${Math.min(128, bounds.max)} anchors.`);
    return value.map((item) => {
        const point = record(item, 'Anchor'); keys(point, ['time', 'price']);
        return { time: finite(point.time, 'Anchor time', 0, MAX_TIME), price: finite(point.price, 'Anchor price', -1e9, 1e9) };
    });
}

function style(value: unknown): Partial<DrawingStyle> {
    const input = record(value, 'Drawing style');
    keys(input, ['lineColor', 'lineWidth', 'lineStyle', 'fillColor', 'fillOpacity', 'arrowLeft', 'arrowRight', 'extendLeft', 'extendRight']);
    const result: Partial<DrawingStyle> = {};
    if (input.lineColor !== undefined) result.lineColor = color(input.lineColor);
    if (input.fillColor !== undefined) result.fillColor = color(input.fillColor);
    if (input.lineWidth !== undefined) result.lineWidth = finite(input.lineWidth, 'Line width', 1, 10);
    if (input.fillOpacity !== undefined) result.fillOpacity = finite(input.fillOpacity, 'Fill opacity', 0, 1);
    if (input.lineStyle !== undefined) result.lineStyle = choice(input.lineStyle, 'Line style', ['solid', 'dashed', 'dotted'] as const);
    for (const key of ['arrowLeft', 'arrowRight', 'extendLeft', 'extendRight'] as const) {
        if (input[key] !== undefined) result[key] = boolean(input[key], key);
    }
    return result;
}

function annotation(value: unknown, previous?: DrawingText): DrawingText {
    const input = typeof value === 'string' ? { value } : record(value, 'Drawing text');
    keys(input, ['value', 'color', 'size', 'hAlign', 'vAlign', 'bold', 'italic', 'place', 'side']);
    const result: DrawingText = { value: '', size: 'normal', hAlign: 'left', vAlign: 'top', ...previous };
    if (input.value !== undefined) result.value = text(input.value, 'Annotation', 2000, true);
    if (input.color !== undefined) result.color = color(input.color);
    if (input.size !== undefined) result.size = choice(input.size, 'Text size', ['tiny', 'small', 'normal', 'large', 'huge', 'auto']);
    if (input.hAlign !== undefined) result.hAlign = choice(input.hAlign, 'Horizontal alignment', ['left', 'center', 'right']);
    if (input.vAlign !== undefined) result.vAlign = choice(input.vAlign, 'Vertical alignment', ['top', 'center', 'bottom']);
    if (input.bold !== undefined) result.bold = boolean(input.bold, 'Bold');
    if (input.italic !== undefined) result.italic = boolean(input.italic, 'Italic');
    if (input.place !== undefined) result.place = choice(input.place, 'Text placement', ['start', 'middle', 'end'] as const);
    if (input.side !== undefined) result.side = choice(input.side, 'Text side', ['above', 'below'] as const);
    return result;
}

function inputValues(value: unknown, schema: readonly InputSchema[], numericMaximum = 20_000): Record<string, InputValue> {
    const values = record(value, 'Indicator inputs');
    if (Object.keys(values).length > 64) throw new Error('At most 64 indicator inputs may be changed at once.');
    const result: Record<string, InputValue> = Object.create(null) as Record<string, InputValue>;
    for (const [key, value] of Object.entries(values)) {
        const entry = schema.find((item) => item.key === key);
        if (!entry || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`Unknown indicator input: ${key}.`);
        if (entry.type === 'bool') result[key] = boolean(value, entry.title);
        else if (['int', 'float', 'price', 'time'].includes(entry.type)) {
            const upper = entry.type === 'time' ? MAX_TIME : entry.type === 'price' ? 1e9 : numericMaximum;
            const min = Math.max(entry.type === 'time' ? 0 : -1e9, entry.min ?? -1e9);
            const max = Math.min(upper, entry.max ?? upper);
            result[key] = entry.type === 'int' || entry.type === 'time' ? integer(value, entry.title, min, max) : finite(value, entry.title, min, max);
        } else if (entry.type === 'color') result[key] = color(value);
        else {
            const next = text(value, entry.title, 2000, true);
            if (entry.options && !entry.options.includes(next)) throw new Error(`Invalid choice for ${entry.title}.`);
            if (entry.type === 'source' && !entry.options && !['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'volume'].includes(next)) throw new Error('Unsupported indicator source.');
            result[key] = next;
        }
    }
    return result;
}

function schemaSummary(schema: readonly InputSchema[]): unknown[] {
    return schema.slice(0, 64).map(({ key, title, type, defval, min, max, step, options }) =>
        ({ key, title, type, defval, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }),
            ...(step === undefined ? {} : { step }), ...(options === undefined ? {} : { options }) }));
}
function indicatorSummary(handle: IndicatorHandle): unknown {
    return { id: handle.id, title: handle.title, nativeType: handle.nativeType ?? null,
        kind: handle.source === undefined ? 'native' : 'script', visible: handle.visible, inputs: handle.inputValues(),
        properties: handle.propValues(), propertySchema: schemaSummary(handle.props), schema: schemaSummary(handle.inputs) };
}

function drawingSummary(drawing: SerializedDrawing): unknown {
    return { id: drawing.id, type: drawing.type, paneId: drawing.paneId, anchors: drawing.anchors.slice(0, 128),
        style: drawing.style, ...(drawing.text ? { text: { ...drawing.text, value: drawing.text.value.slice(0, 2000) } } : {}),
        locked: drawing.locked, visible: drawing.visible };
}

function bounded(value: unknown, limit = JSON_LIMIT): unknown {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > limit) throw new Error('Chart response is too large. Request fewer objects.');
    return value;
}

function scriptSettings(value: unknown): Record<string, InputValue> {
    const input = record(value, 'Script settings');
    if (Object.keys(input).length > 64) throw new Error('At most 64 script settings may be supplied.');
    const result: Record<string, InputValue> = Object.create(null) as Record<string, InputValue>;
    for (const [key, value] of Object.entries(input)) {
        if (!key.length || key.length > 100 || PRIVATE_FIELD.test(key)) throw new Error('Invalid script setting key.');
        if (typeof value === 'boolean') result[key] = value;
        else if (typeof value === 'number') result[key] = finite(value, 'Script setting', -1e12, 1e12);
        else result[key] = text(value, 'Script setting', 2000, true);
    }
    return result;
}

function scriptSource(value: unknown): string {
    const source = text(value, 'Pine source', 60_000);
    if (!source.trim()) throw new Error('Pine source must not be empty.');
    return source;
}

interface ScriptJob {
    id: string; indicatorId: string; replacesId?: string; state: 'running' | 'completed' | 'failed' | 'cancelled';
    createdAt: number; deadline: number; saved: boolean; error?: string; value?: unknown;
    target: ChartAgentTask['target']; chart: Vela; cleanup: (() => void)[]; timer?: ReturnType<typeof setTimeout>;
    cancel(reason: string, failed?: boolean): void;
}
interface BacktestJob {
    jobId: string; target: ChartAgentTask['target']; state: 'running' | 'completed' | 'failed' | 'cancelled';
    createdAt: number; completedAt?: number; error?: string; value?: unknown; timer?: ReturnType<typeof setTimeout>;
}

function screenshot(chart: Vela, args: Record<string, unknown>): unknown {
    keys(args, ['format']);
    const format = args.format === undefined ? 'jpeg' : choice(args.format, 'Screenshot format', ['jpeg', 'png']);
    const source = chart.renderer.screenshotCanvas();
    if (!source || source.width < 1 || source.height < 1) throw new Error('Chart canvas is unavailable.');
    let scale = Math.min(1, 1280 / source.width, 800 / source.height);
    for (let attempt = 0; attempt < 4; attempt++) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(source.width * scale)); canvas.height = Math.max(1, Math.floor(source.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Chart screenshot rendering is unavailable.');
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const mimeType = `image/${format}`; const dataUrl = canvas.toDataURL(mimeType, 0.85);
        if (!dataUrl.startsWith(`data:${mimeType};base64,`)) throw new Error('Chart screenshot encoding failed.');
        const result = { mimeType, width: canvas.width, height: canvas.height, data: dataUrl.slice(dataUrl.indexOf(',') + 1), scope: 'Renderer capture with supported rasterized legends and overlays; excludes arbitrary app DOM and crosshair.' };
        if (new TextEncoder().encode(JSON.stringify(result)).byteLength <= SCREENSHOT_LIMIT) return result;
        scale *= 0.6;
    }
    throw new Error('Chart screenshot exceeds the transfer limit.');
}

/** A browser-owned bridge: every operation resolves its live cell again before changing it. */
export function createChartAgentController(options: ChartAgentControllerOptions): ChartAgentController {
    const clientId = crypto.randomUUID();
    const clientToken = crypto.randomUUID();
    const abort = new AbortController();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flight: Promise<void> | undefined;
    let execution: Promise<unknown> = Promise.resolve();
    let completion: ChartAgentCompletion | undefined;
    let lastError = '';
    const jobs = new Map<string, ScriptJob>();
    const analysis = createChartAnalysis({ api: options.api });
    let analysisRequest: { question: string; scopeId: string; target: ChartAgentTask['target']; createdAt: number } | undefined;
    const backtestJobs = new Map<string, BacktestJob>();

    const request = async <T>(run: (signal: AbortSignal) => Promise<T>, deadline = Date.now() + 5000, cancelled?: AbortSignal, settleOnAbort = false): Promise<T> => {
        const controller = new AbortController();
        const cancel = (): void => controller.abort();
        abort.signal.addEventListener('abort', cancel, { once: true });
        cancelled?.addEventListener('abort', cancel, { once: true });
        const timeout = setTimeout(cancel, Math.max(0, deadline - Date.now()));
        let rejectOnAbort: (() => void) | undefined;
        try {
            if (abort.signal.aborted || cancelled?.aborted) controller.abort();
            if (!settleOnAbort) return await run(controller.signal);
            const ended = new Promise<never>((_resolve, reject) => {
                rejectOnAbort = () => reject(new Error('The chart request expired or its connection closed.'));
                controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
                if (controller.signal.aborted) rejectOnAbort();
            });
            return await Promise.race([run(controller.signal), ended]);
        } finally {
            clearTimeout(timeout); abort.signal.removeEventListener('abort', cancel); cancelled?.removeEventListener('abort', cancel);
            if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
        }
    };

    const timeframe = (value: unknown, view: SessionView): string => {
        const next = text(value, 'Timeframe', 8);
        if (!timeframeSupported(next, view.dataset.schema)) throw new Error('This timeframe is not supported by the replay dataset.');
        return parseTimeframe(next)!.native;
    };

    const guard = (task: ChartAgentTask, expectedChart?: Vela, allowExpired = false): { view: SessionView; chart: Vela | null } => {
        if (disposed) throw new Error('Chart connection has closed.');
        if (options.blocked()) throw new Error('Chart changes are paused while the workspace updates.');
        if (!Number.isFinite(task.deadline) || (!allowExpired && task.deadline <= Date.now())) throw new Error('Chart request has expired.');
        const view = options.session();
        if (!view || task.target.clientId !== clientId || task.target.sessionId !== view.session.id || task.target.generation !== options.generation()) {
            throw new Error('Chart request belongs to an older workspace or session.');
        }
        if (task.operation === 'list_drawing_tools') return { view, chart: null };
        const cell = task.target.cellId ? options.workspace.cells().find((item) => item.id === task.target.cellId) : undefined;
        if (!cell || options.workspace.cell(cell.id)?.chart !== cell.chart || (expectedChart && cell.chart !== expectedChart)) throw new Error('The requested chart cell is no longer available.');
        if (cell.chart.market.symbol !== `replay:${view.dataset.symbol}`) throw new Error('The chart cell is changing markets. Try again once it has loaded.');
        timeframe(cell.chart.market.timeframe, view);
        return { view, chart: cell.chart };
    };

    const persist = async (task: ChartAgentTask, chart: Vela, value: unknown): Promise<unknown> => {
        guard(task, chart);
        try { await options.flush(); }
        catch (error) { throw new Error(`The chart changed, but saving failed: ${error instanceof Error ? error.message : 'Unknown save failure'}`); }
        // A finished save remains reconcilable after its caller's deadline.
        guard(task, chart, true);
        return bounded(value);
    };

    const jobSummary = (job: ScriptJob): unknown => ({ jobId: job.id, indicatorId: job.indicatorId,
        ...(job.replacesId ? { replacesId: job.replacesId } : {}), state: job.state, deadline: job.deadline, saved: job.saved,
        ...(job.error ? { error: job.error } : {}), ...(job.value ? { indicator: job.value } : {}) });

    const startScript = (task: ChartAgentTask, chart: Vela, args: Record<string, unknown>, previous?: IndicatorHandle): unknown => {
        keys(args, previous ? ['id', 'source', 'inputs', 'properties'] : ['source', 'inputs', 'properties']);
        if (chart.indicators().length >= 64) throw new Error('This chart has reached the assistant indicator limit.');
        if ([...jobs.values()].filter(job => job.state === 'running').length >= 4) throw new Error('Four Pine jobs are already running. Wait or cancel one.');
        for (const [id, job] of jobs) if (job.state !== 'running' && (jobs.size >= 32 || Date.now() - job.createdAt > 300000)) jobs.delete(id);
        const source = scriptSource(args.source ?? previous?.source);
        const explicitInputs = scriptSettings(args.inputs ?? {}); const explicitProps = scriptSettings(args.properties ?? {});
        const inheritedInputs = previous ? Object.fromEntries(Object.entries(previous.inputValues()).filter(([key, value]) => !Object.is(previous.inputs.find(entry => entry.key === key)?.defval, value))) : {};
        const original = previous ? JSON.stringify({ source: previous.source, inputs: previous.inputValues(), properties: previous.propValues(), visible: previous.visible }) : undefined;
        const view = guard(task, chart).view; const cursor = view.session.cursor; const cutoff = options.cursorTime?.(); const resolution = chart.market.timeframe;
        const jobTask = { ...task, deadline: Date.now() + SCRIPT_JOB_MS };
        const indicatorId = `ai-pine-${crypto.randomUUID()}`;
        const handle = chart.addIndicator(source, { id: indicatorId, language: 'pine', inputs: { ...inheritedInputs, ...explicitInputs }, props: { ...previous?.propValues(), ...explicitProps } });
        markTransientScript(chart, indicatorId, true);
        const job: ScriptJob = { id: crypto.randomUUID(), indicatorId, ...(previous ? { replacesId: previous.id } : {}), state: 'running', createdAt: Date.now(), deadline: jobTask.deadline, saved: false, target: { ...task.target }, chart, cleanup: [],
            cancel: (reason, failed = false) => {
                if (job.state !== 'running') return;
                job.state = failed ? 'failed' : 'cancelled'; job.error = reason.slice(0, 2000);
                clearTimeout(job.timer); job.cleanup.splice(0).forEach(off => off());
                markTransientScript(chart, indicatorId, false);
                try { handle.remove(); } catch { /* A disposed chart has already removed the staged script. */ }
            } };
        jobs.set(job.id, job);
        const current = (): void => {
            const current = guard(jobTask, chart).view;
            if (current.session.cursor !== cursor || options.cursorTime?.() !== cutoff) throw new Error('Replay advanced while the Pine job was computing. Start the job again.');
            if (chart.market.timeframe !== resolution) throw new Error('The chart timeframe changed while the Pine job was computing.');
            if (!chart.indicators().includes(handle)) throw new Error('The staged Pine script was removed.');
            if (previous && (!chart.indicators().includes(previous) || JSON.stringify({ source: previous.source, inputs: previous.inputValues(), properties: previous.propValues(), visible: previous.visible }) !== original)) throw new Error('The original script changed while its replacement was computing.');
        };
        const watch = (): void => {
            if (job.state !== 'running') return;
            try { current(); } catch (error) { job.cancel(error instanceof Error ? error.message : 'The Pine job target changed.', true); return; }
            job.timer = setTimeout(watch, Math.min(250, Math.max(1, job.deadline - Date.now())));
        };
        job.cleanup.push(handle.on('error', ({ error }) => job.cancel(error.message, true)));
        job.cleanup.push(handle.on('ready', () => {
            if (job.state !== 'running') return;
            try {
                current(); inputValues(explicitInputs, handle.inputs); inputValues(explicitProps, handle.props, 1e12);
                if (previous) {
                    const pane = chart.panes.list().find(pane => pane.indicators?.some(entry => entry.id === previous.id));
                    if (pane) handle.moveTo(pane.kind === 'price' ? 'price' : { pane: pane.id });
                    handle.setVisible(previous.visible); previous.remove();
                }
                job.state = 'completed'; job.value = indicatorSummary(handle); clearTimeout(job.timer); job.cleanup.splice(0).forEach(off => off());
                markTransientScript(chart, indicatorId, false);
                void Promise.resolve().then(() => options.flush()).then(() => { job.saved = true; }).catch(error => { job.error = `The script is on the chart, but saving failed: ${error instanceof Error ? error.message : 'Unknown save failure'}`.slice(0, 2000); });
            } catch (error) { job.cancel(error instanceof Error ? error.message : 'The Pine job failed.', true); }
        }));
        watch();
        return bounded(jobSummary(job));
    };

    const waitContext = async (handle: IndicatorHandle, select: ContextSelect, deadline: number): Promise<EngineContextSnapshot | null> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let cancel: () => void = () => {};
        try {
            return await Promise.race([handle.context(select), new Promise<never>((_resolve, reject) => {
                cancel = () => reject(new Error('The script context request was cancelled.'));
                timeout = setTimeout(() => reject(new Error('The script context did not arrive before its deadline.')), Math.max(0, Math.min(6000, deadline - Date.now())));
                abort.signal.addEventListener('abort', cancel, { once: true }); if (abort.signal.aborted) cancel();
            })]);
        } finally { clearTimeout(timeout); abort.signal.removeEventListener('abort', cancel); }
    };

    const perform = async (task: ChartAgentTask): Promise<unknown> => {
        const { view, chart } = guard(task);
        const args = record(task.args, 'Chart arguments');
        if (task.operation === 'list_drawing_tools') {
            keys(args, []);
            return bounded(drawingTypes().map((meta) => {
                const { min, max } = meta.create({ paneId: 'price' }).anchorSchema();
                return { type: meta.type, label: meta.label, group: meta.group, anchors: { min, max: Math.min(max, 128) } };
            }));
        }
        if (!chart) throw new Error('A chart cell is required.');
        const existingDrawing = (): SerializedDrawing => {
            const id = text(args.id, 'Drawing ID');
            const drawing = chart.drawings.all().find((item) => item.id === id);
            if (!drawing) throw new Error('Drawing not found on this chart.');
            return drawing;
        };
        const existingIndicator = (): IndicatorHandle => {
            const id = text(args.id, 'Indicator ID');
            const handle = chart.indicators().find((item) => item.id === id);
            if (!handle || !handle.nativeType && handle.source === undefined) throw new Error('Indicator not found on this chart.');
            return handle;
        };
        switch (task.operation) {
            case 'backtest_indicator': {
                keys(args, ['id', 'mode', 'from', 'to']); const handle = existingIndicator();
                if (handle.source === undefined) throw new Error('Backtesting requires a Pine strategy.');
                if (!options.strategy) throw new Error('The strategy tester is unavailable.');
                if (options.workspace.context().activeCellId !== task.target.cellId) throw new Error('Select the target chart cell before opening its strategy tester.');
                for (const [id, job] of backtestJobs) if (job.state !== 'running' && Date.now() - (job.completedAt ?? job.createdAt) > 300000) backtestJobs.delete(id);
                if (backtestJobs.size >= 32) throw new Error('The strategy job history is full. Wait for old receipts to expire.');
                if ([...backtestJobs.values()].some(job => job.state === 'running')) throw new Error('A strategy job is already running.');
                const mode = args.mode === undefined ? 'replay' : choice(args.mode, 'Backtest mode', ['replay', 'deep']);
                const range = requestedRange(args);
                if (mode === 'replay' && (range.from !== undefined || range.to !== undefined)) throw new Error('Replay backtests do not accept future date bounds.');
                if (mode === 'deep' && (range.from === undefined || range.to === undefined || range.from >= range.to)) throw new Error('Deep backtesting requires an explicit UTC start and exclusive end.');
                const job: BacktestJob = { jobId: crypto.randomUUID(), target: { ...task.target }, state: 'running', createdAt: Date.now() };
                backtestJobs.set(job.jobId, job);
                const assertCurrent = (): void => { guard(task, chart, true); if (job.state !== 'running') throw new Error('The strategy job has ended.'); };
                job.timer = setTimeout(() => { if (job.state === 'running') { job.state = 'failed'; job.error = 'The strategy job exceeded its 90-second deadline.'; job.completedAt = Date.now(); options.strategy?.cancelBacktest(job.jobId); } }, 90000);
                void options.strategy.startBacktestForIndicator(handle.id, { mode, ...range, operationId: job.jobId }, assertCurrent).then(value => {
                    if (job.state !== 'running') return;
                    job.state = 'completed'; job.completedAt = Date.now();
                    job.value = { generation: value.generation, name: value.name, from: value.result.from, to: value.result.to,
                        symbol: value.result.symbol, timeframe: value.result.timeframe, state: value.result.state, tradeCount: value.result.trades.length,
                        history: value.result.history ?? null, savedRunId: value.savedRunId ?? null, saved: !!value.savedRunId,
                        note: 'Published in the strategy tester. Read current_result for bounded report detail. Manual replay was not advanced.' };
                }, error => { if (job.state === 'running') { job.state = 'failed'; job.completedAt = Date.now(); job.error = error instanceof Error ? error.message.slice(0, 2000) : 'The strategy backtest failed.'; } }).finally(() => clearTimeout(job.timer));
                return { jobId: job.jobId, state: job.state, mode };
            }
            case 'read_backtest_job': case 'cancel_backtest_job': {
                keys(args, ['jobId']); const job = backtestJobs.get(text(args.jobId, 'Strategy job ID'));
                if (!job || !sameTarget(job.target, task.target)) throw new Error('Strategy job not found for this chart target.');
                if (task.operation === 'cancel_backtest_job' && job.state === 'running') {
                    job.state = 'cancelled'; job.completedAt = Date.now(); clearTimeout(job.timer); options.strategy?.cancelBacktest(job.jobId);
                }
                return bounded({ jobId: job.jobId, state: job.state, createdAt: job.createdAt, completedAt: job.completedAt, error: job.error, value: job.value });
            }
            case 'read_analysis_request': {
                keys(args, []);
                if (!analysisRequest) return { request: null };
                const scope = analysis.readScope(task.target, analysisRequest.scopeId);
                return { request: { ...analysisRequest, scope }, note: 'A question queued locally by the chart user. Your external AI host performs analysis; this app has not started a model request.' };
            }
            case 'capture_analysis_scope': {
                const cursor = view.session.cursor; const cutoff = options.cursorTime?.(); const resolution = chart.market.timeframe;
                if (cutoff === undefined || cutoff === null) throw new Error('Reveal a replay bar before capturing an analysis scope.');
                const assertCurrent = (): void => {
                    const current = guard(task, chart, true).view;
                    if (current.session.cursor !== cursor || options.cursorTime?.() !== cutoff || chart.market.timeframe !== resolution
                        || current.dataset.id !== view.dataset.id || current.dataset.checksum !== view.dataset.checksum || current.session.revision !== view.session.revision) {
                        throw new Error('The captured replay scope changed. Capture the intended region again.');
                    }
                };
                return request(signal => analysis.capture({ target: task.target, chart, view, cutoff, assertCurrent, signal }, args), task.deadline, undefined, true);
            }
            case 'read_analysis_scope': keys(args, ['scopeId']); return analysis.readScope(task.target, text(args.scopeId, 'Scope ID'));
            case 'evaluate_analysis': {
                const { scopeId, ...values } = args;
                return analysis.evaluate(task.target, text(scopeId, 'Scope ID'), values);
            }
            case 'read_analysis_job': keys(args, ['jobId']); return analysis.readJob(task.target, text(args.jobId, 'Analysis job ID'));
            case 'cancel_analysis_job': keys(args, ['jobId']); return analysis.cancelJob(task.target, text(args.jobId, 'Analysis job ID'));
            case 'read_session': case 'list_scripts': case 'read_script': case 'list_backtests': case 'read_backtest':
            case 'read_workspace': case 'list_templates': case 'read_current_result': {
                if (!options.appContext) throw new Error('The app context connection is unavailable.');
                const method = { read_session: 'readSession', list_scripts: 'listScripts', read_script: 'readScript', list_backtests: 'listBacktests',
                    read_backtest: 'readBacktest', read_workspace: 'readWorkspace', list_templates: 'listTemplates', read_current_result: 'readCurrentResult' } as const;
                const read = options.appContext[method[task.operation]].bind(options.appContext);
                const value = await request(signal => read(args, signal), task.deadline, undefined, true);
                guard(task, chart); return bounded(value);
            }
            case 'read_chart': {
                keys(args, ['drawingLimit']);
                const limit = args.drawingLimit === undefined ? 100 : integer(args.drawingLimit, 'Drawing limit', 0, 500);
                const drawings = chart.drawings.all();
                return bounded({ sessionId: view.session.id, generation: options.generation(), symbol: view.dataset.symbol,
                    cellId: task.target.cellId, timeframe: chart.market.timeframe, cursorTime: options.cursorTime?.() ?? null,
                    visibleRange: chart.getVisibleRange(), cells: options.workspace.cells().slice(0, 16).map((cell) => ({ id: cell.id, timeframe: cell.chart.market.timeframe })),
                    drawingCount: drawings.length, drawings: drawings.slice(0, limit).map(drawingSummary), drawingsTruncated: drawings.length > limit,
                    indicators: chart.indicators().slice(0, 64).map(indicatorSummary), dataWindow: chart.renderer.dataWindowReadout(),
                    dataWindowScope: 'Formatted values at the hovered bar, or latest loaded bar when the pointer is outside the plot. Not numeric indicator history.' });
            }
            case 'read_candles': {
                keys(args, ['timeframe', 'limit', 'from', 'to']);
                const range = requestedRange(args);
                const resolution = timeframe(args.timeframe ?? chart.market.timeframe, view);
                const limit = args.limit === undefined ? 200 : integer(args.limit, 'Candle limit', 1, 1000);
                const query = new URLSearchParams({ timeframe: toServerTimeframe(resolution), limit: String(limit) });
                const cursor = view.session.cursor;
                const loadedCursorTime = options.cursorTime?.();
                const ranged = range.from !== undefined || range.to !== undefined;
                if (ranged) {
                    query.set('cursor', String(cursor));
                    if (range.from !== undefined) query.set('from', String(range.from));
                    if (range.to !== undefined) query.set('to', String(range.to));
                }
                const result = await request((signal) => options.api.get<ChartView>(`/api/sessions/${encodeURIComponent(view.session.id)}/${ranged ? 'series' : 'chart'}?${query}`, signal), task.deadline);
                const current = guard(task, chart).view;
                if (current.session.cursor !== cursor) throw new Error('Replay advanced during the candle request. Read the chart again.');
                if (loadedCursorTime !== undefined && result.cursorTime !== loadedCursorTime) throw new Error('The saved replay cursor differs from the loaded chart. Refresh the session before reading candles.');
                const cutoff = result.cursorTime;
                return bounded({ timeframe: resolution, cursorTime: cutoff, intervalMs: result.intervalMs,
                    bars: result.bars.filter((bar) => cutoff !== null && bar.time <= cutoff && (range.from === undefined || bar.time >= range.from) && (range.to === undefined || bar.time <= range.to)).slice(-limit), hasMore: result.hasMore,
                    ...(ranged ? { requestedRange: range } : {}),
                    scope: 'Revealed session candles only. The current aggregated candle may be incomplete.' });
            }
            case 'set_timeframe': {
                keys(args, ['timeframe']);
                const resolution = timeframe(args.timeframe, view);
                await options.setTimeframe(task.target.cellId!, resolution, () => { guard(task, chart); });
                guard(task, chart);
                if (chart.market.timeframe !== resolution) throw new Error('The chart timeframe did not change.');
                return persist(task, chart, { cellId: task.target.cellId, timeframe: resolution });
            }
            case 'add_drawing': {
                keys(args, ['type', 'anchors', 'style', 'text', 'paneId']);
                if (chart.drawings.all().length >= 500) throw new Error('This chart has reached the assistant drawing limit.');
                const type = text(args.type, 'Drawing type', 64); const meta = getDrawingType(type);
                if (!meta) throw new Error('Unknown drawing tool.');
                const paneId = args.paneId === undefined ? 'price' : text(args.paneId, 'Pane ID');
                if (!chart.panes.list().some((pane) => pane.id === paneId)) throw new Error('Drawing pane not found.');
                const init = { paneId, anchors: anchors(args.anchors, type), ...(args.style === undefined ? {} : { style: style(args.style) }),
                    ...(args.text === undefined ? {} : { text: annotation(args.text) }) };
                guard(task, chart);
                const drawing = chart.drawings.add(meta.type, init);
                if (!drawing) throw new Error('This renderer cannot add drawings.');
                return persist(task, chart, drawingSummary(drawing.serialize()));
            }
            case 'update_drawing': {
                keys(args, ['id', 'anchors', 'style', 'text', 'locked', 'visible']);
                const drawing = existingDrawing(); const patch: Partial<SerializedDrawing> = {};
                if (args.anchors !== undefined) patch.anchors = anchors(args.anchors, drawing.type);
                if (args.style !== undefined) patch.style = { ...drawing.style, ...style(args.style) };
                if (args.text !== undefined) patch.text = annotation(args.text, drawing.text);
                if (args.locked !== undefined) patch.locked = boolean(args.locked, 'Locked');
                if (args.visible !== undefined) patch.visible = boolean(args.visible, 'Visible');
                if (!Object.keys(patch).length) throw new Error('Supply at least one drawing change.');
                guard(task, chart); chart.drawings.update(drawing.id, patch);
                return persist(task, chart, drawingSummary({ ...drawing, ...patch }));
            }
            case 'remove_drawing': {
                keys(args, ['id']); const drawing = existingDrawing();
                guard(task, chart); chart.drawings.remove(drawing.id);
                return persist(task, chart, { removed: drawing.id });
            }
            case 'run_script': return startScript(task, chart, args);
            case 'update_script': {
                const handle = existingIndicator();
                if (handle.source === undefined) throw new Error('Pine script not found on this chart.');
                return startScript(task, chart, args, handle);
            }
            case 'read_script_job':
            case 'cancel_script_job': {
                keys(args, ['jobId']); const job = jobs.get(text(args.jobId, 'Pine job ID'));
                if (job && job.state !== 'running' && Date.now() - job.createdAt > 300000) { jobs.delete(job.id); throw new Error('Pine job metadata expired. Read the running script by indicator ID.'); }
                if (!job || job.chart !== chart || job.target.sessionId !== task.target.sessionId || job.target.generation !== task.target.generation || job.target.cellId !== task.target.cellId) throw new Error('Pine job not found for this chart target.');
                if (task.operation === 'cancel_script_job') job.cancel('Cancelled by the chart assistant.');
                return bounded(jobSummary(job));
            }
            case 'read_indicator_context':
            case 'read_script_context': {
                keys(args, ['id', 'plotKeys', 'variableKeys', 'limit', 'trades', 'includeSource', 'from', 'to']); const handle = existingIndicator();
                const range = requestedRange(args);
                if (task.operation === 'read_script_context' && handle.source === undefined) throw new Error('Pine script not found on this chart.');
                const limit = args.limit === undefined ? 100 : integer(args.limit, 'Script context limit', 1, 500);
                const selectedKeys = (value: unknown, label: string, maximum: number): string[] | undefined => {
                    if (value === undefined) return undefined;
                    if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must contain at most ${maximum} names.`);
                    return value.map(key => { const result = text(key, label, 100); if (PRIVATE_FIELD.test(result)) throw new Error(`Invalid ${label}.`); return result; });
                };
                const plotKeys = selectedKeys(args.plotKeys, 'Plot keys', 16); const variableKeys = selectedKeys(args.variableKeys, 'Variable keys', 32);
                const includeTrades = args.trades === undefined ? true : boolean(args.trades, 'Include trades');
                const includeSource = args.includeSource === undefined ? false : boolean(args.includeSource, 'Include source');
                const cursor = view.session.cursor; const cutoff = options.cursorTime?.() ?? null; const resolution = chart.market.timeframe;
                const scriptState = JSON.stringify({ source: handle.source, inputs: handle.inputValues(), properties: handle.propValues(), visible: handle.visible });
                if (cutoff === null) throw new Error('Reveal a replay bar before reading a script context.');
                const select: (keyof EngineContextSnapshot)[] = ['language', 'phase', 'barIndex', 'meta', 'strategy', 'warnings'];
                if (plotKeys?.length !== 0) select.push('plots');
                if (variableKeys?.length) select.push('variables');
                if (includeTrades) select.push('trades');
                const context = await waitContext(handle, select, task.deadline);
                const current = guard(task, chart).view;
                if (current.session.cursor !== cursor || (options.cursorTime?.() ?? null) !== cutoff) throw new Error('Replay advanced during the script context request. Read it again.');
                if (chart.market.timeframe !== resolution) throw new Error('The chart timeframe changed during the script context request.');
                if (!chart.indicators().includes(handle)) throw new Error('The Pine script was removed while reading its context.');
                if (JSON.stringify({ source: handle.source, inputs: handle.inputValues(), properties: handle.propValues(), visible: handle.visible }) !== scriptState) throw new Error('The Pine script changed during its context request. Read it again.');
                if (!context) return { id: handle.id, indicator: indicatorSummary(handle), context: null,
                    calculationState: handle.visible ? 'unavailable' : 'hidden',
                    ...(includeSource && handle.source !== undefined ? { source: handle.source.slice(0, 60000), sourceTruncated: handle.source.length > 60000 } : {}),
                    scope: handle.visible ? 'No completed calculation is available. Source and settings remain readable.' : 'The hidden instance has no active calculation. Source and settings remain readable.' };
                const calculation = context.computation;
                const completed = calculation?.completed;
                const ready = calculation?.state === 'ready' && completed?.id === calculation.requested.id;
                if (calculation && !ready) return bounded({ id: handle.id, indicator: indicatorSummary(handle), context: null,
                    calculationState: calculation.state, computation: { requestedId: calculation.requested.id, completedId: completed?.id ?? null },
                    ...(includeSource && handle.source !== undefined ? { source: handle.source.slice(0, 60000), sourceTruncated: handle.source.length > 60000 } : {}),
                    scope: 'The requested settings and data do not have a matching completed calculation. No stale numeric result is returned.' });
                const scalar = (value: unknown): string | number | boolean | null => typeof value === 'number' ? Number.isFinite(value) ? value : null : typeof value === 'string' ? value.slice(0, 2000) : typeof value === 'boolean' ? value : null;
                const names = (plotKeys ?? Object.keys(context.plots ?? {}).slice(0, 8)).filter(key => !PRIVATE_FIELD.test(key));
                const pointLimit = Math.min(limit, Math.max(1, Math.floor(1000 / Math.max(1, names.length))));
                const inRange = (time: number): boolean => Number.isFinite(time) && time >= 0 && time <= cutoff && (range.from === undefined || time >= range.from) && (range.to === undefined || time <= range.to);
                const eligiblePlots = Object.fromEntries(names.map(key => [key, (context.plots?.[key] ?? []).filter(point => inRange(point.time))]));
                const plots = Object.fromEntries(names.map(key => [key, eligiblePlots[key]!.slice(-pointLimit).map(point => ({ time: point.time, value: typeof point.value === 'number' && Number.isFinite(point.value) ? point.value : null }))]));
                const variables = Object.fromEntries((variableKeys ?? []).filter(key => !PRIVATE_FIELD.test(key) && Object.hasOwn(context.variables ?? {}, key)).map(key => [key, scalar(context.variables[key])]));
                const eligibleTrades = includeTrades ? (context.trades ?? []).filter(trade => Number.isFinite(trade.entry.time) && trade.entry.time <= cutoff && (!trade.exit || Number.isFinite(trade.exit.time) && trade.exit.time <= cutoff) && (inRange(trade.entry.time) || !!trade.exit && inRange(trade.exit.time))) : [];
                const trades = eligibleTrades.slice(-limit).map(trade => ({
                    id: trade.id.slice(0, 128), side: trade.side, qty: scalar(trade.qty), open: trade.open,
                    entry: { id: trade.entry.id.slice(0, 128), time: trade.entry.time, price: scalar(trade.entry.price), ...(trade.entry.comment === undefined ? {} : { comment: trade.entry.comment.slice(0, 2000) }) },
                    ...(trade.exit ? { exit: { id: trade.exit.id.slice(0, 128), time: trade.exit.time, price: scalar(trade.exit.price), ...(trade.exit.comment === undefined ? {} : { comment: trade.exit.comment.slice(0, 2000) }) } } : {}),
                    ...Object.fromEntries(['pnl', 'commission', 'maxDrawdown', 'maxRunup'].filter(key => trade[key as keyof typeof trade] !== undefined).map(key => [key, scalar(trade[key as keyof typeof trade])])),
                }));
                const requestedIndicator = indicatorSummary(handle) as Record<string, unknown>;
                return bounded({ id: handle.id, ...(ready ? { indicator: { ...requestedIndicator, inputs: completed!.inputs, properties: completed!.props } } : { requestedIndicator }),
                    calculationState: ready ? 'ready' : 'unverified',
                    ...(ready ? { computation: { id: completed!.id, market: completed!.market, bars: completed!.bars, visibleRange: completed!.visibleRange } } : {}),
                    ...(context.native ? { native: context.native } : {}),
                    outputNames: Object.keys(context.plots ?? {}).filter(key => !PRIVATE_FIELD.test(key)).slice(0, 128),
                    cursorTime: cutoff, language: context.language, phase: context.phase, barIndex: context.barIndex,
                    plots, plotPointLimit: pointLimit, plotsTruncated: names.some(key => eligiblePlots[key]!.length > pointLimit), variables,
                    ...((range.from !== undefined || range.to !== undefined) ? { requestedRange: range, strategyScope: 'Complete loaded chart history, not recalculated for the requested region.' } : {}),
                    strategy: context.strategy ? Object.fromEntries(Object.entries(context.strategy).filter(([key]) => !PRIVATE_FIELD.test(key)).map(([key, value]) => [key, scalar(value)])) : null,
                    trades, tradesTruncated: eligibleTrades.length > limit,
                    warnings: (context.warnings ?? []).slice(-32).map(warning => ({ message: warning.message.slice(0, 2000), bar: scalar(warning.bar), ...(warning.method ? { method: warning.method.slice(0, 100) } : {}) })),
                    ...(includeSource && handle.source !== undefined ? { source: handle.source.slice(0, 60000), sourceTruncated: handle.source.length > 60000 } : {}),
                    scope: 'Revealed chart context only. Plot points and trade timestamps after the loaded source cutoff are omitted. At most 1000 plot points total and 500 trades per request.' });
            }
            case 'list_indicators': {
                keys(args, []);
                const catalog = await request(() => chart.availableNativeIndicators(), task.deadline, undefined, true); guard(task, chart);
                return bounded({ available: catalog.map((item) => ({ ...item, inputs: getNativeIndicator(item.type)?.inputsSchema().slice(0, 64) ?? [] })),
                    instances: chart.indicators().slice(0, 64).map(indicatorSummary), dataWindow: chart.renderer.dataWindowReadout(),
                    dataWindowScope: 'Formatted hovered or latest loaded bar. Use read_script_context for Pine plot history, strategy state and trades.' });
            }
            case 'add_indicator': {
                keys(args, ['type', 'inputs']);
                if (chart.indicators().length >= 32) throw new Error('This chart has reached the assistant indicator limit.');
                const type = text(args.type, 'Native indicator type', 64); const descriptor = getNativeIndicator(type);
                if (!descriptor) throw new Error('Unknown native indicator type. Use run_script for Pine source.');
                const values = inputValues(args.inputs ?? {}, descriptor.inputsSchema());
                const catalog = await request(() => chart.availableNativeIndicators(), task.deadline, undefined, true); guard(task, chart);
                if (!catalog.some((item) => item.type === type && item.supported)) throw new Error('This native indicator is not supported by the replay dataset.');
                const handle = chart.addNativeIndicator(type, { inputs: values });
                return persist(task, chart, indicatorSummary(handle));
            }
            case 'update_indicator': {
                keys(args, ['id', 'inputs', 'properties', 'visible']); const handle = existingIndicator();
                const values = args.inputs === undefined ? undefined : inputValues(args.inputs, handle.inputs);
                const properties = args.properties === undefined ? undefined : inputValues(args.properties, handle.props, 1e12);
                const visible = args.visible === undefined ? undefined : boolean(args.visible, 'Indicator visible');
                if (!values && !properties && visible === undefined) throw new Error('Supply indicator inputs, properties or visibility.');
                guard(task, chart);
                if (values) handle.setInputs(values);
                if (properties) handle.setProps(properties);
                if (visible !== undefined) handle.setVisible(visible);
                return persist(task, chart, indicatorSummary(handle));
            }
            case 'remove_indicator': {
                keys(args, ['id']); const handle = existingIndicator();
                guard(task, chart); handle.remove();
                return persist(task, chart, { removed: handle.id });
            }
            case 'set_viewport': {
                keys(args, ['from', 'to', 'fit']);
                if (args.fit !== undefined && boolean(args.fit, 'Fit view')) {
                    if (args.from !== undefined || args.to !== undefined) throw new Error('Fit view cannot also specify a time range.');
                    chart.setVisibleRangePreset('ALL');
                } else {
                    const from = finite(args.from, 'Viewport start', 0, MAX_TIME); const to = finite(args.to, 'Viewport end', 0, MAX_TIME);
                    if (from >= to) throw new Error('Viewport end must be after its start.');
                    chart.setVisibleRange({ from, to });
                }
                return persist(task, chart, { visibleRange: chart.getVisibleRange() });
            }
            case 'screenshot': return bounded(screenshot(chart, args), SCREENSHOT_LIMIT);
            default: throw new Error('Unsupported chart operation.');
        }
    };

    const execute = (task: ChartAgentTask): Promise<unknown> => {
        const next = execution.catch(() => undefined).then(() => perform(task));
        execution = next;
        return next;
    };

    const advertise = (): Omit<ChartAgentClient, 'clientId'> | null => {
        const view = options.session();
        if (!view) return null;
        const cells = options.workspace.cells().slice(0, 16).map((cell) => ({ id: cell.id, timeframe: cell.chart.market.timeframe ?? '1' }));
        if (!cells.length) return null;
        const activeId = options.workspace.context().activeCellId;
        return { sessionId: view.session.id, generation: options.generation(), symbol: view.dataset.symbol,
            timeframe: cells.find((cell) => cell.id === activeId)?.timeframe ?? cells[0]!.timeframe, cells, cursorTime: options.cursorTime?.() ?? null };
    };

    const heartbeat = (registered: Omit<ChartAgentClient, 'clientId'>): (() => void) => {
        const cancellation = new AbortController();
        const cells = options.workspace.cells().map(cell => ({ id: cell.id, chart: cell.chart }));
        let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
        let stopped = false;
        const stop = (): void => {
            stopped = true; clearTimeout(heartbeatTimer); cancellation.abort();
            abort.signal.removeEventListener('abort', stop);
        };
        const current = (): boolean => {
            const chart = advertise();
            return !disposed && !options.blocked() && !!chart && chart.sessionId === registered.sessionId
                && chart.generation === registered.generation && chart.symbol === registered.symbol
                && chart.cells.length === cells.length && cells.every(cell => options.workspace.cell(cell.id)?.chart === cell.chart && cell.chart.market.symbol === `replay:${registered.symbol}`);
        };
        const renew = async (): Promise<void> => {
            if (stopped || !current()) { stop(); return; }
            const body: ChartAgentExchangeInput = { action: 'heartbeat', clientId, clientToken, chart: registered };
            try {
                await request(signal => options.api.post<ChartAgentExchangeResult>('/api/assistant/exchange', body, signal), Date.now() + 1500, cancellation.signal);
            } catch (error) {
                if (error instanceof ApiError && [403, 409, 503].includes(error.status)) { stop(); return; }
            }
            if (!stopped && current()) heartbeatTimer = setTimeout(() => { void renew(); }, 2000);
            else stop();
        };
        abort.signal.addEventListener('abort', stop, { once: true });
        heartbeatTimer = setTimeout(() => { void renew(); }, 2000);
        return stop;
    };

    const poll = (): Promise<void> => {
        if (disposed) return Promise.resolve();
        if (flight) return flight;
        clearTimeout(timer);
        flight = (async () => {
            const chart = advertise();
            if (!chart || options.blocked()) return;
            const body: ChartAgentExchangeInput = { action: 'poll', clientId, clientToken, chart, ...(completion ? { completion } : {}) };
            try {
                const result = await request((signal) => options.api.post<ChartAgentExchangeResult>('/api/assistant/exchange', body, signal));
                completion = undefined; lastError = '';
                if (disposed || !result.request) return;
                const task = result.request;
                const stopHeartbeat = heartbeat(chart);
                try { completion = { requestId: task.requestId, success: true, value: await execute(task) }; }
                catch (error) { completion = { requestId: task.requestId, success: false, error: (error instanceof Error ? error.message : 'Chart operation failed.').slice(0, 2000) }; }
                finally { stopHeartbeat(); }
            } catch (error) {
                if (error instanceof ApiError && [400, 403, 409, 413, 422].includes(error.status)) {
                    completion = completion?.success && [400, 413, 422].includes(error.status)
                        ? { requestId: completion.requestId, success: false, error: 'The chart response could not pass local bridge validation. No automatic edit retry was made; inspect the chart before repeating an edit.' }
                        : undefined;
                }
                if (disposed || abort.signal.aborted) return;
                const message = error instanceof Error ? error.message : 'Chart assistant connection failed.';
                if (message !== lastError) { lastError = message; options.onError?.(error); }
            }
        })().finally(() => {
            flight = undefined;
            if (!disposed && options.autoStart !== false) timer = setTimeout(() => { void poll(); }, completion ? 0 : 1000);
        });
        return flight;
    };

    if (options.autoStart !== false) timer = setTimeout(() => { void poll(); }, 0);
    return { clientId, poll, execute,
        requestAnalysis: async (question, args = {}) => {
            const value = text(question, 'Analysis question', 2000).trim();
            if (!value) throw new Error('Enter a question about the chart.');
            const current = advertise();
            if (!current) throw new Error('Open a replay chart first.');
            const cellId = options.workspace.context().activeCellId;
            const target = { clientId, sessionId: current.sessionId, generation: current.generation, cellId };
            const scope = await execute({ operation: 'capture_analysis_scope', target, args, requestId: crypto.randomUUID(), deadline: Date.now() + 10000 }) as { scopeId: string };
            analysisRequest = { question: value, scopeId: scope.scopeId, target, createdAt: Date.now() };
            return { ...analysisRequest, instruction: 'Use vela_workspaces to find this exact target, then vela_read_analysis_request to inspect the queued question and its pinned region.' };
        },
        dispose: () => {
            if (disposed) return;
            disposed = true; clearTimeout(timer); abort.abort();
            analysis.dispose();
            for (const job of backtestJobs.values()) { clearTimeout(job.timer); if (job.state === 'running') { job.state = 'cancelled'; options.strategy?.cancelBacktest(job.jobId); } }
            backtestJobs.clear();
            for (const job of jobs.values()) job.cancel('The chart connection closed.');
            jobs.clear();
            const release: ChartAgentExchangeInput = { action: 'release', clientId, clientToken };
            options.api.postKeepalive('/api/assistant/exchange', release);
        } };
}
