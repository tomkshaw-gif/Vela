// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from 'codemirror';
import { ApiError, type LocalApi } from '../client/api';
import { mountPineEditor, PINE_EDITOR_STORAGE_KEY } from '../client/pine-editor';
import { createEditorDraftStorageKeys, PINE_EDITOR_WINDOW_ID_KEY } from '../client/editor-drafts';
import type { ScriptDocument } from '../shared/scripts';

const ID = '7ae7f9c2-5250-47e5-adbd-8ff0c9171f89';
const BASE = '//@version=6\nindicator("Local test")\nplot(close)';
const CHANGED = `${BASE}\n// Keep this unsaved work`;
const INITIAL: ScriptDocument = {
    id: ID, name: 'Local test', source: BASE, revision: 4, versions: 5,
    createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T01:00:00.000Z', archived: false,
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const controllers: ReturnType<typeof mountPineEditor>[] = [];
beforeEach(() => {
    localStorage.clear();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    if (!HTMLDialogElement.prototype.showModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() {} });
    if (!HTMLDialogElement.prototype.close) Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() {} });
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); });
    if (!Range.prototype.getClientRects) Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
    if (!Range.prototype.getBoundingClientRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([] as unknown as DOMRectList);
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect());
});
afterEach(() => {
    controllers.splice(0).forEach(controller => controller.destroy());
    document.body.replaceChildren();
    localStorage.clear();
    vi.restoreAllMocks();
});

function fixture(storageKey?: string) {
    const get = vi.fn<(path: string) => Promise<unknown>>(async path => path === `/api/scripts/${ID}` ? { ...INITIAL } : []);
    const post = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async (_path, body) => {
        const input = body as { id?: string; name: string; source: string };
        return { ...INITIAL, ...input, id: input.id ?? ID, revision: input.id ? 5 : 0, versions: input.id ? 6 : 1 };
    });
    const host = document.createElement('section'); document.body.append(host);
    const onDirty = vi.fn();
    const onRun = vi.fn(async (_source: string) => ({ id: 'test-instance', name: 'Local test' }));
    const controller = mountPineEditor(host, {
        ...(storageKey ? { storageKey } : {}),
        api: { get, post } as unknown as LocalApi,
        onRun,
        onUpdate: vi.fn(async () => undefined), onBacktest: vi.fn(async () => undefined),
        onClose: vi.fn(), onDirty,
    });
    controllers.push(controller);
    return { host, controller, get, post, onDirty, onRun };
}

function view(host: HTMLElement): EditorView {
    const element = host.querySelector<HTMLElement>('.cm-editor');
    if (!element) throw new Error('Expected a real CodeMirror editor.');
    const result = EditorView.findFromDOM(element);
    if (!result) throw new Error('Expected the mounted CodeMirror view.');
    return result;
}
function edit(host: HTMLElement, source: string): void {
    const editor = view(host);
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: source } });
}
function button(host: HTMLElement, label: RegExp): HTMLButtonElement {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(candidate =>
        label.test(candidate.textContent?.trim() ?? '') || label.test(candidate.getAttribute('aria-label') ?? ''));
    if (!button) throw new Error(`Missing editor button ${label}.`);
    return button;
}
function click(host: HTMLElement, label: RegExp): void {
    const target = button(host, label);
    expect(target.disabled).toBe(false);
    target.click();
}
function submitName(host: HTMLElement, name: string): void {
    const dialog = host.querySelector<HTMLDialogElement>('.pine-name-dialog');
    if (!dialog) throw new Error('Expected the script naming dialog.');
    dialog.querySelector<HTMLInputElement>('input')!.value = name;
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('Pine editor draft and revision safety', () => {
    it('uses a scoped recovery key per window and reuses its session identity across editor remounts', async () => {
        const dataA = new Map<string, string>(), dataB = new Map<string, string>();
        const storage = (data: Map<string, string>) => ({ getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } });
        const firstStorage = storage(dataA), secondStorage = storage(dataB);
        const firstWindow = createEditorDraftStorageKeys(), secondWindow = createEditorDraftStorageKeys(), memoryWindow = createEditorDraftStorageKeys(), unavailableWindow = createEditorDraftStorageKeys();
        try {
            const first = await firstWindow.key(firstStorage, { locks: null }), second = await secondWindow.key(secondStorage, { locks: null });
            expect(first).not.toBe(second); expect(first).toBe(`${PINE_EDITOR_STORAGE_KEY}.${dataA.get(PINE_EDITOR_WINDOW_ID_KEY)}`);
            expect(await firstWindow.key(firstStorage, { locks: null })).toBe(first);
            const unavailable = { getItem: () => { throw new Error('Unavailable'); }, setItem: () => { throw new Error('Unavailable'); } };
            await expect(unavailableWindow.key(unavailable, { locks: null })).rejects.toThrow('Unavailable');
            const memory = await memoryWindow.key(undefined, { locks: null }); expect(await memoryWindow.key(undefined, { locks: null })).toBe(memory); expect(memory).not.toBe(first);
        } finally { await Promise.all([firstWindow.release(), secondWindow.release(), memoryWindow.release(), unavailableWindow.release()]); }
    });
    it('copies a missing scoped draft from legacy recovery without modifying the legacy backup', async () => {
        const legacy = fixture(); legacy.controller.open({ source: BASE, name: 'Legacy recovery' }); edit(legacy.host, CHANGED);
        await legacy.controller.flush(); legacy.controller.destroy(); legacy.host.remove();
        const backup = localStorage.getItem(PINE_EDITOR_STORAGE_KEY);
        const scopedKey = `${PINE_EDITOR_STORAGE_KEY}.recovered-window`, scoped = fixture(scopedKey);
        scoped.controller.open(); expect(view(scoped.host).state.doc.toString()).toBe(CHANGED);
        const scopedSource = `${BASE}\n// Scoped newer source`; edit(scoped.host, scopedSource); await scoped.controller.flush();
        expect(localStorage.getItem(PINE_EDITOR_STORAGE_KEY)).toBe(backup);
        scoped.controller.destroy(); scoped.host.remove(); const restored = fixture(scopedKey); restored.controller.open();
        expect(view(restored.host).state.doc.toString()).toBe(scopedSource); expect(localStorage.getItem(PINE_EDITOR_STORAGE_KEY)).toBe(backup);
    });
    it('fails a scoped draft flush when storage is unavailable and keeps the editor source intact', async () => {
        const key = `${PINE_EDITOR_STORAGE_KEY}.quota-window`, f = fixture(key); f.controller.open({ source: BASE, name: 'Quota recovery' });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota reached'); });
        edit(f.host, CHANGED); await expect(f.controller.flush()).rejects.toThrow('Unable to persist');
        expect(view(f.host).state.doc.toString()).toBe(CHANGED); expect(localStorage.getItem(PINE_EDITOR_STORAGE_KEY)).toBeNull();
    });
    it('saves a named script from its own modal without sending its submit to the outer application', async () => {
        const f = fixture(), outerSubmit = vi.fn(), listener = new AbortController();
        document.addEventListener('submit', outerSubmit, { signal: listener.signal });
        f.controller.open({ source: BASE, name: 'New study' }); edit(f.host, CHANGED); click(f.host, /^Save$/);
        const dialog = f.host.querySelector<HTMLDialogElement>('.pine-name-dialog')!;
        expect(dialog.open).toBe(true); expect(dialog.querySelector<HTMLInputElement>('input')!.maxLength).toBe(200);
        submitName(f.host, 'Named study'); await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
        expect(f.post.mock.lastCall?.[1]).toEqual({ name: 'Named study', source: CHANGED });
        expect(f.host.querySelector('.pine-name-dialog')).toBeNull(); expect(outerSubmit).not.toHaveBeenCalled();
        expect(view(f.host).state.doc.toString()).toBe(CHANGED); listener.abort();
    });
    it('cancels an unfinished naming modal during handoff while preserving its unsaved code', async () => {
        const key = `${PINE_EDITOR_STORAGE_KEY}.handoff-window`, f = fixture(key);
        f.controller.open({ source: BASE, name: 'Unfinished name' }); edit(f.host, CHANGED); click(f.host, /^Save$/);
        expect(f.host.querySelector('.pine-name-dialog')).not.toBeNull(); await f.controller.flush();
        expect(f.host.querySelector('.pine-name-dialog')).toBeNull(); expect(f.post).not.toHaveBeenCalled();
        expect(localStorage.getItem(key)).toContain('Keep this unsaved work'); expect(view(f.host).state.doc.toString()).toBe(CHANGED);
        f.controller.destroy(); f.host.remove(); const restored = fixture(key); restored.controller.open();
        expect(view(restored.host).state.doc.toString()).toBe(CHANGED);
    });
    it.each([
        { action: /^Rename/, name: 'Renamed study', path: '/api/scripts' },
        { action: /^Clone saved script/, name: 'Cloned study', path: `/api/scripts/${ID}/clone` },
    ])('accepts an in-theme name for $name', async ({ action, name, path }) => {
        const f = fixture(); f.controller.open({ id: ID }); await vi.waitFor(() => expect(view(f.host).state.doc.toString()).toBe(BASE));
        click(f.host, action); expect(f.host.querySelector('.pine-name-dialog')).not.toBeNull(); submitName(f.host, name);
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce()); expect(f.post.mock.lastCall?.[0]).toBe(path); expect(f.post.mock.lastCall?.[1]).toMatchObject({ name });
    });
    it('recovers each window’s own edited source after both editors flush and remount', async () => {
        const firstKey = `${PINE_EDITOR_STORAGE_KEY}.window-a`, secondKey = `${PINE_EDITOR_STORAGE_KEY}.window-b`;
        const first = fixture(firstKey), second = fixture(secondKey);
        first.controller.open({ source: BASE, name: 'First window' });
        second.controller.open({ source: BASE, name: 'Second window' });
        const firstSource = `${BASE}\n// First window work`, secondSource = `${BASE}\n// Second window work`;
        edit(first.host, firstSource); edit(second.host, secondSource);
        await first.controller.flush(); await second.controller.flush();
        first.controller.destroy(); second.controller.destroy(); first.host.remove(); second.host.remove();
        const restoredFirst = fixture(firstKey), restoredSecond = fixture(secondKey);
        restoredFirst.controller.open(); restoredSecond.controller.open();
        expect(view(restoredFirst.host).state.doc.toString()).toBe(firstSource);
        expect(view(restoredSecond.host).state.doc.toString()).toBe(secondSource);
        expect(localStorage.getItem(firstKey)).toContain('First window work');
        expect(localStorage.getItem(secondKey)).toContain('Second window work');
    });
    it('flushes a new unsaved draft and restores it after the editor is remounted', async () => {
        const first = fixture(); first.controller.open({ source: BASE, name: 'Scratch study' });
        edit(first.host, CHANGED);
        await first.controller.flush();
        expect(localStorage.getItem(PINE_EDITOR_STORAGE_KEY)).toContain('Keep this unsaved work');
        first.controller.destroy(); controllers.splice(controllers.indexOf(first.controller), 1);
        first.host.remove();
        const restored = fixture(); restored.controller.open();
        expect(view(restored.host).state.doc.toString()).toBe(CHANGED);
        expect(restored.onDirty).toHaveBeenLastCalledWith(true);
    });

    it('does not replace code typed while a requested document is loading', async () => {
        const pending = deferred<ScriptDocument>(); const f = fixture();
        f.get.mockImplementation(async path => path === `/api/scripts/${ID}` ? pending.promise : []);
        f.controller.open({ id: ID });
        edit(f.host, CHANGED);
        pending.resolve({ ...INITIAL });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(f.get.mock.calls.some(([path]) => path === `/api/scripts/${ID}`)).toBe(true);
        expect(view(f.host).state.doc.toString()).toBe(CHANGED);
        await f.controller.flush();
        expect(localStorage.getItem(PINE_EDITOR_STORAGE_KEY)).toContain('Keep this unsaved work');
    });

    it('retains unsaved edits separately when opening different chart code for the same saved document', async () => {
        const chartCode = '//@version=6\nindicator("Chart instance")\nplot(high)';
        const f = fixture(); f.controller.open({ id: ID });
        await vi.waitFor(() => expect(view(f.host).state.doc.toString()).toBe(BASE));
        edit(f.host, CHANGED);
        f.controller.open({ id: ID, source: chartCode });
        await vi.waitFor(() => expect(view(f.host).state.doc.toString()).toBe(chartCode));
        await f.controller.flush();
        const stored = JSON.parse(localStorage.getItem(PINE_EDITOR_STORAGE_KEY)!) as {
            activeKey: string; drafts: { key: string; source: string; dirty: boolean }[];
        };
        const unsaved = stored.drafts.find(draft => draft.source === CHANGED);
        const active = stored.drafts.find(draft => draft.key === stored.activeKey);
        expect(unsaved).toMatchObject({ source: CHANGED, dirty: true });
        expect(active).toMatchObject({ source: chartCode, dirty: true });
        expect(unsaved?.key).not.toBe(active?.key);
    });

    it('runs with Ctrl+Enter without inserting a line into the source', async () => {
        const f = fixture(); f.controller.open({ source: BASE, name: 'Keyboard study' });
        const editor = view(f.host);
        editor.focus();
        editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        await vi.waitFor(() => expect(f.onRun).toHaveBeenCalledExactlyOnceWith(BASE));
        expect(editor.state.doc.toString()).toBe(BASE);
    });

    it('recovers seven small dirty drafts without storing their large saved baselines', async () => {
        const documents = Array.from({ length: 7 }, (_, index): ScriptDocument => {
            const prefix = `//@version=6\nindicator("Large ${index}")\n// `;
            return { ...INITIAL, id: `7ae7f9c2-5250-47e5-adbd-8ff0c9171f8${index}`,
                name: `Large ${index}`, source: prefix + 'x'.repeat(200_000 - prefix.length) };
        });
        const first = fixture();
        first.get.mockImplementation(async path => documents.find(item => path === `/api/scripts/${item.id}`) ?? []);
        for (const saved of documents) {
            first.controller.open({ id: saved.id });
            await vi.waitFor(() => expect(view(first.host).state.doc.toString()).toBe(saved.source));
            edit(first.host, 'x');
        }
        await first.controller.flush();
        expect(localStorage.getItem(PINE_EDITOR_STORAGE_KEY)!.length).toBeLessThan(50_000);
        first.controller.destroy(); controllers.splice(controllers.indexOf(first.controller), 1); first.host.remove();
        const restored = fixture(); restored.controller.open();
        expect(view(restored.host).state.doc.toString()).toBe('x');
        expect(restored.onDirty).toHaveBeenLastCalledWith(true);
        await restored.controller.flush();
        const stored = JSON.parse(localStorage.getItem(PINE_EDITOR_STORAGE_KEY)!) as {
            drafts: { source: string; dirty: boolean; document: { id: string } | null }[];
        };
        expect(stored.drafts.filter(draft => draft.dirty)).toHaveLength(7);
        for (const saved of documents) expect(stored.drafts.find(draft => draft.document?.id === saved.id)).toMatchObject({ source: 'x', dirty: true });
    });

    it('keeps the source and recoverable draft when a save conflicts with another revision', async () => {
        const f = fixture(); f.controller.open({ id: ID });
        await vi.waitFor(() => expect(view(f.host).state.doc.toString()).toBe(BASE));
        edit(f.host, CHANGED);
        f.post.mockRejectedValueOnce(new ApiError('Script changed. Reload it before continuing.', 409));
        click(f.host, /^Save$/);
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(f.host.textContent).toMatch(/changed|conflict/i));
        expect(f.post.mock.calls[0]?.[1]).toMatchObject({ id: ID, expectedRevision: INITIAL.revision, source: CHANGED });
        expect(view(f.host).state.doc.toString()).toBe(CHANGED);
        await f.controller.flush();
        expect(localStorage.getItem(PINE_EDITOR_STORAGE_KEY)).toContain('Keep this unsaved work');
        expect(f.onDirty).toHaveBeenLastCalledWith(true);
    });

    it('opens the latest saved source from Library after a conflict while retaining the conflicting draft', async () => {
        let latest = { ...INITIAL }; const f = fixture();
        f.get.mockImplementation(async path => {
            if (path === `/api/scripts/${ID}`) return { ...latest };
            return path === '/api/scripts?includeArchived=true' ? [{ ...latest }] : [];
        });
        f.controller.open({ id: ID });
        await vi.waitFor(() => expect(view(f.host).state.doc.toString()).toBe(BASE));
        edit(f.host, CHANGED);
        f.post.mockRejectedValueOnce(new ApiError('Script changed. Reload it before continuing.', 409));
        click(f.host, /^Save$/);
        await vi.waitFor(() => expect(f.host.textContent).toMatch(/conflict/i));
        latest = { ...INITIAL, revision: 5, versions: 6, source: `${BASE}\n// Other saved revision` };
        click(f.host, /^Library$/);
        await vi.waitFor(() => expect(f.host.querySelector('.pine-editor-script-open')?.textContent).toBe(latest.name));
        click(f.host, /^Local test$/);
        await vi.waitFor(() => expect(view(f.host).state.doc.toString()).toBe(latest.source));
        expect(f.onDirty).toHaveBeenLastCalledWith(false);
        await f.controller.flush();
        const stored = JSON.parse(localStorage.getItem(PINE_EDITOR_STORAGE_KEY)!) as {
            drafts: { source: string; dirty: boolean }[];
        };
        expect(stored.drafts.find(draft => draft.source === CHANGED)).toMatchObject({ source: CHANGED, dirty: true });
    });

    it('keeps edits made during a pending save and saves them with the returned revision', async () => {
        const pending = deferred<ScriptDocument>(); const f = fixture(); f.controller.open({ id: ID });
        await vi.waitFor(() => expect(view(f.host).state.doc.toString()).toBe(BASE));
        edit(f.host, `${BASE}\n// First save`);
        f.post.mockReturnValueOnce(pending.promise);
        click(f.host, /^Save$/);
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(1));
        edit(f.host, CHANGED);
        pending.resolve({ ...INITIAL, source: `${BASE}\n// First save`, revision: 5, versions: 6 });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(f.onDirty).toHaveBeenLastCalledWith(true);
        expect(view(f.host).state.doc.toString()).toBe(CHANGED);
        await f.controller.flush();
        expect(localStorage.getItem(PINE_EDITOR_STORAGE_KEY)).toContain('Keep this unsaved work');
        click(f.host, /^Save$/);
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(2));
        expect(f.post.mock.calls[1]?.[1]).toMatchObject({ id: ID, expectedRevision: 5, source: CHANGED });
    });

    it('saves a dirty existing document as an independent new document without its revision', async () => {
        const f = fixture(); f.controller.open({ id: ID });
        await vi.waitFor(() => expect(view(f.host).state.doc.toString()).toBe(BASE));
        edit(f.host, CHANGED);
        click(f.host, /^Save as/i);
        submitName(f.host, 'Local test copy');
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(1));
        const payload = f.post.mock.calls[0]?.[1];
        expect(f.post.mock.calls[0]?.[0]).toBe('/api/scripts');
        expect(payload).toMatchObject({ name: 'Local test copy', source: CHANGED });
        expect(payload).not.toHaveProperty('id');
        expect(payload).not.toHaveProperty('expectedRevision');
    });

    it('saves an older version against the current revision so history advances without overwriting that version', async () => {
        const historical = '//@version=6\nindicator("Original")\nplot(open)';
        const f = fixture();
        f.get.mockImplementation(async path => {
            if (path === `/api/scripts/${ID}`) return { ...INITIAL };
            if (path === `/api/scripts/${ID}/versions`) return [
                { scriptId: ID, version: 5, name: INITIAL.name, createdAt: INITIAL.updatedAt },
                { scriptId: ID, version: 1, name: 'Original', createdAt: INITIAL.createdAt },
            ];
            if (path === `/api/scripts/${ID}/versions/1`) return {
                scriptId: ID, version: 1, name: 'Original', source: historical, createdAt: INITIAL.createdAt,
            };
            return [];
        });
        f.controller.open({ id: ID });
        await vi.waitFor(() => expect(view(f.host).state.doc.toString()).toBe(BASE));
        click(f.host, /^History$/);
        await vi.waitFor(() => expect(f.host.querySelectorAll('.pine-editor-version')).toHaveLength(2));
        click(f.host, /^v1\s/);
        await vi.waitFor(() => expect(view(f.host).state.doc.toString()).toBe(historical));
        expect(f.onDirty).toHaveBeenLastCalledWith(true);
        click(f.host, /^Save$/);
        await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(1));
        expect(f.post.mock.calls[0]).toEqual(['/api/scripts', {
            id: ID, expectedRevision: INITIAL.revision, name: 'Original', source: historical,
        }]);
    });

    it('does not replace edits made while an older version is loading', async () => {
        const pending = deferred<unknown>(); const f = fixture();
        f.get.mockImplementation(async path => {
            if (path === `/api/scripts/${ID}`) return { ...INITIAL };
            if (path === `/api/scripts/${ID}/versions`) return [
                { scriptId: ID, version: 1, name: 'Original', createdAt: INITIAL.createdAt },
            ];
            return path === `/api/scripts/${ID}/versions/1` ? pending.promise : [];
        });
        f.controller.open({ id: ID });
        await vi.waitFor(() => expect(view(f.host).state.doc.toString()).toBe(BASE));
        click(f.host, /^History$/);
        await vi.waitFor(() => expect(f.host.querySelectorAll('.pine-editor-version')).toHaveLength(1));
        click(f.host, /^v1\s/);
        edit(f.host, CHANGED);
        pending.resolve({ scriptId: ID, version: 1, name: 'Original', source: 'plot(open)', createdAt: INITIAL.createdAt });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(view(f.host).state.doc.toString()).toBe(CHANGED);
        expect(f.onDirty).toHaveBeenLastCalledWith(true);
        await f.controller.flush();
        expect(localStorage.getItem(PINE_EDITOR_STORAGE_KEY)).toContain('Keep this unsaved work');
    });

    it('keeps save and run disabled while a newer document load outlives a stale version request', async () => {
        const nextId = '8ae7f9c2-5250-47e5-adbd-8ff0c9171f89';
        const pendingVersion = deferred<unknown>(); const pendingDocument = deferred<ScriptDocument>();
        const f = fixture();
        f.get.mockImplementation(async path => {
            if (path === `/api/scripts/${ID}`) return { ...INITIAL };
            if (path === `/api/scripts/${ID}/versions`) return [
                { scriptId: ID, version: 1, name: 'Original', createdAt: INITIAL.createdAt },
            ];
            if (path === `/api/scripts/${ID}/versions/1`) return pendingVersion.promise;
            return path === `/api/scripts/${nextId}` ? pendingDocument.promise : [];
        });
        f.controller.open({ id: ID });
        await vi.waitFor(() => expect(view(f.host).state.doc.toString()).toBe(BASE));
        click(f.host, /^History$/);
        await vi.waitFor(() => expect(f.host.querySelectorAll('.pine-editor-version')).toHaveLength(1));
        click(f.host, /^v1\s/);
        f.controller.open({ id: nextId });
        pendingVersion.resolve({ scriptId: ID, version: 1, name: 'Original', source: 'plot(open)', createdAt: INITIAL.createdAt });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(button(f.host, /^Save$/).disabled).toBe(true);
        expect(button(f.host, /^Run$/).disabled).toBe(true);
        const next = { ...INITIAL, id: nextId, name: 'Next script', source: 'plot(low)' };
        pendingDocument.resolve(next);
        await vi.waitFor(() => expect(view(f.host).state.doc.toString()).toBe(next.source));
        expect(button(f.host, /^Save$/).disabled).toBe(false);
        expect(button(f.host, /^Run$/).disabled).toBe(false);
    });
});
