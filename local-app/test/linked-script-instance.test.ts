// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from 'codemirror';
import { mountPineEditor, type PineBacktestContext } from '../client/pine-editor';
import { createEditorDraftStorageKeys } from '../client/editor-drafts';
import type { LocalApi } from '../client/api';
import type { ScriptDocument } from '../shared/scripts';

const SOURCE = '//@version=6\nstrategy("Configured strategy")\nplot(close)';
const controllers: ReturnType<typeof mountPineEditor>[] = [];
const managers: ReturnType<typeof createEditorDraftStorageKeys>[] = [];
beforeEach(() => {
    localStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true);
    if (!Range.prototype.getClientRects) Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
    if (!Range.prototype.getBoundingClientRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([] as unknown as DOMRectList); vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect());
});
afterEach(async () => {
    controllers.splice(0).forEach(controller => controller.destroy());
    for (const manager of managers.splice(0)) await manager.release();
    document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks();
});
function fixture(storageKey = `linked-test-${crypto.randomUUID()}`) {
    const host = document.createElement('section'); document.body.append(host);
    const backtest = vi.fn<(source: string, document: ScriptDocument | null, context?: PineBacktestContext) => Promise<void>>(async () => {});
    const controller = mountPineEditor(host, { storageKey, api: { get: vi.fn(async () => []), post: vi.fn() } as unknown as LocalApi,
        onRun: vi.fn(async () => ({ id: 'new-instance', name: 'New instance' })), onUpdate: vi.fn(async () => {}), onBacktest: backtest, onClose: vi.fn() }); controllers.push(controller);
    const code = () => EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
    const edit = (source: string) => { const editor = code(); editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: source } }); };
    const start = () => { const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Backtest')!; expect(button.disabled).toBe(false); button.click(); };
    return { host, controller, backtest, code, edit, start };
}
function storage(data: Map<string, string>) { return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; }

describe('real editor linked backtests', () => {
    it('passes the exact linked instance through Backtest, including an edited source draft', async () => {
        const f = fixture(); f.controller.open({ source: SOURCE, name: 'Instance B', instanceId: 'instance-B' }); f.start();
        await vi.waitFor(() => expect(f.backtest).toHaveBeenCalledExactlyOnceWith(SOURCE, null, { instanceId: 'instance-B' }));
        await vi.waitFor(() => expect([...f.host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Backtest')!.disabled).toBe(false));
        const edited = `${SOURCE}\n// Dry test before updating the chart`; f.edit(edited); f.start();
        await vi.waitFor(() => expect(f.backtest).toHaveBeenLastCalledWith(edited, null, { instanceId: 'instance-B' }));
    });
    it('marks an unlinked source as unlinked instead of selecting a chart instance by source equality', async () => {
        const f = fixture(); f.controller.open({ source: SOURCE, name: 'Standalone draft' }); f.start();
        await vi.waitFor(() => expect(f.backtest).toHaveBeenCalledExactlyOnceWith(SOURCE, null, { instanceId: null }));
    });
    it('keeps copied-window recovery drafts independent through two mounted CodeMirror editors', async () => {
        const held = new Set<string>();
        const locks = { request: async (name: string, _options: { ifAvailable: true }, callback: (lock: object | null) => Promise<void>) => {
            if (held.has(name)) { await callback(null); return; }
            held.add(name); try { await callback({ name }); } finally { held.delete(name); }
        } };
        const firstManager = createEditorDraftStorageKeys(); const secondManager = createEditorDraftStorageKeys(); managers.push(firstManager, secondManager);
        const firstSession = new Map<string, string>(); const firstKey = await firstManager.key(storage(firstSession), { locks, recoveryStorage: localStorage });
        const first = fixture(firstKey); first.controller.open({ source: SOURCE, name: 'First window' }); const firstDraft = `${SOURCE}\n// First window unsaved`; first.edit(firstDraft); await first.controller.flush();
        const oldBackup = localStorage.getItem(firstKey)!;
        const copiedSession = new Map(firstSession); const secondKey = await secondManager.key(storage(copiedSession), { locks, recoveryStorage: localStorage });
        expect(secondKey).not.toBe(firstKey); expect(localStorage.getItem(secondKey)).toBe(oldBackup);
        const second = fixture(secondKey); second.controller.open(); expect(second.code().state.doc.toString()).toBe(firstDraft);
        const secondDraft = `${SOURCE}\n// Second window keeps its own source`; second.edit(secondDraft); await second.controller.flush();
        expect(first.code().state.doc.toString()).toBe(firstDraft); expect(localStorage.getItem(firstKey)).toBe(oldBackup); expect(localStorage.getItem(secondKey)).toContain('Second window keeps its own source');
    });
});
