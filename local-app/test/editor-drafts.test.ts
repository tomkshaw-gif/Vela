// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorDraftStorageKeys, PINE_EDITOR_STORAGE_KEY, PINE_EDITOR_WINDOW_ID_KEY } from '../client/editor-drafts';

type StoragePort = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function memoryStorage(initial: Iterable<[string, string]> = []): StoragePort & { values: Map<string, string> } {
    const values = new Map(initial);
    return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

class FakeLocks {
    readonly held = new Set<string>();

    request(name: string, _options: { ifAvailable: true }, callback: (lock: object | null) => Promise<void>): Promise<void> {
        if (this.held.has(name)) return Promise.resolve().then(() => callback(null));
        this.held.add(name);
        return Promise.resolve().then(() => callback({ name })).finally(() => { this.held.delete(name); });
    }
}

const documents: ReturnType<typeof createEditorDraftStorageKeys>[] = [];
function documentKeys(): ReturnType<typeof createEditorDraftStorageKeys> {
    const owner = createEditorDraftStorageKeys(); documents.push(owner); return owner;
}

afterEach(async () => {
    await Promise.all(documents.splice(0).map((owner) => owner.release()));
    vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('editor draft document ownership', () => {
    it('forks a duplicated window identity before either editor can write its drafts', async () => {
        const locks = new FakeLocks(); const recovery = memoryStorage(); const original = memoryStorage();
        const firstDocument = await import('../client/editor-drafts');
        const firstKey = await firstDocument.editorDraftStorageKey(original, { locks, recoveryStorage: recovery });
        recovery.setItem(firstKey, '{"source":"draft A"}');
        const copiedSession = memoryStorage(original.values);
        vi.resetModules();
        const secondDocument = await import('../client/editor-drafts');
        const secondKey = await secondDocument.editorDraftStorageKey(copiedSession, { locks, recoveryStorage: recovery });
        expect(secondKey).not.toBe(firstKey);
        expect(recovery.getItem(secondKey)).toBe('{"source":"draft A"}');
        recovery.setItem(secondKey, '{"source":"draft B"}');
        expect(recovery.getItem(firstKey)).toBe('{"source":"draft A"}');
    });

    it('reuses a live document claim across concurrent editor remounts', async () => {
        const owner = documentKeys(); const session = memoryStorage(); const recovery = memoryStorage(); const locks = new FakeLocks();
        const first = owner.key(session, { locks, recoveryStorage: recovery });
        const second = owner.key(session, { locks, recoveryStorage: recovery });
        expect(second).toBe(first);
        const key = await first;
        expect(await owner.key(session, { locks, recoveryStorage: recovery })).toBe(key);
        expect(locks.held.size).toBe(1);
    });

    it('recovers both independent drafts on reload without creating more recovery copies', async () => {
        const locks = new FakeLocks(); const recovery = memoryStorage(); const firstSession = memoryStorage();
        const first = documentKeys(); const firstKey = await first.key(firstSession, { locks, recoveryStorage: recovery });
        recovery.setItem(firstKey, 'A');
        const secondSession = memoryStorage(firstSession.values); const second = documentKeys();
        const secondKey = await second.key(secondSession, { locks, recoveryStorage: recovery });
        recovery.setItem(secondKey, 'B');
        await first.release();
        const reloadedFirst = documentKeys();
        expect(await reloadedFirst.key(firstSession, { locks, recoveryStorage: recovery })).toBe(firstKey);
        expect(recovery.getItem(firstKey)).toBe('A');
        await second.release();
        const reloadedSecond = documentKeys();
        expect(await reloadedSecond.key(secondSession, { locks, recoveryStorage: recovery })).toBe(secondKey);
        expect(recovery.getItem(secondKey)).toBe('B');
        expect(recovery.values.size).toBe(2);
    });

    it('copies on every new document when locks are unavailable and retains previous recovery', async () => {
        const recovery = memoryStorage(); const session = memoryStorage(); const first = documentKeys();
        const firstKey = await first.key(session, { locks: null, recoveryStorage: recovery }); recovery.setItem(firstKey, 'A');
        const clonedSession = memoryStorage(session.values); const second = documentKeys();
        const secondKey = await second.key(clonedSession, { locks: null, recoveryStorage: recovery });
        expect(secondKey).not.toBe(firstKey); expect(recovery.getItem(secondKey)).toBe('A');
        recovery.setItem(secondKey, 'B'); await second.release();
        const reloaded = documentKeys(); const reloadedKey = await reloaded.key(clonedSession, { locks: null, recoveryStorage: recovery });
        expect(reloadedKey).not.toBe(secondKey); expect(recovery.getItem(reloadedKey)).toBe('B');
        expect(recovery.getItem(firstKey)).toBe('A'); expect(recovery.getItem(secondKey)).toBe('B');
    });

    it('does not mistake a still-live no-lock window for a closed lock owner', async () => {
        const recovery = memoryStorage(); const firstSession = memoryStorage();
        const firstKey = await documentKeys().key(firstSession, { locks: null, recoveryStorage: recovery }); recovery.setItem(firstKey, 'A');
        const secondKey = await documentKeys().key(memoryStorage(firstSession.values), { locks: new FakeLocks(), recoveryStorage: recovery });
        expect(secondKey).not.toBe(firstKey); expect(recovery.getItem(secondKey)).toBe('A');
    });

    it('uses isolated recovery copies when the platform lock getter or request fails', async () => {
        const recovery = memoryStorage(); const session = memoryStorage();
        vi.stubGlobal('navigator', { get locks() { throw new Error('Locks unavailable'); } });
        const firstKey = await documentKeys().key(session, { recoveryStorage: recovery }); recovery.setItem(firstKey, 'A');
        const failedLocks = { request: () => Promise.reject(new Error('Request unavailable')) };
        const secondKey = await documentKeys().key(memoryStorage(session.values), { locks: failedLocks, recoveryStorage: recovery });
        expect(secondKey).not.toBe(firstKey); expect(recovery.getItem(secondKey)).toBe('A');
        expect(recovery.getItem(firstKey)).toBe('A');
    });

    it('fails closed on copy quota errors, retains both old and legacy recovery, and allows a safe retry', async () => {
        const locks = new FakeLocks(); const recovery = memoryStorage(); const session = memoryStorage();
        const firstKey = await documentKeys().key(session, { locks, recoveryStorage: recovery });
        recovery.setItem(firstKey, 'A'); recovery.setItem(PINE_EDITOR_STORAGE_KEY, 'legacy');
        const clonedSession = memoryStorage(session.values); const before = [...clonedSession.values]; const duplicate = documentKeys();
        const failing = { getItem: recovery.getItem, setItem() { throw new Error('Quota exceeded'); } };
        await expect(duplicate.key(clonedSession, { locks, recoveryStorage: failing })).rejects.toThrow('Quota exceeded');
        expect([...clonedSession.values]).toEqual(before); expect([...recovery.values]).toEqual([[firstKey, 'A'], [PINE_EDITOR_STORAGE_KEY, 'legacy']]);
        expect(locks.held.size).toBe(1);
        const retried = await duplicate.key(clonedSession, { locks, recoveryStorage: recovery });
        expect(retried).not.toBe(firstKey); expect(recovery.getItem(retried)).toBe('A');
    });

    it('rejects recovery copies beyond the editor read budget without changing the window identity', async () => {
        const locks = new FakeLocks(); const recovery = memoryStorage(); const session = memoryStorage();
        const firstKey = await documentKeys().key(session, { locks, recoveryStorage: recovery }); recovery.setItem(firstKey, 'x'.repeat(2_000_001));
        const copy = memoryStorage(session.values); const previousId = copy.getItem(PINE_EDITOR_WINDOW_ID_KEY);
        await expect(documentKeys().key(copy, { locks, recoveryStorage: recovery })).rejects.toThrow('storage limit');
        expect(copy.getItem(PINE_EDITOR_WINDOW_ID_KEY)).toBe(previousId); expect(recovery.values.size).toBe(1);
    });

    it('copies pre-claim recovery to a new key without rewriting the old key or legacy data', async () => {
        const id = '3d25756e-34a9-4e9a-9d11-e1d295e47811'; const oldKey = `${PINE_EDITOR_STORAGE_KEY}.${id}`;
        const session = memoryStorage([[PINE_EDITOR_WINDOW_ID_KEY, id]]);
        const recovery = memoryStorage([[oldKey, 'old'], [PINE_EDITOR_STORAGE_KEY, 'legacy']]);
        const key = await documentKeys().key(session, { locks: new FakeLocks(), recoveryStorage: recovery });
        expect(key).not.toBe(oldKey); expect(recovery.getItem(key)).toBe('old');
        expect(recovery.getItem(oldKey)).toBe('old'); expect(recovery.getItem(PINE_EDITOR_STORAGE_KEY)).toBe('legacy');
    });

    it('propagates identity storage failures and releases any newly acquired claim', async () => {
        const locks = new FakeLocks(); const recovery = memoryStorage();
        const unreadable = { getItem() { throw new Error('Storage blocked'); }, setItem() { /* unavailable */ } };
        await expect(documentKeys().key(unreadable, { locks, recoveryStorage: recovery })).rejects.toThrow('Storage blocked');
        const unwritable = { getItem: () => null, setItem() { throw new Error('Identity blocked'); } };
        await expect(documentKeys().key(unwritable, { locks, recoveryStorage: recovery })).rejects.toThrow('Identity blocked');
        expect(locks.held.size).toBe(0); expect(recovery.values.size).toBe(0);
    });

    it('bounds identity retries and never overwrites a pre-existing recovery key', async () => {
        const id = '3d25756e-34a9-4e9a-9d11-e1d295e47811'; const key = `${PINE_EDITOR_STORAGE_KEY}.${id}`;
        const random = vi.spyOn(crypto, 'randomUUID').mockReturnValue(id); const recovery = memoryStorage([[key, 'protected']]);
        await expect(documentKeys().key(memoryStorage(), { locks: new FakeLocks(), recoveryStorage: recovery })).rejects.toThrow('independent');
        expect(random).toHaveBeenCalledTimes(32); expect([...recovery.values]).toEqual([[key, 'protected']]);
    });

    it('keeps a document-memory key stable when session storage is unavailable', async () => {
        const owner = documentKeys(); const options = { locks: new FakeLocks(), recoveryStorage: memoryStorage() };
        const first = await owner.key(undefined, options);
        expect(await owner.key(undefined, options)).toBe(first);
        expect(await documentKeys().key(undefined, options)).not.toBe(first);
    });

    it('does not return an editable key after its document has closed during allocation', async () => {
        const owner = documentKeys(); const locks = new FakeLocks(); const recovery = memoryStorage(); const session = memoryStorage();
        const key = owner.key(session, { locks, recoveryStorage: recovery }); const closed = owner.release();
        await expect(key).rejects.toThrow('closed'); await closed;
        expect(locks.held.size).toBe(0); expect(session.values.size).toBe(0); expect(recovery.values.size).toBe(0);
        await expect(owner.key(session, { locks, recoveryStorage: recovery })).rejects.toThrow('closed');
    });
});
