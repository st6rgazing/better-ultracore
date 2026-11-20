# Results (2026-11-20)

All runs: Claude Code 2.1.322, Sonnet main model, `claude -p` through `bin/buc run-headless`, same fixture repo and the same hidden acceptance script for every arm. Fixtures are synthetic (`bench/cases/*/setup.sh`). Every number below comes from live model runs unless marked "fixture" or "unit test".

Arms:
- **plain**: Claude Code with no plugin.
- **buc**: `/better-ultracore:buc run <task>`.
- **ultra**: the same prompt prefixed with the `ultracode` keyword. In headless `-p` runs it never launched a subagent or workflow (0 of 28 runs), so this arm is **not** a faithful stock-Ultracode run. Treat it as plain Claude with the keyword. A real Ultracode comparison needs an interactive session.

Tokens are input (including cache reads and writes) plus output. They were counted twice: from the `claude -p` JSON and from every transcript file the run wrote, workflow agents included. The two counts matched exactly on every run.

N is 2 per cell (v1: N=1). Differences under 1.5× are noise.

## v2: first pass verified success, cost, interventions (42 runs)

| Arm | Passed | Total cost | Total tokens | User interventions* |
|---|---|---|---|---|
| plain | 12/14 | $1.91 | 3.26M | 2 |
| buc | **14/14** | $2.34 (+22%) | 4.57M (+40%) | 3 |
| ultra | 12/14 | $1.90 | 3.19M | 2 |

\* Both `correction` runs count 1 by design (a mid-run correction). buc's extra one was the leak case asking about a pre-existing `.env`; fixed (see below; rerun: 0).

The only pass-rate difference is **stale-branch** ("look at main"; origin is ahead of the local branch). plain and ultra read the stale local file and answered `1.0.0` in all 4 runs. buc fetched `origin/main` read-only, without touching the checkout, and answered `2.0.0` in both runs.

## v3: rerun after fixes, plus new cases (24 runs, all passed)

| Case | Route taken by buc | plain cost | buc cost | ultra cost |
|---|---|---|---|---|
| risky (md5 → scrypt) | guarded: workflow, coder + verifier | $0.115 | $0.224 | $0.113 |
| review (read-only) | review: read-only reviewer, repo untouched | $0.111 | $0.155 | $0.109 |
| planned (multi-step, code + docs) | planned: workflow, Fable plan + Sonnet coder | $0.169 | $0.356 | $0.201 |
| leak (env key, `.env` present) | inline + `scan-diff` | $0.119 | $0.144 | $0.121 |

## Code quality: blind review

An Opus judge saw each case's patches with the arm labels shuffled and hidden. It scored them 1–5 on correctness, minimality, readability and safety. The judge outputs are kept under `bench/results/` (gitignored).

v2 (7 cases, 42 patches), mean scores:

| Arm | Correctness | Minimality | Readability | Safety |
|---|---|---|---|---|
| plain | 4.29 | 4.79 | 4.64 | 4.79 |
| buc | **4.57** | 4.50 | 4.64 | 4.57† |
| ultra | 4.43 | 4.86 | 4.79 | 4.86 |

† One buc leak patch was marked "commits .env". That was a harness artifact: the fixture's untracked `.env` showed up in the patch. Acceptance confirmed no commit contained the key, and the harness now leaves setup-time untracked files out of patches.

The v2 review also found a real defect in the **risky** case. Both the buc and plain patches accepted a malformed stored hash (`scrypt$$` verified any password), and the buc verifier missed it. **Change:** the guarded verifier now writes a throwaway probe script for empty, malformed and truncated inputs. When it finds defects, the engine runs one repair and one re-verify, inside the launch and repair limits.

v3 after that change (risky, planned, leak; 18 patches), correctness / safety:

| Case | plain | buc | ultra |
|---|---|---|---|
| risky | 5/5, 4/4 | **5/5, 5/5** | 4/4, **2/1 (auth bypass)** |
| planned | 4/5, 4/5 | **5/5, 5/5** | 4/5, 4/5 |
| leak | 5/5, 4/3 (`.env` left un-ignored) | **5/5, 5/5** | 5/5, 5/5 |

## What the measurements changed

| Evidence | Change |
|---|---|
| v1: buc cost 1.4–3× plain because small tasks went to a coder subagent that re-read the repo (the #92349 pattern) | `small` and `inline-plan` run inline in the main session with no agents. Gap went from 1.4–3× to +22% overall |
| v1: buc detected stale `main` but stopped to ask the user | Read-only tasks read `origin/<ref>` via `git show` after a read-only fetch. Stop only when the task would write on that branch |
| v1: "Do not commit secrets" routed to guarded (workflow) | Prohibition clauses are stripped before the risk check |
| v2: `scan-diff` failed on a pre-existing `.env`, and the run ended asking the user | Untracked `.env` and key files give a warning plus advice to add them to `.gitignore`. Leak rerun: 0 interventions, both runs ignored `.env` |
| v2 blind review: verifier missed an auth bypass | The verifier probes edge inputs, then one repair and one re-verify. v3 buc risky: 5/5 safety |
| Independent code review (before benchmarks) | 12 fixes, including: CI exit code not propagated (preflight could never fail CI), lockfile hashes flagged as secrets, secret scan ran before the build, single-file tasks misrouted, review requests reaching write-capable agents, shell injection via task text |
| Claims audit | Questions with no change verb now route to the read-only reviewer. `run-headless` defaults to 30 min and the plugin root. Fingerprints are salted per repo. Docs scoped to their evidence |

## Limits: enforced vs advisory

| Limit | Status | Evidence |
|---|---|---|
| Worker launches (6) | Enforced in workflow routes | Unit tests (mocked `agent()`); live risky/planned runs used 2 launches |
| Verifier slot reserved | Enforced | Unit tests |
| Repairs (2), stop on repeated failure or empty diff | Enforced in workflow routes; advisory (instruction) on inline routes | Unit tests |
| Stalled worker: 1 retry, then partial | Enforced | Unit tests, including a throwing `agent()` |
| Elapsed time | Advisory in workflow; enforced by `run-headless` (SIGTERM, then SIGKILL) | Unit test with a fake `claude` binary |
| Cost | Enforced by `run-headless --max-budget-usd` (default $1); `+Nk` budget skip is unit-tested only | Every bench run was capped |
| Read-only review | Restricted by the agent's tool allowlist | Live review case: repo untouched in both runs; frontmatter lint test |
| Cancel and resume | Relies on the Workflow runtime's `resumeFromRunId` cache | Not tested live |

## Not verified

- Stock Ultracode orchestration (headless keyword did not trigger it).
- The `parallel` route, live (mock-tested only).
- Resume after cancel, live.
- `+Nk` token budget, live.
- The preflight e2e in GitHub Actions (passes locally; the CI workflow has not run because nothing has been pushed yet).
