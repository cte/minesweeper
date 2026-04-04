import type { CellView, GameView, Move, Position, Solver } from "./types.js";

interface ClueState {
  cell: CellView;
  hidden: CellView[];
  hiddenKeys: Set<string>;
  minesLeft: number;
}

function neighbors(view: GameView, x: number, y: number): CellView[] {
  const result: CellView[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < view.width && ny < view.height) {
        result.push(view.board[ny]![nx]!);
      }
    }
  }
  return result;
}

function chooseCenter(view: GameView): Move {
  return {
    kind: "reveal",
    x: Math.floor(view.width / 2),
    y: Math.floor(view.height / 2),
    reason: "open center first",
  };
}

function positionKey(pos: Position): string {
  return `${pos.x},${pos.y}`;
}

function comparePositions(a: Position, b: Position): number {
  return a.y - b.y || a.x - b.x;
}

function pickFirstCell(cells: CellView[]): CellView {
  let best = cells[0]!;
  for (let index = 1; index < cells.length; index += 1) {
    const cell = cells[index]!;
    if (comparePositions(cell, best) < 0) {
      best = cell;
    }
  }
  return best;
}

function findPairwiseOverlapMove(first: ClueState, second: ClueState): Move | null {
  const firstOnly: CellView[] = [];
  const overlap: CellView[] = [];
  for (const cell of first.hidden) {
    if (second.hiddenKeys.has(positionKey(cell))) {
      overlap.push(cell);
    } else {
      firstOnly.push(cell);
    }
  }
  const secondOnly = second.hidden.filter((cell) => !first.hiddenKeys.has(positionKey(cell)));

  const minOverlapMines = Math.max(0, first.minesLeft - firstOnly.length, second.minesLeft - secondOnly.length);
  const maxOverlapMines = Math.min(overlap.length, first.minesLeft, second.minesLeft);
  if (minOverlapMines > maxOverlapMines) {
    return null;
  }

  const firstOnlyMinMines = first.minesLeft - maxOverlapMines;
  const firstOnlyMaxMines = first.minesLeft - minOverlapMines;
  const secondOnlyMinMines = second.minesLeft - maxOverlapMines;
  const secondOnlyMaxMines = second.minesLeft - minOverlapMines;
  const pairLabel = `${first.cell.x},${first.cell.y} & ${second.cell.x},${second.cell.y}`;

  if (firstOnly.length > 0 && firstOnlyMaxMines === 0) {
    const target = pickFirstCell(firstOnly);
    return {
      kind: "reveal",
      x: target.x,
      y: target.y,
      reason: `safe from clue pair ${pairLabel}`,
    };
  }

  if (secondOnly.length > 0 && secondOnlyMaxMines === 0) {
    const target = pickFirstCell(secondOnly);
    return {
      kind: "reveal",
      x: target.x,
      y: target.y,
      reason: `safe from clue pair ${pairLabel}`,
    };
  }

  if (overlap.length > 0 && maxOverlapMines === 0) {
    const target = pickFirstCell(overlap);
    return {
      kind: "reveal",
      x: target.x,
      y: target.y,
      reason: `safe from clue pair ${pairLabel}`,
    };
  }

  if (firstOnly.length > 0 && firstOnlyMinMines === firstOnly.length) {
    const target = pickFirstCell(firstOnly);
    return {
      kind: "flag",
      x: target.x,
      y: target.y,
      reason: `forced mine from clue pair ${pairLabel}`,
    };
  }

  if (secondOnly.length > 0 && secondOnlyMinMines === secondOnly.length) {
    const target = pickFirstCell(secondOnly);
    return {
      kind: "flag",
      x: target.x,
      y: target.y,
      reason: `forced mine from clue pair ${pairLabel}`,
    };
  }

  if (overlap.length > 0 && minOverlapMines === overlap.length) {
    const target = pickFirstCell(overlap);
    return {
      kind: "flag",
      x: target.x,
      y: target.y,
      reason: `forced mine from clue pair ${pairLabel}`,
    };
  }

  return null;
}

function scoreHiddenCell(view: GameView, pos: Position): number {
  const clues = neighbors(view, pos.x, pos.y).filter((cell) => cell.revealed && cell.adjacentMines !== null);
  if (clues.length === 0) {
    return view.remainingMinesEstimate / Math.max(1, view.hiddenCount);
  }

  let totalRisk = 0;
  for (const clue of clues) {
    const clueNeighbors = neighbors(view, clue.x, clue.y);
    const hidden = clueNeighbors.filter((cell) => !cell.revealed && !cell.flagged);
    const flagged = clueNeighbors.filter((cell) => cell.flagged).length;
    const minesLeft = Math.max(0, (clue.adjacentMines ?? 0) - flagged);
    totalRisk += hidden.length === 0 ? 0 : minesLeft / hidden.length;
  }
  return totalRisk / clues.length;
}

export class BaselineSolver implements Solver {
  readonly name = "baseline-rules-plus-risk";

  nextMove(view: GameView): Move | null {
    if (view.revealedCount === 0) {
      return chooseCenter(view);
    }

    const forced = this.findForcedMove(view);
    if (forced) {
      return forced;
    }

    return this.findSafestGuess(view);
  }

  private findForcedMove(view: GameView): Move | null {
    const clueStates: ClueState[] = [];
    for (const row of view.board) {
      for (const cell of row) {
        if (!cell.revealed || cell.adjacentMines === null || cell.adjacentMines === 0) {
          continue;
        }
        const around = neighbors(view, cell.x, cell.y);
        const hidden = around.filter((neighbor) => !neighbor.revealed && !neighbor.flagged);
        const flagged = around.filter((neighbor) => neighbor.flagged).length;
        const minesLeft = cell.adjacentMines - flagged;

        if (hidden.length > 0 && minesLeft === 0) {
          const target = hidden[0]!;
          return {
            kind: "reveal",
            x: target.x,
            y: target.y,
            reason: `safe from clue ${cell.x},${cell.y}`,
          };
        }

        if (hidden.length > 0 && minesLeft === hidden.length) {
          const target = hidden[0]!;
          return {
            kind: "flag",
            x: target.x,
            y: target.y,
            reason: `forced mine from clue ${cell.x},${cell.y}`,
          };
        }

        if (minesLeft > 0 && minesLeft < hidden.length) {
          clueStates.push({
            cell,
            hidden,
            hiddenKeys: new Set(hidden.map((neighbor) => positionKey(neighbor))),
            minesLeft,
          });
        }
      }
    }

    for (let firstIndex = 0; firstIndex < clueStates.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < clueStates.length; secondIndex += 1) {
        const move = findPairwiseOverlapMove(clueStates[firstIndex]!, clueStates[secondIndex]!);
        if (move) {
          return move;
        }
      }
    }
    return null;
  }

  private findSafestGuess(view: GameView): Move | null {
    let best: { move: Move; risk: number } | null = null;
    for (const row of view.board) {
      for (const cell of row) {
        if (cell.revealed || cell.flagged) {
          continue;
        }
        const risk = scoreHiddenCell(view, cell);
        const candidate: Move = {
          kind: "reveal",
          x: cell.x,
          y: cell.y,
          reason: `guess risk=${risk.toFixed(3)}`,
        };
        if (
          best === null ||
          risk < best.risk ||
          (risk === best.risk && (cell.y < best.move.y || (cell.y === best.move.y && cell.x < best.move.x)))
        ) {
          best = { move: candidate, risk };
        }
      }
    }
    return best?.move ?? null;
  }
}

export function createSolver(): Solver {
  return new BaselineSolver();
}
