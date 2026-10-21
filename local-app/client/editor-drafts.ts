export const PINE_EDITOR_STORAGE_KEY = 'vela.local.pine-editor.v1';
export const PINE_EDITOR_WINDOW_ID_KEY = 'vela.local.pine-window-id';
const WINDOW_LOCK_KEY = 'vela.local.pine-window-lock';
const MAX_RECOVERY_CHARACTERS = 2_000_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export type DraftStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
export type DraftLockManager = {
    request(name: string, options: { ifAvailable: true }, callback: (lock: object | null) => Promise<void>): Promise<void>;
};
export type EditorDraftStorageOptions = { locks?: DraftLockManager | null; recoveryStorage?: DraftStorage };

type Claim = { id: string; release(): void; finished: Promise<void> };

function newId(): string {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
    bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultLocks(): DraftLockManager | null {
    try { return globalThis.navigator?.locks ?? null; } catch { return null; }
}

function defaultRecoveryStorage(): DraftStorage {
    const storage = globalThis.localStorage;
    if (!storage) throw new Error('Script draft recovery storage is unavailable.');
    return storage;
}

function scopedKey(id: string): string { return `${PINE_EDITOR_STORAGE_KEY}.${id}`; }

function claim(locks: DraftLockManager, id: string): Promise<Claim | null> {
    return new Promise((resolve, reject) => {
        let release!: () => void;
        const lifetime = new Promise<void>((finish) => { release = finish; });
        const finished = Promise.resolve().then(() => locks.request(`vela.local.pine-draft:${id}`, { ifAvailable: true }, async (lock) => {
            if (!lock) { resolve(null); return; }
            resolve({ id, release, finished });
            await lifetime;
        }));
        void finished.catch(reject);
    });
}

/** One owner per live document; editor remounts must keep using the same owner. */
export function createEditorDraftStorageKeys(): {
    key(storage?: DraftStorage, options?: EditorDraftStorageOptions): Promise<string>;
    release(): Promise<void>;
} {
    const pendingByStorage = new WeakMap<DraftStorage, Promise<string>>();
    const claims = new Map<string, Claim>();
    const pending = new Set<Promise<string>>();
    let memoryKey: Promise<string> | undefined;
    let closed = false;

    async function allocate(storage: DraftStorage | undefined, options: EditorDraftStorageOptions): Promise<string> {
        const recovery = options.recoveryStorage ?? defaultRecoveryStorage();
        const storedId = storage?.getItem(PINE_EDITOR_WINDOW_ID_KEY);
        const previousId = storedId && UUID.test(storedId) ? storedId : undefined;
        const previousKey = previousId ? scopedKey(previousId) : undefined;
        let locks = options.locks === undefined ? defaultLocks() : options.locks;

        if (previousId && claims.has(previousId)) return scopedKey(previousId);
        if (previousId && locks && storage?.getItem(WINDOW_LOCK_KEY) === previousId) {
            let owned: Claim | null;
            try { owned = await claim(locks, previousId); } catch { owned = null; locks = null; }
            if (owned) {
                if (closed) { owned.release(); await owned.finished; throw new Error('Script draft owner has closed.'); }
                claims.set(previousId, owned);
                return scopedKey(previousId);
            }
        }

        const source = previousKey ? recovery.getItem(previousKey) : null;
        if (source !== null && source.length > MAX_RECOVERY_CHARACTERS) throw new Error('Script draft recovery exceeds the storage limit.');

        for (let attempt = 0; attempt < 32; attempt++) {
            const id = newId(); const key = scopedKey(id);
            if (recovery.getItem(key) !== null) continue;
            let owned: Claim | null = null;
            if (locks) {
                try { owned = await claim(locks, id); } catch { locks = null; }
                if (locks && !owned) continue;
            }
            try {
                if (closed) throw new Error('Script draft owner has closed.');
                // A copied tab receives its own recovery copy before an editor can save.
                if (source !== null) recovery.setItem(key, source);
                if (storage) {
                    storage.setItem(WINDOW_LOCK_KEY, owned ? id : '');
                    storage.setItem(PINE_EDITOR_WINDOW_ID_KEY, id);
                }
                if (owned) claims.set(id, owned);
                return key;
            } catch (error) {
                if (owned) { owned.release(); await owned.finished; }
                throw error;
            }
        }
        throw new Error('Unable to allocate an independent script draft recovery key.');
    }

    return {
        key(storage, options = {}) {
            if (closed) return Promise.reject(new Error('Script draft owner has closed.'));
            const existing = storage ? pendingByStorage.get(storage) : memoryKey;
            if (existing) return existing;
            const result = allocate(storage, options);
            if (storage) pendingByStorage.set(storage, result); else memoryKey = result;
            pending.add(result);
            void result.then(() => { pending.delete(result); }, () => {
                pending.delete(result);
                if (storage) pendingByStorage.delete(storage); else memoryKey = undefined;
            });
            return result;
        },
        async release() {
            closed = true;
            await Promise.allSettled(pending);
            const held = [...claims.values()];
            for (const owned of held) owned.release();
            await Promise.allSettled(held.map((owned) => owned.finished));
            claims.clear();
        },
    };
}

const documentDraftKeys = createEditorDraftStorageKeys();

/** Closing the document releases its lock; a reload can then recover the same key. */
export function editorDraftStorageKey(storage?: DraftStorage, options?: EditorDraftStorageOptions): Promise<string> {
    return documentDraftKeys.key(storage, options);
}
