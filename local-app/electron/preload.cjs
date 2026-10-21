const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preloads cannot import application modules; keep this fixed protocol narrow.
const PREPARE = 'vela-desktop:prepare';
const PREPARED = 'vela-desktop:prepared';
const UPDATE_STATE = 'vela-desktop:update-state';
const UPDATE_CHANGED = 'vela-desktop:update-changed';
const UPDATE_CHECK = 'vela-desktop:update-check';
const UPDATE_INSTALL = 'vela-desktop:update-install';
const updateCallbacks = new Set();
let updateRevision = 0;
const VERSION = /^(?:unknown|\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/;
function updateState(input) {
    if (!input || !['idle', 'checking', 'downloading', 'current', 'ready', 'installing', 'error'].includes(input.status)
        || typeof input.currentVersion !== 'string' || input.currentVersion.length > 80 || !VERSION.test(input.currentVersion)) throw new Error('The update state is unavailable.');
    const version = typeof input.version === 'string' && input.version.length <= 80 && VERSION.test(input.version) ? input.version : undefined;
    return Object.freeze({ status: input.status, currentVersion: input.currentVersion, ...(version ? { version } : {}) });
}
const invokeUpdate = channel => Promise.resolve().then(() => ipcRenderer.invoke(channel)).catch(() => { throw new Error('The desktop update request could not finish. Try again.'); });
function deliverUpdate(callback, state) { try { callback(state); } catch { /* One observer must not interrupt other controls. */ } }
function changed(_event, input) {
    let state;
    try { state = updateState(input); } catch { return; }
    updateRevision++;
    for (const callback of updateCallbacks) deliverUpdate(callback, state);
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
let callback;
let pending;

function prepared(requestId, error) {
    if (!pending || requestId !== pending.requestId) return;
    pending = undefined;
    ipcRenderer.send(PREPARED, { requestId, ...(error === undefined ? {} : { error: 'The workspace could not be saved.' }) });
}
function deliver() {
    if (!callback || !pending) return;
    try { callback(Object.freeze({ ...pending })); }
    catch { prepared(pending?.requestId, 'The workspace could not be saved.'); }
}
if (process.isMainFrame) {
    ipcRenderer.on(PREPARE, (_event, input) => {
        if (!input || typeof input !== 'object' || !UUID.test(input.requestId) || !['quit', 'update'].includes(input.reason)) return;
        pending = { requestId: input.requestId, reason: input.reason }; deliver();
    });
    contextBridge.exposeInMainWorld('velaDesktop', Object.freeze({
        onPrepare(next) {
            if (typeof next !== 'function') throw new TypeError('A save callback is required.');
            if (callback) throw new Error('A save callback is already registered.');
            callback = next; deliver();
            return () => { if (callback === next) callback = undefined; };
        },
        prepared,
        getUpdateState: () => invokeUpdate(UPDATE_STATE).then(updateState),
        onUpdateState(next) {
            if (typeof next !== 'function') throw new TypeError('An update callback is required.');
            const callback = state => next(state);
            if (!updateCallbacks.size) ipcRenderer.on(UPDATE_CHANGED, changed);
            updateCallbacks.add(callback);
            const revision = updateRevision;
            invokeUpdate(UPDATE_STATE).then(updateState).catch(() => Object.freeze({ status: 'error', currentVersion: 'unknown' })).then(state => {
                if (revision === updateRevision && updateCallbacks.has(callback)) deliverUpdate(callback, state);
            });
            return () => {
                updateCallbacks.delete(callback);
                if (!updateCallbacks.size) ipcRenderer.removeListener(UPDATE_CHANGED, changed);
            };
        },
        checkForUpdates: () => invokeUpdate(UPDATE_CHECK).then(() => undefined),
        installUpdate: () => invokeUpdate(UPDATE_INSTALL).then(result => result === true, () => false),
    }));
}
