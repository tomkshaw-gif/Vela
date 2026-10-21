// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountDateTimePickers, type DateTimePickerRange, type DateTimePickers } from '../client/date-time-picker';
import { parseWallTime } from '../client/replay-time';

const cleanups: DateTimePickers[] = [];
afterEach(() => { cleanups.splice(0).forEach(controller => controller.destroy()); document.body.replaceChildren(); });
const epoch = (value: string): number => Date.parse(value);
const canonical = (input: HTMLInputElement): string => input.value.replace(/\.0+$/, '');
function fixture(value = '2024-04-08T07:24:18', zone = 'UTC', range?: DateTimePickerRange) {
    document.body.innerHTML = `<form><div><span>Replay start</span><input id="time" type="datetime-local" step="1" data-date-time-picker aria-label="Replay start date and time" /></div><label hidden>UTC offset<select id="time-offset"></select></label><button type="submit">Create</button></form>`;
    const form = document.querySelector('form')!; const input = form.querySelector<HTMLInputElement>('#time')!;
    input.value = value; input.dataset.zone = zone;
    const offset = form.querySelector<HTMLSelectElement>('#time-offset')!;
    let currentRange = range;
    const controller = mountDateTimePickers(form, { range: () => currentRange }); cleanups.push(controller);
    const trigger = form.querySelector<HTMLButtonElement>('[data-date-time-trigger]')!;
    const popup = form.querySelector<HTMLElement>('.date-time-picker')!;
    const button = (selector: string): HTMLButtonElement => popup.querySelector<HTMLButtonElement>(selector)!;
    const field = (selector: string): HTMLInputElement => popup.querySelector<HTMLInputElement>(selector)!;
    const edit = (selector: string, value: string): void => { const target = field(selector); target.value = value; target.dispatchEvent(new Event('input', { bubbles: true })); };
    const choose = (selector: string, value: string): void => { const target = popup.querySelector<HTMLSelectElement>(selector)!; target.value = value; target.dispatchEvent(new Event('change', { bubbles: true })); };
    const key = (target: Element, key: string, shiftKey = false): KeyboardEvent => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, shiftKey }); target.dispatchEvent(event); return event;
    };
    return { form, input, offset, controller, trigger, popup, button, field, edit, choose, key, range: (range: DateTimePickerRange) => { currentRange = range; } };
}
const april = { start: epoch('2024-04-08T00:00:00Z'), end: epoch('2024-04-10T00:00:00Z') };

describe('staged local date and time picker', () => {
    it('keeps the canonical ID/value/seconds and only commits on Apply, without submitting', () => {
        const f = fixture(); const input = vi.fn(); const change = vi.fn(); const submit = vi.fn(event => event.preventDefault());
        f.input.addEventListener('input', input); f.input.addEventListener('change', change); f.form.addEventListener('submit', submit);
        expect(f.input.hidden && f.input.readOnly).toBe(true); expect(f.input.type).toBe('datetime-local'); expect(f.input.step).toBe('1');
        expect(f.trigger.textContent).toContain('08 April 2024 · 07:24:18');
        f.trigger.click(); f.button('[data-calendar-date="2024-04-09"]').click();
        expect(canonical(f.input)).toBe('2024-04-08T07:24:18'); expect(input).not.toHaveBeenCalled();
        expect(f.field('[data-draft-time]').value).toBe('07:24:18');
        f.button('[data-picker-apply]').click();
        expect(canonical(f.input)).toBe('2024-04-09T07:24:18'); expect(input).toHaveBeenCalledOnce(); expect(change).toHaveBeenCalledOnce();
        expect(submit).not.toHaveBeenCalled(); expect(f.popup.hidden).toBe(true); expect(document.activeElement).toBe(f.trigger);
    });

    it('Cancel and Escape leave the original date and explicit DST choice untouched', () => {
        const f = fixture('2026-11-01T01:15', 'America/New_York');
        f.offset.add(new Option('UTC-05:00', '-300')); f.offset.value = '-300'; f.offset.dataset.preferredOffset = '-300';
        f.trigger.click(); f.edit('[data-draft-time]', '01:25:18'); f.choose('[data-draft-offset]', '-240'); f.button('[data-picker-cancel]').click();
        expect(canonical(f.input)).toBe('2026-11-01T01:15'); expect(f.offset.value).toBe('-300'); expect(f.offset.dataset.preferredOffset).toBe('-300');
        f.trigger.click(); f.edit('[data-draft-date]', '02/11/2026'); const escape = f.key(f.field('[data-draft-date]'), 'Escape');
        expect(escape.defaultPrevented).toBe(true); expect(f.popup.hidden).toBe(true); expect(canonical(f.input)).toBe('2026-11-01T01:15');
        expect(document.activeElement).toBe(f.trigger);
    });

    it.each(['31/04/2024', '29/02/2023', '8/04/2024', '00/04/2024'])(
        'rejects the invalid typed date %s without normalizing it or changing the original', date => {
            const f = fixture(); f.trigger.click(); f.edit('[data-draft-date]', date); f.button('[data-picker-apply]').click();
            expect(f.popup.hidden).toBe(false); expect(f.field('[data-draft-date]').value).toBe(date);
            expect(canonical(f.input)).toBe('2024-04-08T07:24:18'); expect(f.popup.querySelector<HTMLElement>('[role=alert]')!.hidden).toBe(false);
        });

    it.each(['', '7:00', '24:00:00', '12:60:00', '12:00:60'])(
        'rejects an incomplete or invalid 24-hour time %s', time => {
            const f = fixture(); f.trigger.click(); f.edit('[data-draft-time]', time); f.button('[data-picker-apply]').click();
            expect(f.popup.hidden).toBe(false); expect(f.field('[data-draft-time]').value).toBe(time); expect(canonical(f.input)).toBe('2024-04-08T07:24:18');
        });

    it('bounds calendar days and months and enforces an exclusive end at second precision', () => {
        const f = fixture('2024-04-08T07:24:18', 'UTC', april); f.trigger.click();
        expect(f.button('[data-calendar-prev]').disabled).toBe(true); expect(f.button('[data-calendar-next]').disabled).toBe(true);
        expect(f.button('[data-calendar-date="2024-04-07"]').disabled).toBe(true); expect(f.button('[data-calendar-date="2024-04-10"]').disabled).toBe(true);
        f.edit('[data-draft-date]', '10/04/2024'); f.edit('[data-draft-time]', '00:00:00'); f.button('[data-picker-apply]').click();
        expect(f.popup.hidden).toBe(false); expect(f.popup.textContent).toContain('within the available range');
        f.edit('[data-draft-date]', '09/04/2024'); f.edit('[data-draft-time]', '23:59:59'); f.button('[data-picker-apply]').click();
        expect(canonical(f.input)).toBe('2024-04-09T23:59:59');
    });

    it('allows a session end to equal the cached exclusive endpoint', () => {
        const f = fixture('2024-04-08T07:24:18', 'UTC', { ...april, endInclusive: true }); f.trigger.click();
        expect(f.button('[data-calendar-date="2024-04-10"]').disabled).toBe(false);
        f.button('[data-calendar-date="2024-04-10"]').click(); f.edit('[data-draft-time]', '00:00:00'); f.button('[data-picker-apply]').click();
        expect(canonical(f.input)).toBe('2024-04-10T00:00');
    });

    it('navigates months/years within bounds without altering the staged or canonical date', () => {
        const f = fixture('2024-12-15T12:30', 'UTC', { start: epoch('2024-11-01T00:00Z'), end: epoch('2025-02-01T00:00Z') });
        f.trigger.click(); f.button('[data-calendar-next]').click();
        expect(f.field('[aria-label="Calendar year"]').value).toBe('2025');
        expect(f.popup.querySelector<HTMLSelectElement>('[aria-label="Calendar month"]')!.value).toBe('01');
        expect(f.button('[data-calendar-next]').disabled).toBe(true);
        f.field('[aria-label="Calendar year"]').value = '2023'; f.field('[aria-label="Calendar year"]').dispatchEvent(new Event('change', { bubbles: true }));
        expect(f.popup.textContent).toContain('within the available range'); expect(f.field('[aria-label="Calendar year"]').value).toBe('2023');
        expect(f.field('[data-draft-date]').value).toBe('15/12/2024'); expect(canonical(f.input)).toBe('2024-12-15T12:30');
        f.button('[data-calendar-prev]').click(); expect(f.field('[aria-label="Calendar year"]').value).toBe('2024');
    });

    it('requires an explicit fold choice and applies the selected absolute occurrence', () => {
        const f = fixture('2026-11-01T00:15', 'America/New_York', { start: epoch('2026-11-01T04:00Z'), end: epoch('2026-11-01T08:00Z') });
        f.trigger.click(); f.edit('[data-draft-time]', '01:15:18');
        expect(f.popup.querySelector<HTMLSelectElement>('[data-draft-offset]')!.value).toBe('');
        f.button('[data-picker-apply]').click(); expect(f.popup.hidden).toBe(false); expect(f.popup.textContent).toContain('occurs twice');
        f.choose('[data-draft-offset]', '-300'); f.edit('[data-draft-time]', '01:20:18');
        expect(f.popup.querySelector<HTMLSelectElement>('[data-draft-offset]')!.value).toBe('-300'); f.button('[data-picker-apply]').click();
        expect(parseWallTime(canonical(f.input), 'America/New_York', { offsetMinutes: Number(f.offset.value) })).toBe(epoch('2026-11-01T06:20:18Z'));
        expect(f.offset.dataset.preferredOffset).toBe('-300');
    });

    it('rejects spring gaps and keeps their typed draft visible', () => {
        const f = fixture('2026-03-08T01:30', 'America/New_York'); f.trigger.click(); f.edit('[data-draft-time]', '02:30:00');
        f.button('[data-picker-apply]').click(); expect(f.popup.hidden).toBe(false); expect(f.popup.textContent).toContain('does not exist');
        expect(f.field('[data-draft-time]').value).toBe('02:30:00'); expect(canonical(f.input)).toBe('2026-03-08T01:30');
    });

    it('keeps Enter out of form submission, supports calendar arrows, and cycles popup focus', () => {
        const f = fixture(); const submit = vi.fn(event => event.preventDefault()); f.form.addEventListener('submit', submit); f.trigger.click();
        expect(f.key(f.field('[data-draft-time]'), 'Enter').defaultPrevented).toBe(true);
        f.form.requestSubmit(); expect(submit).not.toHaveBeenCalled(); expect(canonical(f.input)).toBe('2024-04-08T07:24:18');
        const apply = f.button('[data-picker-apply]'); apply.focus(); expect(f.key(apply, 'Tab').defaultPrevented).toBe(true);
        const first = document.activeElement!; expect(first).not.toBe(apply); f.key(first, 'Tab', true); expect(document.activeElement).toBe(apply);
        const day = f.button('[data-calendar-date="2024-04-08"]'); day.focus(); f.key(day, 'ArrowRight');
        expect((document.activeElement as HTMLElement).dataset.calendarDate).toBe('2024-04-09');
        expect(canonical(f.input)).toBe('2024-04-08T07:24:18'); (document.activeElement as HTMLButtonElement).click();
        expect(f.field('[data-draft-date]').value).toBe('09/04/2024'); expect(canonical(f.input)).toBe('2024-04-08T07:24:18');
    });

    it('sync discards stale staged changes and refreshes zone/range after dataset changes', () => {
        const f = fixture(); f.trigger.click(); f.edit('[data-draft-time]', '13:00:00');
        f.input.value = '2026-11-01T01:15'; f.input.dataset.zone = 'America/New_York';
        f.range({ start: epoch('2026-11-01T06:15Z'), end: epoch('2026-11-02T00:00Z') }); f.controller.sync();
        expect(f.popup.hidden).toBe(true); expect(f.trigger.textContent).toContain('01 November 2026 · 01:15:00');
        f.trigger.click(); expect(f.popup.textContent).toContain('America/New_York'); expect(f.field('[data-draft-time]').value).toBe('01:15:00');
        expect(f.button('[data-calendar-prev]').disabled).toBe(true);
    });

    it('destroy removes all controls/listeners and detached Apply cannot alter a replacement', () => {
        const f = fixture(); f.trigger.click(); f.edit('[data-draft-time]', '13:00:00'); const apply = f.button('[data-picker-apply]');
        f.controller.destroy(); f.controller.destroy(); f.input.value = '2024-04-09T10:00'; apply.click(); f.trigger.click();
        expect(f.form.querySelector('.date-time-control')).toBeNull(); expect(canonical(f.input)).toBe('2024-04-09T10:00');
        const submitted = vi.fn(event => event.preventDefault()); f.form.addEventListener('submit', submitted); f.form.requestSubmit();
        expect(submitted).toHaveBeenCalledOnce();
    });
});
