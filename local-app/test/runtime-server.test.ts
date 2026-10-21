import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createReplayServer, serverOptionsFromEnvironment } from '../server/index';
import { RuntimeCoordinator, repositoryIdentity } from '../server/runtime';
import { DEFAULT_RULES } from '../shared/types';
import type { SessionView } from '../shared/types';

const apps: Awaited<ReturnType<typeof createReplayServer>>[] = [];
const coordinators: RuntimeCoordinator[] = [];
const directories: string[] = [];
const START = Date.UTC(2024, 3, 8);
const runtime = { mode: 'run' as const, version: 'test-build.1' };
function temporary(): string { const value = mkdtempSync(join(tmpdir(), 'vela-runtime-test-')); directories.push(value); return value; }
function coordinator(idle: () => boolean = () => true) {
    vi.useFakeTimers(); vi.setSystemTime(START);
    const notify = vi.fn(); const value = new RuntimeCoordinator(runtime, resolve('.'), notify, Date.now, idle);
    coordinators.push(value); return { value, notify };
}
async function setup(options: Parameters<typeof createReplayServer>[0] = {}) {
    const app = await createReplayServer({ dataDirectory: temporary(), port: 0, runtime, apiKey: 'runtime-private-test-key', ...options }); apps.push(app);
    const url = await app.listen(); const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json() as { token: string };
    const post = (path: string, value: unknown, token = bootstrap.token, headers: Record<string, string> = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token, ...headers }, body: JSON.stringify(value) });
    return { app, url, post };
}
afterEach(async () => {
    for (const value of coordinators.splice(0)) value.close(); vi.useRealTimers();
    for (const app of apps.splice(0)) await app.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('managed update lease coordination', () => {
    it('waits for the registration grace and every active application window', () => {
        const { value, notify } = coordinator(); const one = randomUUID(); const two = randomUUID(); const updateId = randomUUID();
        value.client({ clientId: one, action: 'heartbeat' }); value.client({ clientId: two, action: 'heartbeat' });
        expect(value.prepare(updateId)).toBe(true);
        value.client({ clientId: one, action: 'ready', updateId });
        vi.advanceTimersByTime(1000); expect(notify).not.toHaveBeenCalled();
        value.client({ clientId: two, action: 'ready', updateId });
        expect(notify).toHaveBeenCalledExactlyOnceWith({ type: 'runtime:ready', updateId });
        expect(value.canShutdown(updateId)).toBe(true);
    });
    it('discovers a window that registers after ready and rechecks readiness before shutdown', () => {
        const { value, notify } = coordinator(); const updateId = randomUUID();
        value.prepare(updateId); vi.advanceTimersByTime(1000); expect(notify).toHaveBeenCalledTimes(1);
        const clientId = randomUUID(); value.client({ clientId, action: 'heartbeat' });
        expect(value.canShutdown(updateId)).toBe(false);
        vi.advanceTimersByTime(20_000); expect(value.canShutdown(updateId)).toBe(false); expect(notify).toHaveBeenCalledTimes(1);
        value.client({ clientId, action: 'ready', updateId });
        expect(notify).toHaveBeenCalledTimes(2); expect(value.canShutdown(updateId)).toBe(true);
    });
    it('refuses a stale parent shutdown and atomically seals registration after a current shutdown', () => {
        const { value, notify } = coordinator(); const updateId = randomUUID();
        value.prepare(updateId); vi.advanceTimersByTime(1000); expect(notify).toHaveBeenCalledTimes(1);
        const clientId = randomUUID(); value.client({ clientId, action: 'heartbeat' });
        expect(value.beginShutdown(updateId)).toBe(false); expect(value.preparing).toBe(true);
        value.client({ clientId, action: 'ready', updateId }); expect(value.beginShutdown(updateId)).toBe(true);
        expect(() => value.client({ clientId: randomUUID(), action: 'heartbeat' })).toThrow('restarting');
        expect(value.beginShutdown(updateId)).toBe(false); expect(value.prepare(randomUUID())).toBe(false);
    });
    it('bounds window leases, expires abandoned windows outside an update and rejects malformed or stale acknowledgements', () => {
        const { value, notify } = coordinator(); const ids = Array.from({ length: 64 }, () => randomUUID());
        for (const clientId of ids) value.client({ clientId, action: 'heartbeat' });
        expect(() => value.client({ clientId: randomUUID(), action: 'heartbeat' })).toThrow('Too many');
        vi.advanceTimersByTime(20_000);
        value.client({ clientId: ids[0], action: 'heartbeat' });
        const updateId = randomUUID(); value.prepare(updateId);
        expect(() => value.client({ clientId: ids[0], action: 'ready', updateId: randomUUID() })).toThrow('no longer current');
        expect(() => value.client({ clientId: 'not-an-id', action: 'ready', updateId })).toThrow('Invalid runtime');
        expect(() => value.client({ clientId: ids[0], action: 'heartbeat', updateId })).toThrow('must not contain');
        expect(() => value.client({ clientId: ids[0], action: 'ready', updateId, extra: true })).toThrow('Invalid runtime');
        value.client({ clientId: ids[0], action: 'ready', updateId });
        vi.advanceTimersByTime(1000); expect(notify).toHaveBeenCalledTimes(1); expect(value.canShutdown(updateId)).toBe(true);
        const replacement = randomUUID(); value.client({ clientId: replacement, action: 'heartbeat' }); expect(value.canShutdown(updateId)).toBe(false);
        value.client({ clientId: replacement, action: 'release' }); expect(value.canShutdown(updateId)).toBe(true);
        expect(() => value.client({ clientId: replacement, action: 'ready', updateId })).toThrow('Register');
    });
    it('freezes update participants until they explicitly acknowledge or release, even after their lease expires', () => {
        const { value, notify } = coordinator(); const one = randomUUID(); const two = randomUUID(); const updateId = randomUUID();
        value.client({ clientId: one, action: 'heartbeat' }); value.client({ clientId: two, action: 'heartbeat' }); value.prepare(updateId);
        vi.advanceTimersByTime(27_000); expect(notify).not.toHaveBeenCalled(); expect(value.canShutdown(updateId)).toBe(false);
        value.client({ clientId: one, action: 'ready', updateId }); expect(notify).not.toHaveBeenCalled();
        value.client({ clientId: two, action: 'release' }); expect(notify).toHaveBeenCalledExactlyOnceWith({ type: 'runtime:ready', updateId });
        expect(value.canShutdown(updateId)).toBe(true);
    });
    it('clears frozen participants on cancellation and restores normal lease expiration', () => {
        const { value, notify } = coordinator(); const clientId = randomUUID(); const firstUpdate = randomUUID();
        value.client({ clientId, action: 'heartbeat' }); value.prepare(firstUpdate); vi.advanceTimersByTime(27_000);
        expect(value.canShutdown(firstUpdate)).toBe(false); expect(value.cancel(firstUpdate)).toBe(true);
        const nextUpdate = randomUUID(); value.prepare(nextUpdate); vi.advanceTimersByTime(1000);
        expect(notify).toHaveBeenCalledExactlyOnceWith({ type: 'runtime:ready', updateId: nextUpdate });
    });
    it('waits for accepted writes even with no windows, and cancellation restores the old instance', () => {
        let idle = false; const { value, notify } = coordinator(() => idle); const updateId = randomUUID();
        expect(value.prepare('malformed')).toBe(false); value.prepare(updateId);
        vi.advanceTimersByTime(1000); expect(notify).not.toHaveBeenCalled();
        idle = true; value.activityChanged(); expect(notify).toHaveBeenCalledTimes(1);
        expect(value.cancel(randomUUID())).toBe(false); expect(value.cancel(updateId)).toBe(true);
        expect(value.status()).toMatchObject({ phase: 'error', updateId: null }); expect(value.preparing).toBe(false);
        expect(value.canShutdown(updateId)).toBe(false); expect(value.canShutdown(undefined)).toBe(true);
        const nextUpdate = randomUUID(); value.prepare(nextUpdate); vi.advanceTimersByTime(999); expect(notify).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1); expect(notify).toHaveBeenCalledTimes(2);
    });
    it('provides stable repository identity and leaves unmanaged imports inert', () => {
        const value = new RuntimeCoordinator(undefined, resolve('.')); coordinators.push(value);
        expect(value.status()).toMatchObject({ managed: false, phase: 'ready', repositoryId: repositoryIdentity(resolve('.')) });
        expect(value.prepare(randomUUID())).toBe(false);
        expect(() => value.client({ clientId: randomUUID(), action: 'heartbeat' })).toThrow('not managed');
        expect(repositoryIdentity(resolve('.'))).toBe(repositoryIdentity(resolve('.', 'local-app', '..')));
        expect(() => new RuntimeCoordinator({ mode: 'run', version: 'unsafe\nversion' }, resolve('.'))).toThrow('Invalid managed');
    });
});

describe('runtime HTTP boundary and persistence barrier', () => {
    it('applies existing Host/Origin/token policy and exposes no remote update control', async () => {
        const ctx = await setup(); const status = await (await fetch(`${ctx.url}/api/runtime`)).json();
        expect(status).toMatchObject({ managed: true, mode: 'run', version: 'test-build.1', phase: 'ready' });
        expect(status.instanceId).toMatch(/^[a-f0-9-]{36}$/); expect(status.repositoryId).toMatch(/^[a-f0-9]{64}$/);
        expect((await fetch(`${ctx.url}/api/runtime`, { headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
        expect((await ctx.post('/api/runtime/client', { clientId: randomUUID(), action: 'heartbeat' }, '')).status).toBe(403);
        expect((await ctx.post('/api/runtime/client', { clientId: randomUUID(), action: 'heartbeat' })).status).toBe(200);
        expect((await ctx.post('/api/runtime/prepare', { updateId: randomUUID() })).status).toBe(404);
        expect((await ctx.post('/api/runtime/client', { clientId: 'bad', action: 'heartbeat' })).status).toBe(400);
    });
    it('quiesces trading, provider calls and imports, while allowing chart reads and explicit layout saves', async () => {
        let providerCalls = 0; const ctx = await setup({ fetch: async () => { providerCalls++; return new Response('0'); } });
        const dataset = ctx.app.store.addDataset({ name: 'Runtime bars', symbol: 'NQM4', schema: 'ohlcv-1m', source: 'csv', bars: Array.from({ length: 10 }, (_, i) => ({ time: START + i * 60_000, open: 20000, high: 20001, low: 19999, close: 20000, volume: 1 })) });
        const created = await (await ctx.post('/api/sessions', { name: 'Runtime attempt', datasetId: dataset.id, mode: 'practice', initialBalance: 50000, commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 1, rules: DEFAULT_RULES })).json() as SessionView;
        const route = `/api/sessions/${created.session.id}`; const updateId = randomUUID(); ctx.app.runtime.prepare(updateId);
        const blocked = await ctx.post(`${route}/command`, { expectedRevision: 0, command: { type: 'advance', count: 1 } });
        expect(blocked.status).toBe(503); expect(await blocked.json()).toMatchObject({ code: 'UPDATE_PENDING' });
        expect((await ctx.post('/api/provider/quote', {})).status).toBe(503);
        expect((await ctx.post('/api/provider/download', {})).status).toBe(503);
        expect((await ctx.post('/api/provider/settings', { apiKey: 'must-never-be-written' })).status).toBe(503);
        expect((await ctx.post('/api/datasets/import', {})).status).toBe(503);
        expect((await ctx.post('/api/sessions', {})).status).toBe(503);
        expect((await ctx.post(`${route}/clone`, {})).status).toBe(503); expect(providerCalls).toBe(0);
        const chart = await (await fetch(`${ctx.url}${route}/chart`)).json(); expect(chart.cursorTime).toBe(START);
        let revision = 0;
        for (const command of [{ type: 'layout', layout: { selectedCell: 0 } }, { type: 'rename', name: 'Saved before restart' }, { type: 'bookmark', label: 'Resume here' }]) {
            const saved = await ctx.post(`${route}/command`, { expectedRevision: revision++, command });
            expect(saved.status).toBe(200);
        }
        expect(ctx.app.store.session(created.session.id).cursor).toBe(0);
        const clientId = randomUUID(); expect((await ctx.post('/api/runtime/client', { clientId, action: 'heartbeat' })).status).toBe(200);
        expect((await ctx.post('/api/runtime/client', { clientId, action: 'ready', updateId })).status).toBe(200);
        ctx.app.runtime.cancel(updateId);
        expect((await ctx.post(`${route}/command`, { expectedRevision: revision, command: { type: 'advance', count: 1 } })).status).toBe(200);
    });
    it('drains an accepted asynchronous provider call before closing SQLite and the HTTP server', async () => {
        let providerStarted!: () => void; let release!: (response: Response) => void;
        const started = new Promise<void>(resolveStarted => { providerStarted = resolveStarted; });
        const provider = new Promise<Response>(resolveProvider => { release = resolveProvider; });
        const ctx = await setup({ fetch: async () => { providerStarted(); return provider; } });
        // Exercise accepted work without adding the client's idle keep-alive delay to shutdown.
        const request = ctx.post('/api/provider/quote', { dataset: 'GLBX.MDP3', symbol: 'NQM4', schema: 'ohlcv-1m', start: new Date(START).toISOString(), end: new Date(START + 60_000).toISOString() }, undefined, { Connection: 'close' });
        await started; const updateId = randomUUID(); ctx.app.runtime.prepare(updateId);
        await new Promise(resolveWait => setTimeout(resolveWait, 1050)); expect(ctx.app.runtime.canShutdown(updateId)).toBe(false);
        let closed = false; const close = ctx.app.close().then(() => { closed = true; });
        await new Promise(resolveWait => setImmediate(resolveWait)); expect(closed).toBe(false);
        release(new Response('0')); const response = await request; expect(response.status).toBe(200); await response.json(); await close; expect(closed).toBe(true);
    });
    it('keeps the repository data-directory guard valid for a compiled backend outside the source server folder', async () => {
        const repository = temporary(); const data = join(repository, 'runtime-data');
        await expect(createReplayServer({ dataDirectory: data, repositoryDirectory: repository })).rejects.toThrow('outside the repository');
    });
});

describe('managed direct-entry configuration', () => {
    it.each(['0', '5198', '5200', '5197 ', 'http://remote.example:5197'])('rejects arbitrary CLI port %s', async port => {
        await expect(serverOptionsFromEnvironment({ VELA_PORT: port })).rejects.toThrow('Invalid local runtime port');
    });
    it('validates runtime mode, version and existing absolute stage paths without echoing invalid input', async () => {
        const repository = temporary(); const stage = join(repository, 'stage'); mkdirSync(stage); writeFileSync(join(repository, 'package.json'), '{}');
        const environment = { VELA_PORT: '5197', VELA_RUNTIME_MODE: 'run', VELA_RUNTIME_VERSION: 'abcdef0123456789', VELA_REPOSITORY_DIRECTORY: repository, VELA_STATIC_DIRECTORY: stage };
        expect(await serverOptionsFromEnvironment(environment)).toMatchObject({ port: 5197, runtime: { mode: 'run', version: 'abcdef0123456789' }, repositoryDirectory: await realpath(repository), staticDirectory: await realpath(stage) });
        await expect(serverOptionsFromEnvironment({ ...environment, VELA_PORT: '5199' })).rejects.toThrow('does not match');
        await expect(serverOptionsFromEnvironment({ ...environment, VELA_RUNTIME_VERSION: 'private-value\ninvalid' })).rejects.toThrow('Invalid managed');
        await expect(serverOptionsFromEnvironment({ ...environment, VELA_REPOSITORY_DIRECTORY: 'relative/path' })).rejects.toThrow('Invalid local runtime path');
        await expect(serverOptionsFromEnvironment({ ...environment, VELA_STATIC_DIRECTORY: join(repository, 'missing') })).rejects.toThrow('directory is unavailable');
        expect(await serverOptionsFromEnvironment({})).toEqual({});
    });
});
