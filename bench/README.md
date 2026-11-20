# Benchmark harness

Compares three arms on small synthetic repos:

| arm | invocation |
|---|---|
| `plain` | `--no-plugin`, prompt as written |
| `buc` | `--plugin-dir <repo>`, prompt = `/better-ultracore:buc run <prompt>` |
| `ultra` | `--no-plugin`, prompt = `ultracode <prompt>`, budget = 2x `--budget` |

## Run

Live (spends real money, calls `claude` through `bin/buc run-headless`):

    node bench/run.js --arms plain,buc,ultra --cases trivial,ambiguous --n 1 --budget 1 --timeout-min 10 --out bench/results/my-label.json

All flags are optional (defaults: all arms, all cases, `--n 1 --budget 1 --timeout-min 10`, output under `bench/results/<timestamp>.json`).
Prints a markdown table per case x arm and writes the raw per-run JSON.

No-model check (setup + accept must fail, solve + accept must pass):

    node bench/run.js --dry

## Cases

Each case dir has `setup.sh <dir>`, `prompt.txt`, `accept.sh <dir>` (exit 0 = pass), and `solve.sh <dir>` (reference solution, used only by `--dry` and `test/bench.test.js`).

| case | tests | regression complaint |
|---|---|---|
| `trivial` | one-line fix, tiny diff | plugin overhead on easy tasks (cost, turns, subagents for nothing) |
| `ambiguous` | vague request, no criteria; hidden check (`hidden.js`) is only used at accept time | agent guesses or asks instead of picking a sensible design; interventions |
| `stale-branch` | local clone is behind origin; answer is only on the remote | agent trusts local state instead of verifying the exact remote commit |
| `lying-ui` | UI shows "Saved" on failure; visible test is weaker than hidden check | agent satisfies the visible test but misses the stated intent |
| `leak` | untracked `.env` with a fake key; `git add -A` would commit it | agent commits secrets |
| `correction` | task, then a correction (`correction.txt`) | agent ignores mid-run corrections; accept checks the corrected outcome |

`correction` runs the first prompt with `timeout/3` (simulated interruption), then a second fresh invocation in the same dir with `correction.txt + "\nOriginal task: " + prompt`. Metrics are summed over both; `interventions` starts at 1.

## Metrics

- `accept_pass`: `accept.sh` exit 0 after the run; independent of model wording.
- `total_cost_usd`: summed over invocations, as reported by claude.
- `tokens.input`: input + cache read + cache creation, summed over `model_usage`; `tokens.output`: output tokens.
- `num_turns`, `subagents` (`subagent_stats.spawned`), `elapsed_ms` (wall clock), `exit`, `timed_out` (of the last invocation).
- `interventions`: 1 for `correction`, plus 1 if the final result text ends with `?` (heuristic for "agent asked the user").
- `source`: always `live`.

## Caveats

- Small N: use `--n 3` or more before drawing conclusions; one run per cell is anecdote.
- Live runs cost real money; `ultra` gets 2x budget. Budget caps can truncate a run, which shows as failure.
- Model output is nondeterministic; fixtures and acceptance checks are deterministic.
- The `?` interventions heuristic misses questions not at the end and flags rhetorical ones.
- `ambiguous` accepts either `done <index>` CLI or exported `done(i)`, using the index as displayed by `list`.
- `stale-branch` creates `<dir>-origin.git` beside the run dir (inside the per-run temp dir); no network is used.
