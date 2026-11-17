/**
 * Exact longest-common-subsequence matcher over integer-id sequences (lines and tokens share it).
 * Hunt-Szymanski style sparse chain search for sparse regions, Hirschberg linear-space divide and
 * conquer for dense ones. No Myers (D14), no third-party code.
 *
 * Scoring: every match scores MATCH_BASE + weight(line), weight = max(1, floor(1024 / rarity)), where
 * rarity is the larger occurrence count of the line over the two whole inputs. MATCH_BASE exceeds any
 * possible total weight, so the result always has maximal LCS length; among equal-length LCS
 * solutions the one with the greatest total weight (matching rare/unique lines such as signatures
 * instead of braces and blanks) wins. Remaining ties go to the first candidate found scanning the
 * first sequence ascending (and, per row, the second sequence descending), so output is deterministic.
 */

export interface Match {
  a: number;
  b: number;
  len: number;
}

/** Regions with more equal-line pairs than this are split by Hirschberg before the sparse search. */
export const MAX_SPARSE_POINTS = 8_000_000;

const MATCH_BASE = 2 ** 32;
const WEIGHT_SCALE = 1024;

function sparseLcs(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  posB: Map<number, number[]>,
  points: number,
  weight: Float64Array,
  out: Match[],
): void {
  const m = b1 - b0;
  const bitS = new Float64Array(m + 1);
  const bitN = new Int32Array(m + 1).fill(-1);
  const prev = new Int32Array(points);
  const nodeI = new Int32Array(points);
  const nodeJ = new Int32Array(points);
  let count = 0;
  for (let i = a0; i < a1; i++) {
    const list = posB.get(a[i]);
    if (!list) continue;
    const w = MATCH_BASE + weight[a[i]];
    for (let k = list.length - 1; k >= 0; k--) {
      const j = list[k] - b0;
      let s = 0;
      let n = -1;
      for (let x = j; x > 0; x -= x & -x) {
        if (bitS[x] > s) {
          s = bitS[x];
          n = bitN[x];
        }
      }
      const id = count++;
      prev[id] = n;
      nodeI[id] = i;
      nodeJ[id] = j;
      const ns = s + w;
      for (let x = j + 1; x <= m; x += x & -x) {
        if (ns > bitS[x]) {
          bitS[x] = ns;
          bitN[x] = id;
        }
      }
    }
  }
  let best = -1;
  let bs = 0;
  for (let x = m; x > 0; x -= x & -x) {
    if (bitS[x] > bs) {
      bs = bitS[x];
      best = bitN[x];
    }
  }
  for (let n = best; n >= 0; n = prev[n]) out.push({ a: nodeI[n], b: b0 + nodeJ[n], len: 1 });
}

/** Best weighted score row of a[ra..rb) (forward) or reversed, against every prefix/suffix of b[b0..b1). */
function scoreRow(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  ra: number,
  rb: number,
  b0: number,
  b1: number,
  weight: Float64Array,
  forward: boolean,
): Float64Array {
  const m = b1 - b0;
  let prevRow = new Float64Array(m + 1);
  let cur = new Float64Array(m + 1);
  const rows = rb - ra;
  for (let r = 0; r < rows; r++) {
    const av = forward ? a[ra + r] : a[rb - 1 - r];
    const w = MATCH_BASE + weight[av];
    cur[0] = 0;
    for (let j = 1; j <= m; j++) {
      const bv = forward ? b[b0 + j - 1] : b[b1 - j];
      cur[j] = av === bv ? prevRow[j - 1] + w : Math.max(prevRow[j], cur[j - 1]);
    }
    const t = prevRow;
    prevRow = cur;
    cur = t;
  }
  return prevRow;
}

/** Returns maximal, ordered, non-overlapping matching runs of an exact LCS. Deterministic. */
export function matchSequences(a: ArrayLike<number>, b: ArrayLike<number>): Match[] {
  let maxId = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > maxId) maxId = a[i];
  for (let i = 0; i < b.length; i++) if (b[i] > maxId) maxId = b[i];
  const ca = new Int32Array(maxId + 1);
  const cb = new Int32Array(maxId + 1);
  for (let i = 0; i < a.length; i++) ca[a[i]]++;
  for (let i = 0; i < b.length; i++) cb[b[i]]++;
  const weight = new Float64Array(maxId + 1);
  for (let v = 0; v <= maxId; v++) {
    const rarity = Math.max(ca[v], cb[v], 1);
    weight[v] = Math.max(1, Math.floor(WEIGHT_SCALE / rarity));
  }

  const raw: Match[] = [];
  const stack: number[][] = [[0, a.length, 0, b.length]];
  while (stack.length) {
    const [ra0, ra1, rb0, rb1] = stack.pop()!;
    let a0 = ra0;
    let b0 = rb0;
    let a1 = ra1;
    let b1 = rb1;
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
      a0++;
      b0++;
    }
    if (a0 > ra0) raw.push({ a: ra0, b: rb0, len: a0 - ra0 });
    while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) {
      a1--;
      b1--;
    }
    if (a1 < ra1) raw.push({ a: a1, b: b1, len: ra1 - a1 });
    if (a0 >= a1 || b0 >= b1) continue;

    const posB = new Map<number, number[]>();
    for (let j = b0; j < b1; j++) {
      const l = posB.get(b[j]);
      if (l) l.push(j);
      else posB.set(b[j], [j]);
    }
    let points = 0;
    for (let i = a0; i < a1; i++) points += posB.get(a[i])?.length ?? 0;
    if (points === 0) continue;

    if (points <= MAX_SPARSE_POINTS || a1 - a0 < 2 || b1 - b0 < 2) {
      sparseLcs(a, b, a0, a1, b0, b1, posB, points, weight, raw);
      continue;
    }
    const mid = (a0 + a1) >> 1;
    const fwd = scoreRow(a, b, a0, mid, b0, b1, weight, true);
    const bwd = scoreRow(a, b, mid, a1, b0, b1, weight, false);
    const m = b1 - b0;
    let k = 0;
    let bestScore = -1;
    for (let j = 0; j <= m; j++) {
      const s = fwd[j] + bwd[m - j];
      if (s > bestScore) {
        bestScore = s;
        k = j;
      }
    }
    stack.push([a0, mid, b0, b0 + k]);
    stack.push([mid, a1, b0 + k, b1]);
  }
  raw.sort((x, y) => x.a - y.a);
  const out: Match[] = [];
  for (const m of raw) {
    const last = out[out.length - 1];
    if (last && last.a + last.len === m.a && last.b + last.len === m.b) last.len += m.len;
    else out.push({ ...m });
  }
  return out;
}
