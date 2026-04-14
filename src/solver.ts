import type { CellView, GameView, Move, Solver, SolverContext } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function key(x: number, y: number): string {
  return `${x},${y}`;
}

function getNeighbors(view: GameView, x: number, y: number): CellView[] {
  const result: CellView[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < view.width && ny < view.height) {
        result.push(view.board[ny]![nx]!);
      }
    }
  }
  return result;
}

// ── Constraint types ─────────────────────────────────────────────────────────

interface Constraint {
  cells: string[];
  minesLeft: number;
}

interface IndexedConstraint {
  indices: number[];
  minesLeft: number;
}

// ── CSP Enumerator with MCV ordering and incremental constraint tracking ─────

class CSPEnumerator {
  private readonly n: number;
  private readonly cellList: string[];
  private readonly constraints: IndexedConstraint[];
  private readonly varConstraints: number[][];
  private readonly assignment: Int8Array;
  private readonly cMinesSoFar: Int32Array;
  private readonly cUnassigned: Int32Array;
  private readonly maxMines: number;
  // MCV ordering: order[depth] = variable index to assign at that depth
  private readonly order: Int32Array;
  private readonly depthOf: Int32Array; // inverse: depthOf[varIdx] = depth
  private readonly assigned: Uint8Array;

  readonly mineCountDist = new Map<number, number>();
  readonly perCellMineCounts = new Map<number, Map<string, number>>();

  constructor(cellList: string[], constraints: IndexedConstraint[], maxMines: number) {
    this.n = cellList.length;
    this.cellList = cellList;
    this.constraints = constraints;
    this.maxMines = maxMines;
    this.assignment = new Int8Array(this.n).fill(-1);
    this.assigned = new Uint8Array(this.n);
    this.cMinesSoFar = new Int32Array(constraints.length);
    this.cUnassigned = new Int32Array(constraints.length);

    for (let ci = 0; ci < constraints.length; ci++) {
      this.cUnassigned[ci] = constraints[ci]!.indices.length;
    }

    this.varConstraints = Array.from({ length: this.n }, () => []);
    for (let ci = 0; ci < constraints.length; ci++) {
      for (const vi of constraints[ci]!.indices) {
        this.varConstraints[vi]!.push(ci);
      }
    }

    // BFS ordering along constraint graph edges from most-constrained start
    // This ensures adjacent variables are assigned together, maximizing pruning
    this.order = new Int32Array(this.n);
    this.depthOf = new Int32Array(this.n);

    // Build adjacency: two vars are adjacent if they share a constraint
    const adjList: Set<number>[] = Array.from({ length: this.n }, () => new Set());
    for (const c of constraints) {
      for (let i = 0; i < c.indices.length; i++) {
        for (let j = i + 1; j < c.indices.length; j++) {
          adjList[c.indices[i]!]!.add(c.indices[j]!);
          adjList[c.indices[j]!]!.add(c.indices[i]!);
        }
      }
    }

    // Start BFS from the most-constrained variable
    let startVar = 0;
    let maxConstraints = 0;
    for (let vi = 0; vi < this.n; vi++) {
      if (this.varConstraints[vi]!.length > maxConstraints) {
        maxConstraints = this.varConstraints[vi]!.length;
        startVar = vi;
      }
    }

    const visited = new Uint8Array(this.n);
    const queue: number[] = [startVar];
    visited[startVar] = 1;
    let depth = 0;

    while (queue.length > 0) {
      const vi = queue.shift()!;
      this.order[depth] = vi;
      this.depthOf[vi] = depth;
      depth++;

      // Add unvisited neighbors, sorted by constraint count (most first)
      const unvisited: number[] = [];
      for (const adj of adjList[vi]!) {
        if (!visited[adj]) {
          visited[adj] = 1;
          unvisited.push(adj);
        }
      }
      unvisited.sort((a, b) => this.varConstraints[b]!.length - this.varConstraints[a]!.length);
      queue.push(...unvisited);
    }

    // Add any disconnected variables at the end
    for (let vi = 0; vi < this.n; vi++) {
      if (!visited[vi]) {
        this.order[depth] = vi;
        this.depthOf[vi] = depth;
        depth++;
      }
    }
  }

  enumerate(): void {
    this.backtrack(0, 0);
  }

  private backtrack(depth: number, minesUsed: number): void {
    if (depth === this.n) {
      for (let ci = 0; ci < this.constraints.length; ci++) {
        if (this.cMinesSoFar[ci] !== this.constraints[ci]!.minesLeft) return;
      }
      this.recordSolution(minesUsed);
      return;
    }

    const varIdx = this.order[depth]!;

    // Try safe (0)
    if (this.canAssign(varIdx, 0)) {
      this.assign(varIdx, 0);
      this.backtrack(depth + 1, minesUsed);
      this.unassign(varIdx, 0);
    }

    // Try mine (1)
    if (minesUsed < this.maxMines && this.canAssign(varIdx, 1)) {
      this.assign(varIdx, 1);
      this.backtrack(depth + 1, minesUsed + 1);
      this.unassign(varIdx, 1);
    }
  }

  private canAssign(varIdx: number, value: number): boolean {
    for (const ci of this.varConstraints[varIdx]!) {
      const c = this.constraints[ci]!;
      const newMines = this.cMinesSoFar[ci]! + value;
      const newUnassigned = this.cUnassigned[ci]! - 1;

      if (newMines > c.minesLeft) return false;
      if (c.minesLeft - newMines > newUnassigned) return false;
    }
    return true;
  }

  private assign(varIdx: number, value: number): void {
    this.assignment[varIdx] = value;
    this.assigned[varIdx] = 1;
    for (const ci of this.varConstraints[varIdx]!) {
      this.cMinesSoFar[ci]! += value;
      this.cUnassigned[ci]!--;
    }
  }

  private unassign(varIdx: number, value: number): void {
    this.assignment[varIdx] = -1;
    this.assigned[varIdx] = 0;
    for (const ci of this.varConstraints[varIdx]!) {
      this.cMinesSoFar[ci]! -= value;
      this.cUnassigned[ci]!++;
    }
  }

  private recordSolution(minesUsed: number): void {
    this.mineCountDist.set(minesUsed, (this.mineCountDist.get(minesUsed) || 0) + 1);
    let perCell = this.perCellMineCounts.get(minesUsed);
    if (!perCell) {
      perCell = new Map();
      this.perCellMineCounts.set(minesUsed, perCell);
    }
    for (let i = 0; i < this.n; i++) {
      if (this.assignment[i] === 1) {
        const k = this.cellList[i]!;
        perCell.set(k, (perCell.get(k) || 0) + 1);
      }
    }
  }
}

// ── Advanced Solver ──────────────────────────────────────────────────────────

export class AdvancedSolver implements Solver {
  readonly name = "csp-probability-solver";
  private moveQueue: Move[] = [];

  nextMove(view: GameView): Move | null {
    if (this.moveQueue.length > 0) {
      return this.moveQueue.shift()!;
    }

    if (view.revealedCount === 0) {
      return {
        kind: "reveal",
        x: Math.floor(view.width / 2),
        y: Math.floor(view.height / 2),
        reason: "open center",
      };
    }

    // Phase 1: Single-cell deductions
    const deterministic = this.singleCellDeductions(view);
    if (deterministic.length > 0) {
      this.moveQueue.push(...deterministic.slice(1));
      return deterministic[0]!;
    }

    // Phase 2: CSP enumeration + probability guessing
    const cspMoves = this.cspSolve(view);
    if (cspMoves.length > 0) {
      this.moveQueue.push(...cspMoves.slice(1));
      return cspMoves[0]!;
    }

    return this.firstHiddenCell(view);
  }

  private singleCellDeductions(view: GameView): Move[] {
    const moves: Move[] = [];
    const seen = new Set<string>();

    for (const row of view.board) {
      for (const cell of row) {
        if (!cell.revealed || cell.adjacentMines === null || cell.adjacentMines === 0) continue;

        const around = getNeighbors(view, cell.x, cell.y);
        const hidden = around.filter(c => !c.revealed && !c.flagged);
        if (hidden.length === 0) continue;

        const flagged = around.filter(c => c.flagged).length;
        const minesLeft = cell.adjacentMines - flagged;

        if (minesLeft === 0) {
          for (const h of hidden) {
            const k = key(h.x, h.y);
            if (!seen.has(k)) {
              seen.add(k);
              moves.push({ kind: "reveal", x: h.x, y: h.y, reason: `safe from ${cell.x},${cell.y}` });
            }
          }
        } else if (minesLeft === hidden.length) {
          for (const h of hidden) {
            const k = key(h.x, h.y);
            if (!seen.has(k)) {
              seen.add(k);
              moves.push({ kind: "flag", x: h.x, y: h.y, reason: `mine from ${cell.x},${cell.y}` });
            }
          }
        }
      }
    }

    return moves;
  }

  private cspSolve(view: GameView): Move[] {
    // Build constraints
    const constraints: Constraint[] = [];
    const frontierSet = new Set<string>();

    for (const row of view.board) {
      for (const cell of row) {
        if (!cell.revealed || cell.adjacentMines === null || cell.adjacentMines === 0) continue;
        const around = getNeighbors(view, cell.x, cell.y);
        const hidden = around.filter(c => !c.revealed && !c.flagged);
        if (hidden.length === 0) continue;
        const flagged = around.filter(c => c.flagged).length;
        const minesLeft = cell.adjacentMines - flagged;
        const cellKeys = hidden.map(c => key(c.x, c.y));
        cellKeys.forEach(k => frontierSet.add(k));
        constraints.push({ cells: cellKeys, minesLeft });
      }
    }

    if (frontierSet.size === 0) return [];

    // Build frontier cell list
    const frontierCells: { key: string; x: number; y: number }[] = [];
    const keyToCoord = new Map<string, { x: number; y: number }>();
    for (const row of view.board) {
      for (const cell of row) {
        const k = key(cell.x, cell.y);
        if (frontierSet.has(k)) {
          frontierCells.push({ key: k, x: cell.x, y: cell.y });
          keyToCoord.set(k, { x: cell.x, y: cell.y });
        }
      }
    }

    let totalHidden = 0;
    for (const row of view.board) {
      for (const cell of row) {
        if (!cell.revealed && !cell.flagged) totalHidden++;
      }
    }
    const nonFrontierCount = totalHidden - frontierCells.length;
    const totalMinesLeft = view.remainingMinesEstimate;

    // Decompose into connected components
    const components = this.findComponents(frontierCells, constraints);

    // Enumerate components (full CSP - subsumes subset deductions)
    type CompResult = {
      cells: string[];
      mineCountDist: Map<number, number>;
      perCellMineCounts: Map<number, Map<string, number>>;
    };

    const componentResults: CompResult[] = [];

    for (const comp of components) {
      const compConstraints = constraints.filter(c =>
        c.cells.some(k => comp.cellSet.has(k))
      );

      // With MCV ordering + incremental tracking, we can handle larger components
      if (comp.cells.length > 60) {
        // Fall back to subset deductions for large components
        const subMoves = this.subsetDeductions(compConstraints, keyToCoord);
        if (subMoves.length > 0) return subMoves;
        continue;
      }

      const cellList = comp.cells;
      const cellIndex = new Map<string, number>();
      cellList.forEach((k, i) => cellIndex.set(k, i));

      const indexedConstraints: IndexedConstraint[] = compConstraints.map(c => ({
        indices: c.cells.filter(k => cellIndex.has(k)).map(k => cellIndex.get(k)!),
        minesLeft: c.minesLeft,
      }));

      const enumerator = new CSPEnumerator(
        cellList,
        indexedConstraints,
        Math.min(cellList.length, totalMinesLeft),
      );
      enumerator.enumerate();

      componentResults.push({
        cells: cellList,
        mineCountDist: enumerator.mineCountDist,
        perCellMineCounts: enumerator.perCellMineCounts,
      });
    }

    if (componentResults.length === 0) return [];

    // Combine components with global mine constraint using prefix/suffix DP
    const compCount = componentResults.length;
    const compDists = componentResults.map(cr => {
      const dist: { mineCount: number; solCount: number }[] = [];
      for (const [mc, sc] of cr.mineCountDist) {
        dist.push({ mineCount: mc, solCount: sc });
      }
      return dist;
    });

    // Build prefix DP
    const prefixDp: Map<number, number>[] = [];
    {
      let cur = new Map<number, number>();
      cur.set(0, 1);
      prefixDp.push(new Map(cur));
      for (let ci = 0; ci < compCount; ci++) {
        const next = new Map<number, number>();
        for (const [prevMines, prevWeight] of cur) {
          for (const { mineCount, solCount } of compDists[ci]!) {
            const total = prevMines + mineCount;
            if (total > totalMinesLeft) continue;
            next.set(total, (next.get(total) || 0) + prevWeight * solCount);
          }
        }
        cur = next;
        prefixDp.push(new Map(cur));
      }
    }

    // Build suffix DP
    const suffixDp: Map<number, number>[] = new Array(compCount + 1);
    {
      let cur = new Map<number, number>();
      cur.set(0, 1);
      suffixDp[compCount] = new Map(cur);
      for (let ci = compCount - 1; ci >= 0; ci--) {
        const next = new Map<number, number>();
        for (const [prevMines, prevWeight] of cur) {
          for (const { mineCount, solCount } of compDists[ci]!) {
            const total = prevMines + mineCount;
            if (total > totalMinesLeft) continue;
            next.set(total, (next.get(total) || 0) + prevWeight * solCount);
          }
        }
        cur = next;
        suffixDp[ci] = new Map(cur);
      }
    }

    // Compute total weight (with global mine constraint)
    let totalWeight = 0;
    const finalDp = prefixDp[compCount]!;
    for (const [m, w] of finalDp) {
      const nfMines = totalMinesLeft - m;
      if (nfMines >= 0 && nfMines <= nonFrontierCount) {
        totalWeight += w * Math.exp(logCombination(nonFrontierCount, nfMines));
      }
    }

    if (totalWeight === 0) return [];

    // Compute per-cell mine probability
    const cellProb = new Map<string, number>();

    for (let ci = 0; ci < compCount; ci++) {
      const cr = componentResults[ci]!;
      const prefix = prefixDp[ci]!;
      const suffix = suffixDp[ci + 1]!;

      for (const { mineCount, solCount } of compDists[ci]!) {
        const perCell = cr.perCellMineCounts.get(mineCount);

        for (const [prefixMines, prefixWeight] of prefix) {
          for (const [suffixMines, suffixWeight] of suffix) {
            const frontierTotal = prefixMines + mineCount + suffixMines;
            const nfMines = totalMinesLeft - frontierTotal;
            if (nfMines < 0 || nfMines > nonFrontierCount) continue;

            const combW = Math.exp(logCombination(nonFrontierCount, nfMines));
            const totalW = prefixWeight * solCount * suffixWeight * combW;

            if (perCell) {
              for (const cellKey of cr.cells) {
                const cellMineCount = perCell.get(cellKey) || 0;
                const cellW = totalW * (cellMineCount / solCount);
                cellProb.set(cellKey, (cellProb.get(cellKey) || 0) + cellW);
              }
            }
          }
        }
      }
    }

    // Normalize
    for (const [k, v] of cellProb) {
      cellProb.set(k, v / totalWeight);
    }

    // Non-frontier mine probability
    let nonFrontierProb = 1;
    if (nonFrontierCount > 0) {
      let expectedNfMines = 0;
      for (const [m, w] of finalDp) {
        const nfMines = totalMinesLeft - m;
        if (nfMines >= 0 && nfMines <= nonFrontierCount) {
          const combW = Math.exp(logCombination(nonFrontierCount, nfMines));
          expectedNfMines += nfMines * (w * combW / totalWeight);
        }
      }
      nonFrontierProb = expectedNfMines / nonFrontierCount;
    }

    // Find deterministic cells
    const moves: Move[] = [];
    for (const fc of frontierCells) {
      const prob = cellProb.get(fc.key) ?? 0;
      if (prob < 1e-9) {
        moves.push({ kind: "reveal", x: fc.x, y: fc.y, reason: `csp safe (p=${prob.toFixed(4)})` });
      } else if (prob > 1 - 1e-9) {
        moves.push({ kind: "flag", x: fc.x, y: fc.y, reason: `csp mine (p=${prob.toFixed(4)})` });
      }
    }

    if (moves.length > 0) return moves;

    // No deterministic moves - pick best guess with info-gain tie-breaking
    // Collect all candidates with their probabilities
    type Candidate = { x: number; y: number; prob: number; infoScore: number };
    const candidates: Candidate[] = [];

    for (const fc of frontierCells) {
      const prob = cellProb.get(fc.key) ?? 0;
      // Info score: prefer cells adjacent to more hidden cells (flood potential)
      // and cells adjacent to more numbered revealed cells (constraint activation)
      const nbrs = getNeighbors(view, fc.x, fc.y);
      let hiddenNeighbors = 0;
      let revealedNumbered = 0;
      for (const n of nbrs) {
        if (!n.revealed && !n.flagged) hiddenNeighbors++;
        if (n.revealed && n.adjacentMines !== null && n.adjacentMines > 0) revealedNumbered++;
      }
      // Prefer more hidden neighbors (more flood potential if safe)
      // and more revealed numbered neighbors (more constraints to propagate)
      const infoScore = hiddenNeighbors + revealedNumbered;
      candidates.push({ x: fc.x, y: fc.y, prob, infoScore });
    }

    // Sort: lowest probability first, then highest info score for ties
    candidates.sort((a, b) => {
      const pDiff = a.prob - b.prob;
      if (Math.abs(pDiff) > 1e-6) return pDiff;
      return b.infoScore - a.infoScore;
    });

    const bestCandidate = candidates[0];

    // Check non-frontier
    if (bestCandidate && nonFrontierCount > 0 && nonFrontierProb < bestCandidate.prob) {
      const nfCell = this.bestNonFrontierCell(view, frontierSet);
      if (nfCell) {
        return [{ kind: "reveal", x: nfCell.x, y: nfCell.y, reason: `guess nf (p=${nonFrontierProb.toFixed(4)})` }];
      }
    }

    if (bestCandidate) {
      return [{ kind: "reveal", x: bestCandidate.x, y: bestCandidate.y, reason: `guess (p=${bestCandidate.prob.toFixed(4)})` }];
    }

    return [];
  }

  private subsetDeductions(
    constraints: Constraint[],
    keyToCoord: Map<string, { x: number; y: number }>,
  ): Move[] {
    const moves: Move[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < constraints.length; i++) {
      for (let j = 0; j < constraints.length; j++) {
        if (i === j) continue;
        const ci = constraints[i]!;
        const cj = constraints[j]!;
        if (ci.cells.length >= cj.cells.length) continue; // subset must be smaller

        const cjSet = new Set(cj.cells);
        if (!ci.cells.every(k => cjSet.has(k))) continue;

        const diffCells = cj.cells.filter(k => !new Set(ci.cells).has(k));
        const diffMines = cj.minesLeft - ci.minesLeft;

        if (diffMines === 0) {
          for (const k of diffCells) {
            if (!seen.has(k)) {
              seen.add(k);
              const coord = keyToCoord.get(k)!;
              moves.push({ kind: "reveal", x: coord.x, y: coord.y, reason: "subset safe" });
            }
          }
        } else if (diffMines === diffCells.length) {
          for (const k of diffCells) {
            if (!seen.has(k)) {
              seen.add(k);
              const coord = keyToCoord.get(k)!;
              moves.push({ kind: "flag", x: coord.x, y: coord.y, reason: "subset mine" });
            }
          }
        }
      }
    }

    return moves;
  }

  private findComponents(
    cells: { key: string; x: number; y: number }[],
    constraints: Constraint[],
  ): { cells: string[]; cellSet: Set<string> }[] {
    const parent = new Map<string, string>();
    const rank = new Map<string, number>();

    for (const c of cells) {
      parent.set(c.key, c.key);
      rank.set(c.key, 0);
    }

    const find = (a: string): string => {
      while (parent.get(a) !== a) {
        parent.set(a, parent.get(parent.get(a)!)!);
        a = parent.get(a)!;
      }
      return a;
    };

    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;
      const rankA = rank.get(ra)!;
      const rankB = rank.get(rb)!;
      if (rankA < rankB) parent.set(ra, rb);
      else if (rankA > rankB) parent.set(rb, ra);
      else { parent.set(rb, ra); rank.set(ra, rankA + 1); }
    };

    for (const c of constraints) {
      for (let i = 1; i < c.cells.length; i++) {
        if (parent.has(c.cells[0]!) && parent.has(c.cells[i]!)) {
          union(c.cells[0]!, c.cells[i]!);
        }
      }
    }

    const groups = new Map<string, string[]>();
    for (const c of cells) {
      const root = find(c.key);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(c.key);
    }

    return Array.from(groups.values()).map(cellKeys => ({
      cells: cellKeys,
      cellSet: new Set(cellKeys),
    }));
  }

  private bestNonFrontierCell(
    view: GameView,
    frontierSet: Set<string>,
  ): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestScore = -1;

    for (const row of view.board) {
      for (const cell of row) {
        if (cell.revealed || cell.flagged) continue;
        if (frontierSet.has(key(cell.x, cell.y))) continue;

        const isEdgeX = cell.x === 0 || cell.x === view.width - 1;
        const isEdgeY = cell.y === 0 || cell.y === view.height - 1;
        let score = 1;
        if (isEdgeX && isEdgeY) score = 3;
        else if (isEdgeX || isEdgeY) score = 2;

        if (score > bestScore) {
          bestScore = score;
          best = { x: cell.x, y: cell.y };
        }
      }
    }

    return best;
  }

  private firstHiddenCell(view: GameView): Move | null {
    for (const row of view.board) {
      for (const cell of row) {
        if (!cell.revealed && !cell.flagged) {
          return { kind: "reveal", x: cell.x, y: cell.y, reason: "fallback guess" };
        }
      }
    }
    return null;
  }
}

function logCombination(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  if (k === 0 || k === n) return 0;
  if (k > n - k) k = n - k;
  let result = 0;
  for (let i = 0; i < k; i++) {
    result += Math.log(n - i) - Math.log(i + 1);
  }
  return result;
}

export function createSolver(_context: SolverContext): Solver {
  return new AdvancedSolver();
}
