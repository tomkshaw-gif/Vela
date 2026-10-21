import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createReplayServer } from '../server/index';
import { ChartAgentBroker } from '../server/chart-agent';
import type { ChartAgentCall, ChartAgentClient, ChartAgentCompletion, ChartAgentExchangeResult, ChartAgentTask } from '../shared/chart-agent';

const CREDENTIAL = 'chart-agent-http-synthetic-private-key';
const apps: Awaited<ReturnType<typeof createReplayServer>>[] = [];
const directories: { path: string; parent: string }[] = [];
const providers: ReturnType<typeof vi.fn>[] = [];

function browser() {
    const chart: Omit<ChartAgentClient, 'clientId'> = {
        sessionId: randomUUID(), generation: 1, symbol: 'NQM4', timeframe: '1',
        cells: [{ id: 'cell-1', timeframe: '1' }], cursorTime: Date.UTC(2024, 3, 8),
    };
    return { clientId: randomUUID(), clientToken: randomUUID(), chart };
}
function call(window: ReturnType<typeof browser>, overrides: Partial<ChartAgentCall> = {}): ChartAgentCall {
    return {
        operation: 'read_chart', target: { clientId: window.clientId, sessionId: window.chart.sessionId, generation: window.chart.generation, cellId: 'cell-1' },
        args: {}, ...overrides,
    };
}
async function setup(managed = false) {
    const parent = realpathSync(tmpdir()); const path = realpathSync(mkdtempSync(join(parent, 'vela-chart-agent-http-'))); directories.push({ path, parent });
    const provider = vi.fn(async () => { throw new Error('Chart assistant tests must not contact a provider.'); }); providers.push(provider);
    const app = await createReplayServer({ dataDirectory: path, port: 0, apiKey: CREDENTIAL, fetch: provider, ...(managed ? { runtime: { mode: 'run' as const, version: 'chart-agent-http.1' } } : {}) }); apps.push(app);
    const url = await app.listen(); const bootstrapResponse = await fetch(`${url}/api/bootstrap`);
    expect(bootstrapResponse.status).toBe(200); const bootstrap = await bootstrapResponse.json() as { token: string; provider: { configured: boolean } };
    expect(bootstrap.provider.configured).toBe(true); expect(JSON.stringify(bootstrap)).not.toContain(CREDENTIAL);
    const headers = { 'Content-Type': 'application/json', 'X-Local-Token': bootstrap.token, Connection: 'close' };
    const post = (path: string, value: unknown, extraHeaders: Record<string, string> = {}) => {
        const result = fetch(`${url}${path}`, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(value) });
        void result.catch(() => {}); return result;
    };
    const poll = (window: ReturnType<typeof browser>, completion?: ChartAgentCompletion) => post('/api/assistant/exchange', { action: 'poll', ...window, ...(completion ? { completion } : {}) });
    return { app, url, headers, post, poll, provider };
}
async function receive(ctx: Awaited<ReturnType<typeof setup>>, window: ReturnType<typeof browser>): Promise<ChartAgentTask> {
    return vi.waitFor(async () => {
        const response = await ctx.poll(window); expect(response.status).toBe(200);
        const result = await response.json() as ChartAgentExchangeResult; expect(result.request).not.toBeNull(); return result.request!;
    }, { timeout: 2000, interval: 10 });
}
async function raw(url: string, method: string, headers: Record<string, string>, data = ''): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
        const request = httpRequest(url, { method, headers }, response => {
            const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode!, text: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', reject); request.end(data);
    });
}

afterEach(async () => {
    vi.restoreAllMocks();
    for (const app of apps.splice(0)) await app.close();
    for (const provider of providers.splice(0)) expect(provider).not.toHaveBeenCalled();
    for (const directory of directories.splice(0)) {
        const actual = realpathSync(directory.path);
        if (actual !== directory.path || dirname(actual) !== directory.parent || !basename(actual).startsWith('vela-chart-agent-http-')) throw new Error('The temporary chart test directory changed.');
        rmSync(actual, { recursive: true });
    }
});

describe('chart assistant local HTTP boundary', () => {
    it('requires the same Host, Origin and local write token for chart calls and exchanges', async () => {
        const ctx = await setup(); const window = browser(); const pollBody = { action: 'poll', ...window };
        for (const [path, value] of [['/api/assistant/exchange', pollBody], ['/api/assistant/call', call(window)]] as const) {
            for (const token of ['', '0'.repeat(64), 'not-a-token']) {
                const response = await ctx.post(path, value, { 'X-Local-Token': token }); expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: 'CSRF' });
            }
            const untrustedHeaders: Record<string, string>[] = [{ Origin: 'https://outside.example' }, { 'Sec-Fetch-Site': 'cross-site' }];
            for (const headers of untrustedHeaders) {
                const response = await ctx.post(path, value, headers); expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: 'LOCAL_ONLY' });
            }
            const wrongHost = await raw(`${ctx.url}${path}`, 'POST', { ...ctx.headers, Host: 'outside.example' }, JSON.stringify(value));
            expect(wrongHost.status).toBe(403); expect(JSON.parse(wrongHost.text)).toMatchObject({ code: 'LOCAL_ONLY' });
        }
        expect((await ctx.post('/api/assistant/exchange', pollBody, { Origin: ctx.url, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
        expect((await fetch(`${ctx.url}/api/assistant/clients`, { headers: { Origin: 'https://outside.example' } })).status).toBe(403);
        expect((await raw(`${ctx.url}/api/assistant/clients`, 'GET', { Host: 'outside.example', Connection: 'close' })).status).toBe(403);
    });
    it('hands a real HTTP call to its browser once and returns the browser chart result', async () => {
        const ctx = await setup(); const window = browser(); expect((await ctx.poll(window)).status).toBe(200);
        const listedResponse = await fetch(`${ctx.url}/api/assistant/clients`); expect(listedResponse.status).toBe(200);
        const listedText = await listedResponse.text(); expect(listedText).not.toContain(window.clientToken); expect(listedText).not.toContain(CREDENTIAL);
        expect(JSON.parse(listedText)).toEqual([{ clientId: window.clientId, ...window.chart }]);
        const request = ctx.post('/api/assistant/call', call(window)); const task = await receive(ctx, window);
        expect(task).toMatchObject(call(window)); expect(task.deadline).toBeGreaterThan(Date.now());
        expect(await (await ctx.poll(window)).json()).toEqual({ request: null });
        const value = { symbol: 'NQM4', timeframe: '1', candles: [{ time: window.chart.cursorTime, open: 20000, high: 20002, low: 19999, close: 20001, volume: 25 }] };
        const completed = await ctx.poll(window, { requestId: task.requestId, success: true, value }); expect(completed.status).toBe(200);
        const result = await request; expect(result.status).toBe(200); expect(await result.json()).toEqual(value);
        expect((await ctx.poll(window, { requestId: task.requestId, success: true, value })).status).toBe(409);
        expect(ctx.app.store.sessions()).toHaveLength(0); expect(ctx.app.store.listDatasets()).toHaveLength(0);
    });
    it('reconciles a delivered operation after its real HTTP caller disconnects without resending it', async () => {
        const ctx = await setup(); const window = browser(); await ctx.poll(window);
        const requestId = randomUUID(); const original = call(window, { operation: 'set_viewport', requestId, args: { fit: true } });
        const cancellation = new AbortController();
        const disconnected = fetch(`${ctx.url}/api/assistant/call`, { method: 'POST', headers: ctx.headers, body: JSON.stringify(original), signal: cancellation.signal }).catch(error => error);
        const task = await receive(ctx, window); expect(task.requestId).toBe(requestId);
        cancellation.abort(); expect(await disconnected).toMatchObject({ name: 'AbortError' });
        const inspect = () => ctx.post('/api/assistant/call', call(window, { operation: 'read_operation', args: { requestId } }));
        const pending = await inspect(); expect(pending.status).toBe(200); expect(await pending.json()).toMatchObject({ requestId, state: 'pending', dispatchedAt: expect.any(Number) });
        const value = { visibleRange: { from: 100, to: 200 }, saved: true };
        expect((await ctx.poll(window, { requestId, success: true, value })).status).toBe(200);
        const receipt = await inspect(); expect(receipt.status).toBe(200); expect(await receipt.json()).toMatchObject({ state: 'completed', value });
        const reused = await ctx.post('/api/assistant/call', original); expect(reused.status).toBe(409); expect(await reused.json()).toMatchObject({ code: 'CHART_REQUEST_ID_REUSED' });
        expect(await (await ctx.poll(window)).json()).toEqual({ request: null });
        expect(ctx.provider).not.toHaveBeenCalled();
    });
    it('keeps registration tokens private and rejects a different browser completing a chart request', async () => {
        const ctx = await setup(); const one = browser(); const two = browser(); await ctx.poll(one); await ctx.poll(two);
        const request = ctx.post('/api/assistant/call', call(one)); const task = await receive(ctx, one);
        expect((await ctx.poll({ ...one, clientToken: randomUUID() })).status).toBe(403);
        expect((await ctx.poll(two, { requestId: task.requestId, success: true, value: 'different chart' })).status).toBe(409);
        expect((await ctx.poll(one, { requestId: task.requestId, success: true, value: { ready: true } })).status).toBe(200);
        expect(await (await request).json()).toEqual({ ready: true });
    });
    it('blocks exact provider credentials in chart arguments, registrations, results and error strings', async () => {
        const ctx = await setup(); const window = browser(); await ctx.poll(window);
        for (const operation of [
            () => ctx.post('/api/assistant/call', call(window, { args: { text: CREDENTIAL } })),
            () => ctx.poll({ ...window, chart: { ...window.chart, symbol: CREDENTIAL } }),
        ]) {
            const response = await operation(); expect(response.status).toBe(400); const text = await response.text(); expect(text).not.toContain(CREDENTIAL); expect(text).toContain('provider credential');
        }
        const request = ctx.post('/api/assistant/call', call(window)); const task = await receive(ctx, window);
        for (const completion of [
            { requestId: task.requestId, success: true as const, value: { note: `Provider ${CREDENTIAL}` } },
            { requestId: task.requestId, success: false as const, error: `Provider ${CREDENTIAL}` },
        ]) {
            const response = await ctx.poll(window, completion); expect(response.status).toBe(400); expect(await response.text()).not.toContain(CREDENTIAL);
        }
        const listed = await (await fetch(`${ctx.url}/api/assistant/clients`)).text(); expect(listed).not.toContain(CREDENTIAL); expect(listed).toContain('NQM4');
        expect((await ctx.poll(window, { requestId: task.requestId, success: true, value: { symbol: 'NQM4', candles: [] } })).status).toBe(200);
        const response = await request; expect(response.status).toBe(200); expect(await response.json()).toEqual({ symbol: 'NQM4', candles: [] });
    });
    it('blocks an exact provider credential even if it reaches the final response serializer', async () => {
        const ctx = await setup(); const window = browser();
        vi.spyOn(ChartAgentBroker.prototype, 'list').mockReturnValue([{ clientId: window.clientId, ...window.chart, symbol: CREDENTIAL }]);
        const response = await fetch(`${ctx.url}/api/assistant/clients`); expect(response.status).toBe(500);
        const text = await response.text(); expect(text).not.toContain(CREDENTIAL); expect(JSON.parse(text)).toEqual({ error: 'Response blocked because it contains a credential.' });
    });
    it('rejects unsupported operations and private fields without contacting any provider', async () => {
        const ctx = await setup(); const window = browser(); await ctx.poll(window);
        for (const operation of ['eval', 'place_order', 'provider_download', 'read_secret']) {
            const response = await ctx.post('/api/assistant/call', { ...call(window), operation }); expect(response.status).toBe(400);
        }
        for (const args of [{ apiKey: 'forbidden' }, { nested: { secret: 'forbidden' } }, { token: 'forbidden' }]) {
            const response = await ctx.post('/api/assistant/call', call(window, { args })); expect(response.status).toBe(400); expect(await response.text()).not.toContain('forbidden');
        }
        expect(await (await ctx.poll(window)).json()).toEqual({ request: null }); expect(ctx.provider).not.toHaveBeenCalled();
    });
});

describe('chart assistant HTTP request and shutdown limits', () => {
    it('applies JSON content, body-byte and argument-count limits before chart dispatch', async () => {
        const ctx = await setup(); const window = browser(); await ctx.poll(window);
        expect((await ctx.post('/api/assistant/exchange', { action: 'poll', ...window }, { 'Content-Type': 'text/plain' })).status).toBe(415);
        const malformed = await raw(`${ctx.url}/api/assistant/exchange`, 'POST', ctx.headers, '{'); expect(malformed.status).toBe(400);
        expect((await ctx.post('/api/assistant/call', call(window, { args: { text: 'x'.repeat(70_000) } }))).status).toBe(413);
        expect((await ctx.post('/api/assistant/exchange', { action: 'poll', ...window, padding: 'x'.repeat(2_000_000) })).status).toBe(413);
        expect((await ctx.post('/api/assistant/call', call(window, { args: { values: Array.from({ length: 10001 }, () => null) } }))).status).toBe(400);
        expect((await ctx.post('/api/assistant/call', call(window, { args: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field${index}`, index])) }))).status).toBe(400);
        expect(await (await ctx.poll(window)).json()).toEqual({ request: null });
    });
    it('enforces one outstanding HTTP tool call per browser and releases capacity after completion', async () => {
        const ctx = await setup(); const window = browser(); await ctx.poll(window);
        const first = ctx.post('/api/assistant/call', call(window)); const task = await receive(ctx, window);
        const duplicate = await ctx.post('/api/assistant/call', call(window)); expect(duplicate.status).toBe(429); expect(await duplicate.json()).toMatchObject({ code: 'CHART_REQUEST_LIMIT' });
        await ctx.poll(window, { requestId: task.requestId, success: true, value: 'first' }); expect(await (await first).json()).toBe('first');
        const next = ctx.post('/api/assistant/call', call(window)); const nextTask = await receive(ctx, window); expect(nextTask.requestId).not.toBe(task.requestId);
        await ctx.poll(window, { requestId: nextTask.requestId, success: true, value: 'next' }); expect(await (await next).json()).toBe('next');
    });
    it('rejects calls and exchanges while a managed update prepares and resumes after cancellation', async () => {
        const ctx = await setup(true); const window = browser(); await ctx.poll(window);
        const updateId = randomUUID(); expect(ctx.app.runtime.prepare(updateId)).toBe(true);
        for (const [path, value] of [['/api/assistant/call', call(window)], ['/api/assistant/exchange', { action: 'poll', ...window }]] as const) {
            const response = await ctx.post(path, value); expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: 'UPDATE_PENDING' });
        }
        expect((await fetch(`${ctx.url}/api/assistant/clients`)).status).toBe(200);
        expect(ctx.app.runtime.cancel(updateId)).toBe(true); expect((await ctx.poll(window)).status).toBe(200);
    });
    it('terminates an accepted pending HTTP call promptly when the application closes', async () => {
        const ctx = await setup(); const window = browser(); await ctx.poll(window);
        const request = ctx.post('/api/assistant/call', call(window)); await receive(ctx, window);
        const started = Date.now(); const stopped = ctx.app.close();
        const response = await request; expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: 'CHART_ASSISTANT_CLOSED' });
        await stopped; expect(Date.now() - started).toBeLessThan(1500); await ctx.app.close();
    });
});
