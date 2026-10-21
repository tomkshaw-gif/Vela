import './event-comparison.css';
import type { EventComparisonContext, EventComparisonRequest, EventComparisonResult } from '../shared/event-comparison';
import { EVENT_COMPARISON_LIMITS, eventComparisonCandidates, eventComparisonRequestKey, pinEventComparison, sameEventComparisonPin } from '../shared/event-comparison';
import type { EventMovement } from '../shared/event-comparison';
import { escapeHtml as e, utc } from './util';

export interface EventComparisonCallbacks {
    compare(input: EventComparisonRequest, signal: AbortSignal): Promise<EventComparisonResult>;
}
export interface EventComparisonView {
    update(context: EventComparisonContext | null): void;
    run(): Promise<void>;
    cancel(): void;
    prepareToLeave(): Promise<void>;
    destroy(): Promise<void>;
}
type Unit = 'points' | 'ticks' | 'percent';
const number = (value: number): string => value.toLocaleString('en-US', { maximumSignificantDigits: 12 });
const movement = (value: EventMovement): string => `${number(value.points)} points · ${value.ticks === null ? 'ticks unavailable' : `${number(value.ticks)} ticks`} · ${value.percent === null ? '% unavailable (nonpositive open)' : `${number(value.percent)}%`}`;

export function mountEventComparison(host: HTMLElement, callbacks: EventComparisonCallbacks): EventComparisonView {
    host.innerHTML = `<section class="event-comparison" aria-label="Historical event-day comparisons"><h2>Historical event-day comparisons</h2>
      <p>Compare up to three complete sessions from this exact query and a supplied local event calendar. These are day-session examples; no release minute is supplied.</p>
      <label>Supplied local event calendar<select data-event-calendar aria-label="Supplied local event calendar"></select></label>
      <p data-event-coverage></p><fieldset data-event-choices><legend>Select up to three matched event-day sessions</legend></fieldset>
      <div class="ec-actions"><button type="button" data-event-compare>Compare selected sessions</button><button type="button" data-event-cancel hidden>Cancel comparison</button>
      <label>Overlay units<select data-event-units aria-label="Overlay units"><option value="percent">Percent from first measured open</option><option value="points">Price points from first measured open</option><option value="ticks">Ticks from first measured open</option></select></label></div>
      <p data-event-status role="status" aria-live="polite"></p><div data-event-result></div></section>`;
    const query = <T extends Element>(selector: string): T => host.querySelector<T>(selector)!;
    const calendarSelect = query<HTMLSelectElement>('[data-event-calendar]'), choices = query<HTMLFieldSetElement>('[data-event-choices]');
    const compareButton = query<HTMLButtonElement>('[data-event-compare]'), cancelButton = query<HTMLButtonElement>('[data-event-cancel]');
    const units = query<HTMLSelectElement>('[data-event-units]'), status = query<HTMLElement>('[data-event-status]'), resultHost = query<HTMLElement>('[data-event-result]');
    let context: EventComparisonContext | null = null, contextKey = '', calendarEvent = '', unit: Unit = 'percent';
    const selected = new Set<string>();
    let last: EventComparisonResult | null = null, lastRequest: EventComparisonRequest | null = null, lastCurrent = false;
    let generation = 0, disposed = false, leaving = false, abort: AbortController | null = null, active: Promise<void> | null = null;
    let drainMessage: string | null = null;
    const currentCalendar = () => context?.calendars.find(item => item.event === calendarEvent);
    const candidates = () => { const calendar = currentCalendar(); return context && calendar ? eventComparisonCandidates(context.result, calendar) : []; };
    const ready = (): boolean => !!context && !!currentCalendar() && !!context.result.coverage.events
        && selected.size > 0 && selected.size <= EVENT_COMPARISON_LIMITS.sessions && [...selected].every(id => candidates().some(row => row.sessionId === id));
    function controls(): void {
        compareButton.disabled = disposed || leaving || !!active || !ready();
        cancelButton.hidden = !active; cancelButton.disabled = !abort || abort.signal.aborted;
        calendarSelect.disabled = disposed || leaving || !context;
        for (const checkbox of choices.querySelectorAll<HTMLInputElement>('[data-event-session]')) checkbox.disabled = disposed || leaving || !checkbox.checked && selected.size >= EVENT_COMPARISON_LIMITS.sessions;
    }
    function renderChoices(): void {
        const available = candidates();
        choices.innerHTML = '<legend>Select up to three matched event-day sessions</legend>' + available.map(row =>
            `<label class="ec-choice"><input type="checkbox" data-event-session value="${e(row.sessionId)}" ${selected.has(row.sessionId) ? 'checked' : ''}><span>${e(row.tradeDate)} · ${e(row.sessionId)}</span></label>`).join('')
            + [...selected].filter(id => !available.some(row => row.sessionId === id)).map(id =>
                `<label class="ec-choice ec-unavailable"><input type="checkbox" data-event-session value="${e(id)}" checked><span>${e(id)} · retained selection, unavailable in the current query/calendar</span></label>`).join('')
            + (available.length ? '' : '<p>No covered event-day sessions are listed in the current query. Run statistics with an explicit event calendar and sufficient session results.</p>');
        controls();
    }
    function renderCalendars(): void {
        const available = context?.calendars ?? [];
        if (!calendarEvent && available.length) calendarEvent = available[0]!.event;
        calendarSelect.innerHTML = available.map(item => `<option value="${e(item.event)}">${e(item.event)} · ${e(item.version)}</option>`).join('')
            + (calendarEvent && !available.some(item => item.event === calendarEvent) ? `<option value="${e(calendarEvent)}">${e(calendarEvent)} · retained draft, unavailable</option>` : '');
        calendarSelect.value = calendarEvent;
        const calendar = currentCalendar();
        query<HTMLElement>('[data-event-coverage]').textContent = calendar
            ? `${calendar.event} · ${calendar.version} · covered trade dates ${calendar.coverage.from} through ${calendar.coverage.to} · day-only calendar. ${calendar.notes ?? ''}`
            : 'An explicit supplied local event calendar and a current statistics result are required.';
        renderChoices();
    }
    function overlay(result: EventComparisonResult): string {
        const labels = { points: 'Price points', ticks: 'Ticks', percent: 'Percent' };
        const paths = result.sessions.map(session => ({ session,
            points: [{ elapsedMinutes: (session.baseline.time - session.startTs) / 60_000,
                value: (unit === 'percent' ? session.baseline.percentAvailable : unit === 'ticks' ? session.tickSize !== null : true) ? 0 : null },
                ...session.path.map(point => ({ elapsedMinutes: point.elapsedMinutes, value: point.change[unit] }))]
                .filter((point): point is { elapsedMinutes: number; value: number } => point.value !== null) }));
        const values = paths.flatMap(path => path.points.map(point => point.value));
        const min = Math.min(0, ...values), max = Math.max(0, ...values), span = max - min || 1;
        const minutes = Math.max(1, ...result.sessions.map(session => (session.endTs - session.startTs) / 60_000));
        const x = (minute: number) => 76 + minute / minutes * 690;
        const y = (value: number) => 205 - (value - min) / span * 165;
        return `<div class="ec-overlay"><svg viewBox="0 0 800 258" role="img" aria-label="${labels[unit]} from each first measured session open, by minutes from the scheduled session open">
          <text x="76" y="18">${labels[unit]} from first measured open</text><text x="12" y="44">${e(number(max))}</text><text x="12" y="209">${e(number(min))}</text>
          <line class="ec-axis" x1="76" y1="${y(0).toFixed(2)}" x2="766" y2="${y(0).toFixed(2)}"/><line class="ec-axis" x1="76" y1="40" x2="76" y2="205"/>
          ${paths.map(({ session, points }, index) => points.length ? `<path class="ec-line ec-series-${index}" fill="none" d="${points.map((point, i) => `${i ? 'L' : 'M'}${x(point.elapsedMinutes).toFixed(2)},${y(point.value).toFixed(2)}`).join(' ')}"><title>${e(session.tradeDate)} · ${e(session.contract?.symbol ?? session.symbol)}</title></path>` : '').join('')}
          <text x="76" y="228">0</text><text x="746" y="228">${e(number(minutes))}</text><text x="240" y="250">Minutes from scheduled session open</text></svg>
          <ul class="ec-legend">${paths.map(({ session, points }, index) => `<li class="ec-series-${index}">${e(session.tradeDate)} · ${e(session.contract?.symbol ?? session.symbol)}${points.length ? '' : ` · ${labels[unit]} unavailable`}</li>`).join('')}</ul></div>`;
    }
    function renderLast(): void {
        if (!last || !lastRequest) return;
        resultHost.innerHTML = `<h3>Last completed comparison${lastCurrent ? ' · current selection' : ' · previous query, source or selection'}</h3>
          <p>${e(last.calendar.event)} · calendar ${e(last.calendar.version)} · ${last.sessions.length} selected day-session example${last.sessions.length === 1 ? '' : 's'}. ${e(last.disclaimer)}</p>
          <p>Source: ${e(last.pin.selection.name)} · ${e(last.pin.selection.symbol)} · ${e(last.pin.selection.sourceMode)} · checksum ${e(last.pin.selection.checksum)}${last.pin.selection.replay ? ` · replay revision ${last.pin.selection.replay.revision} / cursor ${last.pin.selection.replay.cursor}` : ''}</p>
          <p>Pinned range: ${e(utc(last.pin.selection.from))} to ${e(utc(last.pin.selection.until))} (excluded). Query: <code>${e(lastRequest.request.query.dsl)}</code></p>
          ${overlay(last)}<div class="ec-summaries">${last.sessions.map(session => `<article><h4>${e(session.tradeDate)} · ${e(session.contract?.symbol ?? session.symbol)}</h4>
            <p>${session.barCount} measured minute bars · ${e(session.tz)} · ${e(session.sessionKey)}${session.isRollDay ? ' · first session after contract roll; measured contract kept separate' : ''}${session.contract?.instrumentId ? ` · instrument ${e(session.contract.instrumentId)}` : ''}</p>
            <p>Scheduled session: ${e(utc(session.startTs))} to ${e(utc(session.endTs))} (excluded). Measured bars: ${e(utc(session.firstBarOpen))} to ${e(utc(session.lastBarClose))} (closed).</p>
            <p>Baseline: first measured session-bar open ${number(session.baseline.price)} at ${e(utc(session.baseline.time))}. Tick size: ${session.tickSize === null ? 'unavailable' : number(session.tickSize)}.</p>
            <dl><dt>Open / close / high / low · price</dt><dd>${[session.prices.open, session.prices.close, session.prices.high, session.prices.low].map(number).join(' / ')}</dd>
            ${(['range', 'netChange', 'longMae', 'longMfe', 'shortMae', 'shortMfe'] as const).map((key, index) => `<dt>${['Session range', 'Net change', 'Long MAE', 'Long MFE', 'Short MAE', 'Short MFE'][index]}</dt><dd>${movement(session[key])}</dd>`).join('')}</dl></article>`).join('')}</div>
          <p>${e(last.basis)}</p><p>Calendar provenance: ${last.calendar.sources.map(e).join(' · ')} · ${e(last.calendar.fingerprint)}</p>`;
    }
    function invalidate(message: string): void {
        generation++; abort?.abort(); lastCurrent = false;
        if (active) drainMessage = message;
        status.textContent = active ? `${message} Waiting for cancellation to drain; your draft and last result are preserved.` : message;
        renderLast(); controls();
    }
    function validateResult(value: EventComparisonResult, request: EventComparisonRequest, snapshot: EventComparisonContext): void {
        const failure = (): never => { throw new Error('The comparison receipt or matched sessions changed. Run statistics again.'); };
        if (!value || !value.pin || !sameEventComparisonPin(value.pin, request.pin) || !value.calendar || value.calendar.event !== request.calendarEvent
            || value.calendar.timing !== 'day-only' || value.calendar.fingerprint !== snapshot.result.coverage.events?.calendars.find(item => item.event === request.calendarEvent)?.fingerprint
            || !Array.isArray(value.sessions) || value.sessions.length !== request.sessionIds.length || value.sessions.length > EVENT_COMPARISON_LIMITS.sessions
            || new Set(value.sessions.map(session => session.sessionId)).size !== value.sessions.length
            || typeof value.basis !== 'string' || typeof value.disclaimer !== 'string' || !Array.isArray(value.calendar.sources)
            || JSON.stringify(value).length > EVENT_COMPARISON_LIMITS.outputBytes) failure();
        for (const session of value.sessions) {
            const row = snapshot.result.result.sessions.find(item => item.sessionId === session.sessionId);
            if (!request.sessionIds.includes(session.sessionId) || !row || row.tradeDate !== session.tradeDate
                || session.symbol !== snapshot.result.selection.symbol || session.sessionKey !== snapshot.request.session.key
                || !session.baseline || !Number.isFinite(session.baseline.price) || session.baseline.kind !== 'first-session-bar-open'
                || session.startTs < snapshot.result.selection.from || session.endTs > snapshot.result.selection.until || session.endTs <= session.startTs
                || !Number.isSafeInteger(session.barCount) || session.barCount < 1 || session.barCount > EVENT_COMPARISON_LIMITS.barsPerSession
                || !Array.isArray(session.path) || session.path.length !== session.barCount) failure();
            const movements = [session.range, session.netChange, session.longMae, session.longMfe, session.shortMae, session.shortMfe, ...session.path.map(point => point.change)];
            if (movements.some(item => !item || !Number.isFinite(item.points) || item.ticks !== null && !Number.isFinite(item.ticks)
                || item.percent !== null && !Number.isFinite(item.percent) || session.baseline.price <= 0 && item.percent !== null)
                || session.path.some(point => !Number.isFinite(point.elapsedMinutes) || !Number.isSafeInteger(point.time) || point.time <= session.startTs || point.time > session.endTs)) failure();
        }
    }
    function run(): Promise<void> {
        if (active) return Promise.resolve();
        if (disposed || leaving || !ready() || !context) return Promise.resolve();
        const owner = ++generation, snapshot = structuredClone(context);
        const request: EventComparisonRequest = { request: snapshot.request, pin: pinEventComparison(snapshot.request, snapshot.result), calendarEvent, sessionIds: [...selected] };
        const controller = new AbortController(); abort = controller;
        status.textContent = 'Reading selected native session artifacts serially…';
        const work = (async () => {
            try {
                const value = await callbacks.compare(structuredClone(request), controller.signal);
                if (disposed || leaving || controller.signal.aborted || generation !== owner) return;
                validateResult(value, request, snapshot);
                last = structuredClone(value); lastRequest = request; lastCurrent = true; renderLast();
                status.textContent = `Compared ${value.sessions.length} selected day-session examples. No release minute or probability is inferred.`;
            } catch (error) {
                if (!disposed && !leaving && generation === owner && !controller.signal.aborted) {
                    lastCurrent = false; renderLast(); status.textContent = error instanceof Error ? error.message : 'The historical comparison could not complete.';
                }
            } finally { if (abort === controller) abort = null; }
        })();
        active = work;
        void work.then(() => {
            if (active === work) {
                active = null;
                if (!disposed && drainMessage) status.textContent = `${drainMessage} Draft and last result preserved.`;
                drainMessage = null; controls();
            }
        });
        controls(); return work;
    }
    function change(event: Event): void {
        const target = event.target;
        if (disposed || leaving) return;
        if (target === units) { unit = units.value as Unit; renderLast(); return; }
        if (target === calendarSelect) { calendarEvent = calendarSelect.value; invalidate('Calendar draft changed.'); renderCalendars(); return; }
        if (target instanceof HTMLInputElement && target.hasAttribute('data-event-session')) {
            if (!target.checked) selected.delete(target.value);
            else if (selected.size < EVENT_COMPARISON_LIMITS.sessions && candidates().some(row => row.sessionId === target.value)) selected.add(target.value);
            else target.checked = selected.has(target.value);
            invalidate('Session selection changed.'); controls();
        }
    }
    const clickRun = () => { void run(); }, cancel = () => invalidate('Comparison cancelled.');
    host.addEventListener('change', change); compareButton.addEventListener('click', clickRun); cancelButton.addEventListener('click', cancel);
    renderCalendars(); status.textContent = 'Run statistics with an explicit supplied event calendar to select historical sessions.';
    return {
        update(next) {
            if (disposed) return;
            const detached = next ? structuredClone(next) : null;
            const key = detached ? eventComparisonRequestKey({ pin: pinEventComparison(detached.request, detached.result), calendars: detached.calendars } as unknown as EventComparisonContext['request']) : '';
            if (contextKey !== key) invalidate('Query or source changed.');
            contextKey = key; context = detached; leaving = false; renderCalendars();
        }, run, cancel,
        async prepareToLeave() { if (disposed) return; leaving = true; invalidate('Leaving historical comparisons.'); await active; },
        async destroy() {
            if (disposed) { await active; return; } disposed = true; leaving = true; invalidate('Historical comparisons closed.');
            host.removeEventListener('change', change); compareButton.removeEventListener('click', clickRun); cancelButton.removeEventListener('click', cancel);
            await active; host.replaceChildren();
        },
    };
}
