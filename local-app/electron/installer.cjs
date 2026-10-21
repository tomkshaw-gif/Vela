const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { realpath, stat } = require('node:fs/promises');
const { dirname, isAbsolute } = require('node:path');

/** Launch the already downloaded, verified per-user installer before permitting quit. */
async function launchInstaller({ app, update, start = spawn }) {
    const expected = update?.sha512 ?? update?.files?.find(file => typeof file.url === 'string' && /\.exe$/i.test(file.url))?.sha512;
    if (!update || typeof update.downloadedFile !== 'string' || !isAbsolute(update.downloadedFile) || !/\.exe$/i.test(update.downloadedFile)
        || update.isAdminRightsRequired === true || typeof expected !== 'string' || Buffer.from(expected, 'base64').length !== 64
        || Buffer.from(expected, 'base64').toString('base64') !== expected) throw new Error('A verified desktop installer is required.');
    const file = await realpath(update.downloadedFile); const details = await stat(file);
    if (!details.isFile() || details.size < 1 || details.size > 1024 * 1024 * 1024) throw new Error('The desktop installer is invalid.');
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest('base64') !== expected) throw new Error('The desktop installer changed after download.');
    const executable = app.getPath('exe');
    if (!isAbsolute(executable) || !/\.exe$/i.test(executable)) throw new Error('The installed application path is invalid.');
    await new Promise((resolve, reject) => {
        let child; let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('The update installer did not confirm startup.')); } }, 15_000);
        try {
            child = start(file, ['--updated', '/S', '--force-run', `/D=${dirname(executable)}`], { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
            child.once('error', () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('The update installer could not start.')); } });
            child.once('spawn', () => { if (!settled) { settled = true; clearTimeout(timer); child.unref(); resolve(); } });
        } catch { settled = true; clearTimeout(timer); reject(new Error('The update installer could not start.')); }
    });
    app.quit();
}
module.exports = { launchInstaller };
