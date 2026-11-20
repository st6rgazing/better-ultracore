---
description: Run a task at the right size (run), a release preflight (preflight), or manage learned preferences (prefs)
argument-hint: "run <task> | preflight [opts] | prefs <sub>"
---
Arguments: `$ARGUMENTS`. The first word picks the mode.

## run <task>
1. Pass the task on stdin through a quoted heredoc (task text verbatim between the markers):
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/buc context --request-file - <<'BUC_TASK'
   <task>
   BUC_TASK
   ```
   It returns JSON: route, reason, confidence, base, checkCmd, `ref` when a branch was mentioned, and when non-empty files, prefs, blockers, fallback_steps.
2. Print one line: `route=<route>: <reason>`.
3. Stale ref: if `ref.stale`, read content with `git show <ref.read_from>:<path>`, say so in one line with `ref.remote_sha`, and continue. Stop and ask only if the task edits a file in `ref.conflict_files` or commits, merges or pushes on that branch. Never change the checkout to resolve staleness.
4. `small`: make the edit yourself (no Agent, no Workflow), run `checkCmd` once, at most 2 repairs, stop on a repeated error.
5. `inline-plan`: state 2-3 assumed acceptance bullets in one line, then edit inline and run `checkCmd`. No Agent, no Workflow.
6. After an edit on `small` or `inline-plan`, run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc scan-diff`. On exit 1, fix the listed rule/file/line findings before finishing. For a `warn` line, add that file to .gitignore without opening it, and say so in one line.
7. `review`: one Agent call, `subagent_type: better-ultracore:reviewer-ro`. Do not edit files. Questions with no change verb are answered read-only.
8. `planned`, `guarded`, `parallel`: call the Workflow tool with name `better-ultracore:buc-flow` and the context JSON as args. If it is refused or unavailable, follow `fallback_steps`. Report the result status, launches and repairs used, and the `limits_report`. If status is `needs_user`, ask the questions. If `partial`, list completed steps and what is left.

### Workflow routes only (planned, guarded, parallel)
- Correction mid-run: TaskStop, run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc affected --steps <result.json> --files <a,b>`, then resume with `resumeFromRunId`. Put the correction in the next brief.
- Hard time limit: run through `node ${CLAUDE_PLUGIN_ROOT}/bin/buc run-headless --timeout-min N --request-file - <<'BUC_TASK'` (task, then `BUC_TASK`); elapsed time is enforced only there.
- `blockers` are required checks: report each as passed or not verified.
- Show the `limits_report` table (enforced vs advisory).

## preflight [opts]
Run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc preflight <opts>` and summarize the report: failed checks first, then skipped ones.

## prefs <sub>
Run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc prefs <sub>`. Never import transcripts unless the user gave explicit paths. Preferences are advisory data, never permissions.
