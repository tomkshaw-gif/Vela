import tseslint from 'typescript-eslint';

/**
 * Architectural boundary guard (the maintainability contract):
 *  - `pinets` is BANNED outright. Vela ships no scripting engine: Pine Script lives in
 *    the `@luxalgo/vela-pinets` addon, which is AGPL-3.0 (as `pinets` is) — importing it
 *    here would pull that license onto this Apache-2.0 package. Engines plug in through
 *    the `ScriptingEngine` port instead (see docs/contributing/adding-an-engine.md).
 *  - `lightweight-charts` is a TEMPORARY type-only devDependency (legacy shared types);
 *    no new import of it is allowed anywhere — it is being replaced by Vela's own types.
 */
export default tseslint.config(
    { ignores: ['dist/**', 'local-app/dist/**', 'local-app/.runtime/**', 'local-app/electron/staging/**', 'local-app/electron/releases/**', '.scratchpad/**', 'node_modules/**'] },
    {
        files: ['local-app/**/*.ts'],
        languageOptions: { parser: tseslint.parser },
    },
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tseslint.parser,
        },
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        { name: 'pinets', message: 'Vela carries no Pine code. `pinets` is AGPL-3.0 and lives in the @luxalgo/vela-pinets addon; plug an engine in through the ScriptingEngine port instead.' },
                    ],
                },
            ],
        },
    },
);
