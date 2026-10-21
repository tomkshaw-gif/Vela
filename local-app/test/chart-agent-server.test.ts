import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ChartAgentBroker } from '../server/chart-agent';
import { CHART_AGENT_OPERATIONS } from '../shared/chart-agent';
import type { ChartAgentCall, ChartAgentClient, ChartAgentCompletion, ChartAgentTask } from '../shared/chart-agent';

const brokers: ChartAgentBroker[] = [];
function setup() {
    vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2024, 3, 8));
    const broker = new ChartAgentBroker(); brokers.push(broker);
    return broker;
}
function client() {
    const clientId = randomUUID(); const clientToken = randomUUID();
    const chart: Omit<ChartAgentClient, 'clientId'> = {
        sessionId: randomUUID(), generation: 1, symbol: 'NQM4', timeframe: '1',
        cells: [{ id: 'cell-1', timeframe: '1' }, { id: 'cell-2', timeframe: '5' }], cursorTime: Date.UTC(2024, 3, 8),
    };
    return { clientId, clientToken, chart };
}
function poll(broker: ChartAgentBroker, browser: ReturnType<typeof client>, completion?: ChartAgentCompletion) {
    return broker.exchange({ action: 'poll', ...browser, ...(completion ? { completion } : {}) });
}
function input(browser: ReturnType<typeof client>, overrides: Partial<ChartAgentCall> = {}): ChartAgentCall {
    return {
        operation: 'read_chart', args: {},
        target: { clientId: browser.clientId, sessionId: browser.chart.sessionId, generation: browser.chart.generation, cellId: 'cell-1' },
        ...overrides,
    };
}
function delivered(broker: ChartAgentBroker, browser: ReturnType<typeof client>): ChartAgentTask {
    const task = poll(broker, browser).request; expect(task).not.toBeNull(); return task!;
}
function outcome(value: Promise<unknown>): Promise<unknown> { return value.catch(error => error); }
function readOperation(broker: ChartAgentBroker, browser: ReturnType<typeof client>, requestId: string, target = input(browser).target) {
    return broker.call({ operation: 'read_operation', target, args: { requestId } });
}

afterEach(() => { for (const broker of brokers.splice(0)) broker.close(); vi.useRealTimers(); });

describe('chart assistant browser handoff', () => {
    it('delivers once to the exact chart window and returns only its validated result', async () => {
        const broker = setup(); const one = client(); const two = client(); poll(broker, one); poll(broker, two);
        const request = broker.call(input(one)); const task = delivered(broker, one);
        expect(task).toMatchObject({ ...input(one), deadline: Date.now() + 10_000 });
        expect(task.requestId).toMatch(/^[a-f0-9-]{36}$/);
        expect(poll(broker, one)).toEqual({ request: null }); expect(poll(broker, two)).toEqual({ request: null });
        const value = { candles: [{ time: one.chart.cursorTime, close: 20000 }], futureData: false };
        expect(poll(broker, one, { requestId: task.requestId, success: true, value })).toEqual({ request: null });
        expect(await request).toEqual(value);
        expect(() => poll(broker, one, { requestId: task.requestId, success: true, value })).toThrow('no longer pending');
    });
    it('lists metadata without the private browser token and returns independent copies', () => {
        const broker = setup(); const browser = client(); poll(broker, browser);
        const listed = broker.list(); expect(listed).toEqual([{ clientId: browser.clientId, ...browser.chart }]);
        expect(JSON.stringify(listed)).not.toContain(browser.clientToken);
        listed[0]!.cells[0]!.id = 'modified'; browser.chart.cells[1]!.id = 'also-modified';
        expect(broker.list()[0]!.cells.map(cell => cell.id)).toEqual(['cell-1', 'cell-2']);
    });
    it('copies arguments before enqueueing and never exposes mutable internal tasks', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser);
        const args = { nested: { color: '#fff' } }; const request = broker.call(input(browser, { args })); args.nested.color = '#000';
        const task = delivered(broker, browser); expect(task.args).toEqual({ nested: { color: '#fff' } });
        task.target.generation = 999;
        poll(broker, browser, { requestId: task.requestId, success: true, value: null }); expect(await request).toBeNull();
    });
    it('rejects registration and response takeover by another browser token', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser); const request = broker.call(input(browser));
        const task = delivered(broker, browser); const intruder = { ...browser, clientToken: randomUUID() };
        expect(() => poll(broker, intruder)).toThrow('token does not match');
        expect(() => poll(broker, intruder, { requestId: task.requestId, success: true, value: null })).toThrow('token does not match');
        expect(() => broker.exchange({ action: 'release', clientId: browser.clientId, clientToken: intruder.clientToken })).toThrow('token does not match');
        poll(broker, browser, { requestId: task.requestId, success: true, value: 'owner' }); expect(await request).toBe('owner');
    });
    it('rejects completion from a different chart and completion before delivery', async () => {
        const broker = setup(); const one = client(); const two = client(); poll(broker, one); poll(broker, two);
        const request = broker.call(input(one)); const task = delivered(broker, one);
        expect(() => poll(broker, two, { requestId: task.requestId, success: true, value: null })).toThrow('no longer pending');
        expect(() => poll(broker, one, { requestId: randomUUID(), success: true, value: null })).toThrow('no longer pending');
        poll(broker, one, { requestId: task.requestId, success: true, value: null }); await request;
        const absent = client();
        expect(() => poll(broker, absent, { requestId: task.requestId, success: true, value: null })).toThrow('Register the chart');
    });
    it('surfaces a bounded tool failure once without replaying the command', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser); const request = outcome(broker.call(input(browser)));
        const task = delivered(broker, browser); poll(broker, browser, { requestId: task.requestId, success: false, error: 'This indicator input is not supported.' });
        expect(await request).toMatchObject({ status: 422, code: 'CHART_TOOL_FAILED', message: 'This indicator input is not supported.' });
        expect(poll(broker, browser).request).toBeNull();
    });
});

describe('chart assistant target and lifecycle boundaries', () => {
    it('requires an explicit connected client, session generation, and cell for every cell tool', async () => {
        const broker = setup(); const browser = client();
        await expect(broker.call(input(browser))).rejects.toMatchObject({ code: 'CHART_CLIENT_NOT_CONNECTED' }); poll(broker, browser);
        for (const target of [
            { ...input(browser).target, sessionId: randomUUID() },
            { ...input(browser).target, generation: 0 },
            { ...input(browser).target, cellId: 'missing' },
        ]) await expect(broker.call(input(browser, { target }))).rejects.toMatchObject({ code: 'CHART_TARGET_CHANGED' });
        const { cellId: _cellId, ...target } = input(browser).target;
        for (const operation of CHART_AGENT_OPERATIONS.filter(operation => operation !== 'list_drawing_tools')) await expect(broker.call(input(browser, { operation, target }))).rejects.toMatchObject({ status: 400 });
        const request = broker.call(input(browser, { operation: 'list_drawing_tools', target })); const task = delivered(broker, browser);
        poll(broker, browser, { requestId: task.requestId, success: true, value: [] }); expect(await request).toEqual([]);
    });
    it('cancels queued requests when the browser changes session or generation', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser); const old = input(browser);
        const request = outcome(broker.call(old)); browser.chart = { ...browser.chart, sessionId: randomUUID(), generation: 2 };
        expect(poll(broker, browser).request).toBeNull(); expect(await request).toMatchObject({ code: 'CHART_TARGET_CHANGED' });
        await expect(broker.call(old)).rejects.toMatchObject({ code: 'CHART_TARGET_CHANGED' });
        expect(() => poll(broker, { ...browser, chart: { ...browser.chart, generation: 1 } })).toThrow('no longer current');
        expect(() => poll(broker, { ...browser, chart: { ...browser.chart, sessionId: randomUUID() } })).toThrow('no longer current');
    });
    it('records the new session even when a stale delivered response arrives with its heartbeat', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser); const request = outcome(broker.call(input(browser)));
        const task = delivered(broker, browser); browser.chart = { ...browser.chart, sessionId: randomUUID(), generation: 2 };
        expect(() => poll(broker, browser, { requestId: task.requestId, success: true, value: 'stale' })).toThrow('no longer pending');
        expect(await request).toMatchObject({ code: 'CHART_TARGET_CHANGED' });
        expect(broker.list()[0]).toMatchObject({ sessionId: browser.chart.sessionId, generation: 2 });
    });
    it('cancels delivered requests when their cell is removed, without selecting a replacement', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser); const request = outcome(broker.call(input(browser)));
        const task = delivered(broker, browser); browser.chart.cells = [browser.chart.cells[1]!];
        expect(() => poll(broker, browser, { requestId: task.requestId, success: true, value: 'wrong cell' })).toThrow('no longer pending');
        expect(await request).toMatchObject({ code: 'CHART_TARGET_CHANGED' });
        await expect(broker.call(input(browser))).rejects.toMatchObject({ code: 'CHART_TARGET_CHANGED' });
    });
    it('rejects requests immediately on explicit release and permits idempotent release', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser); const request = outcome(broker.call(input(browser)));
        const release = { action: 'release', clientId: browser.clientId, clientToken: browser.clientToken };
        expect(broker.exchange(release)).toEqual({ request: null }); expect(broker.exchange(release)).toEqual({ request: null });
        expect(await request).toMatchObject({ code: 'CHART_CLIENT_DISCONNECTED' }); expect(broker.list()).toEqual([]);
    });
    it('expires a missing browser after eight seconds and never redelivers its task', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser); const request = outcome(broker.call(input(browser)));
        const task = delivered(broker, browser); await vi.advanceTimersByTimeAsync(8000);
        expect(await request).toMatchObject({ code: 'CHART_CLIENT_EXPIRED' }); expect(broker.list()).toEqual([]);
        await expect(readOperation(broker, browser, task.requestId)).resolves.toMatchObject({ state: 'unknown', requestId: task.requestId });
        expect(poll(broker, browser, { requestId: task.requestId, success: true, value: null })).toEqual({ request: null });
        await expect(readOperation(broker, browser, task.requestId)).resolves.toMatchObject({ state: 'completed', value: null });
        expect(poll(broker, browser).request).toBeNull();
    });
    it('enforces a ten-second request deadline even while the browser remains connected', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser); const request = outcome(broker.call(input(browser)));
        const task = delivered(broker, browser); await vi.advanceTimersByTimeAsync(6000); poll(broker, browser);
        await vi.advanceTimersByTimeAsync(4000); expect(await request).toMatchObject({ status: 504, code: 'CHART_REQUEST_TIMEOUT' });
        expect(broker.list()).toHaveLength(1);
        await expect(readOperation(broker, browser, task.requestId)).resolves.toMatchObject({ state: 'unknown' });
        expect((await request as Error).message).toContain(task.requestId);
        expect(poll(broker, browser, { requestId: task.requestId, success: true, value: { saved: true } })).toEqual({ request: null });
        await expect(readOperation(broker, browser, task.requestId)).resolves.toMatchObject({ state: 'completed', value: { saved: true } });
        expect(poll(broker, browser).request).toBeNull();
    });
    it('closes and clears every timer and pending request without retaining browser data', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser); const request = outcome(broker.call(input(browser)));
        expect(vi.getTimerCount()).toBe(1); broker.close(); broker.close();
        expect(await request).toMatchObject({ status: 503, code: 'CHART_ASSISTANT_CLOSED' }); expect(vi.getTimerCount()).toBe(0); expect(broker.list()).toEqual([]);
        await expect(broker.call(input(browser))).rejects.toMatchObject({ status: 503 });
        expect(() => poll(broker, browser)).toThrow('restarting');
    });
});

describe('chart assistant authenticated heartbeat and operation reconciliation', () => {
    it('renews only an existing exact registration and never dispatches a queued operation', async () => {
        const broker = setup(); const browser = client();
        const heartbeat = () => broker.exchange({ action: 'heartbeat', ...browser });
        expect(heartbeat).toThrow('not registered'); expect(broker.list()).toEqual([]);
        poll(broker, browser); const requestId = randomUUID(); const request = broker.call(input(browser, { requestId }));
        await vi.advanceTimersByTimeAsync(6000);
        expect(heartbeat()).toEqual({ request: null });
        expect(() => broker.exchange({ action: 'heartbeat', ...browser, clientToken: randomUUID() })).toThrow('token does not match');
        for (const chart of [
            { ...browser.chart, generation: 2 }, { ...browser.chart, sessionId: randomUUID() }, { ...browser.chart, symbol: 'ESM4' },
            { ...browser.chart, timeframe: '5' }, { ...browser.chart, cursorTime: null }, { ...browser.chart, cells: [...browser.chart.cells].reverse() },
            { ...browser.chart, cells: [{ id: 'cell-1', timeframe: '5' }, browser.chart.cells[1]!] },
        ]) expect(() => broker.exchange({ action: 'heartbeat', ...browser, chart })).toThrow('no longer current');
        expect(() => broker.exchange({ action: 'heartbeat', ...browser, completion: { requestId, success: true, value: null } })).toThrow('Invalid chart assistant');
        await vi.advanceTimersByTimeAsync(3000); expect(broker.list()).toHaveLength(1);
        const receipt = await readOperation(broker, browser, requestId); expect(receipt).toMatchObject({ state: 'pending' }); expect(receipt).not.toHaveProperty('dispatchedAt');
        const task = delivered(broker, browser); expect(task.requestId).toBe(requestId);
        poll(broker, browser, { requestId, success: true, value: 'one delivery' }); await expect(request).resolves.toBe('one delivery');
    });
    it('retains owned outcomes after disconnect, rejects reused IDs and never applies a retry', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser);
        const requestId = randomUUID(); const request = outcome(broker.call(input(browser, { requestId }))); delivered(broker, browser);
        broker.exchange({ action: 'release', clientId: browser.clientId, clientToken: browser.clientToken });
        expect(await request).toMatchObject({ code: 'CHART_CLIENT_DISCONNECTED' });
        await expect(readOperation(broker, browser, requestId)).resolves.toMatchObject({ state: 'unknown', requestId, target: input(browser).target });
        await expect(broker.call(input(browser, { requestId }))).rejects.toMatchObject({ code: 'CHART_REQUEST_ID_REUSED' });
        await expect(broker.call(input(browser, { requestId: requestId.toUpperCase() }))).rejects.toMatchObject({ code: 'CHART_REQUEST_ID_REUSED' });
        for (const target of [
            { ...input(browser).target, clientId: randomUUID() }, { ...input(browser).target, sessionId: randomUUID() },
            { ...input(browser).target, generation: 2 }, { ...input(browser).target, cellId: 'cell-2' },
        ]) await expect(readOperation(broker, browser, requestId, target)).rejects.toMatchObject({ code: 'CHART_TARGET_CHANGED' });
        expect(() => poll(broker, { ...browser, clientToken: randomUUID() }, { requestId, success: true, value: null })).toThrow('token does not match');
        poll(broker, browser, { requestId, success: true, value: { saved: true } });
        await expect(readOperation(broker, browser, requestId)).resolves.toMatchObject({ state: 'completed', completedAt: Date.now(), value: { saved: true } });
        expect(poll(broker, browser).request).toBeNull();
    });
    it('copies retained results independently of both the browser and the original caller', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser);
        const request = broker.call(input(browser)); const task = delivered(broker, browser); const value = { drawing: { color: '#fff' } };
        poll(broker, browser, { requestId: task.requestId, success: true, value }); value.drawing.color = '#000';
        (await request as typeof value).drawing.color = '#abc';
        const receipt = await readOperation(broker, browser, task.requestId) as { value: typeof value };
        expect(receipt.value.drawing.color).toBe('#fff'); receipt.value.drawing.color = '#def';
        await expect(readOperation(broker, browser, task.requestId)).resolves.toMatchObject({ value: { drawing: { color: '#fff' } } });
    });
    it('authenticates late acknowledgments even if another token registered after lease expiry', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser);
        const request = outcome(broker.call(input(browser))); const task = delivered(broker, browser);
        await vi.advanceTimersByTimeAsync(8000); await request;
        const intruder = { ...browser, clientToken: randomUUID() }; poll(broker, intruder);
        expect(() => poll(broker, intruder, { requestId: task.requestId, success: true, value: 'forged' })).toThrow('token does not match');
        await expect(readOperation(broker, browser, task.requestId)).resolves.toMatchObject({ state: 'unknown' });
    });
    it('records undelivered and tool failures distinctly, and bounds retained outcomes to 64 for five minutes', async () => {
        const broker = setup(); const browser = client(); const absentId = randomUUID();
        await expect(broker.call(input(browser, { requestId: absentId }))).rejects.toMatchObject({ code: 'CHART_CLIENT_NOT_CONNECTED' });
        await expect(readOperation(broker, browser, absentId)).resolves.toMatchObject({ state: 'not_dispatched' });
        poll(broker, browser);
        const failure = outcome(broker.call(input(browser))); const failedTask = delivered(broker, browser);
        poll(broker, browser, { requestId: failedTask.requestId, success: false, error: 'The chart changed, but saving failed.' }); await failure;
        await expect(readOperation(broker, browser, failedTask.requestId)).resolves.toMatchObject({ state: 'failed', error: 'The chart changed, but saving failed.' });
        let lastId = '';
        for (let index = 0; index < 65; index++) {
            const request = broker.call(input(browser)); const task = delivered(broker, browser); lastId = task.requestId;
            poll(broker, browser, { requestId: task.requestId, success: true, value: { index } }); await request;
        }
        await expect(readOperation(broker, browser, absentId)).resolves.toMatchObject({ state: 'unknown', error: expect.stringContaining('expired, been evicted') });
        await expect(readOperation(broker, browser, failedTask.requestId)).resolves.toMatchObject({ state: 'unknown' });
        await expect(readOperation(broker, browser, lastId)).resolves.toMatchObject({ state: 'completed', value: { index: 64 } });
        expect((broker as unknown as { receipts: Map<string, unknown> }).receipts.size).toBe(64);
        await vi.advanceTimersByTimeAsync(300000);
        await expect(readOperation(broker, browser, lastId)).resolves.toMatchObject({ state: 'unknown', error: expect.stringContaining('does not establish') });
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('chart assistant request and memory bounds', () => {
    it('retains every cell in a sixteen-chart workspace without truncating its target metadata', () => {
        const broker = setup(); const browser = client(); browser.chart.cells = Array.from({ length: 16 }, (_, index) => ({ id: `cell-${index}`, timeframe: index % 2 ? '3M' : '7' }));
        poll(broker, browser); expect(broker.list()[0]!.cells).toEqual(browser.chart.cells);
    });
    it('allows sixteen live browser registrations and reclaims expired leases', async () => {
        const broker = setup(); for (let i = 0; i < 16; i++) poll(broker, client());
        const next = client(); expect(() => poll(broker, next)).toThrow('Too many active chart');
        await vi.advanceTimersByTimeAsync(8000); expect(poll(broker, next).request).toBeNull(); expect(broker.list()).toHaveLength(1);
    });
    it('bounds concurrent requests to eight globally and one per window', async () => {
        const broker = setup(); const browsers = Array.from({ length: 9 }, client); browsers.forEach(browser => poll(broker, browser));
        const requests = browsers.slice(0, 8).map(browser => outcome(broker.call(input(browser))));
        await expect(broker.call(input(browsers[0]!))).rejects.toMatchObject({ status: 429 });
        await expect(broker.call(input(browsers[8]!))).rejects.toMatchObject({ status: 429 });
        const task = delivered(broker, browsers[0]!); poll(broker, browsers[0]!, { requestId: task.requestId, success: true, value: null });
        const admitted = outcome(broker.call(input(browsers[8]!))); broker.close(); await Promise.all([...requests, admitted]);
    });
    it.each([
        { action: 'unknown' }, { action: 'poll', clientId: 'not-uuid', clientToken: randomUUID(), chart: client().chart },
        { action: 'release', clientId: randomUUID(), clientToken: randomUUID(), extra: true },
        { action: 'poll', ...client(), extra: true },
    ])('rejects unknown exchange fields and malformed identity %#', value => {
        const broker = setup(); expect(() => broker.exchange(value)).toThrow('Invalid chart assistant');
    });
    it.each([
        { generation: -1 }, { generation: 1.5 }, { generation: Number.MAX_SAFE_INTEGER + 1 }, { symbol: '\u0000' },
        { timeframe: '' }, { cells: [] }, { cells: Array.from({ length: 17 }, (_, i) => ({ id: String(i), timeframe: '1' })) },
        { cells: [{ id: 'same', timeframe: '1' }, { id: 'same', timeframe: '5' }] }, { cursorTime: NaN },
        { cursorTime: -1 }, { cursorTime: '2024-04-08' }, { cells: [{ id: '1', timeframe: '1', extra: true }] },
    ])('rejects malformed registration metadata %#', override => {
        const broker = setup(); const browser = client(); expect(() => poll(broker, { ...browser, chart: { ...browser.chart, ...override } as typeof browser.chart })).toThrow('Invalid chart assistant');
    });
    it.each([
        { operation: 'eval' }, { operation: 'place_order' }, { extra: 'not supported' }, { args: [] },
        { target: { ...input(client()).target, extra: true } },
    ])('rejects operations and wrapper fields outside the explicit allowlist %#', async override => {
        const broker = setup(); const browser = client(); poll(broker, browser);
        await expect(broker.call({ ...input(browser), ...override })).rejects.toMatchObject({ status: 400 });
    });
    it('rejects non-JSON, deep, cyclic, oversized, and private argument fields before enqueueing', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser);
        const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
        let deep: Record<string, unknown> = {}; for (let i = 0; i < 13; i++) deep = { next: deep };
        const getter = Object.defineProperty({}, 'value', { get: () => 'not data', enumerable: true });
        for (const args of [{ value: NaN }, { value: Infinity }, { value: undefined }, { value: BigInt(1) }, { value: () => {} }, { value: new Date() }, cyclic, deep, { value: 'x'.repeat(65536) }, { values: Array.from({ length: 10001 }, () => null) }, { apiKey: 'private' }, { nested: { authorization: 'private' } }, getter]) {
            await expect(broker.call(input(browser, { args }))).rejects.toMatchObject({ status: 400 });
        }
        expect(poll(broker, browser).request).toBeNull();
    });
    it('limits normal results to 256 KiB and allows a bounded screenshot result up to 1.5 MiB', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser);
        const request = broker.call(input(browser)); const task = delivered(broker, browser); const screenshot = { mimeType: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${'a'.repeat(500_000)}` };
        expect(() => poll(broker, browser, { requestId: task.requestId, success: true, value: screenshot })).toThrow('Invalid chart assistant');
        expect(() => poll(broker, browser, { requestId: task.requestId, success: true, value: { token: 'private' } })).toThrow('Invalid chart assistant');
        poll(broker, browser, { requestId: task.requestId, success: true, value: null }); await request;
        const imageRequest = broker.call(input(browser, { operation: 'screenshot' })); const imageTask = delivered(broker, browser);
        expect(() => poll(broker, browser, { requestId: imageTask.requestId, success: true, value: 'x'.repeat(1536 * 1024) })).toThrow('Invalid chart assistant');
        poll(broker, browser, { requestId: imageTask.requestId, success: true, value: screenshot }); expect(await imageRequest).toEqual(screenshot);
    });
    it('rejects malformed completions and oversized or control-character errors without losing the pending request', async () => {
        const broker = setup(); const browser = client(); poll(broker, browser); const request = broker.call(input(browser)); const task = delivered(broker, browser);
        for (const response of [
            { requestId: task.requestId, success: true, value: null, extra: true },
            { requestId: task.requestId, success: false, error: 'x'.repeat(2001) },
            { requestId: task.requestId, success: false, error: 'bad\u0000error' },
            { requestId: task.requestId, success: 'true', value: null },
        ]) expect(() => broker.exchange({ action: 'poll', ...browser, completion: response })).toThrow('Invalid chart assistant');
        poll(broker, browser, { requestId: task.requestId, success: true, value: null }); await request;
    });
});
