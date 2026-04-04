import { execFileSync } from "node:child_process";

import type { HookContext, JsonValue, ResearchHooks, ScoreSnapshot } from "./types.js";
import { asNumber, asString, resolveDotPath } from "./utils.js";

export interface CommandSpecObject {
  command: readonly [string, ...string[]];
  cwd?: string;
  env?: Record<string, string>;
}

export type CommandSpec = readonly [string, ...string[]] | CommandSpecObject;

export interface JsonCommandHooksOptions {
  evalCommand: CommandSpec;
  holdoutCommand?: CommandSpec;
  checkCommand?: CommandSpec;
  candidatePath: string;
  primaryPath: string;
  secondaryPath?: string;
  metadataPaths?: Record<string, string>;
}

function normalizeCommand(spec: CommandSpec): CommandSpecObject {
  if (Array.isArray(spec)) {
    const tuple = spec as readonly [string, ...string[]];
    return { command: tuple };
  }
  return spec as CommandSpecObject;
}

function runCommandCapture(spec: CommandSpec, projectRoot: string): string {
  const normalized = normalizeCommand(spec);
  const [command, ...args] = normalized.command;
  return execFileSync(command, args, {
    cwd: normalized.cwd ?? projectRoot,
    env: {
      ...process.env,
      ...normalized.env,
    },
    encoding: "utf8",
  }).trim();
}

function runCommandInherit(spec: CommandSpec, projectRoot: string): void {
  const normalized = normalizeCommand(spec);
  const [command, ...args] = normalized.command;
  execFileSync(command, args, {
    cwd: normalized.cwd ?? projectRoot,
    env: {
      ...process.env,
      ...normalized.env,
    },
    stdio: "inherit",
  });
}

function commandOutputToSnapshot(output: JsonValue, options: JsonCommandHooksOptions): ScoreSnapshot {
  const metadata: Record<string, JsonValue> = {};
  for (const [key, path] of Object.entries(options.metadataPaths ?? {})) {
    metadata[key] = resolveDotPath(output, path);
  }
  return {
    candidate: asString(resolveDotPath(output, options.candidatePath), "candidate"),
    primary: asNumber(resolveDotPath(output, options.primaryPath), "primary metric"),
    secondary: options.secondaryPath ? asNumber(resolveDotPath(output, options.secondaryPath), "secondary metric") : null,
    metadata,
    raw: output,
  };
}

function parseJsonFromCommandOutput(stdout: string): JsonValue {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error("Command returned empty output; expected JSON");
  }
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const firstBracket = trimmed.indexOf("[");
    const candidates = [firstBrace, firstBracket].filter((index) => index >= 0).sort((left, right) => left - right);
    for (const index of candidates) {
      const slice = trimmed.slice(index);
      try {
        return JSON.parse(slice) as JsonValue;
      } catch {
        continue;
      }
    }
    throw new Error(`Could not parse JSON from command output: ${trimmed.slice(0, 200)}`);
  }
}

function evaluateJsonCommand(context: HookContext, spec: CommandSpec, options: JsonCommandHooksOptions): ScoreSnapshot {
  const stdout = runCommandCapture(spec, context.project.projectRoot);
  const parsed = parseJsonFromCommandOutput(stdout);
  return commandOutputToSnapshot(parsed, options);
}

export function createJsonCommandHooks(options: JsonCommandHooksOptions): ResearchHooks {
  return {
    runCheck: options.checkCommand
      ? (context) => {
          runCommandInherit(options.checkCommand as CommandSpec, context.project.projectRoot);
        }
      : null,
    evaluateEval: (context) => evaluateJsonCommand(context, options.evalCommand, options),
    evaluateHoldout: options.holdoutCommand
      ? (context) => evaluateJsonCommand(context, options.holdoutCommand as CommandSpec, options)
      : null,
  };
}
