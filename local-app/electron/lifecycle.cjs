const { randomUUID } = require('node:crypto');

const CHANNELS = Object.freeze({ prepare: 'vela-desktop:prepare', prepared: 'vela-desktop:prepared' });

function isTrustedPage(value, origin) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' && url.origin === origin && !url.username && !url.password
            && (url.pathname === '/' || url.pathname === '/index.html');
    } catch { return false; }
}

function isTrustedSender(event, window, origin) {
    return !window.isDestroyed() && event.sender === window.webContents
        && event.senderFrame === window.webContents.mainFrame
        && isTrustedPage(event.senderFrame?.url, origin);
}

/** Only the current application frame can acknowledge its own save request. */
function createPrepareController({ window, ipcMain, origin, timeoutMs = 60_000, requestId = randomUUID }) {
    const contents = window.webContents;
    let pending;
    let disposed = false;
    let saved = false;
    const finish = (error) => {
        if (!pending) return;
        const current = pending; pending = undefined; clearTimeout(current.timer);
        if (error) current.reject(error); else current.resolve();
    };
    const lost = () => { saved = false; finish(new Error('The workspace is unavailable. Pending changes have not been confirmed saved.')); };
    const navigate = (_event, _url, _inPlace, mainFrame) => { if (mainFrame) lost(); };
    const acknowledge = (event, input) => {
        if (!pending || !isTrustedSender(event, window, origin) || !input || typeof input !== 'object'
            || Array.isArray(input) || Object.keys(input).some(key => !['requestId', 'error'].includes(key))
            || input.requestId !== pending.id || input.error !== undefined && typeof input.error !== 'string') return;
        saved = input.error === undefined;
        finish(saved ? undefined : new Error('The workspace could not be saved. The application remains open.'));
    };
    ipcMain.on(CHANNELS.prepared, acknowledge);
    contents.on('render-process-gone', lost);
    contents.on('destroyed', lost);
    contents.on('did-start-navigation', navigate);
    return {
        prepareForQuit(reason = 'quit') {
            if (pending) return pending.promise;
            if (disposed || window.isDestroyed() || contents.isDestroyed()
                || !isTrustedPage(contents.getURL(), origin)) return Promise.reject(new Error('The workspace is not ready to save.'));
            if (!['quit', 'update'].includes(reason)) return Promise.reject(new Error('Invalid preparation reason.'));
            saved = false;
            const id = requestId();
            const promise = new Promise((resolve, reject) => {
                pending = { id, resolve, reject, timer: setTimeout(() => finish(new Error('Saving the workspace timed out. The application remains open.')), timeoutMs) };
            });
            pending.promise = promise;
            try { contents.send(CHANNELS.prepare, { requestId: id, reason }); }
            catch { lost(); }
            return promise;
        },
        isPrepared() { return saved && !disposed && !window.isDestroyed() && !contents.isDestroyed() && isTrustedPage(contents.getURL(), origin); },
        dispose() {
            disposed = true; lost(); ipcMain.removeListener(CHANNELS.prepared, acknowledge);
            contents.removeListener('render-process-gone', lost);
            contents.removeListener('destroyed', lost);
            contents.removeListener('did-start-navigation', navigate);
        },
    };
}

/** Both the updater and native close events must pass the same save/close barrier. */
function createQuitLifecycle({ app, window, prepare, stop, canStop = () => true, onError = () => {} }) {
    let state = 'running';
    let preparation;
    let stopping;
    let quitting;
    let installer;
    let finalizing = false;
    const prepareForQuit = (reason = 'update') => {
        if (['stopping', 'stopped'].includes(state) || state === 'prepared' && canStop()) return Promise.resolve();
        if (preparation) return preparation;
        state = 'preparing';
        preparation = Promise.resolve().then(() => prepare(reason)).then(() => { state = 'prepared'; })
            .catch(error => { state = 'running'; throw error; }).finally(() => { preparation = undefined; });
        return preparation;
    };
    const shutdown = () => {
        if (state === 'stopped') return Promise.resolve();
        if (stopping) return stopping;
        if (state !== 'prepared' || !canStop()) return Promise.reject(new Error('Save the workspace before stopping the backend.'));
        state = 'stopping';
        stopping = Promise.resolve().then(stop).then(() => { state = 'stopped'; })
            .catch(error => { state = 'prepared'; throw error; }).finally(() => { stopping = undefined; });
        return stopping;
    };
    const close = ({ install } = {}) => {
        if (install !== undefined && typeof install !== 'function') return Promise.reject(new Error('Invalid installer callback.'));
        if (finalizing) return quitting ?? Promise.resolve(true);
        if (install && !finalizing) installer = install;
        if (quitting) return quitting;
        quitting = prepareForQuit(installer ? 'update' : 'quit').then(shutdown).then(async () => {
            finalizing = true;
            if (installer) {
                if (await installer() === false) throw new Error('The installer did not start.');
            } else app.quit();
            return true;
        }).catch(() => {
            installer = undefined; finalizing = false;
            onError(new Error('Vela could not finish saving and closing. The application remains open; resolve the save error and try again.'));
            return false;
        }).finally(() => { quitting = undefined; });
        return quitting;
    };
    const requestQuit = () => close();
    const beforeQuit = (event) => { if (state !== 'stopped') { event.preventDefault(); void requestQuit(); } };
    app.on('before-quit', beforeQuit); window.on('close', beforeQuit);
    return { prepareForQuit, shutdown, requestQuit, close, isStopped: () => state === 'stopped',
        dispose() { app.removeListener('before-quit', beforeQuit); window.removeListener('close', beforeQuit); },
    };
}

module.exports = { CHANNELS, isTrustedPage, isTrustedSender, createPrepareController, createQuitLifecycle };
