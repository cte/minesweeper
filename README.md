# minesweeper-ts

A small, deterministic Minesweeper solver harness designed for autonomous code improvement.

The project is split into two parts:

- `src/game.ts` is the fixed game engine and board rules.
- `src/solver.ts` is the candidate solver that you optimize.

The main feedback loop is:

1. edit `src/solver.ts`
2. run `pnpm score`
3. keep the change if the score improved

## Commands

Install dependencies:

```bash
pnpm install
```

Run one seeded game:

```bash
pnpm play -- --seed demo --show-steps
```

Initialize a dedicated research branch and record the baseline:

```bash
pnpm research:init -- --tag apr4
```

Score the solver on the fixed evaluation set:

```bash
pnpm score
```

Record the current solver into `results.tsv`:

```bash
pnpm record -- --description "baseline"
```

Evaluate a candidate solver edit and automatically keep or discard it:

```bash
pnpm research:trial -- --description "add stronger frontier guessing"
```

Run a provider-agnostic autonomous loop around an external editor command:

```bash
pnpm research:loop -- \
  --editor-command 'your-editor-command-here' \
  --max-iterations 20
```

Run the loop with Codex directly:

```bash
pnpm research:loop:codex -- --max-iterations 20
```

Score on the holdout set:

```bash
pnpm score:holdout
```

Type-check:

```bash
pnpm check
```

## Scoring

`pnpm score` runs a fixed benchmark of seeded boards and prints:

- `win_rate`: fraction of boards solved
- `progress_score`: average fraction of safe cells revealed, which acts as a tie-breaker

The intended optimization target is:

1. maximize `win_rate`
2. use `progress_score` as a secondary tie-breaker

The benchmark definitions live in `bench/`.

## Experiment Log

`pnpm record` evaluates the current solver on the main benchmark and the holdout benchmark, then appends a human-readable summary to `results.tsv` and a structured record to `.autoresearch/results.jsonl`.

The log is created automatically on first use and includes:

- git branch / commit
- whether the worktree was dirty
- eval and holdout metrics
- a free-form description

The reusable research runtime now lives in [packages/autoresearch](/Users/cte/Documents/Workspace/minesweeper-ts/packages/autoresearch). The Minesweeper app only provides:

- the benchmark commands in `src/score.ts`
- the editable target in `src/solver.ts`
- a thin project config in `src/autoresearch.ts`

## Branch Workflow

The intended autonomous workflow is branch-based and sequential:

1. Start from a clean `main`/`master`.
2. Run `pnpm research:init -- --tag apr4`.
3. This creates `autoresearch/apr4` and writes a baseline row to `results.tsv`.
4. Edit `src/solver.ts`.
5. Run `pnpm research:trial -- --description "what changed"`.
6. If the eval score improved, the script commits `src/solver.ts` on the run branch.
7. If the score did not improve, the script logs a discard row and restores `src/solver.ts` back to `HEAD`.

This keeps one branch per run and one commit per accepted improvement.

## Loop Driver

`pnpm research:loop` does not hard-code a specific AI provider. Instead it:

1. writes `.autoresearch/context.json`
2. writes `.autoresearch/prompt.txt`
3. runs your `--editor-command`
4. expects that command to edit only `src/solver.ts`
5. runs `research:trial`
6. logs per-iteration JSON in `.autoresearch/iterations/`

It passes these environment variables to the editor command:

- `AUTORESEARCH_PROJECT_ROOT`
- `AUTORESEARCH_BRANCH`
- `AUTORESEARCH_ITERATION`
- `AUTORESEARCH_SOLVER_PATH`
- `AUTORESEARCH_RESULTS_PATH`
- `AUTORESEARCH_CONTEXT_JSON`
- `AUTORESEARCH_PROMPT_FILE`
- `AUTORESEARCH_DESCRIPTION_FILE`
- `AUTORESEARCH_TRANSCRIPT_FILE`
- `AUTORESEARCH_CURRENT_TRANSCRIPT_FILE`

If the editor writes a one-line summary to `AUTORESEARCH_DESCRIPTION_FILE`, the loop uses it as the trial description. Otherwise it infers a description from the git diff.

During a Codex-backed run you can tail:

```bash
tail -f .autoresearch/current-codex.log
```

The loop also keeps per-iteration transcript files under:

```bash
.autoresearch/transcripts/0001.log
```

For a live browser view of the run, start:

```bash
pnpm research:dashboard
```

That serves a real-time dashboard with:

- current loop status
- best and latest scores
- recent decisions
- structured event history
- the live Codex transcript tail

## Codex Backend

The repo now includes a direct Codex backend:

- `pnpm research:codex-edit`
- `pnpm research:loop:codex`

`research:codex-edit` reads `.autoresearch/prompt.txt`, wraps it with Codex-specific instructions, and invokes `codex exec` in non-interactive mode.

Useful examples:

```bash
pnpm research:loop:codex -- --max-iterations 20
pnpm research:loop:codex -- --model gpt-5-codex --max-iterations 20
pnpm research:codex-edit -- --dry-run
```

By default the wrapper uses:

- `codex exec`
- `--full-auto`
- `--sandbox workspace-write`
- `--color never`

If you really want to bypass sandboxing, you can pass:

```bash
pnpm research:loop:codex -- --dangerously-bypass-approvals-and-sandbox
```
