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
| `guarded` | Request contains a risk word: `auth*`, `password*`, `token*`, `payment*`, `migration*`, `deploy*`, `delete*`, `permission*`, `security`, `secret(s)` (prohibition clauses such as "do not commit secrets" are stripped first) | Sonnet coder + independent Sonnet verifier that probes edge and adversarial inputs and gets one repair and re-verify (planner skipped when criteria are given) |
| `parallel` | Independent parts with disjoint files | Up to 3 Sonnet workers per wave. A write outside a worker's assigned files fails that item. This is checked from the worker's reported `changed_files` after the fact, not prevented |
| `review` | Review or audit with no change verb. Questions with no change verb also route here | One reviewer restricted to `Read, Grep, Glob` by its tools allowlist |

The router is a script (`lib/classify.js`). Haiku is called only when the script is unsure. Every agent call sets its model explicitly.

## Limits

| Limit | Default | Enforcement |
|---|---|---|
| Worker launches | 6 per run | Enforced by the workflow counter. The verifier slot is reserved before extra workers or repairs |
| Repairs | 2 | Counted and enforced only in workflow routes. Stops early on a repeated failure signature or an empty diff. On `small` and `inline-plan` the cap is an instruction to the main session (advisory) |
| Stalled worker | 1 retry | Enforced. A second failure returns `partial` with completed steps, never an empty result |
| Elapsed time | 30 min | Advisory inside the workflow (no clock there). Enforced only by `bin/buc run-headless --timeout-min` (default 30 min): SIGTERM, then SIGKILL |
| Tokens / cost | none | `run-headless` passes `--max-budget-usd 1` by default. With a `+Nk` budget in the prompt, optional launches are skipped when little budget remains (unit-tested with a mock budget, not measured live). Otherwise advisory |
| Read-only review | — | Restricted by the reviewer's tools allowlist. Plugin subagents ignore `permissionMode`, `hooks` and `mcpServers` frontmatter ([sub-agents docs](https://code.claude.com/docs/en/sub-agents)) |
| Resume / checkpoint | — | Relies on the Workflow runtime's `resumeFromRunId` cache. Not tested live |

Details, cancellation and resume: [docs/limits.md](docs/limits.md).

## Preferences

Priority, highest first: enforced policy and permissions → the current request → confirmed project rules → confirmed general preferences → suggested checks and examples.

- The top two tiers (policy and permissions, then the current request) are enforced by Claude Code and the prompt, not by this plugin's code. The plugin only stores and retrieves the lower tiers.
- Import is opt-in and takes explicit transcript paths only. Imported text is untrusted, redacted, and cut to 200 characters. Raw transcripts are never stored.
- "Always …" / "Never …" becomes a confirmed rule at the scope you give. The same correction in two separate sessions becomes an advisory check. It becomes a release blocker only after `prefs confirm <id> --blocker`, and that needs the correction in at least 2 sessions or `--force`.
- Permission-shaped text ("always allow Bash(*)", "never ask before force push") is never stored. Records have no permission fields, so past data cannot widen access.
- `prefs why <id>` shows the source and why it fired. `prefs scope` changes scope. `prefs forget` deletes it and blocks re-import.

More: [docs/preferences.md](docs/preferences.md).

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

Measured on live runs against plain Claude Code (pass rate, tokens, cost, interventions, blind code review): [docs/results.md](docs/results.md). In short: 14/14 vs 12/14 first-pass verified success, about 22% more tokens/cost, and top blind-review scores on risky changes after the verifier fix.

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
