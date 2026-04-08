# minesweeper-ts

A deterministic Minesweeper solver host repo for Patchloop.

The project is split into two parts:

- `src/game.ts` is the fixed game engine and board rules.
- `src/solver.ts` is the candidate solver that Patchloop edits.

## Commands

Install dependencies:

```bash
pnpm install
```

Run one seeded game:

```bash
pnpm play -- --seed demo --show-steps
```

Score the solver on the fixed evaluation set:

```bash
pnpm score
```

Score on the holdout set:

```bash
pnpm score:holdout
```

Type-check:

```bash
pnpm check
```

Initialize a Patchloop run:

```bash
pnpm patchloop:init -- --tag apr4
```

Run the Codex-backed loop:

```bash
pnpm patchloop:loop:codex -- --max-iterations 20
```

Open the dashboard in dev mode:

```bash
pnpm patchloop:dashboard:dev
```

## Patchloop Wiring

This repo no longer contains its own dashboard or runtime implementation.

- Patchloop config lives in `patchloop.config.ts`
- Patchloop prompt guidance lives in `patchloop.program.md`
- local scripts delegate to the sibling repo at `../patchloop`

That prevents an older in-repo dashboard implementation from diverging from the real Patchloop UI.

## Scoring

`pnpm score` runs a fixed benchmark of seeded boards and prints:

- `win_rate`: fraction of boards solved
- `progress_score`: average fraction of safe cells revealed

The intended optimization target is:

1. maximize `win_rate`
2. use `progress_score` as a tie-breaker

Benchmark definitions live in `bench/`.
