export type GameStatus = "ready" | "running" | "won" | "lost";

export type MoveKind = "reveal" | "flag" | "unflag";

export interface Position {
  x: number;
  y: number;
}

export interface Move extends Position {
  kind: MoveKind;
  reason?: string;
}

export interface CellView extends Position {
  revealed: boolean;
  flagged: boolean;
  adjacentMines: number | null;
}

export interface GameConfig {
  width: number;
  height: number;
  mines: number;
  seed: string | number;
}

export interface GameView extends GameConfig {
  status: GameStatus;
  step: number;
  remainingMinesEstimate: number;
  revealedCount: number;
  hiddenCount: number;
  board: CellView[][];
}

export interface MoveResult {
  status: GameStatus;
  changed: boolean;
  explodedMine?: Position;
}

export interface Solver {
  readonly name: string;
  nextMove(view: GameView): Move | null;
}
