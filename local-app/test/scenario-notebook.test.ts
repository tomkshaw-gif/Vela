// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type LocalApi } from '../client/api';
import { mountScenarioNotebook, type ScenarioNotebook } from '../client/scenario-notebook';
import { emptyScenarioContent, type ScenarioContext, type ScenarioDocument, type SaveScenarioInput } from '../shared/scenarios';

const context: ScenarioContext = { sessionId: '11111111-1111-4111-8111-111111111111', datasetId: '22222222-2222-4222-8222-222222222222', datasetChecksum: 'a'.repeat(64), cursor: 2, cutoff: 5000 };
const other: ScenarioContext = { ...context, sessionId: '33333333-3333-4333-8333-333333333333' };
const id = '44444444-4444-4444-8444-444444444444';
const initial: ScenarioDocument = { id, title: 'Saved study', revision: 3, archived: false, createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', context,
    content: { ...emptyScenarioContent(), title: 'Saved study', notes: 'Original notes' } };
const controllers: ScenarioNotebook[] = [];
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(storageKey = 'scenario-test') {
    const get = vi.fn<(path: string) => Promise<unknown>>(async path => path.endsWith(`/${id}`) ? structuredClone(initial) : [initial]);
    const post = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async (_path, body) => {
        const input = body as SaveScenarioInput;
        return { ...initial, context: input.context, content: structuredClone(input.content), title: input.content.title, id: input.id ?? id, revision: input.id ? input.expectedRevision! + 1 : 0 };
    });
    const host = document.createElement('section'); document.body.append(host); const preview = vi.fn();
    const notebook = mountScenarioNotebook(host, { api: { get, post } as unknown as LocalApi, storageKey, onPreview: preview }); controllers.push(notebook);
    notebook.setContext(context); return { host, notebook, get, post, preview };
}
async function settle() { await new Promise(resolve => setTimeout(resolve, 0)); }
function field(host: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
    const node = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`); expect(node, label).not.toBeNull(); return node!;
}
function edit(host: HTMLElement, label: string, value: string) { const input = field(host, label); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
function button(host: HTMLElement, label: string) { const result = [...host.querySelectorAll('button')].find(item => item.textContent === label); expect(result, label).toBeDefined(); return result!; }
async function load(host: HTMLElement) {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Saved scenarios"]')!; expect(select).not.toBeNull(); select.value = id; select.dispatchEvent(new Event('change')); await settle();
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { controllers.splice(0).forEach(controller => controller.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('scenario notebook ownership and explicit saves', () => {
    for (const title of ['', '   ']) it(`recovers an incomplete ${JSON.stringify(title)} title and all other drafts without normalizing its bytes`, async () => {
        const f = fixture(); await settle(); edit(f.host, 'Notes', 'Earlier retained notes'); button(f.host, 'New').click(); edit(f.host, 'Notes', 'Incomplete draft notes'); edit(f.host, 'Scenario title', title);
        await f.notebook.prepare(); expect(f.post).not.toHaveBeenCalled(); const recovery = JSON.parse(localStorage.getItem('scenario-test')!);
        expect(recovery.drafts[1].form.title).toBe(title); f.notebook.destroy(); const next = fixture(); await settle();
        expect(field(next.host, 'Scenario title').value).toBe(title); expect(field(next.host, 'Notes').value).toBe('Incomplete draft notes');
        const select = next.host.querySelector<HTMLSelectElement>('[aria-label="Local scenario drafts"]')!; expect(select.options.length).toBe(3);
        await expect(next.notebook.prepare()).resolves.toBeUndefined(); button(next.host, 'Save').click(); await settle(); expect(next.post).not.toHaveBeenCalled();
        select.value = recovery.drafts[0].key; select.dispatchEvent(new Event('change')); expect(field(next.host, 'Notes').value).toBe('Earlier retained notes');
    });
    for (const olderFirst of [false, true]) it(`keeps an acknowledged save in the library when the older list resolves ${olderFirst ? 'before' : 'after'} the refreshed list`, async () => {
        const f = fixture(); await settle(); const older = deferred<unknown>(); f.get.mockReturnValueOnce(older.promise);
        f.notebook.setContext({ ...context, cursor: 3, cutoff: 9000 });
        if (olderFirst) { older.resolve([]); await settle(); }
        edit(f.host, 'Notes', 'Explicit saved draft'); f.get.mockResolvedValueOnce([{ ...initial, revision: 0 }]); button(f.host, 'Save').click(); await settle();
        const present = () => [...f.host.querySelector<HTMLSelectElement>('[aria-label="Saved scenarios"]')!.options].some(option => option.value === id);
        expect(present()).toBe(true); if (!olderFirst) { older.resolve([]); await settle(); } expect(present()).toBe(true);
        expect(field(f.host, 'Notes').value).toBe('Explicit saved draft'); expect(f.post).toHaveBeenCalledTimes(1);
    });
    it('edits both cases and notes, saves explicitly, and recovers a local draft after remount', async () => {
        const f = fixture(); await settle(); edit(f.host, 'Bull thesis', 'Upside acceptance'); edit(f.host, 'Bear invalidation', 'Above rejection high'); edit(f.host, 'Notes', 'Keep my notes');
        expect(f.post).not.toHaveBeenCalled(); await f.notebook.prepare(); expect(f.post).not.toHaveBeenCalled();
        f.notebook.destroy(); const restored = fixture(); await settle(); expect(field(restored.host, 'Notes').value).toBe('Keep my notes');
        button(restored.host, 'Save').click(); await settle(); expect(restored.post).toHaveBeenCalledWith(expect.stringContaining('/scenarios'), expect.objectContaining({ content: expect.objectContaining({ notes: 'Keep my notes', bull: expect.objectContaining({ thesis: 'Upside acceptance' }) }), context }));
    });
    it('preserves the local draft and exact old revision after a conflict until explicit Save as new', async () => {
        const f = fixture(); await settle(); await load(f.host); edit(f.host, 'Notes', 'My conflicting draft');
        f.post.mockRejectedValueOnce(new ApiError('Sensitive server path must not appear', 409)); button(f.host, 'Save').click(); await settle();
        expect(field(f.host, 'Notes').value).toBe('My conflicting draft'); expect(f.host.textContent).toContain('changed'); expect(f.host.textContent).not.toContain('Sensitive');
        expect((f.post.mock.calls[0]![1] as SaveScenarioInput).expectedRevision).toBe(3);
        button(f.host, 'Save as new').click(); await settle(); expect(f.post.mock.calls[1]![1]).not.toHaveProperty('id');
        expect(field(f.host, 'Notes').value).toBe('My conflicting draft'); await expect(f.notebook.prepare()).resolves.toBeUndefined();
    });
    it('does not overwrite typing during save, and advances the exact baseline for the next save', async () => {
        const f = fixture(); await settle(); await load(f.host); edit(f.host, 'Notes', 'Submitted notes');
        const pending = deferred<ScenarioDocument>(); f.post.mockReturnValueOnce(pending.promise); button(f.host, 'Save').click(); edit(f.host, 'Notes', 'Newer typing');
        pending.resolve({ ...initial, revision: 4, content: { ...initial.content, notes: 'Submitted notes' } }); await settle();
        expect(field(f.host, 'Notes').value).toBe('Newer typing'); button(f.host, 'Save').click(); await settle();
        expect(f.post.mock.calls[1]![1]).toMatchObject({ id, expectedRevision: 4, content: { notes: 'Newer typing' } });
    });
    it('keeps sessions separate while an old save resolves and restores that old draft later', async () => {
        const f = fixture(); await settle(); edit(f.host, 'Notes', 'Session A'); const pending = deferred<ScenarioDocument>(); f.post.mockReturnValueOnce(pending.promise);
        button(f.host, 'Save').click(); f.notebook.setContext(other); await settle(); edit(f.host, 'Notes', 'Session B');
        pending.resolve({ ...initial, revision: 0, title: 'Untitled scenario', content: { ...emptyScenarioContent(), notes: 'Session A' } }); await settle();
        expect(field(f.host, 'Notes').value).toBe('Session B'); f.notebook.setContext(context); await settle(); expect(field(f.host, 'Notes').value).toBe('Session A');
    });
    it('does not replace a newer edited draft with a late document read', async () => {
        const f = fixture(); await settle(); const pending = deferred<ScenarioDocument>(); f.get.mockReturnValueOnce(pending.promise);
        const select = f.host.querySelector<HTMLSelectElement>('[aria-label="Saved scenarios"]')!; select.value = id; select.dispatchEvent(new Event('change'));
        edit(f.host, 'Notes', 'Typed during load'); pending.resolve(initial); await settle(); expect(field(f.host, 'Notes').value).toBe('Typed during load');
    });
    it('hides later local content on rewind and restores the retained draft after advancing again', async () => {
        const f = fixture(); await settle(); edit(f.host, 'Notes', 'Later visible knowledge'); f.notebook.setContext({ ...context, cursor: 0, cutoff: 1000 }); await settle();
        expect(f.host.textContent).not.toContain('Later visible knowledge'); expect(field(f.host, 'Notes').value).not.toBe('Later visible knowledge');
        f.notebook.setContext(context); await settle(); expect(field(f.host, 'Notes').value).toBe('Later visible knowledge');
    });
    it('drains pending explicit saves before prepare and rejects a failed save barrier without losing notes', async () => {
        const f = fixture(); await settle(); edit(f.host, 'Notes', 'Do not lose'); const pending = deferred<ScenarioDocument>(); f.post.mockReturnValueOnce(pending.promise);
        button(f.host, 'Save').click(); let completed = false; const ready = f.notebook.prepare().then(() => { completed = true; }); const checked = expect(ready).rejects.toThrow();
        await settle(); expect(completed).toBe(false); pending.reject(new Error('Network path credential')); await checked;
        expect(field(f.host, 'Notes').value).toBe('Do not lose'); expect(f.host.textContent).not.toContain('credential');
    });
    it('blocks prepare on recovery storage failure and preserves the visible draft', async () => {
        const f = fixture(); await settle(); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); }); edit(f.host, 'Notes', 'Keep in memory');
        await expect(f.notebook.prepare()).rejects.toThrow(); expect(field(f.host, 'Notes').value).toBe('Keep in memory');
    });
    it('previews annotations only after explicit action and never invokes trading or save', async () => {
        const f = fixture(); await settle(); edit(f.host, 'Bull trigger price', '18000.25'); edit(f.host, 'Bear invalidation price', '18050');
        expect(f.preview).not.toHaveBeenCalled(); button(f.host, 'Preview levels').click(); await settle(); expect(f.preview).toHaveBeenCalledWith([
            expect.objectContaining({ case: 'bull', kind: 'trigger', price: 18000.25 }), expect.objectContaining({ case: 'bear', kind: 'invalidation', price: 18050 }),
        ], context); expect(f.post).not.toHaveBeenCalled();
    });
    it('rejects non-finite level input without turning it into a saved null or drawing', async () => {
        const f = fixture(); await settle(); edit(f.host, 'Bull trigger price', 'NaN'); button(f.host, 'Save').click(); button(f.host, 'Preview levels').click(); await settle();
        expect(f.post).not.toHaveBeenCalled(); expect(f.preview).not.toHaveBeenCalled(); expect(field(f.host, 'Bull trigger price').value).toBe('NaN');
    });
    it('loads a newer server copy separately after conflict and keeps the conflicting draft selectable', async () => {
        const f = fixture(); await settle(); await load(f.host); edit(f.host, 'Notes', 'Conflicting notes');
        f.post.mockRejectedValueOnce(new ApiError('Conflict', 409)); button(f.host, 'Save').click(); await settle();
        f.get.mockResolvedValueOnce({ ...initial, revision: 4, content: { ...initial.content, notes: 'Other window accepted' } }); await load(f.host);
        expect(field(f.host, 'Notes').value).toBe('Other window accepted');
        const select = f.host.querySelector<HTMLSelectElement>('[aria-label="Local scenario drafts"]')!;
        const dirty = [...select.options].find(option => option.textContent?.endsWith('*'))!; expect(dirty).toBeDefined(); select.value = dirty.value; select.dispatchEvent(new Event('change'));
        expect(field(f.host, 'Notes').value).toBe('Conflicting notes');
    });
    it('does not let a destroyed notebook late failure overwrite a newer remount recovery snapshot', async () => {
        const f = fixture(); await settle(); edit(f.host, 'Notes', 'Old snapshot'); const pending = deferred<ScenarioDocument>(); f.post.mockReturnValueOnce(pending.promise);
        const retainedSaveButton = button(f.host, 'Save'); retainedSaveButton.click(); f.notebook.destroy(); const next = fixture(); await settle(); edit(next.host, 'Notes', 'New snapshot');
        pending.reject(new Error('Old save failed')); await settle(); retainedSaveButton.click();
        const recovery = JSON.parse(localStorage.getItem('scenario-test')!); expect(JSON.stringify(recovery)).toContain('New snapshot'); expect(f.post).toHaveBeenCalledTimes(1);
    });
    it('keeps AI proposals as draft-only and refuses unrevealed evidence without replacing existing notes', async () => {
        const f = fixture(); await settle(); edit(f.host, 'Notes', 'My original');
        expect(f.notebook.propose({ ...emptyScenarioContent(), notes: 'Proposed draft' })).toBe(true); expect(f.post).not.toHaveBeenCalled();
        expect(field(f.host, 'Notes').value).toBe('Proposed draft');
        expect(f.notebook.propose({ ...emptyScenarioContent(), evidence: [{ kind: 'candle', sourceIndex: 3, time: 9000, note: 'Future' }] })).toBe(false);
        expect(field(f.host, 'Notes').value).toBe('Proposed draft'); expect(f.post).not.toHaveBeenCalled();
    });
    it('links only the explicit current candle and retains editable evidence notes after recovery', async () => {
        const f = fixture(); await settle(); button(f.host, 'Link current candle').click(); edit(f.host, 'Evidence 1 note', 'Observed wick'); await f.notebook.prepare(); f.notebook.destroy();
        const next = fixture(); await settle(); expect(field(next.host, 'Evidence 1 note').value).toBe('Observed wick'); button(next.host, 'Save').click(); await settle();
        expect(next.post.mock.calls[0]![1]).toMatchObject({ context, content: { evidence: [{ kind: 'candle', sourceIndex: 2, time: 5000, note: 'Observed wick' }] } });
    });
    it('requires explicit discard of the selected local draft and leaves other notes intact', async () => {
        const f = fixture(); await settle(); edit(f.host, 'Notes', 'First retained'); button(f.host, 'New').click(); edit(f.host, 'Notes', 'Second draft');
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false); button(f.host, 'Discard local draft').click(); expect(field(f.host, 'Notes').value).toBe('Second draft');
        confirm.mockReturnValue(true); button(f.host, 'Discard local draft').click(); expect(field(f.host, 'Notes').value).toBe('First retained'); expect(f.post).not.toHaveBeenCalled();
    });
    it('preserves malformed recovery bytes without overwriting them and blocks the lifecycle barrier', async () => {
        const malformed = '{"version":1,"drafts":[{"private":"keep-original"}]}'; localStorage.setItem('malformed-scenarios', malformed);
        const f = fixture('malformed-scenarios'); await settle(); edit(f.host, 'Notes', 'Safe in memory');
        await expect(f.notebook.prepare()).rejects.toThrow(); expect(localStorage.getItem('malformed-scenarios')).toBe(malformed); expect(field(f.host, 'Notes').value).toBe('Safe in memory');
    });
    it('forks a copied window recovery into an independent owner and never overwrites the source window', async () => {
        vi.resetModules(); const firstModule = await import('../client/scenario-notebook');
        const get = vi.fn(async () => []), post = vi.fn(); const api = { get, post } as unknown as LocalApi;
        const a = document.createElement('section'), b = document.createElement('section'); document.body.append(a, b);
        const first = firstModule.mountScenarioNotebook(a, { api }); controllers.push(first); first.setContext(context); await settle(); edit(a, 'Notes', 'Original window');
        const firstKey = sessionStorage.getItem('vela.local.scenarios.v1')!;
        vi.resetModules(); const secondModule = await import('../client/scenario-notebook'); const second = secondModule.mountScenarioNotebook(b, { api }); controllers.push(second); second.setContext(context); await settle();
        const secondKey = sessionStorage.getItem('vela.local.scenarios.v1')!; expect(secondKey).not.toBe(firstKey); expect(field(b, 'Notes').value).toBe('Original window');
        edit(b, 'Notes', 'Copied window'); edit(a, 'Notes', 'Original updated');
        expect(localStorage.getItem(firstKey)).toContain('Original updated'); expect(localStorage.getItem(firstKey)).not.toContain('Copied window');
        expect(localStorage.getItem(secondKey)).toContain('Copied window'); expect(localStorage.getItem(secondKey)).not.toContain('Original updated'); expect(post).not.toHaveBeenCalled();
    });
});
