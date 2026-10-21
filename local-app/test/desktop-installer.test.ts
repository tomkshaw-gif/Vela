import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SpawnOptions } from 'node:child_process';

interface InstallerApp {
    getPath(name: 'exe'): string;
    quit(): void;
}
type InstallerChild = EventEmitter & { unref(): void };
type StartInstaller = (file: string, args: string[], options: SpawnOptions) => InstallerChild;
type LaunchInstaller = (input: { app: InstallerApp; update: unknown; start: StartInstaller }) => Promise<void>;
interface QuitLifecycle {
    close(options: { install: () => Promise<void> }): Promise<boolean>;
    isStopped(): boolean;
    dispose(): void;
}
type CreateQuitLifecycle = (input: {
    app: EventEmitter & InstallerApp;
    window: EventEmitter;
    prepare: (reason: string) => Promise<void>;
    stop: () => Promise<void>;
    onError: (error: Error) => void;
}) => QuitLifecycle;

const require = createRequire(import.meta.url);
const { launchInstaller } = require('../electron/installer.cjs') as { launchInstaller: LaunchInstaller };
const { createQuitLifecycle } = require('../electron/lifecycle.cjs') as { createQuitLifecycle: CreateQuitLifecycle };
const cleanups: (() => void)[] = [];

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
}

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'vela-installer-test-'));
    cleanups.push(() => rmdirSync(directory));
    const downloadedFile = join(directory, 'dummy.exe');
    const bytes = Buffer.from('MZ - inert installer test bytes; never execute this file.\n');
    writeFileSync(downloadedFile, bytes);
    cleanups.push(() => unlinkSync(downloadedFile));
    const update = { downloadedFile, sha512: createHash('sha512').update(bytes).digest('base64') };
    const executable = join(directory, 'Installed Vela With Spaces', 'Vela Replay Studio.exe');
    const app = Object.assign(new EventEmitter(), {
        getPath: vi.fn<InstallerApp['getPath']>(() => executable), quit: vi.fn(),
    });
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const started = deferred();
    const start = vi.fn<StartInstaller>(() => { started.resolve(); return child; });
    const launch = (input: unknown = update) => launchInstaller({ app, update: input, start });
    return { directory, downloadedFile, bytes, update, executable, app, child, start, started, launch };
}

afterEach(() => {
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('verified desktop installer launch', () => {
    it('waits for the actual child spawn acknowledgement before unref and quit', async () => {
        const f = fixture(); const settled = vi.fn();
        const pending = f.launch().then(settled);
        await f.started.promise;
        await Promise.resolve();
        expect(f.start).toHaveBeenCalledOnce();
        expect(f.child.unref).not.toHaveBeenCalled();
        expect(f.app.quit).not.toHaveBeenCalled();
        expect(settled).not.toHaveBeenCalled();

        f.child.emit('spawn'); await pending;
        expect(f.child.unref).toHaveBeenCalledOnce();
        expect(f.app.quit).toHaveBeenCalledOnce();
        expect(f.child.unref.mock.invocationCallOrder[0]).toBeLessThan(f.app.quit.mock.invocationCallOrder[0]!);
        f.child.emit('spawn');
        expect(f.app.quit).toHaveBeenCalledOnce();
    });

    it('passes the installation directory with spaces as one final NSIS argument without a shell', async () => {
        const f = fixture(); const pending = f.launch();
        await f.started.promise;
        expect(f.app.getPath).toHaveBeenCalledExactlyOnceWith('exe');
        expect(f.start).toHaveBeenCalledExactlyOnceWith(realpathSync.native(f.downloadedFile),
            ['--updated', '/S', '--force-run', `/D=${dirname(f.executable)}`],
            { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
        f.child.emit('spawn'); await pending;
    });

    it('rejects an asynchronous child error and ignores a subsequent spawn without quitting', async () => {
        const f = fixture(); const rejected = expect(f.launch()).rejects.toThrow('could not start');
        await f.started.promise;
        f.child.emit('error', new Error('EACCES: private launcher diagnostic')); await rejected;
        f.child.emit('spawn');
        expect(f.child.unref).not.toHaveBeenCalled();
        expect(f.app.quit).not.toHaveBeenCalled();
    });

    it('rejects a synchronous start failure without quitting', async () => {
        const f = fixture(); f.start.mockImplementationOnce(() => { throw new Error('Synchronous spawn failure'); });
        await expect(f.launch()).rejects.toThrow('could not start');
        expect(f.start).toHaveBeenCalledOnce();
        expect(f.child.unref).not.toHaveBeenCalled();
        expect(f.app.quit).not.toHaveBeenCalled();
    });

    it('rehashes the actual downloaded bytes and refuses a file changed after download', async () => {
        const f = fixture(); writeFileSync(f.downloadedFile, Buffer.from('Changed downloaded bytes'));
        await expect(f.launch()).rejects.toThrow('changed after download');
        expect(f.start).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
    });

    it('accepts the executable checksum from the downloaded event file metadata', async () => {
        const f = fixture();
        const pending = f.launch({ downloadedFile: f.downloadedFile, files: [
            { url: 'RELEASES.yml', sha512: 'not an executable checksum' },
            { url: 'Vela-Setup.EXE', sha512: f.update.sha512 },
        ] });
        await f.started.promise; f.child.emit('spawn'); await pending;
        expect(f.start).toHaveBeenCalledOnce(); expect(f.app.quit).toHaveBeenCalledOnce();
    });

    it('rejects a mismatched top-level checksum even when file metadata has the correct checksum', async () => {
        const f = fixture();
        await expect(f.launch({ ...f.update, sha512: Buffer.alloc(64).toString('base64'),
            files: [{ url: 'Vela-Setup.exe', sha512: f.update.sha512 }] })).rejects.toThrow('changed after download');
        expect(f.start).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
    });

    it.each([
        ['missing update', () => undefined],
        ['null update', () => null],
        ['missing downloaded path', (f: ReturnType<typeof fixture>) => ({ sha512: f.update.sha512 })],
        ['non-string downloaded path', (f: ReturnType<typeof fixture>) => ({ ...f.update, downloadedFile: 42 })],
        ['relative downloaded path', (f: ReturnType<typeof fixture>) => ({ ...f.update, downloadedFile: 'dummy.exe' })],
        ['non-executable downloaded path', (f: ReturnType<typeof fixture>) => ({ ...f.update, downloadedFile: join(f.directory, 'dummy.zip') })],
        ['missing checksum', (f: ReturnType<typeof fixture>) => ({ downloadedFile: f.downloadedFile })],
        ['non-string checksum', (f: ReturnType<typeof fixture>) => ({ ...f.update, sha512: 42 })],
        ['empty checksum', (f: ReturnType<typeof fixture>) => ({ ...f.update, sha512: '' })],
        ['short checksum', (f: ReturnType<typeof fixture>) => ({ ...f.update, sha512: Buffer.alloc(63).toString('base64') })],
        ['long checksum', (f: ReturnType<typeof fixture>) => ({ ...f.update, sha512: Buffer.alloc(65).toString('base64') })],
        ['non-base64 checksum', (f: ReturnType<typeof fixture>) => ({ ...f.update, sha512: '!'.repeat(88) })],
        ['noncanonical checksum', (f: ReturnType<typeof fixture>) => ({ ...f.update, sha512: f.update.sha512 + '\n' })],
        ['administrator-only installer', (f: ReturnType<typeof fixture>) => ({ ...f.update, isAdminRightsRequired: true })],
    ] as const)('rejects %s before spawning', async (_label, input) => {
        const f = fixture();
        // Passing undefined explicitly must test missing metadata, not the fixture default.
        await expect(launchInstaller({ app: f.app, update: input(f), start: f.start })).rejects.toThrow('verified desktop installer');
        expect(f.start).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
    });

    it('rejects a downloaded executable that does not exist', async () => {
        const f = fixture();
        await expect(f.launch({ ...f.update, downloadedFile: join(f.directory, 'missing.exe') })).rejects.toThrow();
        expect(f.start).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
    });

    it('rejects an empty executable and a directory named as an executable', async () => {
        const f = fixture(); writeFileSync(f.downloadedFile, Buffer.alloc(0));
        await expect(f.launch({ ...f.update, sha512: createHash('sha512').digest('base64') })).rejects.toThrow('installer is invalid');
        const directory = join(f.directory, 'folder.exe'); mkdirSync(directory);
        cleanups.push(() => rmdirSync(directory));
        await expect(f.launch({ ...f.update, downloadedFile: directory })).rejects.toThrow('installer is invalid');
        expect(f.start).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
    });

    it.each(['', 'relative/Vela.exe', join(tmpdir(), 'Vela.zip')])('rejects invalid installed application path %j', async executable => {
        const f = fixture(); f.app.getPath.mockReturnValue(executable);
        await expect(f.launch()).rejects.toThrow('application path is invalid');
        expect(f.start).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
    });

    it('fails closed after fifteen seconds without spawn and ignores a late acknowledgement', async () => {
        const f = fixture();
        // getPath runs after realpath, stat, and the complete checksum stream have settled.
        f.app.getPath.mockImplementationOnce(() => { vi.useFakeTimers(); return f.executable; });
        const rejected = expect(f.launch()).rejects.toThrow('did not confirm startup');
        await f.started.promise;
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(14_999);
        expect(f.child.unref).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1); await rejected;
        f.child.emit('spawn');
        expect(f.child.unref).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('retries through the quit lifecycle after an asynchronous launch error, stopping the backend only once', async () => {
        const f = fixture(); const window = new EventEmitter();
        const prepare = vi.fn(async (_reason: string) => {}); const stop = vi.fn(async () => {}); const onError = vi.fn();
        const lifecycle = createQuitLifecycle({ app: f.app, window, prepare, stop, onError });
        cleanups.push(() => lifecycle.dispose());
        const install = vi.fn(() => f.launch());
        const first = lifecycle.close({ install });
        await f.started.promise;
        expect(prepare).toHaveBeenCalledExactlyOnceWith('update'); expect(stop).toHaveBeenCalledOnce();
        expect(lifecycle.isStopped()).toBe(true); expect(f.app.quit).not.toHaveBeenCalled();
        f.child.emit('error', new Error('First asynchronous launch failed'));
        await expect(first).resolves.toBe(false);
        expect(onError).toHaveBeenCalledOnce(); expect(f.app.quit).not.toHaveBeenCalled();
        const retryChild = Object.assign(new EventEmitter(), { unref: vi.fn() }); const retried = deferred();
        f.start.mockImplementationOnce(() => { retried.resolve(); return retryChild; });
        const second = lifecycle.close({ install });
        await retried.promise;
        expect(f.app.quit).not.toHaveBeenCalled();
        retryChild.emit('spawn'); await expect(second).resolves.toBe(true);
        expect(prepare).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce(); expect(install).toHaveBeenCalledTimes(2);
        expect(f.start).toHaveBeenCalledTimes(2); expect(f.child.unref).not.toHaveBeenCalled();
        expect(retryChild.unref).toHaveBeenCalledOnce(); expect(f.app.quit).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledOnce();
    });
});
