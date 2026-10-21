import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build as bundle } from 'esbuild';
import { build as buildClient } from 'vite';

const [rootArgument, outputArgument, mode] = process.argv.slice(2);
if (!rootArgument || !outputArgument || !['run', 'develop'].includes(mode)) throw new Error('Invalid local build arguments.');
const root = resolve(rootArgument); const output = resolve(outputArgument);
if (mode === 'run') {
    await new Promise((done, reject) => {
        const child = spawn(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'local-app/tsconfig.json'), '--noEmit'], { cwd: root, stdio: 'inherit', windowsHide: true });
        child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error('Local typecheck failed.')));
    });
}
await mkdir(output, { recursive: true });
await bundle({ entryPoints: [join(root, 'local-app/server/index.ts')], outfile: join(output, 'server.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['node:*'], sourcemap: false, logLevel: 'warning' });
const config = join(root, 'local-app/vite.config.ts');
await bundle({ entryPoints: [config], outfile: join(output, 'vite.config.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', define: { 'import.meta.url': JSON.stringify(pathToFileURL(config).href) }, logLevel: 'warning' });
await buildClient({ configFile: join(output, 'vite.config.mjs'), build: { outDir: join(output, 'client'), emptyOutDir: false } });
