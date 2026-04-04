import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  assertCleanWorktree,
  branchExists,
  changedPaths,
  commitPaths,
  currentBranch,
  currentCommit,
  getGitInfo,
  git,
  restorePaths,
} from "./git.js";
import { appendResearchEvent, overwriteEvents } from "./events.js";
import { getAcceptedResultRecords, overwriteResultsStore, appendResultRecord, readResultRecords, ensureResultsStore } from "./store.js";
import { buildDefaultState, readResearchState, writeResearchState } from "./state.js";
import type {
  HookContext,
  PromptContext,
  ResearchPaths,
  ResearchProject,
  ResearchProjectInput,
  ResearchState,
  ResultRecord,
  ScoreSnapshot,
} from "./types.js";
import { writeJsonFile } from "./utils.js";

const EPSILON = 1e-12;

interface InitOptions {
  tag: string;
  base: string;
  force: boolean;
  skipBaseline: boolean;
  json: boolean;
}

interface RecordOptions {
  description: string;
  decision: "recorded" | "keep" | "discard" | "baseline";
  skipCheck: boolean;
  skipHoldout: boolean;
  json: boolean;
}

interface TrialOptions {
  description: string;
  commitMessage: string;
  allowAnyBranch: boolean;
  json: boolean;
  skipHoldout: boolean;
  skipCheck: boolean;
  iteration: number;
}

interface LoopOptions {
  editorCommand: string;
  maxIterations: number;
  stopOnCrash: boolean;
  stopOnNoChange: boolean;
  stopOnKeep: boolean;
  skipHoldout: boolean;
  skipCheck: boolean;
  shell: string;
}

interface TrialExecution {
  action: "keep" | "discard" | "crash";
  reason: string;
  record: ResultRecord;
}

interface IterationLog {
  iteration: number;
  action: string;
  description: string;
  reason: string;
  record: ResultRecord;
}

function now(): string {
  return new Date().toISOString();
}

function createHookContext(project: ResearchProject): HookContext {
  return {
    project,
    paths: resolveResearchPaths(project),
  };
}

function runCheck(project: ResearchProject): void {
  if (project.hooks.runCheck) {
    project.hooks.runCheck(createHookContext(project));
  }
}

async function evaluateEval(project: ResearchProject): Promise<ScoreSnapshot> {
  return await project.hooks.evaluateEval(createHookContext(project));
}

async function evaluateHoldout(project: ResearchProject): Promise<ScoreSnapshot | null> {
  if (!project.hooks.evaluateHoldout) {
    return null;
  }
  return await project.hooks.evaluateHoldout(createHookContext(project));
}

function defaultCompare(candidate: ScoreSnapshot, reference: ResultRecord, project: ResearchProject): { keep: boolean; reason: string } {
  if (!reference.eval) {
    throw new Error("Reference result does not include eval metrics");
  }
  const primaryLabel = project.metrics.primaryLabel;
  const primaryBetter =
    project.metrics.primaryDirection === "maximize"
      ? candidate.primary > reference.eval.primary + EPSILON
      : candidate.primary < reference.eval.primary - EPSILON;
  if (primaryBetter) {
    return {
      keep: true,
      reason: `${primaryLabel} improved from ${reference.eval.primary.toFixed(6)} to ${candidate.primary.toFixed(6)}`,
    };
  }
  const primaryEqual = Math.abs(candidate.primary - reference.eval.primary) <= EPSILON;
  const secondaryLabel = project.metrics.secondaryLabel;
  const secondaryDirection = project.metrics.secondaryDirection;
  if (primaryEqual && secondaryLabel && secondaryDirection && candidate.secondary !== null && reference.eval.secondary !== null) {
    const secondaryBetter =
      secondaryDirection === "maximize"
        ? candidate.secondary > reference.eval.secondary + EPSILON
        : candidate.secondary < reference.eval.secondary - EPSILON;
    if (secondaryBetter) {
      return {
        keep: true,
        reason: `${secondaryLabel} improved from ${reference.eval.secondary.toFixed(6)} to ${candidate.secondary.toFixed(6)} at equal ${primaryLabel}`,
      };
    }
  }
  const secondarySummary =
    reference.eval.secondary !== null && candidate.secondary !== null
      ? ` / ${reference.eval.secondary.toFixed(6)}`
      : "";
  return {
    keep: false,
    reason: `not better than current best (${reference.eval.primary.toFixed(6)}${secondarySummary})`,
  };
}

export function defineResearchProject(input: ResearchProjectInput): ResearchProject {
  return {
    projectName: input.projectName,
    projectRoot: input.projectRoot,
    editablePaths: input.editablePaths,
    branchPrefix: input.branchPrefix ?? "autoresearch/",
    stateDir: input.stateDir ?? path.join(input.projectRoot, ".autoresearch"),
    resultsJsonPath: input.resultsJsonPath ?? path.join(input.projectRoot, ".autoresearch", "results.jsonl"),
    resultsTsvPath: input.resultsTsvPath ?? path.join(input.projectRoot, "results.tsv"),
    eventsPath: input.eventsPath ?? path.join(input.projectRoot, ".autoresearch", "events.jsonl"),
    metrics: {
      primaryLabel: input.metrics.primaryLabel,
      primaryDirection: input.metrics.primaryDirection,
      secondaryLabel: input.metrics.secondaryLabel ?? null,
      secondaryDirection: input.metrics.secondaryDirection ?? (input.metrics.secondaryLabel ? "maximize" : null),
    },
    prompt: {
      objective: input.prompt.objective,
      rules: input.prompt.rules,
      notes: input.prompt.notes ?? [],
    },
    hooks: input.hooks,
    formatPrompt: input.formatPrompt ?? null,
    compare: input.compare ?? null,
  };
}

export function resolveResearchPaths(project: ResearchProject): ResearchPaths {
  return {
    stateDir: project.stateDir,
    promptPath: path.join(project.stateDir, "prompt.txt"),
    contextPath: path.join(project.stateDir, "context.json"),
    statePath: path.join(project.stateDir, "state.json"),
    descriptionPath: path.join(project.stateDir, "description.txt"),
    currentTranscriptPath: path.join(project.stateDir, "current-codex.log"),
    transcriptsDir: path.join(project.stateDir, "transcripts"),
    iterationsDir: path.join(project.stateDir, "iterations"),
    codexLastMessagePath: path.join(project.stateDir, "codex-last-message.txt"),
    eventsPath: project.eventsPath,
    resultsJsonPath: project.resultsJsonPath,
    resultsTsvPath: project.resultsTsvPath,
  };
}

function ensureRuntimeDirs(paths: ResearchPaths): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.transcriptsDir, { recursive: true });
  fs.mkdirSync(paths.iterationsDir, { recursive: true });
}

function relativeStateDir(project: ResearchProject, paths: ResearchPaths): string {
  return path.relative(project.projectRoot, paths.stateDir).replace(/\\/g, "/");
}

function ignoreProjectStatePath(project: ResearchProject, paths: ResearchPaths, filePath: string): boolean {
  const relative = relativeStateDir(project, paths);
  return relative.length > 0 && (filePath === relative || filePath.startsWith(`${relative}/`));
}

function filterRuntimeChanges(project: ResearchProject, paths: ResearchPaths, filePaths: string[]): string[] {
  return filePaths.filter((filePath) => !ignoreProjectStatePath(project, paths, filePath));
}

function updateState(
  project: ResearchProject,
  patch: Partial<ResearchState> & Pick<ResearchState, "currentBranch" | "status" | "currentIteration" | "maxIterations" | "message">,
): void {
  const paths = resolveResearchPaths(project);
  ensureRuntimeDirs(paths);
  const existing = readResearchState(project, paths);
  const next: ResearchState = {
    ...existing,
    ...patch,
    updatedAt: now(),
  };
  writeResearchState(paths, next);
}

function bestAcceptedRecord(project: ResearchProject): ResultRecord | null {
  const paths = resolveResearchPaths(project);
  return getAcceptedResultRecords(readResultRecords(paths)).at(-1) ?? null;
}

function writeLoopContext(project: ResearchProject, context: PromptContext): void {
  const paths = resolveResearchPaths(project);
  writeJsonFile(paths.contextPath, {
    branch: context.branch,
    iteration: context.iteration,
    editablePaths: context.editablePaths,
    descriptionPath: context.descriptionPath,
    promptPath: context.promptPath,
    transcriptPath: context.transcriptPath,
    bestResult: context.bestResult,
    recentResults: context.recentResults,
    objective: project.prompt.objective,
    rules: project.prompt.rules,
    notes: project.prompt.notes,
  });
}

function defaultPrompt(context: PromptContext, project: ResearchProject): string {
  const recentLines = context.recentResults
    .slice(-8)
    .map((record) => {
      const primary = record.eval ? record.eval.primary.toFixed(6) : "n/a";
      const secondary = record.eval && record.eval.secondary !== null ? `/${record.eval.secondary.toFixed(6)}` : "";
      return `- ${record.decision} | eval=${primary}${secondary} | ${record.description || "(no description)"}`;
    });

  const bestLine = context.bestResult?.eval
    ? `Current best: ${project.metrics.primaryLabel}=${context.bestResult.eval.primary.toFixed(6)}${
        project.metrics.secondaryLabel && context.bestResult.eval.secondary !== null
          ? `, ${project.metrics.secondaryLabel}=${context.bestResult.eval.secondary.toFixed(6)}`
          : ""
      }`
    : "Current best: baseline not recorded yet";

  return [
    `You are improving ${project.projectName}.`,
    "",
    "Objective:",
    `- ${project.prompt.objective}`,
    "",
    "Rules:",
    ...project.prompt.rules.map((rule) => `- ${rule}`),
    ...(project.prompt.notes.length > 0 ? ["", "Notes:", ...project.prompt.notes.map((note) => `- ${note}`)] : []),
    "",
    `Editable paths: ${context.editablePaths.join(", ")}`,
    `Current branch: ${context.branch}`,
    `Iteration: ${context.iteration}`,
    bestLine,
    "",
    "Recent results:",
    ...(recentLines.length > 0 ? recentLines : ["- none"]),
    "",
    "After editing the allowed file(s), you may optionally write a single-line description of the change to:",
    context.descriptionPath,
    "",
    "The outer loop will run scoring, decide keep/discard, and handle git commits.",
  ].join("\n");
}

function formatPrompt(context: PromptContext, project: ResearchProject): string {
  if (project.formatPrompt) {
    return project.formatPrompt(context, project);
  }
  return defaultPrompt(context, project);
}

function readDescription(descriptionPath: string): string {
  if (!fs.existsSync(descriptionPath)) {
    return "";
  }
  return fs.readFileSync(descriptionPath, "utf8").trim();
}

function inferDescription(project: ResearchProject, iteration: number): string {
  const diff = execFileSync("git", ["diff", "--unified=0", "--", ...project.editablePaths], {
    cwd: project.projectRoot,
    encoding: "utf8",
  });
  const numstat = execFileSync("git", ["diff", "--numstat", "--", ...project.editablePaths], {
    cwd: project.projectRoot,
    encoding: "utf8",
  }).trim();
  let summary = `iteration-${String(iteration).padStart(3, "0")} edit`;
  if (numstat.length > 0) {
    const totals = numstat
      .split(/\r?\n/)
      .map((line) => line.split(/\s+/))
      .reduce(
        (acc, parts) => ({
          added: acc.added + Number(parts[0] ?? 0),
          removed: acc.removed + Number(parts[1] ?? 0),
        }),
        { added: 0, removed: 0 },
      );
    summary += ` (+${totals.added}/-${totals.removed})`;
  }
  const informativeLine = diff
    .split(/\r?\n/)
    .find((line) => line.startsWith("+") && !line.startsWith("+++") && line.slice(1).trim().length > 0);
  if (informativeLine) {
    summary += `: ${informativeLine.slice(1).trim().replace(/\s+/g, " ").slice(0, 80)}`;
  }
  return summary;
}

function defaultCommitMessage(project: ResearchProject, description: string): string {
  const firstPath = project.editablePaths[0] ?? "candidate";
  const name = path.basename(firstPath, path.extname(firstPath)) || "candidate";
  return `${name}: ${description}`;
}

function createResultRecord(
  project: ResearchProject,
  decision: ResultRecord["decision"],
  description: string,
  reason: string,
  commit: string,
  dirty: boolean,
  evalScore: ScoreSnapshot | null,
  holdoutScore: ScoreSnapshot | null,
): ResultRecord {
  return {
    timestamp: now(),
    branch: currentBranch(project.projectRoot),
    commit,
    dirty,
    decision,
    description,
    reason,
    candidate: evalScore?.candidate ?? holdoutScore?.candidate ?? "unknown",
    eval: evalScore,
    holdout: holdoutScore,
  };
}

async function executeTrial(project: ResearchProject, options: TrialOptions): Promise<TrialExecution> {
  const paths = resolveResearchPaths(project);
  ensureRuntimeDirs(paths);
  ensureResultsStore(paths);
  const branch = currentBranch(project.projectRoot);
  if (!options.allowAnyBranch && !branch.startsWith(project.branchPrefix)) {
    throw new Error(`Current branch must start with ${project.branchPrefix}, found: ${branch}`);
  }
  const changed = filterRuntimeChanges(project, paths, changedPaths(project.projectRoot));
  if (changed.length === 0) {
    throw new Error(`No changes detected. Edit ${project.editablePaths.join(", ")} before running a trial.`);
  }
  const unexpected = changed.filter((filePath) => !project.editablePaths.includes(filePath));
  if (unexpected.length > 0) {
    throw new Error(`Only ${project.editablePaths.join(", ")} may be changed. Unexpected changes: ${unexpected.join(", ")}`);
  }

  appendResearchEvent(paths, {
    type: "trial_started",
    iteration: 0,
    message: options.description,
    data: { branch, changedPaths: changed },
  });
  updateState(project, {
    currentBranch: branch,
    status: "evaluating",
    currentIteration: options.iteration,
    maxIterations: 0,
    message: `evaluating: ${options.description}`,
  });

  try {
    if (!options.skipCheck) {
      runCheck(project);
    }

    const evalScore = await evaluateEval(project);
    const reference = bestAcceptedRecord(project);
    if (!reference) {
      throw new Error("No baseline or accepted result found");
    }
    const compare = project.compare ?? defaultCompare;
    const keepDecision = compare(evalScore, reference, project);

    if (!keepDecision.keep) {
      const record = createResultRecord(
        project,
        "discard",
        options.description,
        keepDecision.reason,
        currentCommit(project.projectRoot),
        true,
        evalScore,
        null,
      );
      appendResultRecord(paths, record);
      restorePaths(project.projectRoot, project.editablePaths);
      appendResearchEvent(paths, {
        type: "trial_finished",
        iteration: options.iteration,
        message: `discard: ${keepDecision.reason}`,
        data: record,
      });
      updateState(project, {
        currentBranch: branch,
        status: "initialized",
        currentIteration: options.iteration,
        maxIterations: 0,
        message: `discarded: ${keepDecision.reason}`,
      });
      return { action: "discard", reason: keepDecision.reason, record };
    }

    const commitMessage = options.commitMessage.trim().length > 0
      ? options.commitMessage
      : defaultCommitMessage(project, options.description);
    const commit = commitPaths(project.projectRoot, project.editablePaths, commitMessage);
    const holdout = options.skipHoldout ? null : await evaluateHoldout(project);
    const record = createResultRecord(
      project,
      "keep",
      options.description,
      keepDecision.reason,
      commit,
      false,
      evalScore,
      holdout,
    );
    appendResultRecord(paths, record);
    appendResearchEvent(paths, {
      type: "trial_finished",
      iteration: options.iteration,
      message: `keep: ${keepDecision.reason}`,
      data: record,
    });
    updateState(project, {
      currentBranch: branch,
      status: "initialized",
      currentIteration: options.iteration,
      maxIterations: 0,
      message: `accepted: ${keepDecision.reason}`,
    });
    return { action: "keep", reason: keepDecision.reason, record };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const record = createResultRecord(
      project,
      "crash",
      options.description,
      message,
      currentCommit(project.projectRoot),
      true,
      null,
      null,
    );
    appendResultRecord(paths, record);
    restorePaths(project.projectRoot, project.editablePaths);
    appendResearchEvent(paths, {
      type: "trial_finished",
      iteration: options.iteration,
      message: `crash: ${message}`,
      data: record,
    });
    updateState(project, {
      currentBranch: branch,
      status: "initialized",
      currentIteration: options.iteration,
      maxIterations: 0,
      message: `crash: ${message}`,
    });
    return { action: "crash", reason: message, record };
  }
}

async function executeRecord(project: ResearchProject, options: RecordOptions): Promise<ResultRecord> {
  const paths = resolveResearchPaths(project);
  ensureRuntimeDirs(paths);
  ensureResultsStore(paths);
  if (!options.skipCheck) {
    runCheck(project);
  }
  const evalScore = await evaluateEval(project);
  const holdout = options.skipHoldout ? null : await evaluateHoldout(project);
  const gitInfo = getGitInfo(project.projectRoot);
  const record = createResultRecord(
    project,
    options.decision,
    options.description,
    options.description,
    gitInfo.commit,
    gitInfo.dirty,
    evalScore,
    holdout,
  );
  appendResultRecord(paths, record);
  appendResearchEvent(paths, {
    type: "recorded",
    iteration: 0,
    message: options.description || options.decision,
    data: record,
  });
  updateState(project, {
    currentBranch: gitInfo.branch,
    status: "initialized",
    currentIteration: 0,
    maxIterations: 0,
    message: `recorded: ${options.description || options.decision}`,
  });
  return record;
}

function printTrialResult(project: ResearchProject, result: TrialExecution): void {
  console.log(`action: ${result.action}`);
  console.log(`reason: ${result.reason}`);
  console.log(`commit: ${result.record.commit}`);
  if (result.record.eval) {
    console.log(`${project.metrics.primaryLabel}: ${result.record.eval.primary.toFixed(6)}`);
    if (project.metrics.secondaryLabel && result.record.eval.secondary !== null) {
      console.log(`${project.metrics.secondaryLabel}: ${result.record.eval.secondary.toFixed(6)}`);
    }
  }
  if (result.record.holdout) {
    console.log(`holdout_${project.metrics.primaryLabel}: ${result.record.holdout.primary.toFixed(6)}`);
    if (project.metrics.secondaryLabel && result.record.holdout.secondary !== null) {
      console.log(`holdout_${project.metrics.secondaryLabel}: ${result.record.holdout.secondary.toFixed(6)}`);
    }
  }
}

function printRecordResult(project: ResearchProject, record: ResultRecord): void {
  console.log(`recorded_to: ${resolveResearchPaths(project).resultsTsvPath}`);
  console.log(`commit: ${record.commit}`);
  console.log(`dirty: ${record.dirty ? "yes" : "no"}`);
  if (record.eval) {
    console.log(`${project.metrics.primaryLabel}: ${record.eval.primary.toFixed(6)}`);
    if (project.metrics.secondaryLabel && record.eval.secondary !== null) {
      console.log(`${project.metrics.secondaryLabel}: ${record.eval.secondary.toFixed(6)}`);
    }
  }
  if (record.holdout) {
    console.log(`holdout_${project.metrics.primaryLabel}: ${record.holdout.primary.toFixed(6)}`);
    if (project.metrics.secondaryLabel && record.holdout.secondary !== null) {
      console.log(`holdout_${project.metrics.secondaryLabel}: ${record.holdout.secondary.toFixed(6)}`);
    }
  }
  console.log(`decision: ${record.decision}`);
  console.log(`description: ${record.description || "(none)"}`);
}

function parseInitArgs(argv: string[], project: ResearchProject): InitOptions {
  const options: InitOptions = {
    tag: "",
    base: currentBranch(project.projectRoot),
    force: false,
    skipBaseline: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    }
    if (arg === "--tag" && next) {
      options.tag = next;
      i += 1;
    } else if (arg === "--base" && next) {
      options.base = next;
      i += 1;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--skip-baseline") {
      options.skipBaseline = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.error("Usage: research:init -- --tag run-id [--base main] [--force] [--skip-baseline] [--json]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.tag.trim().length === 0) {
    throw new Error("Missing required --tag");
  }
  return options;
}

function parseRecordArgs(argv: string[]): RecordOptions {
  const options: RecordOptions = {
    description: "",
    decision: "recorded",
    skipCheck: false,
    skipHoldout: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    }
    if (arg === "--description" && next) {
      options.description = next;
      i += 1;
    } else if (arg === "--decision" && next) {
      if (next === "recorded" || next === "keep" || next === "discard" || next === "baseline") {
        options.decision = next;
      } else {
        throw new Error(`Invalid decision: ${next}`);
      }
      i += 1;
    } else if (arg === "--skip-check") {
      options.skipCheck = true;
    } else if (arg === "--skip-holdout") {
      options.skipHoldout = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.error("Usage: record -- --description TEXT [--decision recorded] [--skip-check] [--skip-holdout] [--json]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function parseTrialArgs(argv: string[]): TrialOptions {
  const options: TrialOptions = {
    description: "",
    commitMessage: "",
    allowAnyBranch: false,
    json: false,
    skipHoldout: false,
    skipCheck: false,
    iteration: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    }
    if (arg === "--description" && next) {
      options.description = next;
      i += 1;
    } else if (arg === "--message" && next) {
      options.commitMessage = next;
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
      console.error("Usage: research:trial -- --description TEXT [--message TEXT] [--skip-holdout] [--skip-check] [--json]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.description.trim().length === 0) {
    throw new Error("Missing required --description");
  }
  return options;
}

function parseLoopArgs(argv: string[]): LoopOptions {
  const options: LoopOptions = {
    editorCommand: "",
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
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    }
    if (arg === "--editor-command" && next) {
      options.editorCommand = next;
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
      console.error("Usage: research:loop -- --editor-command '...' [--max-iterations 20] [--continue-on-crash] [--continue-on-no-change]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.editorCommand.trim().length === 0) {
    throw new Error("Missing required --editor-command");
  }
  if (!Number.isInteger(options.maxIterations) || options.maxIterations < 0) {
    throw new Error("--max-iterations must be a non-negative integer");
  }
  return options;
}

export async function runResearchInitCli(project: ResearchProject, argv: string[]): Promise<void> {
  const options = parseInitArgs(argv, project);
  const paths = resolveResearchPaths(project);
  assertCleanWorktree(project.projectRoot);
  const branchName = `${project.branchPrefix}${options.tag}`;
  if (branchExists(project.projectRoot, branchName)) {
    throw new Error(`Branch already exists: ${branchName}`);
  }
  if ((fs.existsSync(paths.resultsTsvPath) || fs.existsSync(paths.stateDir)) && !options.force) {
    throw new Error(`Existing research artifacts found. Use --force to overwrite ${paths.stateDir} and ${paths.resultsTsvPath}`);
  }

  fs.rmSync(paths.stateDir, { recursive: true, force: true });
  fs.rmSync(paths.resultsTsvPath, { force: true });
  ensureRuntimeDirs(paths);
  overwriteEvents(paths);
  overwriteResultsStore(paths);

  execFileSync("git", ["checkout", "-b", branchName, options.base], {
    cwd: project.projectRoot,
    stdio: "inherit",
  });

  let baseline: ResultRecord | null = null;
  if (!options.skipBaseline) {
    const evalScore = await evaluateEval(project);
    const holdout = await evaluateHoldout(project);
    baseline = createResultRecord(project, "baseline", "baseline", "baseline", currentCommit(project.projectRoot), false, evalScore, holdout);
    appendResultRecord(paths, baseline);
  }

  updateState(project, {
    currentBranch: branchName,
    status: "initialized",
    currentIteration: 0,
    maxIterations: 0,
    message: baseline ? "baseline recorded" : "initialized without baseline",
  });
  appendResearchEvent(paths, {
    type: "init",
    iteration: 0,
    message: baseline ? "baseline recorded" : "initialized",
    data: { branch: branchName, baseline },
  });

  if (options.json) {
    console.log(JSON.stringify({
      branch: branchName,
      base: options.base,
      resultsTsvPath: paths.resultsTsvPath,
      resultsJsonPath: paths.resultsJsonPath,
      baseline,
    }, null, 2));
    return;
  }

  console.log(`branch: ${branchName}`);
  console.log(`results_tsv: ${paths.resultsTsvPath}`);
  console.log(`results_json: ${paths.resultsJsonPath}`);
  if (baseline?.eval) {
    console.log(`baseline_${project.metrics.primaryLabel}: ${baseline.eval.primary.toFixed(6)}`);
    if (project.metrics.secondaryLabel && baseline.eval.secondary !== null) {
      console.log(`baseline_${project.metrics.secondaryLabel}: ${baseline.eval.secondary.toFixed(6)}`);
    }
  } else {
    console.log("baseline: skipped");
  }
}

export async function runResearchRecordCli(project: ResearchProject, argv: string[]): Promise<void> {
  const options = parseRecordArgs(argv);
  const record = await executeRecord(project, options);
  if (options.json) {
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  printRecordResult(project, record);
}

export async function runResearchTrialCli(project: ResearchProject, argv: string[]): Promise<void> {
  const options = parseTrialArgs(argv);
  const result = await executeTrial(project, options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printTrialResult(project, result);
}

export async function runResearchLoopCli(project: ResearchProject, argv: string[]): Promise<void> {
  const options = parseLoopArgs(argv);
  const paths = resolveResearchPaths(project);
  ensureRuntimeDirs(paths);
  const branch = currentBranch(project.projectRoot);
  if (!branch.startsWith(project.branchPrefix)) {
    throw new Error(`Current branch must start with ${project.branchPrefix}, found: ${branch}`);
  }
  const cleanStart = filterRuntimeChanges(project, paths, changedPaths(project.projectRoot));
  if (cleanStart.length > 0) {
    throw new Error(`Loop requires a clean worktree at start. Unexpected changes: ${cleanStart.join(", ")}`);
  }

  appendResearchEvent(paths, {
    type: "loop_started",
    iteration: 0,
    message: "loop started",
    data: { branch, maxIterations: options.maxIterations, editorCommand: options.editorCommand },
  });
  updateState(project, {
    currentBranch: branch,
    status: "editing",
    currentIteration: 0,
    maxIterations: options.maxIterations,
    message: "loop running",
  });

  let iteration = 1;
  while (options.maxIterations === 0 || iteration <= options.maxIterations) {
    if (fs.existsSync(paths.descriptionPath)) {
      fs.rmSync(paths.descriptionPath);
    }
    const transcriptPath = path.join(paths.transcriptsDir, `${String(iteration).padStart(4, "0")}.log`);
    const bestResult = bestAcceptedRecord(project);
    const recentResults = readResultRecords(paths).slice(-8);
    const context: PromptContext = {
      branch,
      iteration,
      editablePaths: project.editablePaths,
      descriptionPath: paths.descriptionPath,
      promptPath: paths.promptPath,
      transcriptPath,
      bestResult,
      recentResults,
    };
    writeLoopContext(project, context);
    fs.writeFileSync(paths.promptPath, `${formatPrompt(context, project)}\n`, "utf8");
    updateState(project, {
      currentBranch: branch,
      status: "editing",
      currentIteration: iteration,
      maxIterations: options.maxIterations,
      message: `iteration ${iteration}: waiting for editor`,
    });
    appendResearchEvent(paths, {
      type: "iteration_started",
      iteration,
      message: `iteration ${iteration}`,
      data: { transcriptPath, promptPath: paths.promptPath },
    });

    console.log(`iteration: ${iteration}`);
    console.log(`branch: ${branch}`);
    console.log(`prompt: ${paths.promptPath}`);
    console.log(`transcript: ${transcriptPath}`);

    execFileSync(options.shell, ["-lc", options.editorCommand], {
      cwd: project.projectRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        AUTORESEARCH_PROJECT_ROOT: project.projectRoot,
        AUTORESEARCH_BRANCH: branch,
        AUTORESEARCH_ITERATION: String(iteration),
        AUTORESEARCH_EDITABLE_PATHS: project.editablePaths.join(","),
        AUTORESEARCH_RESULTS_TSV_PATH: paths.resultsTsvPath,
        AUTORESEARCH_RESULTS_JSON_PATH: paths.resultsJsonPath,
        AUTORESEARCH_CONTEXT_JSON: paths.contextPath,
        AUTORESEARCH_PROMPT_FILE: paths.promptPath,
        AUTORESEARCH_DESCRIPTION_FILE: paths.descriptionPath,
        AUTORESEARCH_TRANSCRIPT_FILE: transcriptPath,
        AUTORESEARCH_CURRENT_TRANSCRIPT_FILE: paths.currentTranscriptPath,
        AUTORESEARCH_EVENTS_PATH: paths.eventsPath,
        AUTORESEARCH_CODEX_LAST_MESSAGE_PATH: paths.codexLastMessagePath,
      },
    });

    const changeSet = filterRuntimeChanges(project, paths, changedPaths(project.projectRoot));
    if (changeSet.length === 0) {
      console.log("action: no-change");
      appendResearchEvent(paths, {
        type: "iteration_no_change",
        iteration,
        message: "editor produced no tracked change",
        data: null,
      });
      if (options.stopOnNoChange) {
        console.log("stopping: editor produced no tracked change");
        break;
      }
      iteration += 1;
      continue;
    }

    const description = readDescription(paths.descriptionPath) || inferDescription(project, iteration);
    const trial = await executeTrial(project, {
      description,
      commitMessage: "",
      allowAnyBranch: true,
      json: false,
      skipHoldout: options.skipHoldout,
      skipCheck: options.skipCheck,
      iteration,
    });
    writeJsonFile(path.join(paths.iterationsDir, `${String(iteration).padStart(4, "0")}.json`), {
      iteration,
      action: trial.action,
      description,
      reason: trial.reason,
      record: trial.record,
    } satisfies IterationLog);

    if (trial.action === "crash" && options.stopOnCrash) {
      console.log("stopping: crash result");
      break;
    }
    if (trial.action === "keep" && options.stopOnKeep) {
      console.log("stopping: keep result");
      break;
    }

    iteration += 1;
  }

  appendResearchEvent(paths, {
    type: "loop_finished",
    iteration: iteration - 1,
    message: "loop finished",
    data: null,
  });
  updateState(project, {
    currentBranch: branch,
    status: "stopped",
    currentIteration: Math.max(0, iteration - 1),
    maxIterations: options.maxIterations,
    message: "loop finished",
  });
}
