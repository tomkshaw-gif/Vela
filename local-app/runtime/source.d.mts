export function relevantSource(filename: string): boolean;
export function sourceFingerprint(root: string): Promise<string>;
export function watchSources(root: string, onChange: () => void): () => void;
