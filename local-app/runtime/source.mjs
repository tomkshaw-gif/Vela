import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync, lstatSync, watch } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT_FILES = new Set(['package.json', 'package-lock.json', 'tsconfig.json']);
const OMITTED = new Set(['test', 'tests', '__tests__', 'docs', 'node_modules', '.runtime', 'dist', 'staging', 'releases']);
export function relevantSource(filename) {
    const parts = filename.split(/[\\/]/);
    if (parts.length === 1) return ROOT_FILES.has(filename);
    if (parts.some(part => OMITTED.has(part)) || /\.(?:test|spec)\.[^.]+$/.test(filename)) return false;
    const vendor = parts[0] === 'vendor' && parts[1] === 'edge-stats';
    return vendor || (parts[0] === 'src' || parts[0] === 'local-app') && /\.(?:ts|mts|cts|js|mjs|css|html|json|svg)$/.test(filename);
}
export async function sourceFingerprint(root) {
    const filenames = [];
    async function walk(directory) {
        for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
            const filename = join(directory, item.name);
            if (item.isDirectory()) {
                if (!OMITTED.has(item.name)) await walk(filename);
            } else if (item.isFile() && relevantSource(filename)) filenames.push(filename);
        }
    }
    await walk('src'); await walk('local-app');
    const vendor = await lstat(join(root, 'vendor/edge-stats')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (vendor?.isSymbolicLink()) throw new Error('Vendored source must not be linked outside the checkout.');
    if (vendor?.isDirectory()) await walk('vendor/edge-stats');
    for (const filename of ROOT_FILES) if (await stat(join(root, filename)).then(value => value.isFile(), () => false)) filenames.push(filename);
    const hash = createHash('sha256');
    for (const filename of filenames.sort()) hash.update(filename.split(sep).join('/')).update('\0').update(await readFile(join(root, filename))).update('\0');
    return hash.digest('hex').slice(0, 16);
}
export function watchSources(root, onChange) {
    const watchers = [];
    const directories = ['src', 'local-app', '.'];
    const vendor = join(root, 'vendor/edge-stats');
    if (existsSync(vendor)) {
        if (lstatSync(vendor).isSymbolicLink()) throw new Error('Vendored source must not be linked outside the checkout.');
        directories.push('vendor/edge-stats');
    }
    for (const directory of directories) {
        const watcher = watch(join(root, directory), { recursive: directory !== '.' }, (_event, filename) => {
            if (!filename) { onChange(); return; }
            const path = relative(root, join(root, directory, filename.toString()));
            if (relevantSource(path)) onChange();
        });
        watcher.on('error', error => console.error(`Source watcher: ${error.message}`));
        watchers.push(watcher);
    }
    return () => { for (const watcher of watchers) watcher.close(); };
}
