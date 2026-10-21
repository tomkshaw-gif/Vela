// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as replayTime from '../client/replay-time';
import { escapeHtml, utc } from '../client/util';
import { createSession, validateSessionConfig } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS, type SessionCreateConfig, type SessionView } from '../shared/types';

// Exercise production form methods without starting the app, storage, providers or API clients.
const source = ts.createSourceFile('main.ts', readFileSync('local-app/client/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const studio = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ReplayStudio');
if (!studio || !ts.isClassDeclaration(studio)) throw new Error('ReplayStudio is missing.');
const names = ['submit', 'createSession', 'showDialog', 'newSessionDialog', 'zoneOptions', 'applyPreset', 'updateStartTime',
    'updateTimeOccurrences', 'readReplayTime', 'timeOffsetMarkup', 'replayTimeChanged', 'error'];
const methods = names.map(name => {
    const method = studio.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === name);
    if (!method) throw new Error(`ReplayStudio.${name} is missing.`);
    return method.getText(source);
});
const compiled = ts.transpileModule(`class Harness { ${methods.join('\n')} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

interface Harness {
    view: SessionView | null; sessionGeneration: number; modalGeneration: number;
    navigationGeneration: number;
    newSessionDialog(mode?: 'chart' | 'backtest'): void; showDialog(title: string, body: string): void;
    replayTimeChanged(target: HTMLInputElement | HTMLSelectElement): void;
    submit(form: HTMLFormElement): Promise<void>;
    createSession(form: HTMLFormElement): Promise<SessionView>;
}
function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function fixture() {
    document.body.innerHTML = '<dialog id="modal"><div id="modal-content"></div></dialog>';
    const instrument = INSTRUMENTS[0]!;
    const session = createSession({ name: 'Inert creation fixture', datasetId: 'inert-data', mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES } }, instrument, 'inert-current');
    const start = Date.parse('2026-11-01T04:00:00Z');
    const view: SessionView = { session, dataset: { id: 'inert-data', name: 'Synthetic', symbol: 'NQM4', schema: 'ohlcv-1m', intervalMs: 60000,
        instrument, barCount: 240, start, end: start + 240 * 60000, source: 'demo', createdAt: '', checksum: '' } };
    const created = { ...view, session: { ...session, id: 'inert-created' } };
    const $ = (selector: string): HTMLElement => {
        const element = document.querySelector<HTMLElement>(selector); if (!element) throw new Error(`Missing fixture element: ${selector}`); return element;
    };
    const value = (id: string): string => ($(`#${id}`) as HTMLInputElement).value;
    const numeric = (id: string): number => Number(value(id));
    const optionalNumber = (id: string): number | undefined => value(id).trim() ? numeric(id) : undefined;
    const dependencies = { ...replayTime, $, value, numeric, optionalNumber, esc: escapeHtml, utc, DEFAULT_RULES };
    const Constructor = new Function(...Object.keys(dependencies), `${compiled}; return Harness;`)(...Object.values(dependencies)) as new () => Harness;
    const harness = new Constructor(); const pending = deferred<SessionView>();
    const post = vi.fn((_path: string, _config: SessionCreateConfig) => pending.promise); const refreshIndex = vi.fn(async (): Promise<void> => undefined);
    const openSession = vi.fn(async (_id: string | undefined): Promise<void> => undefined); const toast = vi.fn();
    const action = vi.fn(async (_action: string, data: DOMStringMap) => { await openSession(data.id); });
    Object.assign(harness, { view, bootstrap: { datasets: [view.dataset] }, replayZone: 'UTC', modalGeneration: 0, sessionGeneration: 1,
        disposed: false, runtimeBlocked: false, api: { post }, refreshIndex, openSession, action, toast, pause: vi.fn() });
    const modal = document.querySelector<HTMLDialogElement>('#modal')!;
    modal.showModal = () => modal.setAttribute('open', '');
    modal.close = vi.fn(() => { modal.removeAttribute('open'); harness.modalGeneration++; });
    const form = (): HTMLFormElement => modal.querySelector('form')!;
    const field = (id: string): HTMLInputElement => form().querySelector<HTMLInputElement>(`#${id}`)!;
    const submit = (): Promise<void> => harness.submit(form());
    harness.newSessionDialog(); field('new-name').value = 'Submitted session';
    return { harness, view, created, pending, post, refreshIndex, openSession, action, toast, modal, form, field, submit };
}

function setMode(f: ReturnType<typeof fixture>, mode: 'practice' | 'prop'): void {
    const select = f.form().querySelector<HTMLSelectElement>('#new-mode')!;
    select.value = mode; f.harness.replayTimeChanged(select);
}

function requestSubmit(f: ReturnType<typeof fixture>) {
    let task: Promise<void> | undefined;
    const submitted = vi.fn((event: Event) => { event.preventDefault(); task = f.submit(); });
    f.form().addEventListener('submit', submitted);
    f.form().requestSubmit(f.form().querySelector<HTMLButtonElement>('button.primary')!);
    return { submitted, task };
}

describe('session mode validation and configuration', () => {
    it('disables only inactive evaluation controls and preserves their draft through mode changes', () => {
        const f = fixture(); const rules = f.form().querySelector<HTMLDetailsElement>('#evaluation-rules')!;
        const controls = [...rules.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')];
        expect(controls.every(field => field.disabled && !field.willValidate)).toBe(true);
        expect(f.field('new-balance').disabled).toBe(false); expect(f.field('new-fee').disabled).toBe(false);
        setMode(f, 'prop'); expect(rules.hidden).toBe(false); expect(controls.every(field => !field.disabled)).toBe(true);
        f.field('rule-target').value = ''; f.field('rule-consistency').value = '101'; f.field('rule-lock').checked = false;
        const draft = controls.map(field => ({ value: field.value, checked: field instanceof HTMLInputElement ? field.checked : undefined }));
        expect(f.form().checkValidity()).toBe(false);
        setMode(f, 'practice'); expect(rules.hidden).toBe(true); expect(f.form().checkValidity()).toBe(true);
        setMode(f, 'prop'); expect(f.form().checkValidity()).toBe(false);
        expect(controls.map(field => ({ value: field.value, checked: field instanceof HTMLInputElement ? field.checked : undefined }))).toEqual(draft);
        expect(f.field('rule-target').validity.valueMissing).toBe(true);
        expect(f.field('rule-consistency').validity.rangeOverflow).toBe(true);
    });

    it.each([1, 1500, 2000])('creates practice at balance %s through native form and real engine validation with an invalid evaluation draft', async initialBalance => {
        const f = fixture(); expect(f.form().checkValidity()).toBe(true); setMode(f, 'prop');
        f.field('new-balance').value = String(initialBalance);
        f.field('rule-target').value = ''; f.field('rule-daily').value = '-1'; f.field('rule-consistency').value = '101';
        f.field('rule-contracts').value = '0'; f.field('rule-zone').value = ''; f.field('rule-flat').checked = false;
        expect(f.form().checkValidity()).toBe(false); setMode(f, 'practice');
        expect(f.form().checkValidity()).toBe(true);
        f.post.mockImplementation(async (_path, config) => {
            expect(config).toMatchObject({ startTime: f.view.dataset.start, endTime: f.view.dataset.end });
            const validated = validateSessionConfig({ ...config, startIndex: 0, endIndex: f.view.dataset.barCount }, f.view.dataset.barCount);
            return { ...f.created, session: createSession(validated, f.view.dataset.instrument, f.created.session.id) };
        });
        const request = requestSubmit(f); expect(request.submitted).toHaveBeenCalledOnce(); await request.task;
        expect(f.post).toHaveBeenCalledExactlyOnceWith('/api/sessions', expect.objectContaining({ mode: 'practice', initialBalance, rules: DEFAULT_RULES }));
        expect(f.action).toHaveBeenCalledExactlyOnceWith('open-session', { id: f.created.session.id });
        const submitted = f.post.mock.calls[0]![1];
        expect(() => validateSessionConfig({ ...submitted, startIndex: 0, endIndex: f.view.dataset.barCount, mode: 'prop' }, f.view.dataset.barCount))
            .toThrow('Loss and drawdown limits must be less than initial balance');
    });

    it('does not read inactive evaluation fields when constructing a practice request', async () => {
        const f = fixture();
        for (const field of f.form().querySelectorAll<HTMLInputElement | HTMLSelectElement>('#evaluation-rules input,#evaluation-rules select')) {
            vi.spyOn(field, 'value', 'get').mockImplementation(() => { throw new Error('Inactive evaluation draft was read'); });
        }
        f.pending.resolve(f.created);
        await expect(f.harness.createSession(f.form())).resolves.toBe(f.created);
        expect(f.post).toHaveBeenCalledExactlyOnceWith('/api/sessions', expect.objectContaining({ mode: 'practice', rules: DEFAULT_RULES }));
    });

    it.each([['rule-target', ''], ['rule-consistency', '101'], ['rule-contracts', '0']])(
        'rejects native evaluation submission for invalid %s', (id, value) => {
            const f = fixture(); setMode(f, 'prop'); f.field(id).value = value;
            expect(f.field(id).willValidate).toBe(true); expect(f.form().checkValidity()).toBe(false);
            const request = requestSubmit(f); expect(request.submitted).not.toHaveBeenCalled(); expect(request.task).toBeUndefined();
            expect(f.post).not.toHaveBeenCalled(); expect(f.modal.open).toBe(true);
        });

    it('submits the preserved evaluation draft after returning from practice', async () => {
        const f = fixture(); setMode(f, 'prop');
        f.field('rule-target').value = '4500'; f.field('rule-daily').value = '1250'; f.field('rule-type').value = 'static';
        f.field('rule-consistency').value = '75'; f.field('rule-zone').value = 'Australia/Perth'; f.field('rule-lock').checked = false;
        setMode(f, 'practice'); setMode(f, 'prop'); expect(f.form().checkValidity()).toBe(true);
        f.pending.resolve(f.created); const request = requestSubmit(f); expect(request.submitted).toHaveBeenCalledOnce(); await request.task;
        expect(f.post).toHaveBeenCalledExactlyOnceWith('/api/sessions', expect.objectContaining({ mode: 'prop',
            rules: { ...DEFAULT_RULES, profitTargetUsd: 4500, maxDailyLossUsd: 1250, drawdownType: 'static', consistencyPct: 75,
                dayResetTimezone: 'Australia/Perth', drawdownLocksAtInitialBalance: false } }));
    });
});

describe('session creation completion ownership', () => {
    it('refreshes saved sessions after a cancelled creation without retiring a replacement form or switching context', async () => {
        const f = fixture(); const submitted = f.form(); const task = f.submit();
        expect(f.post).toHaveBeenCalledExactlyOnceWith('/api/sessions', expect.objectContaining({ name: 'Submitted session' }));
        f.modal.close(); f.harness.newSessionDialog(); const replacement = f.form(); f.field('new-name').value = 'Replacement draft';
        f.pending.resolve(f.created); await task;
        expect(f.refreshIndex).toHaveBeenCalledOnce(); expect(f.openSession).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled();
        expect(f.modal.open).toBe(true); expect(f.form()).toBe(replacement); expect(submitted.isConnected).toBe(false);
        expect(f.field('new-name').value).toBe('Replacement draft'); expect(f.toast).toHaveBeenCalledWith(expect.stringMatching(/created.*saved sessions/i));
    });

    it.each(['new-name', 'new-balance', 'rule-lock', 'new-start-time', 'new-end-time', 'new-zone'])(
        'preserves newer %s values in the submitted form and keeps the created session discoverable', async id => {
            const f = fixture(); const form = f.form(); const task = f.submit(); const field = f.field(id);
            if (field.type === 'checkbox') field.checked = !field.checked;
            else field.value = id === 'new-balance' ? '75000' : id === 'new-start-time' || id === 'new-end-time' ? '2026-11-01T05:15' : id === 'new-zone' ? 'America/New_York' : 'Newer draft';
            if (id === 'new-start-time' || id === 'new-end-time' || id === 'new-zone') f.harness.replayTimeChanged(field);
            const edited = { value: field.value, checked: field.checked };
            f.pending.resolve(f.created); await task;
            expect(f.refreshIndex).toHaveBeenCalledOnce(); expect(f.openSession).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled();
            expect(f.modal.open).toBe(true); expect(f.form()).toBe(form); expect(field.value).toBe(edited.value); expect(field.checked).toBe(edited.checked);
            expect(form.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(false);
        });

    it('checks ownership again after the saved-session list refresh', async () => {
        const f = fixture(); const refreshing = deferred<void>(); f.refreshIndex.mockImplementation(() => refreshing.promise);
        const task = f.submit(); f.pending.resolve(f.created); await vi.waitFor(() => expect(f.refreshIndex).toHaveBeenCalledOnce());
        f.modal.close(); f.harness.showDialog('Replacement', '<form id="replacement-form"><input value="untouched"></form>');
        const replacement = f.form(); refreshing.resolve(); await task;
        expect(f.modal.open).toBe(true); expect(f.form()).toBe(replacement); expect(f.openSession).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled();
    });

    it('does not switch back after the active session generation changes', async () => {
        const f = fixture(); const task = f.submit(); f.harness.sessionGeneration++;
        f.harness.view = { ...f.view, session: { ...f.view.session, id: 'inert-other' } };
        f.pending.resolve(f.created); await task;
        expect(f.openSession).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled(); expect(f.modal.open).toBe(true);
        expect(f.harness.view.session.id).toBe('inert-other'); expect(f.refreshIndex).toHaveBeenCalledOnce();
    });

    it.each(['replacement', 'edit'] as const)('keeps delayed errors out of a %s dialog/draft', async kind => {
        const f = fixture(); const task = f.submit();
        if (kind === 'replacement') { f.modal.close(); f.harness.showDialog('Replacement', '<form id="replacement-form"><input value="untouched"></form>'); }
        else f.field('new-name').value = 'Newer draft';
        const form = f.form(); f.pending.reject(new Error('Synthetic creation failure')); await task;
        expect(f.modal.open).toBe(true); expect(f.form()).toBe(form); expect(document.querySelector<HTMLElement>('#dialog-error')!.hidden).toBe(true);
        expect(f.toast).toHaveBeenCalledWith('Synthetic creation failure', true); expect(f.openSession).not.toHaveBeenCalled();
    });

    it('reports errors in the unchanged submitting form', async () => {
        const f = fixture(); const task = f.submit(); f.pending.reject(new Error('Synthetic creation failure')); await task;
        expect(f.modal.open).toBe(true); expect(document.querySelector<HTMLElement>('#dialog-error')!.hidden).toBe(false);
        expect(document.querySelector('#dialog-error')!.textContent).toBe('Synthetic creation failure');
    });

    it('reports an already-created session honestly if the list refresh fails, without opening it', async () => {
        const f = fixture(); f.refreshIndex.mockRejectedValue(new Error('Synthetic refresh failure'));
        const task = f.submit(); f.pending.resolve(f.created); await task;
        expect(f.post).toHaveBeenCalledOnce(); expect(f.openSession).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled();
        expect(f.modal.open).toBe(true); expect(document.querySelector('#dialog-error')!.textContent).toMatch(/Session created.*list could not be refreshed/);
        expect(f.form().querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(false);
    });

    it('retires the unchanged form and opens an accepted creation through the session navigation action', async () => {
        const f = fixture(); const task = f.submit();
        expect(f.form().querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(true);
        f.pending.resolve(f.created); await task;
        expect(f.refreshIndex).toHaveBeenCalledOnce(); expect(f.modal.open).toBe(false);
        expect(f.action).toHaveBeenCalledExactlyOnceWith('open-session', { id: 'inert-created' });
        expect(f.openSession).toHaveBeenCalledExactlyOnceWith('inert-created');
    });

    it('opens an explicitly requested Chart creation in Chart mode', async () => {
        const f = fixture(); f.harness.newSessionDialog('chart'); const task = f.submit(); f.pending.resolve(f.created); await task;
        expect(f.action).toHaveBeenCalledExactlyOnceWith('open-session', { id: 'inert-created', mode: 'chart' });
    });

    it('refreshes a late accepted creation without stealing a newer route intent', async () => {
        const f = fixture(); f.harness.navigationGeneration = 0; const task = f.submit(); f.harness.navigationGeneration++;
        f.pending.resolve(f.created); await task;
        expect(f.refreshIndex).toHaveBeenCalledOnce(); expect(f.action).not.toHaveBeenCalled(); expect(f.modal.open).toBe(true);
    });
});
