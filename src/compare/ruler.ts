export interface RulerMarker {
  hunk: number;
  /** px from the top of the ruler. */
  top: number;
  height: number;
}

export const MIN_MARKER_PX = 3;

/** Marker rectangles for hunk spans (`first` row, `count` rows) on a ruler of `heightPx` covering `totalRows` rows. */
export function rulerMarkers(spans: readonly { hunk: number; first: number; count: number }[], totalRows: number, heightPx: number): RulerMarker[] {
  if (totalRows <= 0 || heightPx <= 0) return [];
  const scale = heightPx / totalRows;
  return spans.map((s) => {
    const height = Math.max(MIN_MARKER_PX, s.count * scale);
    const top = Math.min(Math.max(0, s.first * scale), Math.max(0, heightPx - height));
    return { hunk: s.hunk, top, height };
  });
}

/** Row at a ruler y position (clamped). */
export function rowAtY(y: number, totalRows: number, heightPx: number): number {
  if (totalRows <= 0 || heightPx <= 0) return 0;
  return Math.max(0, Math.min(totalRows - 1, Math.floor((y / heightPx) * totalRows)));
}

/** Hunk whose marker contains `y`, else the nearest within `tolerance` px, else undefined. */
export function hunkAtY(markers: readonly RulerMarker[], y: number, tolerance = 6): number | undefined {
  let best: number | undefined;
  let bestD = Infinity;
  for (const m of markers) {
    const d = y < m.top ? m.top - y : y > m.top + m.height ? y - (m.top + m.height) : 0;
    if (d < bestD) {
      bestD = d;
      best = m.hunk;
    }
  }
  return bestD <= tolerance ? best : undefined;
}

/** Visible window of the panes as a ruler thumb. */
export function viewportThumb(scrollTop: number, viewH: number, contentH: number, heightPx: number): { top: number; height: number } {
  if (contentH <= 0) return { top: 0, height: heightPx };
  const k = heightPx / contentH;
  return { top: scrollTop * k, height: Math.max(MIN_MARKER_PX, Math.min(heightPx, viewH * k)) };
}
