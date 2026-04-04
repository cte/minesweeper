import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { getProjectRoot } from "./project.js";
import { ensureResultsFile, overwriteResultsFile, appendResultRow, type ResultsRow } from "./results.js";
import { createSolver } from "./solver.js";
import { evaluateBenchmark } from "./scoring.js";

interface InitOptions {
  tag: string;
  base: string;
  outputPath: string;
  force: boolean;
  skipBaseline: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): InitOptions {
  const projectRoot = getProjectRoot();
  const options: InitOptions = {
    tag: "",
    base: currentBranch(projectRoot),
    outputPath: path.join(projectRoot, "results.tsv"),
    force: false,
    skipBaseline: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    const next = argv[i + 1];
    if (arg === "--tag" && next) {
      options.tag = next;
      i += 1;
    } else if (arg === "--base" && next) {
      options.base = next;
      i += 1;
    } else if (arg === "--output" && next) {
      options.outputPath = path.resolve(next);
      i += 1;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--skip-baseline") {
      options.skipBaseline = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit(0);
    } else {
      printHelpAndExit(1, `Unknown argument: ${arg}`);
    }
  }

  if (options.tag.trim().length === 0) {
    printHelpAndExit(1, "Missing required --tag");
  }

  return options;
}

function printHelpAndExit(code: number, message?: string): never {
  if (message) {
    console.error(message);
    console.error("");
  }
  console.error("Usage: pnpm research:init -- --tag apr4 [--base master] [--force] [--skip-baseline] [--json]");
  process.exit(code);
}

function git(projectRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
}

function currentBranch(projectRoot: string): string {
  return git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function branchExists(projectRoot: string, branch: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", branch], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function assertCleanWorktree(projectRoot: string): void {
  const status = git(projectRoot, ["status", "--short"]);
  if (status.length > 0) {
    throw new Error("Worktree must be clean before initializing a research branch");
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = getProjectRoot();
  const branchName = `autoresearch/${options.tag}`;

  assertCleanWorktree(projectRoot);

  if (branchExists(projectRoot, branchName)) {
    throw new Error(`Branch already exists: ${branchName}`);
  }

  if (fs.existsSync(options.outputPath) && !options.force) {
    throw new Error(`Results file already exists: ${options.outputPath}. Use --force to overwrite it.`);
  }

  execFileSync("git", ["checkout", "-b", branchName, options.base], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  overwriteResultsFile(options.outputPath);
  ensureResultsFile(options.outputPath);

  let baselineRow: ResultsRow | null = null;
  if (!options.skipBaseline) {
    const solver = createSolver();
    const evalPath = path.join(projectRoot, "bench", "eval.json");
    const holdoutPath = path.join(projectRoot, "bench", "holdout.json");
    const evalSummary = evaluateBenchmark(evalPath, solver);
    const holdoutSummary = evaluateBenchmark(holdoutPath, solver);
    baselineRow = {
      timestamp: new Date().toISOString(),
      branch: branchName,
      commit: git(projectRoot, ["rev-parse", "--short", "HEAD"]),
      dirty: "no",
      solver: solver.name,
      evalWinRate: evalSummary.winRate.toFixed(6),
      evalProgress: evalSummary.progressScore.toFixed(6),
      evalAvgSteps: evalSummary.avgSteps.toFixed(2),
      holdoutWinRate: holdoutSummary.winRate.toFixed(6),
      holdoutProgress: holdoutSummary.progressScore.toFixed(6),
      holdoutAvgSteps: holdoutSummary.avgSteps.toFixed(2),
      decision: "baseline",
      description: "baseline",
    };
    appendResultRow(options.outputPath, baselineRow);
  }

  if (options.json) {
    console.log(JSON.stringify({
      branch: branchName,
      base: options.base,
      resultsPath: options.outputPath,
      baseline: baselineRow,
    }, null, 2));
    return;
  }

  console.log(`branch: ${branchName}`);
  console.log(`results: ${options.outputPath}`);
  if (baselineRow) {
    console.log(`baseline_eval_win_rate: ${baselineRow.evalWinRate}`);
    console.log(`baseline_holdout_win_rate: ${baselineRow.holdoutWinRate}`);
  } else {
    console.log("baseline: skipped");
  }
}

main();
