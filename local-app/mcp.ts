import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ChartAgentOperation } from './shared/chart-agent';
import { LocalResearchConnection, registerResearchTools } from './mcp-research';
import { parseScenarioContent, SCENARIO_LIMITS } from './shared/scenarios';

class ChartOperationError extends Error {}

/** The model receives chart tools only; the private bootstrap never leaves this process. */
export class LocalChartConnection {
    private token = '';
    private readonly origin: string;
    constructor(port = '5197', private readonly request: typeof fetch = fetch) {
        if (!['5196', '5197', '5199'].includes(port)) throw new Error('Use local Vela port 5196, 5197 or 5199.');
        this.origin = `http://127.0.0.1:${port}`;
    }
    private async json(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
        signal?.throwIfAborted();
        const response = await this.request(this.origin + path, { method: body === undefined ? 'GET' : 'POST',
            headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Local-Token': this.token },
            body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000) });
        if (!response.ok) {
            if (response.status === 403) this.token = '';
            // Never surface an arbitrary HTTP response or bootstrap to the model.
            const errors: Record<number, string> = { 403: 'Reconnect the local chart bridge after Vela restarts.',
                404: 'This Vela build does not have the chart AI bridge yet.', 409: 'Chart target changed. List workspaces again.',
                429: 'The local chart bridge is busy. Try again later.', 503: 'Vela is updating or the target chart disconnected.',
                504: 'The chart did not complete this request before the deadline.' };
            let message = errors[response.status] ?? `Local chart request failed (${response.status}).`;
            if (response.status === 422) {
                const raw = await response.text();
                if (raw.length <= 4096) {
                    try {
                        const detail: unknown = JSON.parse(raw);
                        if (detail && typeof detail === 'object' && 'error' in detail && typeof detail.error === 'string') {
                            message = `Chart operation failed: ${detail.error.slice(0, 2000).replace(/[\u0000-\u001f\u007f]/g, ' ')}`;
                        }
                    } catch { /* An invalid error body does not replace the bounded status message. */ }
                }
            }
            throw new ChartOperationError(message);
        }
        const raw = await response.text();
        if (raw.length > 2_000_000) throw new Error('Chart response exceeds the size limit.');
        return JSON.parse(raw) as unknown;
    }
    async clients(): Promise<unknown> { this.token = ''; return this.json('/api/assistant/clients'); }
    async call(operation: ChartAgentOperation, target: unknown, args: unknown, signal?: AbortSignal): Promise<unknown> {
        signal?.throwIfAborted();
        if (!this.token) {
            const bootstrap = await this.json('/api/bootstrap', undefined, signal) as { token?: unknown };
            if (typeof bootstrap.token !== 'string' || !/^[a-f0-9]{64}$/.test(bootstrap.token)) throw new Error('The local chart bridge did not return a valid connection.');
            this.token = bootstrap.token;
        }
        const requestId = randomUUID();
        try { return await this.json('/api/assistant/call', { operation, target, args, requestId }, signal); }
        catch (error) {
            const detail = error instanceof ChartOperationError ? error.message : 'The local chart connection ended before an outcome was received.';
            if (operation === 'read_operation') throw new ChartOperationError(detail);
            throw new ChartOperationError(`${detail} Operation ID: ${requestId}. Inspect vela_read_operation with the original target before repeating an edit.`);
        }
    }
}

/** Desktop and source modes have independent identities; calls never switch targets. */
export class LocalChartConnections {
    private readonly targets = new Map<string, LocalChartConnection>();
    constructor(private readonly modes = [
        { mode: 'desktop', connection: new LocalChartConnection('5196') },
        { mode: 'run', connection: new LocalChartConnection('5197') },
        { mode: 'develop', connection: new LocalChartConnection('5199') },
    ]) {}
    async clients(): Promise<unknown> {
        this.targets.clear();
        const results = await Promise.allSettled(this.modes.map(async ({ mode, connection }) => {
            const clients = await connection.clients();
            if (!Array.isArray(clients) || clients.length > 16) throw new Error('Invalid local chart list.');
            return clients.map((client: Record<string, unknown>) => {
                if (typeof client.clientId !== 'string') throw new Error('Invalid local chart identity.');
                this.targets.set(client.clientId, connection);
                return { ...client, mode };
            });
        }));
        if (results.every(result => result.status === 'rejected')) throw new Error('The local chart bridge is unavailable.');
        return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    }
    call(operation: ChartAgentOperation, target: unknown, args: unknown, signal?: AbortSignal): Promise<unknown> {
        const id = (target as { clientId?: unknown } | null)?.clientId;
        const connection = typeof id === 'string' ? this.targets.get(id) : undefined;
        if (!connection) return Promise.reject(new Error('Chart target changed. List workspaces again.'));
        return connection.call(operation, target, args, signal);
    }
}

const target = z.object({ clientId: z.uuid(), sessionId: z.uuid(), generation: z.number().int().nonnegative(), cellId: z.string().min(1).max(100) }).strict();
const anchor = z.object({ time: z.number().finite().nonnegative(), price: z.number().finite() }).strict();
const inputs = z.record(z.string().min(1).max(100), z.union([z.number().finite(), z.string().max(1000), z.boolean()]));
const style = z.object({ lineColor: z.string().max(40).optional(), lineWidth: z.number().int().min(1).max(10).optional(),
    lineStyle: z.enum(['solid', 'dashed', 'dotted']).optional(), fillColor: z.string().max(40).optional(), fillOpacity: z.number().min(0).max(1).optional(),
    extendLeft: z.boolean().optional(), extendRight: z.boolean().optional(), arrowLeft: z.boolean().optional(), arrowRight: z.boolean().optional() }).strict();

export function createChartMcp(connection: Pick<LocalChartConnection, 'clients' | 'call'> = process.env.VELA_AGENT_PORT
    ? new LocalChartConnection(process.env.VELA_AGENT_PORT) : new LocalChartConnections(),
    research = new LocalResearchConnection()): McpServer {
    const server = new McpServer({ name: 'vela-local-chart', version: '1.1.0' });
    registerResearchTools(server, research);
    server.registerTool('vela_workspaces', { description: 'List open local Vela replay charts. Copy the exact clientId, sessionId, generation and a cell id into subsequent targets. No future replay data is exposed.',
        inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, openWorldHint: false } }, async () => {
        try { return { content: [{ type: 'text' as const, text: JSON.stringify(await connection.clients()) }] }; }
        catch { return { content: [{ type: 'text' as const, text: 'Open Run Vela (or select Develop port 5199). The local chart bridge is unavailable.' }], isError: true }; }
    });
    const tool = (operation: ChartAgentOperation, description: string, args: z.ZodType, readOnly: boolean): void => {
        server.registerTool(`vela_${operation}`, { description, inputSchema: z.object({ target, args }).strict(),
            annotations: { readOnlyHint: readOnly, destructiveHint: operation.startsWith('remove_'), openWorldHint: false } }, async ({ target: chart, args: values }, ctx) => {
            try {
                const value = await connection.call(operation, chart, values, ctx.mcpReq.signal);
                if (operation === 'screenshot') {
                    const image = value as { data?: unknown; mimeType?: unknown; width?: unknown; height?: unknown };
                    if (typeof image.data !== 'string' || image.data.length > 1_600_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || !['image/png', 'image/jpeg'].includes(String(image.mimeType))) throw new Error('Invalid chart image response.');
                    return { content: [{ type: 'image' as const, data: image.data, mimeType: String(image.mimeType) },
                        { type: 'text' as const, text: JSON.stringify({ width: image.width, height: image.height, note: 'Renderer capture with supported rasterized legends and overlays; excludes arbitrary app DOM and crosshair.' }) }] };
                }
                return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
            } catch (error) {
                const message = error instanceof ChartOperationError || error instanceof Error && /^(?:Use local|Reconnect the local|Local chart request failed|This Vela build|Chart target changed|The local chart bridge|Vela is updating|The chart did not complete|Invalid chart image)/.test(error.message)
                    ? error.message : 'The chart rejected this operation. Refresh its target and check the tool arguments.';
                return { content: [{ type: 'text' as const, text: message }], isError: true };
            }
        });
    };
    const empty = z.object({}).strict();
    const scenarioPrice = z.number().finite().min(-1e12).max(1e12).nullable();
    const scenarioCase = z.object({ thesis: z.string().max(4000), trigger: z.string().max(2000), invalidation: z.string().max(2000),
        triggerPrice: scenarioPrice, invalidationPrice: scenarioPrice, targetPrice: scenarioPrice,
        projectedTime: z.number().int().min(0).max(8_640_000_000_000_000).nullable() }).strict();
    const scenarioContent = z.object({ title: z.string().min(1).max(120), bull: scenarioCase, bear: scenarioCase, notes: z.string().max(8000),
        evidence: z.array(z.object({ kind: z.literal('candle'), sourceIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            time: z.number().int().min(0).max(8_640_000_000_000_000), note: z.string().max(1000) }).strict()).max(SCENARIO_LIMITS.evidence) }).strict()
        .refine(value => { try { parseScenarioContent(value); return true; } catch { return false; } }, 'Invalid bounded scenario content.');
    tool('read_candle_evidence', 'Explain one exact revealed candle, selectedTime in UTC epoch milliseconds or the latest revealed candle when omitted. Captures a fixed scope through the loaded replay clock. Returns deterministic raw OHLCV arithmetic, actual displayed values with explicit transform, bounded prior comparisons and exact evidence IDs/formulas/provenance. Forming candles use revealed source bars only. Causes/news/order types are unavailable from price-only bars. No model call, replay advance or chart mutation.', z.object({ selectedTime: z.number().int().min(0).max(4_102_444_800_000).optional() }).strict(), true);
    tool('propose_scenario', 'Place a bull/bear/invalidation hypothesis in the local scenario notebook as an editable draft for the exact loaded session/dataset/cursor. The response explicitly reports draftOnly and its context. This does not save to the HTTP library, preview annotations, draw on the chart, advance replay or place orders. The user separately chooses Save or Preview. Evidence references must be revealed source candles; projected hypothesis times may be future.', z.object({ content: scenarioContent }).strict(), false);
    tool('read_analysis_request', 'Read the question and pinned chart region queued through the chart AI panel. The external AI host can then inspect candles, calculate unplotted studies, or draw on the chart. Requests expire with their scope; no model request is started inside Vela.', empty, true);
    tool('backtest_indicator', 'Open the actual strategy tester for an exact existing Pine strategy on the active chart. Default replay mode uses revealed candles only. Deep mode requires explicit epoch-ms from/to and uses selected cached history beyond replay; never use it for blind replay analysis. Returns an asynchronous job; the shared tester UI, cancellation, save and export remain available. No manual order or replay advance is placed.', z.object({ id: z.string().min(1).max(100), mode: z.enum(['replay', 'deep']).optional(), from: z.number().int().nonnegative().optional(), to: z.number().int().nonnegative().optional() }).strict(), false);
    tool('read_backtest_job', 'Read a strategy tester job and the exact report generation it published, with result totals and save status. This result is separate from the manual replay account.', z.object({ jobId: z.uuid() }).strict(), true);
    tool('cancel_backtest_job', 'Cancel only the running strategy tester job started through this bridge. UI/editor runs and completed reports are preserved.', z.object({ jobId: z.uuid() }).strict(), false);
    const metadataPage = { limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(10000).optional() };
    const detailLimit = z.number().int().min(1).max(500).optional();
    tool('read_session', 'Read this manual replay account, positions, prop rules/status, costs, orders, fills, trades and bookmarks. This ledger is separate from Pine strategy results. Only current revealed session history is returned.', z.object({ limit: detailLimit }).strict(), true);
    tool('list_scripts', 'List local saved Pine document metadata. Source is omitted. Saved documents are global library context, independent of the replay clock.', z.object({ ...metadataPage, includeArchived: z.boolean().optional() }).strict(), true);
    tool('read_script', 'Read an explicit saved Pine document/version and version metadata. Source is included only on request and preserves code syntax/path literals except credential redaction; sourceRedacted/sourceTruncated report changes. Library context can describe work from other sessions.', z.object({ id: z.uuid(), version: z.number().int().min(1).optional(), includeSource: z.boolean().optional() }).strict(), true);
    tool('list_backtests', 'Explicitly inspect metadata for saved historical Pine backtests, including Deep runs that may extend beyond the current replay. No saved result ledger is included in this list.', z.object({ ...metadataPage, strategyId: z.uuid().optional() }).strict(), true);
    tool('read_backtest', 'Explicitly read a saved historical result by ID. Results may include future replay history and are client-reported snapshots, not execution-signed results. Keep them separate from blind replay analysis. Opted-in source preserves code syntax/path literals except credential redaction; sourceRedacted/sourceTruncated report changes.', z.object({ id: z.uuid(), limit: detailLimit, includeSource: z.boolean().optional() }).strict(), true);
    tool('read_workspace', 'Read current layout, cells, active cell and synchronization metadata. Serialized extensions and script source are omitted.', empty, true);
    tool('list_templates', 'List local chart, indicator and layout template metadata. Template contents and source are omitted.', z.object(metadataPage).strict(), true);
    tool('read_current_result', 'Explicitly inspect the current strategy report. Pass the completed backtest job generation as expectedGeneration to reject a replaced report. This may be a loaded saved or Deep result beyond the replay clock, separate from the manual replay ledger.', z.object({ limit: detailLimit, expectedGeneration: z.number().int().nonnegative().optional() }).strict(), true);
    tool('capture_analysis_scope', 'Capture a fixed historical region from the current viewport, explicit inclusive epoch-ms from/to, or one drawing ID. Pins dataset, chart, replay cursor and whole-source-candle availability. Pausing replay is recommended; changing the chart/session/cursor invalidates the scope. No chart mutation or future replay access.', z.union([empty, z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).strict(), z.object({ drawingId: z.string().min(1).max(128) }).strict()]), true);
    tool('read_analysis_scope', 'Read the exact region and historical clock of a captured scope. Scopes expire after five minutes.', z.object({ scopeId: z.uuid() }).strict(), true);
    tool('evaluate_analysis', 'Compute unplotted Pine indicators or strategies for a captured region in a disposable isolated worker, without changing the chart. Supports alternate timeframes and hidden plots. Primary/secondary history uses one pinned historical cutoff. Warmup is bounded to 50,000 bars; strategy totals include warmup. Returns a job immediately; read_analysis_job returns bounded numeric results and provenance. Two concurrent jobs, 30-second deadline.', z.object({ scopeId: z.uuid(), source: z.string().min(1).max(60000), inputs: inputs.optional(), properties: inputs.optional(), timeframe: z.string().max(8).optional(), warmupBars: z.number().int().min(1).max(50000).optional(), plotKeys: z.array(z.string().min(1).max(100)).max(16).optional(), variableKeys: z.array(z.string().min(1).max(100)).max(32).optional(), includeTrades: z.boolean().optional(), limit: detailLimit, pointsFrom: z.enum(['start', 'end']).optional(), includeSource: z.boolean().optional() }).strict(), true);
    tool('read_analysis_job', 'Read an isolated analysis job and its bounded result, output names, selected-region points, last-bar variables, warnings and dataset provenance. At most 1000 plot points total and 500 trades. Worker extraction can transfer the complete bounded warmup before host slicing.', z.object({ jobId: z.uuid() }).strict(), true);
    tool('cancel_analysis_job', 'Cancel a detached analysis calculation and release its worker. No chart indicator or saved data is removed.', z.object({ jobId: z.uuid() }).strict(), false);
    tool('read_operation', 'Reconcile a previous operation by its requestId and original target, including after timeout or window disconnect. A missing or expired receipt means unknown, never proof that an edit failed. This tool does not repeat or dispatch the original operation.', z.object({ requestId: z.uuid() }).strict(), true);
    tool('read_chart', 'Read the named chart: visible range, drawings, indicator settings and formatted current or hovered plot values. Values are not raw historical indicator series.', z.object({ drawingLimit: z.number().int().min(0).max(500).optional() }).strict(), true);
    tool('read_candles', 'Read up to 1000 revealed OHLCV bars. Optional from/to select an inclusive historical bar-open range; use read_chart visibleRange to inspect the current viewport without moving it. Native custom resolutions include 3S,7,120,D,2D,W,2W,M,3M. Finer than the source is rejected; the incomplete higher-timeframe bar contains revealed source data only. Calendar months and Monday weeks use real boundaries.', z.object({ timeframe: z.string().max(8).optional(), limit: z.number().int().min(1).max(1000).optional(), from: z.number().int().nonnegative().optional(), to: z.number().int().nonnegative().optional() }).strict(), true);
    tool('set_timeframe', 'Change the named cell resolution through the local replay data loader. Other cells stay unchanged.', z.object({ timeframe: z.string().max(8) }).strict(), false);
    tool('list_drawing_tools', 'List installed drawing tool types, labels and required anchor counts. Use those exact types in drawing actions.', empty, true);
    tool('add_drawing', 'Create an editable native drawing in the price pane. Anchor times are epoch milliseconds; price is in instrument units. Changes save with the current session.', z.object({ type: z.string().max(60), anchors: z.array(anchor).min(1).max(128), style: style.optional(), text: z.string().max(2000).optional() }).strict(), false);
    tool('update_drawing', 'Edit one existing drawing by exact id; unspecified fields remain unchanged.', z.object({ id: z.string().min(1).max(100), anchors: z.array(anchor).min(1).max(128).optional(), style: style.optional(), text: z.string().max(2000).optional(), visible: z.boolean().optional(), locked: z.boolean().optional() }).strict(), false);
    tool('remove_drawing', 'Remove one drawing by exact id, saved with this session.', z.object({ id: z.string().min(1).max(100) }).strict(), false);
    tool('list_indicators', 'Read available native studies and all current native/Pine instances, input and declaration-property schemas/settings, plus formatted hover/latest values. Use read_script_context for Pine plot history and strategy trades.', empty, true);
    tool('add_indicator', 'Add one registered native indicator by exact type. Query list_indicators for supported types and inputs first.', z.object({ type: z.string().min(1).max(80), inputs: inputs.optional() }).strict(), false);
    tool('update_indicator', 'Edit validated input values, Pine declaration properties, or visibility of an existing native/Pine indicator by id. Settings save immediately; the script recomputes asynchronously.', z.object({ id: z.string().min(1).max(100), inputs: inputs.optional(), properties: inputs.optional(), visible: z.boolean().optional() }).strict(), false);
    tool('remove_indicator', 'Remove one indicator by exact id.', z.object({ id: z.string().min(1).max(100) }).strict(), false);
    const scriptArguments = { source: z.string().min(1).max(60000), inputs: inputs.optional(), properties: inputs.optional() };
    tool('run_script', 'Compile and run Pine indicator/strategy source in the isolated local engine using revealed data. Returns a jobId immediately; poll read_script_job until completed and saved, or cancel_script_job. Four simultaneous jobs maximum; each has a 30-second deadline. Source never executes in the chart UI thread.', z.object(scriptArguments).strict(), false);
    tool('update_script', 'Safely replace an existing Pine script after a staged replacement compiles and completes its first run. Returns a jobId immediately. On success indicatorId changes; the original remains if compilation fails, the target/replay changes, or the job is cancelled/expired. Poll read_script_job and use the returned indicatorId.', z.object({ ...scriptArguments, id: z.string().min(1).max(100), source: scriptArguments.source.optional() }).strict(), false);
    tool('read_script_job', 'Read a Pine compilation/execution job created on this exact chart target. Completed plus saved:true confirms the script is running and persisted. A completed job with saved:false or an error requires checking its save status. Recent job metadata is retained for up to five minutes.', z.object({ jobId: z.uuid() }).strict(), true);
    tool('cancel_script_job', 'Cancel a running Pine job and remove only its staged instance. A replacement leaves its original script intact; a completed job remains on the chart and can be removed with remove_indicator.', z.object({ jobId: z.uuid() }).strict(), false);
    const contextArgs = z.object({ id: z.string().min(1).max(100), plotKeys: z.array(z.string().min(1).max(100)).max(16).optional(), variableKeys: z.array(z.string().min(1).max(100)).max(32).optional(), limit: detailLimit, trades: z.boolean().optional(), includeSource: z.boolean().optional(), from: z.number().int().nonnegative().optional(), to: z.number().int().nonnegative().optional() }).strict();
    tool('read_script_context', 'Read completed Pine numeric plot history, variables, strategy, trades, warnings and optional source. Pending/stale calculation identities return no numeric result. Inclusive from/to filters points/trades, not strategy totals or last-bar variables. At most 1000 points and 500 trades; source/settings remain readable when hidden.', contextArgs, true);
    tool('read_indicator_context', 'Read actual numeric output history of a current native or Pine indicator by ID, including hidden native studies when available. Same completion identity and replay limits as read_script_context. Native opaque renderer payloads and unacknowledged asynchronous output are explicitly unsupported/stale, never fabricated as numeric plots.', contextArgs, true);
    tool('set_viewport', 'Pan/zoom the named chart to an epoch-millisecond time range, or fit its revealed bars.', z.union([z.object({ from: z.number().finite().nonnegative(), to: z.number().finite().nonnegative() }).strict(), z.object({ fit: z.literal(true) }).strict()]), false);
    tool('screenshot', 'Inspect the actual named chart as a bounded image, including supported rasterized legends and overlays. Arbitrary app DOM and the crosshair are excluded.', empty, true);
    return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    serveStdio(() => createChartMcp());
}
