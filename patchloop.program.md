# deterministic Minesweeper solver

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

- The solver must remain deterministic.
- The solver must not use randomness or external services.
- The solver must return legal moves only.
- Prefer simpler logic when scores are equal.
