import type { ChartCell, VelaWorkspace } from '../../src/workspace';
import { applyLightPlotAppearance, isDefaultPlotAppearance } from './chart-appearance';

/** Wait for the workspace to inherit linked peer styles before deciding on a new default. */
export function queueFreshCellAppearance(workspace: Pick<VelaWorkspace, 'cell' | 'cells' | 'sync'>, cell: ChartCell,
    isCurrent: () => boolean): void {
    const chart = cell.chart;
    queueMicrotask(() => {
        if (!isCurrent() || workspace.cell(cell.id)?.chart !== chart) return;
        const link = workspace.sync.get('style');
        const group = link && typeof link === 'object' ? link[cell.id] : undefined;
        const hasLinkedPeer = workspace.cells().some((peer) => peer.id !== cell.id &&
            (link === true || !!group && typeof link === 'object' && link[peer.id] === group));
        if (!hasLinkedPeer && isDefaultPlotAppearance(chart.renderer.getConfig())) applyLightPlotAppearance(cell);
    });
}
