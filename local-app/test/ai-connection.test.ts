// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountAiConnection } from '../client/ai-connection';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
describe('chart question handoff', () => {
    it('prepares the requested drawing region and copies the exact target without a model call', async () => {
        const host = document.createElement('div'); document.body.append(host);
        const payload = { question: 'Check momentum', target: { clientId: 'own-window' }, scopeId: 'pinned' };
        const prepare = vi.fn(async () => payload); const copy = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
        const destroy = mountAiConnection(host, prepare);
        host.querySelector('textarea')!.value = 'Check momentum'; host.querySelector('input')!.value = 'region-drawing';
        host.querySelector('button')!.click(); await settle();
        expect(prepare).toHaveBeenCalledWith({ question: 'Check momentum', drawingId: 'region-drawing' });
        const button = host.querySelectorAll('button')[1]!; expect(button.hidden).toBe(false); button.click(); await settle();
        expect(copy).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(payload)));
        expect(host.querySelector('[role=status]')!.textContent).toBe('AI prompt copied.'); destroy();
    });
    it('reports scope errors and ignores a pending completion after its panel closes', async () => {
        const host = document.createElement('div'); document.body.append(host);
        const destroy = mountAiConnection(host, async () => { throw new Error('Replay changed. Prepare again.'); });
        host.querySelector('button')!.click(); await settle();
        expect(host.querySelector('[role=status]')!.textContent).toContain('Replay changed');
        expect(host.querySelectorAll('button')[1]!.hidden).toBe(true); destroy();
        let finish!: (value: unknown) => void;
        const close = mountAiConnection(host, () => new Promise(resolve => { finish = resolve; }));
        host.querySelector('button')!.click(); close(); finish({ scopeId: 'old' }); await settle();
        expect(host.childElementCount).toBe(0);
    });
});
