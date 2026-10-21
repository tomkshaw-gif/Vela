import { afterEach, describe, expect, it } from 'vitest';
import { persistDesktopSession, restoreDesktopSession } from '../client/desktop-session';
import { createEditorDraftStorageKeys, PINE_EDITOR_STORAGE_KEY, PINE_EDITOR_WINDOW_ID_KEY } from '../client/editor-drafts';

const RECOVERY = 'vela.desktop.session.v1';
const SELECTED = 'vela-replay-selected-session';
const LOCK = 'vela.local.pine-window-lock';
const SESSION = 'a43fed31-97d5-4d17-a206-27649c430d1b';
const WINDOW = 'c3a613d2-5bd9-4698-9f4d-1a3c30661b41';
const LIVE = '8d3d03ab-5bea-439c-a048-d08e86d0a82b';

function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return { values, getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); } };
}

class FakeLocks {
    private readonly held = new Set<string>();
    request(name: string, _options: { ifAvailable: true }, callback: (lock: object | null) => Promise<void>): Promise<void> {
        if (this.held.has(name)) return Promise.resolve().then(() => callback(null));
        this.held.add(name);
        return Promise.resolve().then(() => callback({ name })).finally(() => { this.held.delete(name); });
    }
}

const owners: ReturnType<typeof createEditorDraftStorageKeys>[] = [];
function owner() { const value = createEditorDraftStorageKeys(); owners.push(value); return value; }
afterEach(async () => { await Promise.all(owners.splice(0).map(value => value.release())); });

describe('desktop session identity recovery', () => {
    it('persists only the selected session and draft owner, retaining unrelated local storage', () => {
        const local = memoryStorage({ unrelated: 'keep', [PINE_EDITOR_STORAGE_KEY]: 'legacy draft' });
        const session = memoryStorage({ [SELECTED]: SESSION, [PINE_EDITOR_WINDOW_ID_KEY]: WINDOW, [LOCK]: WINDOW,
            token: 'unrelated in-memory fixture', arbitrary: 'ignored' });
        persistDesktopSession(local, session);
        expect(JSON.parse(local.getItem(RECOVERY)!)).toEqual({ [SELECTED]: SESSION, [PINE_EDITOR_WINDOW_ID_KEY]: WINDOW, [LOCK]: WINDOW });
        expect(local.getItem('unrelated')).toBe('keep');
        expect(local.getItem(PINE_EDITOR_STORAGE_KEY)).toBe('legacy draft');
        expect(local.values.size).toBe(3);
    });

    it('recovers the same draft key and unsaved text after all session storage is lost', async () => {
        const locks = new FakeLocks(); const local = memoryStorage(); const session = memoryStorage({ [SELECTED]: SESSION });
        const firstOwner = owner();
        const firstKey = await firstOwner.key(session, { locks, recoveryStorage: local });
        const unsaved = JSON.stringify({ source: 'plot(close + 1)', dirty: true });
        local.setItem(firstKey, unsaved);
        persistDesktopSession(local, session);
        await firstOwner.release();

        const relaunched = memoryStorage();
        restoreDesktopSession(local, relaunched);
        expect(relaunched.getItem(SELECTED)).toBe(SESSION);
        expect(relaunched.getItem(PINE_EDITOR_WINDOW_ID_KEY)).toBe(session.getItem(PINE_EDITOR_WINDOW_ID_KEY));
        expect(await owner().key(relaunched, { locks, recoveryStorage: local })).toBe(firstKey);
        expect(local.getItem(firstKey)).toBe(unsaved);
    });

    it('forks a recovered draft when another live document still owns its lock', async () => {
        const locks = new FakeLocks(); const local = memoryStorage(); const session = memoryStorage();
        const originalKey = await owner().key(session, { locks, recoveryStorage: local });
        local.setItem(originalKey, 'unsaved original'); persistDesktopSession(local, session);
        const recovered = memoryStorage(); restoreDesktopSession(local, recovered);
        const nextKey = await owner().key(recovered, { locks, recoveryStorage: local });
        expect(nextKey).not.toBe(originalKey); expect(local.getItem(nextKey)).toBe('unsaved original');
        local.setItem(nextKey, 'independent edit'); expect(local.getItem(originalKey)).toBe('unsaved original');
    });

    it('copies a recovered draft safely when platform locks were unavailable before relaunch', async () => {
        const local = memoryStorage(); const session = memoryStorage();
        const firstOwner = owner(); const firstKey = await firstOwner.key(session, { locks: null, recoveryStorage: local });
        local.setItem(firstKey, 'offline draft'); persistDesktopSession(local, session); await firstOwner.release();
        const recovered = memoryStorage(); restoreDesktopSession(local, recovered);
        expect(recovered.getItem(LOCK)).toBe('');
        const copiedKey = await owner().key(recovered, { locks: null, recoveryStorage: local });
        expect(copiedKey).not.toBe(firstKey); expect(local.getItem(copiedKey)).toBe('offline draft');
        expect(local.getItem(firstKey)).toBe('offline draft');
    });

    it('preserves every existing live identity, including an explicit empty lock marker', () => {
        const local = memoryStorage({ [RECOVERY]: JSON.stringify({ [SELECTED]: SESSION, [PINE_EDITOR_WINDOW_ID_KEY]: WINDOW, [LOCK]: WINDOW }) });
        const session = memoryStorage({ [SELECTED]: LIVE, [PINE_EDITOR_WINDOW_ID_KEY]: LIVE, [LOCK]: '' });
        const before = [...session.values]; restoreDesktopSession(local, session); restoreDesktopSession(local, session);
        expect([...session.values]).toEqual(before);
    });

    it('ignores unknown persisted fields and never restores arbitrary storage', () => {
        const local = memoryStorage({ [RECOVERY]: JSON.stringify({ [SELECTED]: SESSION, token: 'ignored', arbitrary: { value: true }, __proto__: null }) });
        const session = memoryStorage(); restoreDesktopSession(local, session);
        expect([...session.values]).toEqual([[SELECTED, SESSION]]);
    });

    it('replaces stale recovery fields when the current window no longer has those identities', () => {
        const local = memoryStorage({ [RECOVERY]: JSON.stringify({ [SELECTED]: SESSION, [PINE_EDITOR_WINDOW_ID_KEY]: WINDOW, [LOCK]: WINDOW }) });
        persistDesktopSession(local, memoryStorage({ [PINE_EDITOR_WINDOW_ID_KEY]: LIVE, [LOCK]: '' }));
        const session = memoryStorage(); restoreDesktopSession(local, session);
        expect(session.getItem(SELECTED)).toBeNull(); expect(session.getItem(PINE_EDITOR_WINDOW_ID_KEY)).toBe(LIVE);
        persistDesktopSession(local, memoryStorage()); expect(JSON.parse(local.getItem(RECOVERY)!)).toEqual({});
    });

    it('leaves live storage unchanged when recovery is absent', () => {
        const session = memoryStorage({ [SELECTED]: LIVE }); restoreDesktopSession(memoryStorage(), session);
        expect([...session.values]).toEqual([[SELECTED, LIVE]]);
    });

    it.each(['{broken', 'null', '[]', 'false', '42', '"text"', ' '.repeat(1025)]
        .map(raw => ({ name: raw.length > 1024 ? 'oversized input' : raw, raw })))('rejects malformed or oversized recovery: $name', ({ raw }) => {
        const local = memoryStorage({ [RECOVERY]: raw }); const session = memoryStorage();
        expect(() => restoreDesktopSession(local, session)).toThrow(); expect(session.values.size).toBe(0);
        expect(local.getItem(RECOVERY)).toBe(raw);
    });

    it.each([false, 123, null, {}, [], 'not-an-identity', '-'.repeat(36), 'a'.repeat(36)]
        .map(value => ({ value })))('rejects invalid identity values: $value', ({ value }) => {
        const local = memoryStorage({ [RECOVERY]: JSON.stringify({ [SELECTED]: value }) }); const session = memoryStorage();
        expect(() => restoreDesktopSession(local, session)).toThrow(); expect(session.values.size).toBe(0);
    });

    it('validates the entire recovery record before writing any session identity', () => {
        const local = memoryStorage({ [RECOVERY]: JSON.stringify({ [SELECTED]: SESSION, [PINE_EDITOR_WINDOW_ID_KEY]: WINDOW, [LOCK]: 42 }) });
        const session = memoryStorage({ unrelated: 'keep' }); const before = [...session.values];
        expect(() => restoreDesktopSession(local, session)).toThrow(); expect([...session.values]).toEqual(before);
    });

    it('propagates persistence failure without replacing the last recoverable identity', () => {
        const local = memoryStorage({ [RECOVERY]: JSON.stringify({ [SELECTED]: SESSION }) }); const previous = local.getItem(RECOVERY);
        const unavailable = { ...local, setItem: () => { throw new Error('Quota exceeded'); } };
        expect(() => persistDesktopSession(unavailable, memoryStorage({ [SELECTED]: LIVE }))).toThrow('Quota exceeded');
        expect(local.getItem(RECOVERY)).toBe(previous);
    });

    it('fails closed when recovery storage cannot be read and preserves all live identities', () => {
        const local = { ...memoryStorage(), getItem: () => { throw new Error('Storage blocked'); } };
        const session = memoryStorage({ [SELECTED]: LIVE, [PINE_EDITOR_WINDOW_ID_KEY]: LIVE, [LOCK]: LIVE });
        const before = [...session.values];
        expect(() => restoreDesktopSession(local, session)).toThrow('Storage blocked'); expect([...session.values]).toEqual(before);
    });

    it('leaves previous recovery intact if session storage fails during persistence', () => {
        const local = memoryStorage({ [RECOVERY]: JSON.stringify({ [SELECTED]: SESSION }) }); const before = local.getItem(RECOVERY);
        const session = { ...memoryStorage(), getItem: () => { throw new Error('Session storage blocked'); } };
        expect(() => persistDesktopSession(local, session)).toThrow('Session storage blocked'); expect(local.getItem(RECOVERY)).toBe(before);
    });
});
