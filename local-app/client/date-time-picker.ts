import { parseWallTime, wallTimeInput, wallTimeOccurrences } from './replay-time';
import { escapeHtml as esc } from './util';

export interface DateTimePickerRange { start: number; end: number; endInclusive?: boolean }
export interface DateTimePickerOptions { range?: (input: HTMLInputElement) => DateTimePickerRange | undefined }
export interface DateTimePickers { sync(): void; destroy(): void }

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (value: number): string => String(value).padStart(2, '0');
const dayMs = 86400000;
const calendarIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M7 2v6m10-6v6M4 11h16"/></svg>';

function dateEpoch(date: string): number {
    const [year, month, day] = date.split('-').map(Number);
    const result = new Date(0); result.setUTCFullYear(year!, month! - 1, day!); result.setUTCHours(0, 0, 0, 0);
    return result.getTime();
}
function dateString(time: number): string {
    const date = new Date(time);
    return `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function displayDate(date: string): string {
    const [year, month, day] = date.split('-');
    return `${day} ${months[Number(month) - 1]} ${year}`;
}
function displayValue(value: string): string {
    value = value.replace(/\.0+$/, '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return value || 'Choose date & time';
    return `${displayDate(value.slice(0, 10))} · ${value.slice(11).padEnd(8, ':00')}`;
}
function draftValue(date: string, time: string): string {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date.trim());
    if (!match) throw new RangeError('Enter the date as DD/MM/YYYY.');
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(time.trim())) throw new RangeError('Enter a 24-hour time as HH:mm:ss.');
    return `${match[3]}-${match[2]}-${match[1]}T${time.trim()}`;
}

/** Canonical inputs keep their ISO local values; only Apply dispatches their normal input/change events. */
export function mountDateTimePickers(form: HTMLFormElement, options: DateTimePickerOptions = {}): DateTimePickers {
    let destroyed = false;
    let active: { root: HTMLElement; close(focus?: boolean): void } | undefined;
    const cleanups: (() => void)[] = [];
    const records: { input: HTMLInputElement; sync(): void }[] = [];
    const listen = (element: EventTarget, name: string, listener: EventListener): void => {
        element.addEventListener(name, listener); cleanups.push(() => element.removeEventListener(name, listener));
    };
    const connected = (): boolean => !destroyed && form.isConnected;

    for (const input of form.querySelectorAll<HTMLInputElement>('input[data-date-time-picker]')) {
        const original = { hidden: input.hidden, readOnly: input.readOnly };
        // Read-only also removes invisible native constraint-validation/focus UI. The form parser remains authoritative.
        input.hidden = true; input.readOnly = true;
        const label = input.getAttribute('aria-label') ?? input.parentElement?.querySelector('span')?.textContent ?? 'Date and time';
        const root = document.createElement('div'); root.className = 'date-time-control';
        const popupId = `${input.id}-picker`;
        root.innerHTML = `<button type="button" class="date-time-trigger" data-date-time-trigger="${esc(input.id)}" aria-haspopup="dialog" aria-expanded="false" aria-controls="${esc(popupId)}"><span></span>${calendarIcon}</button><div id="${esc(popupId)}" class="date-time-picker" role="dialog" aria-label="${esc(label)}" hidden></div>`;
        input.after(root);
        const trigger = root.querySelector<HTMLButtonElement>('button')!;
        const popup = root.querySelector<HTMLElement>('.date-time-picker')!;
        const offset = form.querySelector<HTMLSelectElement>(`#${input.id}-offset`);
        const sync = (): void => {
            trigger.querySelector('span')!.textContent = displayValue(input.value);
            trigger.setAttribute('aria-label', `${label}: ${displayValue(input.value)}. Open calendar and time picker`);
            trigger.disabled = input.disabled;
        };
        const close = (focus = true): void => {
            popup.hidden = true; popup.replaceChildren(); trigger.setAttribute('aria-expanded', 'false');
            if (active?.root === root) active = undefined;
            if (focus && connected() && trigger.isConnected) trigger.focus();
        };

        const open = (): void => {
            if (!connected() || trigger.disabled) return;
            if (!popup.hidden) { close(); return; }
            active?.close(false);
            const zone = input.dataset.zone ?? 'UTC';
            const range = options.range?.(input);
            const firstDate = range ? wallTimeInput(range.start, zone).slice(0, 10) : '0001-01-01';
            const lastDate = range ? wallTimeInput(range.end - (range.endInclusive ? 0 : 1), zone).slice(0, 10) : '9999-12-31';
            const emptyRange = !!range && (range.start > range.end || range.start === range.end && !range.endInclusive);
            const initialDate = /^\d{4}-\d{2}-\d{2}T/.test(input.value) ? input.value.slice(0, 10) : firstDate;
            const calendarDate = initialDate < firstDate ? firstDate : initialDate > lastDate ? lastDate : initialDate;
            let viewedMonth = calendarDate.slice(0, 7);
            let focusDate = calendarDate;
            let preferredOffset = offset?.dataset.preferredOffset ?? '';
            let currentOffset = offset?.value ?? '';
            const draftForm = `${popupId}-draft`;
            popup.innerHTML = `<div class="date-time-picker-heading"><strong>Choose date & time</strong><span>${esc(zone)} · 24-hour</span></div><div class="date-time-navigation"><button type="button" data-calendar-prev aria-label="Previous month">‹</button><select aria-label="Calendar month" form="${esc(draftForm)}">${months.map((month, index) => `<option value="${pad(index + 1)}">${month}</option>`).join('')}</select><input type="number" aria-label="Calendar year" form="${esc(draftForm)}" min="${Number(firstDate.slice(0, 4))}" max="${Number(lastDate.slice(0, 4))}" step="1" /><button type="button" data-calendar-next aria-label="Next month">›</button></div><div class="date-time-weekdays" aria-hidden="true">${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(day => `<span>${day}</span>`).join('')}</div><div class="date-time-calendar" role="group" aria-label="Calendar days"></div><div class="date-time-editors"><label>Date · DD/MM/YYYY<input data-draft-date type="text" inputmode="numeric" autocomplete="off" spellcheck="false" form="${esc(draftForm)}" /></label><label>Time · HH:mm:ss<input data-draft-time type="text" inputmode="numeric" autocomplete="off" spellcheck="false" form="${esc(draftForm)}" /></label></div><label class="date-time-occurrence" hidden>Repeated time · UTC offset<select data-draft-offset form="${esc(draftForm)}"></select></label><p class="date-time-available"></p><p class="date-time-error" role="alert" hidden></p><div class="date-time-picker-actions"><button type="button" data-picker-cancel>Cancel</button><button type="button" class="date-time-apply" data-picker-apply>Apply</button></div>`;
            const date = popup.querySelector<HTMLInputElement>('[data-draft-date]')!;
            const time = popup.querySelector<HTMLInputElement>('[data-draft-time]')!;
            const occurrence = popup.querySelector<HTMLSelectElement>('[data-draft-offset]')!;
            const month = popup.querySelector<HTMLSelectElement>('[aria-label="Calendar month"]')!;
            const year = popup.querySelector<HTMLInputElement>('[aria-label="Calendar year"]')!;
            const calendar = popup.querySelector<HTMLElement>('.date-time-calendar')!;
            const error = popup.querySelector<HTMLElement>('.date-time-error')!;
            const previous = popup.querySelector<HTMLButtonElement>('[data-calendar-prev]')!;
            const next = popup.querySelector<HTMLButtonElement>('[data-calendar-next]')!;
            const apply = popup.querySelector<HTMLButtonElement>('[data-picker-apply]')!;
            const [initialYear, initialMonth, initialDay] = initialDate.split('-');
            date.value = input.value ? `${initialDay}/${initialMonth}/${initialYear}` : '';
            time.value = input.value ? input.value.replace(/\.0+$/, '').slice(11).padEnd(8, ':00') : '';
            popup.querySelector('.date-time-available')!.textContent = emptyRange ? 'No later time is available in this range.' : range
                ? `Available: ${displayValue(wallTimeInput(range.start, zone))} to ${displayValue(wallTimeInput(range.end, zone))}${range.endInclusive ? ' (latest allowed)' : ' (end excluded)'}.`
                : 'Choose a calendar date and a 24-hour time.';
            const showError = (reason?: unknown): void => {
                error.hidden = !reason; error.textContent = reason instanceof Error ? reason.message : reason ? String(reason) : '';
            };
            const inCalendarRange = (candidate: string): boolean => !emptyRange && candidate >= firstDate && candidate <= lastDate;
            const drawCalendar = (): void => {
                month.value = viewedMonth.slice(5); year.value = String(Number(viewedMonth.slice(0, 4)));
                for (const option of month.options) {
                    const candidate = `${viewedMonth.slice(0, 4)}-${option.value}`;
                    option.disabled = emptyRange || candidate < firstDate.slice(0, 7) || candidate > lastDate.slice(0, 7);
                }
                previous.disabled = emptyRange || viewedMonth <= firstDate.slice(0, 7);
                next.disabled = emptyRange || viewedMonth >= lastDate.slice(0, 7);
                let selected = ''; try { selected = draftValue(date.value, time.value).slice(0, 10); } catch { /* Keep invalid text intact. */ }
                const first = dateEpoch(`${viewedMonth}-01`);
                const leading = (new Date(first).getUTCDay() + 6) % 7;
                const buttons: string[] = Array.from({ length: leading }, () => '<span></span>');
                for (let day = 1; day <= 31; day++) {
                    const candidate = dateString(first + (day - 1) * dayMs); if (!candidate.startsWith(viewedMonth)) break;
                    buttons.push(`<button type="button" data-calendar-date="${candidate}" aria-label="${displayDate(candidate)}" aria-pressed="${candidate === selected}" tabindex="${candidate === focusDate ? '0' : '-1'}"${inCalendarRange(candidate) ? '' : ' disabled'}>${day}</button>`);
                }
                calendar.innerHTML = buttons.join('');
            };
            const updateOccurrences = (preserveCurrent = false): void => {
                try {
                    const value = draftValue(date.value, time.value);
                    const matches = wallTimeOccurrences(value, zone);
                    occurrence.closest<HTMLElement>('label')!.hidden = matches.length <= 1;
                    occurrence.replaceChildren(new Option('Choose UTC offset', ''), ...matches.map(item => new Option(item.label, String(item.offsetMinutes))));
                    occurrence.value = matches.length === 1 ? String(matches[0]!.offsetMinutes) : preserveCurrent ? currentOffset : preferredOffset;
                    currentOffset = occurrence.value;
                    if (!matches.length) parseWallTime(value, zone);
                    showError();
                } catch (reason) { occurrence.closest<HTMLElement>('label')!.hidden = true; occurrence.replaceChildren(); showError(reason); }
            };
            const chooseDate = (candidate: string): void => {
                const [y, m, d] = candidate.split('-'); date.value = `${d}/${m}/${y}`;
                focusDate = candidate; viewedMonth = candidate.slice(0, 7); drawCalendar(); updateOccurrences();
                calendar.querySelector<HTMLButtonElement>(`[data-calendar-date="${candidate}"]`)?.focus();
            };
            const navigate = (candidate: string): void => {
                if (emptyRange || candidate < firstDate.slice(0, 7) || candidate > lastDate.slice(0, 7)) {
                    showError('Choose a calendar month and year within the available range.'); return;
                }
                viewedMonth = candidate; focusDate = candidate === firstDate.slice(0, 7) ? firstDate : `${candidate}-01`;
                drawCalendar(); showError();
            };
            const applyDraft = (): void => {
                if (!connected() || !root.isConnected || active?.root !== root) return;
                try {
                    const value = draftValue(date.value, time.value);
                    const selected = occurrence.value === '' ? undefined : Number(occurrence.value);
                    const instant = parseWallTime(value, zone, selected === undefined ? {} : { offsetMinutes: selected });
                    const latest = options.range?.(input);
                    if (latest && (instant < latest.start || instant > latest.end || instant === latest.end && !latest.endInclusive)) {
                        throw new RangeError('Choose a time within the available range.');
                    }
                    input.value = value;
                    if (offset) {
                        const matches = wallTimeOccurrences(value, zone);
                        offset.replaceChildren(new Option('Choose UTC offset', ''), ...matches.map(item => new Option(item.label, String(item.offsetMinutes))));
                        offset.value = currentOffset;
                        if (preferredOffset) offset.dataset.preferredOffset = preferredOffset; else delete offset.dataset.preferredOffset;
                    }
                    close(); sync();
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                } catch (reason) { showError(reason); }
            };
            // Popup listeners belong to these short-lived nodes and disappear when the popup closes.
            previous.onclick = () => navigate(dateString(dateEpoch(`${viewedMonth}-01`) - dayMs).slice(0, 7));
            next.onclick = () => navigate(dateString(dateEpoch(`${viewedMonth}-01`) + 32 * dayMs).slice(0, 7));
            month.onchange = () => navigate(`${viewedMonth.slice(0, 4)}-${month.value}`);
            year.onchange = () => {
                if (!/^\d{1,4}$/.test(year.value) || Number(year.value) < 1) { showError('Choose a valid calendar year.'); return; }
                navigate(`${year.value.padStart(4, '0')}-${viewedMonth.slice(5)}`);
            };
            date.oninput = time.oninput = () => { updateOccurrences(); drawCalendar(); };
            occurrence.onchange = () => { preferredOffset = occurrence.value; currentOffset = occurrence.value; showError(); };
            calendar.onclick = event => {
                const button = (event.target as Element).closest<HTMLButtonElement>('[data-calendar-date]');
                if (button && !button.disabled) chooseDate(button.dataset.calendarDate!);
            };
            calendar.onkeydown = event => {
                const button = (event.target as Element).closest<HTMLButtonElement>('[data-calendar-date]'); if (!button) return;
                const current = button.dataset.calendarDate!; let candidate: string | undefined;
                const shifts: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
                if (event.key in shifts) candidate = dateString(dateEpoch(current) + shifts[event.key]! * dayMs);
                if (event.key === 'Home' || event.key === 'End') {
                    const weekday = (new Date(dateEpoch(current)).getUTCDay() + 6) % 7;
                    candidate = dateString(dateEpoch(current) + (event.key === 'Home' ? -weekday : 6 - weekday) * dayMs);
                    if (candidate < firstDate) candidate = firstDate; if (candidate > lastDate) candidate = lastDate;
                }
                if (event.key === 'PageUp' || event.key === 'PageDown') {
                    const target = new Date(dateEpoch(current)); const day = target.getUTCDate(); target.setUTCDate(1);
                    target.setUTCMonth(target.getUTCMonth() + (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1));
                    const monthStart = target.getTime(); target.setUTCMonth(target.getUTCMonth() + 1);
                    candidate = dateString(Math.min(monthStart + (day - 1) * dayMs, target.getTime() - dayMs));
                }
                if (!candidate) return;
                event.preventDefault(); event.stopPropagation();
                if (!inCalendarRange(candidate)) return;
                focusDate = candidate; viewedMonth = candidate.slice(0, 7); drawCalendar();
                calendar.querySelector<HTMLButtonElement>(`[data-calendar-date="${candidate}"]`)?.focus();
            };
            popup.querySelector<HTMLButtonElement>('[data-picker-cancel]')!.onclick = () => close();
            apply.onclick = applyDraft; apply.disabled = emptyRange;
            active = { root, close }; popup.hidden = false; trigger.setAttribute('aria-expanded', 'true');
            drawCalendar(); updateOccurrences(true); date.focus(); date.select();
            popup.scrollIntoView?.({ block: 'nearest' });
        };
        listen(trigger, 'click', open);
        listen(root, 'keydown', event => {
            const key = event as KeyboardEvent;
            if (key.key === 'Escape' && !popup.hidden) { key.preventDefault(); key.stopPropagation(); close(); }
            if (popup.hidden) return;
            if (key.key === 'Enter' && key.target instanceof HTMLInputElement) key.preventDefault();
            if (key.key === 'Tab') {
                const fields = [...popup.querySelectorAll<HTMLElement>('*')]
                    .filter(field => field.matches('button,input,select') && !field.matches(':disabled') && !field.closest('[hidden]') && field.tabIndex >= 0);
                const index = fields.indexOf(document.activeElement as HTMLElement);
                if (key.shiftKey && index <= 0 || !key.shiftKey && index === fields.length - 1) {
                    key.preventDefault(); (key.shiftKey ? fields.at(-1) : fields[0])?.focus();
                }
            }
        });
        listen(input, 'input', () => { if (active?.root === root) close(); sync(); });
        listen(input, 'change', sync);
        records.push({ input, sync }); sync();
        cleanups.push(() => { close(false); root.remove(); input.hidden = original.hidden; input.readOnly = original.readOnly; });
    }
    listen(document, 'pointerdown', event => { if (active && !active.root.contains(event.target as Node)) active.close(false); });
    listen(form, 'submit', event => {
        if (active) { event.preventDefault(); event.stopImmediatePropagation(); active.root.querySelector<HTMLElement>('[data-picker-apply]')?.focus(); }
    });
    const controller: DateTimePickers = {
        sync: () => { if (!connected()) return; active?.close(); records.forEach(record => record.sync()); },
        destroy: () => { if (destroyed) return; destroyed = true; active?.close(false); cleanups.splice(0).forEach(cleanup => cleanup()); },
    };
    return controller;
}
