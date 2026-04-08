import type { CellView, GameView, Move, Solver } from "./types.js";

interface ClueConstraint {
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

function firstHiddenNeighbor(cells: CellView[]): CellView | null {
  for (const cell of cells) {
    if (!cell.revealed && !cell.flagged) {
      return cell;
    }
  }
  return null;
}

function firstHiddenCell(view: GameView): Move | null {
  for (const row of view.board) {
    for (const cell of row) {
      if (!cell.revealed && !cell.flagged) {
        return {
          kind: "reveal",
          x: cell.x,
          y: cell.y,
          reason: "guess first hidden cell",
        };
      }
    }
  }
  return null;
}

function cellKey(cell: Pick<CellView, "x" | "y">): string {
  return `${cell.x},${cell.y}`;
}

function collectClueConstraints(view: GameView): ClueConstraint[] {
  const constraints: ClueConstraint[] = [];

  for (const row of view.board) {
    for (const cell of row) {
      if (!cell.revealed || cell.adjacentMines === null || cell.adjacentMines === 0) {
        continue;
      }

      const around = neighbors(view, cell.x, cell.y);
      const hidden = around.filter((neighbor) => !neighbor.revealed && !neighbor.flagged);
      if (hidden.length === 0) {
        continue;
      }

      const flagged = around.filter((neighbor) => neighbor.flagged).length;
      const minesLeft = cell.adjacentMines - flagged;

      if (minesLeft <= 0 || minesLeft >= hidden.length) {
        continue;
      }

      constraints.push({
        cell,
        hidden,
        hiddenKeys: new Set(hidden.map((neighbor) => cellKey(neighbor))),
        minesLeft,
      });
    }
  }

  return constraints;
}

function findPairwiseInferenceMove(view: GameView): Move | null {
  const constraints = collectClueConstraints(view);

  for (let leftIndex = 0; leftIndex < constraints.length; leftIndex += 1) {
    const leftConstraint = constraints[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < constraints.length; rightIndex += 1) {
      const rightConstraint = constraints[rightIndex]!;
      const leftOnly = leftConstraint.hidden.filter(
        (cell) => !rightConstraint.hiddenKeys.has(cellKey(cell)),
      );
      const rightOnly = rightConstraint.hidden.filter(
        (cell) => !leftConstraint.hiddenKeys.has(cellKey(cell)),
      );
      if (leftOnly.length === 0 && rightOnly.length === 0) {
        continue;
      }

      const minesDelta = leftConstraint.minesLeft - rightConstraint.minesLeft;

      if (minesDelta === leftOnly.length) {
        const target = firstHiddenNeighbor(rightOnly);
        if (target) {
          return {
            kind: "reveal",
            x: target.x,
            y: target.y,
            reason: `pairwise-safe from clues ${leftConstraint.cell.x},${leftConstraint.cell.y} and ${rightConstraint.cell.x},${rightConstraint.cell.y}`,
          };
        }

        const mine = firstHiddenNeighbor(leftOnly);
        if (mine) {
          return {
            kind: "flag",
            x: mine.x,
            y: mine.y,
            reason: `pairwise-mine from clues ${leftConstraint.cell.x},${leftConstraint.cell.y} and ${rightConstraint.cell.x},${rightConstraint.cell.y}`,
          };
        }
      }

      if (-minesDelta === rightOnly.length) {
        const target = firstHiddenNeighbor(leftOnly);
        if (target) {
          return {
            kind: "reveal",
            x: target.x,
            y: target.y,
            reason: `pairwise-safe from clues ${leftConstraint.cell.x},${leftConstraint.cell.y} and ${rightConstraint.cell.x},${rightConstraint.cell.y}`,
          };
        }

        const mine = firstHiddenNeighbor(rightOnly);
        if (mine) {
          return {
            kind: "flag",
            x: mine.x,
            y: mine.y,
            reason: `pairwise-mine from clues ${leftConstraint.cell.x},${leftConstraint.cell.y} and ${rightConstraint.cell.x},${rightConstraint.cell.y}`,
          };
        }
      }
    }
  }

  return null;
}

export class BaselineSolver implements Solver {
  readonly name = "baseline-direct-rules";

  nextMove(view: GameView): Move | null {
    if (view.revealedCount === 0) {
      return chooseCenter(view);
    }

    for (const row of view.board) {
      for (const cell of row) {
        if (!cell.revealed || cell.adjacentMines === null || cell.adjacentMines === 0) {
          continue;
        }

        const around = neighbors(view, cell.x, cell.y);
        const hidden = around.filter((neighbor) => !neighbor.revealed && !neighbor.flagged);
        if (hidden.length === 0) {
          continue;
        }

        const flagged = around.filter((neighbor) => neighbor.flagged).length;
        const minesLeft = cell.adjacentMines - flagged;

        if (minesLeft === 0) {
          const target = firstHiddenNeighbor(hidden);
          if (target) {
            return {
              kind: "reveal",
              x: target.x,
              y: target.y,
              reason: `safe from clue ${cell.x},${cell.y}`,
            };
          }
        }

        if (minesLeft === hidden.length) {
          const target = firstHiddenNeighbor(hidden);
          if (target) {
            return {
              kind: "flag",
              x: target.x,
              y: target.y,
              reason: `forced mine from clue ${cell.x},${cell.y}`,
            };
          }
        }
      }
    }

    const pairwiseMove = findPairwiseInferenceMove(view);
    if (pairwiseMove) {
      return pairwiseMove;
    }

    return firstHiddenCell(view);
  }
}

export function createSolver(): Solver {
  return new BaselineSolver();
}
