import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import type { Vela } from '../../src/index';
import type { VelaWorkspace } from '../../src/workspace';
import { createChartAgentController, type ChartAgentController, type ChartAgentControllerOptions, type ResearchOwner } from '../client/chart-agent';
import { buildCandleEvidence, type CandleEvidence } from '../shared/candle-evidence';
import { emptyScenarioContent, type ScenarioContent } from '../shared/scenarios';
import { createSession } from '../engine';
import { createChartMcp } from '../mcp';
import { CHART_AGENT_OPERATIONS, type ChartAgentTask } from '../shared/chart-agent';
import { DEFAULT_RULES, INSTRUMENTS, type Bar, type SessionView } from '../shared/types';

const DATASET = '00000000-0000-4000-8000-000000000001';
const SESSION = '00000000-0000-4000-8000-000000000002';
const source: Bar[] = [0, 60_000, 120_000].map(time => ({ time, open: 100, high: 102, low: 99, close: 101, volume: 10 }));
const controllers: ChartAgentController[] = [];
afterEach(() => { controllers.splice(0).forEach(item => item.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function fixture(extra: Partial<ChartAgentControllerOptions> = {}) {
    const dataset = { id: DATASET, checksum: 'c'.repeat(64), name: 'Synthetic fixture', symbol: 'NQM4', schema: 'ohlcv-1m' as const, intervalMs: 60_000,
        instrument: INSTRUMENTS[0]!, barCount: 3, start: 0, end: 180_000, source: 'csv' as const, createdAt: '2024-01-01' };
    const session = createSession({ name: 'Synthetic fixture', datasetId: DATASET, mode: 'practice', initialBalance: 50_000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES }, dataset.instrument, SESSION);
    session.cursor = 2; session.revision = 3; const view: SessionView = { session, dataset };
    let clock: number | null = 120_000; let style = 'candles'; let generation = 1; let blocked = false;
    const nativeChart = { market: { symbol: 'replay:NQM4', timeframe: '1' }, renderer: { get: () => style }, drawings: { all: () => [] }, getVisibleRange: () => ({ from: 0, to: 120_000 }) };
    const chart = nativeChart as unknown as Vela; const cells = [{ id: 'cell', chart }];
    const get = vi.fn(async (_path: string, _signal?: AbortSignal): Promise<unknown> => ({ bars: [source[2]], cursorTime: 120_000, baseIntervalMs: 60_000, datasetId: DATASET, checksum: dataset.checksum }));
    const post = vi.fn(async (_path: string, body: unknown) => ({ request: null, proposal: { requestId: (body as { requestId: string }).requestId, authorized: true } })); const flush = vi.fn(async () => {});
    const candleEvidence = vi.fn<NonNullable<ChartAgentControllerOptions['candleEvidence']>>(async (input, owner) => {
        owner.assertCurrent(); const envelope = { dataset: input.scope.dataset, cursorTime: input.scope.cursorTime, sourceCutoff: input.scope.clock.sourceCutoff, bars: source };
        return buildCandleEvidence({ scope: input.scope, selectedTime: input.selectedTime ?? 120_000, raw: { ...envelope, from: 0, to: 180_000 },
            displayed: envelope, transform: { kind: 'none' }, assertCurrent: owner.assertCurrent });
    });
    const proposals: ScenarioContent[] = [];
    const proposeScenario = vi.fn<NonNullable<ChartAgentControllerOptions['proposeScenario']>>(async (input, owner) => {
        owner.assertCurrent();
        await owner.commitDraft!(() => { proposals.push(input.content); return true; });
        return { draftOnly: true, context: input.context };
    });
    const agent = createChartAgentController({ api: { get: <T>(path: string, signal?: AbortSignal) => get(path, signal) as Promise<T>, post: <T>(path: string, body: unknown) => post(path, body) as Promise<T>, postKeepalive: () => {} },
        workspace: { cells: () => cells, cell: (id: string) => cells.find(cell => cell.id === id), context: () => ({ activeCellId: 'cell' }) } as unknown as Pick<VelaWorkspace, 'cells' | 'cell' | 'context'>,
        session: () => view, generation: () => generation, blocked: () => blocked, cursorTime: () => clock, flush, setTimeframe: async () => {},
        autoStart: false, candleEvidence, proposeScenario, ...extra }); controllers.push(agent);
    const task = (operation: string, args: Record<string, unknown> = {}, deadline = Date.now() + 10_000): ChartAgentTask => ({
        operation: operation as ChartAgentTask['operation'], args, deadline, requestId: crypto.randomUUID(),
        target: { clientId: agent.clientId, sessionId: SESSION, generation: 1, cellId: 'cell' },
    });
    return { agent, task, view, chart: nativeChart, cells, get, post, flush, candleEvidence, proposeScenario, proposals,
        clock: (value: number | null) => { clock = value; }, style: (value: string) => { style = value; }, generation: () => { generation++; }, block: () => { blocked = true; } };
}

describe('research chart callbacks', () => {
    it('registers both bounded operations and retains the actual chart symbol in its pinned candle scope', async () => {
        const f = fixture(); expect(CHART_AGENT_OPERATIONS).toContain('read_candle_evidence'); expect(CHART_AGENT_OPERATIONS).toContain('propose_scenario');
        const result = await f.agent.execute(f.task('read_candle_evidence', { selectedTime: 0 })) as CandleEvidence;
        expect(f.candleEvidence).toHaveBeenCalledTimes(1);
        expect(f.candleEvidence.mock.calls[0]![0]).toMatchObject({ cellId: 'cell', selectedTime: 0, scope: {
            target: f.task('read_candle_evidence').target, cursorTime: 120_000, chart: { symbol: f.chart.market.symbol, timeframe: '1' },
            clock: { sourceCutoff: 120_000, availableUntil: 180_000 }, region: { from: 0, to: 120_000 }, dataset: { id: DATASET, checksum: 'c'.repeat(64) },
        } });
        const query = new URL(f.get.mock.calls[0]![0], 'http://local'); expect(query.searchParams.get('cutoff')).toBe('120000');
        expect(result).toMatchObject({ selectedTime: 0, transform: { kind: 'none' }, raw: { close: 101 }, displayed: { close: 101 } });
        expect(f.post).not.toHaveBeenCalled(); expect(f.flush).not.toHaveBeenCalled();
    });
    it('defaults to the latest revealed bucket, keeps historical selection exact, and rejects future/off-grid/unknown arguments before callback', async () => {
        const f = fixture(); const latest = await f.agent.execute(f.task('read_candle_evidence')) as CandleEvidence;
        expect(latest.selectedTime).toBe(120_000); expect(f.candleEvidence.mock.calls[0]![0].selectedTime).toBeUndefined();
        await expect(f.agent.execute(f.task('read_candle_evidence', { selectedTime: 180_000 }))).rejects.toThrow();
        await expect(f.agent.execute(f.task('read_candle_evidence', { selectedTime: 1 }))).rejects.toThrow();
        await expect(f.agent.execute(f.task('read_candle_evidence', { selectedTime: 0, arbitrary: true }))).rejects.toThrow();
        expect(f.candleEvidence).toHaveBeenCalledTimes(1);
    });
    it.each(['checksum', 'revision', 'cursor', 'loaded clock', 'timeframe', 'style', 'cell', 'generation', 'blocked'])('does not dispatch candle callback when %s changes during scope capture', async change => {
        const f = fixture(); const started = deferred<void>(), gate = deferred<unknown>();
        f.get.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
        const result = f.agent.execute(f.task('read_candle_evidence')); const rejected = expect(result).rejects.toThrow(); await started.promise;
        if (change === 'checksum') f.view.dataset.checksum = 'd'.repeat(64);
        if (change === 'revision') f.view.session.revision++;
        if (change === 'cursor') f.view.session.cursor++;
        if (change === 'loaded clock') f.clock(60_000);
        if (change === 'timeframe') f.chart.market.timeframe = '5';
        if (change === 'style') f.style('heikinashi');
        if (change === 'cell') f.cells.splice(0);
        if (change === 'generation') f.generation();
        if (change === 'blocked') f.block();
        gate.resolve({ cursorTime: 120_000, baseIntervalMs: 60_000, datasetId: DATASET, checksum: 'c'.repeat(64) }); await rejected;
        expect(f.candleEvidence).not.toHaveBeenCalled(); expect(f.proposeScenario).not.toHaveBeenCalled();
    });
    it('does not let a stale callback return evidence for a different scope', async () => {
        const f = fixture(); f.candleEvidence.mockImplementationOnce(async input => ({ scope: { ...input.scope, scopeId: 'different' } }) as CandleEvidence);
        await expect(f.agent.execute(f.task('read_candle_evidence'))).rejects.toThrow(/scope|evidence/i);
    });
    it('preserves a forming higher-timeframe scope and explicitly separates actual transformed display values', async () => {
        const f = fixture({ candleEvidence: async (input, owner) => {
            const envelope = { dataset: input.scope.dataset, cursorTime: input.scope.cursorTime, sourceCutoff: input.scope.clock.sourceCutoff, bars: source };
            return buildCandleEvidence({ scope: input.scope, selectedTime: input.selectedTime ?? 0,
                raw: { ...envelope, from: 0, to: 180_000 },
                displayed: { ...envelope, bars: [{ time: 0, open: 100.5, high: 102, low: 99, close: 100.5, volume: 30 }] },
                transform: { kind: 'heikinashi' }, assertCurrent: owner.assertCurrent });
        } });
        f.chart.market.timeframe = '5'; f.style('heikinashi');
        const result = await f.agent.execute(f.task('read_candle_evidence', { selectedTime: 0 })) as CandleEvidence;
        expect(result).toMatchObject({ forming: true, selectedTime: 0, transform: { kind: 'heikinashi' },
            scope: { clock: { sourceCutoff: 120_000, availableUntil: 180_000 }, chart: { timeframe: '5' } }, raw: { close: 101 }, displayed: { close: 100.5 } });
        expect(result.statements.map(item => item.text).join(' ')).toContain('not raw execution prices');
    });
    it('strictly parses a draft proposal and binds its context to the loaded replay without saving, previewing or placing orders', async () => {
        const f = fixture(); const content = emptyScenarioContent(); content.title = 'User hypothesis'; content.bull.triggerPrice = -10;
        const result = await f.agent.execute(f.task('propose_scenario', { content }));
        expect(result).toEqual({ draftOnly: true, context: { sessionId: SESSION, datasetId: DATASET, datasetChecksum: 'c'.repeat(64), cursor: 2, cutoff: 120_000 } });
        expect(f.proposeScenario.mock.calls[0]![0]).toEqual({ cellId: 'cell', content, context: (result as { context: unknown }).context });
        expect(f.proposals).toHaveLength(1);
        expect(f.post.mock.calls.map(([path, body]) => [path, (body as { action: string }).action])).toEqual([
            ['/api/assistant/exchange', 'validate_proposal'], ['/api/assistant/exchange', 'commit_proposal'],
        ]);
        expect(f.get).not.toHaveBeenCalled(); expect(f.flush).not.toHaveBeenCalled();
        await expect(f.agent.execute(f.task('propose_scenario', { content: { ...content, arbitrary: true } }))).rejects.toThrow();
        await expect(f.agent.execute(f.task('propose_scenario', { content, context: { cursor: 999 } }))).rejects.toThrow();
        expect(f.proposals).toHaveLength(1);
    });
    it('rejects unavailable clocks, future evidence and unsupported callback results', async () => {
        const f = fixture(); f.clock(null);
        await expect(f.agent.execute(f.task('propose_scenario', { content: emptyScenarioContent() }))).rejects.toThrow();
        await expect(f.agent.execute(f.task('read_candle_evidence'))).rejects.toThrow(); f.clock(120_000);
        const content = emptyScenarioContent(); content.evidence = [{ kind: 'candle', sourceIndex: 3, time: 180_000, note: 'Future' }];
        await expect(f.agent.execute(f.task('propose_scenario', { content }))).rejects.toThrow();
        f.proposeScenario.mockImplementationOnce(async input => ({ draftOnly: true, context: { ...input.context, cursor: 999 } }));
        await expect(f.agent.execute(f.task('propose_scenario', { content: emptyScenarioContent() }))).rejects.toThrow(/context/i);
    });
    it.each(['deadline', 'dispose', 'revision', 'style'])('prevents a pending proposal commit after %s and invalidates its owner', async change => {
        vi.useFakeTimers(); const gate = deferred<void>(), started = deferred<void>(); let owner!: ResearchOwner; const committed: ScenarioContent[] = [];
        const f = fixture({ proposeScenario: async (input, context) => { owner = context; started.resolve(); await gate.promise; context.assertCurrent(); committed.push(input.content); return { draftOnly: true, context: input.context }; } });
        const task = f.task('propose_scenario', { content: emptyScenarioContent() }, Date.now() + 20);
        const request = f.agent.execute(task); const rejected = expect(request).rejects.toThrow(); await started.promise;
        if (change === 'deadline') await vi.advanceTimersByTimeAsync(21);
        if (change === 'dispose') f.agent.dispose();
        if (change === 'revision') f.view.session.revision++;
        if (change === 'style') f.style('heikinashi');
        gate.resolve(); await rejected; await settle(); expect(committed).toEqual([]); expect(() => owner.assertCurrent()).toThrow();
        if (change === 'deadline' || change === 'dispose') expect(owner.signal.aborted).toBe(true);
    });
    it('propagates question cancellation to the pending capture and never replaces the queued question', async () => {
        const f = fixture(); await f.agent.requestAnalysis('Keep this question');
        const started = deferred<void>(), gate = deferred<unknown>(); let signal: AbortSignal | undefined;
        f.get.mockImplementationOnce(async (_path, current) => { signal = current; started.resolve(); return gate.promise; });
        const owner = new AbortController(); let current = true;
        const pending = f.agent.requestAnalysis('Cancelled question', {}, { signal: owner.signal, assertCurrent: () => { if (!current) throw new Error('Question changed'); } });
        const rejected = expect(pending).rejects.toThrow(); await started.promise; current = false; owner.abort();
        expect(signal!.aborted).toBe(true); gate.resolve({ cursorTime: 120_000, baseIntervalMs: 60_000 }); await rejected;
        const result = await f.agent.execute(f.task('read_analysis_request')) as { request: { question: string } }; expect(result.request.question).toBe('Keep this question');
    });
});

async function rpc(agent: ReturnType<typeof fixture>) {
    const call = vi.fn(async (operation: ChartAgentTask['operation'], _target: unknown, args: unknown, signal?: AbortSignal) => agent.agent.execute(agent.task(operation, args as Record<string, unknown>), signal));
    const server = createChartMcp({ clients: async () => [], call }); const [client, transport] = InMemoryTransport.createLinkedPair();
    let id = 0; const waiting = new Map<number, (value: Record<string, unknown>) => void>();
    client.onmessage = (message: JSONRPCMessage) => { if ('id' in message && typeof message.id === 'number') { waiting.get(message.id)?.(message as unknown as Record<string, unknown>); waiting.delete(message.id); } };
    await server.connect(transport); await client.start();
    const send = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>(resolve => { waiting.set(++id, resolve); void client.send({ jsonrpc: '2.0', id, method, params }); });
    await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'bounded-research-test', version: '1' } });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return { send, call, close: async () => { await client.close(); await server.close(); } };
}
describe('research tools over actual MCP registration and dispatch', () => {
    it('advertises the two distinct annotations and dispatches pinned candle reads and draft-only proposals', async () => {
        const f = fixture(), ctx = await rpc(f);
        try {
            const list = await ctx.send('tools/list', {}); const tools = (list.result as { tools: { name: string; annotations: Record<string, boolean> }[] }).tools;
            expect(tools.find(tool => tool.name === 'vela_read_candle_evidence')?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
            expect(tools.find(tool => tool.name === 'vela_propose_scenario')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
            const target = f.task('read_candle_evidence').target;
            const read = await ctx.send('tools/call', { name: 'vela_read_candle_evidence', arguments: { target, args: { selectedTime: 0 } } });
            expect(read).not.toHaveProperty('result.isError', true);
            const payload = JSON.parse((read.result as { content: { text: string }[] }).content[0]!.text);
            expect(payload).toMatchObject({ selectedTime: 0, transform: { kind: 'none' }, raw: { close: 101 }, displayed: { close: 101 } });
            const proposal = await ctx.send('tools/call', { name: 'vela_propose_scenario', arguments: { target, args: { content: emptyScenarioContent() } } });
            expect(proposal).not.toHaveProperty('result.isError', true); expect(JSON.stringify(proposal)).toContain('draftOnly');
            expect(ctx.call.mock.calls.map(call => call[0])).toEqual(['read_candle_evidence', 'propose_scenario']);
            expect(f.post.mock.calls.map(([path]) => path)).toEqual(['/api/assistant/exchange', '/api/assistant/exchange']);
        } finally { await ctx.close(); }
    });
    it('rejects invalid selected times and malformed proposal content before the app callback is dispatched', async () => {
        const f = fixture(), ctx = await rpc(f); const target = f.task('read_candle_evidence').target;
        try {
            for (const args of [{ selectedTime: -1 }, { selectedTime: 1.5 }, { selectedTime: 0, raw: true }]) {
                expect(await ctx.send('tools/call', { name: 'vela_read_candle_evidence', arguments: { target, args } })).toHaveProperty('result.isError', true);
            }
            const content = { ...emptyScenarioContent(), title: 'x'.repeat(121) };
            expect(await ctx.send('tools/call', { name: 'vela_propose_scenario', arguments: { target, args: { content } } })).toHaveProperty('result.isError', true);
            expect(ctx.call).not.toHaveBeenCalled(); expect(f.proposals).toHaveLength(0);
        } finally { await ctx.close(); }
    });
});
