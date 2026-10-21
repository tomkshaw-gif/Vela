import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** Optional machine-local appearance assets never enter the published library. */
export function localDrawingIcons(filename = fileURLToPath(new URL('./.local-ui/drawing-icons.json', import.meta.url)), external = false): Plugin {
    const id = 'virtual:local-drawing-icons';
    return {
        name: 'local-drawing-icons',
        resolveId(source) { return source === id ? '\0' + id : undefined; },
        async load(source) {
            if (source !== '\0' + id) return;
            if (external) return 'const local = await import(/* @vite-ignore */ "/local-appearance/drawing-icons.js"); export default local.default;';
            let icons: Record<string, string> = {};
            try {
                const raw = await readFile(filename, 'utf8');
                if (raw.length > 256_000) throw new Error('Local drawing icon pack exceeds its size limit.');
                const parsed: unknown = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > 128) throw new Error('Invalid local drawing icon pack.');
                icons = Object.fromEntries(Object.entries(parsed).filter(([key, value]) => /^[a-z][a-z0-9-]{0,50}$/.test(key) && typeof value === 'string' && value.length <= 12_000));
                this.addWatchFile(filename);
            } catch (error) {
                if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
            }
            return `export default ${JSON.stringify(icons)};`;
        },
    };
}

/** The optional local chart module is static source, with a matching extraction manifest. */
export function localResultsChart(filename = fileURLToPath(new URL('./.local-ui/results-chart.mjs', import.meta.url)),
    manifestFilename = fileURLToPath(new URL('./.local-ui/results-chart.json', import.meta.url)), external = false): Plugin {
    const id = 'virtual:local-results-chart';
    return {
        name: 'local-results-chart',
        resolveId(source) { return source === id ? '\0' + id : undefined; },
        async load(source) {
            if (source !== '\0' + id) return;
            if (external) return 'const local = await import(/* @vite-ignore */ "/local-appearance/results-chart.mjs"); export default local.default;';
            const reads = await Promise.allSettled([readFile(filename, 'utf8'), readFile(manifestFilename, 'utf8')]);
            const missing = (result: PromiseSettledResult<string>): boolean => result.status === 'rejected'
                && !!result.reason && typeof result.reason === 'object' && result.reason.code === 'ENOENT';
            if (reads.every(missing)) return 'export default null;';
            if (reads.some(result => result.status === 'rejected')) throw new Error('The local results chart asset and manifest must both be present.');
            const code = (reads[0] as PromiseFulfilledResult<string>).value;
            const raw = (reads[1] as PromiseFulfilledResult<string>).value;
            if (Buffer.byteLength(code) > 512_000 || raw.length > 16_000) throw new Error('Local results chart asset exceeds its size limit.');
            const manifest: unknown = JSON.parse(raw);
            if (!manifest || typeof manifest !== 'object' || !('sha256' in manifest) || !('format' in manifest)
                || manifest.format !== 1 || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)
                || createHash('sha256').update(code).digest('hex') !== manifest.sha256) throw new Error('Local results chart asset does not match its manifest.');
            this.addWatchFile(filename); this.addWatchFile(manifestFilename);
            return code;
        },
    };
}
