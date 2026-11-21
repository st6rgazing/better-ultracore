# Results (2026-11-20)

All runs: Claude Code 2.1.322, Sonnet main model, `claude -p`, `--max-budget-usd 1` per call. Every arm gets the same repo, prompt and hidden acceptance script. Numbers come from live model runs unless marked "unit test".

## Arms

- **plain**: Claude Code with no plugin.
- **plain+CLAUDE.md**: no plugin, but the same learned rules that buc uses, pasted into `CLAUDE.md`. This control asks: is buc better than writing the rules down yourself?
- **buc**: the plugin installed and the task given as a normal prompt (hooks inject rules and intent lines, and run the stop-time checks).
- **ultra**: stock Ultracode, run faithfully: `--settings '{"ultracode":true}' --effort xhigh`. Every ultra run was confirmed active from its transcript (`ultra_active` 10/10). The earlier "ultracode keyword" arm never turned Ultracode on in `-p` mode, and its results have been removed.

## Metrics

- **First try**: the hidden acceptance script passes after the first answer, with no correction.
- **Final**: passes after at most 2 scripted follow-ups. Each follow-up is the user's real correction from the original session.
- **Interventions**: follow-ups sent plus questions the agent stopped to ask.
- **Tokens to accept**: all tokens (input including cache, plus output) across every round until acceptance or the end. This is the cost of getting what was wanted.

## Real tasks from the author's own repos (8 cases, N=3)

Each case is a real past request. It is checked out read-only at the commit before the request. The follow-up is the correction the user actually typed afterwards. Task text and code stay out of this repo (`bench/private/` is gitignored).

| Arm | First try | Final | Interventions | Tokens to accept / run | Cost / run |
|---|---|---|---|---|---|
| plain | 10/24 | 14/24 | 25 | 1.76M | $0.65 |
| plain+CLAUDE.md | 12/24 | 17/24 | 19 | 1.74M | $0.62 |
| buc v7 | 10/24 | 18/24 | 23 | 1.56M | $0.59 |
| **buc v8** | **13/24** | 17/24 | **19** | **1.36M** | **$0.52** |
| ultra (N=1) | 1/8 | 3/8 | 12 | 7.51M | $2.68 |

### v10 to v12 (2026-11-20/21)

Rules in these runs are as-of: only rules learned before each case's date, minus any learned from the case's own session. That removes the leakage in earlier rows, so v10+ is a harsher test.

| Version | First try | Final | Interventions / run | Tokens to accept / run | Cost / run |
|---|---|---|---|---|---|
| plain (v9 run) | 11/24 | 23/24 | 0.88 | 1.71M | $0.62 |
| buc v10 | 12/24 | 21/24 | 0.71 | 1.56M | $0.56 |
| **buc v11** (N=2) | **12/16** | **16/16** | **0.25** | **0.90M** | **$0.35** |

What changed:
- **v10:**
  - The model classifies its own reading (EXACT, FEATURE, SWEEP or SHOW) instead of regexes picking a fixed line. Patterns stay only if measured precise on the user's real prompts.
  - New Stop checks: undo restored, no test weakening, conflict markers, typecheck errors only in changed files, soft question and wide-diff feedback.
  - A screenshot helper.
  - A tool-call budget.
  - Rule provenance and as-of filtering.
  - Opt-in per-repo hands-off mode.
  - The commit habit is scoped to the repo where it was stated.
- **v10 eval:** two fixed-line patterns misfired on real prompts, so they were retired. "Degree" was correct 0 of 4 times; "sweep" 1 of 2.
- **v11:** from published methods and from Ultracode complaints in GitHub issues:
  - An evidence check: "tests pass" or "verified" claims need a matching run after the last edit.
  - An agent budget: a soft cap, then a hard stop at a ceiling, on usage-limit errors, or on the same brief dispatched three times.
  - Orchestration lines for an accidental ultracode keyword and for mid-turn messages.
  - Rules voted up or down by outcome, with eviction (ExpeL style).
  - Hash-only reflections, promoted to a rule after recurring.
- **v12:** from an iterative loop on the dev cases:
  - The Stop screenshot is only handed over when it shows the changed UI.
  - Soft `sweep-scope` feedback.
  - Measured on the copy-sweep case: 0/3 → 3/3 first try, 3.09M → 0.77M tokens.
  - Two further ideas made results worse and were reverted: a misread checklist, and treating "fix these" as still-wrong.

Learning-loop replay (offline, all 41 real sessions): learned rules would have pre-empted 0 of 33 later corrections. The only covered correction came from the stated commit habit. Most of buc's measured gain therefore comes from the intent lines and Stop checks, not from mined rules.

### Held-out test (v11, unseen tasks)

The tasks are mined from the user's other past sessions and repos, never used for tuning, and validated: the accept script fails at base, fails on the agent's wrong version, and passes on the user's real fix. Rules are as-of. N=3. The corpus held only 4 valid correction cases and 3 controls.

| Arm | First try | Final | Interventions | Tokens to accept |
|---|---|---|---|---|
| plain, 4 correction cases | 4/12 | 12/12 | 9 | 14.4M |
| buc v11, 4 correction cases | 4/12 | 12/12 | 9 | 19.6M (+36%) |
| plain, 2 controls* | 0/6 | 3/6 | 9 | 12.9M |
| buc v11, 2 controls* | 0/6 | 2/6 | 10 | 17.2M |

\* The third control finished too late to include.

Verdict against the pre-registered criteria: **no measurable gain on unseen tasks, and higher token cost.**
- The dev-set gains (v11: 12/16 first try) did not transfer, so they were largely tuning to those 8 cases.
- On one control buc was worse (final 1/3 vs 3/3).
- With 4 correction cases, a real effect of under about 2 passes cannot be detected either way.
- Stock Ultracode on these cases did not finish before the run deadline.

### Known flaws and next steps (design review, 2026-11-21)

1. No controlled comparison. The dev gains were measured on the cases the loop tuned on, against an older plain run. Next: the same-run paired plain arm on more held-out cases (needs more corpus).
2. Two dev cases never pass first try ("show me how", first-screen sound), and they account for all v11 dev interventions.
3. The revised answer is unchecked. Soft notes, hard blocks and the screenshot share one continuation, so nothing checks the revision.
4. Stop checks without a measured false-positive rate: sweep-scope, sweep-residue, no-test-weakening.
5. The evidence check is weak both ways (any command "backs" a test claim), and edit-unrun conflicts with the "do not run the typecheck" line.
6. Latency: the synchronous Stop typecheck plus screenshot. One simple case averaged 135 s vs plain's 20-30 s.
7. Code with no measured value: the agent budget never fired on the bench, the learning loop is about a quarter of the code for 0 of 33 corrections pre-empted in replay, and the screenshot helper is large but rarely active. Candidates to delete or put behind opt-in.
8. Retired regex patterns and README claims that still lead with learning.


### v9: fairer harness, all three arms rerun (N=3)

The harness changed in v9, so v7/v8 rows above are not directly comparable:
- Clones get copy-on-write `node_modules`, so agents can actually run the typecheck.
- The sound case's acceptance accepts the repo's own `sfx()` call; it still passes on the user's real fix and fails on the base commit.
- A first-turn question no longer swallows the real follow-up.

| Arm | First try | Final | Interventions | Tokens to accept / run | Cost / run |
|---|---|---|---|---|---|
| plain | 11/24 | 23/24 | 21 | 1.71M | $0.62 |
| plain+CLAUDE.md | 11/24 | 17/24 | 20 | 1.77M | $0.63 |
| **buc v9** | **13/24** | **23/24** | **14** | **1.67M** | **$0.55** |

v9 changes, designed from a review of every failing run:
- **End-to-end intent line:** for feature requests without a narrowing cue: trace from the app entry to the screen the user means; if ambiguous, state the reading and do not ask. "Only", "just", degree words, file paths and exact "change X to Y" edits keep the literal line.
- **Correction lines on follow-up turns:**
  - "still wrong": re-read the original words, keep what was right.
  - "no, I meant": take a different reading, do not defend or ask.
  - "undo and show me": restore your files, answer in text.
  - "way too X": move halfway back.
- **Typecheck check:** the repo's own `typecheck` script runs at Stop after any edit turn and blocks once on failure. Turn it off with `"autoCheck": false` in `.claude/buc.json`.
- **Runtime-effect probe:** for sound, toast, animation and similar changes, check the guards (audio unlock, mute, permission) that would stop the effect firing.
- **Rule storage and keys:**
  - Keyword cleaning: meta words like "everything" no longer pull in unrelated rules.
  - `repoKey`: clones and worktrees share per-repo stats.
- **Commit-as-you-go habit:** when the user states it, it becomes a pinned rule enforced by a `commit-changes` stop check. Remove it with `buc rules drop commit-as-you-go`.

buc's main gain in v9 is fewer corrections: 14 interventions against 21 (plain) and 20 (CLAUDE.md). On first try it leads by 2. With the fairer harness, plain's final pass rose from 14 to 23, so buc's v7 lead on final pass is gone.

Wins:
- bug form: 2/3 first try vs 0/3.
- lobby preview: 2/3 vs 1/3.
- first-screen sound: 1/3, the first first-try pass for any arm.

Regression: the guide-icons case fell to 1/3 (plain 3/3), because the new end-to-end line made an exact "change X to be ?" edit read broadly. Exact-edit prompts now keep the literal line. Rerun at N=5: 3/5 first try, still behind plain and at higher token cost.

### v8

v8 adds two intent lines (`lib/intent.js`), both found by reading v7 failures:
- **Sweep prompts** ("whole app", "all traces", "everywhere") get "grep the whole repo for every occurrence, fix each, grep again" instead of "touch only what is named". v7 was telling the agent to narrow a request that asked for breadth.
- **Vague screen fixes** ("can u fix the X screen") get "the request names no defect: work out what the user dislikes from the pasted text and the standing corrections". On the bug-form case first-try went from 0/3 to 3/3. With the same rules but without the line, plain+CLAUDE.md scored 0/3.

On the 4 cases changed in v8, plain+CLAUDE.md was rerun with the same rules: 1/12 first try. The v8 gain comes from the intent lines, not the rule text.

Ultracode on these tasks spawned no subagents. It cost about 4× plain per run and passed fewer cases. Its ~30k-token fixed prompt and xhigh effort did not buy a better reading of short, ambiguous requests.

Caveats:
- N=3. A 1–2 case difference is noise. buc v7 vs v8 per-case swings of ±1 (house-rules, wrong-guess) are within run-to-run variance.
- The learned rules come from the same history as these cases, so rule matching is an optimistic test of personalisation. The intent lines are generic and do not use case text.
- Still weak in v9:
  - The "show me how" case, where the user changed their mind after the agent edited: buc 0/3 first try, plain+CLAUDE.md 2/3.
  - Guide icons: buc 3/5 vs plain 3/3.
- The bench now records every round (prompt, reply, accept result, patch). `--exclude-rules-from self` scores a case without rules mined from its own session; private cases still need their own exclude lists.

## Synthetic fixtures (10 cases, N=2)

| Arm | First try | Final | Interventions | Tokens to accept | Cost |
|---|---|---|---|---|---|
| plain | 14/20 | 18/20 | 8 | 6.81M | $3.59 |
| plain+CLAUDE.md | 16/20 | 20/20 | 6 | 7.09M | $3.43 |
| **buc** | **18/20** | **20/20** | **2** | **4.50M** | **$2.73** |

buc wins where a deterministic check or a repo fact matters:
- **small-commits:** plain 0/2 first try. The stop hook blocks a single large commit.
- **stale-branch:** plain 0/2. buc reads `origin/<ref>` read-only.

The only case where every arm needed the follow-up is `correction`, by design.

Ultracode on synthetic risky and planned (N=1): both passed first try.

## Code quality: blind review

An Opus judge scored anonymised patches 1–5. It never saw the arm labels.

| Case | plain | plain+CLAUDE.md | buc | ultra |
|---|---|---|---|---|
| risky (md5 → scrypt), safety | 1 | 1 | **5** | 3 |
| slight-tweak, minimality | 3 | **5** | **5** | – |
| real: bug form, user fit | 1 | 4 | **4** | – |
| real: lobby preview, user fit | 2 | 3 | **4** | – |
| real: copy sweep, user fit | 2 | **4** | 3 | – |

Risky:
- Both plain patches accept a non-hex stored hash, so any password verifies (confirmed by running it).
- Ultracode's patch accepts a truncated hash.
- buc's edge probe (`lib/probe.js`: run the changed function on empty, malformed, truncated and boundary inputs before finishing) caught both cases.

The real-repo patches were judged from one fresh run per arm, with the v8 lines active. On copy sweep, that buc sample still under-swept: it cleaned both bug screens but not the rest of the app. Across the 3 v8 runs it passed acceptance first try 2 of 3 times (v7: 0/3).

## Bench fixes found along the way

- Real-repo patches were diffed against the repo's first commit, so they recorded the whole repo. They are now diffed against HEAD after setup. Pass/fail was never affected (acceptance scripts read the tree).
- The CLAUDE.md control first used generic rules, not the user's. It now uses the same `rules.json` as buc.

## Limits: enforced vs advisory

| Limit | Status |
|---|---|
| Stop-time checks (tests, only-named-files, no AI traces, no emoji, exact copy, small commits, advice-no-edits) | Enforced: the Stop hook blocks once with the failing check |
| Rules never grant permissions | Enforced in retrieval (unit tests) |
| Injected context ≤ 800 chars | Enforced (unit tests) |
| Intent and probe lines | Advisory (injected text) |
| Cost and time | Enforced by `--max-budget-usd` and `run-headless` timeout |

## CI

The `preflight` workflow on `main` passes secrets, build, no source maps, browser e2e and the ASVS checks. `deploy-permissions` stays `unverified` until the repo has branch protection on `main` and a `PROTECTION_TOKEN` secret. See [preflight-setup.md](preflight-setup.md).
