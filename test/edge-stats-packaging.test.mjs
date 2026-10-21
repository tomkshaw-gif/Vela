import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { bundleMarketStatsWorker, edgeStatsNotices, MARKET_STATS_WORKER, NATIVE_RUNTIME, runtimeResourceFiles, SERVER_EXTERNALS, stageNativeRuntime } from '../vendor/edge-stats/packaging.mjs';
import { relevantSource, sourceFingerprint, watchSources } from '../local-app/runtime/source.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const owned = new Set();
async function temporary() { const directory = await mkdtemp(join(tmpdir(), 'vela-edge-pack-')); owned.add(directory); return directory; }
afterAll(async () => {
    for (const directory of owned) {
        const absolute = await realpath(directory);
        if (dirname(absolute) !== await realpath(tmpdir()) || !absolute.startsWith(join(await realpath(tmpdir()), 'vela-edge-pack-'))) throw new Error('Invalid owned packaging fixture.');
        await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

async function files(directory) {
    const output = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = join(directory, entry.name);
        if (entry.isDirectory()) output.push(...await files(target));
        else if (entry.isFile()) output.push(target);
        else throw new Error('Unexpected linked packaging fixture.');
    }
    return output;
}
function childEnvironment() {
    const environment = {};
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'LOCALAPPDATA']) if (process.env[key]) environment[key] = process.env[key];
    return environment;
}
function run(executable, args, cwd, timeout = 30_000) {
    return new Promise((done, reject) => {
        const child = spawn(executable, args, { cwd, env: childEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = ''; let finished = false;
        const timer = setTimeout(() => { child.kill(); finish(new Error('Owned native probe timed out.')); }, timeout);
        const finish = (error, result) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : done(result); };
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', error => finish(error));
        child.once('exit', code => code === 0 ? finish(undefined, { stdout, stderr }) : finish(new Error(`Owned native probe failed (${code}): ${stderr.slice(-3000)}`)));
    });
}

describe('pinned statistics package', () => {
    it('preserves every upstream source byte and the MIT license', async () => {
        const folder = join(root, 'vendor/edge-stats');
        const provenance = JSON.parse(await readFile(join(folder, 'provenance.json'), 'utf8'));
        expect(provenance.commit).toBe('a48259887962d0f67a27d2b0815e2df9a52efca5');
        expect(provenance.sourceFiles.filter(item => item.path.startsWith('src/'))).toHaveLength(29);
        for (const source of provenance.sourceFiles) {
            const content = await readFile(join(folder, source.path));
            expect(content.length).toBe(source.bytes);
            expect(createHash('sha256').update(content).digest('hex')).toBe(source.sha256);
            expect(source.url).toContain(`/LuxAlgo/edge-stats/${provenance.commit}/`);
        }
        expect((await files(join(folder, 'src'))).map(filename => relative(folder, filename).split(sep).join('/')).sort())
            .toEqual(provenance.sourceFiles.filter(item => item.path.startsWith('src/')).map(item => item.path).sort());
    });

    it('bundles the actual API without network adapters and keeps native modules external', async () => {
        const output = await build({ entryPoints: [join(root, 'vendor/edge-stats/index.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node24', external: SERVER_EXTERNALS, metafile: true, write: false, logLevel: 'silent' });
        const inputs = Object.keys(output.metafile.inputs).map(value => value.replaceAll('\\', '/'));
        expect(inputs.some(value => /edge-stats\/src\/query\/execute\.ts$/.test(value))).toBe(true);
        expect(inputs.some(value => /edge-stats\/src\/features\/derive\.ts$/.test(value))).toBe(true);
        expect(inputs.some(value => /(?:dukascopy-node|fflate|edge-stats\/src\/(?:adapters|sync|live|events|trades))/.test(value))).toBe(false);
        const externals = Object.values(output.metafile.outputs).flatMap(value => value.imports.filter(item => item.external).map(item => item.path));
        expect(externals).toContain('@duckdb/node-api');
        expect(externals.every(value => value.startsWith('node:') || value.startsWith('@duckdb/'))).toBe(true);
    });

    it('ships only the explicit native file closure outside asar', async () => {
        const require = createRequire(import.meta.url);
        const config = require('../local-app/electron/builder.config.cjs');
        const resource = config.extraResources.find(value => value.to === 'app-runtime');
        expect(config.asar).toBe(true); expect(config.files).toContain('!**/node_modules{,/**/*}');
        expect(resource.filter).toContain(MARKET_STATS_WORKER);
        expect(resource.filter.filter(value => value.startsWith('node_modules/')).sort()).toEqual(runtimeResourceFiles().sort());
        expect(NATIVE_RUNTIME.packages.map(value => value.name)).toEqual(['@duckdb/node-api', '@duckdb/node-bindings', '@duckdb/node-bindings-win32-x64']);
        expect(runtimeResourceFiles().some(value => value.endsWith('/duckdb.node'))).toBe(true);
        expect(runtimeResourceFiles().some(value => value.endsWith('/duckdb.dll'))).toBe(true);
        expect(runtimeResourceFiles().some(value => value.includes('*'))).toBe(false);
        for (const filename of ['local-app/runtime/build.mjs', 'local-app/electron/build.mjs']) {
            const source = await readFile(join(root, filename), 'utf8');
            expect(source).toContain('external: SERVER_EXTERNALS');
            expect(source).toContain('await bundleMarketStatsWorker(root,');
            expect(source).toContain('await stageNativeRuntime(root,');
        }
    });

    it('runs the registry catalog from an isolated bundle without importing native DuckDB', async () => {
        const fixture = await temporary(); const entry = join(fixture, 'registry.mjs');
        const bundle = await build({ stdin: { contents: `import {describeRegistry} from '@luxalgo/edge-stats/registry'; console.log(JSON.stringify(describeRegistry()));`, resolveDir: root, loader: 'ts' },
            outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'node24', external: SERVER_EXTERNALS, metafile: true, logLevel: 'silent' });
        const inputs = Object.keys(bundle.metafile.inputs).map(value => value.replaceAll('\\', '/'));
        expect(inputs.some(value => /@duckdb|edge-stats\/src\/store|edge-stats\/index\.ts/.test(value))).toBe(false);
        const imports = Object.values(bundle.metafile.outputs).flatMap(value => value.imports);
        expect(imports.some(value => value.path.startsWith('@duckdb/'))).toBe(false);
        const { stdout } = await run(process.execPath, [entry], fixture);
        const registry = JSON.parse(stdout);
        expect(registry).toEqual(expect.any(Array)); expect(registry.length).toBeGreaterThan(0);
        expect(registry.some(value => value.name === 'closeGreen')).toBe(true);
    });

    it('retains complete engine, DuckDB, Luxon and Zod legal notices', async () => {
        const notices = (await edgeStatsNotices(root)).join('\n');
        for (const text of ['Edge Stats 0.1.0 (MIT)', 'Copyright (c) 2026 LuxAlgo Global, LLC', 'Stichting DuckDB Foundation', 'luxon 3.7.2 (MIT)', 'zod 4.6.7 (MIT)', 'THE SOFTWARE IS PROVIDED "AS IS"']) expect(notices).toContain(text);
        expect(notices).toContain('Calendar data from Edge Stats by LuxAlgo (github.com/LuxAlgo/edge-stats)');
        expect(notices).toContain('Creative Commons Attribution 4.0 International');
    });

    it('validates dependencies before writing output and rejects source links', async () => {
        const fixture = await temporary(); const source = join(fixture, 'source'); const output = join(fixture, 'output');
        const api = join(source, 'node_modules/@duckdb/node-api'); await mkdir(api, { recursive: true });
        await writeFile(join(api, 'package.json'), JSON.stringify({ name: '@duckdb/node-api', version: '0.0.0' }));
        await expect(stageNativeRuntime(source, output, { platform: 'win32', arch: 'x64' })).rejects.toThrow('version mismatch');
        expect(existsSync(output)).toBe(false);
        await expect(stageNativeRuntime(source, output, { platform: 'linux', arch: 'x64' })).rejects.toThrow('Windows x64');
        if (process.platform === 'win32') {
            const linkedRoot = join(fixture, 'linked'); await mkdir(join(linkedRoot, 'node_modules/@duckdb'), { recursive: true });
            await symlink(join(root, 'node_modules/@duckdb/node-api'), join(linkedRoot, 'node_modules/@duckdb/node-api'), 'junction');
            await expect(stageNativeRuntime(linkedRoot, output, { platform: 'win32', arch: 'x64' })).rejects.toThrow('links');
        }
    });
});

describe('vendored source invalidation', () => {
    it('includes this vendor source, wrapper, metadata and license while retaining existing exclusions', () => {
        for (const name of ['vendor/edge-stats/src/query/execute.ts', 'vendor/edge-stats/index.ts', 'vendor/edge-stats/package.json', 'vendor/edge-stats/LICENSE', 'vendor/edge-stats/native-runtime.json',
            'vendor/edge-stats/presets/orb.json', 'vendor/edge-stats/preset-catalog.mjs', 'vendor/edge-stats/data/events/cpi.json', 'vendor/edge-stats/DATA_LICENSE']) expect(relevantSource(name)).toBe(true);
        for (const name of ['vendor/unrelated/src/index.ts', 'vendor/edge-stats/node_modules/a/index.js', 'vendor/edge-stats/test/a.test.ts', 'local-app/electron/staging/app-runtime/server.mjs', 'docs/guide.md']) expect(relevantSource(name)).toBe(false);
    });
    it.each(['run', 'develop'])('invalidates the %s source fingerprint and watcher on vendor content changes', async () => {
        const fixture = await temporary(); await mkdir(join(fixture, 'src')); await mkdir(join(fixture, 'local-app'));
        const vendor = join(fixture, 'vendor/edge-stats/presets'); await mkdir(vendor, { recursive: true });
        const entry = join(vendor, 'orb.json'); await writeFile(entry, '{"version":1}');
        const first = await sourceFingerprint(fixture); let stop;
        try {
            const notified = new Promise((done, reject) => {
                const timer = setTimeout(() => reject(new Error('Vendor watcher did not notify.')), 3000);
                stop = watchSources(fixture, () => { clearTimeout(timer); done(); });
            });
            await writeFile(entry, '{"version":2}'); await notified;
            expect(await sourceFingerprint(fixture)).not.toBe(first);
            const second = await sourceFingerprint(fixture);
            await writeFile(join(fixture, 'vendor/edge-stats/LICENSE'), 'license');
            expect(await sourceFingerprint(fixture)).not.toBe(second);
        } finally { stop?.(); }
    });
});

const windowsNative = process.platform === 'win32' && process.arch === 'x64';
describe.skipIf(!windowsNative)('isolated Windows native runtime', () => {
    let fixture; let runtime; let entry; let workerProbe;
    beforeAll(async () => {
        fixture = await temporary(); runtime = join(fixture, 'resources/app-runtime');
        await stageNativeRuntime(root, runtime);
        entry = join(runtime, 'native-probe.mjs');
        await build({ stdin: { contents: `import { Store, ENGINE_VERSION, configSchema } from '@luxalgo/edge-stats';
import { DateTime } from 'luxon';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const dataDirectory = process.argv[2];
const store = await Store.open(dataDirectory);
let result;
try {
  await store.ingestBars([{symbol:'PACK',tf:'1m',ts:Date.UTC(2024,0,2),open:100,high:102,low:99,close:101,volume:1}], null);
  const row = await store.one('SELECT count(*)::INTEGER AS bars, sum(close)::DOUBLE AS total FROM bars');
  const nativePath = createRequire(import.meta.url).resolve('@duckdb/node-bindings-win32-x64/duckdb.node');
  result = { engine: ENGINE_VERSION, node: process.versions.node, electron: process.versions.electron ?? null, row, nativePath, timezone: DateTime.fromISO('2024-01-02T09:30:00', {zone:'America/New_York'}).toUTC().hour, minN: configSchema.parse({}).minN };
} finally { await store.close(); }
console.log('VELA_EDGE_NATIVE=' + JSON.stringify(result));
process.parentPort?.postMessage(result);
if (process.parentPort) setImmediate(() => process.exit(0));
`, resolveDir: root, loader: 'ts' }, outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'node24', external: SERVER_EXTERNALS, logLevel: 'silent' });
    });

    it('loads only staged dependencies in Node 24 without project ancestry or NODE_PATH', async () => {
        expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(24);
        const { stdout } = await run(process.execPath, [entry, join(fixture, 'node-store')], fixture);
        const result = JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith('VELA_EDGE_NATIVE=')).slice('VELA_EDGE_NATIVE='.length));
        expect(result.engine).toBe('0.1.0'); expect(result.row).toEqual({ bars: 1, total: 101 }); expect(result.timezone).toBe(14);
        expect(result.nativePath.startsWith(join(runtime, 'node_modules'))).toBe(true);
        expect(result.minN).toEqual({ warn: 30, refuse: 10 });
        const stagedFiles = (await files(join(runtime, 'node_modules'))).map(filename => relative(runtime, filename).split(sep).join('/')).sort();
        expect(stagedFiles).toEqual(runtimeResourceFiles().sort());
    });

    it.skipIf(!existsSync(join(root, 'node_modules/electron/dist/electron.exe')))('loads native DuckDB in Electron 44 utilityProcess with an isolated profile', async () => {
        const main = join(fixture, 'electron-main.cjs'); const store = join(fixture, 'electron-store');
        await writeFile(main, `const {app,utilityProcess}=require('electron');
app.setPath('userData',${JSON.stringify(join(fixture, 'profile'))});
app.setPath('sessionData',${JSON.stringify(join(fixture, 'profile'))});
app.disableHardwareAcceleration();
let worker;
const timer=setTimeout(()=>{worker?.kill();app.exit(2);},20000);
app.whenReady().then(()=>{
worker=utilityProcess.fork(${JSON.stringify(entry)},[${JSON.stringify(store)}],{stdio:'pipe',env:${JSON.stringify(childEnvironment())}});
worker.stderr.on('data',chunk=>process.stderr.write(chunk));
worker.on('message',message=>{console.log('VELA_EDGE_ELECTRON='+JSON.stringify(message));});
worker.on('exit',code=>{clearTimeout(timer);app.exit(code===0?0:3);});
});
`);
        const { stdout } = await run(join(root, 'node_modules/electron/dist/electron.exe'), [main], fixture);
        const result = JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith('VELA_EDGE_ELECTRON=')).slice('VELA_EDGE_ELECTRON='.length));
        expect(result.electron.split('.')[0]).toBe('44'); expect(Number(result.node.split('.')[0])).toBeGreaterThanOrEqual(24);
        expect(result.row).toEqual({ bars: 1, total: 101 }); expect(result.nativePath.startsWith(join(runtime, 'node_modules'))).toBe(true);
    }, 30_000);

    it('bundles the separately owned worker next to the server resource', async () => {
        await bundleMarketStatsWorker(root, runtime, build);
        expect((await readFile(join(runtime, MARKET_STATS_WORKER), 'utf8'))).toContain('@duckdb/node-api');
    });

    it('executes the compiled worker through its real factory and disposes the native scratch store', async () => {
        await bundleMarketStatsWorker(root, runtime, build);
        workerProbe = join(runtime, 'worker-probe.mjs');
        await build({ stdin: { contents: `import {createNodeMarketStatsJobFactory} from './local-app/server/market-stats/node-job';
import {prepareMarketStats} from './local-app/server/market-stats/prepare';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readdir} from 'node:fs/promises';
const start=Date.UTC(2024,0,2);
const input=await prepareMarketStats({bars:[0,1,2].map(i=>({time:start+i*60000,open:100,high:102,low:99,close:101,volume:1})),symbol:'PACK',assetClass:'crypto',sourceIntervalMs:60000,revealedUntil:start+180000,session:{key:'test',start:'00:00',end:'00:03',tz:'UTC',overnight:false},calendar:null,orWindows:[1],ibWindow:1,query:{dsl:'closeGreen'}});
const scratch=process.argv[2];
const startJob=createNodeMarketStatsJobFactory({workerUrl:new URL('./${MARKET_STATS_WORKER}',import.meta.url),scratchDirectory:scratch});
const job=startJob(input); let result;
try { result=await job.result; } finally { await job.dispose(); }
console.log('VELA_EDGE_WORKER='+JSON.stringify({n:result.n,engine:result.engineVersion,remaining:(await readdir(scratch)).length}));
`, resolveDir: root, loader: 'ts' }, outfile: workerProbe, bundle: true, platform: 'node', format: 'esm', target: 'node24', external: SERVER_EXTERNALS, logLevel: 'silent' });
        const { stdout } = await run(process.execPath, [workerProbe, join(fixture, 'worker-jobs')], fixture);
        const result = JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith('VELA_EDGE_WORKER=')).slice('VELA_EDGE_WORKER='.length));
        expect(result.n).toBeGreaterThanOrEqual(0); expect(result.remaining).toBe(0);
    });
});
