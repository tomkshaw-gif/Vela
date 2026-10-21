import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import config from '../vite.config';

it('serves the client API module locally and proxies only API routes', async () => {
    const received: string[] = [];
    const backend = createHttpServer((request, response) => {
        received.push(request.url ?? '');
        response.writeHead(207, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ service: 'local-runtime', path: request.url }));
    });
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vela-dev-proxy-'));
    let vite: ViteDevServer | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            backend.once('error', reject);
            backend.listen(0, '127.0.0.1', resolve);
        });
        const backendAddress = backend.address() as AddressInfo;
        const proxies = Object.entries(config.server?.proxy ?? {});
        expect(proxies.length).toBeGreaterThan(0);
        const target = `http://127.0.0.1:${backendAddress.port}`;
        vite = await createServer({
            ...config,
            configFile: false,
            cacheDir: cacheDirectory,
            logLevel: 'silent',
            optimizeDeps: { noDiscovery: true, entries: [] },
            server: {
                ...config.server,
                host: '127.0.0.1',
                port: 0,
                strictPort: false,
                watch: null,
                proxy: Object.fromEntries(proxies.map(([pattern, proxy]) => [
                    pattern, typeof proxy === 'string' ? { target } : { ...proxy, target },
                ])),
            },
        });
        await vite.listen();
        const address = vite.httpServer?.address() as AddressInfo;
        const origin = `http://127.0.0.1:${address.port}`;

        const module = await fetch(`${origin}/api.ts`);
        expect(module.status).toBe(200);
        expect(module.headers.get('Content-Type')).toContain('javascript');
        expect(await module.text()).toContain('class LocalApi');
        expect(received).toEqual([]);

        const runtime = await fetch(`${origin}/api/runtime`);
        expect(runtime.status).toBe(207);
        expect(await runtime.json()).toEqual({ service: 'local-runtime', path: '/api/runtime' });
        expect(received).toEqual(['/api/runtime']);
    } finally {
        await vite?.close();
        backend.closeAllConnections();
        await new Promise<void>((resolve) => backend.close(() => resolve()));
        await rm(cacheDirectory, { recursive: true, force: true });
    }
}, 20_000);
