import { createJsonCommandHooks, definePatchloopConfig } from "@patchloop/core";
import type { ResultRecord, ScoreSnapshot } from "@patchloop/core";

const EPSILON = 1e-12;
const SEARCH_SECONDARY_MIN_DELTA = 0.0015;
const HOLDOUT_SECONDARY_REGRESSION_LIMIT = 0.01;

function metadataNumber(snapshot: ScoreSnapshot | null, key: string): number | null {
  const value = snapshot?.metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function searchReference(reference: ResultRecord): ScoreSnapshot | null {
  return reference.search ?? reference.eval;
}

function meaningfulSearchCompare(candidate: ScoreSnapshot, reference: ResultRecord): { keep: boolean; reason: string } {
  const baseline = searchReference(reference);
  if (!baseline) {
    throw new Error("Reference result does not include search or eval metrics");
  }
  if (candidate.primary > baseline.primary + EPSILON) {
    return {
      keep: true,
      reason: `search win_rate improved from ${baseline.primary.toFixed(6)} to ${candidate.primary.toFixed(6)}`,
    };
  }
  const equalPrimary = Math.abs(candidate.primary - baseline.primary) <= EPSILON;
  if (equalPrimary && candidate.secondary !== null && baseline.secondary !== null) {
    const delta = candidate.secondary - baseline.secondary;
    if (delta >= SEARCH_SECONDARY_MIN_DELTA) {
      return {
        keep: true,
        reason: `search progress_score improved from ${baseline.secondary.toFixed(6)} to ${candidate.secondary.toFixed(6)} at equal win_rate`,
      };
    }
    return {
      keep: false,
      reason: `search progress_score delta ${delta.toFixed(6)} is below the meaningful threshold ${SEARCH_SECONDARY_MIN_DELTA.toFixed(6)} at equal win_rate`,
    };
  }
  return {
    keep: false,
    reason: `not better than current best search (${baseline.primary.toFixed(6)}${baseline.secondary !== null ? ` / ${baseline.secondary.toFixed(6)}` : ""})`,
  };
}

function holdoutGuard(candidate: ScoreSnapshot, reference: ResultRecord): { keep: boolean; reason: string } {
  const baseline = reference.holdout;
  if (!baseline) {
    return { keep: true, reason: "no reference holdout recorded yet" };
  }

  const games = metadataNumber(candidate, "games") ?? metadataNumber(baseline, "games");
  const allowedPrimaryDrop = games && games > 0 ? 1 / games : 0;
  if (candidate.primary < baseline.primary - allowedPrimaryDrop - EPSILON) {
    return {
      keep: false,
      reason: `holdout win_rate regressed from ${baseline.primary.toFixed(6)} to ${candidate.primary.toFixed(6)}`,
    };
  }

  if (
    candidate.secondary !== null &&
    baseline.secondary !== null &&
    candidate.secondary < baseline.secondary - HOLDOUT_SECONDARY_REGRESSION_LIMIT - EPSILON
  ) {
    return {
      keep: false,
      reason: `holdout progress_score regressed from ${baseline.secondary.toFixed(6)} to ${candidate.secondary.toFixed(6)}`,
    };
  }

  return { keep: true, reason: "holdout stayed within the regression guardrail" };
}

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
      "Search benchmark: bench/search.json",
      "Main benchmark: bench/eval.json",
      "Holdout benchmark: bench/holdout.json",
    ],
    programPath: "patchloop.program.md",
  },
  insights: {
    themePatterns: [
      { label: "frontier-guessing", pattern: /\b(off-frontier|guess|guesses|guessing|near-tie|certainty|ambiguity|probe|continuation|information|safe-branch)\b/ },
      { label: "posterior-risk", pattern: /\b(risk|posterior|mine-total|density|guard|discount|penalty|surcharge|bp)\b/ },
      { label: "exact-local", pattern: /\b(local-exact|exact neighborhood|singleton|grouped|component-total|overlapping clue)\b/ },
      { label: "constraint-inference", pattern: /\b(subset|pairwise|constraint|closure|inference|forced|reveal|flag)\b/ },
      { label: "search-limits", pattern: /\b(limit|limits|prune|root selection|cover more|exact-solver path)\b/ },
    ],
    stopwords: ["current", "dense", "denser", "expert-dense", "constrained", "slightly"],
  },
  hooks: createJsonCommandHooks({
    checkCommand: ["pnpm", "check"],
    searchCommand: ["pnpm", "score:search", "--", "--json"],
    evalCommand: ["pnpm", "score", "--", "--json"],
    holdoutCommand: ["pnpm", "score:holdout", "--", "--json"],
    candidatePath: "solver",
    primaryPath: "winRate",
    secondaryPath: "progressScore",
    behaviorFingerprintPath: "behavior.fingerprint",
    behaviorUnitsLabelPath: "behavior.unitsLabel",
    behaviorObservedUnitsPath: "behavior.observedUnits",
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
  searchCompare: meaningfulSearchCompare,
  holdoutCompare: holdoutGuard,
});
