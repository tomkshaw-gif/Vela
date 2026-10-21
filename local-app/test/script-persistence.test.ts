import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndicatorHandle, Vela } from '../../src/index';
import type { CellStateContext, ExternalIndicatorEntry } from '../../src/plugin';

const registered = vi.hoisted(() => ({ handler: undefined as { key: string; scope: string; serialize: (ctx: { chart: Vela }) => unknown; restore: (payload: unknown, ctx: CellStateContext) => void } | undefined, off: vi.fn() }));
vi.mock('../../src/plugin', () => ({ registerStatePersistence: (handler: typeof registered.handler) => { registered.handler = handler; return registered.off; } }));
import { chartScripts, enableScriptPersistence, markTransientScript, validatedScripts } from '../client/script-persistence';

function handle(id: string, source?: string): IndicatorHandle {
    return { id, title: id, source, nativeType: source ? undefined : 'rsi', visible: false,
        inputValues: () => ({ length: 14, color: '#fff' }), propValues: () => ({ initial_capital: 50000 }),
        privateAccount: 'excluded', context: () => { throw new Error('Persistence must not read execution state'); } } as unknown as IndicatorHandle;
}
const entry: ExternalIndicatorEntry = { id: 'pine-1', name: 'Pine study', language: 'pine', script: 'indicator("Example")', inputs: { period: 14 }, props: { initial_capital: 50000 }, hidden: true };
beforeEach(() => { registered.handler = undefined; vi.clearAllMocks(); });

describe('Pine chart persistence', () => {
    it('excludes a pending AI script only from its owning chart until the transient marker clears', () => {
        const chart = { indicators: () => [handle('native'), handle('saved', 'indicator("Saved")'), handle('pending', 'indicator("Pending")')] } as unknown as Vela;
        const otherChart = { indicators: () => [handle('pending', 'indicator("Other chart")')] } as unknown as Vela;
        enableScriptPersistence(vi.fn()); markTransientScript(chart, 'pending', true);
        const pending = registered.handler!.serialize({ chart }) as ExternalIndicatorEntry[];
        expect(pending.map((item) => item.id)).toEqual(['saved']); expect(chartScripts(otherChart).map((item) => item.id)).toEqual(['pending']);
        markTransientScript(chart, 'pending', false);
        const completed = registered.handler!.serialize({ chart }) as ExternalIndicatorEntry[];
        expect(completed.map((item) => item.id)).toEqual(['saved', 'pending']);
        expect(validatedScripts(JSON.parse(JSON.stringify(completed)))).toEqual(completed);
    });
    it('captures source, inputs, properties and visibility while excluding native studies and private runtime fields', () => {
        const chart = { indicators: () => [handle('native'), handle('pine', 'strategy("Example")')] } as unknown as Vela;
        const entries = chartScripts(chart);
        expect(entries).toEqual([{ id: 'pine', name: 'pine', language: 'pine', script: 'strategy("Example")', inputs: { length: 14, color: '#fff' }, props: { initial_capital: 50000 }, hidden: true }]);
        expect(JSON.stringify(entries)).not.toContain('excluded'); expect(validatedScripts(JSON.parse(JSON.stringify(entries)))).toEqual(entries);
    });
    it('rejects duplicated identities, invalid sources and executable or nonfinite settings', () => {
        expect(() => validatedScripts([entry, entry])).toThrow('Invalid saved script');
        expect(() => validatedScripts([{ ...entry, script: '' }])).toThrow('Invalid saved script');
        expect(() => validatedScripts([{ ...entry, language: 'javascript' }])).toThrow('Invalid saved script');
        expect(() => validatedScripts([{ ...entry, inputs: { length: Infinity } }])).toThrow('Invalid saved script setting');
        expect(() => validatedScripts([{ ...entry, inputs: { callback: () => {} } }])).toThrow('Invalid saved script setting');
        expect(() => validatedScripts([{ ...entry, inputs: JSON.parse('{"__proto__":"bad"}') }])).toThrow('Invalid saved script setting');
    });
    it('restores missing scripts through the public cell persistence seam and avoids duplicate live instances', () => {
        const ensure = vi.fn(), dispose = enableScriptPersistence(ensure);
        expect(registered.handler).toMatchObject({ key: 'local.pine', scope: 'cell' });
        const chart = { indicators: () => [handle('already', 'indicator("Existing")')] } as unknown as Vela;
        const addIndicator = vi.fn();
        registered.handler!.restore([{ ...entry, id: 'already' }, entry], { chart, addIndicator } as unknown as CellStateContext);
        expect(ensure).toHaveBeenCalledWith(chart); expect(addIndicator).toHaveBeenCalledOnce(); expect(addIndicator).toHaveBeenCalledWith(entry);
        dispose(); expect(registered.off).toHaveBeenCalledOnce();
    });
    it('rejects the whole invalid document before installing an engine or restoring any script', () => {
        const ensure = vi.fn(), addIndicator = vi.fn(); enableScriptPersistence(ensure);
        expect(() => registered.handler!.restore([entry, { ...entry, id: 'invalid', hidden: 'yes' }], { chart: {}, addIndicator } as unknown as CellStateContext)).toThrow('Invalid saved script');
        expect(ensure).not.toHaveBeenCalled(); expect(addIndicator).not.toHaveBeenCalled();
    });
});
