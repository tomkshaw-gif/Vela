// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { buildReplayShell, managementShell, splitReplayShell } from '../client/shell';
import { keyboardAction, replayShortcutTargetIsEditing } from '../client/util';

afterEach(() => { document.body.replaceChildren(); });
describe('production chart and management page composition', () => {
    it('keeps replay shortcuts out of editor tabs, template controls and disclosure buttons', () => {
        document.body.innerHTML = '<section class="local-script-dock"><button id="editor-tab">Trades</button></section><div class="local-chart-templates"><button id="apply">Apply</button></div><details><summary>Run notes</summary></details>';
        for (const selector of ['#editor-tab', '#apply', 'summary']) {
            const editing = replayShortcutTargetIsEditing(document.querySelector(selector));
            expect(keyboardAction({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: false, metaKey: false, altKey: false }, editing)).toBeNull();
            expect(keyboardAction({ key: ' ', code: 'Space', ctrlKey: false, metaKey: false, altKey: false }, editing)).toBeNull();
        }
    });
    it('keeps every form/dialog unique and management results on their own page', () => {
        document.body.innerHTML = buildReplayShell();
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(document.querySelectorAll('#modal')).toHaveLength(1);
        expect(document.querySelectorAll('.transport[role="toolbar"]')).toHaveLength(1);
        expect(document.querySelector('#standard-workspace #chart')).not.toBeNull();
        expect(document.querySelector('#standard-workspace #results')).toBeNull();
        expect(document.querySelector('#standard-workspace .trading-column')).toBeNull();
        expect(document.querySelector('.trading-column .ticket-panel')).not.toBeNull();
        expect(document.querySelector('.trading-column .position-panel')).toBeNull();
        expect(document.querySelector('.trading-column .orders-panel')).toBeNull();
        expect(document.querySelector('.trading-column .rules-panel')).toBeNull();
        expect(document.querySelector('#trading-details .position-panel')).not.toBeNull();
        expect(document.querySelector('#trading-details .orders-panel')).not.toBeNull();
        expect(document.querySelector('#account-details .rules-panel')).not.toBeNull();
        for (const id of ['results', 'sessions', 'balance', 'ticket-form', 'replay-home', 'trade-home']) {
            expect(document.querySelector(`#session-manager #${id}`), id).not.toBeNull();
        }
        expect(document.querySelector('#session-manager #modal')).toBeNull();
        expect(document.querySelector('#standard-workspace #modal')).toBeNull();
        const stats = document.querySelector<HTMLElement>('#market-stats-page')!;
        expect(stats.hidden).toBe(true); expect(stats.getAttribute('aria-label')).toBe('Market Stats');
        expect(stats.parentElement).toBe(document.querySelector('#standard-workspace')!.parentElement);
        expect(stats.parentElement).toBe(document.querySelector('#session-manager')!.parentElement);
    });
    it('accepts accessibility attributes on the transport and fails closed if a required section disappears', () => {
        const markup = managementShell();
        expect(splitReplayShell(markup).after).toMatch(/^<div class="transport" role="toolbar"/);
        expect(() => splitReplayShell(markup.replace('class="transport"', 'class="other"'))).toThrow('incomplete');
    });
    it('leaves grip arrow keys to its own movement handler and retains chart replay shortcuts', () => {
        document.body.innerHTML = '<button class="local-drawing-grip"><svg><circle/></svg></button><div id="plot"></div>';
        const key = { key: 'ArrowRight', code: 'ArrowRight', ctrlKey: false, metaKey: false, altKey: false };
        expect(keyboardAction(key, replayShortcutTargetIsEditing(document.querySelector('circle')))).toBeNull();
        expect(keyboardAction(key, replayShortcutTargetIsEditing(document.querySelector('#plot')))).toBe('step');
    });
});
