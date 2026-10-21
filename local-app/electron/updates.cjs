const { isTrustedPage, isTrustedSender } = require('./lifecycle.cjs');

const UPDATE_CHANNELS = Object.freeze({ state: 'vela-desktop:update-state', changed: 'vela-desktop:update-changed',
    check: 'vela-desktop:update-check', install: 'vela-desktop:update-install' });
const versionText = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value) && value.length <= 80 ? value : undefined;

/** The native menu and authenticated renderer share the same manual install action. */
function createUpdateController({ app, window, ipcMain, origin, lifecycle, createUpdater }) {
    const contents = window.webContents;
    const currentVersion = versionText(app.getVersion()) ?? 'unknown';
    let state = { status: 'idle', currentVersion };
    let ready = false; let disposed = false; let installing; let installed = false; let checking;
    const getState = () => ({ ...state });
    const publish = (status, version = state.version) => {
        if (disposed) return;
        state = { status: installing || installed ? 'installing' : status, currentVersion, ...(versionText(version) ? { version: versionText(version) } : {}) };
        try {
            if (!window.isDestroyed() && !contents.isDestroyed() && isTrustedPage(contents.getURL(), origin)) contents.send(UPDATE_CHANNELS.changed, getState());
        } catch { /* A window can be destroyed while an updater callback is queued. */ }
    };
    const updater = createUpdater({ app,
        onDownloaded: version => { ready = true; publish(installing || installed ? 'installing' : 'ready', version); },
        onStatus: (status, version) => {
            if (status === 'ready') ready = true;
            publish(installing || installed ? 'installing' : ready ? 'ready' :
                ['checking', 'downloading', 'current'].includes(status) ? status : 'error', ready && status !== 'ready' ? state.version : version);
        },
    });
    const check = () => {
        if (disposed || installing || installed) return Promise.resolve();
        if (checking) return checking;
        if (!ready) publish('checking');
        checking = Promise.resolve().then(() => disposed ? undefined : updater.check()).then(() => {
            if (state.status === 'checking') publish(ready ? 'ready' : 'current');
        }).catch(() => { publish(ready ? 'ready' : 'error'); throw new Error('The update check could not finish. Try again.'); })
            .finally(() => { checking = undefined; });
        return checking;
    };
    const install = () => {
        if (disposed || !ready) return Promise.resolve(false);
        if (installing) return installing;
        if (installed) return Promise.resolve(true);
        // Defer the barrier until the shared promise is assigned, so repeat clicks coalesce.
        installing = Promise.resolve().then(() => disposed ? false : lifecycle.close({ install: () => {
            if (disposed) throw new Error('The desktop update is unavailable.');
            return updater.install();
        } }))
            .then(result => { installed = result === true; return installed; }, () => false)
            .finally(() => { installing = undefined; if (!installed) publish('ready'); });
        publish('installing');
        return installing;
    };
    const handlers = { [UPDATE_CHANNELS.state]: getState, [UPDATE_CHANNELS.check]: check, [UPDATE_CHANNELS.install]: install };
    for (const [channel, action] of Object.entries(handlers)) ipcMain.handle(channel, (event, ...args) => {
        let trusted = false;
        try { trusted = !disposed && !contents.isDestroyed() && isTrustedSender(event, window, origin); } catch { /* Destroyed sender. */ }
        if (!trusted || args.length) throw new Error('The desktop update request is unavailable.');
        return action();
    });
    const dispose = () => {
        if (disposed) return;
        disposed = true; updater.dispose();
        for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
        contents.removeListener('destroyed', dispose);
    };
    contents.on('destroyed', dispose);
    publish(state.status);
    return { getState, check, install, dispose };
}

module.exports = { UPDATE_CHANNELS, createUpdateController };
