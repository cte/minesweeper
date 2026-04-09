import type { CellView, GameView, Move, Solver, SolverContext } from "./types.js";

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

interface GroupedCellAnalysis {
  cells: CellView[];
  mineCount: number;
  mineCountsByTotal: number[];
}

interface GroupedComponentAnalysis {
  groups: GroupedCellAnalysis[];
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

interface ComponentMineTotalAnalysis {
  cells: CellView[];
  exactAnalysis: ExactComponentAnalysis | null;
  groupedAnalysis: GroupedComponentAnalysis | null;
  solutionCountsByTotal: number[];
}

interface GlobalMineBudgetAnalysis {
  frontierRiskByKey: Map<string, number>;
  offFrontierRisk: number | null;
  posteriorWeightsByComponent: number[][];
}

const MAX_EXACT_COMPONENT_CELLS = 18;
const MAX_EXACT_COMPONENT_GROUPS = 18;
const MAX_EXACT_SEARCH_NODES = 200_000;
const MAX_COMPONENT_TOTAL_GROUPS = 24;
const MAX_COMPONENT_TOTAL_SEARCH_NODES = 400_000;
const MAX_LOCAL_EXACT_ROOTS = 12;
const APPROXIMATE_BP_ITERATIONS = 8;
const APPROXIMATE_BP_DAMPING = 0.6;
const APPROXIMATE_BP_EPSILON = 1e-6;
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

function clampProbability(probability: number, fallback: number): number {
  const boundedFallback = Math.min(1 - APPROXIMATE_BP_EPSILON, Math.max(APPROXIMATE_BP_EPSILON, fallback));
  if (!Number.isFinite(probability)) {
    return boundedFallback;
  }

  return Math.min(1 - APPROXIMATE_BP_EPSILON, Math.max(APPROXIMATE_BP_EPSILON, probability));
}

function probabilityToLogOdds(probability: number): number {
  return Math.log(probability / (1 - probability));
}

function logOddsToProbability(logOdds: number): number {
  if (logOdds >= 0) {
    const inverse = Math.exp(-logOdds);
    return 1 / (1 + inverse);
  }

  const exponent = Math.exp(logOdds);
  return exponent / (1 + exponent);
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
  if (component.cells.length === 0) {
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

  const groupedCells = new Map<
    string,
    {
      cells: CellView[];
      constraintIndexes: number[];
    }
  >();

  for (const cell of component.cells) {
    const key = cellKey(cell);
    const memberships = [...(constraintMemberships.get(key) ?? [])];
    const signature = memberships.join(",");
    const group = groupedCells.get(signature);

    if (group) {
      group.cells.push(cell);
    } else {
      groupedCells.set(signature, {
        cells: [cell],
        constraintIndexes: memberships,
      });
    }
  }

  if (groupedCells.size > MAX_EXACT_COMPONENT_GROUPS) {
    return null;
  }

  const orderedGroups = [...groupedCells.values()]
    .map((group) => ({
      cells: [...group.cells].sort((left, right) => {
        if (left.y !== right.y) {
          return left.y - right.y;
        }

        return left.x - right.x;
      }),
      constraintIndexes: group.constraintIndexes,
    }))
    .sort((left, right) => {
      if (left.constraintIndexes.length !== right.constraintIndexes.length) {
        return right.constraintIndexes.length - left.constraintIndexes.length;
      }

      if (left.cells.length !== right.cells.length) {
        return left.cells.length - right.cells.length;
      }

      const leftAnchor = left.cells[0]!;
      const rightAnchor = right.cells[0]!;

      if (leftAnchor.y !== rightAnchor.y) {
        return leftAnchor.y - rightAnchor.y;
      }

      return leftAnchor.x - rightAnchor.x;
    });

  const orderedCells = orderedGroups.flatMap((group) => group.cells);
  const groupCellIndexes = orderedGroups.map(() => [] as number[]);
  let orderedCellIndex = 0;
  for (let groupIndex = 0; groupIndex < orderedGroups.length; groupIndex += 1) {
    const group = orderedGroups[groupIndex]!;
    for (let index = 0; index < group.cells.length; index += 1) {
      groupCellIndexes[groupIndex]!.push(orderedCellIndex);
      orderedCellIndex += 1;
    }
  }

  const constraintRemainingCells = component.constraints.map((constraint) => constraint.hidden.length);
  const constraintRemainingMines = component.constraints.map((constraint) => constraint.minesLeft);
  const groupMineCounts = orderedGroups.map(() => 0);
  const mineCounts = orderedCells.map(() => 0);
  const mineCountsByTotal = orderedCells.map(() => Array(orderedCells.length + 1).fill(0));
  let solutionCount = 0;
  const solutionCountsByTotal = Array(orderedCells.length + 1).fill(0);
  let searchNodes = 0;
  let aborted = false;

  function search(groupIndex: number, assignedMines: number, assignmentWeight: number): void {
    if (aborted) {
      return;
    }

    if (groupIndex === orderedGroups.length) {
      for (const remainingMines of constraintRemainingMines) {
        if (remainingMines !== 0) {
          return;
        }
      }

      solutionCount += assignmentWeight;
      solutionCountsByTotal[assignedMines]! += assignmentWeight;

      for (let currentGroupIndex = 0; currentGroupIndex < orderedGroups.length; currentGroupIndex += 1) {
        const group = orderedGroups[currentGroupIndex]!;
        const minesInGroup = groupMineCounts[currentGroupIndex]!;
        if (minesInGroup === 0) {
          continue;
        }

        const cellMineContribution = (assignmentWeight * minesInGroup) / group.cells.length;
        for (const cellIndex of groupCellIndexes[currentGroupIndex]!) {
          mineCounts[cellIndex]! += cellMineContribution;
          mineCountsByTotal[cellIndex]![assignedMines]! += cellMineContribution;
        }
      }
      return;
    }

    const group = orderedGroups[groupIndex]!;
    const relatedConstraints = group.constraintIndexes;
    let minMines = 0;
    let maxMines = group.cells.length;

    for (const constraintIndex of relatedConstraints) {
      const remainingCells = constraintRemainingCells[constraintIndex]!;
      const remainingMines = constraintRemainingMines[constraintIndex]!;
      minMines = Math.max(minMines, remainingMines - (remainingCells - group.cells.length));
      maxMines = Math.min(maxMines, remainingMines);
    }

    if (minMines > maxMines) {
      return;
    }

    for (let minesInGroup = minMines; minesInGroup <= maxMines; minesInGroup += 1) {
      searchNodes += 1;
      if (searchNodes > MAX_EXACT_SEARCH_NODES) {
        aborted = true;
        return;
      }

      for (const constraintIndex of relatedConstraints) {
        constraintRemainingCells[constraintIndex]! -= group.cells.length;
        constraintRemainingMines[constraintIndex]! -= minesInGroup;
      }

      groupMineCounts[groupIndex] = minesInGroup;
      search(
        groupIndex + 1,
        assignedMines + minesInGroup,
        assignmentWeight * combinationCount(group.cells.length, minesInGroup),
      );
      groupMineCounts[groupIndex] = 0;

      for (const constraintIndex of relatedConstraints) {
        constraintRemainingCells[constraintIndex]! += group.cells.length;
        constraintRemainingMines[constraintIndex]! += minesInGroup;
      }
    }
  }

  search(0, 0, 1);

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

function buildLocalExactComponent(
  component: FrontierComponent,
  rootConstraintIndex: number,
): FrontierComponent | null {
  const rootConstraint = component.constraints[rootConstraintIndex]!;
  if (rootConstraint.hidden.length > MAX_EXACT_COMPONENT_CELLS) {
    return null;
  }

  const includedConstraintIndexes = new Set<number>([rootConstraintIndex]);
  const includedCellsByKey = new Map<string, CellView>();

  for (const cell of rootConstraint.hidden) {
    includedCellsByKey.set(cellKey(cell), cell);
  }

  while (true) {
    let bestConstraintIndex: number | null = null;
    let bestOverlap = -1;
    let bestAddedCells = Number.POSITIVE_INFINITY;
    let bestTightness = Number.POSITIVE_INFINITY;
    let bestHiddenCount = Number.POSITIVE_INFINITY;
    let bestY = Number.POSITIVE_INFINITY;
    let bestX = Number.POSITIVE_INFINITY;

    for (let constraintIndex = 0; constraintIndex < component.constraints.length; constraintIndex += 1) {
      if (includedConstraintIndexes.has(constraintIndex)) {
        continue;
      }

      const constraint = component.constraints[constraintIndex]!;
      let overlap = 0;
      let addedCells = 0;

      for (const cell of constraint.hidden) {
        if (includedCellsByKey.has(cellKey(cell))) {
          overlap += 1;
        } else {
          addedCells += 1;
        }
      }

      if (overlap === 0 || includedCellsByKey.size + addedCells > MAX_EXACT_COMPONENT_CELLS) {
        continue;
      }

      const tightness = Math.min(constraint.minesLeft, constraint.hidden.length - constraint.minesLeft);
      const shouldReplace =
        overlap > bestOverlap ||
        (overlap === bestOverlap && addedCells < bestAddedCells) ||
        (overlap === bestOverlap &&
          addedCells === bestAddedCells &&
          tightness < bestTightness) ||
        (overlap === bestOverlap &&
          addedCells === bestAddedCells &&
          tightness === bestTightness &&
          constraint.hidden.length < bestHiddenCount) ||
        (overlap === bestOverlap &&
          addedCells === bestAddedCells &&
          tightness === bestTightness &&
          constraint.hidden.length === bestHiddenCount &&
          constraint.cell.y < bestY) ||
        (overlap === bestOverlap &&
          addedCells === bestAddedCells &&
          tightness === bestTightness &&
          constraint.hidden.length === bestHiddenCount &&
          constraint.cell.y === bestY &&
          constraint.cell.x < bestX);

      if (!shouldReplace) {
        continue;
      }

      bestConstraintIndex = constraintIndex;
      bestOverlap = overlap;
      bestAddedCells = addedCells;
      bestTightness = tightness;
      bestHiddenCount = constraint.hidden.length;
      bestY = constraint.cell.y;
      bestX = constraint.cell.x;
    }

    if (bestConstraintIndex === null) {
      break;
    }

    includedConstraintIndexes.add(bestConstraintIndex);
    for (const cell of component.constraints[bestConstraintIndex]!.hidden) {
      includedCellsByKey.set(cellKey(cell), cell);
    }
  }

  if (includedConstraintIndexes.size < 2) {
    return null;
  }

  const constraints = [...includedConstraintIndexes]
    .sort((left, right) => left - right)
    .map((constraintIndex) => component.constraints[constraintIndex]!);
  const cells = [...includedCellsByKey.values()].sort((left, right) => {
    if (left.y !== right.y) {
      return left.y - right.y;
    }

    return left.x - right.x;
  });

  return {
    cells,
    constraints,
  };
}

function findLocalExactInferenceMoves(
  view: GameView,
  components: FrontierComponent[],
): {
  forcedSafe: MoveCandidate | null;
  forcedMine: MoveCandidate | null;
  riskByKey: Map<string, number>;
} {
  let forcedSafe: MoveCandidate | null = null;
  let forcedMine: MoveCandidate | null = null;
  const weightedRiskByKey = new Map<string, number>();
  const totalRiskWeightByKey = new Map<string, number>();

  for (const component of components) {
    const cellMembershipCounts = new Map<string, number>();
    for (const constraint of component.constraints) {
      for (const cell of constraint.hidden) {
        const key = cellKey(cell);
        cellMembershipCounts.set(key, (cellMembershipCounts.get(key) ?? 0) + 1);
      }
    }

    const rootConstraintIndexes = component.constraints
      .map((constraint, index) => {
        const overlapPotential = constraint.hidden.reduce(
          (sum, cell) => sum + (cellMembershipCounts.get(cellKey(cell)) ?? 1) - 1,
          0,
        );
        const tightness = Math.min(constraint.minesLeft, constraint.hidden.length - constraint.minesLeft);

        return {
          index,
          overlapPotential,
          tightness,
          hiddenCount: constraint.hidden.length,
          x: constraint.cell.x,
          y: constraint.cell.y,
        };
      })
      .sort((left, right) => {
        if (left.overlapPotential !== right.overlapPotential) {
          return right.overlapPotential - left.overlapPotential;
        }

        if (left.tightness !== right.tightness) {
          return left.tightness - right.tightness;
        }

        if (left.hiddenCount !== right.hiddenCount) {
          return left.hiddenCount - right.hiddenCount;
        }

        if (left.y !== right.y) {
          return left.y - right.y;
        }

        return left.x - right.x;
      })
      .slice(0, MAX_LOCAL_EXACT_ROOTS);

    for (const root of rootConstraintIndexes) {
      const localComponent = buildLocalExactComponent(component, root.index);
      if (!localComponent) {
        continue;
      }

      const analysis = analyzeComponentExactly(localComponent);
      if (!analysis) {
        continue;
      }

      const analysisWeight = localComponent.constraints.length * localComponent.cells.length;
      for (let index = 0; index < analysis.cells.length; index += 1) {
        const cell = analysis.cells[index]!;
        const mineCount = analysis.mineCounts[index]!;
        const risk = mineCount / analysis.solutionCount;
        const key = cellKey(cell);

        weightedRiskByKey.set(key, (weightedRiskByKey.get(key) ?? 0) + risk * analysisWeight);
        totalRiskWeightByKey.set(key, (totalRiskWeightByKey.get(key) ?? 0) + analysisWeight);

        if (mineCount === 0) {
          forcedSafe = preferMoveCandidate(view, forcedSafe, {
            cell,
            reason: `local-exact-safe from ${analysis.solutionCount} neighborhood solutions`,
          });
        } else if (mineCount === analysis.solutionCount) {
          forcedMine = preferMoveCandidate(view, forcedMine, {
            cell,
            reason: `local-exact-mine from ${analysis.solutionCount} neighborhood solutions`,
          });
        }
      }
    }
  }

  const riskByKey = new Map<string, number>();
  for (const [key, totalWeight] of totalRiskWeightByKey) {
    if (totalWeight <= 0) {
      continue;
    }

    riskByKey.set(key, (weightedRiskByKey.get(key) ?? 0) / totalWeight);
  }

  return {
    forcedSafe,
    forcedMine,
    riskByKey,
  };
}

function analyzeComponentMineTotals(component: FrontierComponent): GroupedComponentAnalysis | null {
  if (component.cells.length === 0) {
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

  const groupedCells = new Map<
    string,
    {
      cells: CellView[];
      constraintIndexes: number[];
    }
  >();

  for (const cell of component.cells) {
    const key = cellKey(cell);
    const memberships = [...(constraintMemberships.get(key) ?? [])];
    const signature = memberships.join(",");
    const group = groupedCells.get(signature);

    if (group) {
      group.cells.push(cell);
    } else {
      groupedCells.set(signature, {
        cells: [cell],
        constraintIndexes: memberships,
      });
    }
  }

  if (groupedCells.size > MAX_COMPONENT_TOTAL_GROUPS) {
    return null;
  }

  const orderedGroups = [...groupedCells.values()]
    .map((group) => ({
      cells: [...group.cells].sort((left, right) => {
        if (left.y !== right.y) {
          return left.y - right.y;
        }

        return left.x - right.x;
      }),
      constraintIndexes: group.constraintIndexes,
    }))
    .sort((left, right) => {
      if (left.constraintIndexes.length !== right.constraintIndexes.length) {
        return right.constraintIndexes.length - left.constraintIndexes.length;
      }

      if (left.cells.length !== right.cells.length) {
        return left.cells.length - right.cells.length;
      }

      const leftAnchor = left.cells[0]!;
      const rightAnchor = right.cells[0]!;

      if (leftAnchor.y !== rightAnchor.y) {
        return leftAnchor.y - rightAnchor.y;
      }

      return leftAnchor.x - rightAnchor.x;
    });

  const totalCells = orderedGroups.reduce((sum, group) => sum + group.cells.length, 0);
  const constraintRemainingCells = component.constraints.map((constraint) => constraint.hidden.length);
  const constraintRemainingMines = component.constraints.map((constraint) => constraint.minesLeft);
  const groupMineCounts = orderedGroups.map(() => 0);
  const mineCounts = orderedGroups.map(() => 0);
  const mineCountsByTotal = orderedGroups.map(() => Array(totalCells + 1).fill(0));
  const solutionCountsByTotal = Array(totalCells + 1).fill(0);
  let solutionCount = 0;
  let searchNodes = 0;
  let aborted = false;

  function search(groupIndex: number, assignedMines: number, assignmentWeight: number): void {
    if (aborted) {
      return;
    }

    if (groupIndex === orderedGroups.length) {
      for (const remainingMines of constraintRemainingMines) {
        if (remainingMines !== 0) {
          return;
        }
      }

      solutionCount += assignmentWeight;
      solutionCountsByTotal[assignedMines]! += assignmentWeight;

      for (let currentGroupIndex = 0; currentGroupIndex < orderedGroups.length; currentGroupIndex += 1) {
        const minesInGroup = groupMineCounts[currentGroupIndex]!;
        if (minesInGroup === 0) {
          continue;
        }

        const weightedMineCount = assignmentWeight * minesInGroup;
        mineCounts[currentGroupIndex]! += weightedMineCount;
        mineCountsByTotal[currentGroupIndex]![assignedMines]! += weightedMineCount;
      }
      return;
    }

    const group = orderedGroups[groupIndex]!;
    const relatedConstraints = group.constraintIndexes;
    let minMines = 0;
    let maxMines = group.cells.length;

    for (const constraintIndex of relatedConstraints) {
      const remainingCells = constraintRemainingCells[constraintIndex]!;
      const remainingMines = constraintRemainingMines[constraintIndex]!;
      minMines = Math.max(minMines, remainingMines - (remainingCells - group.cells.length));
      maxMines = Math.min(maxMines, remainingMines);
    }

    if (minMines > maxMines) {
      return;
    }

    for (let minesInGroup = minMines; minesInGroup <= maxMines; minesInGroup += 1) {
      searchNodes += 1;
      if (searchNodes > MAX_COMPONENT_TOTAL_SEARCH_NODES) {
        aborted = true;
        return;
      }

      for (const constraintIndex of relatedConstraints) {
        constraintRemainingCells[constraintIndex]! -= group.cells.length;
        constraintRemainingMines[constraintIndex]! -= minesInGroup;
      }

      groupMineCounts[groupIndex] = minesInGroup;
      search(
        groupIndex + 1,
        assignedMines + minesInGroup,
        assignmentWeight * combinationCount(group.cells.length, minesInGroup),
      );
      groupMineCounts[groupIndex] = 0;

      for (const constraintIndex of relatedConstraints) {
        constraintRemainingCells[constraintIndex]! += group.cells.length;
        constraintRemainingMines[constraintIndex]! += minesInGroup;
      }
    }
  }

  search(0, 0, 1);

  if (aborted || solutionCount === 0) {
    return null;
  }

  return {
    groups: orderedGroups.map((group, index) => ({
      cells: group.cells,
      mineCount: mineCounts[index]!,
      mineCountsByTotal: mineCountsByTotal[index]!,
    })),
    solutionCount,
    solutionCountsByTotal,
  };
}

function buildFallbackMineTotalWeights(component: FrontierComponent): number[] {
  const totalCells = component.cells.length;
  let minTotalMines = 0;
  let maxTotalMines = totalCells;

  for (const constraint of component.constraints) {
    minTotalMines = Math.max(minTotalMines, constraint.minesLeft);
    maxTotalMines = Math.min(
      maxTotalMines,
      totalCells - (constraint.hidden.length - constraint.minesLeft),
    );
  }

  const weights = Array(totalCells + 1).fill(0);
  for (let mines = minTotalMines; mines <= maxTotalMines; mines += 1) {
    weights[mines] = combinationCount(totalCells, mines);
  }

  if (weights.some((weight) => weight > 0)) {
    return weights;
  }

  return Array.from({ length: totalCells + 1 }, (_, mines) => combinationCount(totalCells, mines));
}

function estimateComponentRisksByBeliefPropagation(
  component: FrontierComponent,
  defaultRisk: number,
): Map<string, number> {
  const cellIndexesByKey = new Map<string, number>();
  for (let cellIndex = 0; cellIndex < component.cells.length; cellIndex += 1) {
    cellIndexesByKey.set(cellKey(component.cells[cellIndex]!), cellIndex);
  }

  const constraints = component.constraints.map((constraint) => ({
    minesLeft: constraint.minesLeft,
    cellIndexes: constraint.hidden.map((cell) => cellIndexesByKey.get(cellKey(cell))!),
  }));

  const cellMemberships = component.cells.map(() => [] as Array<{ constraintIndex: number; position: number }>);
  const localRiskSums = component.cells.map(() => 0);
  const localRiskCounts = component.cells.map(() => 0);

  for (let constraintIndex = 0; constraintIndex < constraints.length; constraintIndex += 1) {
    const constraint = constraints[constraintIndex]!;
    const localRisk = component.constraints[constraintIndex]!.minesLeft / constraint.cellIndexes.length;

    for (let position = 0; position < constraint.cellIndexes.length; position += 1) {
      const cellIndex = constraint.cellIndexes[position]!;
      cellMemberships[cellIndex]!.push({ constraintIndex, position });
      localRiskSums[cellIndex]! += localRisk;
      localRiskCounts[cellIndex]! += 1;
    }
  }

  const priors = component.cells.map((_, cellIndex) => {
    const localRisk =
      localRiskCounts[cellIndex]! > 0
        ? localRiskSums[cellIndex]! / localRiskCounts[cellIndex]!
        : defaultRisk;
    return clampProbability(localRisk, defaultRisk);
  });

  let variableToConstraint = constraints.map((constraint) =>
    constraint.cellIndexes.map((cellIndex) => priors[cellIndex]!),
  );
  let constraintToVariable = constraints.map((constraint) =>
    constraint.cellIndexes.map((cellIndex) => priors[cellIndex]!),
  );

  for (let iteration = 0; iteration < APPROXIMATE_BP_ITERATIONS; iteration += 1) {
    const nextConstraintToVariable = constraints.map((constraint, constraintIndex) => {
      const incomingMessages = variableToConstraint[constraintIndex]!;

      return constraint.cellIndexes.map((cellIndex, excludedPosition) => {
        const countDistribution = Array(constraint.cellIndexes.length).fill(0);
        countDistribution[0] = 1;
        let processedCells = 0;

        for (let position = 0; position < constraint.cellIndexes.length; position += 1) {
          if (position === excludedPosition) {
            continue;
          }

          const otherCellIndex = constraint.cellIndexes[position]!;
          const mineProbability = clampProbability(incomingMessages[position]!, priors[otherCellIndex]!);
          processedCells += 1;

          for (let mineCount = processedCells; mineCount >= 0; mineCount -= 1) {
            const previousWithoutMine = countDistribution[mineCount] ?? 0;
            const previousWithMine =
              mineCount > 0 ? (countDistribution[mineCount - 1] ?? 0) : 0;
            countDistribution[mineCount] =
              previousWithoutMine * (1 - mineProbability) + previousWithMine * mineProbability;
          }
        }

        const mineWeight =
          constraint.minesLeft > 0 ? (countDistribution[constraint.minesLeft - 1] ?? 0) : 0;
        const safeWeight = countDistribution[constraint.minesLeft] ?? 0;
        const totalWeight = mineWeight + safeWeight;
        if (totalWeight <= 0) {
          return priors[cellIndex]!;
        }

        return clampProbability(mineWeight / totalWeight, priors[cellIndex]!);
      });
    });

    const nextVariableToConstraint = constraints.map((constraint) =>
      constraint.cellIndexes.map((cellIndex) => priors[cellIndex]!),
    );

    for (let cellIndex = 0; cellIndex < component.cells.length; cellIndex += 1) {
      const memberships = cellMemberships[cellIndex]!;
      const priorLogOdds = probabilityToLogOdds(priors[cellIndex]!);
      const incomingLogOdds = memberships.map(({ constraintIndex, position }) =>
        probabilityToLogOdds(nextConstraintToVariable[constraintIndex]![position]!),
      );

      for (let membershipIndex = 0; membershipIndex < memberships.length; membershipIndex += 1) {
        let combinedLogOdds = priorLogOdds;

        for (let incomingIndex = 0; incomingIndex < incomingLogOdds.length; incomingIndex += 1) {
          if (incomingIndex === membershipIndex) {
            continue;
          }

          combinedLogOdds += incomingLogOdds[incomingIndex]!;
        }

        const { constraintIndex, position } = memberships[membershipIndex]!;
        const updatedProbability = clampProbability(
          logOddsToProbability(combinedLogOdds),
          priors[cellIndex]!,
        );
        const previousProbability = variableToConstraint[constraintIndex]![position]!;
        nextVariableToConstraint[constraintIndex]![position] =
          previousProbability * (1 - APPROXIMATE_BP_DAMPING) +
          updatedProbability * APPROXIMATE_BP_DAMPING;
      }
    }

    constraintToVariable = nextConstraintToVariable;
    variableToConstraint = nextVariableToConstraint;
  }

  const riskByKey = new Map<string, number>();
  for (let cellIndex = 0; cellIndex < component.cells.length; cellIndex += 1) {
    let combinedLogOdds = probabilityToLogOdds(priors[cellIndex]!);

    for (const { constraintIndex, position } of cellMemberships[cellIndex]!) {
      combinedLogOdds += probabilityToLogOdds(constraintToVariable[constraintIndex]![position]!);
    }

    riskByKey.set(
      cellKey(component.cells[cellIndex]!),
      clampProbability(logOddsToProbability(combinedLogOdds), priors[cellIndex]!),
    );
  }

  return riskByKey;
}

function combineComponentMineTotalsWithBudget(
  components: ComponentMineTotalAnalysis[],
  remainingMines: number,
  offFrontierCount: number,
): GlobalMineBudgetAnalysis | null {
  if (components.length === 0) {
    return null;
  }

  const totalCells =
    components.reduce((sum, component) => sum + component.cells.length, 0) + offFrontierCount;
  const boundedRemainingMines = Math.max(0, Math.min(remainingMines, totalCells));
  const offFrontierWaysByMines = Array.from(
    { length: boundedRemainingMines + 1 },
    (_, mines) => combinationCount(offFrontierCount, mines),
  );

  const prefixWays = Array.from({ length: components.length + 1 }, () =>
    Array(boundedRemainingMines + 1).fill(0),
  );
  prefixWays[0]![0] = 1;

  for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
    const component = components[componentIndex]!;
    for (let usedMines = 0; usedMines <= boundedRemainingMines; usedMines += 1) {
      const baseWays = prefixWays[componentIndex]![usedMines]!;
      if (baseWays === 0) {
        continue;
      }

      const maxComponentMines = Math.min(
        component.solutionCountsByTotal.length - 1,
        boundedRemainingMines - usedMines,
      );
      for (let componentMines = 0; componentMines <= maxComponentMines; componentMines += 1) {
        const componentWays = component.solutionCountsByTotal[componentMines]!;
        if (componentWays === 0) {
          continue;
        }

        prefixWays[componentIndex + 1]![usedMines + componentMines]! += baseWays * componentWays;
      }
    }
  }

  const suffixWays = Array.from({ length: components.length + 1 }, () =>
    Array(boundedRemainingMines + 1).fill(0),
  );
  suffixWays[components.length]![0] = 1;

  for (let componentIndex = components.length - 1; componentIndex >= 0; componentIndex -= 1) {
    const component = components[componentIndex]!;
    for (let usedMines = 0; usedMines <= boundedRemainingMines; usedMines += 1) {
      const baseWays = suffixWays[componentIndex + 1]![usedMines]!;
      if (baseWays === 0) {
        continue;
      }

      const maxComponentMines = Math.min(
        component.solutionCountsByTotal.length - 1,
        boundedRemainingMines - usedMines,
      );
      for (let componentMines = 0; componentMines <= maxComponentMines; componentMines += 1) {
        const componentWays = component.solutionCountsByTotal[componentMines]!;
        if (componentWays === 0) {
          continue;
        }

        suffixWays[componentIndex]![usedMines + componentMines]! += baseWays * componentWays;
      }
    }
  }

  let totalWeightedSolutions = 0;
  let offFrontierMineWeight = 0;

  for (let frontierMines = 0; frontierMines <= boundedRemainingMines; frontierMines += 1) {
    const frontierWays = prefixWays[components.length]![frontierMines]!;
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
  const posteriorWeightsByComponent = components.map((component) =>
    Array(component.solutionCountsByTotal.length).fill(0),
  );

  for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
    const component = components[componentIndex]!;
    const otherWaysByTotal = Array(boundedRemainingMines + 1).fill(0);

    for (let leftMines = 0; leftMines <= boundedRemainingMines; leftMines += 1) {
      const leftWays = prefixWays[componentIndex]![leftMines]!;
      if (leftWays === 0) {
        continue;
      }

      for (let rightMines = 0; leftMines + rightMines <= boundedRemainingMines; rightMines += 1) {
        const rightWays = suffixWays[componentIndex + 1]![rightMines]!;
        if (rightWays === 0) {
          continue;
        }

        otherWaysByTotal[leftMines + rightMines]! += leftWays * rightWays;
      }
    }

    const totalWeightByComponentMineTotal = Array(component.solutionCountsByTotal.length).fill(0);
    for (
      let componentMines = 0;
      componentMines < component.solutionCountsByTotal.length;
      componentMines += 1
    ) {
      if (component.solutionCountsByTotal[componentMines] === 0) {
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
      posteriorWeightsByComponent[componentIndex]![componentMines] =
        component.solutionCountsByTotal[componentMines]! * componentWeight;
    }

    if (component.exactAnalysis) {
      for (let cellIndex = 0; cellIndex < component.exactAnalysis.cells.length; cellIndex += 1) {
        let mineWeight = 0;
        const cellMineCountsByTotal = component.exactAnalysis.mineCountsByTotal[cellIndex]!;

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

        frontierRiskByKey.set(
          cellKey(component.exactAnalysis.cells[cellIndex]!),
          mineWeight / totalWeightedSolutions,
        );
      }
      continue;
    }

    if (!component.groupedAnalysis) {
      continue;
    }

    for (const group of component.groupedAnalysis.groups) {
      let mineWeight = 0;

      for (let componentMines = 0; componentMines < group.mineCountsByTotal.length; componentMines += 1) {
        const groupMineCount = group.mineCountsByTotal[componentMines]!;
        const componentWeight = totalWeightByComponentMineTotal[componentMines]!;
        if (groupMineCount === 0 || componentWeight === 0) {
          continue;
        }

        mineWeight += groupMineCount * componentWeight;
      }

      const risk = mineWeight / (group.cells.length * totalWeightedSolutions);
      for (const cell of group.cells) {
        frontierRiskByKey.set(cellKey(cell), risk);
      }
    }
  }

  return {
    frontierRiskByKey,
    offFrontierRisk:
      offFrontierCount > 0 ? offFrontierMineWeight / (totalWeightedSolutions * offFrontierCount) : null,
    posteriorWeightsByComponent,
  };
}

function chooseRiskBasedMove(view: GameView): Move | null {
  const unresolved = hiddenCells(view);
  if (unresolved.length === 0) {
    return null;
  }

  const baseBackgroundRisk = Math.min(1, Math.max(0, view.remainingMinesEstimate / unresolved.length));
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
  const directConstraintRiskByKey = new Map(frontierRiskByKey);

  let forcedSafe: MoveCandidate | null = null;
  let forcedMine: MoveCandidate | null = null;
  const components = buildFrontierComponents(constraints);
  const inexactComponents: FrontierComponent[] = [];
  const fallbackRiskEligibleKeys = new Set<string>();
  const mineTotalAnalyses: ComponentMineTotalAnalysis[] = [];
  let localExactRiskByKey = new Map<string, number>();

  for (const component of components) {
    const analysis = analyzeComponentExactly(component);
    if (!analysis) {
      inexactComponents.push(component);
      const groupedAnalysis = analyzeComponentMineTotals(component);
      if (!groupedAnalysis) {
        const approximateRiskByKey = estimateComponentRisksByBeliefPropagation(
          component,
          baseBackgroundRisk,
        );
        for (const cell of component.cells) {
          const key = cellKey(cell);
          fallbackRiskEligibleKeys.add(key);
          frontierRiskByKey.set(key, approximateRiskByKey.get(key) ?? frontierRiskByKey.get(key)!);
        }
      }
      mineTotalAnalyses.push({
        cells: component.cells,
        exactAnalysis: null,
        groupedAnalysis,
        solutionCountsByTotal:
          groupedAnalysis?.solutionCountsByTotal ?? buildFallbackMineTotalWeights(component),
      });

      if (groupedAnalysis) {
        for (const group of groupedAnalysis.groups) {
          const risk = group.mineCount / (groupedAnalysis.solutionCount * group.cells.length);

          for (const cell of group.cells) {
            const key = cellKey(cell);
            frontierCellsByKey.set(key, cell);
            frontierRiskByKey.set(key, risk);

            if (risk <= RISK_EPSILON) {
              forcedSafe = preferMoveCandidate(view, forcedSafe, {
                cell,
                reason: `grouped-safe from ${groupedAnalysis.solutionCount} frontier solutions`,
              });
            } else if (risk >= 1 - RISK_EPSILON) {
              forcedMine = preferMoveCandidate(view, forcedMine, {
                cell,
                reason: `grouped-mine from ${groupedAnalysis.solutionCount} frontier solutions`,
              });
            }
          }
        }
      }
      continue;
    }

    mineTotalAnalyses.push({
      cells: component.cells,
      exactAnalysis: analysis,
      groupedAnalysis: null,
      solutionCountsByTotal: analysis.solutionCountsByTotal,
    });

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

  let backgroundRisk = baseBackgroundRisk;

  const globalBudget = combineComponentMineTotalsWithBudget(
    mineTotalAnalyses,
    view.remainingMinesEstimate,
    unresolved.length - frontierCellsByKey.size,
  );

  if (globalBudget) {
    backgroundRisk = globalBudget.offFrontierRisk ?? backgroundRisk;

    for (const [key, risk] of globalBudget.frontierRiskByKey) {
      frontierRiskByKey.set(key, risk);

      const cell = frontierCellsByKey.get(key);
      if (!cell) {
        continue;
      }

      if (risk <= RISK_EPSILON) {
        forcedSafe = preferMoveCandidate(view, forcedSafe, {
          cell,
          reason: "global-safe from frontier mine budgeting",
        });
      } else if (risk >= 1 - RISK_EPSILON) {
        forcedMine = preferMoveCandidate(view, forcedMine, {
          cell,
          reason: "global-mine from frontier mine budgeting",
        });
      }
    }

    for (let componentIndex = 0; componentIndex < mineTotalAnalyses.length; componentIndex += 1) {
      const componentAnalysis = mineTotalAnalyses[componentIndex]!;
      if (componentAnalysis.exactAnalysis) {
        continue;
      }

      const posteriorWeights = globalBudget.posteriorWeightsByComponent[componentIndex]!;
      let hasZeroTotal = false;
      let hasFullTotal = false;
      let hasIntermediateTotal = false;

      for (let mines = 0; mines < posteriorWeights.length; mines += 1) {
        if (posteriorWeights[mines] === 0) {
          continue;
        }

        if (mines === 0) {
          hasZeroTotal = true;
          continue;
        }

        if (mines === componentAnalysis.cells.length) {
          hasFullTotal = true;
          continue;
        }

        hasIntermediateTotal = true;
        break;
      }

      if (!hasIntermediateTotal && hasZeroTotal && !hasFullTotal) {
        for (const cell of componentAnalysis.cells) {
          forcedSafe = preferMoveCandidate(view, forcedSafe, {
            cell,
            reason: "global-safe whole frontier component from mine budgeting",
          });
        }
      } else if (!hasIntermediateTotal && hasFullTotal && !hasZeroTotal) {
        for (const cell of componentAnalysis.cells) {
          forcedMine = preferMoveCandidate(view, forcedMine, {
            cell,
            reason: "global-mine whole frontier component from mine budgeting",
          });
        }
      }
    }

    if (globalBudget.offFrontierRisk !== null) {
      for (const cell of unresolved) {
        if (frontierRiskByKey.has(cellKey(cell))) {
          continue;
        }

        if (globalBudget.offFrontierRisk <= RISK_EPSILON) {
          forcedSafe = preferMoveCandidate(view, forcedSafe, {
            cell,
            reason: "global-safe off frontier from mine budgeting",
          });
        } else if (globalBudget.offFrontierRisk >= 1 - RISK_EPSILON) {
          forcedMine = preferMoveCandidate(view, forcedMine, {
            cell,
            reason: "global-mine off frontier from mine budgeting",
          });
        }
      }
    }
  }

  if (!forcedSafe && !forcedMine && inexactComponents.length > 0) {
    const localExact = findLocalExactInferenceMoves(view, inexactComponents);
    forcedSafe = localExact.forcedSafe;
    forcedMine = localExact.forcedMine;
    localExactRiskByKey = localExact.riskByKey;
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

    const localExactRisk =
      fallbackRiskEligibleKeys.has(key) && localExactRiskByKey.has(key)
        ? localExactRiskByKey.get(key)!
        : null;
    const directConstraintRisk = fallbackRiskEligibleKeys.has(key)
      ? directConstraintRiskByKey.get(key) ?? null
      : null;
    const effectiveRisk =
      localExactRisk ??
      (directConstraintRisk === null ? risk : risk + (directConstraintRisk - risk) * 0.25);

    bestGuess = preferGuessCandidate(view, bestGuess, {
      cell,
      risk: effectiveRisk,
      reason:
        localExactRisk === null
          ? directConstraintRisk === null
            ? `guess frontier risk ${effectiveRisk.toFixed(3)}`
            : `guess frontier risk ${effectiveRisk.toFixed(3)} with clue guard`
          : `guess local-exact risk ${effectiveRisk.toFixed(3)}`,
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

export function createSolver(_context: SolverContext): Solver {
  return new BaselineSolver();
}
