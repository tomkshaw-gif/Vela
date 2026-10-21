import type { Plugin } from 'vite';
import { createRequire } from 'node:module';
import { loadPineHostSource, loadPineWorkerSource } from './scripting/worker-source.mjs';

export const PINE_WORKER_CSP = "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'; object-src 'none'";

/** The compiler's evaluation permission belongs only to its isolated worker. */
export function localPineWorker(): Plugin {
    let source: Promise<string> | undefined;
    const entry = createRequire(import.meta.url).resolve('@luxalgo/vela-pinets').replace(/\\/g, '/').replace(/\.cjs$/, '.js');
    const read = (): Promise<string> => source ??= loadPineWorkerSource();
    return {
        name: 'local-pine-worker',
        enforce: 'pre',
        async transform(_code, id) {
            if (id.split('?')[0]!.replace(/\\/g, '/') !== entry) return;
            return { code: await loadPineHostSource(), map: null };
        },
        async buildStart() {
            this.emitFile({ type: 'asset', fileName: 'local-pine-worker.js', source: await read() });
        },
        configureServer(server) {
            server.middlewares.use('/local-pine-worker.js', (_request, response, next) => {
                void read().then((worker) => {
                    response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                    response.setHeader('Content-Security-Policy', PINE_WORKER_CSP);
                    response.setHeader('Cache-Control', 'no-store');
                    response.end(worker);
                }).catch(next);
            });
        },
    };
}
