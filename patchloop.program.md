# Minesweeper solver

This repo is a Patchloop host project.

## Editable Scope

Only edit:

- `src/solver.ts`

Do not edit:

- `src/game.ts`
- `src/run-game.ts`
- `src/benchmark.ts`
- `src/score.ts`
- anything in `bench/`
- Patchloop config or scripts unless the run explicitly targets integration work

Those files are the fixed environment and evaluation harness.

## Goal

Improve the solver on the fixed evaluation benchmark.

Patchloop now runs three benchmark layers:

- `pnpm score:search` as a broad cheap discriminator
- `pnpm score` as the main acceptance benchmark
- `pnpm score:holdout` as the generalization guard

Primary metric:

- `win_rate` from `pnpm score`

Secondary tie-breaker:

- `progress_score` from `pnpm score`

Higher is better for both.

## Workflow

Initialize a run from a clean branch:

```bash
pnpm patchloop:init -- --tag apr4
```

Run the outer loop with Codex:

```bash
pnpm patchloop:loop:codex -- --max-iterations 20
```

Open the dashboard:

```bash
pnpm patchloop:dashboard:dev
```

## Constraints

- The solver may use stochastic logic when it helps, but benchmark behavior should stay reproducible for a fixed board seed.
- The solver must not use external services.
- The solver must return legal moves only.
- Prefer simpler logic when scores are equal.
- Do not chase a tiny `progress_score` bump by overfitting one frontier-guess variant if it weakens holdout behavior.
