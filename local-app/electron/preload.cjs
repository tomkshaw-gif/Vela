const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preloads cannot import application modules; keep this fixed protocol narrow.
const PREPARE = 'vela-desktop:prepare';
const PREPARED = 'vela-desktop:prepared';
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
    }));
}
