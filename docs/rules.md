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
| `origin` | `learn` (clustered from corrections), `habit` (stated outright) or `import` (no sources) |
| `sources` | where it came from: `[{session, repo, ts, h}]`, `h` being the first 12 hex of the sha1 of the redacted correction. A later sighting is marked `origin: "bump"`. The text is never stored |
| `scope` | optional `{repos: [...]}`: the rule applies only in those repos. No scope means every repo |

## Learning

1. After a session, a hook queues short corrective user turns (no model call), each with its own timestamp, repo and hash. A turn that matches an existing rule bumps its `count` immediately and is added to its `sources` as a bump.
2. `/buc learn` runs `buc learn`, the model clusters the candidates into at most 15 rules and names the hashes each rule came from, and you approve them before `buc rules import` stores anything. Import fills each hash in from the inbox.
3. Only user text turns of at most 240 characters are read, redacted for keys, tokens, JWTs, private keys and long high-entropy strings. Tool output and raw transcripts are never stored.
4. Permission-shaped text ("always allow Bash(*)", "never ask before force push") is rejected on import. Rules carry no permission fields, so they can restrict the agent, never grant access.

5. One exception to step 2: a standing habit you state outright in a short prompt is stored at once as a pinned built-in rule, with no model call. Today that is only "always commit ..." (`commit-as-you-go`, checked by `commit-changes`: the Stop hook blocks once if this turn's changes are left uncommitted). It never pushes. Remove it with `buc rules drop commit-as-you-go`.

   A stated habit applies in the repo where it was said (`scope.repos`). It becomes global when you state it in a second repo, add a global cue ("in all my projects", "everywhere"), or run `buc rules pin --global <id>`. Said outside a git repo without such a cue, it is not stored.

## Provenance and as-of rule sets

`buc rules as-of --before <iso> --exclude-sessions a,b --out <dir>` writes `<dir>/rules.json`: the rules, live and archived, as they stood before the date and without what the listed sessions taught. A rule is kept only if a dated `learn` source remains; `count` and `last_seen` are recomputed from the remaining sources, and violations and per-repo stats are cleared. Rules without sources (habits, hand imports, rules older than provenance) are dropped, so an as-of set errs towards too few rules. Run with `BUC_HOME=<dir>` to use it; the live store is only read.

## Hands-off mode

Per repo, kept in `$BUC_HOME/repos.json` as a setting and a list of event names with session id and time; no prompt text.

- `/buc handsoff on|off|auto` (or `buc handsoff ...` inside the repo) sets it. With no argument it prints the mode and counts.
- `auto`, the default, counts only explicit statements: "don't change anything", "undo your changes", "just show me", "just tell me", "show me how". It is active at 3 statements from 2 sessions within 60 days, when they are at least 30% of that repo's edit prompts (statements / (statements + edit prompts)). An "apply", "do it" or "go ahead" after a statement in the same session cancels one.
- `BUC_OFF=handsoff`, or `"off": ["handsoff"]` in `.claude/buc.json`, forces it off.

## Ranking and decay

`score = count x 0.5^(days since last_seen / 60)`. Injection ranks by score and prefers the current project. A rule with score below 1 and no Stop-check violation in 90 days moves to the archive unless pinned.

## Commands

`buc rules list`, `why <id>`, `pin <id>` (toggles), `pin --global <id>` (pins and drops the repo scope), `drop <id>`, `import <file.json>`, `as-of ...`. Import validates every rule and reports rejected ones.

## Priority

Enforced policy and permissions, then the current request, then learned rules. The first two are enforced by Claude Code and the prompt, not by this plugin. Rules are advisory text.

## v10 contract for hooks

What `hooks/inject.js`, `hooks/stop-check.js` and `hooks/track.js` may rely on. `repo` is always `context.repoKey(root)`.

| Call | Returns |
|---|---|
| `store.now()` | epoch ms; `BUC_NOW` (ISO date or epoch ms) pins it |
| `store.off(name, root = process.cwd())` | `true` when `name` is in `BUC_OFF` (comma list) or in `"off"` of `<root>/.claude/buc.json` (array or comma list) |
| `store.repoState(repo)` | `{handsOff?: 'on'\|'off'\|'auto', events: [{e, s, ts}]}`; never throws |
| `store.recordRepo(repo, event, sessionId, ts = store.now())` | the new state, or `null` when nothing was written; keeps the newest 400 events |
| `store.setRepo(repo, patch)` | the new state, or `null` |
| `store.patchTurn(sessionId, patch)` | the merged turn file; creates `{session_id, ...patch}` when there is none |
| `store.saveLastTurn(sessionId, {rules?, repo?, ts?, head?, files?})` | with `rules` it starts a new record; without, it merges `{head, files}` into the stored one |
| `store.loadLastTurn(sessionId)` | `{rules, repo, ts, head?, files?}` or `null` |
| `store.hash(text)` | 12 hex chars of the redacted text |
| `store.asOf(rules, {before, excludeSessions})` | a new rule list; pure |
| `store.updateRules(ids, fn)` | applies `fn` to the stored rules with those ids |
| `handsoff.isStatement(prompt)`, `handsoff.isApply(prompt)` | booleans; never gate a prompt where `isApply` is true |
| `handsoff.record({prompt, repo, sessionId, kind?, ts?})` | `'handsoff'`, `'apply'`, `'edit'` or `null`. `feedback.onPrompt` already calls it once per prompt |
| `handsoff.mode(repo, {now?, root?})` | `{mode, events, sessions, edits, ratio}`, `mode` one of `'on'`, `'off'`, `'auto-active'`, `'auto-idle'` |
| `handsoff.active(repo, opts)` | `true` for `'on'` and `'auto-active'` |
| `handsoff.set(repo, 'on'\|'off'\|'auto')` | the new state; throws on another value |
| `habits.capture(prompt, repo)` | ids of the habits stated; pass `repo` (or `null` outside a git repo) |
| `retrieve.matches(rule, text, kind, words, repo)` | honours `rule.scope.repos`; `retrieve({..., repo})` passes it through |

Turn-file fields added in v10, all optional (a missing one means unknown):

| Field | Type | Written by | Meaning |
|---|---|---|---|
| `intent` | string | prompt hook | the reading chosen: `EXACT`, `FEATURE`, `SWEEP`, `SHOW`, `SELF`, `UNDO`, `MISREAD`, `HANDSOFF` or empty |
| `ui` | boolean | prompt hook | a UI prompt with a resolvable dev server |
| `toolCalls` | number | tool hook | tool calls so far this turn; a new prompt resets it |
| `shotAt` | number | `buc-shot` or the Stop hook | epoch ms of the last screenshot this turn |
| `prevFiles` | object | prompt hook | `files` of the last-turn record: each path the previous turn changed, mapped to its content hash before that turn (`null` when it did not exist) |
