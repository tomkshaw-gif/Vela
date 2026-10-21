import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeCoordinator, rememberSession, selectedSession, type RuntimeNotice } from '../client/runtime';
import { LocalApi } from '../client/api';
import type { RuntimeStatus } from '../shared/runtime';

const state = (overrides: Partial<RuntimeStatus> = {}): RuntimeStatus => ({ managed: true, mode: 'run',
    version: 'first', instanceId: 'process-1', repositoryId: 'test', phase: 'ready', updateId: null, message: null, ...overrides });
const settle = async (): Promise<void> => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function fixture(initial = state(), prepare: () => Promise<void> = async () => undefined) {
    let current = initial;
    const api = { get: vi.fn(async (_path: string, _signal?: AbortSignal) => current),
        post: vi.fn(async (_path: string, _body: unknown, _signal?: AbortSignal) => ({})), postKeepalive: vi.fn() };
    const notices: RuntimeNotice[] = [];
    const hooks = { prepare: vi.fn(prepare), reconnect: vi.fn(async () => undefined),
        notice: vi.fn((notice: RuntimeNotice): void => { notices.push(notice); }), reload: vi.fn() };
    const runtime = new RuntimeCoordinator(api as unknown as LocalApi, hooks, 'b1084328-dfb0-41e8-a963-9e4dc7bc4559');
    return { api, hooks, notices, runtime, set: (next: RuntimeStatus) => { current = next; } };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('managed browser update lifecycle', () => {
    it('keeps startup pending and controls blocked until both runtime discovery and lease registration succeed', async () => {
        vi.useFakeTimers();
        const app = fixture();
        app.api.get.mockRejectedValueOnce(new Error('offline'));
        app.api.post.mockRejectedValueOnce(new Error('registration unavailable'));
        let opened = false;
        try {
            const start = app.runtime.start().then(() => { opened = true; });
            await settle();
            expect(opened).toBe(false); expect(app.notices.at(-1)?.blocked).toBe(true);
            await vi.advanceTimersByTimeAsync(1000);
            expect(opened).toBe(false); expect(app.notices.at(-1)?.blocked).toBe(true);
            await vi.advanceTimersByTimeAsync(2000);
            await start;
            expect(opened).toBe(true);
            expect(app.api.post).toHaveBeenCalledTimes(2);
            expect(app.notices.at(-1)?.blocked).toBe(false);
        } finally { app.runtime.dispose(); }
    });
    it('acknowledges only after the complete snapshot save resolves and maintains its lease meanwhile', async () => {
        vi.useFakeTimers();
        let save: () => void = () => undefined;
        const pending = new Promise<void>((resolve) => { save = resolve; });
        const app = fixture(state({ phase: 'preparing', updateId: 'update-1' }), () => pending);
        try {
            app.runtime.start(); await settle();
            expect(app.notices.at(-1)?.blocked).toBe(true);
            expect(app.hooks.prepare).toHaveBeenCalledOnce();
            expect(app.api.post.mock.calls.some((call) => (call[1] as { action: string }).action === 'ready')).toBe(false);
            await vi.advanceTimersByTimeAsync(7000);
            expect(app.api.post.mock.calls.filter((call) => (call[1] as { action: string }).action === 'heartbeat').length).toBeGreaterThanOrEqual(3);
            expect(app.hooks.prepare).toHaveBeenCalledOnce();
            save(); await settle();
            expect(app.api.post).toHaveBeenLastCalledWith('/api/runtime/client', expect.objectContaining({ action: 'ready', updateId: 'update-1' }), expect.any(AbortSignal));
            expect(app.notices.at(-1)?.message).toContain('Workspace saved');
        } finally { app.runtime.dispose(); }
    });

    it('never acknowledges a failed save, and cancellation unlocks controls while playback remains paused', async () => {
        vi.useFakeTimers();
        let paused = false;
        const app = fixture(state({ phase: 'preparing', updateId: 'update-1' }), async () => { throw new Error('private server diagnostic'); });
        app.hooks.notice.mockImplementation((notice) => { if (notice.blocked) paused = true; app.notices.push(notice); });
        try {
            app.runtime.start(); await settle();
            expect(app.notices.at(-1)).toMatchObject({ blocked: true, error: true });
            expect(JSON.stringify(app.notices)).not.toContain('private server diagnostic');
            await vi.advanceTimersByTimeAsync(4000);
            expect(app.hooks.prepare).toHaveBeenCalledOnce();
            expect(app.api.post.mock.calls.some((call) => (call[1] as { action: string }).action === 'ready')).toBe(false);
            app.set(state()); await vi.advanceTimersByTimeAsync(1000);
            expect(app.notices.at(-1)).toMatchObject({ blocked: false });
            expect(app.notices.at(-1)?.message).toContain('cancelled');
            expect(paused).toBe(true);
        } finally { app.runtime.dispose(); }
    });

    it('does not send a stale acknowledgement if cancellation arrives while a save is finishing', async () => {
        vi.useFakeTimers();
        let save: () => void = () => undefined;
        const app = fixture(state({ phase: 'preparing', updateId: 'update-1' }), () => new Promise((resolve) => { save = resolve; }));
        try {
            app.runtime.start(); await settle();
            app.set(state()); await vi.advanceTimersByTimeAsync(1000);
            save(); await settle();
            expect(app.api.post.mock.calls.some((call) => (call[1] as { action: string }).action === 'ready')).toBe(false);
        } finally { app.runtime.dispose(); }
    });

    it('reloads once when the backend instance changes so bootstrap obtains a fresh write token', async () => {
        vi.useFakeTimers();
        const app = fixture();
        try {
            app.runtime.start(); await settle();
            app.set(state({ instanceId: 'process-2', version: 'second' }));
            await vi.advanceTimersByTimeAsync(1000);
            await vi.advanceTimersByTimeAsync(10000);
            expect(app.hooks.reload).toHaveBeenCalledOnce();
            expect(app.hooks.reconnect).toHaveBeenCalledOnce();
            expect(app.notices.at(-1)?.blocked).toBe(true);
            expect(app.api.get).toHaveBeenCalledTimes(2);
        } finally { app.runtime.dispose(); }
    });

    it('retains a suspended window instead of reloading away unsaved charts when reconnect persistence conflicts', async () => {
        vi.useFakeTimers();
        const app = fixture();
        app.hooks.reconnect.mockRejectedValueOnce(new Error('newer session revision'));
        try {
            await app.runtime.start();
            app.set(state({ instanceId: 'process-2' }));
            await vi.advanceTimersByTimeAsync(1000);
            expect(app.hooks.reconnect).toHaveBeenCalledOnce();
            expect(app.hooks.reload).not.toHaveBeenCalled();
            expect(app.notices.at(-1)?.blocked).toBe(true);
            expect(app.notices.at(-1)?.message).toContain('Pending chart changes stay in this window');
            await vi.advanceTimersByTimeAsync(1000);
            expect(app.hooks.reconnect).toHaveBeenCalledTimes(2);
            expect(app.hooks.reload).toHaveBeenCalledOnce();
        } finally { app.runtime.dispose(); }
    });

    it('stops polling, aborts pending requests and releases its lease once on disposal', async () => {
        vi.useFakeTimers();
        const app = fixture();
        app.runtime.start(); await settle();
        app.runtime.dispose(); app.runtime.dispose();
        await vi.advanceTimersByTimeAsync(30000);
        expect(app.api.get).toHaveBeenCalledOnce();
        expect(app.api.postKeepalive).toHaveBeenCalledExactlyOnceWith('/api/runtime/client', expect.objectContaining({ action: 'release' }));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves unmanaged entry points unchanged and does not create runtime leases', async () => {
        vi.useFakeTimers();
        const app = fixture(state({ managed: false }));
        try {
            app.runtime.start(); await settle();
            await vi.advanceTimersByTimeAsync(3000);
            expect(app.hooks.notice).not.toHaveBeenCalled();
            expect(app.api.post).not.toHaveBeenCalled();
        } finally { app.runtime.dispose(); }
        expect(app.api.postKeepalive).not.toHaveBeenCalled();
    });

    it('pauses and blocks writes while a previously managed backend is unavailable, then reconnects', async () => {
        vi.useFakeTimers();
        const app = fixture();
        try {
            app.runtime.start(); await settle();
            app.api.get.mockRejectedValueOnce(new Error('offline'));
            await vi.advanceTimersByTimeAsync(1000);
            expect(app.notices.at(-1)).toMatchObject({ blocked: true });
            await vi.advanceTimersByTimeAsync(1000);
            expect(app.notices.at(-1)).toMatchObject({ blocked: false });
        } finally { app.runtime.dispose(); }
    });
});

describe('local update persistence and lease release', () => {
    it('restores the selected session even when newer sessions change the list order', () => {
        const values = new Map<string, string>();
        const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, item: string) => { values.set(key, item); } };
        rememberSession(storage, 'selected');
        expect(selectedSession(storage, [{ id: 'newest' }, { id: 'selected' }])).toBe('selected');
        expect(selectedSession(storage, [{ id: 'other' }])).toBe('other');
        expect(selectedSession(storage, [])).toBeUndefined();
        expect([...values.values()]).toEqual(['selected']);
    });

    it('uses the in-memory CSRF token and browser keepalive for pagehide release without storage', async () => {
        const fetch = vi.fn(async () => new Response('{}'));
        vi.stubGlobal('fetch', fetch);
        const api = new LocalApi(); api.setToken('test-token');
        api.postKeepalive('/api/runtime/client', { clientId: 'browser', action: 'release' });
        await settle();
        expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/runtime/client', expect.objectContaining({ keepalive: true,
            credentials: 'same-origin', headers: expect.objectContaining({ 'X-Local-Token': 'test-token' }) }));
    });
});
