import type { VelaWorkspaceOptions } from '../../src/workspace';

export const CHART_TOPBAR = {
    left: ['symbol', 'timeframes', 'style', 'indicators', 'local.templatesShortcut', 'alerts', 'local.replayToggle', 'undo-redo'],
    right: ['layout', 'local.fullscreen', 'screenshot', 'local.tradeShortcut', 'local.sessions', 'panels'],
} satisfies NonNullable<VelaWorkspaceOptions['topbar']>;

/** Position the existing native panel buttons; the shell still owns their lifecycle and actions. */
export function mountChartChrome(root: HTMLElement | undefined): () => void {
    const panels = root?.querySelector<HTMLElement>('.vela-widget-panels');
    if (!root || !panels) return () => {};
    const header = root.querySelector<HTMLElement>('.vela-widget-topbar');
    const footers = [...root.querySelectorAll<HTMLElement>(':scope > .vela-ws-strips, :scope > .vela-widget-bottombar')];
    const attributes = new Map(['role', 'aria-label', 'aria-orientation'].map((name) => [name, panels.getAttribute(name)]));
    const properties = new Map(['--local-chart-rail-top', '--local-chart-rail-bottom'].map((name) => [name,
        { value: root.style.getPropertyValue(name), priority: root.style.getPropertyPriority(name) }]));
    const alreadyMounted = root.classList.contains('local-chart-chrome');
    root.classList.add('local-chart-chrome');
    const win = root.ownerDocument.defaultView;
    let disposed = false;
    const restoreAttributes = (): void => {
        for (const [name, value] of attributes) {
            if (value === null) panels.removeAttribute(name);
            else panels.setAttribute(name, value);
        }
    };
    const sync = (): void => {
        if (disposed) return;
        const desktop = root.dataset.layout !== 'mobile';
        if (desktop) {
            panels.setAttribute('role', 'toolbar');
            panels.setAttribute('aria-label', 'Chart panels');
            panels.setAttribute('aria-orientation', 'vertical');
        } else restoreAttributes();
        root.style.setProperty('--local-chart-rail-top', `${header?.getBoundingClientRect().height || 38}px`);
        root.style.setProperty('--local-chart-rail-bottom', `${footers.reduce((height, footer) => height + footer.getBoundingClientRect().height, 0)}px`);
    };
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
    resize?.observe(root);
    if (header) resize?.observe(header);
    footers.forEach((footer) => resize?.observe(footer));
    const mode = typeof MutationObserver === 'function' ? new MutationObserver(sync) : null;
    mode?.observe(root, { attributes: true, attributeFilter: ['data-layout'] });
    win?.addEventListener('resize', sync);
    sync();
    return () => {
        if (disposed) return;
        disposed = true;
        resize?.disconnect(); mode?.disconnect();
        win?.removeEventListener('resize', sync);
        restoreAttributes();
        for (const [name, { value, priority }] of properties) {
            if (value) root.style.setProperty(name, value, priority);
            else root.style.removeProperty(name);
        }
        if (!alreadyMounted) root.classList.remove('local-chart-chrome');
    };
}
