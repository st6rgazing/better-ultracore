# Limits: enforced vs advisory

| Limit | Default | Enforcement |
|---|---|---|
| maxLaunches | 6 | Enforced. Counter in the workflow, incremented on every `agent()` call, including stall retries. |
| stalled worker | 1 retry | Enforced. A second null returns `partial` with completed steps, never an empty result. |
| write outside assigned files | n/a | Fails that item. Checked from the worker's reported `changed_files` after the fact, not prevented. |
| critic read-only | on | Enforced by the `critic` tools allowlist (Read, Grep, Glob, Bash; no Edit or Write). Plugin subagents ignore `permissionMode`, `hooks` and `mcpServers` frontmatter ([docs](https://code.claude.com/docs/en/sub-agents)), so the allowlist is the only restriction. Bash is there so the critic can run its probe script from the OS tmpdir. |
| Stop-hook revision | 1 | Enforced. The hook never blocks when `stop_hook_active` is true; remaining failures are shown to the user. |
| deterministic rule checks | per rule | Enforced by the Stop hook for the built-in check ids only. |
| judgment checks, rule text | n/a | Advisory. Injected as text and yes/no questions. |
| maxElapsedMin | 30 | Advisory inside a workflow (scripts have no clock). Enforced only through `bin/buc run-headless --timeout-min N` (SIGTERM, then SIGKILL). |
| tokens | none | `run-headless` passes `--max-budget-usd 1` by default. With a `+Nk` budget (`budget.total`), optional launches (second wave onward, the critic) are skipped when under 20000 remain; unit-tested with a mock budget, not measured live. Otherwise advisory. |
| resume / checkpoint | n/a | Relies on the Workflow runtime's `resumeFromRunId` cache. Not tested live. |

## When agents run

| Case | Who does the work | Launches |
|---|---|---|
| Any task | The main session, inline, with the injected rules | 0 |
| 2 or more numbered parts on disjoint files | Workflow `buc-flow`: up to 3 `worker` agents per wave; overlapping files go to later waves | one per part |
| `/buc deep` | Main session inline, then one `critic` with the task, the diff and the matched rules | 1 |

Every run returns a result: `status` is `done`, `partial` or `failed`, with `launches`, `reason`, `completed_steps` and `limits_report`. Every `agent()` call sets its model explicitly. There is no automatic security routing; see the README trade-off.

## Cancel and resume

Every `agent()` call has a stable label (`work:<id>`, `critic`, `:retry` for stall retries). Completed labels are checkpointed.

1. Stop the run with TaskStop.
2. `bin/buc affected --steps <result.json> --files <a,b>` lists steps that touched the corrected files (`rerun`) and the rest (`keep`).
3. Resume with `resumeFromRunId`. Kept steps replay from the checkpoint; put the correction in the new brief.

The launch counter restarts on resume.
