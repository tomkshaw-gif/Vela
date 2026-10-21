import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { Vela } from '../../src/index';
import type { VelaWorkspace } from '../../src/workspace';
import { createChartAgentController, type ChartAgentController, type ResearchOwner } from '../client/chart-agent';
import { ApiError } from '../client/api';
import { createChartMcp, LocalChartConnection } from '../mcp';
import { createReplayServer } from '../server/index';
import { ChartAgentBroker } from '../server/chart-agent';
import { createSession } from '../engine';
import { buildCandleEvidence } from '../shared/candle-evidence';
import { emptyScenarioContent } from '../shared/scenarios';
import { DEFAULT_RULES, type Bar, type SessionView } from '../shared/types';
import type { ChartAgentTask } from '../shared/chart-agent';

const BASE = Date.UTC(2024, 3, 8);
const bars: Bar[] = [0, 60_000, 120_000].map((offset, index) => ({ time: BASE + offset, open: 100, high: 104, low: 98, close: 100 + index, volume: 10 }));
const resources: { agent: ChartAgentController; app: Awaited<ReturnType<typeof createReplayServer>>; directory: string; pump: ReturnType<typeof setInterval> }[] = [];
afterEach(async () => {
    for (const item of resources.splice(0)) {
        clearInterval(item.pump); item.agent.dispose(); await item.app.close();
        const actual = realpathSync(item.directory), child = relative(realpathSync(tmpdir()), actual);
        if (!child || isAbsolute(child) || child.startsWith('..') || !child.startsWith('vela-research-authority-')) throw new Error('Unexpected fixture cleanup path.');
        rmSync(actual, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function rpc(connection: Pick<LocalChartConnection, 'clients' | 'call'>) {
    const server = createChartMcp(connection); const [client, transport] = InMemoryTransport.createLinkedPair();
    const waiting = new Map<number, (value: Record<string, unknown>) => void>(); let id = 0;
    client.onmessage = (value: JSONRPCMessage) => { if ('id' in value && typeof value.id === 'number') { waiting.get(value.id)?.(value as unknown as Record<string, unknown>); waiting.delete(value.id); } };
    await server.connect(transport); await client.start();
    const send = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>(resolve => { waiting.set(++id, resolve); void client.send({ jsonrpc: '2.0', id, method, params }); });
    await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'authority-proof', version: '1' } });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return { send, cancel: () => client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Synthetic cancellation' } }), close: async () => { await client.close(); await server.close(); } };
}
function output(value: Record<string, unknown>) {
    expect(value).not.toHaveProperty('result.isError', true);
    return JSON.parse((value.result as { content: { text: string }[] }).content[0]!.text);
}
async function setup(options: { style?: string; transformed?: boolean; hold?: boolean } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'vela-research-authority-'));
    const provider = vi.fn(async () => { throw new Error('No provider calls in this synthetic fixture.'); });
    const app = await createReplayServer({ dataDirectory: directory, port: 0, fetch: provider });
    const url = await app.listen(); const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json() as { token: string };
    const dataset = app.store.addDataset({ name: 'Synthetic only', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars });
    const session = createSession({ name: 'Synthetic only', datasetId: dataset.id, mode: 'practice', initialBalance: 50_000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: DEFAULT_RULES }, dataset.instrument);
    session.cursor = 2; app.store.createSession(session); const view: SessionView = { dataset, session };
    const before = app.store.session(session.id); const calls: { path: string; body?: Record<string, unknown> }[] = [];
    const get = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
        calls.push({ path }); const response = await fetch(url + path, { signal }); const value = await response.json() as T & { error?: string };
        if (!response.ok) throw new ApiError(value.error ?? 'Read failed', response.status); return value;
    };
    const post = async <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> => {
        calls.push({ path, body: body as Record<string, unknown> });
        const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': bootstrap.token }, body: JSON.stringify(body), signal });
        const value = await response.json() as T & { error?: string }; if (!response.ok) throw new ApiError(value.error ?? 'Write failed', response.status); return value;
    };
    const chart = { market: { symbol: 'replay:NQM4', timeframe: '1' }, renderer: { get: () => options.style ?? 'candles' }, drawings: { all: () => [] }, getVisibleRange: () => ({ from: BASE, to: BASE + 120_000 }) } as unknown as Vela;
    const cells = [{ id: 'cell', chart }]; const started = deferred<void>(), gate = deferred<void>(); let owner!: ResearchOwner; let commits = 0, proposalCalls = 0;
    const agent = createChartAgentController({ api: { get, post, postKeepalive: () => {} },
        workspace: { cells: () => cells, cell: () => cells[0], context: () => ({ activeCellId: 'cell' }) } as unknown as Pick<VelaWorkspace, 'cells' | 'cell' | 'context'>,
        session: () => view, generation: () => 1, cursorTime: () => BASE + 120_000, blocked: () => false, flush: async () => {}, setTimeframe: async () => {}, autoStart: false,
        candleEvidence: async (input, ownership) => {
            const envelope = { dataset: input.scope.dataset, cursorTime: input.scope.cursorTime, sourceCutoff: input.scope.clock.sourceCutoff, bars };
            return buildCandleEvidence({ scope: input.scope, selectedTime: input.selectedTime ?? BASE + 120_000,
                raw: { ...envelope, from: BASE, to: BASE + 180_000 }, displayed: { ...envelope, bars: options.transformed ? bars.map(bar => ({ ...bar, open: 100.5, close: 100.5 })) : bars },
                transform: { kind: options.transformed ? 'heikinashi' : 'none' }, assertCurrent: ownership.assertCurrent });
        },
        proposeScenario: async (input, ownership) => {
            proposalCalls++;
            owner = ownership; started.resolve(); if (options.hold) await gate.promise;
            ownership.assertCurrent();
            const apply = () => { commits++; return true; };
            const commit = (ownership as ResearchOwner & { commitDraft?: (apply: () => boolean) => Promise<boolean> }).commitDraft;
            if (commit) await commit(apply); else apply();
            return { draftOnly: true, context: input.context };
        },
    });
    await agent.poll(); const pump = setInterval(() => { void agent.poll().catch(() => {}); }, 10);
    resources.push({ agent, app, directory, pump });
    const connection = new LocalChartConnection('5199', (async (input, init) => fetch(url + new URL(String(input)).pathname, init)) as typeof fetch);
    const target = { clientId: agent.clientId, sessionId: session.id, generation: 1, cellId: 'cell' };
    return { agent, app, view, provider, calls, connection, target, started, gate, owner: () => owner, commits: () => commits, proposalCalls: () => proposalCalls, before };
}

describe('research authority end to end', { timeout: 15_000 }, () => {
    it.each([[false, 'candles', true], [true, 'heikinashi', true], [true, 'candles', false], [false, 'heikinashi', false], [false, 'renko', false]] as const)
    ('requires symmetric displayed basis: transformed=%s style=%s accepted=%s', async (transformed, style, accepted) => {
        const ctx = await setup({ transformed, style }), client = await rpc(ctx.connection);
        try {
            const result = await client.send('tools/call', { name: 'vela_read_candle_evidence', arguments: { target: ctx.target, args: {} } });
            if (accepted) expect(output(result).transform.kind).toBe(transformed ? 'heikinashi' : 'none');
            else expect(result).toHaveProperty('result.isError', true);
            expect(ctx.app.store.session(ctx.view.session.id)).toEqual(ctx.before); expect(ctx.provider).not.toHaveBeenCalled();
        } finally { await client.close(); }
    });
    it('validates actual SQL source index/time pairs before the proposal callback, including timestamp and index negative controls', async () => {
        const ctx = await setup(), client = await rpc(ctx.connection);
        try {
            for (const [sourceIndex, time, valid] of [[0, BASE, true], [0, BASE + 1, false], [0, BASE + 120_000, false], [2, BASE + 120_000, true]] as const) {
                const count = ctx.commits(), called = ctx.proposalCalls(); const content = emptyScenarioContent(); content.evidence = [{ kind: 'candle', sourceIndex, time, note: 'Synthetic reference' }];
                const result = await client.send('tools/call', { name: 'vela_propose_scenario', arguments: { target: ctx.target, args: { content } } });
                if (valid) { expect(output(result).draftOnly).toBe(true); expect(ctx.commits()).toBe(count + 1); expect(ctx.proposalCalls()).toBe(called + 1); }
                else { expect(result).toHaveProperty('result.isError', true); expect(ctx.commits()).toBe(count); expect(ctx.proposalCalls()).toBe(called); }
            }
            expect(ctx.app.store.session(ctx.view.session.id)).toEqual(ctx.before);
            expect(ctx.app.store.db.prepare('SELECT COUNT(*) AS n FROM local_scenarios').get()).toMatchObject({ n: 0 }); expect(ctx.provider).not.toHaveBeenCalled();
        } finally { await client.close(); }
    });
    it('cancels an awaited proposal through actual MCP, HTTP, broker and browser authority before the draft commit', async () => {
        const ctx = await setup({ hold: true }), client = await rpc(ctx.connection);
        try {
            void client.send('tools/call', { name: 'vela_propose_scenario', arguments: { target: ctx.target, args: { content: emptyScenarioContent() } } });
            await ctx.started.promise; await client.cancel();
            // The commit handshake must reject even before the two-second heartbeat observes cancellation.
            await new Promise(resolve => setTimeout(resolve, 40)); ctx.gate.resolve();
            await vi.waitFor(() => expect(ctx.owner().signal.aborted).toBe(true), { timeout: 3500, interval: 10 });
            expect(ctx.commits()).toBe(0); expect(() => ctx.owner().assertCurrent()).toThrow();
            expect(ctx.app.store.session(ctx.view.session.id)).toEqual(ctx.before);
            expect(ctx.app.store.db.prepare('SELECT COUNT(*) AS n FROM local_scenarios').get()).toMatchObject({ n: 0 });
            expect(ctx.calls.filter(call => call.body && call.path !== '/api/assistant/exchange')).toEqual([]); expect(ctx.provider).not.toHaveBeenCalled();
        } finally { ctx.gate.resolve(); await client.close(); }
    });
    it('allows an uncancelled awaited draft without mutating the saved library or replay ledger', async () => {
        const ctx = await setup({ hold: true }), client = await rpc(ctx.connection);
        try {
            const pending = client.send('tools/call', { name: 'vela_propose_scenario', arguments: { target: ctx.target, args: { content: emptyScenarioContent() } } });
            await ctx.started.promise; ctx.gate.resolve(); expect(output(await pending)).toMatchObject({ draftOnly: true }); expect(ctx.commits()).toBe(1);
            expect(ctx.app.store.session(ctx.view.session.id)).toEqual(ctx.before); expect(ctx.provider).not.toHaveBeenCalled();
        } finally { ctx.gate.resolve(); await client.close(); }
    });
    it('aborts the browser owner through active-request heartbeat while its proposal callback remains awaited', async () => {
        const ctx = await setup({ hold: true }), client = await rpc(ctx.connection);
        try {
            void client.send('tools/call', { name: 'vela_propose_scenario', arguments: { target: ctx.target, args: { content: emptyScenarioContent() } } });
            await ctx.started.promise; await client.cancel();
            await vi.waitFor(() => expect(ctx.owner().signal.aborted).toBe(true), { timeout: 3500, interval: 10 });
            expect(ctx.calls.some(call => call.body?.action === 'heartbeat' && typeof call.body.requestId === 'string')).toBe(true);
            expect(ctx.commits()).toBe(0); ctx.gate.resolve();
            expect(ctx.app.store.session(ctx.view.session.id)).toEqual(ctx.before); expect(ctx.provider).not.toHaveBeenCalled();
        } finally { ctx.gate.resolve(); await client.close(); }
    });
});

describe('proposal cancellation authority and receipt boundaries', () => {
    it('refuses a successful proposal completion without a server commit grant', async () => {
        const broker = new ChartAgentBroker(); const clientId = crypto.randomUUID(), clientToken = crypto.randomUUID(), sessionId = crypto.randomUUID();
        const chart = { sessionId, generation: 1, symbol: 'NQM4', timeframe: '1', cells: [{ id: 'cell', timeframe: '1' }], cursorTime: BASE };
        const target = { clientId, sessionId, generation: 1, cellId: 'cell' };
        broker.exchange({ action: 'poll', clientId, clientToken, chart });
        const request = broker.call({ operation: 'propose_scenario', target, args: { content: emptyScenarioContent() } });
        const ended = request.catch(() => undefined);
        try {
            const task = broker.exchange({ action: 'poll', clientId, clientToken, chart }).request!;
            expect(() => broker.exchange({ action: 'poll', clientId, clientToken, chart, completion: { requestId: task.requestId, success: true, value: { draftOnly: true } } })).toThrow(/commit authority/i);
        } finally { broker.close(); await ended; }
    });
    it.each([false, true])('reconciles a cancelled proposal only when commit authority was already granted: %s', async grant => {
        const broker = new ChartAgentBroker(); const clientId = crypto.randomUUID(), clientToken = crypto.randomUUID(), sessionId = crypto.randomUUID();
        const chart = { sessionId, generation: 1, symbol: 'NQM4', timeframe: '1', cells: [{ id: 'cell', timeframe: '1' }], cursorTime: BASE + 120_000 };
        const target = { clientId, sessionId, generation: 1, cellId: 'cell' }; const cancellation = new AbortController();
        const context = { sessionId, datasetId: crypto.randomUUID(), datasetChecksum: 'c'.repeat(64), cursor: 2, cutoff: BASE + 120_000 };
        try {
            broker.exchange({ action: 'poll', clientId, clientToken, chart });
            const pending = broker.call({ operation: 'propose_scenario', target, args: { content: emptyScenarioContent() } }, cancellation.signal);
            const rejected = expect(pending).rejects.toThrow(/cancelled/i);
            const task = broker.exchange({ action: 'poll', clientId, clientToken, chart }).request!;
            const authority = { clientId, clientToken, chart, requestId: task.requestId, context, revision: 0 };
            const validate = vi.fn(() => {});
            expect(() => broker.exchange({ action: 'commit_proposal', ...authority }, validate)).toThrow(/Validate/);
            broker.exchange({ action: 'validate_proposal', ...authority }, validate);
            expect(() => broker.exchange({ action: 'commit_proposal', ...authority, clientToken: crypto.randomUUID() }, validate)).toThrow(/token/);
            if (grant) broker.exchange({ action: 'commit_proposal', ...authority }, validate);
            cancellation.abort(); await rejected;
            expect(broker.exchange({ action: 'heartbeat', clientId, clientToken, chart, requestId: task.requestId })).toMatchObject({ operation: { requestId: task.requestId, active: false } });
            expect(() => broker.exchange({ action: 'commit_proposal', ...authority }, validate)).toThrow(/authority/);
            const finish = () => broker.exchange({ action: 'poll', clientId, clientToken, chart, completion: { requestId: task.requestId, success: true, value: { draftOnly: true, context } } });
            if (grant) finish(); else expect(finish).toThrow(/no longer pending/);
            expect(await broker.call({ operation: 'read_operation', target, args: { requestId: task.requestId } })).toMatchObject({ state: grant ? 'completed' : 'unknown' });
            expect(validate).toHaveBeenCalledTimes(grant ? 2 : 1);
        } finally { broker.close(); }
    });
});
