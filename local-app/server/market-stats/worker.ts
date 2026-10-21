import { parentPort, workerData } from 'node:worker_threads';
import { MarketStatsError } from './contract';
import type { MarketStatsWorkerRequest, MarketStatsWorkerMessage } from './contract';
import { runMarketStatsEngine } from './engine';

if (!parentPort) throw new Error('Market statistics require an isolated worker.');
const port = parentPort;
void (async () => {
    try {
        const request = workerData as MarketStatsWorkerRequest;
        if (request?.type !== 'market-stats:run' || typeof request.dataDirectory !== 'string') throw new MarketStatsError('INVALID_INPUT', 'Invalid market statistics worker request.');
        const result = request.artifact ? await runMarketStatsEngine(request.input, { dataDirectory: request.dataDirectory, artifact: request.artifact })
            : await runMarketStatsEngine(request.input, { dataDirectory: request.dataDirectory });
        port.postMessage({ type: 'market-stats:result', result } satisfies MarketStatsWorkerMessage);
    } catch (error) {
        const code = error instanceof MarketStatsError ? error.code : 'ENGINE_FAILED';
        port.postMessage({ type: 'market-stats:error', error: { code, message: 'The market statistics query could not be completed.' } } satisfies MarketStatsWorkerMessage);
    } finally { port.close(); }
})();
