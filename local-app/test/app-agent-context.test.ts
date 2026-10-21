import { describe, expect, it, vi } from 'vitest';
import { createAppAgentContext, APP_CONTEXT_LIMITS, type AppAgentContextOptions, type AppWorkspaceSnapshot } from '../client/app-agent-context';
import { createSession } from '../engine';
import { DEFAULT_RULES, type SessionView, type Trade } from '../shared/types';
import type { BacktestSummary, StoredBacktest } from '../shared/scripts';
import type { StrategyResultsSnapshot } from '../shared/strategy-analysis';

const scriptId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
const start = Date.parse('2024-01-01T00:00:00Z');
function view(): SessionView {
    const session = createSession({ name: 'Manual practice', datasetId: 'cache', mode: 'prop', initialBalance: 50000, commissionPerContractSide: 2.5, slippageTicks: 1, spreadTicks: 2, startIndex: 0, rules: { ...DEFAULT_RULES } }, { root: 'NQ', tickSize: .25, pointValue: 20 }, 'test-session');
    session.cursor = 10;
    session.account.netPnl = 200;
    session.prop.tradingDays = 2;
    session.equityCurve = [{ time: start, balance: 50000, equity: 50000 }, { time: start + 600000, balance: 50200, equity: 50200 }];
    return { session, dataset: { id: 'cache', name: 'Cached history', symbol: 'NQM4', schema: 'ohlcv-1m', intervalMs: 60000, instrument: session.instrument, barCount: 10000, start, end: start + 10000000, source: 'csv', createdAt: '2024-01-01', checksum: 'abc' } };
}
function manualTrade(index: number, time: number): Trade {
    return { id: `manual-${index}`, side: 'buy', qty: 1, entryTime: time - 1000, exitTime: time, entryPrice: 100, exitPrice: 110, grossPnl: 200, fees: 5, netPnl: 195, reason: 'close', mae: 10, mfe: 210 };
}
const script = { id: scriptId, name: 'Saved strategy', revision: 3, versions: 2, createdAt: '2024-01-01', updatedAt: '2024-01-02', archived: false };
const versions = [{ scriptId, version: 1, name: 'First version', createdAt: '2024-01-01' }, { scriptId, version: 2, name: 'Saved strategy', createdAt: '2024-01-02' }];
function run(): StoredBacktest {
    return { id: runId, name: 'Immutable deep result', createdAt: '2024-01-03', strategyId: scriptId, scriptVersion: 2, source: 'strategy("saved")', symbol: 'NQM4', timeframe: '5', datasetId: 'cache', datasetChecksum: 'abc', from: start, to: start + 99999999, inputs: { length: 14 }, properties: { initial_capital: 10000 }, engine: { vela: '0.8.5' }, history: { mode: 'deep', requestedFrom: start, requestedTo: start + 99999999, barCount: 10000, checksum: 'abc', sourceDatasets: [{ id: 'cache', checksum: 'abc' }] }, result: { state: { equity: 12345, netPnl: 2345, maxDrawdown: 600 }, trades: [{ id: 'pine-1', side: 'short', qty: 2, entry: { id: 'entry', time: start + 99990000, price: 100 }, exit: { id: 'exit', time: start + 99995000, price: 90 }, open: false, pnl: 400 }], warnings: ['No historical account-equity curve.'] } };
}
function harness(options: Partial<AppAgentContextOptions> = {}, responses: Record<string, unknown> = {}) {
    const current = view();
    const get = vi.fn(async (path: string): Promise<unknown> => {
        if (!Object.hasOwn(responses, path)) throw new Error(`Unexpected read ${path}`);
        return structuredClone(responses[path]);
    });
    return { current, get, context: createAppAgentContext({ api: { get: <T>(path: string) => get(path) as Promise<T> }, getView: () => current, ...options }) };
}

describe('read-only application context', () => {
    it('keeps current manual account, prop rules and costs separate from Pine and makes no API reads', async () => {
        const result = vi.fn(() => { throw new Error('Pine result must not be read by default'); });
        const { current, context, get } = harness({ getCurrentResult: result });
        current.session.trades = [manualTrade(1, start + 1000)];
        const output = await context.readSession();
        expect(output).toMatchObject({ engine: 'manual-replay', scope: 'current-replay-only', pineResultsIncluded: false, account: { netPnl: 200 }, costs: { commissionPerContractSide: 2.5, slippageTicks: 1, spreadTicks: 2 }, prop: { state: { tradingDays: 2 }, rules: { profitTargetUsd: 3000 } } });
        expect(output.trades).toMatchObject({ total: 1, items: [{ id: 'manual-1', netPnl: 195 }] });
        expect(get).not.toHaveBeenCalled(); expect(result).not.toHaveBeenCalled();
    });

    it('filters future manual events using the replay horizon and returns only the latest requested visible rows', async () => {
        const { current, context } = harness({ getCursorTime: () => start + 3000 });
        current.session.trades = [1000, 2000, 3000, 4000].map((time, index) => manualTrade(index, start + time));
        current.session.bookmarks = [{ id: 'past', time: start + 1000, label: 'Review' }, { id: 'future', time: start + 4000, label: 'Future' }];
        current.session.orders = [{ id: 'future-fill', side: 'buy', type: 'market', qty: 1, status: 'filled', createdTime: start + 1000, filledTime: start + 4000, fillPrice: 10 }];
        const output = await context.readSession({ limit: 2 });
        expect(output.trades).toMatchObject({ total: 3, returned: 2, truncated: true, items: [{ id: 'manual-1' }, { id: 'manual-2' }] });
        expect(output.bookmarks).toMatchObject({ total: 1, items: [{ id: 'past' }] });
        expect(output.orders).toMatchObject({ total: 0 });
        expect(JSON.stringify(output)).not.toContain('future');
    });

    it('fails closed for event history before any replay candle and returns detached data', async () => {
        const { current, context } = harness();
        current.session.equityCurve = [];
        current.session.trades = [manualTrade(1, start)];
        const before = await context.readSession();
        expect(before).toMatchObject({ cursorTime: null, trades: { total: 0 } });
        (before.account as Record<string, unknown>).balance = -1;
        expect(current.session.account.balance).toBe(50000);
    });

    it('lists only script metadata with bounded pagination and never includes accidentally supplied source', async () => {
        const scripts = Array.from({ length: 130 }, (_, index) => ({ ...script, id: String(index), source: 'do-not-expose' }));
        const { context } = harness({}, { '/api/scripts': scripts });
        const output = await context.listScripts({ offset: 95, limit: 10 });
        expect(output.scripts).toMatchObject({ total: 130, returned: 10, offset: 95, truncated: true });
        expect(JSON.stringify(output)).not.toContain('do-not-expose');
    });

    it('reads document/version metadata without even fetching source-bearing endpoints', async () => {
        const { context, get } = harness({}, { [`/api/scripts/${scriptId}/versions`]: versions, '/api/scripts?includeArchived=true': [script] });
        expect(await context.readScript({ id: scriptId })).toMatchObject({ sourceIncluded: false, document: { revision: 3 }, versions: { total: 2 } });
        expect(await context.readScript({ id: scriptId, version: 1 })).toMatchObject({ sourceIncluded: false, document: { version: 1, name: 'First version' } });
        expect(get.mock.calls.map(([path]) => path)).not.toContain(`/api/scripts/${scriptId}`);
        await expect(context.readScript({ id: scriptId, version: 3 })).rejects.toThrow('unavailable');
    });

    it('fetches source only for an explicit includeSource and saved version', async () => {
        const { context, get } = harness({}, { [`/api/scripts/${scriptId}/versions`]: versions, [`/api/scripts/${scriptId}/versions/2`]: { ...versions[1], source: 'strategy("version two")' } });
        expect(await context.readScript({ id: scriptId, version: 2, includeSource: true })).toMatchObject({ sourceIncluded: true, source: 'strategy("version two")' });
        expect(get).toHaveBeenLastCalledWith(`/api/scripts/${scriptId}/versions/2`);
    });

    it('requires a valid explicit ID and strict arguments before any read or callback', async () => {
        const { context, get } = harness();
        await expect(context.readBacktest({})).rejects.toThrow('explicit valid');
        await expect(context.readBacktest({ id: '../provider/download' })).rejects.toThrow('explicit valid');
        await expect(context.readScript({ id: scriptId, includeSource: 'true' })).rejects.toThrow('boolean');
        await expect(context.readSession({ limit: 501 })).rejects.toThrow('500');
        await expect(context.listScripts({ limit: 101 })).rejects.toThrow('100');
        await expect(context.readWorkspace({ includeSource: true })).rejects.toThrow('Unsupported');
        expect(get).not.toHaveBeenCalled();
    });

    it('identifies saved summaries as global historical context and excludes all result detail and source', async () => {
        const saved = run();
        const { context, get } = harness({}, { [`/api/backtests?strategyId=${scriptId}`]: [saved as BacktestSummary] });
        const output = await context.listBacktests({ strategyId: scriptId });
        expect(output).toMatchObject({ scope: 'global-historical-pine-results', replaySafe: false, resultsIncluded: false, sourceIncluded: false, backtests: { total: 1, items: [{ history: { mode: 'deep', barCount: 10000 } }] } });
        expect(JSON.stringify(output)).not.toContain('pine-1'); expect(JSON.stringify(output)).not.toContain('strategy("saved")');
        expect(get).toHaveBeenCalledTimes(1);
    });

    it('returns an explicit immutable Deep result with bounded original Pine fields and no invented equity', async () => {
        const saved = run();
        saved.result.trades = Array.from({ length: 600 }, (_, index) => ({ ...(saved.result.trades as object[])[0], id: `pine-${index}` }));
        const { context } = harness({}, { [`/api/backtests/${runId}`]: saved });
        const output = await context.readBacktest({ id: runId, limit: 500 });
        expect(output).toMatchObject({ immutable: true, replaySafe: false, engine: 'pine-strategy', scope: 'global-deep-historical-pine-result', result: { state: { netPnl: 2345 }, trades: { total: 600, returned: 500, truncated: true }, equity: { total: 0 }, equitySource: 'historical-account-equity-unavailable' } });
        expect(output).not.toHaveProperty('source');
    });

    it('redacts credentials and local paths while dropping arbitrary nested result fields', async () => {
        const saved = run();
        saved.name = 'Review C:\\Users\\private\\history.db';
        saved.inputs = { apiKey: 'forbidden', token: 'forbidden', directory: 'forbidden', safe: '/custom/private/data.csv' };
        saved.properties = { secret: 'forbidden', capital: 50000 };
        saved.source = 'strategy("demo")\n// token="private-token"\n// /home/private/key.txt\n// {"api_key":"json-private-token"}';
        saved.result.credentials = { token: 'forbidden' };
        saved.result.warnings = ['Authorization: Bearer private-token', 'Read /private/cached/file.db'];
        const { context } = harness({}, { [`/api/backtests/${runId}`]: saved });
        const output = await context.readBacktest({ id: runId, includeSource: true });
        const json = JSON.stringify(output);
        expect(json).not.toContain('forbidden'); expect(json).not.toContain('private-token'); expect(json).not.toContain('C:\\\\Users'); expect(json).not.toContain('/custom/private');
        expect(output).toMatchObject({ properties: { capital: 50000 }, inputs: { safe: '[local path]' }, sourceIncluded: true, sourceRedacted: true, sourceTruncated: false });
        expect(output.source).toContain('// /home/private/key.txt');
    });

    it('rejects oversized multibyte payloads instead of returning a misleading complete source', async () => {
        const { context } = harness({}, { [`/api/scripts/${scriptId}/versions`]: versions, [`/api/scripts/${scriptId}`]: { ...script, source: '漢'.repeat(100000) } });
        await expect(context.readScript({ id: scriptId, includeSource: true })).rejects.toThrow('256 KiB');
        expect(APP_CONTEXT_LIMITS.bytes).toBe(262144);
    });

    it('projects workspace/template metadata without reading extension data and clones sync groups', async () => {
        const poison = vi.fn(() => { throw new Error('Serialized source must never be accessed'); });
        const workspace: AppWorkspaceSnapshot = { layout: '2h', activeCellId: 'c2', sync: { viewport: { c1: 'red', c2: 'red' }, style: true }, cells: [{ id: 'c1', symbol: 'NQM4', timeframe: '5', priceStyle: 'candles' }, { id: 'c2', symbol: 'ESM4', timeframe: '1', priceStyle: 'line' }] };
        Object.defineProperty(workspace, 'ext', { enumerable: true, get: poison });
        const template = { id: 't1', name: 'Two charts', kind: 'workspace' as const, createdAt: '2024-01-01', updatedAt: '2024-01-01', revision: 1, archived: false };
        Object.defineProperty(template, 'data', { enumerable: true, get: poison });
        const { context } = harness({ workspace: () => workspace, templates: () => [template] });
        const output = await context.readWorkspace();
        expect(output).toMatchObject({ layout: '2h', activeCellId: 'c2', sync: { viewport: { c1: 'red' }, style: true }, cells: { total: 2 } });
        ((output.sync as Record<string, unknown>).viewport as Record<string, unknown>).c1 = 'blue';
        expect(workspace.sync.viewport).toMatchObject({ c1: 'red' });
        expect(await context.listTemplates()).toMatchObject({ sourceIncluded: false, templates: { total: 1, items: [{ kind: 'workspace', name: 'Two charts' }] } });
        expect(poison).not.toHaveBeenCalled();
    });

    it('reads the optional current Pine result only explicitly and retains the historical Deep warning', async () => {
        const saved = run();
        let generation = 7;
        const getCurrentResult = vi.fn(() => ({ generation, name: saved.name, savedRunId: saved.id, snapshot: saved,
            result: { name: saved.name, symbol: saved.symbol, timeframe: saved.timeframe, from: saved.from, to: saved.to, history: saved.history, ...saved.result } as unknown as StrategyResultsSnapshot }));
        const { context } = harness({ getCurrentResult });
        await context.readSession(); expect(getCurrentResult).not.toHaveBeenCalled();
        expect(await context.readCurrentResult({ expectedGeneration: 7 })).toMatchObject({ generation: 7, savedRunId: saved.id, engine: 'pine-strategy', scope: 'explicit-deep-historical-pine-result', replaySafe: false, sourceIncluded: false, result: { trades: { total: 1 } } });
        expect(getCurrentResult).toHaveBeenCalledTimes(1);
        generation = 8;
        await expect(context.readCurrentResult({ expectedGeneration: 7 })).rejects.toThrow('replaced');
    });

    it('reports unavailable optional surfaces without making any network reads', async () => {
        const { context, get } = harness({ getView: () => null });
        expect(await context.readSession()).toMatchObject({ available: false });
        expect(await context.readWorkspace()).toMatchObject({ available: false });
        expect(await context.readCurrentResult()).toMatchObject({ available: false });
        expect(await context.listTemplates()).toMatchObject({ available: false, templates: { total: 0 } });
        expect(get).not.toHaveBeenCalled();
    });
});
