import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface CodexOptions {
  model: string;
  profile: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  bypassSandbox: boolean;
  color: "always" | "never" | "auto";
  dryRun: boolean;
  outputLastMessage: string;
  projectRoot: string;
  promptFile: string;
  descriptionFile: string;
  transcriptFile: string;
  currentTranscriptFile: string;
}

function parseArgs(argv: string[], defaults: {
  projectRoot: string;
  promptFile: string;
  descriptionFile: string;
  outputLastMessage: string;
  transcriptFile: string;
  currentTranscriptFile: string;
}): CodexOptions {
  const options: CodexOptions = {
    model: "",
    profile: "",
    sandbox: "workspace-write",
    bypassSandbox: false,
    color: "never",
    dryRun: false,
    outputLastMessage: defaults.outputLastMessage,
    projectRoot: defaults.projectRoot,
    promptFile: defaults.promptFile,
    descriptionFile: defaults.descriptionFile,
    transcriptFile: defaults.transcriptFile,
    currentTranscriptFile: defaults.currentTranscriptFile,
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
    } else if (arg === "--project-root" && next) {
      options.projectRoot = path.resolve(next);
      i += 1;
    } else if (arg === "--prompt-file" && next) {
      options.promptFile = path.resolve(next);
      i += 1;
    } else if (arg === "--description-file" && next) {
      options.descriptionFile = path.resolve(next);
      i += 1;
    } else if (arg === "--transcript-file" && next) {
      options.transcriptFile = path.resolve(next);
      i += 1;
    } else if (arg === "--current-transcript-file" && next) {
      options.currentTranscriptFile = path.resolve(next);
      i += 1;
    } else if (arg === "--output-last-message" && next) {
      options.outputLastMessage = path.resolve(next);
      i += 1;
    } else if (arg === "--sandbox" && next) {
      if (next !== "read-only" && next !== "workspace-write" && next !== "danger-full-access") {
        printHelpAndExit(1, `Invalid sandbox: ${next}`);
      }
      options.sandbox = next;
      i += 1;
    } else if (arg === "--dangerously-bypass-approvals-and-sandbox") {
      options.bypassSandbox = true;
    } else if (arg === "--color" && next) {
      if (next !== "always" && next !== "never" && next !== "auto") {
        printHelpAndExit(1, `Invalid color mode: ${next}`);
      }
      options.color = next;
      i += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
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
  console.error("Usage: pnpm research:codex-edit -- [--model MODEL] [--profile PROFILE] [--sandbox workspace-write] [--prompt-file FILE] [--transcript-file FILE] [--dry-run]");
  process.exit(code);
}

function optionalEnv(name: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : "";
}

function buildPrompt(promptText: string, descriptionFile: string): string {
  return [
    "You are the editor inside an outer autoresearch loop.",
    "",
    "Requirements:",
    "- Read and follow the task context below.",
    "- Edit only src/solver.ts.",
    "- Do not run git commands.",
    "- Do not modify benchmark files, harness files, package files, or docs.",
    "- Make exactly one coherent solver change.",
    "- Keep the solver deterministic and legal.",
    "- Do not run long experiment loops; the outer harness will evaluate the result.",
    "",
    "Before exiting:",
    `- Optionally write a single-line summary of your change to ${descriptionFile}`,
    "- Then stop.",
    "",
    "Task context:",
    promptText.trim(),
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

async function runCodex(
  args: string[],
  finalPrompt: string,
  transcriptFile: string,
  currentTranscriptFile: string,
  projectRoot: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
  fs.mkdirSync(path.dirname(currentTranscriptFile), { recursive: true });

  const transcript = fs.createWriteStream(transcriptFile, { flags: "w" });
  const currentTranscript = fs.createWriteStream(currentTranscriptFile, { flags: "w" });
  const commandLine = ["codex", ...args.map(shellQuote)].join(" ");
  const header = [
    `=== codex exec started ${new Date().toISOString()} ===`,
    `command: ${commandLine}`,
    `cwd: ${projectRoot}`,
    "---",
    "",
  ].join("\n");
  transcript.write(header);
  currentTranscript.write(header);

  const writeChunk = (chunk: Buffer | string, target: NodeJS.WriteStream): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    target.write(text);
    transcript.write(text);
    currentTranscript.write(text);
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => writeChunk(chunk, process.stdout));
    child.stderr.on("data", (chunk) => writeChunk(chunk, process.stderr));
    child.on("error", (error) => reject(error));
    child.on("close", (code, signal) => {
      const footer = [
        "",
        "---",
        `=== codex exec finished ${new Date().toISOString()} code=${code ?? "null"} signal=${signal ?? "null"} ===`,
        "",
      ].join("\n");
      transcript.write(footer);
      currentTranscript.write(footer);
      transcript.end();
      currentTranscript.end();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`codex exec failed with code=${code ?? "null"} signal=${signal ?? "null"}`));
      }
    });

    child.stdin.write(finalPrompt);
    child.stdin.end();
  });
}

async function main(): Promise<void> {
  const envProjectRoot = optionalEnv("AUTORESEARCH_PROJECT_ROOT");
  const projectRoot = envProjectRoot || process.cwd();
  const stateDir = path.join(projectRoot, ".autoresearch");
  const options = parseArgs(process.argv.slice(2), {
    projectRoot,
    promptFile: optionalEnv("AUTORESEARCH_PROMPT_FILE") || path.join(stateDir, "prompt.txt"),
    descriptionFile: optionalEnv("AUTORESEARCH_DESCRIPTION_FILE") || path.join(stateDir, "description.txt"),
    outputLastMessage: path.join(stateDir, "codex-last-message.txt"),
    transcriptFile: optionalEnv("AUTORESEARCH_TRANSCRIPT_FILE") || path.join(stateDir, "transcripts", "manual.log"),
    currentTranscriptFile: optionalEnv("AUTORESEARCH_CURRENT_TRANSCRIPT_FILE") || path.join(stateDir, "current-codex.log"),
  });
  fs.mkdirSync(path.dirname(options.outputLastMessage), { recursive: true });

  if (!fs.existsSync(options.promptFile)) {
    throw new Error(`Prompt file does not exist: ${options.promptFile}`);
  }

  const promptText = fs.readFileSync(options.promptFile, "utf8");
  const finalPrompt = buildPrompt(promptText, options.descriptionFile);

  const args: string[] = [
    "exec",
    "-C",
    options.projectRoot,
    "--color",
    options.color,
    "--output-last-message",
    options.outputLastMessage,
  ];

  if (options.bypassSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--full-auto", "--sandbox", options.sandbox);
  }
  if (options.model.length > 0) {
    args.push("--model", options.model);
  }
  if (options.profile.length > 0) {
    args.push("--profile", options.profile);
  }
  args.push("-");

  if (options.dryRun) {
    const display = ["codex", ...args.map(shellQuote)].join(" ");
    console.log(display);
    console.log(`transcript: ${options.transcriptFile}`);
    console.log(`current_transcript: ${options.currentTranscriptFile}`);
    console.log("---");
    console.log(finalPrompt);
    return;
  }

  await runCodex(
    args,
    finalPrompt,
    options.transcriptFile,
    options.currentTranscriptFile,
    options.projectRoot,
  );
}

void main();
