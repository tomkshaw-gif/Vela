import { fileURLToPath } from 'node:url';
import { startManagedRuntime } from './runtime/supervisor.mjs';

if (Number(process.versions.node.split('.')[0]) < 24) {
    console.error('Replay Studio requires Node.js 24 or newer. Use the desktop shortcuts.');
    process.exit(1);
}
const requested = process.argv.slice(2); let mode = 'run'; let open = true;
for (let index = 0; index < requested.length; index++) {
    const value = requested[index];
    if (value === '--no-open') open = false;
    else if (value === '--build') { /* Startup always validates the current source. */ }
    else if (value === '--mode' && ['run', 'develop'].includes(requested[index + 1])) mode = requested[++index];
    else if (['run', 'develop'].includes(value)) mode = value;
    else { console.error('Usage: node local-app/launch.mjs --mode run|develop [--no-open]'); process.exit(1); }
}
try {
    await startManagedRuntime({ root: fileURLToPath(new URL('..', import.meta.url)), mode, open });
} catch (error) {
    console.error(`Replay Studio could not start: ${error instanceof Error ? error.message : 'unknown local runtime error'}`);
    process.exitCode = 1;
}
