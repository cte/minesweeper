import { spawn } from "node:child_process";
import fs from "node:fs";

import type { ResearchProject } from "./types.js";
import { resolveResearchPaths } from "./runtime.js";
import { optionalEnv, shellQuote } from "./utils.js";

interface CodexOptions {
  model: string;
  profile: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  bypassSandbox: boolean;
  color: "always" | "never" | "auto";
  dryRun: boolean;
  projectRoot: string;
  promptFile: string;
  descriptionFile: string;
  outputLastMessage: string;
  transcriptFile: string;
  currentTranscriptFile: string;
}

function parseArgs(argv: string[], project: ResearchProject): CodexOptions {
  const paths = resolveResearchPaths(project);
  const options: CodexOptions = {
    model: "",
    profile: "",
    sandbox: "workspace-write",
    bypassSandbox: false,
    color: "never",
    dryRun: false,
    projectRoot: optionalEnv("AUTORESEARCH_PROJECT_ROOT") || project.projectRoot,
    promptFile: optionalEnv("AUTORESEARCH_PROMPT_FILE") || paths.promptPath,
    descriptionFile: optionalEnv("AUTORESEARCH_DESCRIPTION_FILE") || paths.descriptionPath,
    outputLastMessage: optionalEnv("AUTORESEARCH_CODEX_LAST_MESSAGE_PATH") || paths.codexLastMessagePath,
    transcriptFile: optionalEnv("AUTORESEARCH_TRANSCRIPT_FILE") || pathJoin(paths.transcriptsDir, "manual.log"),
    currentTranscriptFile: optionalEnv("AUTORESEARCH_CURRENT_TRANSCRIPT_FILE") || paths.currentTranscriptPath,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    }
    if (arg === "--model" && next) {
      options.model = next;
      i += 1;
    } else if (arg === "--profile" && next) {
      options.profile = next;
      i += 1;
    } else if (arg === "--sandbox" && next) {
      if (next !== "read-only" && next !== "workspace-write" && next !== "danger-full-access") {
        throw new Error(`Invalid sandbox: ${next}`);
      }
      options.sandbox = next;
      i += 1;
    } else if (arg === "--color" && next) {
      if (next !== "always" && next !== "never" && next !== "auto") {
        throw new Error(`Invalid color mode: ${next}`);
      }
      options.color = next;
      i += 1;
    } else if (arg === "--dangerously-bypass-approvals-and-sandbox") {
      options.bypassSandbox = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.error("Usage: research:codex-edit -- [--model MODEL] [--profile PROFILE] [--sandbox workspace-write] [--dry-run]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function pathJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

function buildPrompt(project: ResearchProject, promptText: string, descriptionFile: string): string {
  return [
    "You are the editor inside an outer autoresearch loop.",
    "",
    "Requirements:",
    `- Edit only: ${project.editablePaths.join(", ")}.`,
    "- Do not run git commands.",
    "- Do not modify the evaluation harness, package metadata, or docs.",
    "- Make exactly one coherent change.",
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

async function runCodex(
  args: string[],
  promptText: string,
  transcriptFile: string,
  currentTranscriptFile: string,
  projectRoot: string,
): Promise<void> {
  fs.mkdirSync(pathDirname(transcriptFile), { recursive: true });
  fs.mkdirSync(pathDirname(currentTranscriptFile), { recursive: true });

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
    child.stdin.write(promptText);
    child.stdin.end();
  });
}

function pathDirname(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx >= 0 ? filePath.slice(0, idx) : ".";
}

export async function runCodexEditorCli(project: ResearchProject, argv: string[]): Promise<void> {
  const options = parseArgs(argv, project);
  if (!fs.existsSync(options.promptFile)) {
    throw new Error(`Prompt file does not exist: ${options.promptFile}`);
  }
  const promptText = buildPrompt(project, fs.readFileSync(options.promptFile, "utf8"), options.descriptionFile);
  fs.mkdirSync(pathDirname(options.outputLastMessage), { recursive: true });

  const args = [
    "exec",
    "-C",
    options.projectRoot,
    "--color",
    options.color,
    "--output-last-message",
    options.outputLastMessage,
    ...(options.bypassSandbox ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--full-auto", "--sandbox", options.sandbox]),
    ...(options.model.length > 0 ? ["--model", options.model] : []),
    ...(options.profile.length > 0 ? ["--profile", options.profile] : []),
    "-",
  ];

  if (options.dryRun) {
    console.log(["codex", ...args.map(shellQuote)].join(" "));
    console.log(`transcript: ${options.transcriptFile}`);
    console.log(`current_transcript: ${options.currentTranscriptFile}`);
    console.log("---");
    console.log(promptText);
    return;
  }

  await runCodex(args, promptText, options.transcriptFile, options.currentTranscriptFile, options.projectRoot);
}
