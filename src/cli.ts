import { runGame } from "./run-game.js";
import { createSolver } from "./solver.js";
import type { GameConfig, Move } from "./types.js";

interface CliOptions extends GameConfig {
  showSteps: boolean;
  maxSteps: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    width: 9,
    height: 9,
    mines: 10,
    seed: "demo",
    showSteps: false,
    maxSteps: 10_000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    const next = argv[i + 1];
    if (arg === "--width" && next) {
      options.width = Number(next);
      i += 1;
    } else if (arg === "--height" && next) {
      options.height = Number(next);
      i += 1;
    } else if (arg === "--mines" && next) {
      options.mines = Number(next);
      i += 1;
    } else if (arg === "--seed" && next) {
      options.seed = next;
      i += 1;
    } else if (arg === "--max-steps" && next) {
      options.maxSteps = Number(next);
      i += 1;
    } else if (arg === "--show-steps") {
      options.showSteps = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit(0);
    } else {
      printHelpAndExit(1, `Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelpAndExit(code: number, message?: string): never {
  if (message) {
    console.error(message);
    console.error("");
  }
  console.error("Usage: pnpm play [--width N] [--height N] [--mines N] [--seed VALUE] [--show-steps]");
  console.error("Defaults: width=9 height=9 mines=10 seed=demo");
  process.exit(code);
}

function formatMove(move: Move | null): string {
  if (!move) {
    return "no move";
  }
  const detail = move.reason ? ` (${move.reason})` : "";
  return `${move.kind} ${move.x},${move.y}${detail}`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const solver = createSolver();

  if (options.showSteps) {
    console.log(`Starting game ${options.width}x${options.height} with ${options.mines} mines, seed=${options.seed}`);
    const preview = Array.from({ length: options.height }, (_, y) =>
      `${`${y}`.padStart(2, " ")}  ${Array.from({ length: options.width }, () => ".").join(" ")}`,
    );
    console.log(`     ${Array.from({ length: options.width }, (_, x) => `${x}`.padStart(2, " ")).join(" ")}`);
    console.log(preview.join("\n"));
    console.log("");
  }

  let lastMove: Move | null = null;
  const runOptions = options.showSteps
    ? {
        maxSteps: options.maxSteps,
        onStep: (event: { move: Move; result: { status: string }; view: { step: number }; board: string }) => {
          lastMove = event.move;
          console.log(`step ${event.view.step}: ${formatMove(event.move)} -> ${event.result.status}`);
          console.log(event.board);
          console.log("");
        },
      }
    : {
        maxSteps: options.maxSteps,
      };
  const result = runGame(options, solver, runOptions);

  console.log(`solver: ${solver.name}`);
  console.log(`seed: ${options.seed}`);
  console.log(`status: ${result.status}`);
  console.log(`steps: ${result.steps}`);
  console.log(`revealed: ${result.revealedCount}`);
  console.log(`last_move: ${formatMove(lastMove ?? result.lastMove)}`);
  console.log("---");
  console.log(result.boardWithMines);
}

main();
