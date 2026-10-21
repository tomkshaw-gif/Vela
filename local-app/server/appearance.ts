import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { AppError } from './errors';

/** A fixed, bounded local extension survives application upgrades outside the installer. */
export async function appearanceModule(dataDirectory: string, kind: 'drawing-icons' | 'results-chart'): Promise<string> {
    const directory = join(dataDirectory, 'appearance');
    const read = async (name: string, limit: number): Promise<string | undefined> => {
        try {
            if ((await lstat(directory)).isSymbolicLink()) throw new Error('linked appearance directory');
            const root = await realpath(directory); const file = await realpath(join(root, name));
            if (!file.startsWith(root + sep) || !(await stat(file)).isFile() || (await stat(file)).size > limit) throw new Error('invalid appearance asset');
            const content = await readFile(file, 'utf8');
            if (Buffer.byteLength(content) > limit) throw new Error('oversized appearance asset');
            return content;
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
            throw new AppError(500, 'The local appearance extension is invalid.');
        }
    };
    if (kind === 'drawing-icons') {
        const raw = await read('drawing-icons.json', 256_000);
        if (raw === undefined) return 'export default {};';
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { throw new AppError(500, 'The local drawing extension is invalid.'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > 128) throw new AppError(500, 'The local drawing extension is invalid.');
        const icons = Object.fromEntries(Object.entries(parsed).filter(([key, value]) => /^[a-z][a-z0-9-]{0,50}$/.test(key) && typeof value === 'string' && value.length <= 12_000));
        return `export default ${JSON.stringify(icons)};`;
    }
    const [code, raw] = await Promise.all([read('results-chart.mjs', 512_000), read('results-chart.json', 16_000)]);
    if (code === undefined && raw === undefined) return 'export default null;';
    if (code === undefined || raw === undefined) throw new AppError(500, 'The local results extension is incomplete.');
    let manifest: unknown;
    try { manifest = JSON.parse(raw); } catch { throw new AppError(500, 'The local results extension is invalid.'); }
    if (!manifest || typeof manifest !== 'object' || !('format' in manifest) || manifest.format !== 1 || !('sha256' in manifest)
        || manifest.sha256 !== createHash('sha256').update(code).digest('hex')) throw new AppError(500, 'The local results extension does not match its manifest.');
    return code;
}
