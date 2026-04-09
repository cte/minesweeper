import { createJsonCommandHooks, definePatchloopConfig } from "@patchloop/core";

export default definePatchloopConfig({
  projectName: "Minesweeper solver",
  editablePaths: ["src/solver.ts"],
  branchPrefix: "patchloop/",
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
      "Do not edit the game engine, benchmarks, or Patchloop wiring.",
      "The solver may use seeded stochastic logic if it improves results.",
      "Prefer simpler logic when scores are equal.",
      "Return legal moves only.",
    ],
    notes: [
      "Main benchmark: bench/eval.json",
      "Holdout benchmark: bench/holdout.json",
    ],
    programPath: "patchloop.program.md",
  },
  hooks: createJsonCommandHooks({
    checkCommand: ["pnpm", "check"],
    evalCommand: ["pnpm", "score", "--", "--json"],
    holdoutCommand: ["pnpm", "score:holdout", "--", "--json"],
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
      suites: "suites",
      failed_cases: "failedCases",
    },
  }),
});
