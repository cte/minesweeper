# minesweeper-ts

This repo is an autonomous solver-improvement harness.

## Editable Scope

Only edit:

- `src/solver.ts`

Do not edit:

- `src/game.ts`
- `src/run-game.ts`
- `src/benchmark.ts`
- `src/score.ts`
- anything in `bench/`

Those files are the fixed environment and evaluation harness.

## Goal

Improve the solver on the fixed evaluation benchmark.

Primary metric:

- `win_rate` from `pnpm score`

Secondary tie-breaker:

- `progress_score` from `pnpm score`

Higher is better for both.

## Experiment Loop

Initialize a run from a clean stable branch:

```bash
pnpm research:init -- --tag apr4
```

This creates `autoresearch/apr4` and records the baseline.

1. Inspect the current solver in `src/solver.ts`.
2. Make one coherent solver change.
3. Run:

```bash
pnpm research:trial -- --description "short note about this attempt"
```

4. If `win_rate` improves, the script commits the solver change.
5. If `win_rate` is unchanged but `progress_score` improves, the script also keeps it.
6. Otherwise the script logs a discard row and restores `src/solver.ts`.

If you want an outer automation loop, use:

```bash
pnpm research:loop -- \
  --editor-command 'your editor command here' \
  --max-iterations 20
```

That command will write context and prompt files under `.autoresearch/`, invoke the editor command, and feed the result into `research:trial`.

If you want to use Codex directly, use:

```bash
pnpm research:loop:codex -- --max-iterations 20
```

That is a thin wrapper around `research:loop` that uses `codex exec` as the editor backend.

## Constraints

- The solver must remain deterministic.
- The solver must not use external services or randomness.
- The solver must return legal moves only.
- Prefer simpler logic when scores are equal.
- Keep all accepted changes on the current `autoresearch/<tag>` branch. Do not create a new branch per iteration.
