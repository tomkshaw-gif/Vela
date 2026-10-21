const { autoUpdater } = require('electron-updater');
const { launchInstaller } = require('./installer.cjs');

/** The installer is invoked only by the desktop save-and-close lifecycle. */
function createDesktopUpdater({ app, onDownloaded, onStatus = () => {}, updater = autoUpdater, intervalMs = 30 * 60 * 1000, launch = launchInstaller }) {
    let checking; let downloaded = false; let disposed = false;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    const status = (value, version) => {
        if (disposed) return;
        const next = downloaded ? downloaded.version : version;
        if (next === undefined) onStatus(downloaded ? 'ready' : value); else onStatus(downloaded ? 'ready' : value, next);
    };
    const handlers = {
        'checking-for-update': () => status('checking'),
        'update-available': update => status('downloading', update?.version),
        'update-not-available': () => status('current'),
        'error': () => status('unavailable'),
        'update-downloaded': update => { if (disposed) return; downloaded = update; status('ready'); onDownloaded(update?.version); },
    };
    for (const [event, handler] of Object.entries(handlers)) updater.on(event, handler);
    const check = () => {
        if (disposed || !app.isPackaged) return Promise.resolve(null);
        if (checking) return checking;
        // A later download can clear the shared pending cache before failing. Keep the accepted installer pinned.
        if (downloaded) return Promise.resolve(null);
        checking = Promise.resolve().then(() => disposed || downloaded ? null : updater.checkForUpdates()).then(async result => {
            if (result?.downloadPromise) await result.downloadPromise;
            return result;
        }).catch(error => { status('unavailable'); throw error; }).finally(() => { checking = undefined; });
        return checking;
    };
    const checkQuietly = () => { void check().catch(() => {}); };
    const initial = setTimeout(checkQuietly, 15_000); initial.unref?.();
    const timer = setInterval(checkQuietly, intervalMs); timer.unref?.();
    return {
        check,
        install() {
            if (!downloaded || disposed || !app.isPackaged) throw new Error('A downloaded desktop update is required.');
            return launch({ app, update: downloaded });
        },
        dispose() {
            disposed = true; clearTimeout(initial); clearInterval(timer);
            for (const [event, handler] of Object.entries(handlers)) updater.removeListener(event, handler);
        },
    };
}
module.exports = { createDesktopUpdater };
