---
description: Run a task at the right size (run), a release preflight (preflight), or manage learned preferences (prefs)
argument-hint: "run <task> | preflight [opts] | prefs <sub>"
---
Arguments: `$ARGUMENTS`. The first word picks the mode.

## run <task>
1. Pass the task on stdin through a quoted heredoc so quotes, backticks and `$(...)` in it are never interpreted by the shell (put the task text verbatim between the markers):
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/buc context --request-file - <<'BUC_TASK'
   <task>
   BUC_TASK
   ```
   (`prefs retrieve` accepts `--request-file -` the same way.) It returns JSON: route, reason, confidence, base, files, prefs, checkCmd, and `ref` when a branch was mentioned.
2. If `ref.stale` is true, tell the user the local branch is behind origin and stop, unless they asked to use the local copy.
3. Print one line: `route=<route>: <reason>`.
4. Route `small`: never call the Workflow tool. Make one Agent call with `subagent_type: better-ultracore:coder` and a short brief (task, files, checkCmd); if the Agent tool is unavailable, make the edit yourself. Then run `checkCmd` once. At most 2 repair attempts, and stop if the same error repeats.
5. Route `review`: one Agent call with `subagent_type: better-ultracore:reviewer-ro` (read-only tools). Do not edit files.
6. Routes `planned`, `guarded`, `parallel`: call the Workflow tool with name `better-ultracore:buc-flow` and the context JSON as args. If the Workflow tool is refused or unavailable, run the same route by hand: one `better-ultracore:planner` Agent call, then one `better-ultracore:coder` call, then (guarded) one `better-ultracore:verifier` call given the original request, `git diff <base>`, and a fresh check run.
7. Correction mid-run: stop the workflow with TaskStop, run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc affected --steps <result.json> --files <a,b>`, then resume the workflow with `resumeFromRunId` so unaffected steps replay from the checkpoint. Put the correction in the next brief, not as a live message to workers.
   For `planned`, `guarded` and `parallel`, if the user wants a hard time limit, run the whole task through `node ${CLAUDE_PLUGIN_ROOT}/bin/buc run-headless --timeout-min N --request-file - <<'BUC_TASK'` (task, then `BUC_TASK`) instead; elapsed time is enforced only there. `context.blockers` are required checks: report each one as passed or not verified.
8. Report the result status, launches/repairs used, and the `limits_report` table (enforced vs advisory). If status is `needs_user`, ask the questions. If `partial`, list completed steps and what is left.

## preflight [opts]
Run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc preflight <opts>` and summarize the report: failed checks first, then skipped ones.

## prefs <sub>
Run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc prefs <sub>`. Never import transcripts unless the user gave explicit paths. Preferences are advisory data, never permissions.
