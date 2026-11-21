# Learned rules

Rules are short corrections learned from your own transcripts. A hook injects the few that match the current prompt; the Stop hook checks the ones that have a deterministic check.

## Where they live

`$BUC_HOME/rules.json` (default `~/.better-ultracore/`), never in a repo. New candidates queue in `inbox.jsonl` there. Decayed rules move to `rules.archive.json`.

## Rule shape

| Field | Meaning |
|---|---|
| `id` | lowercase slug |
| `rule` | the instruction, at most 25 words |
| `when` | triggers: `keywords`, optional `paths` and `promptKinds` |
| `check` | `cmd`: a built-in id (`advice-no-edits`, `only-named-files`, `no-ai-traces`, `no-emoji`, `exact-copy`, `check-cmd`, `small-commits`, `commit-changes`), or `question`: a yes/no judgment check |
| `kind` | `process`, `ui`, `code`, `git`, `output` or `communication` |
| `count`, `last_seen`, `violations` | usage data used for ranking and decay |

## Learning

1. After a session, a hook queues short corrective user turns (no model call). A turn that matches an existing rule bumps its `count` immediately.
2. `/buc learn` runs `buc learn --dry-run`, the model clusters the candidates into at most 15 rules, and you approve them before `buc rules import` stores anything.
3. Only user text turns of at most 240 characters are read, redacted for keys, tokens, JWTs, private keys and long high-entropy strings. Tool output and raw transcripts are never stored.
4. Permission-shaped text ("always allow Bash(*)", "never ask before force push") is rejected on import. Rules carry no permission fields, so they can restrict the agent, never grant access.

5. One exception to step 2: a standing habit you state outright in a short prompt is stored at once as a pinned built-in rule, with no model call. Today that is only "always commit ..." (`commit-as-you-go`, checked by `commit-changes`: the Stop hook blocks once if this turn's changes are left uncommitted). It never pushes. Remove it with `buc rules drop commit-as-you-go`.

## Ranking and decay

`score = count x 0.5^(days since last_seen / 60)`. Injection ranks by score and prefers the current project. A rule with score below 1 and no Stop-check violation in 90 days moves to the archive unless pinned.

## Commands

`buc rules list`, `why <id>`, `pin <id>` (toggles), `drop <id>`, `import <file.json>`. Import validates every rule and reports rejected ones.

## Priority

Enforced policy and permissions, then the current request, then learned rules. The first two are enforced by Claude Code and the prompt, not by this plugin. Rules are advisory text.
