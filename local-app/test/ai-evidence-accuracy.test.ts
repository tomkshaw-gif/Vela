import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { PineTS } from 'pinets';
import type { Vela } from '../../src/index';
import type { VelaWorkspace } from '../../src/workspace';
import { createChartAgentController, type ChartAgentController } from '../client/chart-agent';
import { createAppAgentContext } from '../client/app-agent-context';
import { ApiError } from '../client/api';
import { replaySnapshot } from '../client/chart-data';
import { createSession } from '../engine';
import { createReplayServer } from '../server/index';
import type { ChartAgentTask } from '../shared/chart-agent';
import { DEFAULT_RULES, INSTRUMENTS, type Bar, type ChartView, type SessionView } from '../shared/types';
import type { StoredBacktest } from '../shared/scripts';

const START = Date.UTC(2024, 3, 8);
const SCRIPT_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = '00000000-0000-4000-8000-000000000002';
const controllers: ChartAgentController[] = [];
const apps: Awaited<ReturnType<typeof createReplayServer>>[] = [];
const directories: string[] = [];
afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.dispose();
    for (const app of apps.splice(0)) await app.close();
    const parent = realpathSync(tmpdir());
    for (const directory of directories.splice(0)) {
        const actual = realpathSync(directory), child = relative(parent, actual);
        if (!child || isAbsolute(child) || child.startsWith('..') || !child.startsWith('vela-ai-accuracy-')) throw new Error('Unexpected fixture cleanup target.');
        rmSync(actual, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
});
const bars = (high = 102): Bar[] => Array.from({ length: 3 }, (_, index) => ({ time: START + index * 60_000, open: 100, high, low: 99, close: 101, volume: 10 }));
function view(): SessionView {
    const instrument = INSTRUMENTS[0]!;
    const dataset = { id: 'synthetic', name: 'Synthetic accuracy', symbol: 'NQM4', schema: 'ohlcv-1m' as const, intervalMs: 60_000,
        instrument, barCount: 3, start: START, end: START + 180_000, source: 'csv' as const, createdAt: '2024-04-08', checksum: 'checksum-A' };
    const session = createSession({ name: 'Synthetic accuracy', datasetId: dataset.id, mode: 'practice', initialBalance: 50_000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES } }, instrument);
    session.cursor = 2; return { session, dataset };
}
function controller(initial = view(), get: <T>(path: string, signal?: AbortSignal) => Promise<T> = async <T>() => ({ bars: bars(), cursorTime: START + 120_000, intervalMs: 60_000, hasMore: false }) as T) {
    let current = initial; let clock: number | null = START + 120_000;
    const chart = { market: { symbol: 'replay:NQM4', timeframe: '1' } } as Vela;
    const cells = [{ id: 'cell', chart }];
    const workspace = { cells: () => cells, cell: (id: string) => cells.find(cell => cell.id === id) } as unknown as Pick<VelaWorkspace, 'cells' | 'cell' | 'context'>;
    const read = vi.fn(get);
    const agent = createChartAgentController({ api: { get: <T>(path: string, signal?: AbortSignal) => read(path, signal) as Promise<T>, post: async <T>() => ({ request: null }) as T, postKeepalive: () => {} },
        workspace, session: () => current, generation: () => 1, cursorTime: () => clock, blocked: () => false,
        flush: async () => {}, setTimeframe: async () => {}, autoStart: false });
    controllers.push(agent);
    const task = (args: Record<string, unknown> = {}): ChartAgentTask => ({ requestId: crypto.randomUUID(), operation: 'read_candles', args,
        target: { clientId: agent.clientId, sessionId: initial.session.id, generation: 1, cellId: 'cell' }, deadline: Date.now() + 10_000 });
    return { agent, read, task, chart, cells, current: () => current, replace: (next: SessionView) => { current = next; }, clock: (next: number | null) => { clock = next; } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('AI candle evidence ownership', () => {
    it.each([{}, { from: START, to: START + 60_000 }])('pins the actual %j candle request to the existing replay snapshot and preserves bounds', async args => {
        const f = controller(); const expected = replaySnapshot(f.current());
        const result = await f.agent.execute(f.task(args)) as ChartView;
        const url = new URL(f.read.mock.calls[0]![0], 'http://local');
        expect(url.searchParams.get('snapshot')).toBe(expected);
        expect(url.pathname.endsWith('from' in args ? '/series' : '/chart')).toBe(true);
        if ('from' in args) { expect(url.searchParams.get('cursor')).toBe('2'); expect(result.bars.map(bar => bar.time)).toEqual([START, START + 60_000]); }
        else expect(result.bars).toEqual(bars());
    });
    it.each(['checksum', 'datasetId', 'revision', 'cursor', 'loaded clock', 'timeframe', 'cell'] as const)('rejects a same-request change to %s after await, including in-place mutations', async change => {
        const started = deferred<void>(), reply = deferred<ChartView>();
        const f = controller(view(), async <T>() => { started.resolve(); return reply.promise as Promise<T>; });
        const pending = f.agent.execute(f.task()); const rejected = expect(pending).rejects.toThrow(); await started.promise;
        if (change === 'checksum') f.current().dataset.checksum = 'checksum-B';
        if (change === 'datasetId') f.current().dataset.id = 'other';
        if (change === 'revision') f.current().session.revision += 1;
        if (change === 'cursor') f.current().session.cursor += 1;
        if (change === 'loaded clock') f.clock(START + 60_000);
        if (change === 'timeframe') f.chart.market.timeframe = '5';
        if (change === 'cell') f.cells.splice(0);
        reply.resolve({ bars: bars(), cursorTime: START + 120_000, timeframe: '1', baseIntervalMs: 60_000, intervalMs: 60_000, hasMore: false }); await rejected;
    });
    it('fails closed against different cached data at the same cursor through the public controller and actual synthetic HTTP routes', { timeout: 15_000 }, async () => {
        const directory = mkdtempSync(join(tmpdir(), 'vela-ai-accuracy-')); directories.push(directory);
        const provider = vi.fn(async () => { throw new Error('No provider access in this fixture.'); });
        const app = await createReplayServer({ dataDirectory: directory, port: 0, fetch: provider }); apps.push(app); const url = await app.listen();
        const actual = app.store.addDataset({ name: 'Synthetic B', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars: bars(900) });
        const saved = view(); saved.dataset = actual; saved.session.config.datasetId = actual.id;
        app.store.createSession(saved.session);
        const loaded = structuredClone(saved); loaded.dataset.checksum = 'checksum-A';
        const get = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
            const response = await fetch(`${url}${path}`, { signal }); const value = await response.json() as T & { error?: string };
            if (!response.ok) throw new ApiError(value.error ?? 'Fixture read failed', response.status); return value;
        };
        const f = controller(loaded, get);
        const raw = await get<ChartView>(`/api/sessions/${saved.session.id}/chart?timeframe=1&limit=200`);
        expect(raw.bars[0]!.high).toBe(900); expect(bars()[0]!.high).toBe(102);
        await expect(f.agent.execute(f.task())).rejects.toMatchObject({ status: 409 });
        await expect(f.agent.execute(f.task({ from: START, to: START + 60_000 }))).rejects.toMatchObject({ status: 409 });
        const fresh = controller(saved, get); expect((await fresh.agent.execute(fresh.task()) as ChartView).bars[0]!.high).toBe(900);
        expect(provider).not.toHaveBeenCalled();
    });
});

function codeContext(source: string) {
    const script = { id: SCRIPT_ID, name: 'Metadata /private/cache.db', revision: 0, versions: 1, archived: false, createdAt: '2024-04-08', updatedAt: '2024-04-08', source };
    const version = { scriptId: SCRIPT_ID, version: 1, name: script.name, createdAt: script.createdAt, source };
    const saved: StoredBacktest = { id: RUN_ID, name: 'Synthetic saved run', createdAt: script.createdAt, scriptVersion: 1, source,
        symbol: 'NQM4', timeframe: '1', datasetId: 'synthetic', datasetChecksum: 'checksum-A', from: START, to: START + 120_000, inputs: {}, properties: {}, engine: {}, result: {} };
    const responses: Record<string, unknown> = { [`/api/scripts/${SCRIPT_ID}/versions`]: [version], [`/api/scripts/${SCRIPT_ID}`]: script,
        [`/api/scripts/${SCRIPT_ID}/versions/1`]: version, [`/api/backtests/${RUN_ID}`]: saved };
    return createAppAgentContext({ getView: () => null, api: { get: async <T>(path: string) => structuredClone(responses[path]) as T } });
}
describe('explicit AI source projection', () => {
    it.each(['plot(close /2)', 'plot(close / 2)', 'plot(close /math.max(1, 2))'])('returns exact opted-in %s code for script, version and backtest while sanitizing metadata', async expression => {
        const source = `//@version=6\nindicator("Division")\n${expression}`; const context = codeContext(source);
        const outputs = await Promise.all([context.readScript({ id: SCRIPT_ID, includeSource: true }), context.readScript({ id: SCRIPT_ID, version: 1, includeSource: true }), context.readBacktest({ id: RUN_ID, includeSource: true })]);
        for (const output of outputs) expect(output).toMatchObject({ source, sourceIncluded: true, sourceRedacted: false, sourceTruncated: false });
        expect(outputs[0]!.document).toMatchObject({ name: 'Metadata [local path]' });
        const result = await new PineTS([{ openTime: START, closeTime: START + 60_000, open: 100, high: 102, low: 99, close: 100, volume: 10 }]).run(outputs[0]!.source as string);
        expect(Object.values(result.plots)[0]).toMatchObject({ data: [{ value: 50 }] });
    });
    it('preserves code paths/comments exactly and reports actual credential redaction separately', async () => {
        const source = '//@version=6\nindicator("Exact")\n// /home/private/example.pine\nlabel = "C:\\private\\file"\nplot(close /2)';
        expect(await codeContext(source).readScript({ id: SCRIPT_ID, includeSource: true })).toMatchObject({ source, sourceRedacted: false, sourceTruncated: false });
        const credential = `${source}\n// token="synthetic-private-value"\n// Bearer synthetic-example`;
        const output = await codeContext(credential).readBacktest({ id: RUN_ID, includeSource: true });
        expect(output).toMatchObject({ sourceRedacted: true, sourceTruncated: false });
        expect(output.source).toContain('plot(close /2)'); expect(output.source).not.toContain('synthetic-private-value'); expect(output.source).not.toContain('synthetic-example');
    });
    it('reports code truncation and omits source projection unless explicitly requested', async () => {
        const source = 'x'.repeat(200_001); const context = codeContext(source);
        const output = await context.readScript({ id: SCRIPT_ID, includeSource: true });
        expect(output).toMatchObject({ sourceTruncated: true, sourceRedacted: false });
        expect((output.source as string).length).toBe(200_000); expect(output.source === source.slice(0, 200_000)).toBe(true);
        const metadata = await context.readScript({ id: SCRIPT_ID, version: 1 }); expect(metadata).not.toHaveProperty('source'); expect(metadata).not.toHaveProperty('sourceRedacted');
        expect(await context.readBacktest({ id: RUN_ID })).not.toHaveProperty('source');
    });
});
