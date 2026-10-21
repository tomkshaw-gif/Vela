import { describe, expect, it, vi } from 'vitest';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { createChartMcp, LocalChartConnection, LocalChartConnections } from '../mcp';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

async function rpc(connection: LocalChartConnection) {
    const server = createChartMcp(connection);
    const [client, transport] = InMemoryTransport.createLinkedPair();
    const waiting = new Map<number, (message: Record<string, unknown>) => void>();
    client.onmessage = (message: JSONRPCMessage) => {
        if ('id' in message && typeof message.id === 'number') waiting.get(message.id)?.(message as unknown as Record<string, unknown>);
    };
    await server.connect(transport); await client.start();
    let id = 0;
    const request = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
        waiting.set(++id, resolve); void client.send({ jsonrpc: '2.0', id, method, params });
    });
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'local-proof', version: '1' } });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return { request, close: async () => { await client.close(); await server.close(); } };
}

describe('local chart MCP', () => {
    it('discovers the installed desktop through its fixed loopback port', async () => {
        const calls: string[] = [];
        const fetcher = vi.fn<typeof fetch>(async url => { calls.push(String(url)); return String(url).endsWith('/api/bootstrap')
            ? Response.json({ token: 'a'.repeat(64) }) : Response.json([]); });
        await expect(new LocalChartConnection('5196', fetcher).clients()).resolves.toEqual([]);
        expect(calls).toEqual(['http://127.0.0.1:5196/api/assistant/clients']);
    });
    it('starts the real stdio entry from an unrelated working directory with a portable loader URL', async () => {
        const root = new URL('../../', import.meta.url);
        const child = spawn(process.execPath, ['--import', new URL('node_modules/tsx/dist/loader.mjs', root).href,
            fileURLToPath(new URL('local-app/mcp.ts', root))], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const lines = createInterface({ input: child.stdout });
        try {
            const initialized = new Promise<Record<string, unknown>>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Local MCP initialization timed out')), 10_000);
                child.once('error', error => { clearTimeout(timer); reject(error); });
                child.once('exit', code => { clearTimeout(timer); reject(new Error(`Local MCP exited before initialization (${code})`)); });
                lines.once('line', line => { clearTimeout(timer); resolve(JSON.parse(line) as Record<string, unknown>); });
            });
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
                protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'local-entry-proof', version: '1' } } }) + '\n');
            expect(await initialized).toMatchObject({ id: 1, result: { serverInfo: { name: 'vela-local-chart' } } });
        } finally { lines.close(); child.stdin.end(); child.kill(); }
    }, 15_000);
    it('advertises chart and read-only research tools over a real MCP transport', async () => {
        const fetcher = vi.fn<typeof fetch>(); const ctx = await rpc(new LocalChartConnection('5199', fetcher));
        try {
            const result = await ctx.request('tools/list', {});
            const tools = (result.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
            expect(tools).toHaveLength(47);
            expect(tools.map(tool => tool.name)).toContain('vela_screenshot');
            expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['vela_run_script', 'vela_update_script', 'vela_read_script_context', 'vela_read_script_job', 'vela_cancel_script_job']));
            expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['vela_research_apps', 'vela_edge_sources', 'vela_edge_fields', 'vela_edge_presets', 'vela_edge_query', 'vela_edge_report', 'vela_edge_session_bars', 'vela_backtest_sessions', 'vela_backtest_statistics']));
            expect(tools.every(tool => !/order|provider|export|shell|credential/.test(tool.name))).toBe(true);
            expect(tools.find(tool => tool.name === 'vela_add_drawing')?.inputSchema).toMatchObject({ type: 'object', required: ['target', 'args'] });
            expect(fetcher).not.toHaveBeenCalled();
        } finally { await ctx.close(); }
    });
    it('rejects unsafe targets and oversized candle limits before calling the local app', async () => {
        const fetcher = vi.fn<typeof fetch>(); const ctx = await rpc(new LocalChartConnection('5199', fetcher));
        try {
            const result = await ctx.request('tools/call', { name: 'vela_read_candles', arguments: { target: { clientId: 'bad' }, args: { limit: 1001 } } });
            expect(result).toHaveProperty('result.isError', true); expect(fetcher).not.toHaveBeenCalled();
        } finally { await ctx.close(); }
    });
    it('keeps bootstrap credentials out of tool output and only addresses the fixed loopback API', async () => {
        const token = 'a'.repeat(64); const requests: { url: string; init?: RequestInit }[] = [];
        const fetcher = vi.fn<typeof fetch>(async (url, init) => {
            requests.push({ url: String(url), init });
            return new Response(JSON.stringify(String(url).endsWith('/api/bootstrap') ? { token, dataDirectory: 'private-path', sessions: [] } : { timeframe: '5', bars: [] }));
        });
        const ctx = await rpc(new LocalChartConnection('5199', fetcher));
        try {
            const target = { clientId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222', generation: 1, cellId: 'cell-1' };
            const result = await ctx.request('tools/call', { name: 'vela_read_candles', arguments: { target, args: { timeframe: '5', limit: 10 } } });
            expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain('private-path');
            expect(requests.map(request => request.url)).toEqual(['http://127.0.0.1:5199/api/bootstrap', 'http://127.0.0.1:5199/api/assistant/call']);
            expect(requests[1]!.init?.headers).toHaveProperty('X-Local-Token', token);
            expect(JSON.parse(requests[1]!.init?.body as string)).toEqual({ operation: 'read_candles', target, args: { timeframe: '5', limit: 10 }, requestId: expect.stringMatching(/^[a-f0-9-]{36}$/i) });
        } finally { await ctx.close(); }
    });
    it('does not follow redirects or retry a chart mutation', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => new Response('do not reveal server payload', { status: 503 }));
        await expect(new LocalChartConnection('5197', fetcher).call('add_drawing', {}, {})).rejects.toThrow('updating');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0]![1]?.redirect).toBe('error');
        expect(() => new LocalChartConnection('443')).toThrow('5197 or 5199');
    });
    it('refreshes authentication after rediscovery or rejection without replaying a failed mutation', async () => {
        let current = 'a'.repeat(64), bootstraps = 0, attempts = 0, applied = 0;
        const fetcher = vi.fn<typeof fetch>(async (url, init) => {
            if (String(url).endsWith('/api/bootstrap')) { bootstraps++; return Response.json({ token: current }); }
            if (String(url).endsWith('/api/assistant/clients')) return Response.json([]);
            attempts++;
            if ((init?.headers as Record<string, string>)['X-Local-Token'] !== current) return new Response('{}', { status: 403 });
            applied++; return Response.json({ saved: true });
        });
        const connection = new LocalChartConnection('5199', fetcher);
        await connection.call('set_viewport', {}, { fit: true });
        current = 'b'.repeat(64);
        await expect(connection.call('set_viewport', {}, { fit: true })).rejects.toThrow('Reconnect');
        expect({ bootstraps, attempts, applied }).toEqual({ bootstraps: 1, attempts: 2, applied: 1 });
        await connection.call('set_viewport', {}, { fit: true });
        current = 'c'.repeat(64); await connection.clients();
        await connection.call('set_viewport', {}, { fit: true });
        expect({ bootstraps, attempts, applied }).toEqual({ bootstraps: 3, attempts: 4, applied: 3 });
    });
    it('exposes an operation receipt ID after timeout and never resends the original edit', async () => {
        const calls: Record<string, unknown>[] = [];
        const fetcher = vi.fn<typeof fetch>(async (url, init) => {
            if (String(url).endsWith('/api/bootstrap')) return Response.json({ token: 'a'.repeat(64) });
            const call = JSON.parse(String(init?.body)) as Record<string, unknown>; calls.push(call);
            if (call.operation === 'read_operation') return Response.json({ state: 'completed', requestId: (call.args as { requestId: string }).requestId, value: { saved: true } });
            throw new DOMException('Timed out', 'TimeoutError');
        });
        const connection = new LocalChartConnection('5199', fetcher); const target = { clientId: 'window' };
        let failure: Error | undefined;
        try { await connection.call('remove_indicator', target, { id: 'owned' }); } catch (error) { failure = error as Error; }
        const id = /Operation ID: ([a-f0-9-]{36})/.exec(failure!.message)![1]!;
        expect(failure!.message).toContain('vela_read_operation');
        expect(await connection.call('read_operation', target, { requestId: id })).toMatchObject({ state: 'completed', requestId: id });
        expect(calls.map(call => call.operation)).toEqual(['remove_indicator', 'read_operation']);
        expect(calls[1]!.target).toEqual(target);
    });
    it('discovers both desktop modes and pins each call to its original backend', async () => {
        const runFetch = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/api/assistant/clients')
            ? [{ clientId: 'run-window' }] : String(url).endsWith('/api/bootstrap') ? { token: 'a'.repeat(64) } : { mode: 'run' })));
        const devFetch = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/api/assistant/clients')
            ? [{ clientId: 'dev-window' }] : String(url).endsWith('/api/bootstrap') ? { token: 'b'.repeat(64) } : { mode: 'develop' })));
        const pool = new LocalChartConnections([{ mode: 'run', connection: new LocalChartConnection('5197', runFetch) },
            { mode: 'develop', connection: new LocalChartConnection('5199', devFetch) }]);
        expect(await pool.clients()).toEqual([{ clientId: 'run-window', mode: 'run' }, { clientId: 'dev-window', mode: 'develop' }]);
        await expect(pool.call('read_chart', { clientId: 'dev-window' }, {})).resolves.toEqual({ mode: 'develop' });
        expect(runFetch).toHaveBeenCalledTimes(1); expect(devFetch).toHaveBeenCalledTimes(3);
        await expect(pool.call('read_chart', { clientId: 'unknown' }, {})).rejects.toThrow('List workspaces');
    });
    it('reports a post-mutation save failure explicitly to the model', async () => {
        const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/api/bootstrap')
            ? new Response(JSON.stringify({ token: 'a'.repeat(64) }))
            : new Response(JSON.stringify({ error: 'The chart changed, but saving failed: Session changed.' }), { status: 422 }));
        const ctx = await rpc(new LocalChartConnection('5199', fetcher));
        try {
            const target = { clientId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222', generation: 1, cellId: 'cell-1' };
            const result = await ctx.request('tools/call', { name: 'vela_remove_drawing', arguments: { target, args: { id: 'drawing-1' } } });
            expect(result).toHaveProperty('result.isError', true);
            expect(JSON.stringify(result)).toContain('chart changed, but saving failed');
        } finally { await ctx.close(); }
    });
});
