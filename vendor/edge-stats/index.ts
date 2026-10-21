/**
 * Local entry point for the unchanged upstream query/derive dependency closure.
 * Only existing upstream exports are exposed. Network adapters, sync, live loops,
 * event data, trade ingestion, presets, export and session-bar helpers are omitted.
 * See provenance.json for the pinned source files and their SHA-256 hashes.
 */
export { ENGINE_VERSION } from './src/version';
export * from './src/config';
export * from './src/calendar';
export { Store } from './src/store/store';
export type { BarRow, IngestResult } from './src/store/store';
export * from './src/registry';
export * from './src/query/ast';
export { lex, DslSyntaxError } from './src/query/lexer';
export { parseDsl, parseConditionDsl, renderDslError } from './src/query/parser';
export { astToDsl, callToDsl, literalToDsl } from './src/query/normalize';
export { compileQuery, compileConditionExpr, suggest } from './src/query/compile';
export type { CompiledQuery } from './src/query/compile';
export { runQuery, getSessions, parseRequestAst, compileCtxFor, DISCLAIMER } from './src/query/execute';
export type { QueryRequest, QueryResult, SessionRef, GroupResult, RecencyView, SessionDetail } from './src/query/execute';
export * from './src/stats/stats';
export { deriveFeatures } from './src/features/derive';
export type { DeriveOptions, DeriveSummary } from './src/features/derive';
export { featureColumns, featuresDdl, BASE_COLUMNS, orColumns } from './src/features/schema';
