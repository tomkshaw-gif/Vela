import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { QueryResult } from '@luxalgo/edge-stats';
import { MarketStatsError } from './contract';
import type { MarketStatsWorkerRequest, StartMarketStatsJob } from './contract';
import type { PreparedMarketStatsRequest } from './contract';
import type { StartStatsArtifactJob, StatsArtifactOperation } from './artifacts';

type JobOptions = { workerUrl: URL; scratchDirectory: string; execArgv?: string[] };
function createFactory<T>(options: JobOptions) {
    if (options.workerUrl.protocol !== 'file:' || !/\.(?:mjs|js|ts)$/.test(options.workerUrl.pathname)
        || options.workerUrl.pathname.endsWith('.ts') && !options.execArgv?.length) throw new MarketStatsError('INVALID_INPUT', 'Supply a compiled worker URL, or an explicit source worker loader for development.');
    const workerUrl = new URL(options.workerUrl.href); const execArgv = [...(options.execArgv ?? [])];
    mkdirSync(options.scratchDirectory, { recursive: true });
    const root = realpathSync(options.scratchDirectory);
    return (input: PreparedMarketStatsRequest, artifact?: StatsArtifactOperation) => {
        const directory = mkdtempSync(join(root, 'market-stats-job-'));
        const cleanup = () => {
            const target = resolve(directory);
            if (dirname(target) !== root || !target.startsWith(join(root, 'market-stats-job-'))) throw new MarketStatsError('ENGINE_FAILED', 'Invalid market statistics scratch directory.');
            rmSync(target, { recursive: true, force: true });
        };
        let worker: Worker;
        try {
            worker = new Worker(workerUrl, {
                workerData: { type: 'market-stats:run', input, dataDirectory: directory, ...(artifact ? { artifact } : {}) } satisfies MarketStatsWorkerRequest,
                execArgv, resourceLimits: { maxOldGenerationSizeMb: 256 },
            });
        } catch { cleanup(); throw new MarketStatsError('ENGINE_FAILED', 'The market statistics worker could not start.'); }
        let settled = false;
        const result = new Promise<T>((fulfill, reject) => {
            const fail = (error: MarketStatsError) => { if (!settled) { settled = true; reject(error); } };
            worker.on('message', (message: unknown) => {
                if (settled) return;
                if (!message || typeof message !== 'object') { fail(new MarketStatsError('ENGINE_FAILED', 'Invalid market statistics worker response.')); return; }
                const response = message as { type?: string; result?: T; error?: { code?: string } };
                if (response.type === 'market-stats:result' && response.result) { settled = true; fulfill(response.result); }
                else if (response.type === 'market-stats:error') {
                    fail(response.error?.code === 'INVALID_QUERY' ? new MarketStatsError('INVALID_QUERY', 'The query uses an invalid or unavailable market statistics field or argument.')
                        : response.error?.code === 'UNSUPPORTED_INPUT' ? new MarketStatsError('UNSUPPORTED_INPUT', 'This query requires data or settings that were not supplied.')
                            : new MarketStatsError('ENGINE_FAILED', 'The market statistics worker could not complete this query.'));
                } else fail(new MarketStatsError('ENGINE_FAILED', 'Invalid market statistics worker response.'));
            });
            worker.once('error', () => fail(new MarketStatsError('ENGINE_FAILED', 'The market statistics worker could not complete this query.')));
            worker.once('exit', () => fail(new MarketStatsError('ENGINE_FAILED', 'The market statistics worker stopped before returning a result.')));
        });
        let disposal: Promise<void> | undefined;
        return {
            result,
            dispose() {
                disposal ??= (async () => { await worker.terminate(); cleanup(); })();
                return disposal;
            },
        };
    };
}

export function createNodeMarketStatsJobFactory(options: JobOptions): StartMarketStatsJob { return createFactory<QueryResult>(options); }
export function createNodeStatsArtifactJobFactory(options: JobOptions): StartStatsArtifactJob { return createFactory(options); }
