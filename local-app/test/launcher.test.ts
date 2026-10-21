import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { relevantSource, sourceFingerprint } from '../runtime/source.mjs';
import { claimSingleton, managedIdentity, repositoryIdentity, stopOwned } from '../runtime/supervisor.mjs';
import { transitionRuntime, UpdateDeferred } from '../runtime/transition.mjs';
import type { TransitionOperations } from '../runtime/transition.mjs';
import { coordinatedUpdates } from '../vite.config';
import type { ViteDevServer } from 'vite';
import { readCurrentStage, saveCurrentStage } from '../runtime/cache.mjs';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'vela-launcher-test-')); directories.push(directory);
    await mkdir(join(directory, 'src')); await mkdir(join(directory, 'local-app/client'), { recursive: true });
    await writeFile(join(directory, 'src/chart.ts'), 'export const value=1;');
    await writeFile(join(directory, 'local-app/client/style.css'), 'body{color:red}');
    return directory;
}
function operations(events: string[]): TransitionOperations<string> {
    return {
        prepare: async value => { events.push(`prepare:${value}`); }, isCurrent: async () => true,
        cancel: async value => { events.push(`cancel:${value}`); }, stop: async value => { events.push(`stop:${value}`); },
        start: async value => { events.push(`start:${value}`); return value; }, stopFailed: async () => { events.push('stop-failed'); },
        restored: value => { events.push(`restored:${value}`); },
    };
}
describe('managed update safety', () => {
    it('saves clients before replacing the working runtime', async () => {
        const events: string[] = []; expect(await transitionRuntime('old', 'new', operations(events))).toBe('new');
        expect(events).toEqual(['prepare:old', 'stop:old', 'start:new']);
    });
    it('keeps the working process when a client cannot save', async () => {
        const events: string[] = []; const ops = operations(events);
        ops.prepare = async () => { throw new Error('unsaved drawing'); };
        await expect(transitionRuntime('old', 'new', ops)).rejects.toThrow('unsaved drawing');
        expect(events).toEqual(['cancel:old']);
    });
    it('cancels a stale build even if clients became ready', async () => {
        const events: string[] = []; const ops = operations(events); ops.isCurrent = async () => false;
        await expect(transitionRuntime('old', 'new', ops)).rejects.toBeInstanceOf(UpdateDeferred);
        expect(events).toEqual(['prepare:old', 'cancel:old']);
    });
    it('resumes the old application if a late lease refuses shutdown', async () => {
        const events: string[] = []; const ops = operations(events);
        ops.stop = async () => { throw new Error('new unacknowledged client'); };
        await expect(transitionRuntime('old', 'new', ops)).rejects.toThrow('unacknowledged');
        expect(events).toEqual(['prepare:old', 'cancel:old']);
    });
    it('rolls back the compiled backend if its replacement fails to listen', async () => {
        const events: string[] = []; const ops = operations(events);
        ops.start = async value => { events.push(`start:${value}`); if (value === 'new') throw new Error('port conflict'); return value; };
        await expect(transitionRuntime('old', 'new', ops)).rejects.toThrow('port conflict');
        expect(events).toEqual(['prepare:old', 'stop:old', 'start:new', 'stop-failed', 'start:old', 'restored:old']);
    });
    it('never starts a stale initial build', async () => {
        const events: string[] = []; const ops = operations(events); ops.isCurrent = async () => false;
        await expect(transitionRuntime(undefined, 'new', ops)).rejects.toBeInstanceOf(UpdateDeferred); expect(events).toEqual([]);
    });
});
describe('source invalidation', () => {
    it('includes chart/backend/CSS/config and ignores tests, docs and generated files', () => {
        for (const filename of ['src/chart.ts', 'local-app/client/style.css', 'local-app/server/index.ts', 'local-app/vite.config.ts', 'package-lock.json']) expect(relevantSource(filename)).toBe(true);
        for (const filename of ['LOCAL-APP.md', 'local-app/test/launcher.test.ts', 'src/data/chart.test.ts', 'local-app/.runtime/run/server.mjs', 'local-app/dist/assets/a.js',
            'local-app/electron/staging/app-runtime/server.mjs', 'local-app/electron/releases/win-unpacked/resources/app-runtime/server.mjs', 'docs/guide.md']) expect(relevantSource(filename)).toBe(false);
    });
    it('hashes content deterministically, including CSS, and skips ignored output', async () => {
        const directory = await fixture(); const first = await sourceFingerprint(directory);
        expect(await sourceFingerprint(directory)).toBe(first);
        await mkdir(join(directory, 'local-app/.runtime'), { recursive: true }); await writeFile(join(directory, 'local-app/.runtime/ignored.js'), 'changed');
        expect(await sourceFingerprint(directory)).toBe(first);
        await writeFile(join(directory, 'local-app/client/style.css'), 'body{color:blue}'); expect(await sourceFingerprint(directory)).not.toBe(first);
    });
});
describe('local process ownership', () => {
    it('rejects unrelated and mismatched runtime identities', () => {
        const repositoryId = repositoryIdentity('test-repository');
        const state = { managed: true, mode: 'run', repositoryId, instanceId: 'expected' };
        expect(managedIdentity(state, 'run', repositoryId, 'expected')).toBe(true);
        expect(managedIdentity(state, 'develop', repositoryId)).toBe(false);
        expect(managedIdentity(state, 'run', 'different')).toBe(false);
        expect(managedIdentity(state, 'run', repositoryId, 'other')).toBe(false);
        expect(managedIdentity({ ...state, managed: false }, 'run', repositoryId)).toBe(false);
    });
    it('claims one process-owned socket and returns live state to another launcher', async () => {
        const directory = await fixture(); const first = await claimSingleton(directory, 'run', () => ({ ready: true, instanceId: 'one' }));
        try {
            const second = await claimSingleton(directory, 'run', () => ({ ready: false }));
            expect(second.existing).toEqual({ ready: true, instanceId: 'one' }); await second.close();
        } finally { await first.close(); }
    });
    function fakeOwned(reply?: 'runtime:stopping' | 'runtime:shutdown-refused', exitOnKill = false) {
        const emitter = new EventEmitter(); let resolveExit!: () => void;
        const owned = { child: emitter as ChildProcess, exited: false, exit: new Promise<void>(done => { resolveExit = done; }) };
        Object.assign(emitter, { connected: true, send: (message: {updateId: string}, callback: () => void) => { if (reply) emitter.emit('message', { type: reply, updateId: message.updateId }); callback(); }, kill: vi.fn(() => { if (exitOnKill) { owned.exited = true; resolveExit(); emitter.emit('exit', 0); } }) });
        return { owned, kill: emitter as unknown as {kill: ReturnType<typeof vi.fn>} };
    }
    it('never terminates an update backend that refused the barrier', async () => {
        const { owned, kill } = fakeOwned('runtime:shutdown-refused');
        await expect(stopOwned(owned, 'update', 50)).rejects.toThrow('client joined'); expect(kill.kill).not.toHaveBeenCalled();
    });
    it('never terminates an update backend that did not acknowledge shutdown', async () => {
        const { owned, kill } = fakeOwned();
        await expect(stopOwned(owned, 'update', 15)).rejects.toThrow('deadline'); expect(kill.kill).not.toHaveBeenCalled();
    });
    it('may terminate its own hung process only after the save barrier was accepted', async () => {
        const { owned, kill } = fakeOwned('runtime:stopping', true);
        await stopOwned(owned, 'update', 15); expect(kill.kill).toHaveBeenCalledOnce();
    });
});
describe('development reload ownership', () => {
    it('suppresses CSS/module, HTML, config and error refresh signals but leaves the socket live', () => {
        const wsSend = vi.fn(); const hotSend = vi.fn();
        const channel = { send: wsSend }; const environment = { hot: { send: hotSend } };
        const plugin = coordinatedUpdates(); const configure = plugin.configureServer;
        if (typeof configure !== 'function') throw new Error('Missing coordination hook');
        configure.call({} as ThisParameterType<typeof configure>, { ws: channel, environments: { client: environment } } as unknown as ViteDevServer);
        for (const target of [channel, environment.hot]) {
            for (const type of ['update', 'full-reload', 'error']) target.send({ type });
            expect(target.send({ type: 'connected' })).toBeUndefined(); target.send({ type: 'custom', event: 'safe-status' });
        }
        for (const send of [wsSend, hotSend]) expect(send.mock.calls).toEqual([[{ type: 'connected' }], [{ type: 'custom', event: 'safe-status' }]]);
    });
});
describe('validated fast startup', () => {
    async function stageFixture() {
        const directory = await fixture(); const stage = { version: 'a'.repeat(16), directory: join(directory, `${'a'.repeat(16)}-1234`) };
        await mkdir(join(stage.directory, 'client'), { recursive: true });
        await writeFile(join(stage.directory, 'server.mjs'), 'server'); await writeFile(join(stage.directory, 'vite.config.mjs'), 'config');
        await writeFile(join(stage.directory, 'client/index.html'), '<html>client</html>');
        await saveCurrentStage(directory, stage, 'run', 'repository'); return { directory, stage };
    }
    it('reuses a complete content-verified build for the same repository and mode', async () => {
        const { directory, stage } = await stageFixture();
        expect(await readCurrentStage(directory, 'run', 'repository')).toEqual({ ...stage, directory: await realpath(stage.directory) });
        expect(await readCurrentStage(directory, 'develop', 'repository')).toBeUndefined();
        expect(await readCurrentStage(directory, 'run', 'other-repository')).toBeUndefined();
    });
    it('reuses a verified stage through an alias of the runtime root', async () => {
        const { directory, stage } = await stageFixture(); const alias = join(await fixture(), 'runtime-alias');
        await symlink(await realpath(directory), alias, process.platform === 'win32' ? 'junction' : 'dir');
        expect(await readCurrentStage(alias, 'run', 'repository')).toEqual({ ...stage, directory: await realpath(stage.directory) });
    });
    it('rejects a linked stage outside an aliased runtime root even when its content matches', async () => {
        const { directory, stage } = await stageFixture(); const outside = join(await fixture(), 'outside');
        await rename(stage.directory, outside);
        await symlink(await realpath(outside), stage.directory, process.platform === 'win32' ? 'junction' : 'dir');
        const alias = join(await fixture(), 'runtime-alias');
        await symlink(await realpath(directory), alias, process.platform === 'win32' ? 'junction' : 'dir');
        expect(await readCurrentStage(directory, 'run', 'repository')).toBeUndefined();
        expect(await readCurrentStage(alias, 'run', 'repository')).toBeUndefined();
    });
    it('rejects changed or incomplete cached artifacts', async () => {
        const { directory, stage } = await stageFixture();
        await writeFile(join(stage.directory, 'server.mjs'), 'tampered');
        expect(await readCurrentStage(directory, 'run', 'repository')).toBeUndefined();
        await rm(join(stage.directory, 'client/index.html'));
        expect(await readCurrentStage(directory, 'run', 'repository')).toBeUndefined();
    });
    it('does not follow a cache manifest outside its own mode directory', async () => {
        const { directory } = await stageFixture();
        await writeFile(join(directory, 'current.json'), JSON.stringify({ format: 1, mode: 'run', repositoryId: 'repository', version: 'a'.repeat(16), directory: '../outside', artifacts: 'ignored' }));
        expect(await readCurrentStage(directory, 'run', 'repository')).toBeUndefined();
    });
});
