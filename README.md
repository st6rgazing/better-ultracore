# better-ultracore

A Claude Code plugin that keeps the main session on the task and teaches it your corrections. A hook injects a few learned rules before each prompt, a Stop hook checks the result once, and subagents run only for parallel work or on request. It also ships a CI release preflight.

## How it works

- **Prompt hook.** Before each prompt, `hooks/inject.js` picks at most 5 matching learned rules (about 200 tokens), adds one line if a named branch is behind origin, and adds the check command. It makes no model call and prints nothing when nothing matches.
- **Stop hook.** `hooks/stop-check.js` runs the deterministic checks of the matched rules against the diff. On failure it blocks once with the failing rule and file, so the model revises once. It never blocks a second time. Judgment checks are injected as yes/no questions the model answers before it finishes.
- **Subagents only when needed.** Parallel work (2 or more numbered parts on disjoint files) fans out to at most 3 workers. `/buc deep` adds one read-only critic that reviews the diff and probes edge inputs. Everything else runs inline.
- **Learning.** `buc learn` mines short corrective turns from your transcripts; you approve the clustered rules before they are stored. A SessionEnd hook queues new candidates with no model call.

## Commands

| Command | What it does |
|---|---|
| `/better-ultracore:buc run <task>` | Do the task inline; use the workflow only for numbered parts on disjoint files |
| `/better-ultracore:buc deep <task>` | Do the task inline, then one critic agent reviews the diff and probes edge inputs |
| `/better-ultracore:buc learn` | Cluster mined corrections into at most 15 rules, show them, store them after your OK |
| `/better-ultracore:buc rules <sub>` | `list`, `why <id>`, `pin <id>`, `drop <id>`, `import <file>` |
| `/better-ultracore:buc preflight [opts]` | Explicit opt-in: secret scan, production build, browser test, ASVS checks |

`/buc prefs` now points to `rules`. See [docs/rules.md](docs/rules.md).

## Install

Requirements: Claude Code 2.1.322 or later, Node 20+, git.

Try it for one session without installing:

```bash
claude --plugin-dir ~/Desktop/better-ultracore
```

Install for this project only (writes `.claude/settings.local.json` in the current folder):

```bash
claude plugin marketplace add ~/Desktop/better-ultracore --scope local
```

```bash
claude plugin install better-ultracore@better-ultracore-local --scope local
```

Use `--scope user` instead of `--scope local` on both commands to install for every project. Remove it with `claude plugin uninstall better-ultracore@better-ultracore-local --scope local`.

## Privacy

- Rules live in `~/.better-ultracore` (override with `BUC_HOME`), never in a repo.
- `buc learn` reads only short user turns (at most 240 characters), redacted for keys, tokens, JWTs, private keys and long high-entropy strings. Tool output and raw transcripts are never stored.
- Permission-shaped text ("always allow Bash(*)") is dropped, and rules have no permission fields. Rules can restrict the agent, never grant access.

## Limits

| Limit | Default | Enforcement |
|---|---|---|
| Worker launches | 6 per run | Enforced by the workflow counter |
| Stalled worker | 1 retry | Enforced. A second stall returns `partial` with completed steps, never an empty result |
| Write outside assigned files | n/a | Fails that item. Checked from the worker's reported `changed_files` after the fact, not prevented |
| Critic read-only | n/a | Enforced by the critic's tools allowlist (no Edit, Write). Plugin subagents ignore `permissionMode`, `hooks` and `mcpServers` frontmatter ([docs](https://code.claude.com/docs/en/sub-agents)) |
| Stop-hook revision | 1 | Enforced by `stop_hook_active`. Remaining failures are shown to you |
| Elapsed time | 30 min | Advisory inside the workflow. Enforced only by `bin/buc run-headless --timeout-min` |
| Tokens / cost | none | `run-headless` passes `--max-budget-usd 1`. With a `+Nk` budget, optional launches are skipped when little remains. Otherwise advisory |
| Rules | n/a | Advisory text. Only the built-in deterministic checks are enforced |

Details: [docs/limits.md](docs/limits.md).

## Trade-off: no automatic security routing

v1 sent requests containing words like `auth` or `password` to a verifier agent. v2 removes that routing and the automatic secret scan after edits. Risky changes get the adversarial edge-input probe only on `/buc deep`. Without it, expect risky-case safety to match plain Claude Code. Use `deep` for auth, payments and migrations.

## Release preflight

```bash
node bin/buc preflight --dir fixtures/vite-express --base origin/main --head HEAD --out .buc/preflight
```

Statuses are `passed`, `failed`, `not_applicable` and `unverified`. Exit is 1 when any required check is `failed` or `unverified`. Secret findings report rule, file, line and an 8-character fingerprint, never the value. Fingerprints are salted per repo by default.

- The lying-UI e2e check was run locally (`npm --prefix fixtures/vite-express run e2e` passes, `VITE_LYING_UI=1` fails) and runs in CI.
- CI: [.github/workflows/preflight.yml](.github/workflows/preflight.yml)
- Promote the exact artifact you tested: [examples/promote.yml](examples/promote.yml)
- What needs GitHub or hosting setup: [docs/preflight-setup.md](docs/preflight-setup.md)

## Tests

```bash
npm test
```

```bash
npm --prefix fixtures/vite-express install && npx --prefix fixtures/vite-express playwright install chromium
```

```bash
npm --prefix fixtures/vite-express run e2e
```

```bash
node bench/run.js --dry
```

The live benchmark spends real money. See [bench/README.md](bench/README.md).

## Results

Benchmark results against plain Claude Code: [docs/results.md](docs/results.md).

## Install from GitHub

```bash
claude plugin marketplace add st6rgazing/better-ultracore
```

```bash
claude plugin install better-ultracore@better-ultracore-local
```

## Research

What user reports changed in the design: [docs/research.md](docs/research.md).

## License

MIT
