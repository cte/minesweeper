import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getProjectRoot } from "./project.js";
import { appendResultRow, getAcceptedResultsRows, readResultsRows, type ResultsRow } from "./results.js";
import { evaluateBenchmark, type ScoreSummary } from "./scoring.js";
import type { Solver } from "./types.js";

interface TrialOptions {
  description: string;
  commitMessage: string;
  outputPath: string;
  allowAnyBranch: boolean;
  json: boolean;
  skipHoldout: boolean;
  skipCheck: boolean;
}

interface TrialOutcome {
  action: "keep" | "discard" | "crash";
  reason: string;
  evalSummary: ScoreSummary | null;
  holdoutSummary: ScoreSummary | null;
  committedSha: string;
}

function parseArgs(argv: string[]): TrialOptions {
  const projectRoot = getProjectRoot();
  const options: TrialOptions = {
    description: "",
    commitMessage: "",
    outputPath: path.join(projectRoot, "results.tsv"),
    allowAnyBranch: false,
    json: false,
    skipHoldout: false,
    skipCheck: false,
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
    } else if (arg === "--message" && next) {
      options.commitMessage = next;
      i += 1;
    } else if (arg === "--output" && next) {
      options.outputPath = path.resolve(next);
      i += 1;
    } else if (arg === "--allow-any-branch") {
      options.allowAnyBranch = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--skip-holdout") {
      options.skipHoldout = true;
    } else if (arg === "--skip-check") {
      options.skipCheck = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit(0);
    } else {
      printHelpAndExit(1, `Unknown argument: ${arg}`);
    }
  }

  if (options.description.trim().length === 0) {
    printHelpAndExit(1, "Missing required --description");
  }
  if (options.commitMessage.trim().length === 0) {
    options.commitMessage = `solver: ${options.description}`;
  }
  return options;
}

function printHelpAndExit(code: number, message?: string): never {
  if (message) {
    console.error(message);
    console.error("");
  }
  console.error("Usage: pnpm research:trial -- --description TEXT [--message TEXT] [--json] [--skip-holdout]");
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

function changedPaths(projectRoot: string): string[] {
  const status = execFileSync("git", ["status", "--short"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (status.length === 0) {
    return [];
  }
  return status
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim());
}

function restoreSolver(projectRoot: string): void {
  execFileSync("git", ["restore", "--source", "HEAD", "--staged", "--worktree", "src/solver.ts"], {
    cwd: projectRoot,
    stdio: "ignore",
  });
}

function findReferenceRow(resultsPath: string): ResultsRow {
  const rows = getAcceptedResultsRows(readResultsRows(resultsPath));
  const row = rows.at(-1);
  if (!row) {
    throw new Error(`No baseline or accepted result found in ${resultsPath}`);
  }
  return row;
}

function parseMetric(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${label}: ${value}`);
  }
  return parsed;
}

function shouldKeep(candidate: ScoreSummary, reference: ResultsRow): { keep: boolean; reason: string } {
  const bestWinRate = parseMetric(reference.evalWinRate, "evalWinRate");
  const bestProgress = parseMetric(reference.evalProgress, "evalProgress");
  if (candidate.winRate > bestWinRate + 1e-12) {
    return { keep: true, reason: `win_rate improved from ${bestWinRate.toFixed(6)} to ${candidate.winRate.toFixed(6)}` };
  }
  if (Math.abs(candidate.winRate - bestWinRate) <= 1e-12 && candidate.progressScore > bestProgress + 1e-12) {
    return { keep: true, reason: `progress_score improved from ${bestProgress.toFixed(6)} to ${candidate.progressScore.toFixed(6)} at equal win_rate` };
  }
  return { keep: false, reason: `not better than current best (${bestWinRate.toFixed(6)} / ${bestProgress.toFixed(6)})` };
}

async function loadSolver(): Promise<Solver> {
  const projectRoot = getProjectRoot();
  const moduleUrl = `${pathToFileURL(path.join(projectRoot, "src", "solver.ts")).href}?ts=${Date.now()}`;
  const module = await import(moduleUrl);
  if (typeof module.createSolver !== "function") {
    throw new Error("solver module does not export createSolver()");
  }
  return module.createSolver() as Solver;
}

function appendOutcomeRow(
  outputPath: string,
  branch: string,
  commit: string,
  solver: string,
  decision: "keep" | "discard" | "crash",
  description: string,
  evalSummary: ScoreSummary | null,
  holdoutSummary: ScoreSummary | null,
  dirty: string,
): ResultsRow {
  const row: ResultsRow = {
    timestamp: new Date().toISOString(),
    branch,
    commit,
    dirty,
    solver,
    evalWinRate: evalSummary ? evalSummary.winRate.toFixed(6) : "",
    evalProgress: evalSummary ? evalSummary.progressScore.toFixed(6) : "",
    evalAvgSteps: evalSummary ? evalSummary.avgSteps.toFixed(2) : "",
    holdoutWinRate: holdoutSummary ? holdoutSummary.winRate.toFixed(6) : "",
    holdoutProgress: holdoutSummary ? holdoutSummary.progressScore.toFixed(6) : "",
    holdoutAvgSteps: holdoutSummary ? holdoutSummary.avgSteps.toFixed(2) : "",
    decision,
    description,
  };
  appendResultRow(outputPath, row);
  return row;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = getProjectRoot();
  const branch = currentBranch(projectRoot);
  const evalBenchmarkPath = path.join(projectRoot, "bench", "eval.json");
  const holdoutBenchmarkPath = path.join(projectRoot, "bench", "holdout.json");
  const referenceRow = findReferenceRow(options.outputPath);

  if (!options.allowAnyBranch && !branch.startsWith("autoresearch/")) {
    throw new Error(`Current branch must be autoresearch/*, found: ${branch}`);
  }

  const paths = changedPaths(projectRoot);
  if (paths.length === 0) {
    throw new Error("No changes detected. Edit src/solver.ts before running a trial.");
  }
  const unexpected = paths.filter((filePath) => filePath !== "src/solver.ts");
  if (unexpected.length > 0) {
    throw new Error(`Only src/solver.ts may be changed during a trial. Unexpected changes: ${unexpected.join(", ")}`);
  }

  let outcome: TrialOutcome;
  let row: ResultsRow;
  try {
    if (!options.skipCheck) {
      execFileSync("pnpm", ["check"], { cwd: projectRoot, stdio: "inherit" });
    }

    const solver = await loadSolver();
    const evalSummary = evaluateBenchmark(evalBenchmarkPath, solver);
    const keepDecision = shouldKeep(evalSummary, referenceRow);
    if (!keepDecision.keep) {
      row = appendOutcomeRow(
        options.outputPath,
        branch,
        git(projectRoot, ["rev-parse", "--short", "HEAD"]),
        solver.name,
        "discard",
        `${options.description} | ${keepDecision.reason}`,
        evalSummary,
        null,
        "yes",
      );
      restoreSolver(projectRoot);
      outcome = {
        action: "discard",
        reason: keepDecision.reason,
        evalSummary,
        holdoutSummary: null,
        committedSha: row.commit,
      };
    } else {
      execFileSync("git", ["add", "src/solver.ts"], { cwd: projectRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", options.commitMessage], { cwd: projectRoot, stdio: "inherit" });
      const commitSha = git(projectRoot, ["rev-parse", "--short", "HEAD"]);
      const holdoutSummary = options.skipHoldout ? null : evaluateBenchmark(holdoutBenchmarkPath, solver);
      row = appendOutcomeRow(
        options.outputPath,
        branch,
        commitSha,
        solver.name,
        "keep",
        `${options.description} | ${keepDecision.reason}`,
        evalSummary,
        holdoutSummary,
        "no",
      );
      outcome = {
        action: "keep",
        reason: keepDecision.reason,
        evalSummary,
        holdoutSummary,
        committedSha: commitSha,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    row = appendOutcomeRow(
      options.outputPath,
      branch,
      git(projectRoot, ["rev-parse", "--short", "HEAD"]),
      "unknown",
      "crash",
      `${options.description} | ${message}`,
      null,
      null,
      "yes",
    );
    restoreSolver(projectRoot);
    outcome = {
      action: "crash",
      reason: message,
      evalSummary: null,
      holdoutSummary: null,
      committedSha: row.commit,
    };
  }

  if (options.json) {
    console.log(JSON.stringify({
      action: outcome.action,
      reason: outcome.reason,
      commit: outcome.committedSha,
      row,
      eval: outcome.evalSummary,
      holdout: outcome.holdoutSummary,
    }, null, 2));
    return;
  }

  console.log(`action: ${outcome.action}`);
  console.log(`reason: ${outcome.reason}`);
  console.log(`commit: ${outcome.committedSha}`);
  if (outcome.evalSummary) {
    console.log(`eval_win_rate: ${outcome.evalSummary.winRate.toFixed(6)}`);
    console.log(`eval_progress: ${outcome.evalSummary.progressScore.toFixed(6)}`);
  }
  if (outcome.holdoutSummary) {
    console.log(`holdout_win_rate: ${outcome.holdoutSummary.winRate.toFixed(6)}`);
    console.log(`holdout_progress: ${outcome.holdoutSummary.progressScore.toFixed(6)}`);
  }
}

void main();
