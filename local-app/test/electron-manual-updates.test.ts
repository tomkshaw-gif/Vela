import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import type { DesktopBridge, DesktopUpdateState } from '../client/desktop-bridge';

const require = createRequire(import.meta.url);
const { UPDATE_CHANNELS, createUpdateController } = require('../electron/updates.cjs');
const { createQuitLifecycle } = require('../electron/lifecycle.cjs');
const ORIGIN = 'http://127.0.0.1:5196';
const cleanups: (() => void)[] = [];
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const state = (status: DesktopUpdateState['status'] = 'idle'): DesktopUpdateState => ({ status, currentVersion: '1.3.2' });

function fixture() {
    let destroyed = false;
    const frame = { url: ORIGIN + '/' };
    const contents = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => destroyed, getURL: () => frame.url, send: vi.fn() });
    const window = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed, webContents: contents });
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipcMain = { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        if (handlers.has(channel)) throw new Error('Duplicate handler'); handlers.set(channel, fn);
    }, removeHandler: (channel: string) => handlers.delete(channel) };
    const app = Object.assign(new EventEmitter(), { getVersion: () => '1.3.2', quit: vi.fn() });
    const prepare = vi.fn(async () => {}); const stop = vi.fn(async () => {}); const onError = vi.fn();
    const lifecycle = createQuitLifecycle({ app, window, prepare, stop, onError });
    const updater = { check: vi.fn<() => Promise<unknown>>(async () => null), install: vi.fn(async () => {}), dispose: vi.fn() };
    let hooks!: { onDownloaded: (version?: string) => void; onStatus: (status: string, version?: string) => void };
    const controller = createUpdateController({ app, window, ipcMain, origin: ORIGIN, lifecycle, createUpdater: (value: typeof hooks) => { hooks = value; return updater; } });
    const event = { sender: contents, senderFrame: frame };
    const invoke = (channel: string, input = event, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!(input, ...args));
    cleanups.push(() => { controller.dispose(); lifecycle.dispose(); });
    return { app, controller, contents, window, frame, handlers, event, invoke, prepare, stop, onError, updater, hooks,
        destroy() { destroyed = true; contents.emit('destroyed'); Object.defineProperty(window, 'webContents', { get: () => { throw new Error('Destroyed'); } }); } };
}

function preload() {
    const ipc = Object.assign(new EventEmitter(), { invoke: vi.fn<(channel: string) => Promise<unknown>>(async () => state()), send: vi.fn() });
    let api!: DesktopBridge;
    runInNewContext(readFileSync(resolve('local-app/electron/preload.cjs'), 'utf8'), {
        process: { isMainFrame: true }, require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name: string, value: DesktopBridge) => { api = value; } } }),
    });
    return { ipc, api };
}

afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe('authenticated manual desktop updates', () => {
    it('publishes only state on download and starts the save/stop/install barrier only from a trusted explicit request', async () => {
        const f = fixture(); f.hooks.onDownloaded('1.3.3'); await settle();
        expect(f.controller.getState()).toEqual({ ...state('ready'), version: '1.3.3' });
        expect(f.prepare).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
        expect(f.app.quit).not.toHaveBeenCalled(); expect(f.updater.install).not.toHaveBeenCalled();
        expect(await f.invoke(UPDATE_CHANNELS.install)).toBe(true);
        expect(f.prepare).toHaveBeenCalledExactlyOnceWith('update'); expect(f.stop).toHaveBeenCalledOnce(); expect(f.updater.install).toHaveBeenCalledOnce();
    });
    it('never installs a cached update on an ordinary quit', async () => {
        const f = fixture(); f.hooks.onDownloaded('1.3.3');
        const event = { preventDefault: vi.fn() }; f.app.emit('before-quit', event); await settle();
        expect(f.prepare).toHaveBeenCalledExactlyOnceWith('quit'); expect(f.stop).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(f.app.quit).toHaveBeenCalledOnce()); expect(f.updater.install).not.toHaveBeenCalled();
    });
    it('coalesces native-menu and renderer clicks and refuses installation without a download', async () => {
        const f = fixture(); expect(await f.invoke(UPDATE_CHANNELS.install)).toBe(false); expect(f.prepare).not.toHaveBeenCalled();
        f.hooks.onDownloaded('1.3.3');
        const first = f.controller.install(); expect(f.controller.install()).toBe(first);
        const second = f.invoke(UPDATE_CHANNELS.install); await expect(first).resolves.toBe(true); await expect(second).resolves.toBe(true);
        await f.controller.install(); expect(f.updater.install).toHaveBeenCalledOnce(); expect(f.prepare).toHaveBeenCalledOnce();
    });
    it('keeps a failed save open and ready for another explicit install', async () => {
        const f = fixture(); f.hooks.onDownloaded('1.3.3'); f.prepare.mockRejectedValueOnce(new Error('Private save diagnostic'));
        expect(await f.invoke(UPDATE_CHANNELS.install)).toBe(false); expect(f.controller.getState().status).toBe('ready');
        expect(f.stop).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled(); expect(f.updater.install).not.toHaveBeenCalled();
        expect(await f.invoke(UPDATE_CHANNELS.install)).toBe(true); expect(f.prepare).toHaveBeenCalledTimes(2);
    });
    it('retries an installer failure without another save or backend stop', async () => {
        const f = fixture(); f.hooks.onDownloaded('1.3.3'); f.updater.install.mockRejectedValueOnce(new Error('Private installer diagnostic'));
        expect(await f.invoke(UPDATE_CHANNELS.install)).toBe(false); expect(f.controller.getState().status).toBe('ready');
        expect(f.app.quit).not.toHaveBeenCalled(); expect(await f.invoke(UPDATE_CHANNELS.install)).toBe(true);
        expect(f.prepare).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalledOnce(); expect(f.updater.install).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(f.contents.send.mock.calls)).not.toContain('Private');
    });
    it('keeps cached readiness and its version through later check events and a failed check', async () => {
        const f = fixture(); f.hooks.onDownloaded('1.3.3');
        for (const status of ['checking', 'downloading', 'current', 'unavailable']) { f.hooks.onStatus(status, '9.9.9'); expect(f.controller.getState()).toEqual({ ...state('ready'), version: '1.3.3' }); }
        f.updater.check.mockRejectedValueOnce(new Error('Private feed URL'));
        await expect(f.invoke(UPDATE_CHANNELS.check)).rejects.toThrow('The update check could not finish. Try again.');
        expect(f.controller.getState().status).toBe('ready'); expect(await f.invoke(UPDATE_CHANNELS.install)).toBe(true);
    });
    it('coalesces checks and exposes sanitized check errors and state', async () => {
        const f = fixture(); f.updater.check.mockRejectedValueOnce(new Error('Private feed URL'));
        const first = f.controller.check(); expect(f.controller.check()).toBe(first);
        await expect(first).rejects.toThrow('The update check could not finish. Try again.');
        expect(f.controller.getState().status).toBe('error'); await f.controller.check(); expect(f.controller.getState().status).toBe('current');
        f.hooks.onStatus('downloading', 'Private feed URL'); expect(f.controller.getState().version).toBeUndefined();
        expect(JSON.stringify(await f.invoke(UPDATE_CHANNELS.state))).not.toContain('Private');
    });
    it('keeps installing authoritative when an earlier check fails during the save barrier', async () => {
        const f = fixture(); let fail!: (error: Error) => void; let save!: () => void;
        f.updater.check.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
        f.prepare.mockImplementationOnce(() => new Promise(resolve => { save = resolve; }));
        const check = f.controller.check(); const rejected = expect(check).rejects.toThrow('update check'); await settle();
        f.hooks.onDownloaded('1.3.3'); const install = f.controller.install(); await settle();
        fail(new Error('Private check error')); await rejected; expect(f.controller.getState().status).toBe('installing');
        expect(f.updater.install).not.toHaveBeenCalled(); save(); expect(await install).toBe(true);
    });
    it.each(['other-window', 'subframe', 'foreign-origin', 'credentials', 'wrong-path', 'extra-arguments'])('denies %s on every update IPC method', async kind => {
        const f = fixture(); f.hooks.onDownloaded('1.3.3');
        const event = { ...f.event };
        if (kind === 'other-window') event.sender = {} as typeof event.sender;
        if (kind === 'subframe') event.senderFrame = { url: ORIGIN + '/' };
        if (kind === 'foreign-origin') f.frame.url = 'https://example.invalid/';
        if (kind === 'credentials') f.frame.url = 'http://user@127.0.0.1:5196/';
        if (kind === 'wrong-path') f.frame.url = ORIGIN + '/untrusted.html';
        for (const channel of [UPDATE_CHANNELS.state, UPDATE_CHANNELS.check, UPDATE_CHANNELS.install]) {
            await expect(f.invoke(channel, event, ...(kind === 'extra-arguments' ? ['ignored'] : []))).rejects.toThrow('The desktop update request is unavailable.');
        }
        expect(f.prepare).not.toHaveBeenCalled(); expect(f.updater.check).not.toHaveBeenCalled(); expect(f.updater.install).not.toHaveBeenCalled();
    });
    it('removes only its IPC handlers and tolerates queued callbacks after destruction', async () => {
        const f = fixture(); const unrelated = vi.fn(); f.contents.on('destroyed', unrelated);
        const captured = [...f.handlers.values()]; f.destroy();
        expect(f.handlers.size).toBe(0); expect(f.updater.dispose).toHaveBeenCalledOnce();
        f.contents.send.mockClear(); expect(() => { f.hooks.onDownloaded('1.3.3'); f.hooks.onStatus('unavailable'); f.controller.dispose(); }).not.toThrow();
        expect(f.contents.send).not.toHaveBeenCalled(); expect(f.contents.listeners('destroyed')).toEqual([unrelated]);
        for (const handler of captured) expect(() => handler(f.event)).toThrow('unavailable');
        expect(await f.controller.install()).toBe(false);
    });
    it('cancels a queued explicit action when the window is destroyed before the barrier starts', async () => {
        const f = fixture(); f.hooks.onDownloaded('1.3.3'); const install = f.controller.install(); f.destroy();
        expect(await install).toBe(false); expect(f.prepare).not.toHaveBeenCalled(); expect(f.updater.install).not.toHaveBeenCalled();
    });
});

describe('sandboxed update subscription protocol', () => {
    it('delivers initial sanitized state and strips IPC events and unknown fields', async () => {
        const f = preload(); f.ipc.invoke.mockResolvedValue({ ...state('ready'), version: '1.3.3', private: 'not exposed' });
        const observer = vi.fn(); const off = f.api.onUpdateState(observer); await settle();
        expect(observer).toHaveBeenCalledExactlyOnceWith({ ...state('ready'), version: '1.3.3' });
        f.ipc.emit(UPDATE_CHANNELS.changed, { private: 'event' }, { ...state('current'), private: 'diagnostic' });
        expect(observer).toHaveBeenLastCalledWith(state('current')); off(); off(); expect(f.ipc.listenerCount(UPDATE_CHANNELS.changed)).toBe(0);
    });
    it('rejects stale initial responses after a newer notification and cleans up independent subscriptions', async () => {
        const f = preload(); let finish!: (value: unknown) => void;
        f.ipc.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const observer = vi.fn(); const off = f.api.onUpdateState(observer); await settle();
        f.ipc.emit(UPDATE_CHANNELS.changed, {}, state('ready')); finish(state('idle')); await settle();
        expect(observer).toHaveBeenCalledExactlyOnceWith(state('ready'));
        const second = vi.fn(); const off2 = f.api.onUpdateState(second); await settle();
        expect(f.ipc.listenerCount(UPDATE_CHANNELS.changed)).toBe(1); off(); finish(state('current')); await settle();
        expect(second).toHaveBeenCalledExactlyOnceWith(state('current')); off2(); expect(f.ipc.listenerCount(UPDATE_CHANNELS.changed)).toBe(0);
    });
    it('ignores late initial responses after unsubscribe and handles invoke rejection without raw errors', async () => {
        const f = preload(); f.ipc.invoke.mockRejectedValue(new Error('Private IPC diagnostic'));
        const observer = vi.fn(); const off = f.api.onUpdateState(observer); off(); await settle(); expect(observer).not.toHaveBeenCalled();
        const off2 = f.api.onUpdateState(observer); await settle(); expect(observer).toHaveBeenCalledExactlyOnceWith({ status: 'error', currentVersion: 'unknown' }); off2();
        await expect(f.api.getUpdateState()).rejects.toThrow('The desktop update request could not finish. Try again.');
        await expect(f.api.checkForUpdates()).rejects.toThrow('The desktop update request could not finish. Try again.');
        expect(await f.api.installUpdate()).toBe(false);
    });
    it('isolates throwing observers, rejects malformed snapshots, and validates install results', async () => {
        const f = preload(); const off1 = f.api.onUpdateState(() => { throw new Error('Private callback'); }); const observer = vi.fn(); const off2 = f.api.onUpdateState(observer); await settle();
        f.ipc.emit(UPDATE_CHANNELS.changed, {}, { ...state(), status: 'private' }); expect(observer).toHaveBeenCalledOnce();
        f.ipc.emit(UPDATE_CHANNELS.changed, {}, state('ready')); expect(observer).toHaveBeenLastCalledWith(state('ready'));
        f.ipc.invoke.mockResolvedValue({ ...state(), currentVersion: 'Private IPC diagnostic' }); await expect(f.api.getUpdateState()).rejects.toThrow('The update state is unavailable.');
        f.ipc.invoke.mockResolvedValue('truthy'); expect(await f.api.installUpdate()).toBe(false);
        f.ipc.invoke.mockResolvedValue(true); expect(await f.api.installUpdate()).toBe(true); off1(); off2();
    });
});

describe('real Electron manual update IPC', () => {
    const executable = resolve('node_modules/electron/dist/electron.exe');
    it.skipIf(process.platform !== 'win32' || !existsSync(executable))('uses the real sandbox preload and explicit renderer click with an isolated profile and inert installer', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'vela-manual-update-'));
        cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
        const entry = join(directory, 'main.cjs');
        const source = `const { app, BrowserWindow, ipcMain } = require('electron');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { createPrepareController, createQuitLifecycle } = require(${JSON.stringify(resolve('local-app/electron/lifecycle.cjs'))});
const { createUpdateController } = require(${JSON.stringify(resolve('local-app/electron/updates.cjs'))});
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
app.setPath('sessionData', ${JSON.stringify(join(directory, 'profile'))});
const counts = { save: 0, stop: 0, install: 0, quit: 0, error: 0 }; const order = [];
const quit = app.quit.bind(app); app.quit = () => { counts.quit++; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async test => { for (let i = 0; i < 150; i++) { if (await test()) return; await sleep(20); } throw new Error('Owned probe timed out'); };
let server; let win; let updates; let prepare; let lifecycle;
app.whenReady().then(async () => {
    server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><button id="install">Install update</button>'); });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const origin = 'http://127.0.0.1:' + server.address().port;
    assert.notEqual(server.address().port, 5196);
    win = new BrowserWindow({ show: false, webPreferences: { preload: ${JSON.stringify(resolve('local-app/electron/preload.cjs'))}, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    prepare = createPrepareController({ window: win, ipcMain, origin, timeoutMs: 3000 });
    lifecycle = createQuitLifecycle({ app, window: win, prepare: reason => { counts.save++; order.push('save'); return prepare.prepareForQuit(reason); }, canStop: () => prepare.isPrepared(), stop: async () => { counts.stop++; order.push('stop'); }, onError: () => { counts.error++; } });
    let hooks;
    updates = createUpdateController({ app: { getVersion: () => '1.3.2' }, window: win, ipcMain, origin, lifecycle, createUpdater: value => { hooks = value; return { check: async () => {}, install: async () => { counts.install++; order.push('install'); if (counts.install === 1) throw new Error('Inert installer first failure'); }, dispose() {} }; } });
    await win.loadURL(origin);
    await win.webContents.executeJavaScript(\`window.states = []; window.results = []; window.velaDesktop.onUpdateState(state => window.states.push(state)); window.velaDesktop.onPrepare(request => { window.velaDesktop.prepared(request.requestId); }); document.querySelector('button').onclick = () => { window.velaDesktop.installUpdate().then(result => window.results.push(result)); }; void 0;\`);
    await until(() => win.webContents.executeJavaScript('window.states.length > 0'));
    await sleep(30); hooks.onDownloaded('1.3.3'); await until(() => win.webContents.executeJavaScript('window.states.at(-1).status === "ready"'));
    assert.deepEqual(counts, { save: 0, stop: 0, install: 0, quit: 0, error: 0 });
    await win.webContents.executeJavaScript('document.querySelector("button").click()');
    await until(() => win.webContents.executeJavaScript('window.results.length === 1'));
    assert.equal(await win.webContents.executeJavaScript('window.results[0]'), false);
    assert.equal(updates.getState().status, 'ready'); assert.deepEqual(order, ['save', 'stop', 'install']);
    await win.webContents.executeJavaScript('document.querySelector("button").click()');
    await until(() => win.webContents.executeJavaScript('window.results.length === 2'));
    assert.equal(await win.webContents.executeJavaScript('window.results[1]'), true);
    assert.deepEqual(counts, { save: 1, stop: 1, install: 2, quit: 0, error: 1 });
    assert.deepEqual(order, ['save', 'stop', 'install', 'install']);
    console.log('VELA_MANUAL_UPDATE_PROBE=' + JSON.stringify({ counts, order, sandbox: true, origin: 'isolated-loopback', states: await win.webContents.executeJavaScript('window.states.map(state => state.status)') }));
    updates.dispose(); prepare.dispose(); lifecycle.dispose(); win.destroy(); server.close(); app.quit = quit; app.exit(0);
}).catch(error => { console.error('Owned manual update probe failed:', error.stack); updates?.dispose(); prepare?.dispose(); lifecycle?.dispose(); if (win && !win.isDestroyed()) win.destroy(); server?.close(); app.exit(1); });
`;
        writeFileSync(entry, source);
        const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH;
        const stdout = await new Promise<string>((done, fail) => {
            const child = spawn(executable, [entry], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let output = ''; let stderr = '';
            const timer = setTimeout(() => { child.kill(); fail(new Error('Owned manual update probe timed out')); }, 20_000);
            child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { stderr += value; });
            child.once('error', error => { clearTimeout(timer); fail(error); });
            child.once('exit', code => { clearTimeout(timer); if (code === 0) done(output); else fail(new Error(`Owned manual update probe failed (${code}): ${stderr.slice(-1500)}`)); });
        });
        const line = stdout.split(/\r?\n/).find(value => value.startsWith('VELA_MANUAL_UPDATE_PROBE=')); expect(line).toBeDefined();
        const result = JSON.parse(line!.slice('VELA_MANUAL_UPDATE_PROBE='.length));
        expect(result.counts).toEqual({ save: 1, stop: 1, install: 2, quit: 0, error: 1 });
        expect(result.order).toEqual(['save', 'stop', 'install', 'install']);
        expect(result.states).toContain('ready'); expect(result.states).toContain('installing'); expect(result.sandbox).toBe(true);
    }, 25_000);
});
