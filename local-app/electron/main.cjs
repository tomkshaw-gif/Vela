const { existsSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { createPrepareController, createQuitLifecycle, isTrustedPage } = require('./lifecycle.cjs');

function configureProfile(app, environment = process.env, platform = process.platform) {
    const base = environment.LOCALAPPDATA ?? (platform === 'win32' ? undefined : join(environment.HOME ?? '', '.local', 'share'));
    if (!environment.VELA_DATA_DIR && !base) throw new Error('The local application-data directory is unavailable.');
    const dataDirectory = resolve(environment.VELA_DATA_DIR ?? join(base, 'VelaReplayStudio'));
    const profile = join(dataDirectory, 'desktop-profile');
    mkdirSync(profile, { recursive: true });
    app.setPath('userData', profile); app.setPath('sessionData', profile);
    return profile;
}

function runtimeDirectory(app, resourcesPath = process.resourcesPath, sourceDirectory = __dirname) {
    if (app.isPackaged) return join(resourcesPath, 'app-runtime');
    const staged = resolve(app.getAppPath(), '..', 'app-runtime');
    return existsSync(join(staged, 'server.mjs')) ? staged : join(sourceDirectory, 'staging', 'app-runtime');
}

function startBackend({ utilityProcess, directory, version, repositoryDirectory, timeoutMs = 30_000, onUnexpectedExit = () => {} }) {
    const env = { ...process.env };
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'VELA_PORT', 'VELA_RUNTIME_MODE', 'VELA_RUNTIME_VERSION', 'VELA_STATIC_DIRECTORY', 'VELA_REPOSITORY_DIRECTORY']) delete env[key];
    const child = utilityProcess.fork(join(directory, 'backend.mjs'), [directory, version, repositoryDirectory],
        { env, stdio: 'ignore', serviceName: 'Vela Replay Backend' });
    let ready = false; let stopping = false; let exited = false; let exitCode;
    let stopPromise; let resolveStop; let rejectStop; let stopTimer;
    const started = new Promise((resolveStart, rejectStart) => {
        const timer = setTimeout(() => { rejectStart(new Error('The local backend did not start in time.')); child.kill(); }, timeoutMs);
        child.on('message', input => {
            if (input?.type === 'backend:ready' && !ready) {
                try {
                    const url = new URL(input.url);
                    if (url.origin !== 'http://127.0.0.1:5196' || url.pathname !== '/'
                        || url.username || url.password || url.search || url.hash
                        || input.sqlite !== true || typeof input.node !== 'string' || !/^\d+\./.test(input.node) || Number(input.node.split('.')[0]) < 24) throw new Error();
                    ready = true; clearTimeout(timer); resolveStart({ url: url.origin, node: input.node });
                } catch { clearTimeout(timer); rejectStart(new Error('The local backend returned an invalid address or runtime.')); child.kill(); }
            } else if (input?.type === 'backend:failed') {
                clearTimeout(timer); rejectStart(new Error('The local backend failed to start.')); child.kill();
            } else if (input?.type === 'backend:shutdown-failed') {
                clearTimeout(stopTimer); rejectStop?.(new Error('The local backend could not finish closing.'));
            }
        });
        child.once('exit', code => {
            exited = true; exitCode = code; clearTimeout(timer); clearTimeout(stopTimer);
            if (!ready) rejectStart(new Error('The local backend exited before it was ready.'));
            else if (!stopping) onUnexpectedExit();
            if (stopping) {
                if (code === 0) resolveStop?.(); else rejectStop?.(new Error('The local backend exited without confirming a clean shutdown.'));
            }
        });
    });
    return { started,
        shutdown() {
            if (exited) return exitCode === 0 ? Promise.resolve() : Promise.reject(new Error('The local backend is no longer running.'));
            if (stopPromise) return stopPromise;
            stopping = true;
            stopPromise = new Promise((resolveStopPromise, rejectStopPromise) => {
                resolveStop = resolveStopPromise; rejectStop = rejectStopPromise;
                stopTimer = setTimeout(() => rejectStop(new Error('The local backend is still closing. The application remains open.')), timeoutMs);
                try { child.postMessage({ type: 'backend:shutdown' }); }
                catch { clearTimeout(stopTimer); rejectStop(new Error('The local backend could not be reached.')); }
            });
            return stopPromise;
        },
    };
}

function secureWindow(window, origin) {
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const navigate = (event, url) => { if (!isTrustedPage(url, origin)) event.preventDefault(); };
    contents.on('will-navigate', navigate); contents.on('will-redirect', navigate);
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
}

async function runDesktop({ app, BrowserWindow, utilityProcess, ipcMain, dialog, Menu }, options = {}) {
    configureProfile(app, options.environment);
    if (!app.requestSingleInstanceLock()) { app.quit(); return; }
    let window; let backend; let prepare; let lifecycle; let updater;
    let loaded = false;
    const focus = () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } };
    app.on('second-instance', focus); app.on('activate', focus);
    await app.whenReady();
    const error = () => {
        if (window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', title: 'Vela Replay Studio',
            message: lifecycle?.isStopped() ? 'The workspace is saved, but the update installer did not start.' : 'Vela could not finish saving and closing.',
            detail: lifecycle?.isStopped() ? 'Use File → Install downloaded update to retry, or quit safely and reopen Vela.' : 'Your window remains open. Resolve any save error before trying again.', buttons: ['Keep open'] }).catch(() => {});
    };
    try {
        const directory = runtimeDirectory(app);
        backend = startBackend({ utilityProcess, directory, version: app.getVersion(), repositoryDirectory: app.getAppPath(), onUnexpectedExit: error });
        const { url } = await backend.started;
        window = new BrowserWindow({ width: 1440, height: 960, minWidth: 960, minHeight: 640, show: false,
            title: 'Vela Replay Studio', backgroundColor: '#10131a',
            webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true,
                nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
                webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, safeDialogs: true } });
        secureWindow(window, url);
        prepare = createPrepareController({ window, ipcMain, origin: url });
        lifecycle = createQuitLifecycle({ app, window, prepare: reason => prepare.prepareForQuit(reason), canStop: () => prepare.isPrepared(), stop: () => backend.shutdown(), onError: error });
        app.once('will-quit', () => { updater?.dispose(); prepare.dispose(); lifecycle.dispose(); });
        await window.loadURL(url);
        loaded = true;
        const createUpdater = options.createUpdater ?? require('./updater.cjs').createDesktopUpdater;
        updater = require('./updates.cjs').createUpdateController({ app, window, ipcMain, origin: url, lifecycle, createUpdater });
        const updateAction = action => { void Promise.resolve().then(action).catch(() => {
            if (!window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', title: 'Vela updates',
                message: 'The update request could not finish. Try again.',
                detail: 'Your workspace remains open. A downloaded update stays available to install.', buttons: ['OK'] }).catch(() => {});
        }); };
        Menu.setApplicationMenu(Menu.buildFromTemplate([
            { label: 'File', submenu: [
                { label: 'Check for updates…', click: () => updateAction(async () => {
                    await updater.check();
                    const status = updater.getState().status;
                    if (!window.isDestroyed()) await dialog.showMessageBox(window, { type: 'info', title: 'Vela updates',
                        message: status === 'ready' ? 'An update is ready to install.' : status === 'downloading' ? 'An update is downloading.' :
                            status === 'error' ? 'The update check could not finish.' : status === 'installing' ? 'Vela is preparing to install the update.' : 'Update check complete.',
                        detail: 'Updates install only when you choose Install update. Vela saves your workspace before restarting.', buttons: ['OK'] });
                }) },
                { label: 'Install downloaded update…', click: () => {
                    if (['ready', 'installing'].includes(updater.getState().status)) updateAction(() => updater.install());
                    else updateAction(() => dialog.showMessageBox(window, { type: 'info', title: 'Vela updates', message: 'No downloaded update is ready.', detail: 'Use File → Check for updates to look for a new version.', buttons: ['OK'] }));
                } },
                { type: 'separator' }, { role: 'quit' },
            ] },
            { role: 'editMenu' },
            { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
        ]));
        window.show();
        return { window, backend, ...lifecycle };
    } catch {
        if (loaded) {
            // Once a client can edit, even initialization failure must use its save hook.
            window.show(); error(); return { window, backend, ...lifecycle };
        }
        lifecycle?.dispose(); prepare?.dispose();
        if (backend) await backend.shutdown().catch(() => {});
        if (window && !window.isDestroyed()) window.destroy();
        dialog.showErrorBox('Vela Replay Studio', 'The local application could not start. Rebuild or reinstall the application and try again.');
        app.quit();
    }
}

module.exports = { configureProfile, runtimeDirectory, startBackend, secureWindow, runDesktop };
// Electron loads the application through its bootstrap module, so require.main is not this module.
if (process.versions.electron && process.type === 'browser') {
    const electron = require('electron');
    void runDesktop(electron).catch(() => {
        electron.dialog.showErrorBox('Vela Replay Studio', 'The application profile is unavailable. Check your local application-data directory and try again.');
        electron.app.quit();
    });
}
