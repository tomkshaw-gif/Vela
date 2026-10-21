import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Importing this module is inert; only Electron's utility entry point starts a server. */
export async function startBackend({ port = process.parentPort, runtimeDirectory, repositoryDirectory, version, load = url => import(url), exit = code => process.exit(code) }) {
    if (!port || Number(process.versions.node.split('.')[0]) < 24) throw new Error('The desktop backend requires Electron with Node 24 or newer.');
    if (typeof version !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(version)) throw new Error('Invalid desktop version.');
    const probe = new DatabaseSync(':memory:');
    try { probe.prepare('SELECT 1 AS ready').get(); } finally { probe.close(); }
    const directory = resolve(runtimeDirectory);
    const { createReplayServer } = await load(pathToFileURL(join(directory, 'server.mjs')).href);
    // Browser drafts and templates are origin-scoped. Never fall back to another port.
    const backend = await createReplayServer({ port: 5196, staticDirectory: join(directory, 'client'),
        repositoryDirectory: resolve(repositoryDirectory), runtime: { mode: 'run', version } });
    let stopping;
    const shutdown = () => {
        if (!stopping) stopping = backend.close().then(() => exit(0)).catch(() => {
            port.postMessage({ type: 'backend:shutdown-failed' });
        });
        return stopping;
    };
    port.on('message', ({ data }) => { if (data?.type === 'backend:shutdown') void shutdown(); });
    try {
        const url = await backend.listen();
        const address = new URL(url);
        if (address.origin !== 'http://127.0.0.1:5196' || address.pathname !== '/' || address.username || address.password || address.search || address.hash) throw new Error('Invalid desktop loopback address.');
        port.postMessage({ type: 'backend:ready', url, node: process.versions.node, sqlite: true });
    } catch (error) { await backend.close(); throw error; }
    return { shutdown };
}

if (process.parentPort && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    const [runtimeDirectory, version, repositoryDirectory] = process.argv.slice(2);
    void startBackend({ runtimeDirectory, version, repositoryDirectory }).catch(() => {
        process.parentPort.postMessage({ type: 'backend:failed' }); process.exit(1);
    });
}
