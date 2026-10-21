import type { VelaTheme } from '../../src/index';
import { getDrawingType, registerIcon } from '../../src/plugin';
import type { ChartCell } from '../../src/workspace';

export const CHART_THEME: VelaTheme = {
    background: '#0f0f0f', textColor: '#dbdbdb', gridColor: '#242424', borderColor: '#2e2e2e',
    upColor: '#089981', downColor: '#f23645',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif',
};

/** Plot cosmetics stay separate from the dark application/menu theme. */
export const LIGHT_PLOT_APPEARANCE = {
    layout: { background: '#ffffff', backgroundGradient: { topColor: '#ffffff', bottomColor: '#d9d9d9' },
        textColor: '#777777', fontFamily: CHART_THEME.fontFamily, fontSize: 12 },
    grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    candles: { upColor: '#292929', downColor: '#292929', bodyVisible: true, hollowUp: true,
        borderVisible: true, borderUpColor: '#292929', borderDownColor: '#292929', wickVisible: true,
        wickUpColor: '#292929', wickDownColor: '#292929' },
    bars: { upColor: '#292929', downColor: '#292929' },
    priceScale: { borderColor: '#b7b7b7', currentPriceLine: false, priceLabel: true, countdown: false },
    crosshair: { color: '#777777', width: 1, opacity: 0.5, labelBackground: '#555555' },
    panes: { separatorColor: '#b7b7b7' },
};

/** An explicit user choice, or the starting point for a cell with no saved layout. */
export function applyLightPlotAppearance(cell: Pick<ChartCell, 'chart' | 'statusPrefs' | 'applyStatusPrefs'>): void {
    cell.chart.renderer.applyConfig(LIGHT_PLOT_APPEARANCE);
    cell.chart.renderer.set('priceStyle', 'candles');
    cell.applyStatusPrefs({ ...cell.statusPrefs(), watermark: false, replayWatermark: false });
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'clipPath']);
const ATTRIBUTES = new Set(['viewBox', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap',
    'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'opacity', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
    'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'points', 'transform', 'clip-rule']);
const PAINT = /^(?:none|currentColor|#[0-9a-f]{3,8})$/i;
const GEOMETRY = /^[\d\s.,+eE-]+$/;
const PATH = /^[MmZzLlHhVvCcSsQqTtAa\d\s.,+eE-]+$/;
const TRANSFORM = /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([\d\s.,+eE-]+\)\s*)+$/;
const STYLE_FIELDS: Record<string, string[]> = {
    candles: ['upColor', 'downColor', 'borderUpColor', 'borderDownColor', 'wickUpColor', 'wickDownColor'],
    bars: ['upColor', 'downColor'], priceScale: ['borderColor'], panes: ['separatorColor'], line: ['color'], area: ['lineColor'],
};

/** Match every cosmetic the initial local preset would replace, not isolated colors. */
export function isDefaultPlotAppearance(config: unknown): boolean {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
    const source = config as Record<string, unknown>;
    const exact = (value: unknown, expected: Record<string, unknown>): boolean => !!value && typeof value === 'object'
        && Object.entries(expected).every(([key, entry]) => (value as Record<string, unknown>)[key] === entry);
    const layout = source.layout as Record<string, unknown> | undefined;
    const grid = source.grid as Record<string, unknown> | undefined;
    const candles = source.candles as Record<string, unknown> | undefined;
    return exact(layout, { background: CHART_THEME.background, textColor: CHART_THEME.textColor,
        fontFamily: CHART_THEME.fontFamily, fontSize: 11 }) && layout?.backgroundGradient == null
        && exact(grid?.vertLines, { color: CHART_THEME.gridColor, visible: true })
        && exact(grid?.horzLines, { color: CHART_THEME.gridColor, visible: true })
        && exact(candles, { upColor: CHART_THEME.upColor, downColor: CHART_THEME.downColor, bodyVisible: true,
            borderVisible: false, borderUpColor: CHART_THEME.upColor, borderDownColor: CHART_THEME.downColor,
            wickVisible: true, wickUpColor: CHART_THEME.upColor, wickDownColor: CHART_THEME.downColor })
        && !candles?.hollowUp
        && exact(source.bars, { upColor: CHART_THEME.upColor, downColor: CHART_THEME.downColor })
        && exact(source.priceScale, { borderColor: CHART_THEME.borderColor, currentPriceLine: true, priceLabel: true, countdown: true })
        && exact(source.crosshair, { color: '#9aa0ad', width: 1, style: 'dashed', opacity: 0.4, labelBackground: '#595959' })
        && exact(source.panes, { separatorColor: CHART_THEME.borderColor });
}

function isPreviousLightAppearance(config: unknown): boolean {
    const expected = { ...LIGHT_PLOT_APPEARANCE, layout: { ...LIGHT_PLOT_APPEARANCE.layout, fontSize: 11 } };
    const matches = (actual: unknown, preset: unknown): boolean => {
        if (!preset || typeof preset !== 'object') return actual === preset;
        if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
        return Object.entries(preset).every(([key, value]) => matches((actual as Record<string, unknown>)[key], value));
    };
    return matches(config, expected);
}

export function needsPlotAppearanceMigration(config: unknown): boolean {
    return isDefaultPlotAppearance(config) || isPreviousLightAppearance(config);
}

/** Rebuild a small static SVG; no imported executable content or resource references survive. */
export function sanitizeDrawingIcon(markup: string): string | null {
    if (!markup || markup.length > 65536 || typeof DOMParser === 'undefined' || /<!DOCTYPE|<!ENTITY/i.test(markup)) return null;
    try {
        const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
        const root = parsed.documentElement;
        if (root.localName !== 'svg' || parsed.querySelector('parsererror') || parsed.doctype || parsed.childElementCount !== 1) return null;
        if (!root.querySelector('path,rect,circle,ellipse,line,polyline,polygon')) return null;
        const output = parsed.implementation.createDocument(SVG_NAMESPACE, 'svg', null);
        let count = 0;
        const copy = (source: Element, target: Element): boolean => {
            if (++count > 256 || !TAGS.has(source.localName) || source.prefix ||
                (source.namespaceURI !== null && source.namespaceURI !== SVG_NAMESPACE) || (source !== root && source.localName === 'svg')) return false;
            for (const attr of Array.from(source.attributes)) {
                if (attr.name === 'xmlns' && source === root && attr.value === SVG_NAMESPACE) continue;
                if (attr.namespaceURI || !ATTRIBUTES.has(attr.name)) return false;
                const value = attr.value.trim();
                const valid = attr.name === 'fill' || attr.name === 'stroke' ? PAINT.test(value)
                    : attr.name === 'd' ? PATH.test(value)
                    : attr.name === 'transform' ? TRANSFORM.test(value)
                    : attr.name === 'fill-rule' || attr.name === 'clip-rule' ? /^(?:nonzero|evenodd)$/.test(value)
                    : attr.name === 'stroke-linecap' ? /^(?:butt|round|square)$/.test(value)
                    : attr.name === 'stroke-linejoin' ? /^(?:miter|round|bevel)$/.test(value)
                    : GEOMETRY.test(value);
                if (!valid) return false;
                if (source !== root || (attr.name !== 'width' && attr.name !== 'height')) target.setAttribute(attr.name, value);
            }
            for (const child of Array.from(source.childNodes)) {
                if (child.nodeType === 3 && !child.textContent?.trim()) continue;
                if (child.nodeType === 8) continue;
                if (child.nodeType !== 1) return false;
                const element = child as Element;
                const clean = output.createElementNS(SVG_NAMESPACE, element.localName);
                if (!copy(element, clean)) return false;
                target.appendChild(clean);
            }
            return true;
        };
        if (!copy(root, output.documentElement)) return null;
        if (!output.documentElement.hasAttribute('viewBox')) {
            const width = Number(root.getAttribute('width'));
            const height = Number(root.getAttribute('height'));
            if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
            output.documentElement.setAttribute('viewBox', `0 0 ${width} ${height}`);
        }
        const viewBox = output.documentElement.getAttribute('viewBox')!.trim().split(/[\s,]+/).map(Number);
        if (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2]! <= 0 || viewBox[3]! <= 0) return null;
        if (!output.documentElement.hasAttribute('fill')) output.documentElement.setAttribute('fill', 'currentColor');
        return new XMLSerializer().serializeToString(output.documentElement);
    } catch { return null; }
}

/** Install validated drawing and utility glyphs through the public registries. */
export function configureChartAppearance(icons: Record<string, string>): number {
    let installed = 0;
    for (const [type, markup] of Object.entries(icons)) {
        const meta = getDrawingType(type);
        const utility = /^icon-([a-z][a-z0-9-]{0,50})$/.exec(type)?.[1];
        if ((!meta && !utility) || typeof markup !== 'string') continue;
        const icon = sanitizeDrawingIcon(markup);
        if (!icon) continue;
        if (utility) registerIcon(utility, icon);
        else if (meta) meta.icon = icon;
        installed++;
    }
    return installed;
}

/** Migrate only unchanged historical defaults in known chart-style fields. */
export function nativeChartConfig(config: unknown): unknown {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
    const source = config as Record<string, unknown>;
    if (isPreviousLightAppearance(config)) return { ...source, layout: { ...source.layout as Record<string, unknown>, fontSize: 12 } };
    if (isDefaultPlotAppearance(config)) {
        const merge = (key: keyof typeof LIGHT_PLOT_APPEARANCE): Record<string, unknown> => ({
            ...source[key] as Record<string, unknown>, ...LIGHT_PLOT_APPEARANCE[key],
        });
        const grid = source.grid as { vertLines: Record<string, unknown>; horzLines: Record<string, unknown> };
        return { ...source, ...Object.fromEntries(Object.keys(LIGHT_PLOT_APPEARANCE).map((key) => [key, merge(key as keyof typeof LIGHT_PLOT_APPEARANCE)])),
            grid: { ...grid, vertLines: { ...grid.vertLines, visible: false }, horzLines: { ...grid.horzLines, visible: false } } };
    }
    const layout = source.layout as Record<string, unknown> | undefined;
    const initial = layout?.background === '#101419' && layout.textColor === '#8795a8';
    const native = layout?.background === '#151619' && layout.textColor === '#b2b5be';
    const previous = layout?.background === '#131722' && layout.textColor === '#d1d4dc';
    if (!initial && !native && !previous) return config;
    const colors: Record<string, string> = initial
        ? { '#101419': CHART_THEME.background, '#8795a8': CHART_THEME.textColor, '#1a222b': CHART_THEME.gridColor,
            '#26313f': CHART_THEME.borderColor, '#50d5ac': CHART_THEME.upColor, '#f17b82': CHART_THEME.downColor,
            'Inter, ui-sans-serif, system-ui, sans-serif': CHART_THEME.fontFamily }
        : native ? { '#151619': CHART_THEME.background, '#b2b5be': CHART_THEME.textColor, '#20222c': CHART_THEME.gridColor,
            '#2a2b30': CHART_THEME.borderColor, 'sans-serif': CHART_THEME.fontFamily }
        : { '#131722': CHART_THEME.background, '#d1d4dc': CHART_THEME.textColor, '#1e222d': CHART_THEME.gridColor,
            '#2a2e39': CHART_THEME.borderColor };
    const rebase = (value: unknown, keys: string[]): unknown => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const next = { ...value as Record<string, unknown> };
        for (const key of keys) if (typeof next[key] === 'string') next[key] = colors[next[key] as string] ?? next[key];
        return next;
    };
    const grid = source.grid && typeof source.grid === 'object' && !Array.isArray(source.grid) ? source.grid as Record<string, unknown> : null;
    return { ...source,
        layout: rebase(layout, ['background', 'textColor', 'fontFamily']),
        ...(grid ? { grid: { ...grid, ...('vertLines' in grid ? { vertLines: rebase(grid.vertLines, ['color']) } : {}),
            ...('horzLines' in grid ? { horzLines: rebase(grid.horzLines, ['color']) } : {}) } } : {}),
        ...Object.fromEntries(Object.entries(STYLE_FIELDS).filter(([key]) => key in source).map(([key, keys]) => [key, rebase(source[key], keys)])),
    };
}
