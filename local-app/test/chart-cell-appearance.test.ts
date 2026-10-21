// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { VelaWorkspace } from '../../src/workspace';
import { CHART_THEME, applyLightPlotAppearance, isDefaultPlotAppearance } from '../client/chart-appearance';
import { queueFreshCellAppearance } from '../client/chart-cell-appearance';

(globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
beforeAll(() => { Element.prototype.animate ??= (() => ({ cancel() {}, finish() {}, addEventListener() {} })) as unknown as Element['animate']; });
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); });

function fixture(style: boolean | Record<string, string> = false): VelaWorkspace {
    const host = document.createElement('div'); document.body.append(host);
    const workspace = new VelaWorkspace(host, { layout: '1', theme: CHART_THEME, sync: { style }, live: false, volume: false, persist: false });
    let current = true;
    const off = workspace.on('cell:created', ({ id }) => queueFreshCellAppearance(workspace, workspace.cell(id)!, () => current));
    disposers.push(() => { current = false; off(); workspace.destroy(); });
    return workspace;
}

describe('fresh cell appearance in the real workspace lifecycle', () => {
    it('gives every new unlinked grid cell the mixed light appearance after layout creation', async () => {
        const workspace = fixture(); applyLightPlotAppearance(workspace.active);
        workspace.setLayout('4'); await Promise.resolve();
        for (const cell of workspace.cells()) expect(cell.chart.renderer.getConfig()).toMatchObject({ layout: { background: '#ffffff', backgroundGradient: { bottomColor: '#d9d9d9' } } });
    });
    it.each([true, { c1: 'shared', c2: 'shared' }])('preserves and inherits the existing customized peer with style link %j', async (style) => {
        const workspace = fixture(style);
        workspace.active.chart.renderer.applyConfig({ layout: { background: '#112233' }, candles: { upColor: '#123456' } });
        const before = workspace.active.chart.renderer.getConfig();
        workspace.setLayout('2h'); await Promise.resolve();
        expect(workspace.cell('c1')!.chart.renderer.getConfig()).toEqual(before);
        expect(workspace.cell('c2')!.chart.renderer.getConfig()).toMatchObject({ layout: { background: '#112233' }, candles: { upColor: '#123456' } });
    });
    it('preserves a deliberately untouched dark linked peer instead of using the new default as a sync origin', async () => {
        const workspace = fixture(true); const before = workspace.active.chart.renderer.getConfig();
        expect(isDefaultPlotAppearance(before)).toBe(true);
        workspace.setLayout('2h'); await Promise.resolve();
        expect(workspace.cell('c1')!.chart.renderer.getConfig()).toEqual(before);
        expect(workspace.cell('c2')!.chart.renderer.getConfig()).toMatchObject({ layout: { background: CHART_THEME.background, backgroundGradient: null } });
    });
    it('ignores queued cells removed by another layout or invalidated by a document/session change', async () => {
        const workspace = fixture(); const cell = workspace.active;
        const before = cell.chart.renderer.getConfig();
        queueFreshCellAppearance(workspace, cell, () => false); await Promise.resolve();
        expect(cell.chart.renderer.getConfig()).toEqual(before);
        workspace.setLayout('2h'); const removed = workspace.cell('c2')!;
        workspace.setLayout('1'); await Promise.resolve();
        expect(workspace.cell(removed.id)).toBeUndefined();
        expect(workspace.cell('c1')!.chart.renderer.getConfig()).toEqual(before);
    });
});
