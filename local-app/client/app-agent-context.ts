import type { SyncOptions } from '../../src/workspace';
import type { BacktestSummary, ScriptDocument, ScriptSummary, ScriptVersion, ScriptVersionSummary, StoredBacktest } from '../shared/scripts';
import type { SessionView } from '../shared/types';
import type { LocalApi } from './api';
import type { ChartTemplate } from './chart-templates';
import type { ScriptWorkspaceResult } from './script-workspace';

export const APP_CONTEXT_LIMITS = Object.freeze({ bytes: 256 * 1024, metadata: 100, detail: 500 });
export interface AppWorkspaceSnapshot {
    layout: string;
    activeCellId: string | null;
    sync: SyncOptions;
    cells: readonly { id: string; symbol: string; timeframe: string; priceStyle: string }[];
}
export type AppTemplateMetadata = Pick<ChartTemplate, 'id' | 'name' | 'kind' | 'createdAt' | 'updatedAt' | 'revision' | 'archived'>;
export interface AppAgentContextOptions {
    api: Pick<LocalApi, 'get'>;
    getView: () => SessionView | null;
    getCursorTime?: () => number | null;
    workspace?: () => AppWorkspaceSnapshot | null;
    templates?: () => readonly AppTemplateMetadata[];
    getCurrentResult?: () => ScriptWorkspaceResult | null;
}
export interface AppAgentContext {
    readSession(args?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
    listScripts(args?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
    readScript(args?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
    listBacktests(args?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
    readBacktest(args?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
    readWorkspace(args?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
    listTemplates(args?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
    readCurrentResult(args?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

type Fields = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE_FIELD = /(?:api[_-]?key|authorization|cookie|password|secret|token|credential|source|path|directory)/i;
const STATE_FIELDS = ['position', 'avgPrice', 'equity', 'openPnl', 'netPnl', 'grossProfit', 'grossLoss', 'wins', 'losses', 'even', 'maxDrawdown', 'maxRunup', 'initialCapital'];
const SCRIPT_FIELDS = ['id', 'name', 'revision', 'versions', 'createdAt', 'updatedAt', 'archived'];
const RUN_FIELDS = ['id', 'name', 'createdAt', 'strategyId', 'scriptVersion', 'symbol', 'timeframe', 'datasetId', 'datasetChecksum', 'from', 'to'];

function object(value: unknown): Fields {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Fields;
}
function request(value: unknown, allowed: string[]): Fields {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Context arguments must be a plain object.');
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!allowed.includes(key) || !('value' in descriptor)) throw new Error('Unsupported context argument.');
    }
    return value as Fields;
}
function number(value: unknown, fallback: number, max: number, min = 1): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Context limit must be an integer from ${min} to ${max}.`);
    return value;
}
function flag(value: unknown): boolean {
    if (value === undefined) return false;
    if (typeof value !== 'boolean') throw new Error('Context flags must be boolean.');
    return value;
}
function id(value: unknown): string {
    if (typeof value !== 'string' || !UUID.test(value)) throw new Error('An explicit valid saved document or result ID is required.');
    return value;
}
function redactCredentials(value: string): string {
    return value.replace(/\b(?:sk-[a-z0-9_-]{12,}|Bearer\s+[a-z0-9._~-]+)/gi, '[credential]')
        .replace(/\b(api[_-]?key|authorization|cookie|password|secret|token|credential)["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1=[credential]')
        .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[credential]@');
}
function clean(value: string, max = 1024): string {
    return redactCredentials(value.slice(0, max)
        .replace(/(?:[a-z]:[\\/]|\\\\)[^\s"'<>]*/gi, '[local path]')
        .replace(/(^|[\s"'=(])\/(?!\/)[^\s"'<>]+/g, '$1[local path]'));
}
/** Opted-in code retains its syntax and path literals; only credential redaction may alter it. */
function sourceProjection(value: string): Fields {
    const redacted = redactCredentials(value);
    return { source: redacted.slice(0, 200000), sourceRedacted: redacted !== value, sourceTruncated: redacted.length > 200000 };
}
function scalar(value: unknown): string | number | boolean | null | undefined {
    if (typeof value === 'string') return clean(value);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return undefined;
}
function pick(value: unknown, fields: readonly string[]): Fields {
    const input = object(value), output: Fields = {};
    for (const key of fields) {
        const result = scalar(input[key]);
        if (result !== undefined) output[key] = result;
    }
    return output;
}
function targetProjection(value: unknown): Fields {
    return Array.isArray(value) ? { takeProfits: value.slice(0, 10).map(leg => pick(leg, ['id', 'price', 'qty'])) } : {};
}
function settings(value: unknown): Fields {
    const input = object(value), result: Fields = {};
    for (const key of Object.keys(input).slice(0, APP_CONTEXT_LIMITS.metadata)) {
        if (PRIVATE_FIELD.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
        const field = scalar(input[key]);
        if (field !== undefined) result[clean(key, 128)] = field;
    }
    return result;
}
function page<T>(values: readonly T[], limit: number, project: (value: T) => unknown, offset = 0, latest = false): Fields {
    const start = latest ? Math.max(0, values.length - limit) : offset;
    const items = values.slice(start, start + limit).map(project);
    return { items, total: values.length, returned: items.length, offset: start, truncated: start > 0 || start + items.length < values.length };
}
function finish(value: Fields): Fields {
    const json = JSON.stringify(value);
    if (new TextEncoder().encode(json).byteLength > APP_CONTEXT_LIMITS.bytes) throw new Error('Context exceeds 256 KiB. Request fewer rows or omit source.');
    return JSON.parse(json) as Fields;
}
function history(value: unknown): Fields | undefined {
    const input = object(value);
    if (input.mode !== 'deep') return undefined;
    const result = pick(input, ['mode', 'requestedFrom', 'requestedTo', 'barCount', 'checksum']);
    for (const key of ['sourceDatasets', 'secondarySourceDatasets']) if (Array.isArray(input[key])) result[key] = page(input[key] as unknown[], 100, item => pick(item, ['id', 'checksum']));
    return result;
}
function provenance(value: unknown): Fields | null {
    const input = object(value);
    if (input.version !== 1 || input.mode !== 'replay') return null;
    return { ...pick(input, ['version', 'mode', 'sessionId', 'cursor', 'cutoff']), reportedBy: 'client',
        primarySourceDatasets: page(Array.isArray(input.primarySourceDatasets) ? input.primarySourceDatasets : [], 100, item => pick(item, ['id', 'checksum'])),
        secondarySourceDatasets: page(Array.isArray(input.secondarySourceDatasets) ? input.secondarySourceDatasets : [], 100, item => pick(item, ['id', 'checksum'])) };
}
function runMetadata(value: BacktestSummary | StoredBacktest): Fields {
    return { ...pick(value, RUN_FIELDS), engine: settings(value.engine), ...(value.history ? { history: history(value.history) } : {}) };
}
function pineResult(value: unknown, limit: number): Fields {
    const result = object(value);
    const trades = Array.isArray(result.trades) ? result.trades : [];
    const equity = Array.isArray(result.equity) ? result.equity : [];
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    return {
        state: pick(result.state, STATE_FIELDS),
        trades: page(trades, limit, value => {
            const trade = object(value);
            return { ...pick(trade, ['id', 'side', 'qty', 'open', 'pnl', 'commission', 'maxDrawdown', 'maxRunup']), entry: pick(trade.entry, ['id', 'time', 'price', 'comment']), ...(trade.exit ? { exit: pick(trade.exit, ['id', 'time', 'price', 'comment']) } : {}) };
        }),
        equity: page(equity, limit, item => pick(item, ['time', 'value'])),
        equitySource: equity.length ? 'supplied-account-observations' : 'historical-account-equity-unavailable',
        warnings: page(warnings, 100, value => typeof value === 'string' ? clean(value, 2000) : clean(String(object(value).message ?? ''))),
    };
}

/** Read-only app evidence. Saved Pine results are never folded into manual replay state. */
export function createAppAgentContext(options: AppAgentContextOptions): AppAgentContext {
    return {
        async readSession(args) {
            const input = request(args, ['limit']);
            const limit = number(input.limit, 100, APP_CONTEXT_LIMITS.detail);
            const view = options.getView();
            if (!view) return { available: false, engine: 'manual-replay', reason: 'No replay session is open.' };
            const session = view.session;
            const cutoff = options.getCursorTime ? options.getCursorTime() : session.equityCurve.at(-1)?.time ?? null;
            const visible = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && cutoff !== null && value <= cutoff;
            return finish({
                available: true, engine: 'manual-replay', scope: 'current-replay-only', pineResultsIncluded: false,
                session: pick(session, ['id', 'status', 'revision', 'cursor', 'createdAt', 'updatedAt']), cursorTime: cutoff,
                config: pick(session.config, ['name', 'mode', 'initialBalance', 'startIndex']),
                costs: pick(session.config, ['commissionPerContractSide', 'slippageTicks', 'spreadTicks']),
                dataset: pick(view.dataset, ['id', 'name', 'symbol', 'schema', 'intervalMs', 'barCount', 'checksum', 'source']), instrument: pick(session.instrument, ['root', 'tickSize', 'pointValue']),
                account: pick(session.account, ['balance', 'equity', 'unrealizedPnl', 'netPnl', 'fees', 'peakEquity', 'maxDrawdown']),
                prop: { state: pick(session.prop, ['status', 'reason', 'dailyLoss', 'drawdownFloor', 'trailingPeak', 'tradingDays', 'bestDayProfit', 'consistencyPct']), rules: pick(session.config.rules, ['profitTargetUsd', 'maxDailyLossUsd', 'maxDrawdownUsd', 'drawdownType', 'drawdownLocksAtInitialBalance', 'minTradingDays', 'maxContracts', 'consistencyPct', 'dayResetTimezone', 'dayResetHour', 'requireFlatToPass']) },
                position: session.position && visible(session.position.entryTime) ? { ...pick(session.position, ['side', 'qty', 'avgPrice', 'entryTime', 'entryFees', 'stopLoss', 'takeProfit', 'initialRisk', 'mae', 'mfe']), ...targetProjection(session.position.takeProfits) } : null,
                orders: page(session.orders.filter(order => visible(order.createdTime) && (order.filledTime === undefined || visible(order.filledTime))), limit, order => ({ ...pick(order, ['id', 'side', 'type', 'qty', 'price', 'stopLoss', 'takeProfit', 'intent', 'status', 'createdTime', 'filledTime', 'fillPrice', 'rejectReason']), ...targetProjection(order.takeProfits) }), 0, true),
                fills: page(session.fills.filter(fill => visible(fill.time)), limit, fill => pick(fill, ['id', 'orderId', 'time', 'side', 'qty', 'price', 'fees', 'reason', 'takeProfitLegId']), 0, true),
                trades: page(session.trades.filter(trade => visible(trade.entryTime) && visible(trade.exitTime)), limit, trade => pick(trade, ['id', 'side', 'qty', 'entryTime', 'exitTime', 'entryPrice', 'exitPrice', 'grossPnl', 'fees', 'netPnl', 'reason', 'initialRisk', 'mae', 'mfe', 'takeProfitLegId']), 0, true),
                bookmarks: page(session.bookmarks.filter(bookmark => visible(bookmark.time)), limit, bookmark => pick(bookmark, ['id', 'time', 'label']), 0, true),
                equity: page(session.equityCurve.filter(point => visible(point.time)), limit, point => pick(point, ['time', 'balance', 'equity']), 0, true),
            });
        },
        async listScripts(args, signal) {
            const input = request(args, ['limit', 'offset', 'includeArchived']);
            const limit = number(input.limit, 100, 100), offset = number(input.offset, 0, 10000, 0), archived = flag(input.includeArchived);
            const scripts = await options.api.get<ScriptSummary[]>(`/api/scripts${archived ? '?includeArchived=true' : ''}`, signal);
            return finish({ scope: 'global-script-library-metadata', sourceIncluded: false, scripts: page(scripts, limit, script => pick(script, SCRIPT_FIELDS), offset) });
        },
        async readScript(args, signal) {
            const input = request(args, ['id', 'version', 'includeSource']);
            const scriptId = id(input.id), source = flag(input.includeSource);
            const version = input.version === undefined ? undefined : number(input.version, 1, 50);
            const versions = await options.api.get<ScriptVersionSummary[]>(`/api/scripts/${scriptId}/versions`, signal);
            let document: ScriptSummary | ScriptVersionSummary | ScriptDocument | ScriptVersion | undefined;
            if (source) document = await options.api.get<ScriptDocument | ScriptVersion>(`/api/scripts/${scriptId}${version === undefined ? '' : `/versions/${version}`}`, signal);
            else if (version !== undefined) document = versions.find(item => item.version === version);
            else document = (await options.api.get<ScriptSummary[]>('/api/scripts?includeArchived=true', signal)).find(item => item.id === scriptId);
            if (!document) throw new Error('The requested saved script or version is unavailable.');
            return finish({ scope: 'global-script-library-document', sourceIncluded: source, document: pick(document, [...SCRIPT_FIELDS, 'scriptId', 'version']), ...(version === undefined ? { versions: page(versions, 100, item => pick(item, ['scriptId', 'version', 'name', 'createdAt'])) } : {}), ...(source && 'source' in document ? sourceProjection(document.source) : {}) });
        },
        async listBacktests(args, signal) {
            const input = request(args, ['limit', 'offset', 'strategyId']);
            const limit = number(input.limit, 100, 100), offset = number(input.offset, 0, 10000, 0);
            const strategyId = input.strategyId === undefined ? undefined : id(input.strategyId);
            const runs = await options.api.get<BacktestSummary[]>(`/api/backtests${strategyId ? `?strategyId=${strategyId}` : ''}`, signal);
            return finish({ scope: 'global-historical-pine-results', replaySafe: false, resultsIncluded: false, sourceIncluded: false, notice: 'Saved runs may include unrevealed or Deep history. Request an explicit result ID for detail.', backtests: page(runs, limit, runMetadata, offset) });
        },
        async readBacktest(args, signal) {
            const input = request(args, ['id', 'limit', 'includeSource']);
            const runId = id(input.id), limit = number(input.limit, 100, 500), source = flag(input.includeSource);
            const run = await options.api.get<StoredBacktest>(`/api/backtests/${runId}`, signal);
            return finish({ scope: run.history ? 'global-deep-historical-pine-result' : 'global-historical-pine-result', engine: 'pine-strategy', replaySafe: false, immutable: true, sourceIncluded: source, metadata: runMetadata(run), inputs: settings(run.inputs), properties: settings(run.properties), provenance: provenance(run.provenance), result: pineResult(run.result, limit), ...(source ? sourceProjection(run.source) : {}) });
        },
        async readWorkspace(args) {
            request(args, []);
            const workspace = options.workspace?.();
            if (!workspace) return { available: false, reason: 'Workspace context is not connected.' };
            return finish({ available: true, scope: 'current-workspace-metadata', sourceIncluded: false, ...pick(workspace, ['layout', 'activeCellId']), sync: Object.fromEntries(Object.entries(workspace.sync).filter(([key]) => ['symbol', 'timeframe', 'crosshair', 'viewport', 'drawings', 'style'].includes(key)).map(([key, value]) => [key, typeof value === 'object' ? settings(value) : scalar(value)])), cells: page(workspace.cells, 100, cell => pick(cell, ['id', 'symbol', 'timeframe', 'priceStyle'])) });
        },
        async listTemplates(args) {
            const input = request(args, ['limit', 'offset']);
            const limit = number(input.limit, 100, 100), offset = number(input.offset, 0, 10000, 0);
            return finish({ available: !!options.templates, scope: 'global-template-metadata', sourceIncluded: false, templates: page(options.templates?.() ?? [], limit, template => pick(template, ['id', 'name', 'kind', 'createdAt', 'updatedAt', 'revision', 'archived']), offset) });
        },
        async readCurrentResult(args) {
            const input = request(args, ['limit', 'expectedGeneration']);
            const limit = number(input.limit, 100, 500), current = options.getCurrentResult?.();
            if (!current) return { available: false, reason: 'No current Pine result is connected.' };
            const expected = input.expectedGeneration === undefined ? undefined : number(input.expectedGeneration, 0, Number.MAX_SAFE_INTEGER, 0);
            if (expected !== undefined && expected !== current.generation) throw new Error('The strategy report has been replaced. Read its new generation before analysing it.');
            const result = current.result;
            return finish({ available: true, generation: current.generation, savedRunId: current.savedRunId ?? null,
                scope: result.history ? 'explicit-deep-historical-pine-result' : 'explicit-current-pine-result', engine: 'pine-strategy', replaySafe: false, sourceIncluded: false,
                metadata: pick(result, ['name', 'symbol', 'timeframe', 'from', 'to']), ...(result.history ? { history: history(result.history) } : {}),
                provenance: provenance(current.snapshot?.provenance), result: pineResult(result, limit) });
        },
    };
}
