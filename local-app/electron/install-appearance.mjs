import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const data = process.env.VELA_DATA_DIR ?? (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'VelaReplayStudio'));
if (!data) throw new Error('The local application data directory is unavailable.');
const target = join(data, 'appearance');
await mkdir(target, { recursive: true });
for (const name of ['drawing-icons.json', 'results-chart.mjs', 'results-chart.json', 'results-chart-upstream-LICENSE.txt', 'results-chart-upstream-NOTICE.txt', 'PROVENANCE.md']) {
    const source = join(root, 'local-app/.local-ui', name);
    try {
        await copyFile(source, join(target, name), constants.COPYFILE_EXCL);
        console.log(`Installed local appearance asset: ${name}`);
    } catch (error) {
        if (error.code === 'ENOENT') continue;
        if (error.code !== 'EEXIST') throw error;
        const same = (await readFile(source)).equals(await readFile(join(target, name)));
        console.log(`${same ? 'Kept existing' : 'Preserved different'} local appearance asset: ${name}`);
    }
}
