import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { build as buildClient } from 'vite';
import { buildIcon } from './icon.mjs';

const directory = dirname(fileURLToPath(import.meta.url)); const root = resolve(directory, '../..');
const stage = join(directory, 'staging'); const app = join(stage, 'app'); const runtime = join(stage, 'app-runtime');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = process.env.VELA_DESKTOP_VERSION ?? '1.0.0';
if (!/^[1-9]\d*\.\d+\.\d+$/.test(version)) throw new Error('Use a stable desktop semantic version.');
async function run(script, args = [], env = process.env) {
    await new Promise((done, reject) => {
        const child = spawn(process.execPath, [script, ...args], { cwd: root, env, stdio: 'inherit', windowsHide: true });
        child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error('Desktop command failed.')));
    });
}
try { await access(join(root, 'node_modules/electron/dist/electron.exe')); }
catch { await run(join(root, 'node_modules/electron/install.js')); }
await mkdir(app, { recursive: true }); await mkdir(runtime, { recursive: true });
await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'vela-desktop', version, private: true, main: 'main.cjs', description: 'Local Vela replay and strategy workspace', author: 'Tom Shaw', license: 'AGPL-3.0-only', repository: { type: 'git', url: 'https://github.com/tomkshaw-gif/Vela.git' } }, null, 2) + '\n');
for (const name of ['main.cjs', 'preload.cjs', 'lifecycle.cjs', 'updates.cjs']) await copyFile(join(directory, name), join(app, name));
await build({ entryPoints: [join(directory, 'updater.cjs')], outfile: join(app, 'updater.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'node:*'], logLevel: 'warning' });
await copyFile(join(directory, 'backend.mjs'), join(runtime, 'backend.mjs'));
await build({ entryPoints: [join(root, 'local-app/server/index.ts')], outfile: join(runtime, 'server.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['node:*'], logLevel: 'warning' });
const previous = process.env.VELA_DESKTOP_EXTERNAL_APPEARANCE; process.env.VELA_DESKTOP_EXTERNAL_APPEARANCE = '1';
try { await buildClient({ configFile: join(root, 'local-app/vite.config.ts'), build: { outDir: join(runtime, 'client'), emptyOutDir: true } }); }
finally { if (previous === undefined) delete process.env.VELA_DESKTOP_EXTERNAL_APPEARANCE; else process.env.VELA_DESKTOP_EXTERNAL_APPEARANCE = previous; }
for (const name of ['LICENSE', 'NOTICE']) await copyFile(join(root, name), join(app, name));
const notices = ['Vela desktop combines the Apache-2.0 Vela library with AGPL-3.0-only scripting addons.',
    'Source and updates: https://github.com/tomkshaw-gif/Vela',
    'Machine-local appearance extensions are separate from this installer.'];
for (const name of ['@luxalgo/vela-pinets', 'pinets', 'electron-updater']) {
    const folder = join(root, 'node_modules', name); const dependency = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
    notices.push(`\n${name} ${dependency.version} (${dependency.license})`);
    for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE']) {
        try { notices.push(await readFile(join(folder, file), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}
for (const [family, file] of [['Nunito Sans', 'NunitoSans-OFL.txt'], ['Lato', 'Lato-OFL.txt']]) {
    notices.push(`\n${family} (SIL Open Font License 1.1)`,
        await readFile(join(root, 'local-app/client/fonts', file), 'utf8'));
}
await writeFile(join(app, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n') + '\n');
await buildIcon(join(stage, 'icons'));
console.log(`Desktop ${version} staged with Electron ${pkg.devDependencies.electron}.`);
if (process.argv.includes('--dist')) {
    const extra = process.argv.slice(2).filter(value => value !== '--dist');
    await run(join(root, 'node_modules/electron-builder/cli.js'), ['--config', join(directory, 'builder.config.cjs'), '--win', '--x64', ...extra], { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? 'false' });
}
