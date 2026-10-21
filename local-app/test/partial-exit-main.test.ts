// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../client/api';
import { mountPartialClose, partialCloseMarkup, readTargetLegs, TargetEditor, targetAllocationError, targetEditorMarkup } from '../client/partial-exit-controls';
import { escapeHtml } from '../client/util';
import { createSession } from '../engine';
import { DEFAULT_RULES, INSTRUMENTS, type SessionView } from '../shared/types';

const source = ts.createSourceFile('main.ts', readFileSync('local-app/client/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const studio = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ReplayStudio');
if (!studio || !ts.isClassDeclaration(studio)) throw new Error('ReplayStudio missing.');
const methods = ['command', 'submit', 'showDialog', 'partialCloseDialog', 'amendDialog', 'chartExitDialog'].map(name => {
    const method = studio.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
    if (!method) throw new Error(`Missing actual method ${name}`);
    return method.getText(source);
});
const compiled = ts.transpileModule(`class Harness { ${methods.join('\n')} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
interface Harness {
    view: SessionView; sessionGeneration: number; modalGeneration: number; navigationGeneration: number;
    partialCloseDialog(): void; amendDialog(orderId?: string): void; submit(form: HTMLFormElement): Promise<void>; chartExitDialog(event: CustomEvent): void;
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
function fixture(quantity = 4) {
    document.body.innerHTML = '<div id="save-status"></div><dialog id="modal"><div id="modal-content"></div></dialog>';
    const $ = (selector: string): HTMLElement => document.querySelector(selector)!;
    const value = (id: string): string => ($(`#${id}`) as HTMLInputElement).value;
    const numeric = (id: string): number => Number(value(id));
    const optionalNumber = (id: string): number | undefined => value(id).trim() ? numeric(id) : undefined;
    const Constructor = new Function('$', 'value', 'numeric', 'optionalNumber', 'ApiError', 'esc',
        'mountPartialClose', 'partialCloseMarkup', 'readTargetLegs', 'TargetEditor', 'targetAllocationError', 'targetEditorMarkup', `${compiled}; return Harness;`)(
        $, value, numeric, optionalNumber, ApiError, escapeHtml, mountPartialClose, partialCloseMarkup, readTargetLegs, TargetEditor, targetAllocationError, targetEditorMarkup) as new () => Harness;
    const harness = new Constructor();
    const instrument = INSTRUMENTS[0]!;
    const session = createSession({ name: 'Inert partial modal', datasetId: 'synthetic', mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES } }, instrument, 'inert-partial');
    session.cursor = 0;
    session.position = { side: 'buy', qty: quantity, avgPrice: 100, entryTime: 0, entryFees: 0, stopLoss: 90, takeProfit: 120, mae: 0, mfe: 0 };
    const view: SessionView = { session, dataset: { id: 'synthetic', name: 'Synthetic', symbol: 'NQZ6', schema: 'ohlcv-1m', intervalMs: 60000,
        instrument, barCount: 10, start: 0, end: 600000, source: 'demo', createdAt: '', checksum: '' } };
    const modal = document.querySelector<HTMLDialogElement>('#modal')!;
    modal.showModal = () => modal.setAttribute('open', ''); modal.close = () => modal.removeAttribute('open');
    const accepted = (): SessionView => ({ ...view, session: { ...view.session, revision: view.session.revision + 1 } });
    const post = vi.fn<(...args: unknown[]) => Promise<SessionView>>(async () => accepted());
    const error = vi.fn(), toast = vi.fn(), pause = vi.fn();
    Object.assign(harness, { view, sessionGeneration: 1, modalGeneration: 0, navigationGeneration: 0, chartReady: true, mode: 'backtest',
        runtimeBlocked: false, starting: false, disposed: false, mutationBusy: false, playing: false, jumping: false, navigating: false,
        commandQueue: Promise.resolve(), sessionController: new AbortController(), api: { post }, analyticsVersion: 0,
        renderView: vi.fn(), updateControls: vi.fn(), updateSummary: vi.fn(), analyticsRefresh: { invalidate: vi.fn(), wake: vi.fn() }, error, toast, pause });
    const form = (): HTMLFormElement => modal.querySelector('form')!;
    const rows = (): HTMLElement[] => Array.from(form().querySelectorAll('[data-target-row]'));
    const add = (): void => form().querySelector<HTMLButtonElement>('[data-target-add]')!.click();
    const input = (selector: string, next: string): void => {
        const field = form().querySelector<HTMLInputElement>(selector)!; field.value = next; field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const event = (type = 'local-replay:chart-partial-close', overrides = {}): CustomEvent => new CustomEvent(type, { detail: {
        sessionId: session.id, revision: session.revision, cursor: session.cursor, ...session.position, ...overrides,
    } });
    return { harness, view, modal, post, error, toast, pause, accepted, form, rows, add, input, event };
}

describe('guarded partial-close and target amendment dialogs', () => {
    it('queues an explicit rounded-down close from current remaining quantity under the captured revision', async () => {
        const f = fixture(5); f.harness.partialCloseDialog();
        f.form().querySelector<HTMLButtonElement>('[data-close-percent="50"]')!.click();
        await f.harness.submit(f.form());
        expect(f.post.mock.calls[0]?.[1]).toEqual({ expectedRevision: 0, command: { type: 'close', qty: 2 } });
        expect(f.modal.open).toBe(false);
    });

    it.each(['revision', 'cursor', 'quantity', 'entry', 'side'] as const)('rejects a stale %s owner before submitting an open partial-close modal', async change => {
        const f = fixture(); f.harness.partialCloseDialog();
        if (change === 'revision') f.view.session.revision++;
        if (change === 'cursor') f.view.session.cursor++;
        if (change === 'quantity') f.view.session.position!.qty--;
        if (change === 'entry') f.view.session.position!.entryTime++;
        if (change === 'side') f.view.session.position!.side = 'sell';
        await f.harness.submit(f.form());
        expect(f.post).not.toHaveBeenCalled(); expect(f.modal.open).toBe(true);
        if (change === 'revision') expect(f.error).toHaveBeenCalledOnce(); else expect(f.toast).toHaveBeenCalledOnce();
    });

    it.each(['quantity', 'entry', 'cursor'] as const)('retains the modal if its %s owner changes in the accepted response', async change => {
        const f = fixture(); f.harness.partialCloseDialog();
        const response = f.accepted(); response.session.position = { ...response.session.position! };
        if (change === 'quantity') response.session.position.qty--;
        if (change === 'entry') response.session.position.entryTime++;
        if (change === 'cursor') response.session.cursor++;
        f.post.mockResolvedValue(response); await f.harness.submit(f.form());
        expect(f.modal.open).toBe(true); expect(f.toast).not.toHaveBeenCalled();
    });

    it.each(['position', 'order'] as const)('submits %s target allocations atomically with stable IDs and preserves the scalar input ID', async owner => {
        const f = fixture();
        if (owner === 'order') f.view.session.orders.push({ id: 'working', side: 'buy', type: 'limit', qty: 4, price: 99, takeProfit: 120, status: 'working', createdTime: 0 });
        f.harness.amendDialog(owner === 'order' ? 'working' : undefined); f.add();
        const targets = readTargetLegs(f.form());
        expect(targets.map(leg => leg.qty)).toEqual([2, 2]); expect(f.form().querySelector('#amend-take')).not.toBeNull();
        await f.harness.submit(f.form());
        expect(f.post.mock.calls[0]?.[1]).toEqual({ expectedRevision: 0, command: { type: 'amend', stopLoss: owner === 'order' ? null : 90,
            takeProfit: null, takeProfits: targets, ...(owner === 'order' ? { orderId: 'working', price: 99 } : {}) } });
        expect(f.modal.open).toBe(false);
    });

    it.each(['added', 'removed', 'replaced-id', 'edited'] as const)('retains %s target fields created or changed during a pending save', async change => {
        const f = fixture(); f.harness.amendDialog(); f.add();
        const pending = deferred<SessionView>(); f.post.mockReturnValue(pending.promise);
        const form = f.form(); const save = f.harness.submit(form); await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
        if (change === 'added') f.add();
        if (change === 'removed') f.rows()[0]!.querySelector<HTMLButtonElement>('[data-target-remove]')!.click();
        if (change === 'replaced-id') f.rows()[0]!.querySelector<HTMLInputElement>('[data-target-leg-id]')!.value = crypto.randomUUID();
        if (change === 'edited') f.input('[data-target-price]', '121');
        const newer = readTargetLegs(form);
        pending.resolve(f.accepted()); await save;
        expect(f.modal.open).toBe(true); expect(f.form()).toBe(form); expect(readTargetLegs(form)).toEqual(newer);
        expect(f.post).toHaveBeenCalledOnce(); expect(f.toast).not.toHaveBeenCalled();
        expect(form.querySelector<HTMLButtonElement>('.primary')!.disabled).toBe(change === 'added');
    });

    it('clears only the selected existing leg and clears the array explicitly when the last leg is removed', async () => {
        const f = fixture();
        delete f.view.session.position!.takeProfit;
        f.view.session.position!.takeProfits = [{ id: crypto.randomUUID(), price: 120, qty: 1 }, { id: crypto.randomUUID(), price: 125, qty: 1 }];
        f.harness.amendDialog(); const survivor = readTargetLegs(f.form())[1]!;
        f.rows()[0]!.querySelector<HTMLButtonElement>('[data-target-remove]')!.click();
        await f.harness.submit(f.form());
        expect(f.post.mock.calls[0]?.[1]).toMatchObject({ command: { takeProfits: [survivor] } });
        f.harness.amendDialog();
        for (const row of f.rows()) row.querySelector<HTMLButtonElement>('[data-target-remove]')!.click();
        await f.harness.submit(f.form());
        expect(f.post.mock.calls[1]?.[1]).toMatchObject({ command: { takeProfits: null, takeProfit: null } });
    });

    it('never falls back to editing a position when a working order is no longer present', () => {
        const f = fixture(); f.harness.amendDialog('missing-order'); expect(f.modal.open).toBe(false);
    });

    it('does not close a replacement modal after a pending target amendment completes', async () => {
        const f = fixture(); f.harness.amendDialog(); f.add();
        const pending = deferred<SessionView>(); f.post.mockReturnValue(pending.promise);
        const save = f.harness.submit(f.form()); await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
        f.modal.close(); f.harness.partialCloseDialog(); const replacement = f.form(); f.input('#close-qty', '2');
        pending.resolve(f.accepted()); await save;
        expect(f.modal.open).toBe(true); expect(f.form()).toBe(replacement);
        expect(replacement.querySelector<HTMLInputElement>('#close-qty')!.value).toBe('2');
    });

    it('opens chart partial controls only for the current captured position and never queues a command while opening', () => {
        const f = fixture();
        f.harness.chartExitDialog(f.event(undefined, { revision: 99 })); expect(f.modal.open).toBe(false);
        f.harness.chartExitDialog(f.event(undefined, { qty: 1 })); expect(f.modal.open).toBe(false);
        f.harness.chartExitDialog(f.event(undefined, { entryTime: 1 })); expect(f.modal.open).toBe(false);
        f.harness.chartExitDialog(f.event()); expect(f.form().id).toBe('partial-close-form');
        expect(f.pause).toHaveBeenCalledOnce(); expect(f.post).not.toHaveBeenCalled();
    });

    it('routes an existing-target chart affordance into the same editor without submitting a scalar amendment', () => {
        const f = fixture(); f.harness.chartExitDialog(f.event('local-replay:chart-edit-exits'));
        expect(f.form().id).toBe('amend-form'); expect(f.form().querySelector('[data-target-add]')).not.toBeNull();
        expect(f.post).not.toHaveBeenCalled();
    });
});
