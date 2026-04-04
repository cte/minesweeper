import { loadBenchmark } from "./benchmark.js";
import { runGame } from "./run-game.js";
import type { Solver } from "./types.js";

export interface FailedCase {
  id: string;
  suite: string;
  seed: string | number;
  status: string;
  progressScore: number;
  steps: number;
}

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
  failedCases: FailedCase[];
}

interface MutableSuiteStats {
  games: number;
  wins: number;
  stalled: number;
  progressSum: number;
  stepsSum: number;
}

export function evaluateBenchmark(benchmarkPath: string, solver: Solver): ScoreSummary {
  const benchmark = loadBenchmark(benchmarkPath);
  const startedAt = performance.now();

  let wins = 0;
  let stalled = 0;
  let progressSum = 0;
  let stepsSum = 0;
  const suiteStats = new Map<string, MutableSuiteStats>();
  const failedCases: FailedCase[] = [];

  for (const testCase of benchmark.cases) {
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

    if (!result.won) {
      failedCases.push({
        id: testCase.id,
        suite: testCase.suite,
        seed: testCase.seed,
        status: result.status,
        progressScore: result.revealedFraction,
        steps: result.steps,
      });
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
    solver: solver.name,
    games,
    wins,
    losses,
    stalled,
    winRate: games === 0 ? 0 : wins / games,
    progressScore: games === 0 ? 0 : progressSum / games,
    avgSteps: games === 0 ? 0 : stepsSum / games,
    elapsedMs,
    suites,
    failedCases,
  };
  if (benchmark.description !== undefined) {
    summary.description = benchmark.description;
  }
  return summary;
}
