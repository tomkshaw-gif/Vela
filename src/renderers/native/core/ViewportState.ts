/**
 * The authoritative, user-controlled pan/zoom state of the time axis.
 *
 * - `barSpacing`: pixels between adjacent bar centers (the zoom level).
 * - `rightOffset`: distance in bar-widths from the last bar's center (`bar-center`)
 *   or its slot's right edge (`bar-edge`) to the plot's right edge. The renderer
 *   selects the convention; the latter adds half a bar to the center's distance.
 *
 * The chart width and bar count are NOT part of this state — they are owned by
 * the renderer (resize / setBars) and combined with the viewport in the
 * CoordinateSystem to produce pixel coordinates.
 */
export interface ViewportState {
    barSpacing: number;
    rightOffset: number;
}

export type RightOffsetConvention = 'bar-center' | 'bar-edge';

/** Center-to-edge phase in logical bar units. */
export function rightOffsetPhase(convention: RightOffsetConvention): number {
    return convention === 'bar-edge' ? 0.5 : 0;
}

export const MIN_BAR_SPACING = 0.5;
/**
 * A high sanity ceiling for a single bar's pixel width — NOT the practical zoom-in limit. The real
 * max-zoom is governed by `MIN_VISIBLE_BARS` in the renderer's `clampViewport` (keep ≥ N candles on
 * screen ⇒ `barSpacing ≤ width / N`), which on any sub-4K display binds well before this. Kept large
 * so a deep reveal-style zoom (wide candles, a roomy grid, legible per-level numbers) isn't pre-clamped.
 */
export const MAX_BAR_SPACING = 1000;

/** Default zoom/pan before any data is loaded. */
export function defaultViewport(): ViewportState {
    return { barSpacing: 8, rightOffset: 6 };
}

export function clampBarSpacing(spacing: number): number {
    return Math.max(MIN_BAR_SPACING, Math.min(MAX_BAR_SPACING, spacing));
}
