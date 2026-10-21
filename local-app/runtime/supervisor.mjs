import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, lstat, unlink, realpath } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sourceFingerprint, watchSources } from './source.mjs';
import { transitionRuntime, UpdateDeferred } from './transition.mjs';
import { readCurrentStage, saveCurrentStage } from './cache.mjs';

const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const LIMITS = { readiness: 27_000, startup: 15_000, build: 180_000, shutdown: 5000 };
export function repositoryIdentity(root) { return createHash('sha256').update(process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)).digest('hex'); }
export function managedIdentity(status, mode, repositoryId, instanceId) {
    return status?.managed === true && status.mode === mode && status.repositoryId === repositoryId && typeof status.instanceId === 'string' && (!instanceId || status.instanceId === instanceId);
}
async function runtimeStatus(port) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/runtime`, { signal: AbortSignal.timeout(2000) });
        return response.ok ? await response.json() : undefined;
    } catch { return undefined; }
}
async function portOccupied(port) {
    return new Promise(done => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.setTimeout(1000);
        socket.once('connect', () => { socket.destroy(); done(true); });
        socket.once('error', () => { socket.destroy(); done(false); });
        socket.once('timeout', () => { socket.destroy(); done(true); });
    });
}
function socketRequest(name) {
    return new Promise(done => {
        const socket = createConnection(name); let output = ''; let settled = false;
        const finish = value => { if (!settled) { settled = true; socket.destroy(); done(value); } };
        socket.setTimeout(2000); socket.once('connect', () => socket.write('status\n'));
        socket.on('data', chunk => { output += chunk.toString(); if (output.length > 4096) finish(undefined); else if (output.includes('\n')) { try { finish(JSON.parse(output.split('\n')[0])); } catch { finish(undefined); } } });
        socket.once('error', () => finish(undefined)); socket.once('timeout', () => finish(undefined)); socket.once('end', () => finish(undefined));
    });
}
export async function claimSingleton(root, mode, state) {
    const suffix = repositoryIdentity(root).slice(0, 24) + '-' + mode;
    const name = process.platform === 'win32' ? `\\\\.\\pipe\\vela-replay-${suffix}` : join(tmpdir(), `vela-replay-${suffix}.sock`);
    const server = createServer(socket => {
        socket.setTimeout(2000, () => socket.destroy()); let length = 0;
        socket.on('error', () => {});
        socket.on('data', chunk => { length += chunk.length; if (length > 32) { socket.destroy(); return; } socket.end(JSON.stringify(state()) + '\n'); });
    });
    server.maxConnections = 16;
    const listen = () => new Promise((done, reject) => { server.once('error', reject); server.listen(name, () => { server.off('error', reject); done(); }); });
    try { await listen(); }
    catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
        const existing = await socketRequest(name);
        if (existing) return { existing, state: () => socketRequest(name), close: async () => {} };
        // Windows removes named pipes on exit. Unix can leave an abandoned socket inode.
        if (process.platform === 'win32') throw new Error('Another launcher is starting. Try the shortcut again shortly.');
        const info = await lstat(name).catch(() => undefined);
        if (!info?.isSocket() || info.uid !== process.getuid?.()) throw new Error('The local launcher socket cannot be safely recovered.');
        await unlink(name); await listen();
    }
    return { close: async () => new Promise(done => server.close(() => done())) };
}
export function openApplication(url) {
    if (!/^http:\/\/127\.0\.0\.1:(5197|5198)$/.test(url)) throw new Error('Invalid application window URL.');
    let executable; let args;
    if (process.platform === 'win32') {
        const candidates = [
            join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
            join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
            join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
            ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')] : []),
        ];
        executable = candidates.find(filename => existsSync(filename));
        if (executable) args = [`--app=${url}`];
        else { executable = 'rundll32.exe'; args = ['url.dll,FileProtocolHandler', url]; }
    } else if (process.platform === 'darwin') { executable = 'open'; args = [url]; }
    else { executable = 'xdg-open'; args = [url]; }
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => console.error(`Open ${url} in your browser.`)); child.unref();
}
function spawnOwned(root, args, environment = {}, ipc = true) {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...environment }, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout?.pipe(process.stdout); child.stderr?.pipe(process.stderr);
    const state = { child, exited: false, code: undefined };
    state.exit = new Promise(done => { child.once('exit', code => { state.exited = true; state.code = code; done(); }); child.once('error', () => { state.exited = true; done(); }); });
    return state;
}
function waitMessage(owned, predicate, timeout) {
    return new Promise((done, reject) => {
        const timer = setTimeout(() => finish(new Error('Local process did not respond before its deadline.')), timeout);
        const message = value => { if (predicate(value)) finish(undefined, value); };
        const exit = () => finish(new Error(`Local process exited before readiness (${owned.code ?? 'startup error'}).`));
        const finish = (error, value) => { clearTimeout(timer); owned.child.off('message', message); owned.child.off('exit', exit); owned.child.off('error', exit); error ? reject(error) : done(value); };
        owned.child.on('message', message); owned.child.once('exit', exit); owned.child.once('error', exit);
        if (owned.exited) exit();
    });
}
function send(owned, message) {
    if (!owned || owned.exited || !owned.child.connected) throw new Error('The local backend is no longer connected.');
    owned.child.send(message, error => { if (error) console.error('The local backend disconnected during an update.'); });
}
export async function stopOwned(owned, updateId, timeout = LIMITS.shutdown) {
    if (!owned || owned.exited) return;
    if (updateId) {
        const accepted = waitMessage(owned, value => ['runtime:stopping', 'runtime:shutdown-refused'].includes(value?.type) && value.updateId === updateId, timeout);
        send(owned, { type: 'runtime:shutdown', updateId });
        const reply = await accepted;
        if (reply.type !== 'runtime:stopping') throw new Error('A client joined during the update. The working application was kept.');
    } else if (owned.child.connected) send(owned, { type: 'runtime:shutdown' });
    else owned.child.kill();
    async function waitExit() {
        let timer;
        try { return await Promise.race([owned.exit.then(() => true), new Promise(done => { timer = setTimeout(() => done(false), timeout); })]); }
        finally { clearTimeout(timer); }
    }
    const graceful = await waitExit();
    if (!graceful) {
        owned.child.kill();
        if (!(await waitExit())) throw new Error('The owned process did not stop. Its port remains reserved.');
    }
}
export async function startManagedRuntime({ root, mode, open = true }) {
    root = await realpath(root);
    if (!['run', 'develop'].includes(mode)) throw new Error('Invalid local runtime mode.');
    const repositoryId = repositoryIdentity(root); const backendPort = mode === 'run' ? 5197 : 5199;
    const publicPort = mode === 'run' ? 5197 : 5198; const url = `http://127.0.0.1:${publicPort}`;
    const runtimeRoot = join(root, 'local-app/.runtime', mode); await mkdir(runtimeRoot, { recursive: true });
    let current; let backend; let vite; let building; let closing = false; let ready = false; let updating = false;
    let dirty = true; let debounce; let stopWatching = () => {};
    const singleton = await claimSingleton(root, mode, () => ({ mode, repositoryId, pid: process.pid, ready, instanceId: backend?.instanceId }));
    if (singleton.existing) {
        for (let attempt = 0; attempt < 90; attempt++) {
            const owner = await singleton.state();
            const status = await runtimeStatus(backendPort);
            if (owner?.ready && managedIdentity(status, mode, repositoryId, owner.instanceId) && status.phase !== 'preparing') {
                if (open) openApplication(url);
                console.log(`Reusing ${mode} Replay Studio: ${url}`); return;
            }
            await pause(1000);
        }
        throw new Error('Another launcher exists but its managed backend is not healthy. No process was stopped.');
    }
    async function cleanup() {
        if (closing) return; closing = true; ready = false; clearTimeout(debounce); stopWatching();
        await stopOwned(building).catch(() => {}); await stopOwned(vite).catch(() => {}); await stopOwned(backend).catch(() => {}); await singleton.close();
    }
    const interrupted = () => { void cleanup().then(() => process.exit(0)); };
    process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
    try {
        if (await portOccupied(backendPort) || (mode === 'develop' && await portOccupied(publicPort))) throw new Error(`Port ${backendPort} or ${publicPort} is already in use by an unrelated process. Nothing was stopped.`);
        async function startStage(stage) {
            backend = spawnOwned(root, [join(stage.directory, 'server.mjs')], { VELA_PORT: String(backendPort), VELA_STATIC_DIRECTORY: join(stage.directory, 'client'), VELA_REPOSITORY_DIRECTORY: root, VELA_RUNTIME_MODE: mode, VELA_RUNTIME_VERSION: stage.version });
            const message = await waitMessage(backend, value => value?.type === 'runtime:listening' && value.port === backendPort && value.version === stage.version, LIMITS.startup);
            backend.instanceId = message.instanceId;
            const status = await runtimeStatus(backendPort);
            if (!managedIdentity(status, mode, repositoryId, message.instanceId)) throw new Error('The backend identity did not match this checkout.');
            if (mode === 'develop') {
                vite = spawnOwned(root, [join(root, 'local-app/runtime/develop.mjs'), join(stage.directory, 'vite.config.mjs')], { VELA_RUNTIME_MODE: mode });
                await waitMessage(vite, value => value?.type === 'vite:listening' && value.port === publicPort, LIMITS.startup);
            }
            ready = true; return stage;
        }
        async function prepareUpdate() {
            const updateId = randomUUID(); current.updateId = updateId;
            const waiting = waitMessage(backend, value => value?.type === 'runtime:ready' && value.updateId === updateId, LIMITS.readiness);
            send(backend, { type: 'runtime:prepare', updateId }); await waiting;
        }
        async function performBuild() {
            dirty = false;
            const version = await sourceFingerprint(root);
            if (current?.version === version && backend && !backend.exited && (mode === 'run' || (vite && !vite.exited))) return;
            if (!current) {
                const cached = await readCurrentStage(runtimeRoot, mode, repositoryId);
                if (cached?.version === version && await sourceFingerprint(root) === version) {
                    current = await startStage(cached);
                    console.log(`Replay Studio ${mode} ready from its validated build: ${url} (${version})`);
                    return;
                }
            }
            const stage = { version, directory: join(runtimeRoot, `${version}-${Date.now()}`) };
            console.log(`Preparing ${mode} update ${version}...`);
            building = spawnOwned(root, [join(root, 'local-app/runtime/build.mjs'), root, stage.directory, mode], {}, false);
            let timer;
            try {
                await Promise.race([building.exit.then(() => { if (building.code !== 0) throw new Error('The new build failed; keeping the current application.'); }), new Promise((_done, reject) => { timer = setTimeout(() => reject(new Error('The local build exceeded its deadline.')), LIMITS.build); })]);
                if (closing) return;
                if (await sourceFingerprint(root) !== version) throw new UpdateDeferred('Source changed during build; preparing the newest version.');
                const previous = backend?.exited ? undefined : current;
                current = await transitionRuntime(previous, stage, {
                    prepare: prepareUpdate,
                    isCurrent: async value => !closing && await sourceFingerprint(root) === value.version,
                    cancel: async value => { if (backend && !backend.exited) { send(backend, { type: 'runtime:cancel', updateId: value.updateId }); ready = true; } },
                    stop: async value => { ready = false; await stopOwned(backend, value.updateId); backend = undefined; await stopOwned(vite); vite = undefined; },
                    start: startStage,
                    stopFailed: async () => { await stopOwned(vite); vite = undefined; await stopOwned(backend); backend = undefined; },
                    restored: value => { current = value; console.error('The previous working version was restored.'); },
                });
                await saveCurrentStage(runtimeRoot, current, mode, repositoryId);
                console.log(`Replay Studio ${mode} ready: ${url} (${version})`);
            } catch (error) {
                if (error instanceof UpdateDeferred) dirty = true;
                console.error(error instanceof Error ? error.message : 'The new build failed.');
                if (!current && !closing && !(error instanceof UpdateDeferred)) throw error;
            } finally {
                clearTimeout(timer); await stopOwned(building).catch(() => {}); building = undefined;
            }
        }
        async function rebuild() {
            if (updating || closing) return;
            updating = true;
            try { await performBuild(); }
            finally {
                updating = false;
                if (dirty && !closing) debounce = setTimeout(() => { void rebuild().catch(error => console.error(error.message)); }, 400);
            }
        }
        stopWatching = watchSources(root, () => {
            dirty = true; clearTimeout(debounce);
            debounce = setTimeout(() => { void rebuild().catch(error => console.error(error.message)); }, 700);
        });
        await rebuild();
        while (!current && dirty && !closing) await rebuild();
        if (!current) throw new Error('No current build could be started.');
        if (open) openApplication(url);
        // Keep the named pipe and watchers alive until an explicit process shutdown.
    } catch (error) {
        await cleanup(); throw error;
    }
}
