const { autoUpdater } = require('electron-updater');
const { launchInstaller } = require('./installer.cjs');

/** The installer is invoked only by the desktop save-and-close lifecycle. */
function createDesktopUpdater({ app, onDownloaded, onStatus = () => {}, updater = autoUpdater, intervalMs = 30 * 60 * 1000, launch = launchInstaller }) {
    let checking; let downloaded = false; let disposed = false;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    // Public releases require no user credential, including inherited developer tokens.
    const handlers = {
        'checking-for-update': () => onStatus('checking'),
        'update-available': () => onStatus('downloading'),
        'update-not-available': () => onStatus('current'),
        'error': () => onStatus('unavailable'),
        'update-downloaded': update => { downloaded = update; onStatus('ready'); if (!disposed) onDownloaded(); },
    };
    for (const [event, handler] of Object.entries(handlers)) updater.on(event, handler);
    const check = () => {
        if (disposed || !app.isPackaged) return Promise.resolve(null);
        if (checking) return checking;
        checking = Promise.resolve().then(() => updater.checkForUpdates()).then(async result => {
            if (result?.downloadPromise) await result.downloadPromise;
            return result;
        }).finally(() => { checking = undefined; });
        return checking;
    };
    const checkQuietly = () => { void check().catch(() => onStatus('unavailable')); };
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
