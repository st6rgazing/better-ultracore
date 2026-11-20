# Limits: enforced vs advisory

| Limit | Default | Enforcement |
|---|---|---|
| maxLaunches | 6 | Enforced. Counter in the workflow, incremented on every `agent()` call. The verifier slot on `guarded` runs is reserved first, so repairs and extra workers are denied before it is starved. |
| maxRepairs | 2 | Counted and enforced only in workflow routes. On `small` and `inline-plan` it is an instruction to the main session (advisory). The repair loop also stops on an empty diff or a repeated failure signature (check name plus first error with numbers, paths and whitespace removed). |
| maxElapsedMin | 30 | Advisory inside a workflow (scripts have no clock) and in a plain `/buc run`; `context` only reports `startedAtMs` and `deadlineMs`. Enforced only when the run goes through `bin/buc run-headless --timeout-min N` (default 30), which sends SIGTERM and then SIGKILL. |
| blocker prefs | n/a | Listed as "Required checks (must pass before done)" in every worker brief and returned as `blockers` in the result for the command to report. Not machine-verified. |
| tokens | none | `run-headless` passes `--max-budget-usd 1` by default. With a `+Nk` budget (`budget.total`), optional launches are skipped when under 20000 remain; this is unit-tested with a mock budget, not measured live. Otherwise advisory. |
| read-only review | on | Restricted by the `reviewer-ro` tools allowlist (Read, Grep, Glob). Plugin subagents ignore `permissionMode`, `hooks` and `mcpServers` frontmatter ([docs](https://code.claude.com/docs/en/sub-agents)), so the allowlist is the only restriction. |
| resume / checkpoint | n/a | Relies on the Workflow runtime's `resumeFromRunId` cache. Not tested live. |

## Routes

| Route | When | Who does the work | Launches |
|---|---|---|---|
| `small` | short, criteria or a single named file | the main session edits inline, runs `checkCmd` once, max 2 repairs | 0 |
| `inline-plan` | short change, no criteria, at most one named file | main session states 2-3 assumed acceptance bullets in one line, then edits inline | 0 |
| `review` | review-only verb, or a question with no change verb | one read-only `reviewer-ro` agent | 1 |
| `planned` | vague, 3+ sentences without criteria, or 2+ files without criteria | Workflow: planner (fable), coder | 2 |
| `guarded` | one of `auth*`, `password*`, `token*`, `payment*`, `migration*`, `deploy*`, `delete*`, `permission*`, `security`, `secret(s)` outside a prohibition clause ("Do not commit secrets" is ignored) | Workflow: planner only when there are no criteria and not exactly one named file, then coder, verifier (probes edge and adversarial inputs; one repair and re-verify) | 2-3 |
| `parallel` | explicit independent parts | Workflow: planner, up to 3 coders per wave. A write outside a coder's assigned files fails that item; checked from reported `changed_files` after the fact | up to 6 |

The haiku router runs only when the route is missing or confidence is `uncertain`. After an inline edit (`small`, `inline-plan`) the command runs `buc scan-diff` (deterministic secret scan of the working-tree diff and untracked files, no tokens).

Every run returns a result, never an empty value: `status` is `done`, `partial`, `needs_user` or `failed`, with `launches`, `repairs`, `completed_steps` and `limits_report`. A worker that returns null is retried once with the same brief (counted as a launch); a second null ends the run as `partial`.

## Cancel and resume

Every `agent()` call has a stable label (`plan`, `code`, `code:repair1`, `verify`, `work:<id>`, `:retry` for stall retries). Completed labels are checkpointed.

1. Stop the run with TaskStop.
2. `bin/buc affected --steps <result.json> --files <a,b>` lists steps that touched the corrected files (`rerun`) and the rest (`keep`).
3. Resume with `resumeFromRunId`. Kept steps replay from the checkpoint; the correction goes into the new brief. Later messages are never treated as overrides by workers.

Launch and repair counters restart on resume, so a resumed run gets a fresh budget for the steps it reruns.
