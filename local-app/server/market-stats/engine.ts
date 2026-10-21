import { writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
    Store, ENGINE_VERSION, configSchema, holidayCalendarSchema, resolveSessions, deriveFeatures,
    parseRequestAst, compileQuery, compileCtxFor, runQuery, describeRegistry,
} from '@luxalgo/edge-stats';
import type { QueryResult, SessionResolver } from '@luxalgo/edge-stats';
import { MARKET_STATS_SOURCE, MarketStatsError } from './contract';
import type { PreparedMarketStatsRequest } from './contract';
import { checkAborted, prepareMarketStats } from './prepare';
import { getSessionBars } from '@luxalgo/edge-stats/session-bars';
import { exportQuery } from '@luxalgo/edge-stats/export';
import { artifactOperation, type StatsArtifact, type StatsArtifactOperation } from './artifacts';
import { applyEventEligibility, eventRequirements, requireEventCalendars } from './events';

/** Runs inside the isolated worker. No sync, vendor adapters, event downloads, or account state. */
export function runMarketStatsEngine(input: PreparedMarketStatsRequest, options: { dataDirectory: string; signal?: AbortSignal; artifact: StatsArtifactOperation }): Promise<StatsArtifact>;
export function runMarketStatsEngine(input: PreparedMarketStatsRequest, options: { dataDirectory: string; signal?: AbortSignal }): Promise<QueryResult>;
export async function runMarketStatsEngine(input: PreparedMarketStatsRequest, options: { dataDirectory: string; signal?: AbortSignal; artifact?: StatsArtifactOperation }): Promise<QueryResult | StatsArtifact> {
    checkAborted(options.signal);
    if (ENGINE_VERSION !== MARKET_STATS_SOURCE.version) throw new MarketStatsError('ENGINE_FAILED', 'The pinned market statistics engine version does not match.');
    const sessionKey = input.symbol.defaultSession!; const definition = input.symbol.sessions?.[sessionKey];
    if (!definition) throw new MarketStatsError('INVALID_INPUT', 'The statistics session definition is missing.');
    // Check the worker boundary too: never trust an externally assembled Prepared value.
    const prepared = await prepareMarketStats({
        bars: input.bars.map(bar => ({ time: bar.ts, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
            ...(bar.instrumentId !== undefined ? { instrumentId: bar.instrumentId, contract: bar.contract ?? undefined } : {}) })),
        symbol: input.symbol.symbol, assetClass: input.symbol.assetClass, sourceIntervalMs: 60_000,
        revealedUntil: input.coverage.revealedUntil, session: { key: sessionKey, ...definition }, calendar: input.calendar, events: input.events,
        orWindows: input.symbol.orWindows, ibWindow: input.symbol.ibWindow,
        query: { dsl: input.query.dsl!, since: input.query.since, until: input.query.until, groupBy: input.query.groupBy, sessionsLimit: input.query.sessionsLimit },
    }, options.signal);
    const config = configSchema.parse({ dataDir: options.dataDirectory, symbols: [prepared.symbol] });
    const calendar = prepared.calendar === null ? null : holidayCalendarSchema.parse(prepared.calendar);
    let ast: ReturnType<typeof parseRequestAst>;
    try {
        ast = parseRequestAst(prepared.query);
        compileQuery(ast, compileCtxFor(prepared.symbol));
        if (prepared.query.groupBy && !describeRegistry('field').some(field => field.name === prepared.query.groupBy && field.groupable)) throw new MarketStatsError('INVALID_QUERY', 'The selected field cannot group market statistics.');
        requireEventCalendars(eventRequirements(ast), prepared.events);
    } catch (error) {
        if (error instanceof MarketStatsError) throw error;
        throw new MarketStatsError('INVALID_QUERY', 'The market statistics query contains an invalid field or argument.');
    }
    if (calendar) {
        mkdirSync(join(options.dataDirectory, 'calendar'), { recursive: true });
        // The upstream result fingerprints this exact supplied calendar; nothing is fetched.
        writeFileSync(join(options.dataDirectory, 'calendar', 'provided.json'), JSON.stringify(calendar));
    }
    const cohorts: { first: number; end: number }[] = [];
    if (/^(NQ|GC)\.v\.0$/.test(prepared.symbol.symbol)) {
        for (let index = 0; index < prepared.bars.length; index++) {
            const bar = prepared.bars[index]!;
            if (index === 0 || bar.contract !== prepared.bars[index - 1]!.contract) cohorts.push({ first: bar.ts, end: bar.ts + 60_000 });
            else cohorts[cohorts.length - 1]!.end = bar.ts + 60_000;
        }
        if (cohorts.length > 128) throw new MarketStatsError('INVALID_INPUT', 'The selected interval contains too many contract changes. Choose a shorter range.');
    }
    let cohort: { first: number; end: number } | undefined;
    const resolver: SessionResolver = {
        resolve(symbol, key, from, to) {
            const windows = resolveSessions({ symbol, sessionKey: key, from, to, holidays: calendar });
            return windows.filter(window => {
                if (window.endMs > prepared.coverage.revealedUntil
                    || calendar && (window.tradeDate < calendar.coverage.from || window.tradeDate > calendar.coverage.to)) return false;
                if (cohort && (window.startMs < cohort.first || window.endMs > cohort.end)) return false;
                return true;
            });
        },
    };
    let store: Awaited<ReturnType<typeof Store.open>> | undefined;
    try {
        store = await Store.open(options.dataDirectory); checkAborted(options.signal);
        await store.run("SET memory_limit='256MB'");
        await store.run('SET threads=1');
        // Automatic extension installation/loading is never needed for these local tables/files.
        await store.run('SET autoinstall_known_extensions=false');
        await store.run('SET autoload_known_extensions=false');
        await store.replaceEvents(prepared.events.flatMap(file => file.dates.map(date => ({ date, event: file.event }))));
        await store.ingestBars(prepared.bars, null); checkAborted(options.signal);
        // The upstream receipt reads `bars` again. Materialize the bounded local rows
        // before disabling filesystem access for the query and receipt phase.
        await store.run('CREATE TEMP TABLE market_stats_bars AS SELECT * FROM bars');
        await store.run('CREATE OR REPLACE TEMP VIEW bars AS SELECT * FROM market_stats_bars');
        if (cohorts.length > 1) {
            // Derive each uninterrupted raw contract separately: prior ranges, ATR,
            // streaks and next-session outcomes must never bridge a contract roll.
            for (let index = 0; index < cohorts.length; index++) {
                cohort = cohorts[index]!; checkAborted(options.signal);
                await store.run(`CREATE OR REPLACE TEMP VIEW bars AS SELECT * FROM market_stats_bars WHERE ts >= ${cohort.first} AND ts < ${cohort.end}`);
                if (index > 0) await store.run('DELETE FROM session_features');
                await deriveFeatures(store, config, resolver); checkAborted(options.signal);
                if (index > 0) await store.run(`UPDATE session_features SET is_roll_day=true WHERE complete AND start_ts=(
                    SELECT min(candidate.start_ts) FROM session_features candidate WHERE candidate.complete
                    AND candidate.symbol=session_features.symbol AND candidate.session_key=session_features.session_key)`);
                await store.run(index === 0 ? 'CREATE TEMP TABLE market_stats_features AS SELECT * FROM session_features'
                    : 'INSERT INTO market_stats_features SELECT * FROM session_features');
            }
            await store.run('DELETE FROM session_features');
            await store.run('INSERT INTO session_features SELECT * FROM market_stats_features');
            await store.run('CREATE OR REPLACE TEMP VIEW bars AS SELECT * FROM market_stats_bars');
        } else {
            cohort = cohorts[0];
            await deriveFeatures(store, config, resolver); checkAborted(options.signal);
        }
        await applyEventEligibility(store, eventRequirements(ast), prepared.events, cohorts, prepared.coverage.revealedUntil);
        checkAborted(options.signal);
        const operation = options.artifact ? artifactOperation(options.artifact) : undefined;
        if (!operation) await store.run('SET enable_external_access=false');
        const result = await runQuery(store, config, { ...prepared.query, ast, dsl: undefined });
        if (operation?.kind === 'session') {
            if (!result.sessions.some(row => row.sessionId === operation.sessionId)) throw new MarketStatsError('INVALID_INPUT', 'Choose a session from this exact query result.');
            const session = await getSessionBars(store, config, operation.sessionId, { contextBars: operation.contextBars });
            const matching = cohorts.find(item => session.startTs >= item.first && session.endTs <= item.end);
            if (matching && session.context.bars.some(bar => bar.ts < matching.first)) {
                session.context.bars = session.context.bars.filter(bar => bar.ts >= matching.first);
                if (!session.context.bars.length) { session.context.kind = 'none'; session.context.note = 'Context from an earlier contract was excluded.'; }
            }
            checkAborted(options.signal); return { kind: 'session', session };
        }
        if (operation?.kind === 'export') {
            const path = join(options.dataDirectory, `matched-sessions.${operation.format}`);
            const summary = await exportQuery(store, config, prepared.query, path, operation.format);
            const bytes = statSync(path).size;
            if (bytes > 8_000_000) throw new MarketStatsError('INVALID_RESULT', 'The statistics export exceeds 8 MB. Choose a shorter interval.');
            const data = readFileSync(path); checkAborted(options.signal);
            return { kind: 'export', format: operation.format, rows: summary.rows, bytes, sha256: createHash('sha256').update(data).digest('hex'), data: data.toString('base64') };
        }
        checkAborted(options.signal); return result;
    } catch (error) {
        if (error instanceof MarketStatsError) throw error;
        throw new MarketStatsError('ENGINE_FAILED', 'The market statistics engine could not compute the selected local data.', { cause: error });
    } finally { if (store) await store.close(); }
}
