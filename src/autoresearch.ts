import path from "node:path";

import { createJsonCommandHooks, defineResearchProject } from "@autoresearch/runtime";

import { getProjectRoot } from "./project.js";

const projectRoot = getProjectRoot();

export const minesweeperResearch = defineResearchProject({
  projectName: "a deterministic Minesweeper solver",
  projectRoot,
  editablePaths: ["src/solver.ts"],
  metrics: {
    primaryLabel: "win_rate",
    primaryDirection: "maximize",
    secondaryLabel: "progress_score",
    secondaryDirection: "maximize",
  },
  prompt: {
    objective: "Improve the solver on the fixed evaluation benchmark. Maximize win_rate first, then progress_score.",
    rules: [
      "Edit only src/solver.ts.",
      "Do not edit the game engine, benchmarks, or research harness.",
      "Keep the solver deterministic and legal.",
      "Prefer simple changes over complicated ones.",
      "Return legal moves only.",
    ],
    notes: [
      `Main benchmark: ${path.join(projectRoot, "bench", "eval.json")}`,
      `Holdout benchmark: ${path.join(projectRoot, "bench", "holdout.json")}`,
    ],
  },
  hooks: createJsonCommandHooks({
    evalCommand: ["pnpm", "score", "--", "--json"],
    holdoutCommand: ["pnpm", "score:holdout", "--", "--json"],
    checkCommand: ["pnpm", "check"],
    candidatePath: "solver",
    primaryPath: "winRate",
    secondaryPath: "progressScore",
    metadataPaths: {
      benchmark: "benchmark",
      games: "games",
      wins: "wins",
      losses: "losses",
      stalled: "stalled",
      avg_steps: "avgSteps",
      elapsed_ms: "elapsedMs",
    },
  }),
});
