# Research notes (2026-11-20)

Short. Each finding names what it changed in the implementation.

| Source | Finding | Status | Changed in better-ultracore |
|---|---|---|---|
| anthropics/claude-code#92349 | Standing Ultracode instruction makes fan-out track the mode, not the task (325-agent settings audit). Subagents re-read files the parent already read (1.37B in / 2.69M out). Limit hits return `[]`/`null` with no partial work. | Closed by stale bot, not fixed | Router picks the smallest route and logs one-line reason. Context (SHA, files, prefs) resolved once by script and passed as args. Limit/null paths return `partial` with completed steps, never empty. |
| anthropics/claude-code#109799 | 36 subagents / 13.2M tokens drained Fable allowance; last run 0/12 finished, partial work hidden. | Open | Hard `maxLaunches` counter (default 6); Fable used for one plan call at most; partial report always emitted. |
| anthropics/claude-code#106667 | User steering relayed to writers, who treated it as an override and wrote nothing. Verify/fix loop kept going with no file changes; findings grew. All agents defaulted to session model. | Open | Workers' brief says later messages are not overrides; correction = stop + `buc affected` + resume. Repair loop stops on empty diff or repeated failure signature; max 2 repairs. Every `agent()` call sets `model` (lint test). |
| anthropics/claude-code#106641 | Desktop marks a worker "stalled" while it waits on a long Bash call. | Open | Stall = `agent()` returned null (real failure), not "slow". One retry, then partial. |
| anthropics/claude-code#106080 | Users want auto mode that decides per prompt whether to fan out and says why. | Open (feature request) | `route=<x>: <reason>` line on every run. |
| Reddit r/ClaudeAI 1uphv78, 1tquz3d | Could not fetch (Reddit blocks automated fetch). Duplicated exploration and stalled workers are treated as leads covered by the issues above. | Unverified | None directly. |
| Ultracode discussion (attached) | Not available in this session. | — | None. |
| "Independent review caught bugs" | No sampled issue says this. Kept as one targeted verifier on high-risk routes only, given original request + exact diff + fresh check output. | Unverified | Verifier only on `guarded` route; its launch reserved first. |

## Platform facts verified on Claude Code 2.1.322
- Plugins ship `workflows/*.js`, run as `/<plugin>:<meta.name>`. Scripts have no fs and no clock (`Date.now` throws) → elapsed limit is advisory in-workflow, enforced only by `bin/buc run-headless` wrapper.
- Plugin subagents ignore `permissionMode`/`hooks`/`mcpServers` frontmatter; `tools` allowlist is honored → read-only reviewer has `tools: Read, Grep, Glob`.
- `claude -p --output-format json` reports `total_cost_usd`, `usage`, `modelUsage`, `num_turns`, `subagent_stats`; `--max-budget-usd` is a documented hard cap.

## What the benchmark changed
- v1 buc cost 1.4-3x plain Claude because it spawned subagents that re-read context (the #92349 pattern itself). `small` and `inline-plan` now run inline.
- Stale branch: buc detected staleness but stopped to ask. It now reads `origin/<ref>` read-only and continues.
- Leak case routed `guarded` because of "Do not commit secrets". Prohibition clauses are now stripped before the risk test.
- `scan-diff` flagged a pre-existing `.env`. It now warns and the command gitignores the file without opening it.
