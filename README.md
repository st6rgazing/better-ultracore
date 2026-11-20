# better-ultracore

A Claude Code plugin that sizes the work to the task. Small, clear edits run inline with one focused check. Vague or multi-file work gets one Fable plan, then a Sonnet coder. Risky work adds one independent verifier. Hard limits stop runaway fan-out, repeated repair loops and stalled workers. It also ships learned preferences and a CI release preflight.

One command, three entry points:

| Entry point | What it does |
|---|---|
| `/better-ultracore:buc run <task>` | Resolve repo state once, pick a route, do the task, report status and limits |
| `/better-ultracore:buc preflight [opts]` | Secret scan (commits + built assets + source maps), production build, browser test, ASVS checks |
| `/better-ultracore:buc prefs <sub>` | Import, list, explain, rescope, confirm or forget learned preferences |

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

Use `--scope user` instead of `--scope local` on both commands to install for every project.

Remove it:

```bash
claude plugin uninstall better-ultracore@better-ultracore-local --scope local
```

## Run

```text
/better-ultracore:buc run In greet.js make greet return 'Hello, <name>!'. Acceptance: node test.js prints ok.
/better-ultracore:buc run Look at main and tell me what changed in the auth module.
/better-ultracore:buc preflight --dir . --base origin/main --head HEAD
/better-ultracore:buc prefs import ~/.claude/projects/<project>/<session>.jsonl --dry-run
/better-ultracore:buc prefs why <id>
```

The CLI behind the command also runs on its own:

```bash
node bin/buc context --request-file - <<'EOF'
Change the default port to 8080 in server.js
EOF
```

## Routes

| Route | When | Agents |
|---|---|---|
| `small` | Concrete change, criteria or one named file | None. The main session edits and runs the check |
| `inline-plan` | Short request with no criteria, one file at most | None. States 2–3 assumed acceptance bullets, then edits |
| `planned` | Vague, multi-sentence or multi-file | Workflow `buc-flow`: Fable planner, then Sonnet coder |
| `guarded` | Auth, payments, secrets handling, migrations, deploys | Sonnet coder + independent Sonnet verifier (planner skipped when criteria are given) |
| `parallel` | Independent parts with disjoint files | Up to 3 Sonnet workers, one writer per file |
| `review` | Review or audit with no change verb | One read-only reviewer (`Read, Grep, Glob` only) |

The router is a script (`lib/classify.js`). Haiku is called only when the script is unsure. Every agent call sets its model explicitly.

## Limits

| Limit | Default | Enforcement |
|---|---|---|
| Worker launches | 6 per run | Enforced by the workflow counter. The verifier slot is reserved before extra workers or repairs |
| Repairs | 2 | Enforced. Stops early on a repeated failure signature or an empty diff |
| Stalled worker | 1 retry | Enforced. A second failure returns `partial` with completed steps, never an empty result |
| Elapsed time | 30 min | Advisory inside the workflow (no clock there). Enforced only by `bin/buc run-headless --timeout-min` |
| Tokens / cost | none | Enforced only by a `+Nk` budget in the prompt or `run-headless --max-budget-usd` |
| Read-only review | — | Enforced by the reviewer's tool allowlist (plugin agents ignore `permissionMode`) |

Details, cancellation and resume: [docs/limits.md](docs/limits.md).

## Preferences

Priority, highest first: enforced policy and permissions → the current request → confirmed project rules → confirmed general preferences → suggested checks and examples.

- Import is opt-in and takes explicit transcript paths only. Imported text is untrusted, redacted, and cut to 200 characters. Raw transcripts are never stored.
- "Always …" / "Never …" becomes a confirmed rule at the scope you give. The same correction in two separate sessions becomes an advisory check. It becomes a release blocker only after `prefs confirm <id> --blocker`.
- Permission-shaped text ("always allow Bash(*)", "never ask before force push") is never stored. Records have no permission fields, so past data cannot widen access.
- `prefs why <id>` shows the source and why it fired. `prefs scope` changes scope. `prefs forget` deletes it and blocks re-import.

More: [docs/preferences.md](docs/preferences.md).

## Release preflight

```bash
node bin/buc preflight --dir fixtures/vite-express --base origin/main --head HEAD --out .buc/preflight
```

Statuses are `passed`, `failed`, `not_applicable` and `unverified`. Exit is 1 when any required check is `failed` or `unverified`. Secret findings report rule, file, line and an 8-character salted fingerprint, never the value.

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

## Research

What user reports changed in the design: [docs/research.md](docs/research.md).

## License

MIT
