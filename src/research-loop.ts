import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { getProjectRoot } from "./project.js";
import { getAcceptedResultsRows, readResultsRows, type ResultsRow } from "./results.js";

interface LoopOptions {
  editorCommand: string;
  outputPath: string;
  stateDir: string;
  maxIterations: number;
  stopOnCrash: boolean;
  stopOnNoChange: boolean;
  stopOnKeep: boolean;
  skipHoldout: boolean;
  skipCheck: boolean;
  shell: string;
}

interface LoopContext {
  branch: string;
  iteration: number;
  solverPath: string;
  resultsPath: string;
  descriptionPath: string;
  transcriptPath: string;
  currentTranscriptPath: string;
  best: {
    commit: string;
    evalWinRate: string;
    evalProgress: string;
    holdoutWinRate: string;
    holdoutProgress: string;
    description: string;
  };
  recent: Array<{
    decision: string;
    evalWinRate: string;
    evalProgress: string;
    description: string;
  }>;
}

interface IterationLog {
  iteration: number;
  action: string;
  description: string;
  branch: string;
  row: ResultsRow;
}

function parseArgs(argv: string[]): LoopOptions {
  const projectRoot = getProjectRoot();
  const options: LoopOptions = {
    editorCommand: "",
    outputPath: path.join(projectRoot, "results.tsv"),
    stateDir: path.join(projectRoot, ".autoresearch"),
    maxIterations: 0,
    stopOnCrash: true,
    stopOnNoChange: true,
    stopOnKeep: false,
    skipHoldout: false,
    skipCheck: false,
    shell: process.env.SHELL || "/bin/sh",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    const next = argv[i + 1];
    if (arg === "--editor-command" && next) {
      options.editorCommand = next;
      i += 1;
    } else if (arg === "--output" && next) {
      options.outputPath = path.resolve(next);
      i += 1;
    } else if (arg === "--state-dir" && next) {
      options.stateDir = path.resolve(next);
      i += 1;
    } else if (arg === "--max-iterations" && next) {
      options.maxIterations = Number(next);
      i += 1;
    } else if (arg === "--continue-on-crash") {
      options.stopOnCrash = false;
    } else if (arg === "--continue-on-no-change") {
      options.stopOnNoChange = false;
    } else if (arg === "--stop-on-keep") {
      options.stopOnKeep = true;
    } else if (arg === "--skip-holdout") {
      options.skipHoldout = true;
    } else if (arg === "--skip-check") {
      options.skipCheck = true;
    } else if (arg === "--shell" && next) {
      options.shell = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit(0);
    } else {
      printHelpAndExit(1, `Unknown argument: ${arg}`);
    }
  }

  if (options.editorCommand.trim().length === 0) {
    printHelpAndExit(1, "Missing required --editor-command");
  }
  if (!Number.isInteger(options.maxIterations) || options.maxIterations < 0) {
    printHelpAndExit(1, "--max-iterations must be a non-negative integer");
  }

  return options;
}

function printHelpAndExit(code: number, message?: string): never {
  if (message) {
    console.error(message);
    console.error("");
  }
  console.error("Usage: pnpm research:loop -- --editor-command 'your command' [--max-iterations 10] [--stop-on-keep]");
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
  if (status.trim().length === 0) {
    return [];
  }
  return status
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim());
}

function ensureCleanStart(projectRoot: string): void {
  const paths = changedPaths(projectRoot).filter((filePath) => !filePath.startsWith(".autoresearch/"));
  if (paths.length > 0) {
    throw new Error(`Loop requires a clean worktree at start. Unexpected changes: ${paths.join(", ")}`);
  }
}

function bestReferenceRow(resultsPath: string): ResultsRow {
  const rows = getAcceptedResultsRows(readResultsRows(resultsPath));
  const row = rows.at(-1);
  if (!row) {
    throw new Error(`No accepted results found in ${resultsPath}. Run research:init first.`);
  }
  return row;
}

function recentRows(resultsPath: string, limit = 8): ResultsRow[] {
  const rows = readResultsRows(resultsPath);
  return rows.slice(Math.max(0, rows.length - limit));
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function formatPrompt(context: LoopContext): string {
  const recentLines = context.recent.map((row) =>
    `- ${row.decision} | eval=${row.evalWinRate}/${row.evalProgress} | ${row.description || "(no description)"}`,
  );
  return [
    "You are improving a deterministic Minesweeper solver.",
    "",
    "Rules:",
    "- Edit only src/solver.ts.",
    "- Do not edit the game engine, benchmarks, or harness.",
    "- Keep the solver deterministic and legal.",
    "- Prefer simple changes over complicated ones.",
    "",
    `Current branch: ${context.branch}`,
    `Iteration: ${context.iteration}`,
    `Current best: eval_win_rate=${context.best.evalWinRate}, eval_progress=${context.best.evalProgress}, holdout_win_rate=${context.best.holdoutWinRate || "n/a"}, holdout_progress=${context.best.holdoutProgress || "n/a"}`,
    `Best description: ${context.best.description || "(baseline)"}`,
    "",
    "Recent results:",
    ...(recentLines.length > 0 ? recentLines : ["- none"]),
    "",
    "After editing src/solver.ts, you may optionally write a single-line description of the change to:",
    context.descriptionPath,
    "",
    "The outer loop will run scoring, decide keep/discard, and handle git commits.",
  ].join("\n");
}

function makeLoopContext(
  projectRoot: string,
  resultsPath: string,
  descriptionPath: string,
  transcriptPath: string,
  currentTranscriptPath: string,
  iteration: number,
): LoopContext {
  const best = bestReferenceRow(resultsPath);
  return {
    branch: currentBranch(projectRoot),
    iteration,
    solverPath: path.join(projectRoot, "src", "solver.ts"),
    resultsPath,
    descriptionPath,
    transcriptPath,
    currentTranscriptPath,
    best: {
      commit: best.commit,
      evalWinRate: best.evalWinRate,
      evalProgress: best.evalProgress,
      holdoutWinRate: best.holdoutWinRate,
      holdoutProgress: best.holdoutProgress,
      description: best.description,
    },
    recent: recentRows(resultsPath).map((row) => ({
      decision: row.decision,
      evalWinRate: row.evalWinRate,
      evalProgress: row.evalProgress,
      description: row.description,
    })),
  };
}

function readDescription(descriptionPath: string): string {
  if (!fs.existsSync(descriptionPath)) {
    return "";
  }
  return fs.readFileSync(descriptionPath, "utf8").trim();
}

function inferDescription(projectRoot: string, iteration: number): string {
  const numstat = execFileSync("git", ["diff", "--numstat", "--", "src/solver.ts"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  const diff = execFileSync("git", ["diff", "--unified=0", "--", "src/solver.ts"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  let summary = `iteration-${String(iteration).padStart(3, "0")} solver edit`;
  if (numstat.length > 0) {
    const [added = "0", removed = "0"] = numstat.split(/\s+/);
    summary += ` (+${added}/-${removed})`;
  }

  const informativeLine = diff
    .split(/\r?\n/)
    .find((line) => line.startsWith("+") && !line.startsWith("+++") && line.slice(1).trim().length > 0);
  if (informativeLine) {
    const snippet = informativeLine.slice(1).trim().replace(/\s+/g, " ").slice(0, 80);
    if (snippet.length > 0) {
      summary += `: ${snippet}`;
    }
  }
  return summary;
}

function lastResultRow(resultsPath: string): ResultsRow {
  const rows = readResultsRows(resultsPath);
  const row = rows.at(-1);
  if (!row) {
    throw new Error(`No result row found in ${resultsPath}`);
  }
  return row;
}

function writeIterationLog(filePath: string, value: IterationLog): void {
  writeJson(filePath, value);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = getProjectRoot();
  const branch = currentBranch(projectRoot);
  if (!branch.startsWith("autoresearch/")) {
    throw new Error(`Current branch must be autoresearch/*, found: ${branch}`);
  }
  ensureCleanStart(projectRoot);

  const iterationsDir = path.join(options.stateDir, "iterations");
  const transcriptsDir = path.join(options.stateDir, "transcripts");
  fs.mkdirSync(iterationsDir, { recursive: true });
  fs.mkdirSync(transcriptsDir, { recursive: true });
  const contextPath = path.join(options.stateDir, "context.json");
  const promptPath = path.join(options.stateDir, "prompt.txt");
  const descriptionPath = path.join(options.stateDir, "description.txt");
  const currentTranscriptPath = path.join(options.stateDir, "current-codex.log");

  let iteration = 1;
  while (options.maxIterations === 0 || iteration <= options.maxIterations) {
    if (fs.existsSync(descriptionPath)) {
      fs.rmSync(descriptionPath);
    }

    const transcriptPath = path.join(transcriptsDir, `${String(iteration).padStart(4, "0")}.log`);
    const contextWithTranscript = makeLoopContext(
      projectRoot,
      options.outputPath,
      descriptionPath,
      transcriptPath,
      currentTranscriptPath,
      iteration,
    );
    writeJson(contextPath, contextWithTranscript);
    fs.writeFileSync(promptPath, `${formatPrompt(contextWithTranscript)}\n`, "utf8");

    console.log(`iteration: ${iteration}`);
    console.log(`branch: ${branch}`);
    console.log(`prompt: ${promptPath}`);
    console.log(`transcript: ${transcriptPath}`);

    execFileSync(options.shell, ["-lc", options.editorCommand], {
      cwd: projectRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        AUTORESEARCH_PROJECT_ROOT: projectRoot,
        AUTORESEARCH_BRANCH: branch,
        AUTORESEARCH_ITERATION: String(iteration),
        AUTORESEARCH_SOLVER_PATH: path.join(projectRoot, "src", "solver.ts"),
        AUTORESEARCH_RESULTS_PATH: options.outputPath,
        AUTORESEARCH_CONTEXT_JSON: contextPath,
        AUTORESEARCH_PROMPT_FILE: promptPath,
        AUTORESEARCH_DESCRIPTION_FILE: descriptionPath,
        AUTORESEARCH_BEST_EVAL_WIN_RATE: contextWithTranscript.best.evalWinRate,
        AUTORESEARCH_BEST_EVAL_PROGRESS: contextWithTranscript.best.evalProgress,
        AUTORESEARCH_BEST_HOLDOUT_WIN_RATE: contextWithTranscript.best.holdoutWinRate,
        AUTORESEARCH_BEST_HOLDOUT_PROGRESS: contextWithTranscript.best.holdoutProgress,
        AUTORESEARCH_TRANSCRIPT_FILE: transcriptPath,
        AUTORESEARCH_CURRENT_TRANSCRIPT_FILE: currentTranscriptPath,
      },
    });

    const paths = changedPaths(projectRoot).filter((filePath) => !filePath.startsWith(".autoresearch/"));
    if (paths.length === 0) {
      console.log("action: no-change");
      if (options.stopOnNoChange) {
        console.log("stopping: editor produced no tracked change");
        break;
      }
      iteration += 1;
      continue;
    }

    const description = readDescription(descriptionPath) || inferDescription(projectRoot, iteration);
    execFileSync(
      "pnpm",
      [
        "research:trial",
        "--",
        "--description",
        description,
        ...(options.skipHoldout ? ["--skip-holdout"] : []),
        ...(options.skipCheck ? ["--skip-check"] : []),
      ],
      {
        cwd: projectRoot,
        stdio: "inherit",
      },
    );

    const row = lastResultRow(options.outputPath);
    const logPath = path.join(iterationsDir, `${String(iteration).padStart(4, "0")}.json`);
    writeIterationLog(logPath, {
      iteration,
      action: row.decision,
      description,
      branch,
      row,
    });

    if (row.decision === "crash" && options.stopOnCrash) {
      console.log("stopping: crash result");
      break;
    }
    if (row.decision === "keep" && options.stopOnKeep) {
      console.log("stopping: keep result");
      break;
    }

    iteration += 1;
  }
}

main();
