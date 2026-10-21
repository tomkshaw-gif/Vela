import { createServer } from 'vite';
import { pathToFileURL } from 'node:url';

const configPath = process.argv[2];
if (!configPath) throw new Error('A staged development configuration is required.');
const config = (await import(pathToFileURL(configPath).href)).default;
const server = await createServer({ ...config, configFile: false, mode: 'local-managed' });
await server.listen();
process.send?.({ type: 'vite:listening', port: 5198 });
async function close() { await server.close(); process.exit(0); }
process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
process.once('disconnect', () => { void close(); });
process.on('message', message => { if (message?.type === 'runtime:shutdown') void close(); });
