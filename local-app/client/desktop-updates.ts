import type { DesktopUpdateState } from './desktop-bridge';
import './desktop-updates.css';

/** Mount a desktop-only control; the main process owns downloads and installation. */
export function mountDesktopUpdates(host: HTMLElement, bridge = window.velaDesktop, compact = false): () => void {
    if (!bridge?.getUpdateState || !bridge.onUpdateState || !bridge.checkForUpdates || !bridge.installUpdate) return () => {};
    const root = document.createElement('div'); root.className = `desktop-updates${compact ? ' desktop-updates-compact' : ''}`;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'desktop-update-button';
    const icon = document.createElement('span'); icon.className = 'desktop-update-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = '↻';
    const label = document.createElement('span'); label.textContent = 'Check for updates'; button.append(icon, label);
    const note = document.createElement('small'); note.className = 'desktop-update-note'; note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
    root.append(button, note); host.append(root);
    let disposed = false, pending = false, sequence = 0, failed = false;
    let state: DesktopUpdateState = { status: 'idle', currentVersion: '' };
    const render = (): void => {
        if (disposed) return;
        const busy = pending || ['checking', 'downloading', 'installing'].includes(state.status);
        const ready = state.status === 'ready';
        button.setAttribute('aria-disabled', String(busy)); button.setAttribute('aria-busy', String(busy));
        root.dataset.state = state.status;
        label.textContent = state.status === 'installing' ? 'Saving & restarting…' : ready ? 'Restart to update'
            : state.status === 'downloading' ? 'Downloading update…' : state.status === 'checking' || pending ? 'Checking for updates…'
                : state.status === 'error' || failed ? 'Retry update check' : 'Check for updates';
        const version = state.currentVersion ? `Vela ${state.currentVersion}` : 'Vela desktop';
        note.textContent = failed ? ready ? 'Update ready. Click to retry restarting.' : 'Couldn’t check for updates. Try again.'
            : ready ? `${state.version ? `Version ${state.version}` : 'Update'} ready · restart when you’re ready`
                : state.status === 'installing' ? 'Saving your workspace before restarting.'
                    : state.status === 'downloading' ? 'You can keep working. Restart when ready.'
                        : state.status === 'current' ? `${version} · up to date`
                            : state.status === 'error' ? 'Couldn’t check for updates. Try again.' : version;
        button.title = ready ? 'Save your workspace, install the downloaded update and relaunch Vela.' : 'Check for a new desktop version.';
    };
    const accept = (next: DesktopUpdateState): void => {
        if (disposed) return;
        sequence++; state = next; failed = false; render();
    };
    const refresh = async (): Promise<void> => {
        const requested = sequence;
        try { const next = await bridge.getUpdateState(); if (!disposed && sequence === requested) accept(next); }
        catch { if (!disposed && sequence === requested) { failed = true; render(); } }
    };
    const off = bridge.onUpdateState(accept);
    const click = (): void => {
        if (disposed || pending || ['checking', 'downloading', 'installing'].includes(state.status)) return;
        const install = state.status === 'ready';
        pending = true; failed = false; render();
        void Promise.resolve().then<boolean | void>(() => install ? bridge.installUpdate() : bridge.checkForUpdates()).then(async result => {
            if (disposed) return;
            if (install && result === false) failed = true;
            else await refresh();
        }).catch(() => { if (!disposed) failed = true; }).finally(() => {
            if (disposed) return;
            pending = false; render();
        });
    };
    button.addEventListener('click', click); render(); void refresh();
    return () => { if (disposed) return; disposed = true; off(); button.removeEventListener('click', click); root.remove(); };
}
