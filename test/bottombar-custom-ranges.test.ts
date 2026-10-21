// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bottombar } from '../src/widget/bottombar';
import { DrawingToolbar } from '../src/renderers/native/drawings/DrawingToolbar';
import { resolveTheme } from '../src/core/theme';

(globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); });

describe('custom bottom bar composition', () => {
    it('uses the configured actual range and opens date navigation without invoking a range action', () => {
        const host = document.createElement('div'); document.body.append(host);
        const onRange = vi.fn(); const onDateJump = vi.fn(); const onSession = vi.fn();
        const clockOff = vi.fn();
        const bar = new Bottombar(host, { timezone: 'Etc/UTC', rangePresets: [{ id: '5D', tf: '5', preset: '5D', bars: 1500 }],
            onRange, onDateJump, onSession, onTimezone: () => {}, sessionControls: false, clock: { onTick: () => clockOff } });
        disposers.push(() => bar.destroy());
        expect([...bar.el.querySelectorAll('.vela-bb-range')].map((button) => button.textContent)).toEqual(['5D']);
        bar.el.querySelector<HTMLButtonElement>('.vela-bb-range')!.click();
        expect(onRange).toHaveBeenCalledWith({ id: '5D', tf: '5', preset: '5D', bars: 1500 });
        onRange.mockClear(); bar.el.querySelector<HTMLButtonElement>('.vela-bb-date')!.click();
        expect(onDateJump).toHaveBeenCalledOnce(); expect(onRange).not.toHaveBeenCalled();
        bar.setSession({ enabled: true, session: 'extended' });
        expect((bar.el.querySelector('.vela-bb-session') as HTMLElement).style.display).toBe('none');
        for (const button of bar.el.querySelectorAll<HTMLButtonElement>('.vela-bb-session-btn')) { expect(button.disabled).toBe(true); button.click(); }
        expect(onSession).not.toHaveBeenCalled();
        bar.destroy(); expect(clockOff).toHaveBeenCalledOnce();
        disposers.pop();
    });

    it('keeps utility order and reads actual state without replacing the focused button', () => {
        const host = document.createElement('div'); document.body.append(host);
        let locked = false; const run = vi.fn(() => { locked = !locked; });
        const erase = vi.fn();
        const toolbar = new DrawingToolbar(host, resolveTheme('dark'), () => {}, undefined, undefined, erase);
        disposers.push(() => toolbar.destroy()); toolbar.setVisible(true);
        toolbar.setUtilities([
            { id: 'zoom', label: 'Zoom', icon: '', group: 'navigation', run: () => {} },
            { id: 'lock', label: 'Lock all', icon: '', group: 'drawing', run, pressed: () => locked },
            { id: 'delete', label: 'Delete all', icon: '', group: 'remove', run: () => {}, eraserInMenu: true },
            { id: 'favorites', label: 'Favorites', icon: '', group: 'footer', run: () => {} },
        ]);
        const buttons = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label]')];
        const labels = buttons.map((button) => button.getAttribute('aria-label'));
        expect(labels.indexOf('Measure')).toBeLessThan(labels.indexOf('Zoom'));
        expect(labels.indexOf('Zoom')).toBeLessThan(labels.indexOf('Lock all'));
        expect(labels.indexOf('Lock all')).toBeLessThan(labels.indexOf('Delete all'));
        expect(labels.indexOf('Delete all')).toBeLessThan(labels.indexOf('Favorites'));
        expect(labels).not.toContain('Eraser (click/drag to delete)');
        const lock = host.querySelector<HTMLButtonElement>('[data-utility="lock"]')!;
        lock.focus(); lock.click(); expect(run).toHaveBeenCalledOnce();
        expect(lock.getAttribute('aria-pressed')).toBe('true'); expect(lock.dataset.active).toBe('1');
        locked = false; toolbar.refreshUtilities(); expect(document.activeElement).toBe(lock);
        expect(lock.getAttribute('aria-pressed')).toBe('false');
        const more = host.querySelector<HTMLButtonElement>('[data-utility-menu="delete"]')!;
        more.click(); expect(more.getAttribute('aria-expanded')).toBe('true');
        const eraser = host.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
        expect(eraser.getAttribute('aria-label')).toBe('Eraser (click/drag to delete)');
        eraser.click(); expect(erase).toHaveBeenCalledOnce(); expect(more.getAttribute('aria-expanded')).toBe('false');
        toolbar.setEraserActive(true);
        expect(more.closest('.vela-dtb-cell')!.getAttribute('data-active')).toBe('1');
        toolbar.setUtilities([]); expect(host.querySelector('[data-utility]')).toBeNull();
        expect(host.querySelector('.vela-dtb [aria-label="Eraser (click/drag to delete)"]')).not.toBeNull();
    });
});
