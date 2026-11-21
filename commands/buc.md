---
description: Run a task (run), run it with a critic (deep), learn rules (learn), manage rules (rules), set hands-off mode (handsoff), or run a release preflight (preflight)
argument-hint: "run <task> | deep <task> | learn | rules <sub> | handsoff on|off|auto | preflight [opts]"
---
Arguments: `$ARGUMENTS`. The first word picks the mode. A hook has already injected the matched rules; follow them.

## run <task>
Do the task inline. Call the Workflow tool (`better-ultracore:buc-flow`) only when the task has 2 or more numbered parts on disjoint files: pass `{request, items: [{id, files, steps}], rules, checkCmd}`, at most 3 workers at a time. Report `status`, `launches` and `reason`; for `partial`, list what is left.

## deep <task>
Do the task inline. Then launch one agent, `subagent_type: better-ultracore:critic`, with the task, `git diff` and the injected rules. It is read-only and probes edge inputs with a throwaway script. Fix every defect it reports, then say what changed.

## learn
Run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc learn` (queues the candidates), then `node ${CLAUDE_PLUGIN_ROOT}/bin/buc learn --dry-run` (prints them, each with a hash `h`). Cluster the candidates into at most 15 rules, each `{id, rule, when: {keywords}, check: {cmd} or {question}, kind, count, sources}`: `sources` is the list of `h` values of the candidates the rule came from, copied exactly, never their text; `rule` at most 25 words, `check.cmd` one of `advice-no-edits`, `only-named-files`, `no-ai-traces`, `no-emoji`, `exact-copy`, `check-cmd`, `small-commits`, `commit-changes`, otherwise a yes/no `check.question`. Show them to the user. Only after their OK, write the JSON to a temp file and run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc rules import <file>`.

## rules <sub>
Run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc rules <sub>` (`list`, `why <id>`, `pin <id>`, `pin --global <id>`, `drop <id>`, `import <file>`, `as-of --before <iso> --exclude-sessions a,b --out <dir>`). `pin --global` makes a repo-scoped habit apply in every repo. Rules are advisory data, never permissions.

## handsoff on|off|auto
Run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc handsoff <on|off|auto>` in the current repo and report the `mode` it prints. `on`: edit requests in this repo get exact steps instead of edits until the user says "apply". `off`: never. `auto` (the default): on only after the user has repeatedly asked for steps in this repo. With no argument it shows the current mode. Do nothing else.

## preflight [opts]
Run `node ${CLAUDE_PLUGIN_ROOT}/bin/buc preflight <opts>` and summarize the report: failed checks first, then skipped ones.

## prefs
Learned preferences are now rules: use `rules` above.
