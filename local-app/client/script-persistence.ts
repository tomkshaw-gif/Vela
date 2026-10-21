import type { Vela, InputValue } from '../../src/index';
import { registerStatePersistence, type CellStateContext, type ExternalIndicatorEntry } from '../../src/plugin';

const transientScripts = new WeakMap<Vela, Set<string>>();
export function markTransientScript(chart: Vela, id: string, pending: boolean): void {
    let ids = transientScripts.get(chart);
    if (pending) { if (!ids) transientScripts.set(chart, ids = new Set()); ids.add(id); }
    else ids?.delete(id);
}

export function chartScripts(chart: Vela): ExternalIndicatorEntry[] {
    return chart.indicators().filter((handle) => handle.source !== undefined && !transientScripts.get(chart)?.has(handle.id)).map((handle) => ({
        id: handle.id, name: handle.title, script: handle.source!, language: 'pine',
        inputs: handle.inputValues(), props: handle.propValues(), hidden: !handle.visible,
    }));
}

function values(input: unknown): Record<string, InputValue> | undefined {
    if (input === undefined) return undefined;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 256) throw new Error('Invalid saved script settings.');
    for (const [key, value] of Object.entries(input)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype' || key.length > 200
            || !['number', 'string', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)
            || typeof value === 'string' && value.length > 10000) throw new Error('Invalid saved script setting.');
    }
    return input as Record<string, InputValue>;
}

export function validatedScripts(payload: unknown): ExternalIndicatorEntry[] {
    if (!Array.isArray(payload) || payload.length > 64) throw new Error('Invalid saved Pine scripts.');
    const ids = new Set<string>();
    return payload.map((item: unknown) => {
        if (!item || typeof item !== 'object') throw new Error('Invalid saved script.');
        const entry = item as Record<string, unknown>;
        if (typeof entry.id !== 'string' || !/^[\w.-]{1,128}$/.test(entry.id) || ids.has(entry.id)
            || typeof entry.name !== 'string' || entry.name.length > 200
            || typeof entry.script !== 'string' || !entry.script.length || entry.script.length > 1_000_000
            || entry.language !== 'pine' || typeof entry.hidden !== 'boolean') throw new Error('Invalid saved script.');
        ids.add(entry.id);
        return { id: entry.id, name: entry.name, script: entry.script, language: 'pine', hidden: entry.hidden,
            inputs: values(entry.inputs), props: values(entry.props) };
    });
}

export function enableScriptPersistence(ensureEngine: (chart: Vela) => void): () => void {
    return registerStatePersistence({ key: 'local.pine', scope: 'cell',
        serialize: ({ chart }) => chartScripts(chart),
        restore: (payload: unknown, ctx: CellStateContext) => {
            const entries = validatedScripts(payload);
            ensureEngine(ctx.chart);
            for (const entry of entries) if (!ctx.chart.indicators().some((handle) => handle.id === entry.id)) ctx.addIndicator(entry);
        },
    });
}
