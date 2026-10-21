const PANEL_CLASS = 'vela-widget-panel-';
const PANEL_RANK: Record<string, number> = {
    'local.watchlist': 0, objects: 10, dataWindow: 11,
    'local.templates': 100, 'local.assistant': 110, 'local.trade': 120,
    'local.pine': 190, 'local.strategy': 200,
};

/** Arrange the real chart controls without replacing their native event handlers. */
export function mountReferenceChrome(root: HTMLElement | undefined): () => void {
    const rail = root?.querySelector<HTMLElement>('.vela-widget-panels');
    if (!root || !rail) return () => {};
    const settings = root.querySelector<HTMLElement>('.vela-bb-settings');
    const right = root.querySelector<HTMLElement>('.vela-topbar-right') ?? rail;
    const alerts = root.querySelector<HTMLButtonElement>('.vela-widget-alerts');
    const alertsShortcut = alerts ? root.ownerDocument.createElement('button') : null;
    const showAlerts = (): void => alerts?.click();
    if (alertsShortcut && alerts) {
        alertsShortcut.type = 'button'; alertsShortcut.className = 'vela-widget-tool local-rail-alerts';
        alertsShortcut.setAttribute('aria-label', 'Alerts'); alertsShortcut.setAttribute('aria-haspopup', 'menu');
        alertsShortcut.title = 'Alerts';
        const glyph = alerts.querySelector('.vela-icon'); if (glyph) alertsShortcut.append(glyph.cloneNode(true));
        alertsShortcut.addEventListener('click', showAlerts);
    }
    const settingsHome = settings?.parentNode;
    const marker = settings ? root.ownerDocument.createComment('chart-settings-position') : null;
    if (settings && marker) settings.before(marker);
    const drawingToolbar = root.querySelector<HTMLElement>('.vela-dtb');
    const hadClass = root.classList.contains('local-reference-chrome');
    const previousWidth = root.style.getPropertyValue('--local-reference-left');
    const previousPriority = root.style.getPropertyPriority('--local-reference-left');
    const attributes = new Map<HTMLElement, string | null>();
    const order = new Map<HTMLElement, number>();
    let disposed = false;
    root.classList.add('local-reference-chrome');

    const remember = (button: HTMLElement): void => {
        if (!attributes.has(button)) attributes.set(button, button.getAttribute('data-local-panel'));
        const id = [...button.classList].find((name) => name.startsWith(PANEL_CLASS))?.slice(PANEL_CLASS.length);
        if (id) button.setAttribute('data-local-panel', id);
        if (!order.has(button)) order.set(button, order.size);
    };
    const restoreSettings = (): void => {
        if (!settings || !marker) return;
        if (marker.parentNode && settings.previousSibling !== marker) marker.after(settings);
        else if (!marker.parentNode && settingsHome && settings.parentNode === right) settingsHome.appendChild(settings);
    };
    const nativeOrder = (): void => {
        const buttons = [...rail.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== settings && element !== alertsShortcut);
        const sorted = [...buttons].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
        if (buttons.some((button, index) => button !== sorted[index])) sorted.forEach((button) => rail.appendChild(button));
    };
    const sync = (): void => {
        if (disposed) return;
        const buttons = [...rail.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== settings && element !== alertsShortcut);
        buttons.forEach(remember);
        const desktop = root.dataset.layout !== 'mobile';
        if (!desktop) { alertsShortcut?.remove(); restoreSettings(); nativeOrder(); return; }
        const width = drawingToolbar?.getBoundingClientRect().width;
        if (width !== undefined && Number.isFinite(width) && width >= 0) root.style.setProperty('--local-reference-left', `${width}px`);
        const sorted = [...buttons].sort((left, right) =>
            (PANEL_RANK[left.dataset.localPanel ?? ''] ?? 50) - (PANEL_RANK[right.dataset.localPanel ?? ''] ?? 50) ||
            (order.get(left) ?? 0) - (order.get(right) ?? 0));
        if (buttons.some((button, index) => button !== sorted[index])) sorted.forEach((button) => rail.appendChild(button));
        if (alertsShortcut) {
            const watchlist = sorted.find((button) => button.dataset.localPanel === 'local.watchlist');
            if (watchlist && watchlist.nextSibling !== alertsShortcut) watchlist.after(alertsShortcut);
            else if (!watchlist && rail.firstChild !== alertsShortcut) rail.prepend(alertsShortcut);
        }
        if (settings && settings.parentNode !== right) {
            const fullscreen = right.querySelector('[data-local-action="local.fullscreen"]')?.closest('.vela-widget-action-pin');
            if (fullscreen) fullscreen.before(settings); else right.append(settings);
        }
    };
    const mode = typeof MutationObserver === 'function' ? new MutationObserver(sync) : null;
    mode?.observe(root, { attributes: true, attributeFilter: ['data-layout'] });
    mode?.observe(rail, { childList: true });
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
    if (drawingToolbar) resize?.observe(drawingToolbar);
    const win = root.ownerDocument.defaultView;
    win?.addEventListener('resize', sync);
    sync();
    return () => {
        if (disposed) return;
        disposed = true;
        mode?.disconnect(); resize?.disconnect(); win?.removeEventListener('resize', sync);
        alertsShortcut?.removeEventListener('click', showAlerts); alertsShortcut?.remove();
        restoreSettings(); nativeOrder(); marker?.remove();
        for (const [button, value] of attributes) {
            if (value === null) button.removeAttribute('data-local-panel');
            else button.setAttribute('data-local-panel', value);
        }
        if (previousWidth) root.style.setProperty('--local-reference-left', previousWidth, previousPriority);
        else root.style.removeProperty('--local-reference-left');
        if (!hadClass) root.classList.remove('local-reference-chrome');
    };
}
