// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountCandleEvidence, type CandleOwnership } from '../client/candle-evidence';
import type { CandleEvidenceSnapshot } from '../shared/candle-evidence';

const NOW = 1_000_000;
function snapshot(time = 0): CandleEvidenceSnapshot {
    const dataset = { id: 'cache', checksum: 'sha', symbol: 'TEST', schema: 'ohlcv-1m' as const, intervalMs: 60_000 };
    const bars = [{ time, open: 10, high: 13, low: 9, close: 12, volume: 0 }];
    const envelope = { dataset, cursorTime: time, sourceCutoff: time, bars };
    return {
        scope: { scopeId: `scope-${time}`, target: { clientId: 'c', sessionId: 's', generation: 1 }, createdAt: NOW - 10, expiresAt: NOW + 100,
            cursorTime: time, region: { from: time, to: time, requestedFrom: time, requestedTo: time, clamped: false, origin: 'range' },
            clock: { sourceCutoff: time, availableUntil: time + 60_000, sourceIntervalMs: 60_000, label: 'Pinned clock' },
            chart: { symbol: 'TEST', timeframe: '1', intervalMs: 60_000 }, dataset },
        selectedTime: time, raw: { ...envelope, from: time, to: time + 60_000 }, displayed: envelope, transform: { kind: 'none' }, assertCurrent: vi.fn(),
    };
}
function harness(options: Parameters<typeof mountCandleEvidence>[1] = {}) {
    const host = document.createElement('div'); document.body.append(host);
    const panel = mountCandleEvidence(host, { now: () => NOW, ...options }); return { host, panel };
}
function pending<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('mounted candle explanation', () => {
    it('shows readable facts, native keyboard controls and expandable exact evidence refs with text-safe values', () => {
        const { host, panel } = harness(); const input = snapshot();
        input.scope.dataset.id = '<img src=x onerror=alert(1)>'; input.raw.dataset = input.scope.dataset; input.displayed.dataset = input.scope.dataset;
        input.transform = { kind: 'other', label: '<svg onload=alert(1)>' };
        panel.update(input);
        expect(host.textContent).toContain('1970-01-01T00:00:00.000Z');
        expect(host.textContent).toContain('Open'); expect(host.textContent).toContain('Volume');
        expect(host.textContent).toContain('Causes unavailable');
        expect(host.querySelector('img, svg, script')).toBeNull();
        const details = host.querySelector('details')!; expect(details.querySelector('summary')!.textContent).toContain('Evidence');
        expect(details.textContent).toContain('checksum'); expect(details.textContent).toContain('raw');
        const ref = host.querySelector<HTMLButtonElement>('[data-evidence-id]')!; ref.focus(); expect(document.activeElement).toBe(ref);
        ref.click(); expect(details.open).toBe(true);
        expect(details.contains(document.activeElement)).toBe(true);
        expect(host.querySelector('button')!.type).toBe('button');
        panel.destroy(); expect(host.childElementCount).toBe(0);
    });
    it('queues only the exact pinned candle/report via the supplied callback and never needs a network or model', async () => {
        const callback = vi.fn(async (_request, ownership: CandleOwnership) => { ownership.assertCurrent(); });
        const { host, panel } = harness({ prepareQuestion: callback }); panel.update(snapshot());
        const button = host.querySelector<HTMLButtonElement>('[data-action="ask-candle"]')!;
        expect(button.disabled).toBe(false); button.focus(); button.click(); await settle();
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0]![0]).toMatchObject({ selectedTime: 0, scope: { scopeId: 'scope-0' }, evidence: { selectedTime: 0 } });
        expect(host.querySelector('[role=status]')!.textContent).toContain('prepared');
        expect(button.disabled).toBe(false); panel.destroy();
    });
    it('does not queue after ownership changes or scope expires', async () => {
        const callback = vi.fn(async () => {}); let now = NOW; let current = true;
        const { host, panel } = harness({ prepareQuestion: callback, now: () => now }); const input = snapshot();
        input.assertCurrent = () => { if (!current) throw new Error('Chart changed'); }; panel.update(input); current = false;
        host.querySelector<HTMLButtonElement>('[data-action="ask-candle"]')!.click(); await settle(); expect(callback).not.toHaveBeenCalled();
        current = true; panel.update(snapshot()); now = NOW + 100;
        host.querySelector<HTMLButtonElement>('[data-action="ask-candle"]')!.click(); await settle(); expect(callback).not.toHaveBeenCalled();
        expect(() => panel.getEvidence()).toThrow(/expired/i); panel.destroy();
    });
    it('ignores stale loader completions and aborts their guards when a newer update wins', async () => {
        const { host, panel } = harness(); const load = pending<CandleEvidenceSnapshot>(); let ownership!: CandleOwnership;
        const task = panel.prepare(context => { ownership = context; return load.promise; });
        panel.update(snapshot(60_000)); expect(ownership.signal.aborted).toBe(true); expect(() => ownership.assertCurrent()).toThrow();
        load.resolve(snapshot()); expect(await task).toBeNull(); expect(panel.getEvidence()!.selectedTime).toBe(60_000);
        expect(host.textContent).toContain('1970-01-01T00:01:00.000Z'); panel.destroy();
    });
    it('handles out-of-order prepare completion, stale errors and destroy without repopulating the host', async () => {
        const { host, panel } = harness(); const old = pending<CandleEvidenceSnapshot>(); const next = pending<CandleEvidenceSnapshot>();
        const first = panel.prepare(() => old.promise); const second = panel.prepare(() => next.promise);
        next.resolve(snapshot(60_000)); expect((await second)!.selectedTime).toBe(60_000);
        old.reject(new Error('old error')); expect(await first).toBeNull(); expect(host.textContent).not.toContain('old error');
        const late = pending<CandleEvidenceSnapshot>(); const closing = panel.prepare(() => late.promise); panel.destroy();
        late.resolve(snapshot()); expect(await closing).toBeNull(); expect(host.childElementCount).toBe(0);
        expect(() => panel.update(snapshot())).toThrow(/destroy/i); expect(panel.getEvidence()).toBeNull();
    });
    it('cancels question ownership and ignores old success/error when selection changes or panel is destroyed', async () => {
        const ask = pending<unknown>(); let ownership!: CandleOwnership;
        const { host, panel } = harness({ prepareQuestion: async (_request, context) => { ownership = context; return ask.promise; } });
        panel.update(snapshot()); host.querySelector<HTMLButtonElement>('[data-action="ask-candle"]')!.click();
        panel.update(snapshot(60_000)); expect(ownership.signal.aborted).toBe(true); expect(() => ownership.assertCurrent()).toThrow();
        ask.reject(new Error('old question')); await settle(); expect(host.textContent).not.toContain('old question');
        const stale = host.querySelector<HTMLButtonElement>('[data-action="ask-candle"]')!; panel.destroy(); stale.click(); await settle();
        expect(host.childElementCount).toBe(0);
    });
    it('removes invalid reports, reports loader errors safely and disables unbound handoff', async () => {
        const { host, panel } = harness(); panel.update(snapshot());
        expect(host.querySelector<HTMLButtonElement>('[data-action="ask-candle"]')!.disabled).toBe(true);
        const bad = snapshot(); bad.scope.expiresAt = NOW;
        expect(() => panel.update(bad)).toThrow(); expect(host.textContent).not.toContain('Open');
        await expect(panel.prepare(async () => { throw new Error('<img src=x>'); })).rejects.toThrow('<img src=x>');
        expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toContain('<img src=x>');
        panel.update(null); expect(host.textContent).toContain('Select a candle'); panel.destroy();
    });
    it('lets the queue callback reject a stale async commit after a selection switch or destroy', async () => {
        let gate = pending<void>(); const committed: number[] = [];
        const callback = vi.fn(async (request, ownership: CandleOwnership) => { await gate.promise; ownership.assertCurrent(); committed.push(request.selectedTime); });
        const { host, panel } = harness({ prepareQuestion: callback }); panel.update(snapshot());
        host.querySelector<HTMLButtonElement>('[data-action="ask-candle"]')!.click(); panel.update(snapshot(60_000));
        gate.resolve(); await settle(); expect(committed).toEqual([]);
        expect(host.textContent).toContain('1970-01-01T00:01:00.000Z'); expect(host.textContent).not.toContain('no longer owns');
        gate = pending<void>(); host.querySelector<HTMLButtonElement>('[data-action="ask-candle"]')!.click(); panel.destroy();
        gate.resolve(); await settle(); expect(committed).toEqual([]); expect(host.childElementCount).toBe(0);
    });
    it('detaches input aliases and returned reports from the retained pin and prevents duplicate asks', async () => {
        const done = pending<unknown>(); const callback = vi.fn(async () => done.promise);
        const { host, panel } = harness({ prepareQuestion: callback }); const input = snapshot(); const report = panel.update(input)!;
        input.selectedTime = 60_000; input.scope.scopeId = 'changed'; input.displayed.bars = [];
        report.scope.scopeId = 'mutated-report'; report.raw.close = 100;
        expect(panel.getEvidence()).toMatchObject({ scope: { scopeId: 'scope-0' }, selectedTime: 0, raw: { close: 12 } });
        const ask = host.querySelector<HTMLButtonElement>('[data-action="ask-candle"]')!; ask.click(); ask.click();
        expect(callback).toHaveBeenCalledTimes(1); done.resolve({}); await settle(); expect(ask.disabled).toBe(false); panel.destroy();
    });
});
