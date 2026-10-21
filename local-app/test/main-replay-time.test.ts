// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as replayTime from '../client/replay-time';
import { mountDateTimePickers, type DateTimePickers } from '../client/date-time-picker';
import { escapeHtml, utc } from '../client/util';
import { DEFAULT_RULES, INSTRUMENTS, type SessionView } from '../shared/types';
import { createSession } from '../engine';

const source = ts.createSourceFile('main.ts', readFileSync('local-app/client/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const studio = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ReplayStudio');
if (!studio || !ts.isClassDeclaration(studio)) throw new Error('ReplayStudio is missing.');
const names = new Set(['showDialog', 'goToDialog', 'zoneOptions', 'updateStartTime', 'updateGoToZone', 'newSessionDialog', 'applyPreset',
    'submit', 'createSession', 'error', 'timeOffsetMarkup', 'updateTimeOccurrences', 'readReplayTime', 'replayTimeChanged', 'mountReplayTimePickers']);
const methods = studio.members.filter(member => ts.isMethodDeclaration(member) && names.has(member.name.getText(source)));
const compiled = ts.transpileModule(`class Harness { ${methods.map(method => method.getText(source)).join('\n')} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

interface Harness {
    replayZone: string; modalGeneration: number;
    dateTimePickers?: DateTimePickers;
    view: SessionView;
    bootstrap: { datasets: SessionView['dataset'][]; sessions?: { id: string; startTime: number; endTime: number }[] };
    goToDialog(): void; newSessionDialog(): void;
    updateGoToZone(): void; updateStartTime(reset: boolean): void;
    showDialog(title: string, body: string): void;
    replayTimeChanged(target: HTMLInputElement | HTMLSelectElement): void;
    submit(form: HTMLFormElement): Promise<void>;
}
const epoch = (value: string): number => Date.parse(value);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); });

function fixture(start = '2026-11-01T04:00:00Z', end = '2026-11-01T08:00:00Z', cursor = '2026-11-01T06:10:00Z') {
    document.body.innerHTML = '<dialog id="modal"><div id="modal-content"></div></dialog>';
    const instrument = INSTRUMENTS[0]!;
    const session = createSession({ name: 'Inert time fixture', datasetId: 'inert-time', mode: 'practice', initialBalance: 50000,
        commissionPerContractSide: 0, slippageTicks: 0, spreadTicks: 0, startIndex: 0, rules: { ...DEFAULT_RULES } }, instrument, 'inert-time-session');
    const view: SessionView = { session, dataset: { id: 'inert-time', name: 'Synthetic', symbol: 'NQM4', schema: 'ohlcv-1m', intervalMs: 60000,
        instrument, barCount: 240, start: epoch(start), end: epoch(end), source: 'demo', createdAt: '', checksum: '' } };
    const $ = (selector: string): HTMLElement => {
        const element = document.querySelector<HTMLElement>(selector); if (!element) throw new Error(`Missing fixture element: ${selector}`); return element;
    };
    const value = (id: string): string => ($(`#${id}`) as HTMLInputElement).value;
    const numeric = (id: string): number => Number(value(id));
    const optionalNumber = (id: string): number | undefined => value(id).trim() ? numeric(id) : undefined;
    const dependencies = { ...replayTime, mountDateTimePickers, $, value, numeric, optionalNumber, esc: escapeHtml, utc, DEFAULT_RULES };
    const Constructor = new Function(...Object.keys(dependencies), `${compiled}; return Harness;`)(...Object.values(dependencies)) as new () => Harness;
    const harness = new Constructor();
    const post = vi.fn(async () => view); const jumpToTime = vi.fn(async (_time: number) => undefined); const toast = vi.fn();
    Object.assign(harness, { view, bootstrap: { datasets: [view.dataset] }, replayZone: 'UTC', modalGeneration: 0, sessionGeneration: 1,
        charts: { cursorTime: epoch(cursor) }, api: { post }, jumpToTime, refreshIndex: vi.fn(), action: vi.fn(), toast, pause: vi.fn() });
    const modal = document.querySelector<HTMLDialogElement>('#modal')!;
    modal.showModal = () => modal.setAttribute('open', '');
    modal.close = () => { modal.removeAttribute('open'); harness.modalGeneration++; };
    const listener = (event: Event): void => {
        const target = event.target as HTMLInputElement | HTMLSelectElement;
        if (harness.replayTimeChanged) harness.replayTimeChanged(target);
        else if (target.id === 'go-to-zone') harness.updateGoToZone();
        else if (target.id === 'new-zone') harness.updateStartTime(false);
    };
    document.addEventListener('input', listener); document.addEventListener('change', listener);
    cleanups.push(() => { harness.dateTimePickers?.destroy(); document.removeEventListener('input', listener); document.removeEventListener('change', listener); });
    const input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
    const select = (id: string): HTMLSelectElement => document.getElementById(id) as HTMLSelectElement;
    const edit = (id: string, value: string): void => { const field = input(id); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); };
    const choose = (id: string, value: string): void => { const field = select(id); field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); };
    const submit = (): Promise<void> => harness.submit(modal.querySelector('form')!);
    return { harness, view, modal, post, jumpToTime, toast, input, select, edit, choose, submit };
}

describe('replay time form disambiguation', () => {
    it('replaces native date popups with an explicit app picker', () => {
        const f = fixture(); f.harness.newSessionDialog();
        for (const id of ['new-start-time', 'new-end-time']) {
            expect(f.input(id).hidden).toBe(true);
            expect(f.input(id).readOnly).toBe(true);
            expect(document.querySelector(`[data-date-time-trigger="${id}"]`)).not.toBeNull();
        }
        f.harness.goToDialog();
        expect(f.input('go-to-time').hidden).toBe(true);
        expect(document.querySelector('[data-date-time-trigger="go-to-time"]')).not.toBeNull();
    });

    it('recovers the full April cached range after invalid edits without replacing non-date drafts', async () => {
        const f = fixture('2024-04-08T00:00:00Z', '2024-04-10T00:00:00Z'); f.harness.newSessionDialog();
        f.input('new-name').value = 'Keep my session name'; f.input('new-balance').value = '75000';
        f.edit('new-start-time', '2024-02-01T07:24:18'); f.edit('new-end-time', '2026-10-21T00:00');
        await f.submit(); expect(f.post).not.toHaveBeenCalled();
        expect(document.querySelector<HTMLElement>('#dialog-error')!.hidden).toBe(false);
        const reset = document.querySelector<HTMLButtonElement>('[data-date-range-reset]'); expect(reset).not.toBeNull(); reset!.click();
        expect(f.input('new-start-time').value).toBe('2024-04-08T00:00');
        expect(f.input('new-end-time').value).toBe('2024-04-10T00:00');
        expect(f.input('new-start-time').validationMessage).toBe(''); expect(f.input('new-end-time').validationMessage).toBe('');
        expect(document.querySelector<HTMLElement>('#dialog-error')!.hidden).toBe(true);
        expect(f.input('new-name').value).toBe('Keep my session name'); expect(f.input('new-balance').value).toBe('75000');
        await f.submit(); expect(f.post).toHaveBeenCalledExactlyOnceWith('/api/sessions', expect.objectContaining({
            startTime: epoch('2024-04-08T00:00:00Z'), endTime: epoch('2024-04-10T00:00:00Z'), initialBalance: 75000,
        }));
    });

    it('submits second-precision picker values through the existing parser', async () => {
        const f = fixture('2024-04-08T00:00:00Z', '2024-04-10T00:00:00Z'); f.harness.newSessionDialog();
        document.querySelector<HTMLButtonElement>('[data-date-time-trigger="new-start-time"]')!.click();
        const time = document.querySelector<HTMLInputElement>('[data-draft-time]')!;
        time.value = '07:24:18'; time.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector<HTMLButtonElement>('[data-picker-apply]')!.click(); await f.submit();
        expect(f.post).toHaveBeenCalledExactlyOnceWith('/api/sessions', expect.objectContaining({ startTime: epoch('2024-04-08T07:24:18Z') }));
    });

    it('refreshes display and bounds on dataset/zone changes and destroys a replaced popup', () => {
        const f = fixture(); f.harness.newSessionDialog();
        const trigger = document.querySelector<HTMLButtonElement>('[data-date-time-trigger="new-start-time"]')!; trigger.click();
        f.choose('new-zone', 'America/New_York'); expect(document.querySelector<HTMLElement>('.date-time-picker')!.hidden).toBe(true);
        expect(trigger.textContent).toContain('01 November 2026 · 00:00:00');
        f.harness.bootstrap.datasets.push({ ...f.view.dataset, id: 'april', start: epoch('2024-04-08T00:00Z'), end: epoch('2024-04-10T00:00Z') });
        f.select('new-dataset').add(new Option('April fixture', 'april')); f.choose('new-dataset', 'april');
        expect(trigger.textContent).toContain('07 April 2024 · 20:00:00'); expect(document.querySelector('#new-data-range')!.textContent).toContain('2024-04-09 20:00:00 America/New_York');
        trigger.click(); const oldApply = document.querySelector<HTMLButtonElement>('[data-picker-apply]')!;
        f.harness.showDialog('Replacement', '<input id="new-start-time" value="untouched">'); oldApply.click(); trigger.click();
        expect(f.input('new-start-time').value).toBe('untouched'); expect(document.querySelector('.date-time-control')).toBeNull();
    });

    it('focuses the visible date trigger after a canonical range error', async () => {
        const f = fixture(); f.harness.newSessionDialog(); f.edit('new-start-time', '2026-11-02T06:15'); await f.submit();
        expect(document.activeElement).toBe(document.querySelector('[data-date-time-trigger="new-start-time"]'));
    });

    it('chooses the second New York 01:15 after a 06:10Z cursor, without wall-time bounds', async () => {
        const f = fixture(); f.harness.replayZone = 'America/New_York'; f.harness.goToDialog();
        const offset = f.select('go-to-time-offset'); expect(offset).not.toBeNull();
        expect(offset.closest('label')!.hidden).toBe(false);
        expect([...offset.options].map(option => option.text)).toContain('UTC-05:00');
        f.edit('go-to-time', '2026-11-01T01:15'); f.choose('go-to-time-offset', '-300'); await f.submit();
        expect(f.jumpToTime).toHaveBeenCalledExactlyOnceWith(epoch('2026-11-01T06:15:00Z'));
        expect(f.input('go-to-time').min).toBe(''); expect(f.input('go-to-time').max).toBe('');
    });

    it('preserves a known second-occurrence instant from UTC through a New York zone change', async () => {
        const f = fixture(); f.harness.goToDialog();
        f.edit('go-to-time', '2026-11-01T06:15'); f.choose('go-to-zone', 'America/New_York');
        expect(f.input('go-to-time').value).toBe('2026-11-01T01:15');
        await f.submit(); expect(f.jumpToTime).toHaveBeenCalledExactlyOnceWith(epoch('2026-11-01T06:15:00Z'));
        expect(f.select('go-to-time-offset').value).toBe('-300');
    });

    it('retains an explicitly chosen offset when the repeated wall time is edited', async () => {
        const f = fixture(); f.harness.goToDialog(); f.choose('go-to-zone', 'America/New_York');
        f.choose('go-to-time-offset', '-300'); f.edit('go-to-time', '2026-11-01T01:20');
        expect(f.select('go-to-time-offset').value).toBe('-300');
        await f.submit(); expect(f.jumpToTime).toHaveBeenCalledExactlyOnceWith(epoch('2026-11-01T06:20:00Z'));
    });

    it.each(['missing', 'invalid', 'past'] as const)('does not jump with a %s fold choice', async kind => {
        const f = fixture(); f.harness.goToDialog(); f.choose('go-to-zone', 'America/New_York');
        f.edit('go-to-time', '2026-11-01T01:15'); const offset = f.select('go-to-time-offset');
        expect(offset).not.toBeNull();
        if (kind === 'invalid') offset.add(new Option('Invalid offset fixture', '-999'));
        offset.value = kind === 'missing' ? '' : kind === 'invalid' ? '-999' : '-240';
        await f.submit(); expect(f.jumpToTime).not.toHaveBeenCalled(); expect(f.modal.open).toBe(true);
        expect(document.querySelector<HTMLElement>('#dialog-error')!.hidden).toBe(false);
    });

    it('rejects a spring-forward gap without jumping or replacing the invalid draft', async () => {
        const f = fixture('2026-03-08T04:00:00Z', '2026-03-08T12:00:00Z', '2026-03-08T06:00:00Z');
        f.harness.replayZone = 'America/New_York'; f.harness.goToDialog(); f.edit('go-to-time', '2026-03-08T02:30');
        await f.submit(); expect(f.jumpToTime).not.toHaveBeenCalled(); expect(f.input('go-to-time').value).toBe('2026-03-08T02:30');
        expect(document.querySelector('#dialog-error')!.textContent).toMatch(/does not exist/);
    });

    it('preserves a new-session second-occurrence start across zone changes', async () => {
        const f = fixture('2026-11-01T06:15:00Z'); f.harness.newSessionDialog(); f.choose('new-zone', 'America/New_York');
        expect(f.input('new-start-time').value).toBe('2026-11-01T01:15');
        expect(f.select('new-start-time-offset').value).toBe('-300');
        expect(f.input('new-start-time').min).toBe(''); expect(f.input('new-start-time').max).toBe('');
        await f.submit(); expect(f.post).toHaveBeenCalledExactlyOnceWith('/api/sessions', expect.objectContaining({ startTime: epoch('2026-11-01T06:15:00Z') }));
    });

    it('requires a new choice for an ambiguous new-session time and validates its absolute range', async () => {
        const f = fixture(); f.harness.replayZone = 'America/New_York'; f.harness.newSessionDialog();
        f.edit('new-start-time', '2026-11-01T01:15'); const offset = f.select('new-start-time-offset'); expect(offset).not.toBeNull();
        expect(offset.value).toBe(''); await f.submit(); expect(f.post).not.toHaveBeenCalled();
        f.choose('new-start-time-offset', '-300'); f.edit('new-start-time', '2026-11-01T01:20');
        expect(offset.value).toBe('-300'); await f.submit();
        expect(f.post).toHaveBeenCalledExactlyOnceWith('/api/sessions', expect.objectContaining({ startTime: epoch('2026-11-01T06:20:00Z') }));
    });

    it('rejects a new-session start outside the absolute dataset range', async () => {
        const f = fixture(); f.harness.newSessionDialog(); f.edit('new-start-time', '2026-11-02T06:15'); await f.submit();
        expect(f.post).not.toHaveBeenCalled(); expect(f.modal.open).toBe(true);
    });

    it('uses the cached exclusive end and preserves its known fold instant across zone changes', async () => {
        const f = fixture('2026-11-01T04:00:00Z', '2026-11-01T06:15:00Z'); f.harness.newSessionDialog();
        expect(f.input('new-end-time').value).toBe('2026-11-01T06:15'); expect(f.input('new-end-time').step).toBe('1');
        f.choose('new-zone', 'America/New_York');
        expect(f.input('new-end-time').value).toBe('2026-11-01T01:15'); expect(f.select('new-end-time-offset').value).toBe('-300');
        await f.submit(); expect(f.post).toHaveBeenCalledExactlyOnceWith('/api/sessions', expect.objectContaining({
            datasetId: f.view.dataset.id, startTime: epoch('2026-11-01T04:00:00Z'), endTime: epoch('2026-11-01T06:15:00Z'),
        }));
    });

    it('supports a range whose repeated end wall time looks earlier than its start', async () => {
        const f = fixture(); f.harness.replayZone = 'America/New_York'; f.harness.newSessionDialog();
        f.edit('new-start-time', '2026-11-01T01:45'); f.choose('new-start-time-offset', '-240');
        f.edit('new-end-time', '2026-11-01T01:15');
        await f.submit(); expect(f.post).not.toHaveBeenCalled();
        f.choose('new-end-time-offset', '-300'); await f.submit();
        expect(f.post).toHaveBeenCalledExactlyOnceWith('/api/sessions', expect.objectContaining({
            startTime: epoch('2026-11-01T05:45:00Z'), endTime: epoch('2026-11-01T06:15:00Z'),
        }));
    });

    it.each(['2026-11-01T04:00', '2026-11-01T03:59', '2026-11-01T08:01'])(
        'rejects the absolute end %s without losing the draft', async end => {
            const f = fixture(); f.harness.newSessionDialog(); f.edit('new-end-time', end); await f.submit();
            expect(f.post).not.toHaveBeenCalled(); expect(f.modal.open).toBe(true); expect(f.input('new-end-time').value).toBe(end);
            expect(document.querySelector<HTMLElement>('#dialog-error')!.hidden).toBe(false);
        });

    it('rejects a spring-forward end gap and retains both times', async () => {
        const f = fixture('2026-03-08T04:00:00Z', '2026-03-08T12:00:00Z');
        f.harness.replayZone = 'America/New_York'; f.harness.newSessionDialog(); f.edit('new-end-time', '2026-03-08T02:30');
        const start = f.input('new-start-time').value; await f.submit();
        expect(f.post).not.toHaveBeenCalled(); expect(f.input('new-end-time').value).toBe('2026-03-08T02:30');
        expect(f.input('new-start-time').value).toBe(start); expect(document.querySelector('#dialog-error')!.textContent).toMatch(/does not exist/);
    });

    it('bounds Go to by the effective session end before dispatching a jump', async () => {
        const f = fixture(); f.harness.bootstrap.sessions = [{ id: f.view.session.id, startTime: epoch('2026-11-01T04:30:00Z'), endTime: epoch('2026-11-01T06:30:00Z') }];
        f.harness.goToDialog(); f.edit('go-to-time', '2026-11-01T06:30'); await f.submit();
        expect(f.jumpToTime).not.toHaveBeenCalled(); expect(f.modal.open).toBe(true);
        f.edit('go-to-time', '2026-11-01T06:20'); await f.submit(); expect(f.jumpToTime).toHaveBeenCalledExactlyOnceWith(epoch('2026-11-01T06:20:00Z'));
    });

    it('keeps evaluation rules conditional and collapsed, and preserves advanced fill settings', () => {
        const f = fixture(); f.harness.newSessionDialog(); const rules = document.querySelector<HTMLDetailsElement>('#evaluation-rules')!;
        expect(rules.hidden).toBe(true); expect(rules.open).toBe(false);
        f.choose('new-mode', 'prop'); expect(rules.hidden).toBe(false); expect(rules.open).toBe(false);
        expect(f.input('new-fee').closest('details')!.open).toBe(false); expect(f.input('rule-lock').checked).toBe(true);
    });

    it('ignores a detached time-control event after its modal has been replaced', () => {
        const f = fixture(); f.harness.goToDialog(); const old = f.input('go-to-time');
        f.harness.showDialog('Replacement', '<form id="other-form"><input id="go-to-time" value="untouched"></form>');
        f.harness.replayTimeChanged?.(old);
        expect(f.input('go-to-time').value).toBe('untouched'); expect(f.toast).not.toHaveBeenCalled();
    });
});
