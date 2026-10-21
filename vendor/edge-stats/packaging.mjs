import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
export const NATIVE_RUNTIME = JSON.parse(await readFile(join(directory, 'native-runtime.json'), 'utf8'));
export const SERVER_EXTERNALS = ['node:*', '@duckdb/*'];
export const MARKET_STATS_WORKER = 'market-stats-worker.mjs';

/** Reject linked source or destination ancestors; native code must come from this install. */
async function regularPath(filename, { missing = false } = {}) {
    const absolute = resolve(filename);
    let current = absolute;
    while (true) {
        let info;
        try { info = await lstat(current); }
        catch (error) { if (missing && error.code === 'ENOENT') { /* Created by the caller below. */ } else throw error; }
        if (info?.isSymbolicLink()) throw new Error('Native runtime paths must not contain links.');
        const parent = dirname(current);
        if (parent === current) return info;
        if (current === absolute && info && !info.isFile() && !info.isDirectory()) throw new Error('Invalid native runtime file.');
        current = parent;
    }
}

export async function stageNativeRuntime(root, output, { platform = process.platform, arch = process.arch } = {}) {
    if (platform !== NATIVE_RUNTIME.platform || arch !== NATIVE_RUNTIME.arch) throw new Error('Native statistics packaging supports Windows x64 only.');
    const copies = [];
    for (const dependency of NATIVE_RUNTIME.packages) {
        const source = join(root, 'node_modules', dependency.name);
        await regularPath(join(source, 'package.json'));
        const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
        if (pkg.name !== dependency.name || pkg.version !== NATIVE_RUNTIME.version) throw new Error('Native statistics dependency version mismatch.');
        for (const filename of dependency.files) {
            if (isAbsolute(filename) || filename.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) throw new Error('Invalid native runtime allowlist.');
            const from = resolve(source, filename);
            if (!from.startsWith(resolve(source) + sep)) throw new Error('Native runtime source escaped its package.');
            const to = join(output, 'node_modules', dependency.name, filename);
            await regularPath(from);
            if (!(await lstat(from)).isFile()) throw new Error('Native runtime source is not a file.');
            await regularPath(to, { missing: true });
            copies.push({ from, to });
        }
    }
    // Validate the whole dependency closure before creating output.
    for (const { from, to } of copies) { await mkdir(dirname(to), { recursive: true }); await copyFile(from, to); }
    return copies.map(({ to }) => to);
}

export function runtimeResourceFiles() {
    return NATIVE_RUNTIME.packages.flatMap(dependency => dependency.files.map(filename => `node_modules/${dependency.name}/${filename}`));
}

export async function bundleMarketStatsWorker(root, output, bundle) {
    return bundle({ entryPoints: [join(root, 'local-app/server/market-stats/worker.ts')], outfile: join(output, MARKET_STATS_WORKER),
        bundle: true, platform: 'node', format: 'esm', target: 'node24', external: SERVER_EXTERNALS, logLevel: 'warning' });
}

export async function edgeStatsNotices(root) {
    const source = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'));
    const notices = [`Edge Stats ${source.version} (MIT)\n${source.repository}\nCommit ${source.commit}`, await readFile(join(directory, 'LICENSE'), 'utf8')];
    for (const [name, license] of [...NATIVE_RUNTIME.packages.map(item => [item.name, 'LICENSE']), ['luxon', 'LICENSE.md'], ['zod', 'LICENSE']]) {
        const folder = join(root, 'node_modules', name);
        const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
        notices.push(`${pkg.name} ${pkg.version} (${pkg.license})`, await readFile(join(folder, license), 'utf8'));
    }
    notices.push('Calendar data from Edge Stats by LuxAlgo (github.com/LuxAlgo/edge-stats). Pinned event and exchange-calendar compilations are distributed unchanged under CC BY 4.0: https://creativecommons.org/licenses/by/4.0/',
        await readFile(join(directory, 'DATA_LICENSE'), 'utf8'));
    return notices;
}
