import { createHash } from "node:crypto";

import { loadBenchmark } from "./benchmark.js";
import { createRng } from "./rng.js";
import { runGame } from "./run-game.js";
import type { SolverFactory } from "./types.js";

export interface BenchmarkCaseScore {
  id: string;
  suite: string;
  seed: string | number;
  status: string;
  won: boolean;
  progressScore: number;
  steps: number;
}

export interface FailedCase extends BenchmarkCaseScore {}

export interface SuiteScore {
  suite: string;
  games: number;
  wins: number;
  losses: number;
  stalled: number;
  winRate: number;
  progressScore: number;
  avgSteps: number;
}

export interface ScoreSummary {
  benchmark: string;
  description?: string;
  solver: string;
  games: number;
  wins: number;
  losses: number;
  stalled: number;
  winRate: number;
  progressScore: number;
  avgSteps: number;
  elapsedMs: number;
  suites: SuiteScore[];
  cases: BenchmarkCaseScore[];
  failedCases: FailedCase[];
  behavior: {
    fingerprint: string;
    unitsLabel: "cases";
    observedUnits: number;
  };
}

interface MutableSuiteStats {
  games: number;
  wins: number;
  stalled: number;
  progressSum: number;
  stepsSum: number;
}

function behaviorFingerprint(benchmarkName: string, cases: BenchmarkCaseScore[]): string {
  const signature = cases
    .map((entry) => `${entry.id}|${entry.status}|${entry.won ? 1 : 0}|${entry.progressScore.toFixed(6)}|${entry.steps}`)
    .join("\n");
  return `sha256:${createHash("sha256").update(`${benchmarkName}\n${signature}`).digest("hex")}`;
}

export function evaluateBenchmark(benchmarkPath: string, createSolver: SolverFactory): ScoreSummary {
  const benchmark = loadBenchmark(benchmarkPath);
  const startedAt = performance.now();

  let solverName = "unknown";
  let wins = 0;
  let stalled = 0;
  let progressSum = 0;
  let stepsSum = 0;
  const suiteStats = new Map<string, MutableSuiteStats>();
  const cases: BenchmarkCaseScore[] = [];
  const failedCases: FailedCase[] = [];

  for (const testCase of benchmark.cases) {
    const solver = createSolver({
      config: testCase,
      random: createRng(`solver:${testCase.seed}`),
    });
    solverName = solver.name;
    const result = runGame(testCase, solver);
    wins += result.won ? 1 : 0;
    stalled += result.status === "stalled" ? 1 : 0;
    progressSum += result.revealedFraction;
    stepsSum += result.steps;

    const suite = suiteStats.get(testCase.suite) ?? { games: 0, wins: 0, stalled: 0, progressSum: 0, stepsSum: 0 };
    suite.games += 1;
    suite.wins += result.won ? 1 : 0;
    suite.stalled += result.status === "stalled" ? 1 : 0;
    suite.progressSum += result.revealedFraction;
    suite.stepsSum += result.steps;
    suiteStats.set(testCase.suite, suite);

    const caseScore: BenchmarkCaseScore = {
      id: testCase.id,
      suite: testCase.suite,
      seed: testCase.seed,
      status: result.status,
      won: result.won,
      progressScore: result.revealedFraction,
      steps: result.steps,
    };
    cases.push(caseScore);

    if (!result.won) {
      failedCases.push(caseScore);
    }
  }

  const games = benchmark.cases.length;
  const losses = games - wins - stalled;
  const elapsedMs = performance.now() - startedAt;

  const suites: SuiteScore[] = [];
  for (const [suiteName, suite] of suiteStats) {
    const suiteLosses = suite.games - suite.wins - suite.stalled;
    suites.push({
      suite: suiteName,
      games: suite.games,
      wins: suite.wins,
      losses: suiteLosses,
      stalled: suite.stalled,
      winRate: suite.games === 0 ? 0 : suite.wins / suite.games,
      progressScore: suite.games === 0 ? 0 : suite.progressSum / suite.games,
      avgSteps: suite.games === 0 ? 0 : suite.stepsSum / suite.games,
    });
  }

  const summary: ScoreSummary = {
    benchmark: benchmark.name,
    solver: solverName,
    games,
    wins,
    losses,
    stalled,
    winRate: games === 0 ? 0 : wins / games,
    progressScore: games === 0 ? 0 : progressSum / games,
    avgSteps: games === 0 ? 0 : stepsSum / games,
    elapsedMs,
    suites,
    cases,
    failedCases,
    behavior: {
      fingerprint: behaviorFingerprint(benchmark.name, cases),
      unitsLabel: "cases",
      observedUnits: cases.length,
    },
  };
  if (benchmark.description !== undefined) {
    summary.description = benchmark.description;
  }
  return summary;
}
