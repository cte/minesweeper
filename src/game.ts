import { createRng } from "./rng.js";
import type { CellView, GameConfig, GameStatus, GameView, Move, MoveResult, Position } from "./types.js";

interface InternalCell {
  mine: boolean;
  revealed: boolean;
  flagged: boolean;
  adjacentMines: number;
}

const NEIGHBOR_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

function assertInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export class MinesweeperGame {
  private readonly config: GameConfig;
  private readonly rng: () => number;
  private readonly board: InternalCell[][];
  private status: GameStatus = "ready";
  private step = 0;
  private revealedCount = 0;
  private flaggedCount = 0;
  private initialized = false;

  constructor(config: GameConfig) {
    assertInteger("width", config.width);
    assertInteger("height", config.height);
    assertInteger("mines", config.mines);
    if (config.mines >= config.width * config.height) {
      throw new Error("mines must be smaller than the number of cells");
    }
    this.config = { ...config };
    this.rng = createRng(config.seed);
    this.board = Array.from({ length: config.height }, () =>
      Array.from({ length: config.width }, () => ({
        mine: false,
        revealed: false,
        flagged: false,
        adjacentMines: 0,
      })),
    );
  }

  getStatus(): GameStatus {
    return this.status;
  }

  getView(): GameView {
    const viewBoard: CellView[][] = this.board.map((row, y) =>
      row.map((cell, x) => ({
        x,
        y,
        revealed: cell.revealed,
        flagged: cell.flagged,
        adjacentMines: cell.revealed ? cell.adjacentMines : null,
      })),
    );
    return {
      ...this.config,
      status: this.status,
      step: this.step,
      remainingMinesEstimate: Math.max(0, this.config.mines - this.flaggedCount),
      revealedCount: this.revealedCount,
      hiddenCount: this.config.width * this.config.height - this.revealedCount,
      board: viewBoard,
    };
  }

  applyMove(move: Move): MoveResult {
    if (this.status === "won" || this.status === "lost") {
      return { status: this.status, changed: false };
    }
    if (!this.inBounds(move.x, move.y)) {
      throw new Error(`Move out of bounds: (${move.x}, ${move.y})`);
    }
    if (!this.initialized && move.kind === "reveal") {
      this.initializeBoard(move);
    }
    this.step += 1;

    if (move.kind === "reveal") {
      return this.reveal(move.x, move.y);
    }
    if (move.kind === "flag") {
      return this.setFlag(move.x, move.y, true);
    }
    return this.setFlag(move.x, move.y, false);
  }

  render(options?: { revealMines?: boolean }): string {
    const lines: string[] = [];
    const header = ["   "];
    for (let x = 0; x < this.config.width; x += 1) {
      header.push(`${x}`.padStart(2, " "));
    }
    lines.push(header.join(" "));
    for (let y = 0; y < this.config.height; y += 1) {
      const parts = [`${y}`.padStart(2, " "), " "];
      for (let x = 0; x < this.config.width; x += 1) {
        const cell = this.getCell(x, y);
        let symbol = ".";
        if (cell.flagged) {
          symbol = "F";
        } else if (!cell.revealed) {
          symbol = options?.revealMines && cell.mine ? "*" : ".";
        } else if (cell.mine) {
          symbol = "*";
        } else {
          symbol = cell.adjacentMines === 0 ? " " : `${cell.adjacentMines}`;
        }
        parts.push(symbol.padStart(2, " "));
      }
      lines.push(parts.join(""));
    }
    return lines.join("\n");
  }

  private initializeBoard(firstMove: Position): void {
    const protectedCells = new Set<string>();
    protectedCells.add(this.key(firstMove.x, firstMove.y));
    for (const neighbor of this.getNeighbors(firstMove.x, firstMove.y)) {
      protectedCells.add(this.key(neighbor.x, neighbor.y));
    }
    const candidates: Position[] = [];
    for (let y = 0; y < this.config.height; y += 1) {
      for (let x = 0; x < this.config.width; x += 1) {
        if (!protectedCells.has(this.key(x, y))) {
          candidates.push({ x, y });
        }
      }
    }
    if (candidates.length < this.config.mines) {
      throw new Error("Board is too small to guarantee a safe first move");
    }
    for (let i = candidates.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.rng() * (i + 1));
      const temp = candidates[i]!;
      candidates[i] = candidates[j]!;
      candidates[j] = temp;
    }
    for (let i = 0; i < this.config.mines; i += 1) {
      const pos = candidates[i]!;
      this.getCell(pos.x, pos.y).mine = true;
    }
    for (let y = 0; y < this.config.height; y += 1) {
      for (let x = 0; x < this.config.width; x += 1) {
        const cell = this.getCell(x, y);
        cell.adjacentMines = this.getNeighbors(x, y).filter((neighbor) => this.getCell(neighbor.x, neighbor.y).mine).length;
      }
    }
    this.initialized = true;
    this.status = "running";
  }

  private reveal(x: number, y: number): MoveResult {
    const cell = this.getCell(x, y);
    if (cell.revealed || cell.flagged) {
      return { status: this.status, changed: false };
    }
    cell.revealed = true;
    this.revealedCount += 1;
    if (cell.mine) {
      this.status = "lost";
      return { status: this.status, changed: true, explodedMine: { x, y } };
    }
    if (cell.adjacentMines === 0) {
      this.floodReveal(x, y);
    }
    this.updateWinStatus();
    return { status: this.status, changed: true };
  }

  private floodReveal(startX: number, startY: number): void {
    const queue: Position[] = [{ x: startX, y: startY }];
    const seen = new Set<string>([this.key(startX, startY)]);
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      for (const neighbor of this.getNeighbors(current.x, current.y)) {
        const key = this.key(neighbor.x, neighbor.y);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const cell = this.getCell(neighbor.x, neighbor.y);
        if (cell.flagged || cell.revealed || cell.mine) {
          continue;
        }
        cell.revealed = true;
        this.revealedCount += 1;
        if (cell.adjacentMines === 0) {
          queue.push(neighbor);
        }
      }
    }
  }

  private setFlag(x: number, y: number, flagged: boolean): MoveResult {
    const cell = this.getCell(x, y);
    if (cell.revealed || cell.flagged === flagged) {
      return { status: this.status, changed: false };
    }
    cell.flagged = flagged;
    this.flaggedCount += flagged ? 1 : -1;
    return { status: this.status, changed: true };
  }

  private updateWinStatus(): void {
    const safeCells = this.config.width * this.config.height - this.config.mines;
    if (this.revealedCount >= safeCells) {
      this.status = "won";
    }
  }

  private getNeighbors(x: number, y: number): Position[] {
    const neighbors: Position[] = [];
    for (const [dx, dy] of NEIGHBOR_DELTAS) {
      const nx = x + dx;
      const ny = y + dy;
      if (this.inBounds(nx, ny)) {
        neighbors.push({ x: nx, y: ny });
      }
    }
    return neighbors;
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.config.width && y < this.config.height;
  }

  private getCell(x: number, y: number): InternalCell {
    if (!this.inBounds(x, y)) {
      throw new Error(`Cell out of bounds: (${x}, ${y})`);
    }
    return this.board[y]![x]!;
  }

  private key(x: number, y: number): string {
    return `${x},${y}`;
  }
}
