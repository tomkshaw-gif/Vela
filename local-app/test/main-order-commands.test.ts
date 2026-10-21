// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../client/api';
import { TradeTicket, tradeTicketMarkup } from '../client/trade-ticket';
import { mountPartialClose, partialCloseMarkup, readTargetLegs, TargetEditor, targetAllocationError, targetEditorMarkup } from '../client/partial-exit-controls';
import { escapeHtml } from '../client/util';
import { createSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS, type Command, type SessionView } from '../shared/types';

// Compile only actual methods; never construct the application or its API/runtime clients.
const source = ts.createSourceFile('main.ts', readFileSync('local-app/client/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const studio = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ReplayStudio');
if (!studio || !ts.isClassDeclaration(studio)) throw new Error('ReplayStudio is missing.');
const names = ['command', 'place', 'submit', 'showDialog', 'amendDialog', 'simpleDialog', 'partialCloseDialog', 'clone', 'exportSession', 'run', 'error'];
const methods = names.map(name => {
    const method = studio.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === name);
    if (!method) throw new Error(`ReplayStudio.${name} is missing.`);
    return method.getText(source);
});
const compiled = ts.transpileModule(`class Harness { ${methods.join('\n')} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

interface Harness {
    view: SessionView | null;
    sessionGeneration: number; navigationGeneration: number; modalGeneration: number; mutationBusy: boolean;
    commandQueue: Promise<void>;
    command(command: Command, strict?: boolean, revision?: number): Promise<'accepted' | 'conflict' | 'stale'>;
    place(side: 'buy' | 'sell'): Promise<void>;
    submit(form: HTMLFormElement): Promise<void>;
    run(task: () => Promise<void>): Promise<unknown>;
    showDialog(title: string, body: string): void;
    amendDialog(orderId?: string): void;
    simpleDialog(title: string, formId: string, label: string, initial: string, button: string): void;
    partialCloseDialog(): void;
    clone(restart: boolean): Promise<void>;
    exportSession(): Promise<void>;
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); });

function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function fixture() {
    document.body.innerHTML = `<div id="save-status"></div><dialog id="modal"><div id="modal-content"></div></dialog>${tradeTicketMarkup()}`;
    const modal = document.querySelector<HTMLDialogElement>('#modal')!;
    const ticket = new TradeTicket(document.querySelector<HTMLFormElement>('#ticket-form')!, { submit() {} });
    cleanups.push(() => ticket.destroy());
    const instrument = INSTRUMENTS[0]!;
    const session = createSession({ name: 'Inert command fixture', datasetId: 'inert-data', mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES } }, instrument, 'inert-command');
    session.cursor = 0;
    session.position = { side: 'buy', qty: 2, avgPrice: 100, entryTime: 0, entryFees: 0, mae: 0, mfe: 0, stopLoss: 95, takeProfit: 105 };
    const view: SessionView = { session, dataset: { id: 'inert-data', name: 'Synthetic', symbol: 'NQM4', schema: 'ohlcv-1m', intervalMs: 60000,
        instrument, barCount: 10, start: 0, end: 600000, source: 'demo', createdAt: '', checksum: '' } };
    const $ = (selector: string): HTMLElement => {
        const element = document.querySelector<HTMLElement>(selector); if (!element) throw new Error(`Missing fixture element: ${selector}`); return element;
    };
    const value = (id: string): string => ($(`#${id}`) as HTMLInputElement).value;
    const numeric = (id: string): number => Number(value(id));
    const optionalNumber = (id: string): number | undefined => value(id).trim() ? numeric(id) : undefined;
    const download = vi.fn();
    const Constructor = new Function('$', 'value', 'numeric', 'optionalNumber', 'ApiError', 'esc', 'downloadJson',
        'mountPartialClose', 'partialCloseMarkup', 'readTargetLegs', 'TargetEditor', 'targetAllocationError', 'targetEditorMarkup', `${compiled}; return Harness;`)(
        $, value, numeric, optionalNumber, ApiError, escapeHtml, download,
        mountPartialClose, partialCloseMarkup, readTargetLegs, TargetEditor, targetAllocationError, targetEditorMarkup) as new () => Harness;
    const harness = new Constructor();
    modal.showModal = () => modal.setAttribute('open', '');
    modal.close = vi.fn(() => { modal.removeAttribute('open'); harness.modalGeneration++; });
    const post = vi.fn(async (): Promise<SessionView> => ({ ...view, session: { ...view.session, revision: view.session.revision + 1 } }));
    const get = vi.fn(async () => ({ inert: true }));
    const toast = vi.fn();
    // Model only the refresh ownership effects, without storage, chart mounting or requests.
    const openSession = vi.fn(async (id: string, _saveLayout = true) => {
        harness.sessionGeneration++; harness.mutationBusy = false; harness.commandQueue = Promise.resolve();
        harness.view = { ...view, session: { ...view.session, id, revision: view.session.revision + 1 } };
        ticket.update(harness.view, 100);
    });
    const snapshot = vi.fn(() => ({ inert: true }));
    Object.assign(harness, { view, tradeTicket: ticket, sessionGeneration: 1, navigationGeneration: 0, mode: 'backtest', modalGeneration: 0, commandQueue: Promise.resolve(),
        runtimeBlocked: false, starting: false, disposed: false, mutationBusy: false, playing: false, jumping: false,
        api: { post, get }, sessionController: new AbortController(), updateControls: vi.fn(), pause: vi.fn(), toast,
        renderView: () => ticket.update(harness.view, 100), updateSummary: vi.fn(), openSession, refreshIndex: vi.fn(),
        navigate: vi.fn(async (_mode: string, id: string, saveLayout: boolean) => { harness.navigationGeneration++; await openSession(id, saveLayout); }),
        analyticsRefresh: { invalidate: vi.fn(), wake: vi.fn() }, charts: { sync: vi.fn(), snapshot }, activeTasks: new Set() });
    ticket.update(view, 100); ticket.selectPrice(99);
    const pending = deferred<SessionView>();
    const waitForPost = async (): Promise<void> => { await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1)); };
    const form = (): HTMLFormElement => modal.querySelector('form')!;
    const input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
    const accept = (): void => pending.resolve({ ...view, session: { ...view.session, revision: view.session.revision + 1 } });
    return { harness, view, modal, ticket, post, get, toast, openSession, snapshot, download, pending, waitForPost, form, input, accept };
}

describe('ticket command outcomes', () => {
    it('keeps the draft and retry notice after a revision conflict, without reporting submission', async () => {
        const f = fixture(); const draft = f.ticket.draft(); f.post.mockRejectedValue(new ApiError('Synthetic conflict', 409));
        await f.harness.place('buy');
        expect(f.openSession).toHaveBeenCalledExactlyOnceWith('inert-command', false);
        expect(f.ticket.draft()).toEqual(draft);
        expect(f.toast.mock.calls).toEqual([['This session changed in another window. Refreshed; please retry your action.', true]]);
    });

    it('returns conflict explicitly and retains strict chart-save rejection', async () => {
        const f = fixture(); f.post.mockRejectedValue(new ApiError('Synthetic conflict', 409));
        await expect(f.harness.command({ type: 'bookmark', label: 'Fixture' })).resolves.toBe('conflict');
        await expect(f.harness.command({ type: 'layout', layout: {} as never }, true)).rejects.toThrow('pending chart snapshot was not saved');
        expect(f.openSession).toHaveBeenCalledTimes(1);
    });

    it('returns stale without a session or when the session changes in the queue', async () => {
        const f = fixture(); const queue = deferred<void>(); f.harness.commandQueue = queue.promise;
        const command = f.harness.command({ type: 'close' }); f.harness.sessionGeneration++; queue.resolve();
        await expect(command).resolves.toBe('stale'); expect(f.post).not.toHaveBeenCalled();
        f.harness.view = null;
        await expect(f.harness.command({ type: 'close' })).resolves.toBe('stale');
    });

    it('does not announce or retire a ticket after an in-flight session change', async () => {
        const f = fixture(); f.post.mockReturnValue(f.pending.promise);
        const work = f.harness.place('buy'); await f.waitForPost();
        f.harness.sessionGeneration++; f.harness.view = { ...f.view, session: { ...f.view.session, id: 'other-inert-session' } };
        f.ticket.update(f.harness.view, 100); f.ticket.selectPrice(98); const draft = f.ticket.draft();
        f.accept(); await work;
        expect(f.ticket.draft()).toEqual(draft); expect(f.toast).not.toHaveBeenCalled();
    });

    it.each([false, true])('accepts a placement and retires only its unchanged ticket (edited=%s)', async edited => {
        const f = fixture(); f.post.mockReturnValue(f.pending.promise); const work = f.harness.place('buy'); await f.waitForPost();
        if (edited) f.ticket.selectPrice(98);
        f.accept(); await work;
        expect(f.input('order-price').value).toBe(edited ? '98' : '');
        expect(f.toast).toHaveBeenCalledExactlyOnceWith('Simulated buy order submitted. Advance a source bar to execute.');
    });
});

const forms = ['amend', 'rename', 'bookmark', 'partial-close'] as const;
function openForm(f: ReturnType<typeof fixture>, kind: typeof forms[number]): { field: HTMLInputElement; next: string } {
    if (kind === 'amend') { f.harness.amendDialog(); return { field: f.input('amend-stop'), next: '96' }; }
    if (kind === 'partial-close') { f.harness.partialCloseDialog(); return { field: f.input('close-qty'), next: '2' }; }
    f.harness.simpleDialog('Inert form', `${kind}-form`, 'Label', 'Initial', 'Save');
    return { field: f.input('simple-value'), next: 'Newer unsaved text' };
}

describe('dialog command completion ownership', () => {
    it.each(forms)('preserves newer %s edits while an earlier snapshot saves', async kind => {
        const f = fixture(); const { field, next } = openForm(f, kind); const form = f.form();
        f.post.mockReturnValue(f.pending.promise); const work = f.harness.submit(form); await f.waitForPost();
        field.value = next; field.dispatchEvent(new Event('input', { bubbles: true }));
        await f.harness.submit(form); expect(f.post).toHaveBeenCalledTimes(1);
        f.accept(); await work;
        expect(f.modal.open).toBe(true); expect(f.form()).toBe(form); expect(field.value).toBe(next);
        expect(form.querySelector<HTMLButtonElement>('.primary')!.disabled).toBe(false);
        expect(f.toast).not.toHaveBeenCalled();
    });

    it.each(forms)('keeps a rejected %s form open on conflict without a success notice', async kind => {
        const f = fixture(); const { field } = openForm(f, kind); const original = field.value;
        f.post.mockRejectedValue(new ApiError('Synthetic conflict', 409)); await f.harness.submit(f.form());
        expect(f.modal.open).toBe(true); expect(field.value).toBe(original);
        expect(f.toast.mock.calls).toEqual([['This session changed in another window. Refreshed; please retry your action.', true]]);
    });

    it.each(forms)('closes an accepted unchanged %s form', async kind => {
        const f = fixture(); openForm(f, kind); await f.harness.submit(f.form());
        expect(f.modal.open).toBe(false);
        expect(f.toast.mock.calls).toEqual(kind === 'bookmark' ? [['Replay bookmark saved.']] : []);
    });

    it.each(['accepted', 'rejected'] as const)('does not close or put an old %s result in a replacement dialog', async outcome => {
        const f = fixture(); f.harness.amendDialog(); const old = f.form();
        f.post.mockReturnValue(f.pending.promise); const work = f.harness.run(() => f.harness.submit(old)); await f.waitForPost();
        f.modal.close(); f.harness.amendDialog(); const replacement = f.form(); f.input('amend-stop').value = '96';
        const settled = work.catch(() => undefined);
        if (outcome === 'accepted') f.accept(); else f.pending.reject(new Error('Synthetic save failure'));
        await settled;
        expect(f.modal.open).toBe(true); expect(f.form()).toBe(replacement); expect(f.input('amend-stop').value).toBe('96');
        expect(document.querySelector<HTMLElement>('#dialog-error')!.hidden).toBe(true);
        expect(replacement.querySelector<HTMLButtonElement>('.primary')!.disabled).toBe(false);
    });

    it('does not read replacement inputs or send a command for a detached submitted form', async () => {
        const f = fixture(); f.harness.amendDialog(); const old = f.form();
        f.harness.amendDialog(); f.input('amend-stop').value = '96'; await f.harness.submit(old);
        expect(f.post).not.toHaveBeenCalled(); expect(f.modal.open).toBe(true); expect(f.input('amend-stop').value).toBe('96');
    });

    it('reports a failed current amendment in its own dialog and preserves its fields', async () => {
        const f = fixture(); f.harness.amendDialog(); f.post.mockRejectedValue(new Error('Synthetic save failure'));
        await f.harness.run(() => f.harness.submit(f.form())).catch(() => undefined);
        expect(f.modal.open).toBe(true); expect(f.input('amend-stop').value).toBe('95');
        expect(document.querySelector('#dialog-error')!.textContent).toBe('Synthetic save failure');
        expect(document.querySelector<HTMLElement>('#dialog-error')!.hidden).toBe(false);
    });
});

describe('layout-save dependent actions', () => {
    it.each(['clone', 'exportSession'] as const)('requires acceptance before %s continues, even without a refresh', async action => {
        const f = fixture(); const command = vi.spyOn(f.harness, 'command').mockResolvedValue('stale');
        if (action === 'clone') await f.harness.clone(false); else await f.harness.exportSession();
        expect(command).toHaveBeenCalledTimes(1); expect(f.post).not.toHaveBeenCalled();
        expect(f.get).not.toHaveBeenCalled(); expect(f.download).not.toHaveBeenCalled(); expect(f.toast).not.toHaveBeenCalled();
    });

    it.each(['clone', 'exportSession'] as const)('stops %s after a rejected layout save', async action => {
        const f = fixture(); f.post.mockRejectedValue(new ApiError('Synthetic conflict', 409));
        if (action === 'clone') await f.harness.clone(false); else await f.harness.exportSession();
        expect(f.post).toHaveBeenCalledTimes(1); expect(f.get).not.toHaveBeenCalled(); expect(f.download).not.toHaveBeenCalled();
        expect(f.toast.mock.calls).toEqual([['This session changed in another window. Refreshed; please retry your action.', true]]);
    });
});
