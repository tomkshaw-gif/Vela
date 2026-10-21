import type { IndicatorModel } from '../../../core/model/indicator';

const EMPTY: ReadonlyMap<number, string> = new Map();
interface Source {
    id: string;
    model: IndicatorModel;
    colors: IndicatorModel['barColors'];
    length: number;
}

/** Resolve indicator precedence once per data change, rather than once per viewport paint. */
export class BarColorCache {
    private indicators: Map<string, IndicatorModel> | null = null;
    private revision = -1;
    private sources: Source[] = [];
    private result = EMPTY;

    get(indicators: Map<string, IndicatorModel>, revision: number): ReadonlyMap<number, string> {
        if (this.indicators === indicators && this.revision === revision && this.sources.length === indicators.size) {
            let index = 0;
            let unchanged = true;
            for (const [id, model] of indicators) {
                const prior = this.sources[index++];
                if (!prior || prior.id !== id || prior.model !== model || prior.colors !== model.barColors
                    || prior.length !== (model.barColors?.length ?? 0)) { unchanged = false; break; }
            }
            if (unchanged) return this.result;
        }
        const sources: Source[] = [];
        let resolved: Map<number, string> | undefined;
        for (const [id, model] of indicators) {
            const colors = model.barColors;
            sources.push({ id, model, colors, length: colors?.length ?? 0 });
            if (!colors?.length) continue;
            resolved ??= new Map();
            // Preserve mount order and the last color at each timestamp, including duplicates.
            for (const color of colors) resolved.set(color.time, color.color);
        }
        this.indicators = indicators; this.revision = revision;
        this.sources = sources; this.result = resolved ?? EMPTY;
        return this.result;
    }

    clear(): void {
        this.indicators = null; this.revision = -1; this.sources = []; this.result = EMPTY;
    }
}
