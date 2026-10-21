import { registerIcon } from '../../src/plugin';
import { sanitizeDrawingIcon } from './chart-appearance';
import icons from 'virtual:local-drawing-icons';
import { restoreDesktopSession } from './desktop-session';
import type {} from './desktop-bridge';

if (window.velaDesktop) restoreDesktopSession(localStorage, sessionStorage);

// Utility controls capture glyphs as their modules load. Register local assets first.
for (const [key, markup] of Object.entries(icons)) {
    if (!key.startsWith('icon-')) continue;
    const icon = sanitizeDrawingIcon(markup);
    if (icon) registerIcon(key.slice(5), icon);
}
void import('./main').then(({ startReplayStudio }) => startReplayStudio()).catch(() => {
    const app = document.querySelector('#app');
    if (app) app.textContent = 'Could not open Vela. Start the local launcher and reload this window.';
});
