import type { CellView, GameView, Move, Solver } from "./types.js";

interface ClueConstraint {
  cell: CellView;
  hidden: CellView[];
  hiddenKeys: Set<string>;
  minesLeft: number;
}

interface FrontierComponent {
  cells: CellView[];
  constraints: ClueConstraint[];
}

interface ExactComponentAnalysis {
  cells: CellView[];
  mineCounts: number[];
  mineCountsByTotal: number[][];
  solutionCount: number;
  solutionCountsByTotal: number[];
}

interface MoveCandidate {
  cell: CellView;
  reason: string;
}

interface GuessCandidate extends MoveCandidate {
  risk: number;
}

interface GlobalExactRiskAnalysis {
  frontierRiskByKey: Map<string, number>;
  offFrontierRisk: number | null;
}

const MAX_EXACT_COMPONENT_CELLS = 18;
const MAX_EXACT_SEARCH_NODES = 200_000;
const RISK_EPSILON = 1e-9;

function combinationCount(total: number, selected: number): number {
  if (selected < 0 || selected > total) {
    return 0;
  }

  const k = Math.min(selected, total - selected);
  let result = 1;

  for (let index = 1; index <= k; index += 1) {
    result = (result * (total - k + index)) / index;
  }

  return result;
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

function hiddenCells(view: GameView): CellView[] {
  const result: CellView[] = [];
  for (const row of view.board) {
    for (const cell of row) {
      if (!cell.revealed && !cell.flagged) {
        result.push(cell);
      }
    }
  }
  return result;
}

function cellKey(cell: Pick<CellView, "x" | "y">): string {
  return `${cell.x},${cell.y}`;
}

function countHiddenNeighbors(view: GameView, cell: CellView): number {
  return neighbors(view, cell.x, cell.y).filter((neighbor) => !neighbor.revealed && !neighbor.flagged)
    .length;
}

function distanceToCenter(view: GameView, cell: CellView): number {
  const centerX = (view.width - 1) / 2;
  const centerY = (view.height - 1) / 2;
  return Math.abs(cell.x - centerX) + Math.abs(cell.y - centerY);
}

function preferCell(view: GameView, current: CellView | null, candidate: CellView): CellView {
  if (!current) {
    return candidate;
  }

  const candidateHiddenNeighbors = countHiddenNeighbors(view, candidate);
  const currentHiddenNeighbors = countHiddenNeighbors(view, current);
  if (candidateHiddenNeighbors !== currentHiddenNeighbors) {
    return candidateHiddenNeighbors > currentHiddenNeighbors ? candidate : current;
  }

  const candidateDistance = distanceToCenter(view, candidate);
  const currentDistance = distanceToCenter(view, current);
  if (candidateDistance !== currentDistance) {
    return candidateDistance < currentDistance ? candidate : current;
  }

  if (candidate.y !== current.y) {
    return candidate.y < current.y ? candidate : current;
  }

  return candidate.x < current.x ? candidate : current;
}

function preferMoveCandidate(
  view: GameView,
  current: MoveCandidate | null,
  candidate: MoveCandidate,
): MoveCandidate {
  if (!current) {
    return candidate;
  }

  return preferCell(view, current.cell, candidate.cell) === candidate.cell ? candidate : current;
}

function preferGuessCandidate(
  view: GameView,
  current: GuessCandidate | null,
  candidate: GuessCandidate,
): GuessCandidate {
  if (!current) {
    return candidate;
  }

  if (candidate.risk < current.risk - RISK_EPSILON) {
    return candidate;
  }

  if (candidate.risk > current.risk + RISK_EPSILON) {
    return current;
  }

  return preferCell(view, current.cell, candidate.cell) === candidate.cell ? candidate : current;
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

function buildFrontierComponents(constraints: ClueConstraint[]): FrontierComponent[] {
  const cellToConstraintIndexes = new Map<string, number[]>();
  const cellsByKey = new Map<string, CellView>();

  for (let constraintIndex = 0; constraintIndex < constraints.length; constraintIndex += 1) {
    const constraint = constraints[constraintIndex]!;
    for (const cell of constraint.hidden) {
      const key = cellKey(cell);
      cellsByKey.set(key, cell);

      const linkedIndexes = cellToConstraintIndexes.get(key);
      if (linkedIndexes) {
        linkedIndexes.push(constraintIndex);
      } else {
        cellToConstraintIndexes.set(key, [constraintIndex]);
      }
    }
  }

  const seenConstraints = new Set<number>();
  const seenCells = new Set<string>();
  const components: FrontierComponent[] = [];

  for (let startIndex = 0; startIndex < constraints.length; startIndex += 1) {
    if (seenConstraints.has(startIndex)) {
      continue;
    }

    const pending = [startIndex];
    const componentConstraints: ClueConstraint[] = [];
    const componentCells: CellView[] = [];
    seenConstraints.add(startIndex);

    while (pending.length > 0) {
      const constraintIndex = pending.pop()!;
      const constraint = constraints[constraintIndex]!;
      componentConstraints.push(constraint);

      for (const cell of constraint.hidden) {
        const key = cellKey(cell);
        if (!seenCells.has(key)) {
          seenCells.add(key);
          componentCells.push(cellsByKey.get(key)!);
        }

        const linkedIndexes = cellToConstraintIndexes.get(key) ?? [];
        for (const linkedIndex of linkedIndexes) {
          if (!seenConstraints.has(linkedIndex)) {
            seenConstraints.add(linkedIndex);
            pending.push(linkedIndex);
          }
        }
      }
    }

    components.push({
      cells: componentCells,
      constraints: componentConstraints,
    });
  }

  return components;
}

function analyzeComponentExactly(component: FrontierComponent): ExactComponentAnalysis | null {
  if (component.cells.length === 0 || component.cells.length > MAX_EXACT_COMPONENT_CELLS) {
    return null;
  }

  const constraintMemberships = new Map<string, number[]>();
  for (let constraintIndex = 0; constraintIndex < component.constraints.length; constraintIndex += 1) {
    const constraint = component.constraints[constraintIndex]!;
    for (const cell of constraint.hidden) {
      const key = cellKey(cell);
      const memberships = constraintMemberships.get(key);
      if (memberships) {
        memberships.push(constraintIndex);
      } else {
        constraintMemberships.set(key, [constraintIndex]);
      }
    }
  }

  const orderedCells = [...component.cells].sort((left, right) => {
    const leftDegree = constraintMemberships.get(cellKey(left))?.length ?? 0;
    const rightDegree = constraintMemberships.get(cellKey(right))?.length ?? 0;
    if (leftDegree !== rightDegree) {
      return rightDegree - leftDegree;
    }

    if (left.y !== right.y) {
      return left.y - right.y;
    }

    return left.x - right.x;
  });

  const cellIndexes = new Map<string, number>();
  orderedCells.forEach((cell, index) => {
    cellIndexes.set(cellKey(cell), index);
  });

  const cellConstraintIndexes = orderedCells.map(() => [] as number[]);
  const constraintRemainingCells = component.constraints.map((constraint) => constraint.hidden.length);
  const constraintRemainingMines = component.constraints.map((constraint) => constraint.minesLeft);

  for (let constraintIndex = 0; constraintIndex < component.constraints.length; constraintIndex += 1) {
    const constraint = component.constraints[constraintIndex]!;
    for (const cell of constraint.hidden) {
      const cellIndex = cellIndexes.get(cellKey(cell));
      if (cellIndex === undefined) {
        continue;
      }

      cellConstraintIndexes[cellIndex]!.push(constraintIndex);
    }
  }

  const assignment = orderedCells.map(() => false);
  const mineCounts = orderedCells.map(() => 0);
  const mineCountsByTotal = orderedCells.map(() => Array(orderedCells.length + 1).fill(0));
  let solutionCount = 0;
  const solutionCountsByTotal = Array(orderedCells.length + 1).fill(0);
  let searchNodes = 0;
  let aborted = false;

  function search(cellIndex: number, assignedMines: number): void {
    if (aborted) {
      return;
    }

    if (cellIndex === orderedCells.length) {
      for (const remainingMines of constraintRemainingMines) {
        if (remainingMines !== 0) {
          return;
        }
      }

      solutionCount += 1;
      solutionCountsByTotal[assignedMines]! += 1;
      for (let index = 0; index < assignment.length; index += 1) {
        if (assignment[index]) {
          mineCounts[index]! += 1;
          mineCountsByTotal[index]![assignedMines]! += 1;
        }
      }
      return;
    }

    searchNodes += 1;
    if (searchNodes > MAX_EXACT_SEARCH_NODES) {
      aborted = true;
      return;
    }

    branch(cellIndex, assignedMines, false);
    branch(cellIndex, assignedMines, true);
  }

  function branch(cellIndex: number, assignedMines: number, isMine: boolean): void {
    const relatedConstraints = cellConstraintIndexes[cellIndex]!;
    for (const constraintIndex of relatedConstraints) {
      constraintRemainingCells[constraintIndex]! -= 1;
      if (isMine) {
        constraintRemainingMines[constraintIndex]! -= 1;
      }
    }

    let valid = true;
    for (const constraintIndex of relatedConstraints) {
      const remainingCells = constraintRemainingCells[constraintIndex]!;
      const remainingMines = constraintRemainingMines[constraintIndex]!;
      if (remainingMines < 0 || remainingMines > remainingCells) {
        valid = false;
        break;
      }
    }

    if (valid) {
      assignment[cellIndex] = isMine;
      search(cellIndex + 1, assignedMines + (isMine ? 1 : 0));
      assignment[cellIndex] = false;
    }

    for (const constraintIndex of relatedConstraints) {
      constraintRemainingCells[constraintIndex]! += 1;
      if (isMine) {
        constraintRemainingMines[constraintIndex]! += 1;
      }
    }
  }

  search(0, 0);

  if (aborted || solutionCount === 0) {
    return null;
  }

  return {
    cells: orderedCells,
    mineCounts,
    mineCountsByTotal,
    solutionCount,
    solutionCountsByTotal,
  };
}

function combineExactAnalysesWithMineBudget(
  analyses: ExactComponentAnalysis[],
  remainingMines: number,
  offFrontierCount: number,
): GlobalExactRiskAnalysis | null {
  if (analyses.length === 0) {
    return null;
  }

  const totalCells =
    analyses.reduce((sum, analysis) => sum + analysis.cells.length, 0) + offFrontierCount;
  const boundedRemainingMines = Math.max(0, Math.min(remainingMines, totalCells));
  const offFrontierWaysByMines = Array.from(
    { length: boundedRemainingMines + 1 },
    (_, mines) => combinationCount(offFrontierCount, mines),
  );

  const prefixWays = Array.from({ length: analyses.length + 1 }, () =>
    Array(boundedRemainingMines + 1).fill(0),
  );
  prefixWays[0]![0] = 1;

  for (let analysisIndex = 0; analysisIndex < analyses.length; analysisIndex += 1) {
    const analysis = analyses[analysisIndex]!;
    for (let usedMines = 0; usedMines <= boundedRemainingMines; usedMines += 1) {
      const baseWays = prefixWays[analysisIndex]![usedMines]!;
      if (baseWays === 0) {
        continue;
      }

      const maxComponentMines = Math.min(
        analysis.solutionCountsByTotal.length - 1,
        boundedRemainingMines - usedMines,
      );
      for (let componentMines = 0; componentMines <= maxComponentMines; componentMines += 1) {
        const componentWays = analysis.solutionCountsByTotal[componentMines]!;
        if (componentWays === 0) {
          continue;
        }

        prefixWays[analysisIndex + 1]![usedMines + componentMines]! += baseWays * componentWays;
      }
    }
  }

  const suffixWays = Array.from({ length: analyses.length + 1 }, () =>
    Array(boundedRemainingMines + 1).fill(0),
  );
  suffixWays[analyses.length]![0] = 1;

  for (let analysisIndex = analyses.length - 1; analysisIndex >= 0; analysisIndex -= 1) {
    const analysis = analyses[analysisIndex]!;
    for (let usedMines = 0; usedMines <= boundedRemainingMines; usedMines += 1) {
      const baseWays = suffixWays[analysisIndex + 1]![usedMines]!;
      if (baseWays === 0) {
        continue;
      }

      const maxComponentMines = Math.min(
        analysis.solutionCountsByTotal.length - 1,
        boundedRemainingMines - usedMines,
      );
      for (let componentMines = 0; componentMines <= maxComponentMines; componentMines += 1) {
        const componentWays = analysis.solutionCountsByTotal[componentMines]!;
        if (componentWays === 0) {
          continue;
        }

        suffixWays[analysisIndex]![usedMines + componentMines]! += baseWays * componentWays;
      }
    }
  }

  let totalWeightedSolutions = 0;
  let offFrontierMineWeight = 0;

  for (let frontierMines = 0; frontierMines <= boundedRemainingMines; frontierMines += 1) {
    const frontierWays = prefixWays[analyses.length]![frontierMines]!;
    const offFrontierMines = boundedRemainingMines - frontierMines;
    const offFrontierWays = offFrontierWaysByMines[offFrontierMines] ?? 0;
    if (frontierWays === 0 || offFrontierWays === 0) {
      continue;
    }

    const weightedWays = frontierWays * offFrontierWays;
    totalWeightedSolutions += weightedWays;
    offFrontierMineWeight += weightedWays * offFrontierMines;
  }

  if (totalWeightedSolutions === 0) {
    return null;
  }

  const frontierRiskByKey = new Map<string, number>();

  for (let analysisIndex = 0; analysisIndex < analyses.length; analysisIndex += 1) {
    const analysis = analyses[analysisIndex]!;
    const otherWaysByTotal = Array(boundedRemainingMines + 1).fill(0);

    for (let leftMines = 0; leftMines <= boundedRemainingMines; leftMines += 1) {
      const leftWays = prefixWays[analysisIndex]![leftMines]!;
      if (leftWays === 0) {
        continue;
      }

      for (let rightMines = 0; leftMines + rightMines <= boundedRemainingMines; rightMines += 1) {
        const rightWays = suffixWays[analysisIndex + 1]![rightMines]!;
        if (rightWays === 0) {
          continue;
        }

        otherWaysByTotal[leftMines + rightMines]! += leftWays * rightWays;
      }
    }

    const totalWeightByComponentMineTotal = Array(analysis.solutionCountsByTotal.length).fill(0);
    for (
      let componentMines = 0;
      componentMines < analysis.solutionCountsByTotal.length;
      componentMines += 1
    ) {
      if (analysis.solutionCountsByTotal[componentMines] === 0) {
        continue;
      }

      let componentWeight = 0;
      for (
        let otherMines = 0;
        otherMines + componentMines <= boundedRemainingMines;
        otherMines += 1
      ) {
        const otherWays = otherWaysByTotal[otherMines]!;
        const offFrontierMines = boundedRemainingMines - otherMines - componentMines;
        const offFrontierWays = offFrontierWaysByMines[offFrontierMines] ?? 0;
        if (otherWays === 0 || offFrontierWays === 0) {
          continue;
        }

        componentWeight += otherWays * offFrontierWays;
      }

      totalWeightByComponentMineTotal[componentMines] = componentWeight;
    }

    for (let cellIndex = 0; cellIndex < analysis.cells.length; cellIndex += 1) {
      let mineWeight = 0;
      const cellMineCountsByTotal = analysis.mineCountsByTotal[cellIndex]!;

      for (
        let componentMines = 0;
        componentMines < cellMineCountsByTotal.length;
        componentMines += 1
      ) {
        const cellMineCount = cellMineCountsByTotal[componentMines]!;
        const componentWeight = totalWeightByComponentMineTotal[componentMines]!;
        if (cellMineCount === 0 || componentWeight === 0) {
          continue;
        }

        mineWeight += cellMineCount * componentWeight;
      }

      frontierRiskByKey.set(cellKey(analysis.cells[cellIndex]!), mineWeight / totalWeightedSolutions);
    }
  }

  return {
    frontierRiskByKey,
    offFrontierRisk:
      offFrontierCount > 0 ? offFrontierMineWeight / (totalWeightedSolutions * offFrontierCount) : null,
  };
}

function chooseRiskBasedMove(view: GameView): Move | null {
  const unresolved = hiddenCells(view);
  if (unresolved.length === 0) {
    return null;
  }

  const constraints = collectClueConstraints(view);
  const frontierCellsByKey = new Map<string, CellView>();
  const frontierRiskByKey = new Map<string, number>();

  for (const constraint of constraints) {
    const localRisk = constraint.minesLeft / constraint.hidden.length;
    for (const cell of constraint.hidden) {
      const key = cellKey(cell);
      frontierCellsByKey.set(key, cell);

      const currentRisk = frontierRiskByKey.get(key);
      if (currentRisk === undefined || localRisk > currentRisk) {
        frontierRiskByKey.set(key, localRisk);
      }
    }
  }

  let forcedSafe: MoveCandidate | null = null;
  let forcedMine: MoveCandidate | null = null;
  const components = buildFrontierComponents(constraints);
  const exactAnalyses: ExactComponentAnalysis[] = [];
  let allComponentsExact = true;

  for (const component of components) {
    const analysis = analyzeComponentExactly(component);
    if (!analysis) {
      allComponentsExact = false;
      continue;
    }

    exactAnalyses.push(analysis);

    for (let index = 0; index < analysis.cells.length; index += 1) {
      const cell = analysis.cells[index]!;
      const mineCount = analysis.mineCounts[index]!;
      const key = cellKey(cell);
      const risk = mineCount / analysis.solutionCount;

      frontierCellsByKey.set(key, cell);
      frontierRiskByKey.set(key, risk);

      if (mineCount === 0) {
        forcedSafe = preferMoveCandidate(view, forcedSafe, {
          cell,
          reason: `exact-safe from ${analysis.solutionCount} frontier solutions`,
        });
        continue;
      }

      if (mineCount === analysis.solutionCount) {
        forcedMine = preferMoveCandidate(view, forcedMine, {
          cell,
          reason: `exact-mine from ${analysis.solutionCount} frontier solutions`,
        });
      }
    }
  }

  let backgroundRisk = Math.min(1, Math.max(0, view.remainingMinesEstimate / unresolved.length));

  if (allComponentsExact && components.length > 0) {
    const globalExact = combineExactAnalysesWithMineBudget(
      exactAnalyses,
      view.remainingMinesEstimate,
      unresolved.length - frontierCellsByKey.size,
    );

    if (globalExact) {
      backgroundRisk = globalExact.offFrontierRisk ?? backgroundRisk;

      for (const [key, risk] of globalExact.frontierRiskByKey) {
        frontierRiskByKey.set(key, risk);

        const cell = frontierCellsByKey.get(key);
        if (!cell) {
          continue;
        }

        if (risk <= RISK_EPSILON) {
          forcedSafe = preferMoveCandidate(view, forcedSafe, {
            cell,
            reason: "global-safe from exact frontier mine budgeting",
          });
        } else if (risk >= 1 - RISK_EPSILON) {
          forcedMine = preferMoveCandidate(view, forcedMine, {
            cell,
            reason: "global-mine from exact frontier mine budgeting",
          });
        }
      }

      if (globalExact.offFrontierRisk !== null) {
        for (const cell of unresolved) {
          if (frontierRiskByKey.has(cellKey(cell))) {
            continue;
          }

          if (globalExact.offFrontierRisk <= RISK_EPSILON) {
            forcedSafe = preferMoveCandidate(view, forcedSafe, {
              cell,
              reason: "global-safe off frontier from exact mine budgeting",
            });
          } else if (globalExact.offFrontierRisk >= 1 - RISK_EPSILON) {
            forcedMine = preferMoveCandidate(view, forcedMine, {
              cell,
              reason: "global-mine off frontier from exact mine budgeting",
            });
          }
        }
      }
    }
  }

  if (forcedSafe) {
    return {
      kind: "reveal",
      x: forcedSafe.cell.x,
      y: forcedSafe.cell.y,
      reason: forcedSafe.reason,
    };
  }

  if (forcedMine) {
    return {
      kind: "flag",
      x: forcedMine.cell.x,
      y: forcedMine.cell.y,
      reason: forcedMine.reason,
    };
  }

  let bestGuess: GuessCandidate | null = null;

  for (const [key, risk] of frontierRiskByKey) {
    const cell = frontierCellsByKey.get(key);
    if (!cell) {
      continue;
    }

    bestGuess = preferGuessCandidate(view, bestGuess, {
      cell,
      risk,
      reason: `guess frontier risk ${risk.toFixed(3)}`,
    });
  }

  for (const cell of unresolved) {
    if (frontierRiskByKey.has(cellKey(cell))) {
      continue;
    }

    bestGuess = preferGuessCandidate(view, bestGuess, {
      cell,
      risk: backgroundRisk,
      reason: `guess global risk ${backgroundRisk.toFixed(3)}`,
    });
  }

  if (!bestGuess) {
    return null;
  }

  return {
    kind: "reveal",
    x: bestGuess.cell.x,
    y: bestGuess.cell.y,
    reason: bestGuess.reason,
  };
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

    return chooseRiskBasedMove(view);
  }
}

export function createSolver(): Solver {
  return new BaselineSolver();
}
