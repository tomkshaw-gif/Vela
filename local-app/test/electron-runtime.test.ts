import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { CHANNELS, createPrepareController, createQuitLifecycle, isTrustedPage } = require('../electron/lifecycle.cjs');
const { configureProfile, startBackend, runtimeDirectory, secureWindow, runDesktop } = require('../electron/main.cjs');
const { UPDATE_CHANNELS } = require('../electron/updates.cjs');
const ORIGIN = 'http://127.0.0.1:5196';
const ID = '11111111-1111-4111-8111-111111111111';
const directories: string[] = [];
const disposers: (() => void)[] = [];

function temporary() { const directory = mkdtempSync(join(tmpdir(), 'vela-electron-test-')); directories.push(directory); return directory; }
function deferred() {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function fixture() {
    const frame = { url: ORIGIN + '/' };
    const contents = Object.assign(new EventEmitter(), { mainFrame: frame, getURL: () => frame.url,
        isDestroyed: () => false, send: vi.fn(), setWindowOpenHandler: vi.fn(),
        session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } });
    const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
    const handlers = new Map();
    const ipcMain = Object.assign(new EventEmitter(), { handle: (channel: string, handler: unknown) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) });
    const event = { sender: contents, senderFrame: frame };
    return { window, contents, ipcMain, event, frame };
}
function controller() {
    const f = fixture();
    const value = createPrepareController({ ...f, origin: ORIGIN, timeoutMs: 100, requestId: () => ID });
    disposers.push(() => value.dispose()); return { ...f, value };
}
function lifecycle(extra = {}) {
    const f = fixture(); const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
    const prepare = vi.fn(async () => {}); const stop = vi.fn(async () => {}); const onError = vi.fn();
    const value = createQuitLifecycle({ app, window: f.window, prepare, stop, onError, ...extra });
    disposers.push(() => value.dispose()); return { ...f, app, prepare, stop, onError, value };
}
function utility() {
    const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
    const fork = vi.fn(() => child);
    const backend = startBackend({ utilityProcess: { fork }, directory: resolve('local-app/electron/staging/app-runtime'),
        repositoryDirectory: resolve('.'), version: '1.0.0', timeoutMs: 100 });
    const ready = () => child.emit('message', { type: 'backend:ready', url: ORIGIN, node: '24.22.0', sqlite: true });
    return { child, fork, backend, ready };
}

async function desktop(loadFails = false, updaterFails = false) {
    const f = fixture(); const root = temporary();
    const window = Object.assign(f.window, { show: vi.fn(), focus: vi.fn(), restore: vi.fn(), isMinimized: () => false,
        destroy: vi.fn(), loadURL: vi.fn(async () => { if (loadFails) throw new Error('Load failed.'); }) });
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), postMessage: vi.fn(() => { if (loadFails) queueMicrotask(() => child.emit('exit', 0)); }) });
    const app = Object.assign(new EventEmitter(), { quit: vi.fn(), setPath: vi.fn(), isPackaged: false,
        requestSingleInstanceLock: () => true, whenReady: async () => {}, getVersion: () => '1.0.0', getAppPath: () => join(root, 'app') });
    const BrowserWindow = vi.fn(function () { return window; });
    const dialog = { showMessageBox: vi.fn(async () => ({})), showErrorBox: vi.fn() };
    const updater = { check: vi.fn(async () => null), install: vi.fn(), dispose: vi.fn() };
    const createUpdater = vi.fn((_hooks: { onDownloaded: (version?: string) => void }) => { if (updaterFails) throw new Error('Missing updater.'); return updater; });
    const Menu = { buildFromTemplate: vi.fn((template: { label?: string; submenu?: { label?: string; click?: () => void }[] }[]) => template), setApplicationMenu: vi.fn() };
    const result = await runDesktop({ app, BrowserWindow, utilityProcess: { fork: () => {
        queueMicrotask(() => child.emit('message', { type: 'backend:ready', url: ORIGIN, node: '24.22.0', sqlite: true })); return child;
    } }, ipcMain: f.ipcMain, dialog, Menu }, { createUpdater, environment: { VELA_DATA_DIR: root } });
    disposers.push(() => app.emit('will-quit'));
    f.contents.send.mockClear();
    return { ...f, window, app, root, BrowserWindow, child, dialog, updater, createUpdater, Menu, result };
}

afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    vi.useRealTimers();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('desktop save IPC', () => {
    it('waits for the exact main-frame acknowledgement and rejects other frames, windows, origins, and request IDs', async () => {
        const f = controller(); const saved = vi.fn(); const preparation = f.value.prepareForQuit('update').then(saved);
        expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(CHANNELS.prepare, { requestId: ID, reason: 'update' });
        const ack = { requestId: ID };
        f.ipcMain.emit(CHANNELS.prepared, { ...f.event, senderFrame: { url: ORIGIN + '/' } }, ack);
        f.ipcMain.emit(CHANNELS.prepared, { ...f.event, sender: {} }, ack);
        f.ipcMain.emit(CHANNELS.prepared, f.event, { requestId: 'old-request' });
        f.frame.url = 'https://example.invalid/'; f.ipcMain.emit(CHANNELS.prepared, f.event, ack);
        f.frame.url = ORIGIN + '/'; await Promise.resolve(); expect(saved).not.toHaveBeenCalled();
        f.ipcMain.emit(CHANNELS.prepared, f.event, ack); await preparation;
        expect(saved).toHaveBeenCalledOnce(); expect(f.value.isPrepared()).toBe(true);
    });
    it('blocks quit on failed saving and permits a fresh successful attempt', async () => {
        const f = controller(); const failed = f.value.prepareForQuit();
        expect(f.value.prepareForQuit()).toBe(failed);
        f.ipcMain.emit(CHANNELS.prepared, f.event, { requestId: ID, error: 'disk is full' });
        await expect(failed).rejects.toThrow('could not be saved'); expect(f.value.isPrepared()).toBe(false);
        const retry = f.value.prepareForQuit();
        f.ipcMain.emit(CHANNELS.prepared, f.event, { requestId: ID }); await retry;
        expect(f.value.isPrepared()).toBe(true);
    });
    it('fails closed on missing callback, a crash, or navigation, and revokes an old success', async () => {
        vi.useFakeTimers(); const f = controller();
        const missing = expect(f.value.prepareForQuit()).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(100); await missing;
        const crash = expect(f.value.prepareForQuit()).rejects.toThrow('unavailable');
        f.contents.emit('render-process-gone'); await crash;
        const navigated = expect(f.value.prepareForQuit()).rejects.toThrow('unavailable');
        f.contents.emit('did-start-navigation', {}, ORIGIN, false, true); await navigated;
        const saved = f.value.prepareForQuit(); f.ipcMain.emit(CHANNELS.prepared, f.event, { requestId: ID }); await saved;
        f.contents.emit('render-process-gone'); expect(f.value.isPrepared()).toBe(false);
    });
    it('limits page trust to the fixed application origin and document', () => {
        for (const url of [ORIGIN + '/', ORIGIN + '/#sessions', ORIGIN + '/index.html']) expect(isTrustedPage(url, ORIGIN)).toBe(true);
        for (const url of ['https://127.0.0.1:5196/', 'http://127.0.0.1:5197/', ORIGIN + '.invalid/', ORIGIN + '/assets/untrusted.html', 'file:///index.html', 'http://user@127.0.0.1:5196/']) expect(isTrustedPage(url, ORIGIN)).toBe(false);
    });
    it('disposes after a destroyed BrowserWindow without reading its throwing webContents getter', async () => {
        const f = controller(); const preparation = expect(f.value.prepareForQuit()).rejects.toThrow('unavailable');
        Object.defineProperty(f.window, 'webContents', { get: () => { throw new TypeError('Object has been destroyed'); } });
        expect(() => f.value.dispose()).not.toThrow(); await preparation;
        expect(f.contents.listenerCount('destroyed')).toBe(0); expect(f.ipcMain.listenerCount(CHANNELS.prepared)).toBe(0);
        expect(() => f.value.dispose()).not.toThrow();
    });
});

describe('quit and updater barrier', () => {
    it('orders durable renderer saving, backend exit, then installation, coalescing simultaneous native close', async () => {
        const saved = deferred(); const stopped = deferred(); const install = vi.fn();
        const stop = vi.fn(() => stopped.promise);
        const f = lifecycle({ prepare: vi.fn(() => saved.promise), stop });
        const closing = f.value.close({ install });
        const event = { preventDefault: vi.fn() }; f.window.emit('close', event); f.app.emit('before-quit', event);
        expect(event.preventDefault).toHaveBeenCalledTimes(2); expect(install).not.toHaveBeenCalled();
        saved.resolve(); await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
        expect(install).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
        stopped.resolve(); expect(await closing).toBe(true); expect(install).toHaveBeenCalledOnce();
        const accepted = { preventDefault: vi.fn() }; f.app.emit('before-quit', accepted); expect(accepted.preventDefault).not.toHaveBeenCalled();
    });
    it('keeps the backend/window open after failed saving, with no installation, and can retry', async () => {
        const prepare = vi.fn().mockRejectedValueOnce(new Error('save failed')).mockResolvedValue(undefined);
        const f = lifecycle({ prepare }); const install = vi.fn();
        expect(await f.value.close({ install })).toBe(false); expect(f.stop).not.toHaveBeenCalled();
        expect(install).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled(); expect(f.onError).toHaveBeenCalledOnce();
        expect(await f.value.requestQuit()).toBe(true); expect(f.stop).toHaveBeenCalledOnce(); expect(f.app.quit).toHaveBeenCalledOnce();
    });
    it('refuses direct shutdown, a revoked ACK, or a failed backend close', async () => {
        let safe = true; const stop = vi.fn().mockRejectedValue(new Error('close failed')); const f = lifecycle({ canStop: () => safe, stop });
        await expect(f.value.shutdown()).rejects.toThrow('Save the workspace');
        await f.value.prepareForQuit(); safe = false;
        await expect(f.value.shutdown()).rejects.toThrow('Save the workspace'); safe = true;
        const install = vi.fn(); expect(await f.value.close({ install })).toBe(false);
        expect(install).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
    });
    it('can upgrade a pending native quit to the downloaded installation without racing two finish actions', async () => {
        const saved = deferred(); const f = lifecycle({ prepare: () => saved.promise }); const install = vi.fn();
        const closing = f.value.requestQuit(); expect(f.value.close({ install })).toBe(closing);
        saved.resolve(); await closing; expect(install).toHaveBeenCalledOnce(); expect(f.app.quit).not.toHaveBeenCalled();
        await f.value.close({ install }); expect(install).toHaveBeenCalledOnce();
    });
    it.each(['throws', 'returns false'])('permits safe quit or installer retry after the installer %s with an already-saved stopped backend', async kind => {
        const f = lifecycle(); const install = vi.fn(() => { if (kind === 'throws') throw new Error('failed'); return false; });
        expect(await f.value.close({ install })).toBe(false); expect(f.value.isStopped()).toBe(true);
        expect(f.app.quit).not.toHaveBeenCalled(); const retry = vi.fn(); expect(await f.value.close({ install: retry })).toBe(true);
        expect(retry).toHaveBeenCalledOnce(); expect(f.prepare).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalledOnce();
    });
});

describe('Electron utility supervision and window policy', () => {
    it('forks the bundled backend with clean Node flags and waits for actual process exit before shutdown completes', async () => {
        const f = utility(); f.ready(); await expect(f.backend.started).resolves.toEqual({ url: ORIGIN, node: '24.22.0' });
        const [file, args, options] = f.fork.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; stdio: string }];
        expect(file).toMatch(/app-runtime[\\/]backend.mjs$/); expect(args[1]).toBe('1.0.0');
        expect(options.env.NODE_OPTIONS).toBeUndefined(); expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined(); expect(options.stdio).toBe('ignore');
        const complete = vi.fn(); const stopping = f.backend.shutdown().then(complete);
        expect(f.child.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'backend:shutdown' });
        f.child.emit('message', { type: 'backend:stopped' }); await Promise.resolve(); expect(complete).not.toHaveBeenCalled();
        f.child.emit('exit', 0); await stopping; expect(complete).toHaveBeenCalledOnce(); expect(f.child.kill).not.toHaveBeenCalled();
    });
    it.each([ORIGIN.replace('5196', '5197'), 'https://example.invalid/', 'http://127.0.0.1:57321'])('rejects backend origin %s instead of silently switching origin', async url => {
        const f = utility(); const started = expect(f.backend.started).rejects.toThrow('invalid address');
        f.child.emit('message', { type: 'backend:ready', url, node: '24.22.0', sqlite: true }); await started; expect(f.child.kill).toHaveBeenCalledOnce();
    });
    it('retains the process on shutdown timeout and refuses abnormal exit', async () => {
        vi.useFakeTimers(); const f = utility(); f.ready(); await f.backend.started;
        const timeout = expect(f.backend.shutdown()).rejects.toThrow('still closing'); await vi.advanceTimersByTimeAsync(100); await timeout;
        expect(f.child.kill).not.toHaveBeenCalled(); f.child.emit('exit', 1);
        const other = utility(); other.ready(); await other.backend.started;
        const failed = expect(other.backend.shutdown()).rejects.toThrow('clean shutdown'); other.child.emit('exit', 1); await failed;
    });
    it('fails startup when the backend exits or does not respond', async () => {
        vi.useFakeTimers(); const first = utility(); const exited = expect(first.backend.started).rejects.toThrow('before it was ready'); first.child.emit('exit', 1); await exited;
        const next = utility(); const missing = expect(next.backend.started).rejects.toThrow('did not start'); await vi.advanceTimersByTimeAsync(100); await missing;
        expect(next.child.kill).toHaveBeenCalledOnce();
    });
    it('denies popup windows, webviews, permissions, and untrusted navigation', () => {
        const f = fixture(); secureWindow(f.window, ORIGIN);
        expect(f.contents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' });
        const denied = { preventDefault: vi.fn() }; f.contents.emit('will-navigate', denied, 'https://example.invalid/');
        f.contents.emit('will-redirect', denied, 'http://127.0.0.1:5197/'); f.contents.emit('will-attach-webview', denied);
        expect(denied.preventDefault).toHaveBeenCalledTimes(3);
        const allow = vi.fn(); f.contents.session.setPermissionRequestHandler.mock.calls[0]![0](f.contents, 'camera', allow); expect(allow).toHaveBeenCalledWith(false);
        expect(f.contents.session.setPermissionCheckHandler.mock.calls[0]![0]()).toBe(false);
    });
    it('resolves packaged and staged runtime files without relying on the current directory', () => {
        const root = temporary(); const appPath = join(root, 'app'); mkdirSync(join(root, 'app-runtime'));
        writeFileSync(join(root, 'app-runtime/server.mjs'), '');
        expect(runtimeDirectory({ isPackaged: true }, root)).toBe(join(root, 'app-runtime'));
        expect(runtimeDirectory({ isPackaged: false, getAppPath: () => appPath }, root)).toBe(join(root, 'app-runtime'));
        expect(runtimeDirectory({ isPackaged: false, getAppPath: () => join(root, 'missing/app') }, root, root)).toBe(join(root, 'staging/app-runtime'));
    });
    it('pins browser state to the existing data root, including test/developer overrides', () => {
        const root = temporary(); const app = { setPath: vi.fn() };
        const profile = configureProfile(app, { LOCALAPPDATA: root }, 'win32');
        expect(profile).toBe(join(root, 'VelaReplayStudio/desktop-profile')); expect(existsSync(profile)).toBe(true);
        expect(app.setPath.mock.calls).toEqual([['userData', profile], ['sessionData', profile]]);
        app.setPath.mockClear(); const overridden = configureProfile(app, { LOCALAPPDATA: 'unused', VELA_DATA_DIR: root }, 'win32');
        expect(overridden).toBe(join(root, 'desktop-profile')); expect(app.setPath).toHaveBeenCalledWith('userData', overridden);
    });
    it('exits a second instance before starting a backend or opening a renderer', async () => {
        const app = { setPath: vi.fn(), requestSingleInstanceLock: () => false, quit: vi.fn(), whenReady: vi.fn() };
        await runDesktop({ app }, { environment: { VELA_DATA_DIR: temporary() } }); expect(app.quit).toHaveBeenCalledOnce(); expect(app.whenReady).not.toHaveBeenCalled();
    });
});

describe('sandboxed preload contract', () => {
    function preload(mainFrame = true) {
        const ipc = Object.assign(new EventEmitter(), { send: vi.fn(), invoke: vi.fn() }); let exposed: { onPrepare: (cb: (value: { requestId: string; reason: string }) => void) => () => void; prepared: (requestId: string, error?: string) => void } | undefined;
        runInNewContext(readFileSync(resolve('local-app/electron/preload.cjs'), 'utf8'), {
            require: (name: string) => { expect(name).toBe('electron'); return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (name: string, api: typeof exposed) => { expect(name).toBe('velaDesktop'); exposed = api; } } }; },
            process: { isMainFrame: mainFrame },
        });
        return { ipc, api: exposed! };
    }
    it('exposes only typed save operations, queues early requests, and never exposes IPC events or raw errors', () => {
        const { ipc, api } = preload(); expect(Object.keys(api).sort()).toEqual(['checkForUpdates', 'getUpdateState', 'installUpdate', 'onPrepare', 'onUpdateState', 'prepared']);
        ipc.emit(CHANNELS.prepare, { secret: 'not exposed' }, { requestId: ID, reason: 'update' });
        const callback = vi.fn(); const off = api.onPrepare(callback); expect(callback).toHaveBeenCalledExactlyOnceWith({ requestId: ID, reason: 'update' });
        api.prepared('stale'); expect(ipc.send).not.toHaveBeenCalled();
        api.prepared(ID, 'private detail'); expect(ipc.send).toHaveBeenCalledExactlyOnceWith(CHANNELS.prepared, { requestId: ID, error: 'The workspace could not be saved.' });
        off(); ipc.emit(CHANNELS.prepare, {}, { requestId: ID, reason: 'quit' }); expect(callback).toHaveBeenCalledOnce();
        api.onPrepare(value => api.prepared(value.requestId)); expect(ipc.send).toHaveBeenLastCalledWith(CHANNELS.prepared, { requestId: ID });
    });
    it('does not expose a subframe bridge or acknowledge an absent callback', () => {
        const child = preload(false); expect(child.api).toBeUndefined();
        const { ipc, api } = preload(); ipc.emit(CHANNELS.prepare, {}, { requestId: ID, reason: 'quit' });
        expect(ipc.send).not.toHaveBeenCalled(); api.onPrepare(() => { throw new Error('failed'); });
        expect(ipc.send).toHaveBeenCalledWith(CHANNELS.prepared, { requestId: ID, error: 'The workspace could not be saved.' });
    });
});

describe('desktop entry integration', () => {
    it('starts under Electron even when its bootstrap owns require.main', async () => {
        const root = temporary(); const app = { setPath: vi.fn(), requestSingleInstanceLock: () => false, quit: vi.fn() };
        const nativeRequire = (name: string) => name === 'electron' ? { app } : require(name === './lifecycle.cjs' ? '../electron/lifecycle.cjs' : name);
        Object.assign(nativeRequire, { main: {} });
        runInNewContext(readFileSync(resolve('local-app/electron/main.cjs'), 'utf8'), {
            require: nativeRequire, module: { exports: {} }, __dirname: resolve('local-app/electron'),
            process: { versions: { electron: '44.9.2' }, type: 'browser', platform: 'win32', env: { VELA_DATA_DIR: root } },
        });
        await Promise.resolve(); expect(app.quit).toHaveBeenCalledOnce(); expect(app.setPath).toHaveBeenCalledWith('userData', join(root, 'desktop-profile'));
    });
    it('configures an isolated sandboxed renderer, a fixed profile, and menus without stopping the backend for an unavailable update', async () => {
        const f = await desktop(); const options = f.BrowserWindow.mock.calls[0] as unknown as [{ webPreferences: Record<string, unknown> }];
        expect(options[0].webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false });
        expect(f.app.setPath).toHaveBeenCalledWith('userData', join(f.root, 'desktop-profile'));
        const file = f.Menu.buildFromTemplate.mock.calls[0]![0][0]!;
        file.submenu!.find(item => item.label?.startsWith('Install'))!.click!();
        await vi.waitFor(() => expect(f.dialog.showMessageBox).toHaveBeenCalled());
        expect(f.contents.send).not.toHaveBeenCalled(); expect(f.child.postMessage).not.toHaveBeenCalled(); expect(f.updater.install).not.toHaveBeenCalled();
        file.submenu!.find(item => item.label?.startsWith('Check'))!.click!();
        await vi.waitFor(() => expect(f.updater.check).toHaveBeenCalledOnce());
    });
    it('keeps a downloaded update idle until the explicit menu action passes renderer ACK and actual utility exit', async () => {
        const f = await desktop(); f.createUpdater.mock.calls[0]![0].onDownloaded();
        await Promise.resolve(); await Promise.resolve();
        expect(f.contents.send.mock.calls.every(call => call[0] === UPDATE_CHANNELS.changed)).toBe(true);
        expect(f.child.postMessage).not.toHaveBeenCalled(); f.contents.send.mockClear();
        expect(f.updater.install).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
        f.Menu.buildFromTemplate.mock.calls[0]![0][0]!.submenu!.find(item => item.label?.startsWith('Install'))!.click!();
        await vi.waitFor(() => expect(f.contents.send.mock.calls.some(call => call[0] === CHANNELS.prepare)).toBe(true));
        expect(f.child.postMessage).not.toHaveBeenCalled(); expect(f.updater.install).not.toHaveBeenCalled();
        const request = f.contents.send.mock.calls.find(call => call[0] === CHANNELS.prepare)![1] as { requestId: string; reason: string };
        expect(request.reason).toBe('update'); f.ipcMain.emit(CHANNELS.prepared, f.event, { requestId: request.requestId });
        await vi.waitFor(() => expect(f.child.postMessage).toHaveBeenCalledOnce()); expect(f.updater.install).not.toHaveBeenCalled();
        f.child.emit('exit', 0); await vi.waitFor(() => expect(f.updater.install).toHaveBeenCalledOnce());
        expect(f.app.quit).not.toHaveBeenCalled();
    });
    it('reports the pinned downloaded update as ready when the File menu checks again without entering the save barrier', async () => {
        const f = await desktop(); f.createUpdater.mock.calls[0]![0].onDownloaded('1.3.3'); f.contents.send.mockClear();
        f.Menu.buildFromTemplate.mock.calls[0]![0][0]!.submenu!.find(item => item.label?.startsWith('Check'))!.click!();
        await vi.waitFor(() => expect(f.dialog.showMessageBox).toHaveBeenCalledWith(f.window, expect.objectContaining({ message: 'An update is ready to install.' })));
        expect(f.contents.send).not.toHaveBeenCalled(); expect(f.child.postMessage).not.toHaveBeenCalled();
        expect(f.updater.install).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
    });
    it('can quit cleanly after a main document load failure, without waiting for a client that never started', async () => {
        const f = await desktop(true); expect(f.dialog.showErrorBox).toHaveBeenCalledOnce(); expect(f.app.quit).toHaveBeenCalledOnce();
        expect(f.contents.send).not.toHaveBeenCalled(); expect(f.window.destroy).toHaveBeenCalledOnce(); expect(f.child.postMessage).toHaveBeenCalledOnce();
    });
    it('retains the save barrier if updater initialization fails after the document loads', async () => {
        const f = await desktop(false, true); expect(f.dialog.showMessageBox).toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
        const closing = f.result.close(); await vi.waitFor(() => expect(f.contents.send).toHaveBeenCalledOnce());
        const request = f.contents.send.mock.calls[0]![1] as { requestId: string };
        f.ipcMain.emit(CHANNELS.prepared, f.event, { requestId: request.requestId });
        await vi.waitFor(() => expect(f.child.postMessage).toHaveBeenCalledOnce()); f.child.emit('exit', 0);
        expect(await closing).toBe(true); expect(f.app.quit).toHaveBeenCalledOnce();
    });
});

describe('real Electron utility feasibility', () => {
    const electronInstalled = existsSync(resolve('node_modules/electron/dist/electron.exe'));
    it.skipIf(process.platform !== 'win32' || !electronInstalled)('runs ESM and node:sqlite inside the installed utility process without touching application data', async () => {
        const directory = temporary(); const entry = join(directory, 'main.cjs'); const probe = join(directory, 'probe.mjs');
        mkdirSync(join(directory, 'profile'));
        writeFileSync(probe, `import { DatabaseSync } from 'node:sqlite';\nimport { pathToFileURL } from 'node:url';\nimport { resolve } from 'node:path';\nconst db = new DatabaseSync(':memory:');\nconst result = db.prepare('SELECT 42 AS value').get(); db.close();\nprocess.parentPort.on('message', () => process.exit(0));\nprocess.parentPort.postMessage({ node: process.versions.node, electron: process.versions.electron, sqlite: result.value, esm: import.meta.url.endsWith('probe.mjs'), argvMatches: !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url });\n`);
        writeFileSync(entry, `const { app, utilityProcess } = require('electron');\nconst quit = app.quit; const lock = app.requestSingleInstanceLock; let entryQuits = 0;\napp.quit = () => { entryQuits++; }; app.requestSingleInstanceLock = () => false;\nrequire(${JSON.stringify(resolve('local-app/electron/main.cjs'))});\napp.quit = quit; app.requestSingleInstanceLock = lock;\nconst appEntry = entryQuits === 1 && app.getPath('userData') === ${JSON.stringify(join(directory, 'desktop-profile'))};\napp.whenReady().then(() => { const child = utilityProcess.fork(${JSON.stringify(probe)}, [], { stdio: 'ignore' }); let result; child.on('message', value => { result = value; child.postMessage({ stop: true }); }); child.on('exit', code => { console.log('VELA_UTILITY_PROBE=' + JSON.stringify({ ...result, exitCode: code, entryMain: require.main === module, appEntry })); app.exit(code); }); });\n`);
        const env: NodeJS.ProcessEnv = { ...process.env, VELA_DATA_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
        const output = await new Promise<string>((done, fail) => {
            const child = spawn(resolve('node_modules/electron/dist/electron.exe'), [entry], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = ''; let stderr = ''; const timer = setTimeout(() => { child.kill(); fail(new Error('Electron utility probe timed out.')); }, 20_000);
            child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
            child.on('error', error => { clearTimeout(timer); fail(error); }); child.on('exit', code => { clearTimeout(timer); if (code === 0) done(stdout); else fail(new Error(`Electron utility probe failed (${code}): ${stderr.slice(-1000)}`)); });
        });
        const line = output.split(/\r?\n/).find(value => value.startsWith('VELA_UTILITY_PROBE=')); expect(line).toBeDefined();
        const result = JSON.parse(line!.slice('VELA_UTILITY_PROBE='.length)) as { node: string; electron: string; sqlite: number; esm: boolean; exitCode: number; argvMatches: boolean; entryMain: boolean; appEntry: boolean };
        expect(Number(result.node.split('.')[0])).toBeGreaterThanOrEqual(24); expect(result.sqlite).toBe(42); expect(result.esm).toBe(true); expect(result.exitCode).toBe(0);
        expect(result.argvMatches).toBe(true);
        expect(result.appEntry).toBe(true);
        console.log(`Electron verified: actual app entry/profile, Electron ${result.electron}, Node ${result.node}, ESM, node:sqlite, clean utility exit; Node-style app entry guard ${result.entryMain}.`);
    }, 25_000);
});
