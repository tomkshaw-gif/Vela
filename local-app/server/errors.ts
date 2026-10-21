export class AppError extends Error {
    constructor(public status: number, message: string, public code = 'INVALID_REQUEST') { super(message); }
}
export function requireObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'Expected a JSON object.');
    return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 120): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new AppError(400, `Invalid ${label}.`);
    return value.trim();
}
