import { MinesweeperGame } from "./game.js";
import type { GameConfig, GameStatus, GameView, Move, MoveResult, Solver } from "./types.js";

export type RunStatus = Extract<GameStatus, "won" | "lost"> | "stalled";

export interface StepEvent {
  move: Move;
  result: MoveResult;
  view: GameView;
  board: string;
}

export interface RunGameOptions {
  maxSteps?: number;
  onStep?: (event: StepEvent) => void;
}

export interface RunGameSummary extends GameConfig {
  solver: string;
  status: RunStatus;
  won: boolean;
  steps: number;
  revealedCount: number;
  safeCells: number;
  revealedFraction: number;
  lastMove: Move | null;
  board: string;
  boardWithMines: string;
}

export function runGame(config: GameConfig, solver: Solver, options: RunGameOptions = {}): RunGameSummary {
  const maxSteps = options.maxSteps ?? 10_000;
  const game = new MinesweeperGame(config);
  let lastMove: Move | null = null;
  let stalled = false;

  while (game.getStatus() === "ready" || game.getStatus() === "running") {
    const move = solver.nextMove(game.getView());
    if (!move) {
      stalled = true;
      break;
    }
    lastMove = move;
    const result = game.applyMove(move);
    const view = game.getView();
    options.onStep?.({
      move,
      result,
      view,
      board: game.render(),
    });
    if (view.step >= maxSteps) {
      throw new Error(`Exceeded max steps (${maxSteps})`);
    }
  }

  const finalView = game.getView();
  const safeCells = config.width * config.height - config.mines;
  const status: RunStatus = stalled ? "stalled" : (game.getStatus() as Extract<GameStatus, "won" | "lost">);

  return {
    ...config,
    solver: solver.name,
    status,
    won: status === "won",
    steps: finalView.step,
    revealedCount: finalView.revealedCount,
    safeCells,
    revealedFraction: safeCells === 0 ? 0 : finalView.revealedCount / safeCells,
    lastMove,
    board: game.render(),
    boardWithMines: game.render({ revealMines: true }),
  };
}
