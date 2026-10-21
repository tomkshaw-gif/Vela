export interface CachedStage { version: string; directory: string }
export function readCurrentStage(runtimeRoot: string, mode: string, repositoryId: string): Promise<CachedStage | undefined>;
export function saveCurrentStage(runtimeRoot: string, stage: CachedStage, mode: string, repositoryId: string): Promise<void>;
