# Limits: enforced vs advisory

| Limit | Default | Enforcement |
|---|---|---|
| maxLaunches | 6 | Enforced. Counter in the workflow, incremented on every `agent()` call. The verifier slot on `guarded` runs is reserved first, so repairs and extra workers are denied before it is starved. |
| maxRepairs | 2 | Enforced. The repair loop also stops on an empty diff or a repeated failure signature (check name plus first error with numbers, paths and whitespace removed). |
| maxElapsedMin | 30 | Advisory inside a workflow (scripts have no clock) and in a plain `/buc run`; `context` only reports `startedAtMs` and `deadlineMs`. Enforced only when the run goes through `bin/buc run-headless --timeout-min N`, which sends SIGTERM and then SIGKILL. |
| blocker prefs | n/a | Listed as "Required checks (must pass before done)" in every worker brief and returned as `blockers` in the result for the command to report. Not machine-verified. |
| tokens | none | Enforced only with a `+Nk` budget (`budget.total`; optional launches are skipped when under 20000 remain) or `run-headless --max-budget-usd`. Otherwise advisory. |
| read-only review | on | Enforced by the `reviewer-ro` tools allowlist (Read, Grep, Glob). |

Every run returns a result, never an empty value: `status` is `done`, `partial`, `needs_user` or `failed`, with `launches`, `repairs`, `completed_steps` and `limits_report`. A worker that returns null is retried once with the same brief (counted as a launch); a second null ends the run as `partial`.

## Cancel and resume

Every `agent()` call has a stable label (`plan`, `code`, `code:repair1`, `verify`, `work:<id>`, `:retry` for stall retries). Completed labels are checkpointed.

1. Stop the run with TaskStop.
2. `bin/buc affected --steps <result.json> --files <a,b>` lists steps that touched the corrected files (`rerun`) and the rest (`keep`).
3. Resume with `resumeFromRunId`. Kept steps replay from the checkpoint; the correction goes into the new brief. Later messages are never treated as overrides by workers.

Launch and repair counters restart on resume, so a resumed run gets a fresh budget for the steps it reruns.
