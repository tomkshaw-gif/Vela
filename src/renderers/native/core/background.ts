/** Vertical plot background, shared by live CSS, axis gutters and PNG exports.
 * Stops use concrete hex colors so saved configs remain portable to Canvas2D. */
export interface BackgroundGradient {
    topColor: string;
    bottomColor: string;
}

export function backgroundGradient(value: unknown): BackgroundGradient | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    const hex = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
    return typeof candidate.topColor === 'string' && hex.test(candidate.topColor)
        && typeof candidate.bottomColor === 'string' && hex.test(candidate.bottomColor)
        ? { topColor: candidate.topColor, bottomColor: candidate.bottomColor } : null;
}

export function backgroundCss(color: string, gradient: BackgroundGradient | null | undefined): string {
    return gradient ? `linear-gradient(to bottom, ${gradient.topColor}, ${gradient.bottomColor})` : color;
}

/** Bottom-corner branding follows the gradient's lower surface, not its solid fallback. */
export function backgroundCornerColor(color: string, gradient: BackgroundGradient | null | undefined): string {
    return gradient?.bottomColor ?? color;
}

export function backgroundPaint(ctx: CanvasRenderingContext2D, color: string, gradient: BackgroundGradient | null | undefined, height: number): string | CanvasGradient {
    if (!gradient) return color;
    const fill = ctx.createLinearGradient(0, 0, 0, Math.max(1, height));
    fill.addColorStop(0, gradient.topColor);
    fill.addColorStop(1, gradient.bottomColor);
    return fill;
}
