import path from "node:path";

import { getProjectRoot } from "./project.js";
import { evaluateBenchmark } from "./scoring.js";
import { createSolver } from "./solver.js";

interface ScoreOptions {
  benchmarkPath: string;
  showLosses: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): ScoreOptions {
  const projectRoot = getProjectRoot();
  const options: ScoreOptions = {
    benchmarkPath: path.join(projectRoot, "bench", "eval.json"),
    showLosses: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    const next = argv[i + 1];
    if (arg === "--benchmark" && next) {
      options.benchmarkPath = path.resolve(next);
      i += 1;
    } else if (arg === "--show-losses") {
      options.showLosses = true;
    } else if (arg === "--json") {
      options.json = true;
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
  console.error("Usage: pnpm score [--benchmark PATH] [--show-losses] [--json]");
  process.exit(code);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const solver = createSolver();
  const summary = evaluateBenchmark(options.benchmarkPath, solver);

  if (options.json) {
    const output = options.showLosses ? summary : { ...summary, failedCases: [] };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`benchmark: ${summary.benchmark}`);
  console.log(`solver: ${summary.solver}`);
  console.log(`games: ${summary.games}`);
  console.log(`wins: ${summary.wins}`);
  console.log(`losses: ${summary.losses}`);
  console.log(`stalled: ${summary.stalled}`);
  console.log(`win_rate: ${summary.winRate.toFixed(6)}`);
  console.log(`progress_score: ${summary.progressScore.toFixed(6)}`);
  console.log(`avg_steps: ${summary.avgSteps.toFixed(2)}`);
  console.log(`elapsed_ms: ${summary.elapsedMs.toFixed(1)}`);
  console.log("---");

  for (const suite of summary.suites) {
    console.log(
      `suite ${suite.suite}: games=${suite.games} wins=${suite.wins} stalled=${suite.stalled} win_rate=${suite.winRate.toFixed(6)} progress_score=${suite.progressScore.toFixed(6)}`,
    );
  }

  if (options.showLosses && summary.failedCases.length > 0) {
    console.log("---");
    for (const failedCase of summary.failedCases) {
      console.log(
        `${failedCase.id} suite=${failedCase.suite} seed=${failedCase.seed} status=${failedCase.status} progress=${failedCase.progressScore.toFixed(4)} steps=${failedCase.steps}`,
      );
    }
  }
}

main();
