# Limits: enforced vs advisory

| Limit | Default | Enforcement |
|---|---|---|
| maxLaunches | 6 | Enforced. Counter in the workflow, incremented on every `agent()` call, including stall retries. |
| stalled worker | 1 retry | Enforced. A second null returns `partial` with completed steps, never an empty result. |
| write outside assigned files | n/a | Fails that item. Checked from the worker's reported `changed_files` after the fact, not prevented. |
| critic read-only | on | Enforced by the `critic` tools allowlist (Read, Grep, Glob, Bash; no Edit or Write). Plugin subagents ignore `permissionMode`, `hooks` and `mcpServers` frontmatter ([docs](https://code.claude.com/docs/en/sub-agents)), so the allowlist is the only restriction. Bash is there so the critic can run its probe script from the OS tmpdir. |
| Stop-hook revision | 1 | Enforced. The hook never blocks and never adds feedback when `stop_hook_active` is true; remaining failures are shown to the user. A block and a soft note both use up the one continuation. |
| deterministic rule checks | per rule | Enforced by the Stop hook for the built-in check ids only. |
| built-in hard checks | on | Enforced: the Stop hook blocks once. `undo-restored`, `handsoff-no-edits`, `sweep-residue`, `no-test-weakening`, `conflict-or-debugger`. They run on every turn that has a baseline in the turn file, with no rule needed. |
| built-in soft checks | on | Advisory: returned as Stop `additionalContext`, never a `decision`. `ended-with-question`, `wide-diff`, `sweep-scope`. |
| typecheck | on when the repo has the script | Blocks only when the output names a file changed this turn. A failure elsewhere passes with a note. |
| switching a check off | n/a | Each check id is a `BUC_OFF` name (comma list), also `"off"` in `.claude/buc.json`. `shot` turns off the Stop screenshot, `budget` the tool-call notice. |
| tool-call budget | 20 or 45 | Advisory. `hooks/track.js` on `PostToolBatch` counts tool calls per turn and says so once at the budget and once at twice it: 20 on a turn with a fixed reading or a correction, 45 otherwise. `"toolBudget"` in `.claude/buc.json`: a number, `{small, large}` or `false`. Subagent calls are not counted. Nothing is stopped. |
| screenshot | 60 s, 45 s at Stop | `bin/buc-shot` waits 20 s for the server, stops the server it started on every path (also when killed), and exits 0 with `skipped:` when there is no engine or server. A server that already answered is used and left running. |
| judgment checks, rule text | n/a | Advisory. Injected as text and yes/no questions. |
| maxElapsedMin | 30 | Advisory inside a workflow (scripts have no clock). Enforced only through `bin/buc run-headless --timeout-min N` (SIGTERM, then SIGKILL). |
| tokens | none | `run-headless` passes `--max-budget-usd 1` by default. With a `+Nk` budget (`budget.total`), optional launches (second wave onward, the critic) are skipped when under 20000 remain; unit-tested with a mock budget, not measured live. Otherwise advisory. |
| resume / checkpoint | n/a | Relies on the Workflow runtime's `resumeFromRunId` cache. Not tested live. |

## Stop checks

| Check | Kind | Fires when |
|---|---|---|
| `undo-restored` | hard | The turn's intent is `UNDO` and a file the previous turn changed differs from its state before that turn. Needs `prevFiles` in the turn file. |
| `handsoff-no-edits` | hard | The intent is `HANDSOFF` (or no intent was recorded and the repo is hands-off) and files changed. An `apply` prompt is never held. |
| `sweep-residue` | hard | The intent is `SWEEP`, the prompt names a literal (`"A" to "B"`, a quoted string after remove or replace, or a code-like word), and `git grep -F` still finds it. Reports 3 hits. Lock files are skipped. |
| `no-test-weakening` | hard | A test file was removed (a move keeps its name and passes), or `.skip`, `.only`, `xit(` and the like were added to one, and the prompt does not mention tests. |
| `conflict-or-debugger` | hard | An added line starts with a conflict marker, or a `debugger` statement was added to a script file. |
| `ended-with-question` | soft | An edit prompt of at most 25 words with no destructive word, nothing changed, and the reply ends in `?`. |
| `wide-diff` | soft | The intent is `EXACT` or `LITERAL` and the turn changed over 5 files or 150 lines, tests and lock files aside. |
| `sweep-scope` | soft | An edit prompt with whole-scope words (`whole app`, `everywhere`, `all traces`, `every page` and the like, pasted blocks aside) changed 1 or 2 files, tests and lock files aside, or the end of the reply offers left-out work back (`say if you want`, `do you want me to`). A turn that changed nothing passes. |

Known gaps: a file that was already dirty when the turn began and was edited again is not seen as changed; `sweep-residue` cannot tell an intended leftover (a changelog entry) from a missed one, so its message allows a one-line reason.

## Screenshots

`bin/buc-shot [--path /route] [--click <selector>]... [--out file.png] [--audit] [--classes a,b]` prints `shot: <png>` first.

- Server, first match: `"ui": {"dev": "<command>", "url": "<url>"}` in `.claude/buc.json` (without `url` the command gets a free port as `$PORT` and `{port}`), the Playwright `webServer` (read as text, never executed), the repo's `node_modules/.bin/vite`. `"ui": false` turns screenshots off.
- Engine: the repo's Playwright, else an installed Chrome with `--headless=new --screenshot`. `--click` and `--audit` need Playwright; with Chrome they are reported as ignored.
- `--audit` prints at most 5 findings: horizontal overflow of the page, text clipped by its own box, overlapping interactive boxes. `--classes` limits element findings to those classes.
- Stop fallback: when a turn changed `css, scss, tsx, jsx, vue, svelte, html` files and ran no `buc-shot`, the Stop hook takes one of `/` with the audit limited to the classes in the turn's added lines, and returns the PNG path as `additionalContext`. A skipped screenshot says nothing.
- The fallback needs evidence that `/` shows the change: the turn must introduce a class (one found nowhere in the repo at the turn's baseline commit) or change the style rule of one, and the captured page must have one of those; an old class on new markup does not count (Playwright waits up to 3 s for a visible element; Chrome looks in a `--dump-dom`). Otherwise the hook takes or keeps no image and says nothing, so a change on another route, behind a click, with no visual part, or built only from existing utility classes gets no fallback look.
- Limits: a root screenshot shows nothing about a deep state unless `--click` reaches it. Chrome captures at page load, so a slow client render can come out blank. Clipped text behind `text-overflow: ellipsis` is treated as intended.

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
