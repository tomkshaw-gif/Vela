// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { InputsUI } from '../src/renderers/shared/InputsUI';
import { DARK_THEME, LIGHT_THEME } from '../src/core/theme';

let ui: InputsUI | null = null;
afterEach(() => {
    ui?.destroy();
    ui = null;
    document.body.replaceChildren();
});

function setup(terminal: boolean) {
    const host = document.createElement('div');
    if (terminal) host.setAttribute('data-vela-legend-appearance', 'terminal');
    document.body.appendChild(host);
    ui = new InputsUI(host, DARK_THEME);
    const toggles: boolean[] = [];
    ui.setOnToggleVisible((_id, visible) => toggles.push(visible));
    ui.upsert('levels', 'Session levels', [], {});
    ui.setPlotValues(new Map([['levels', [{ value: '4,178.1', color: '#000' }]]]));
    const row = host.querySelector<HTMLElement>('.vela-ind-row')!;
    const eye = row.querySelector<HTMLButtonElement>('[aria-label="Hide"]')!;
    return { host, row, eye, toggles };
}

describe('terminal legend appearance', () => {
    it('keeps the native geometry by default and opts into compact rows and glyphs', () => {
        const { host, row, eye } = setup(false);
        const terminalGlyph = eye.querySelector<HTMLElement>('.vela-legend-glyph-terminal')!;
        expect(getComputedStyle(row).minHeight).toBe('22px');
        expect(getComputedStyle(terminalGlyph).display).toBe('none');
        host.setAttribute('data-vela-legend-appearance', 'terminal');
        expect(getComputedStyle(row).minHeight).toBe('24px');
        expect(getComputedStyle(eye).width).toBe('28px');
        expect(getComputedStyle(terminalGlyph).display).toBe('inline-flex');
        expect(terminalGlyph.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 18 18');
    });

    it('keeps the crossed eye actionable while hiding values of a hidden study', () => {
        const { row, eye, toggles } = setup(true);
        ui!.setVisible('levels', false);
        expect(getComputedStyle(row).opacity).toBe('1');
        expect(row.parentElement!.style.getPropertyValue('--vela-legend-hidden-ink-default')).toBe('#575757');
        expect(getComputedStyle(row.querySelector('.vela-ind-values')!).display).toBe('none');
        expect(getComputedStyle(eye.parentElement!).display).toBe('inline-flex');
        expect(eye.getAttribute('aria-label')).toBe('Show');
        eye.click();
        expect(toggles).toEqual([true]);
        ui!.setVisible('levels', true);
        expect(eye.getAttribute('aria-label')).toBe('Hide');
        expect(getComputedStyle(eye.parentElement!).display).toBe('none');
        expect(getComputedStyle(row.querySelector('.vela-ind-values')!).display).toBe('block');
    });

    it('places the fold control below the studies and restores the rows after expanding', () => {
        const { host, row } = setup(true);
        ui!.upsert('second', 'S/R', [], {});
        const fold = host.querySelector<HTMLButtonElement>('.vela-ind-fold')!;
        expect(fold.parentElement?.lastElementChild).toBe(fold);
        expect(getComputedStyle(fold).height).toBe('19px');
        expect(getComputedStyle(fold).minWidth).toBe('27px');
        expect(fold.querySelector<HTMLElement>('.vela-legend-glyph-terminal')?.style.transform).toBe('rotate(180deg)');
        fold.click();
        expect(row.style.display).toBe('none');
        expect(fold.getAttribute('aria-label')).toBe('Show indicator legend');
        expect(fold.textContent).toBe('2');
        fold.click();
        expect(row.style.display).toBe('flex');
        expect(fold.getAttribute('aria-label')).toBe('Hide indicator legend');
    });

    it('retokens action and hidden-title contrast without overwriting explicit host overrides', () => {
        const { host, row } = setup(true);
        host.style.setProperty('--vela-legend-action-ink', '#123456');
        host.style.setProperty('--vela-legend-hidden-ink', '#654321');
        const legend = row.parentElement!;
        expect(legend.style.getPropertyValue('--vela-legend-action-ink-default')).toBe('#dbdbdb');
        ui!.setTheme({ ...LIGHT_THEME, textColor: '#777777' });
        expect(row.style.color).toBe('rgb(119, 119, 119)');
        expect(legend.style.getPropertyValue('--vela-legend-action-ink-default')).toBe('#0f0f0f');
        expect(legend.style.getPropertyValue('--vela-legend-hidden-ink-default')).toBe('#b8b8b8');
        expect(host.style.getPropertyValue('--vela-legend-action-ink')).toBe('#123456');
        expect(host.style.getPropertyValue('--vela-legend-hidden-ink')).toBe('#654321');
    });
});
