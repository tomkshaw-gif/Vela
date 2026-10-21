import { defineConfig } from 'vitest/config';
import { localDrawingIcons, localResultsChart } from './local-app/local-ui-plugin';

export default defineConfig({
    plugins: [localDrawingIcons(), localResultsChart()],
    test: {
        // `.mjs` tests cover the framework-free playground modules (plain JS, outside the
        // TS build) — e.g. the keyboard-shortcut policy in `playground/modules/shortcuts-core.js`.
        include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'test/**/*.test.mjs', 'local-app/test/**/*.test.ts'],
        environment: 'node',
    },
});
