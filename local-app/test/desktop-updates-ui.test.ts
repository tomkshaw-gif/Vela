// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountDesktopUpdates } from '../client/desktop-updates';
import { mountSessionDashboard } from '../client/session-dashboard';
import type { DesktopBridge, DesktopUpdateState } from '../client/desktop-bridge';

const disposers: (() => void)[] = [];
const initial: DesktopUpdateState = { status: 'current', currentVersion: '1.3.1' };
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
function fixture() {
    let state = { ...initial };
    const callbacks = new Set<(state: DesktopUpdateState) => void>();
    const bridge: DesktopBridge = {
        onPrepare: () => () => {}, prepared: () => {},
        getUpdateState: vi.fn(async () => state),
        onUpdateState(callback) { callbacks.add(callback); callback(state); return () => { callbacks.delete(callback); }; },
        checkForUpdates: vi.fn(async () => {}), installUpdate: vi.fn(async () => true),
    };
    const host = document.createElement('div'); document.body.append(host);
    const mount = (compact = false): (() => void) => { const off = mountDesktopUpdates(host, bridge, compact); disposers.push(off); return off; };
    const emit = (next: DesktopUpdateState): void => { state = next; for (const callback of callbacks) callback(next); };
    const button = (): HTMLButtonElement => host.querySelector('button')!;
    return { bridge, host, mount, emit, callbacks, button };
}
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); delete window.velaDesktop; document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('desktop update control', () => {
    it('leaves the ordinary browser dashboard free of desktop update controls', () => {
        const host = document.createElement('div'); document.body.append(host);
        disposers.push(mountDesktopUpdates(host)); expect(host.children).toHaveLength(0);
    });

    it('shows the installed version and checks only after an explicit click', async () => {
        const f = fixture(); f.mount(); await Promise.resolve();
        expect(f.button().textContent).toContain('Check for updates'); expect(f.host.textContent).toContain('Vela 1.3.1');
        expect(f.bridge.checkForUpdates).not.toHaveBeenCalled(); expect(f.bridge.installUpdate).not.toHaveBeenCalled();
        f.button().focus(); f.button().click();
        await vi.waitFor(() => expect(f.bridge.checkForUpdates).toHaveBeenCalledOnce());
        expect(f.bridge.installUpdate).not.toHaveBeenCalled(); expect(document.activeElement).toBe(f.button());
    });

    it('waits for a click after download and coalesces repeated restart clicks', async () => {
        const f = fixture(); const install = deferred<boolean>(); vi.mocked(f.bridge.installUpdate).mockReturnValue(install.promise); f.mount();
        f.emit({ status: 'ready', currentVersion: '1.3.1', version: '1.4.1' });
        expect(f.button().textContent).toContain('Restart to update'); expect(f.host.textContent).toContain('Version 1.4.1 ready');
        expect(f.bridge.installUpdate).not.toHaveBeenCalled();
        f.button().click(); f.button().click(); await vi.waitFor(() => expect(f.bridge.installUpdate).toHaveBeenCalledOnce());
        f.emit({ status: 'installing', currentVersion: '1.3.1', version: '1.4.1' });
        expect(f.button().textContent).toContain('Saving & restarting'); expect(f.button().getAttribute('aria-disabled')).toBe('true');
        install.resolve(true);
    });

    it.each(['checking', 'downloading', 'installing'] as const)('keeps %s inert while retaining keyboard focus', async status => {
        const f = fixture(); f.mount(); f.button().focus(); f.emit({ status, currentVersion: '1.3.1' });
        f.button().click(); await Promise.resolve();
        expect(f.bridge.checkForUpdates).not.toHaveBeenCalled(); expect(f.bridge.installUpdate).not.toHaveBeenCalled();
        expect(f.button().getAttribute('aria-disabled')).toBe('true'); expect(document.activeElement).toBe(f.button());
    });

    it('keeps a failed save or installation retryable without exposing private errors', async () => {
        const f = fixture(); f.mount(); f.emit({ status: 'ready', currentVersion: '1.3.1', version: '1.4.1' });
        vi.mocked(f.bridge.installUpdate).mockResolvedValueOnce(false);
        f.button().click(); await vi.waitFor(() => expect(f.host.textContent).toContain('Click to retry restarting'));
        expect(f.button().textContent).toContain('Restart to update'); expect(f.button().getAttribute('aria-disabled')).toBe('false');
        f.button().click(); await vi.waitFor(() => expect(f.bridge.installUpdate).toHaveBeenCalledTimes(2));
    });

    it('reports a failed check and allows retry', async () => {
        const f = fixture(); f.mount(); vi.mocked(f.bridge.checkForUpdates).mockRejectedValueOnce(new Error('Private filesystem diagnostic'));
        f.button().click(); await vi.waitFor(() => expect(f.button().textContent).toContain('Retry update check'));
        expect(f.host.textContent).not.toContain('Private'); expect(f.host.querySelector('[role=status]')?.textContent).toContain('Couldn’t check');
        f.button().click(); await vi.waitFor(() => expect(f.bridge.checkForUpdates).toHaveBeenCalledTimes(2));
    });

    it('does not let a stale initial snapshot overwrite a newer ready notification', async () => {
        const f = fixture(); const snapshot = deferred<DesktopUpdateState>(); vi.mocked(f.bridge.getUpdateState).mockReturnValue(snapshot.promise); f.mount();
        f.emit({ status: 'ready', version: '1.4.1', currentVersion: '1.3.1' }); snapshot.resolve(initial); await Promise.resolve(); await Promise.resolve();
        expect(f.button().textContent).toContain('Restart to update'); expect(f.host.textContent).toContain('Version 1.4.1');
    });

    it('removes subscriptions and ignores pending completions after disposal', async () => {
        const f = fixture(); const snapshot = deferred<DesktopUpdateState>(); vi.mocked(f.bridge.getUpdateState).mockReturnValue(snapshot.promise);
        const off = f.mount(); const oldButton = f.button(); off(); off();
        expect(f.callbacks.size).toBe(0); oldButton.click(); snapshot.resolve({ status: 'ready', currentVersion: '1.3.1' });
        await Promise.resolve(); expect(f.host.children).toHaveLength(0); expect(f.bridge.installUpdate).not.toHaveBeenCalled();
    });

    it('places the live control in the dashboard footer and cleans up with the dashboard', () => {
        const f = fixture(); window.velaDesktop = f.bridge;
        const dashboard = mountSessionDashboard(f.host, { newSession: () => {}, openSession: () => {}, openChart: () => {}, openData: () => {}, importSession: () => {} });
        disposers.push(() => dashboard.destroy());
        const update = f.host.querySelector('.desktop-updates')!;
        expect(update.closest('.sd-sidebar-footer')).not.toBeNull(); expect(update.parentElement?.textContent).toContain('Local workspace');
        f.emit({ status: 'ready', currentVersion: '1.3.1', version: '1.4.1' });
        expect(update.textContent).toContain('Restart to update'); dashboard.destroy(); expect(f.callbacks.size).toBe(0);
    });

    it('keeps compact chart and dashboard controls synchronized through the desktop bridge', () => {
        const f = fixture(); f.mount(); f.mount(true);
        f.emit({ status: 'ready', currentVersion: '1.3.1', version: '1.4.1' });
        expect([...f.host.querySelectorAll('button')].every(button => button.textContent?.includes('Restart to update'))).toBe(true);
        expect(f.host.querySelectorAll('.desktop-updates-compact')).toHaveLength(1); expect(f.bridge.installUpdate).not.toHaveBeenCalled();
    });
});
