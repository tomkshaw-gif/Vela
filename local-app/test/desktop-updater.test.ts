import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

class FakeUpdater extends EventEmitter {
    autoDownload = false;
    autoInstallOnAppQuit = true;
    allowPrerelease = true;
    allowDowngrade = true;
    checkForUpdates = vi.fn<() => Promise<unknown>>(async () => ({ updateInfo: { version: '1.2.3' } }));
    quitAndInstall = vi.fn();
}

interface DesktopUpdater { check(): Promise<unknown>; install(): Promise<void>; dispose(): void }
type UpdaterFactory = (options: { app: { isPackaged: boolean }; onDownloaded: () => void; onStatus?: (status: string) => void;
    updater?: FakeUpdater; intervalMs?: number; launch?: (input: unknown) => Promise<void> }) => DesktopUpdater;

const UPDATE = { downloadedFile: 'C:/owned/Vela-Setup.exe', sha512: Buffer.alloc(64).toString('base64') };

const instances: DesktopUpdater[] = [];
const directories: string[] = [];
function fixture(packaged = true, intervalMs = 60_000) {
    const updater = new FakeUpdater(); const defaultUpdater = new FakeUpdater();
    const launch = vi.fn<(_input: unknown) => Promise<void>>(async () => {});
    const requireStub = vi.fn((name: string) => {
        if (name === './installer.cjs') return { launchInstaller: launch };
        if (name !== 'electron-updater') throw new Error(`Unexpected updater dependency: ${name}`);
        return { autoUpdater: defaultUpdater };
    });
    const filename = fileURLToPath(new URL('../electron/updater.cjs', import.meta.url));
    const module = { exports: {} as { createDesktopUpdater: UpdaterFactory } };
    runInNewContext(readFileSync(filename, 'utf8'), { module, exports: module.exports, require: requireStub,
        setTimeout, clearTimeout, setInterval, clearInterval }, { filename });
    const app = { isPackaged: packaged, quit: vi.fn() }; const onDownloaded = vi.fn(); const onStatus = vi.fn();
    const controller = module.exports.createDesktopUpdater({ app, onDownloaded, onStatus, updater, intervalMs });
    instances.push(controller);
    return { controller, updater, defaultUpdater, app, onDownloaded, onStatus, requireStub, launch };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
    for (const controller of instances.splice(0)) controller.dispose();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
});

describe('desktop updater boundary', () => {
    it('downloads automatically but delegates all installation to the save-and-close lifecycle', () => {
        const f = fixture();
        expect(f.updater.autoDownload).toBe(true); expect(f.updater.autoInstallOnAppQuit).toBe(false);
        expect(f.updater.allowPrerelease).toBe(false); expect(f.updater.allowDowngrade).toBe(false);
        expect(f.updater.quitAndInstall).not.toHaveBeenCalled(); expect(f.defaultUpdater.eventNames()).toEqual([]);
        expect(f.defaultUpdater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('deduplicates overlapping checks and allows another check after settlement', async () => {
        const f = fixture(); let finish!: (value: unknown) => void;
        f.updater.checkForUpdates.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const first = f.controller.check(); const second = f.controller.check();
        expect(second).toBe(first); await Promise.resolve(); expect(f.updater.checkForUpdates).toHaveBeenCalledOnce();
        finish({ version: '1.2.3' }); await expect(first).resolves.toEqual({ version: '1.2.3' });
        await f.controller.check(); expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    });

    it('checks after startup and periodically, coalescing timer checks with an active manual check', async () => {
        const f = fixture(); let finish!: (value: unknown) => void;
        f.updater.checkForUpdates.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const active = f.controller.check(); await Promise.resolve();
        await vi.advanceTimersByTimeAsync(15_000); expect(f.updater.checkForUpdates).toHaveBeenCalledOnce();
        finish(null); await active;
        await vi.advanceTimersByTimeAsync(45_000); expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(60_000); expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(3);
    });

    it.each(['reject', 'throw'] as const)('handles an automatic check %s and retries on the next interval', async mode => {
        const f = fixture();
        f.updater.checkForUpdates.mockImplementationOnce(() => {
            if (mode === 'throw') throw new Error('Private updater diagnostic');
            return Promise.reject(new Error('Private updater diagnostic'));
        });
        await vi.advanceTimersByTimeAsync(15_000);
        expect(f.onStatus).toHaveBeenCalledExactlyOnceWith('unavailable'); expect(f.onDownloaded).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(45_000); expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
        expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('propagates a requested check failure while releasing its deduplication slot', async () => {
        const f = fixture(); f.updater.checkForUpdates.mockRejectedValueOnce(new Error('Check failed'));
        await expect(f.controller.check()).rejects.toThrow('Check failed');
        await expect(f.controller.check()).resolves.toMatchObject({ updateInfo: { version: '1.2.3' } });
        expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    });

    it('reports updater events without installing or leaking error details', () => {
        const f = fixture();
        for (const event of ['checking-for-update', 'update-available', 'update-not-available', 'error']) f.updater.emit(event, new Error('Private updater diagnostic'));
        expect(f.onStatus.mock.calls).toEqual([['checking'], ['downloading'], ['current'], ['unavailable']]);
        expect(f.onDownloaded).not.toHaveBeenCalled(); expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
        expect(() => f.controller.install()).toThrow('downloaded');
    });

    it('allows explicit installation only after a complete download and while packaged', async () => {
        const f = fixture(); expect(() => f.controller.install()).toThrow('downloaded');
        f.updater.emit('update-available'); expect(() => f.controller.install()).toThrow('downloaded');
        f.updater.emit('update-downloaded', UPDATE);
        expect(f.onStatus).toHaveBeenLastCalledWith('ready'); expect(f.onDownloaded).toHaveBeenCalledOnce();
        expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
        f.app.isPackaged = false; expect(() => f.controller.install()).toThrow('downloaded');
        f.app.isPackaged = true; await f.controller.install(); expect(f.launch).toHaveBeenCalledExactlyOnceWith({ app: f.app, update: UPDATE });
    });

    it('keeps the lifecycle retryable when the installer reports an asynchronous failure', async () => {
        const f = fixture(); f.updater.emit('update-downloaded', UPDATE); f.launch.mockRejectedValueOnce(new Error('Installer could not start'));
        await expect(f.controller.install()).rejects.toThrow('could not start'); expect(f.app.quit).not.toHaveBeenCalled();
        await expect(f.controller.install()).resolves.toBeUndefined(); expect(f.launch).toHaveBeenCalledTimes(2);
    });

    it.each(['manual', 'startup timer', 'periodic timer'])('pins the waiting installer against cache-clearing downloads from a later %s check', async trigger => {
        const require = createRequire(import.meta.url);
        const { AppUpdater } = require('electron-updater/out/AppUpdater');
        const { DownloadedUpdateHelper } = require('electron-updater/out/DownloadedUpdateHelper');
        const directory = mkdtempSync(join(tmpdir(), 'vela-pinned-updater-')); directories.push(directory);
        const helper = new DownloadedUpdateHelper(directory); mkdirSync(helper.cacheDirForPendingUpdate, { recursive: true });
        const downloadedFile = join(helper.cacheDirForPendingUpdate, 'accepted.exe'); writeFileSync(downloadedFile, 'inert accepted installer');
        const accepted = { ...UPDATE, version: '1.3.3', downloadedFile };
        const oldFileInfo = { url: new URL('https://updates.invalid/accepted.exe'), info: { url: 'accepted.exe', sha512: UPDATE.sha512 } };
        await helper.setDownloadedFile(downloadedFile, null, { version: accepted.version }, oldFileInfo, 'accepted.exe', true);
        const clear = vi.spyOn(helper, 'clear');
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        const engine = Object.assign(new EventEmitter(), { _logger: logger, getOrCreateDownloadHelper: async () => helper });
        const f = fixture();
        const attempts: Promise<unknown>[] = [];
        f.updater.checkForUpdates.mockImplementation(async () => {
            const downloadPromise = AppUpdater.prototype.executeDownload.call(engine, {
            fileInfo: { url: new URL('https://updates.invalid/newer.exe'), info: { url: 'newer.exe', sha512: Buffer.alloc(64, 1).toString('base64') } },
            fileExtension: 'exe', downloadUpdateOptions: { requestHeaders: {}, updateInfoAndProvider: { info: { version: '1.3.4' } } },
            task: async () => { throw new Error('The inert newer download failed.'); }, done: vi.fn(),
            });
            attempts.push(downloadPromise); return { downloadPromise };
        });
        f.updater.emit('update-downloaded', accepted);
        if (trigger === 'manual') await f.controller.check().catch(() => {});
        else await vi.advanceTimersByTimeAsync(trigger === 'startup timer' ? 15_000 : 120_000);
        await Promise.allSettled(attempts);
        expect({ checks: f.updater.checkForUpdates.mock.calls.length, clears: clear.mock.calls.length, installerExists: existsSync(downloadedFile) })
            .toEqual({ checks: 0, clears: 0, installerExists: true });
        await f.controller.install(); expect(f.launch).toHaveBeenCalledExactlyOnceWith({ app: f.app, update: accepted });
    });

    it('coalesces the accepted download check until it settles, then suppresses later checks even after installer failure', async () => {
        const f = fixture(); let finish!: () => void;
        f.updater.checkForUpdates.mockImplementationOnce(async () => ({ downloadPromise: new Promise<void>(resolve => { finish = resolve; }) }));
        const active = f.controller.check(); await Promise.resolve(); await Promise.resolve();
        f.updater.emit('update-downloaded', UPDATE); expect(f.controller.check()).toBe(active);
        await vi.advanceTimersByTimeAsync(60_000); expect(f.updater.checkForUpdates).toHaveBeenCalledOnce();
        finish(); await active; await expect(f.controller.check()).resolves.toBeNull();
        f.launch.mockRejectedValueOnce(new Error('Inert installer failure')); await expect(f.controller.install()).rejects.toThrow('Inert installer failure');
        await vi.advanceTimersByTimeAsync(120_000); await expect(f.controller.check()).resolves.toBeNull();
        expect(f.updater.checkForUpdates).toHaveBeenCalledOnce(); await f.controller.install(); expect(f.launch).toHaveBeenCalledTimes(2);
    });

    it('does not begin a queued check if a completed download arrives before its microtask starts', async () => {
        const f = fixture(); const check = f.controller.check(); f.updater.emit('update-downloaded', UPDATE);
        await expect(check).resolves.toBeNull(); expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('retains the cached download and ready state after late check events and suppresses further checks', async () => {
        const f = fixture(); f.updater.emit('update-downloaded', UPDATE); f.onStatus.mockClear();
        for (const event of ['checking-for-update', 'update-available', 'update-not-available', 'error']) f.updater.emit(event, { version: '9.9.9' });
        expect(f.onStatus.mock.calls).toEqual([['ready'], ['ready'], ['ready'], ['ready']]);
        f.updater.checkForUpdates.mockRejectedValueOnce(new Error('Private diagnostic'));
        await expect(f.controller.check()).resolves.toBeNull(); expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
        expect(f.onStatus).toHaveBeenLastCalledWith('ready');
        await f.controller.install(); expect(f.launch).toHaveBeenCalledExactlyOnceWith({ app: f.app, update: UPDATE });
    });

    it('handles an automatic download rejection and suppresses pending-check errors after disposal', async () => {
        const f = fixture(); f.updater.checkForUpdates.mockImplementationOnce(async () => ({ downloadPromise: Promise.reject(new Error('Private download failure')) }));
        await vi.advanceTimersByTimeAsync(15_000); expect(f.onStatus).toHaveBeenLastCalledWith('unavailable');
        let reject!: (error: Error) => void;
        f.updater.checkForUpdates.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
        const check = f.controller.check(); const rejected = expect(check).rejects.toThrow('Private delayed failure'); await Promise.resolve();
        f.controller.dispose(); f.onStatus.mockClear(); reject(new Error('Private delayed failure')); await rejected;
        expect(f.onStatus).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
    });

    it('consumes automatic download failures and permits another check', async () => {
        const f = fixture(); let fail!: (error: Error) => void;
        f.updater.checkForUpdates.mockResolvedValueOnce({ downloadPromise: new Promise((_resolve, reject) => { fail = reject; }) });
        const check = f.controller.check(); const rejected = expect(check).rejects.toThrow('Download failed');
        await Promise.resolve(); await Promise.resolve(); fail(new Error('Download failed')); await rejected;
        await expect(f.controller.check()).resolves.toEqual({ updateInfo: { version: '1.2.3' } });
        expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('never checks or installs in an unpackaged application', async () => {
        const f = fixture(false); await expect(f.controller.check()).resolves.toBeNull();
        await vi.advanceTimersByTimeAsync(120_000); expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
        f.updater.emit('update-downloaded', UPDATE); expect(() => f.controller.install()).toThrow('downloaded');
        expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('disposes timers and only its own listeners, and disables checks and installation', async () => {
        const f = fixture(); const observer = vi.fn(); f.updater.on('update-available', observer);
        f.updater.emit('update-downloaded', UPDATE); f.onDownloaded.mockClear(); f.onStatus.mockClear();
        f.controller.dispose(); f.controller.dispose();
        expect(vi.getTimerCount()).toBe(0); expect(f.updater.listeners('update-available')).toEqual([observer]);
        expect(f.updater.listenerCount('error')).toBe(0); expect(f.updater.listenerCount('update-downloaded')).toBe(0);
        f.updater.emit('update-downloaded', UPDATE); f.updater.emit('update-available');
        await vi.advanceTimersByTimeAsync(120_000); await expect(f.controller.check()).resolves.toBeNull();
        expect(f.updater.checkForUpdates).not.toHaveBeenCalled(); expect(f.onStatus).not.toHaveBeenCalled();
        expect(f.onDownloaded).not.toHaveBeenCalled(); expect(observer).toHaveBeenCalledOnce();
        expect(() => f.controller.install()).toThrow('downloaded'); expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('ignores completion events after disposal even if a check was still pending', async () => {
        const f = fixture(); let finish!: (value: unknown) => void;
        f.updater.checkForUpdates.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const active = f.controller.check(); await Promise.resolve(); f.controller.dispose();
        f.updater.emit('update-downloaded', UPDATE); finish(null); await active;
        expect(f.onDownloaded).not.toHaveBeenCalled(); expect(f.onStatus).not.toHaveBeenCalled();
        expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('does not start a queued check after disposal', async () => {
        const f = fixture(); const check = f.controller.check(); f.controller.dispose();
        await expect(check).resolves.toBeNull(); expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
    });
});
