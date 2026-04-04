import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { createSolver } from "./solver.js";
import { getProjectRoot } from "./project.js";
import { appendResultRow, ensureResultsFile, type ResultsRow } from "./results.js";
import { evaluateBenchmark } from "./scoring.js";

interface RecordOptions {
  description: string;
  decision: string;
  outputPath: string;
  skipCheck: boolean;
  skipHoldout: boolean;
  json: boolean;
}

interface GitInfo {
  branch: string;
  commit: string;
  dirty: boolean;
}

function parseArgs(argv: string[]): RecordOptions {
  const projectRoot = getProjectRoot();
  const options: RecordOptions = {
    description: "",
    decision: "recorded",
    outputPath: path.join(projectRoot, "results.tsv"),
    skipCheck: false,
    skipHoldout: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    const next = argv[i + 1];
    if (arg === "--description" && next) {
      options.description = next;
      i += 1;
    } else if (arg === "--decision" && next) {
      options.decision = next;
      i += 1;
    } else if (arg === "--output" && next) {
      options.outputPath = path.resolve(next);
      i += 1;
    } else if (arg === "--skip-check") {
      options.skipCheck = true;
    } else if (arg === "--skip-holdout") {
      options.skipHoldout = true;
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
  console.error("Usage: pnpm record -- --description TEXT [--decision keep] [--skip-check] [--skip-holdout] [--json]");
  process.exit(code);
}

function getGitInfo(projectRoot: string): GitInfo {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    const status = execFileSync("git", ["status", "--short"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    return { branch, commit, dirty: status.length > 0 };
  } catch {
    return { branch: "nogit", commit: "unknown", dirty: false };
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = getProjectRoot();
  const evalBenchmarkPath = path.join(projectRoot, "bench", "eval.json");
  const holdoutBenchmarkPath = path.join(projectRoot, "bench", "holdout.json");

  if (!options.skipCheck) {
    execFileSync("pnpm", ["check"], { cwd: projectRoot, stdio: "inherit" });
  }

  const solver = createSolver();
  const evalSummary = evaluateBenchmark(evalBenchmarkPath, solver);
  const holdoutSummary = options.skipHoldout ? null : evaluateBenchmark(holdoutBenchmarkPath, solver);
  const gitInfo = getGitInfo(projectRoot);

  ensureResultsFile(options.outputPath);

  const row: ResultsRow = {
    timestamp: new Date().toISOString(),
    branch: gitInfo.branch,
    commit: gitInfo.commit,
    dirty: gitInfo.dirty ? "yes" : "no",
    solver: solver.name,
    evalWinRate: evalSummary.winRate.toFixed(6),
    evalProgress: evalSummary.progressScore.toFixed(6),
    evalAvgSteps: evalSummary.avgSteps.toFixed(2),
    holdoutWinRate: holdoutSummary ? holdoutSummary.winRate.toFixed(6) : "",
    holdoutProgress: holdoutSummary ? holdoutSummary.progressScore.toFixed(6) : "",
    holdoutAvgSteps: holdoutSummary ? holdoutSummary.avgSteps.toFixed(2) : "",
    decision: options.decision,
    description: options.description,
  };

  appendResultRow(options.outputPath, row);

  if (options.json) {
    console.log(JSON.stringify({
      outputPath: options.outputPath,
      row,
      eval: evalSummary,
      holdout: holdoutSummary,
    }, null, 2));
    return;
  }

  console.log(`recorded_to: ${options.outputPath}`);
  console.log(`commit: ${row.commit}`);
  console.log(`dirty: ${row.dirty}`);
  console.log(`eval_win_rate: ${row.evalWinRate}`);
  console.log(`eval_progress: ${row.evalProgress}`);
  if (holdoutSummary) {
    console.log(`holdout_win_rate: ${row.holdoutWinRate}`);
    console.log(`holdout_progress: ${row.holdoutProgress}`);
  }
  console.log(`decision: ${row.decision}`);
  console.log(`description: ${row.description || "(none)"}`);
}

main();
