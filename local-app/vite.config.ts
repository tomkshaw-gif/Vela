import { defineConfig } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { localDrawingIcons, localResultsChart } from './local-ui-plugin';
import { localPineWorker } from './pine-worker-plugin';

// Module invalidation still runs. Only the supervisor may ask clients to reload.
export function coordinatedUpdates(): Plugin {
    return {
        name: 'local-coordinated-updates',
        apply: 'serve',
        configureServer(server: ViteDevServer) {
            const guarded = new WeakSet<object>();
            const guard = (channel: { send: (...args: unknown[]) => unknown }) => {
                if (guarded.has(channel)) return; guarded.add(channel);
                const send = channel.send.bind(channel);
                channel.send = (...args: unknown[]) => {
                    const payload = args[0];
                    if (payload && typeof payload === 'object' && 'type' in payload && ['update', 'full-reload', 'error'].includes(String(payload.type))) return;
                    return send(...args);
                };
            };
            guard(server.ws as unknown as Parameters<typeof guard>[0]);
            for (const environment of Object.values(server.environments)) guard(environment.hot as unknown as Parameters<typeof guard>[0]);
        },
        hotUpdate() { return []; },
    };
}
export default defineConfig({
    root: fileURLToPath(new URL('./client', import.meta.url)),
    plugins: [coordinatedUpdates(), localDrawingIcons(undefined, process.env.VELA_DESKTOP_EXTERNAL_APPEARANCE === '1'),
        localResultsChart(undefined, undefined, process.env.VELA_DESKTOP_EXTERNAL_APPEARANCE === '1'), localPineWorker()],
    optimizeDeps: { exclude: ['@luxalgo/vela-pinets'] },
    build: {
        outDir: fileURLToPath(new URL('./dist', import.meta.url)),
        emptyOutDir: true,
        sourcemap: false,
        target: 'es2022',
        chunkSizeWarningLimit: 1600,
    },
    server: {
        host: '127.0.0.1', port: 5198, strictPort: true,
        headers: {
            'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws://127.0.0.1:5198; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'X-Frame-Options': 'DENY',
        },
        proxy: {
            '^/api/': {
                target: 'http://127.0.0.1:5199', changeOrigin: true,
                configure(proxy) {
                    proxy.on('proxyReq', (outgoing, incoming) => {
                        if (incoming.headers.origin === 'http://127.0.0.1:5198') {
                            outgoing.setHeader('origin', 'http://127.0.0.1:5199');
                        }
                    });
                },
            },
        },
    },
});
