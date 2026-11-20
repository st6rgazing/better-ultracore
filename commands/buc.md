---
description: Run a task at the right size (run), a release preflight (preflight), or manage learned preferences (prefs)
argument-hint: "run <task> | preflight [opts] | prefs <sub>"
---
Arguments: `$ARGUMENTS`. The first word picks the mode.

## run <task>
1. Run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc context --request "<task>"`. It returns JSON: route, reason, confidence, base, files, prefs, checkCmd, and `ref` when a branch was mentioned.
2. If `ref.stale` is true, tell the user the local branch is behind origin and stop, unless they asked to use the local copy.
3. Print one line: `route=<route>: <reason>`.
4. If route is `small` and the change is a few lines, do it directly: one Agent call with `subagent_type: better-ultracore:coder` (Sonnet), then run `checkCmd`. No workflow.
5. Otherwise call the Workflow tool with name `better-ultracore:buc` and the context JSON as args.
6. Correction mid-run: stop the workflow with TaskStop, run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc affected --steps <result.json> --files <a,b>`, then resume the workflow with `resumeFromRunId` so unaffected steps replay from the checkpoint. Put the correction in the next brief, not as a live message to workers.
7. Report the result status, launches/repairs used, and the `limits_report` table (enforced vs advisory). If status is `needs_user`, ask the questions. If `partial`, list completed steps and what is left.

## preflight [opts]
Run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc preflight <opts>` and summarize the report: failed checks first, then skipped ones.

## prefs <sub>
Run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc prefs <sub>`. Never import transcripts unless the user gave explicit paths. Preferences are advisory data, never permissions.
