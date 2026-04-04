import { execFileSync } from "node:child_process";

interface LoopCodexOptions {
  model: string;
  profile: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  bypassSandbox: boolean;
  maxIterations: number;
  stopOnKeep: boolean;
  continueOnCrash: boolean;
  continueOnNoChange: boolean;
  skipHoldout: boolean;
  skipCheck: boolean;
}

function parseArgs(argv: string[]): LoopCodexOptions {
  const options: LoopCodexOptions = {
    model: "",
    profile: "",
    sandbox: "workspace-write",
    bypassSandbox: false,
    maxIterations: 0,
    stopOnKeep: false,
    continueOnCrash: false,
    continueOnNoChange: false,
    skipHoldout: false,
    skipCheck: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    const next = argv[i + 1];
    if (arg === "--model" && next) {
      options.model = next;
      i += 1;
    } else if (arg === "--profile" && next) {
      options.profile = next;
      i += 1;
    } else if (arg === "--sandbox" && next) {
      if (next !== "read-only" && next !== "workspace-write" && next !== "danger-full-access") {
        printHelpAndExit(1, `Invalid sandbox: ${next}`);
      }
      options.sandbox = next;
      i += 1;
    } else if (arg === "--dangerously-bypass-approvals-and-sandbox") {
      options.bypassSandbox = true;
    } else if (arg === "--max-iterations" && next) {
      options.maxIterations = Number(next);
      i += 1;
    } else if (arg === "--stop-on-keep") {
      options.stopOnKeep = true;
    } else if (arg === "--continue-on-crash") {
      options.continueOnCrash = true;
    } else if (arg === "--continue-on-no-change") {
      options.continueOnNoChange = true;
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

  return options;
}

function printHelpAndExit(code: number, message?: string): never {
  if (message) {
    console.error(message);
    console.error("");
  }
  console.error("Usage: pnpm research:loop:codex -- [--model MODEL] [--max-iterations 20] [--stop-on-keep]");
  process.exit(code);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  const editorCommandParts = ["pnpm", "research:codex-edit", "--"];
  if (options.model.length > 0) {
    editorCommandParts.push("--model", options.model);
  }
  if (options.profile.length > 0) {
    editorCommandParts.push("--profile", options.profile);
  }
  if (options.bypassSandbox) {
    editorCommandParts.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    editorCommandParts.push("--sandbox", options.sandbox);
  }
  const editorCommand = editorCommandParts.map(shellQuote).join(" ");

  const loopArgs = ["research:loop", "--", "--editor-command", editorCommand];
  if (options.maxIterations > 0) {
    loopArgs.push("--max-iterations", String(options.maxIterations));
  }
  if (options.stopOnKeep) {
    loopArgs.push("--stop-on-keep");
  }
  if (options.continueOnCrash) {
    loopArgs.push("--continue-on-crash");
  }
  if (options.continueOnNoChange) {
    loopArgs.push("--continue-on-no-change");
  }
  if (options.skipHoldout) {
    loopArgs.push("--skip-holdout");
  }
  if (options.skipCheck) {
    loopArgs.push("--skip-check");
  }

  execFileSync("pnpm", loopArgs, {
    stdio: "inherit",
    encoding: "utf8",
  });
}

main();
