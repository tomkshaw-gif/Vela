import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

async function artifactFingerprint(directory) {
    for (const filename of ['server.mjs', 'vite.config.mjs', 'client/index.html']) if (!(await stat(join(directory, filename))).isFile()) throw new Error('Incomplete local build.');
    const hash = createHash('sha256');
    async function walk(relative) {
        const entries = await readdir(join(directory, relative), { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const name = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) await walk(name);
            else if (entry.isFile()) hash.update(name).update('\0').update(await readFile(join(directory, name))).update('\0');
            else throw new Error('Local build contains a linked or unsupported artifact.');
        }
    }
    await walk(''); return hash.digest('hex');
}
export async function readCurrentStage(runtimeRoot, mode, repositoryId) {
    try {
        const manifest = JSON.parse(await readFile(join(runtimeRoot, 'current.json'), 'utf8'));
        if (manifest.format !== 1 || manifest.mode !== mode || manifest.repositoryId !== repositoryId || !/^[a-f0-9]{16}$/.test(manifest.version) || typeof manifest.directory !== 'string' || basename(manifest.directory) !== manifest.directory || !/^[a-f0-9]{16}-[0-9]+$/.test(manifest.directory)) return undefined;
        const directory = resolve(runtimeRoot, manifest.directory);
        if (dirname(directory) !== resolve(runtimeRoot) || await realpath(directory) !== directory || await artifactFingerprint(directory) !== manifest.artifacts) return undefined;
        return { version: manifest.version, directory };
    } catch { return undefined; }
}
export async function saveCurrentStage(runtimeRoot, stage, mode, repositoryId) {
    if (dirname(resolve(stage.directory)) !== resolve(runtimeRoot)) throw new Error('Build cache must stay within its mode directory.');
    const manifest = { format: 1, mode, repositoryId, version: stage.version, directory: basename(stage.directory), artifacts: await artifactFingerprint(stage.directory) };
    const temporary = join(runtimeRoot, `current-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(runtimeRoot, 'current.json'));
}
