/**
 * Hungarian (Kuhn–Munkres) assignment.
 *
 * Solves: given N items and M slots and a cost for every pairing, find the
 * one-to-one assignment minimising total cost. O(n³), guaranteed optimal.
 *
 * Needed because per-item greedy choice has no global view. Assigning each
 * shooting burst its own best-scoring shade independently produced a state that
 * is physically impossible — two bursts both claiming "It's All For You" while
 * "I'll Be Right Back" went unclaimed, when the swatcher demonstrably shot each
 * shade once. Hungarian forbids that by construction: it will accept a slightly
 * worse choice for one burst when that frees a much better global total.
 *
 * This is the Jonker-Volgenant style shortest-augmenting-path formulation with
 * potentials, which requires rows <= cols; `solveAssignment` pads for you.
 */

/** Cost matrix rows→cols, rows.length <= cols.length. Returns row→col index. */
function hungarianCore(cost: number[][]): number[] {
  const n = cost.length;
  const m = cost[0].length;
  const INF = Infinity;

  // 1-indexed working arrays; index 0 is the sentinel the algorithm needs.
  const u = new Array<number>(n + 1).fill(0); // row potentials
  const v = new Array<number>(m + 1).fill(0); // column potentials
  const p = new Array<number>(m + 1).fill(0); // p[j] = row currently matched to column j
  const way = new Array<number>(m + 1).fill(0); // predecessor columns on the augmenting path

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(INF);
    const used = new Array<boolean>(m + 1).fill(false);

    // Grow a shortest augmenting path from row i until it reaches a free column.
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      // Re-weight so the path stays tight; this is what keeps it O(n³).
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);

    // Walk the path back, flipping matches.
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const rowToCol = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j] > 0) rowToCol[p[j] - 1] = j - 1;
  return rowToCol;
}

/**
 * Maximise total SCORE with a one-to-one assignment.
 *
 * Pass a score matrix (higher is better) — it is negated internally. Handles
 * any shape by padding with zero-score dummies; padded pairings come back as -1.
 */
export function solveAssignment(score: number[][]): number[] {
  const n = score.length;
  if (!n) return [];
  const m = score[0].length;
  const size = Math.max(n, m);

  const cost: number[][] = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => (i < n && j < m ? -score[i][j] : 0)),
  );

  const res = hungarianCore(cost);
  return res.slice(0, n).map((c) => (c >= 0 && c < m ? c : -1));
}
