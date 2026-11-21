# Benchmark harness

Compares five arms on small synthetic repos and on real-task cases:

| arm | invocation |
|---|---|
| `plain` | `--no-plugin`, prompt as written |
| `plain-claudemd` | `--no-plugin`, prompt as written; `CLAUDE.md` with the rules from `fixtures/rules.json` as plain bullets is written into the run repo (git-excluded, so not in the patch) |
| `buc` | `--plugin-dir <repo>`, prompt as written (hooks do the work); gets its own copy of `--buc-home` as `BUC_HOME` |
| `buc-regex` | ablation: as `buc`, with `BUC_OFF=self`, so the v9 fixed intent lines replace self-classification |
| `ultra` | stock Ultracode: `--no-plugin`, prompt unchanged, `--settings '{"ultracode":true,"workflowSizeGuideline":"small"}' --effort xhigh`, budget = 2x `--budget`; `ultra_active` records whether `ultra_effort_enter` appears in the run's transcripts |

## Run

Live (spends real money, spawns `claude` directly; `BUC_CLAUDE_BIN` overrides the binary):

    node bench/run.js --arms plain,buc,ultra --cases trivial,ambiguous --n 1 --budget 1 --timeout-min 10 --out bench/results/my-label.json

`--buc-home <dir>` seeds each buc run with a fresh copy of that rules dir (e.g. one containing `rules.json` copied from `bench/fixtures/`); without it the buc arm starts with an empty `BUC_HOME`. All flags are optional (defaults: all arms, all cases, `--n 1 --budget 1 --timeout-min 10`, output under `bench/results/<timestamp>.json`).
Prints a markdown table per case x arm and writes the raw per-run JSON.

`--exclude-rules-from self` scores each case without the rules listed in its own `exclude-rules.json` (an array of rule ids mined from that case's session), so a case is never helped by a rule that encodes its answer. `--exclude-rules-from caseA,caseB` drops those cases' lists from every run instead. The buc arm's copied `rules.json` and the `plain-claudemd` bullets are both filtered; the row records `excluded_rules`.

`--cases` accepts names from `bench/cases`, `bench/private` and `bench/heldout` (both gitignored, may be absent). A held-out folder counts as a case only when it has a `case.json`. `BUC_BENCH_PRIVATE` and `BUC_BENCH_HELDOUT` point at another checkout's folders, for example from a git worktree.

No-model check, listing the arms and every case (setup + accept must fail, solve + accept must pass; cases without `solve.sh` are skipped for the solve half; a case with `wrong.sh` must also fail accept in the state the user corrected):

    node bench/run.js --dry

Results are written to `--out` after every run, so a long bench that dies keeps what it has.

### As-of rules

`--rules-as-of case` gives every run the rule store as it stood before the case's own request and without what the case's session taught. For each case the harness reads `ts` and `session` from `case.json` and runs `buc rules as-of --before <ts> --exclude-sessions <session>` on a copy of `--buc-home` (required). The `buc` and `buc-regex` arms get the result as their `BUC_HOME`; `plain-claudemd` gets the same rules as bullets, or no bullets when none are left. A case without `case.json` is not cut. `--rules-as-of <ISO date>` cuts every case at one date instead.

A rule without provenance never survives the cut. `--rule-sources <file>` adds backfilled sources (`{rule id: [{session, repo, ts, h}]}`, the output of `bench/backfill-sources.js`) to the copy first; the store itself is not changed. The row records `rules_as_of`: `before`, `excluded_sessions`, and the rule ids `kept` and `dropped`.

### Browser in clones

Real-task runs happen in a fresh clone under a temp dir. The plugin's screenshot and layout checks need a Playwright there. When the clone has none at its root, the harness sets `BUC_PLAYWRIGHT` to one found in a subfolder of the clone, in the case's source repo (`case.json` `repo`) or in `fixtures/vite-express`, and `PLAYWRIGHT_BROWSERS_PATH` to the user's browser cache when it exists. Values already set in the environment are kept. The row records `browser.playwright`: `own`, `borrowed` or null.

## Cases

Each case dir has `setup.sh <dir>`, `prompt.txt`, `accept.sh <dir>` (exit 0 = pass; read-only cases read the final reply from `../result.txt`), and `solve.sh <dir>` (reference solution, used only by `--dry` and `test/bench.test.js`).

| case | tests | regression complaint |
|---|---|---|
| `trivial` | one-line fix, tiny diff | plugin overhead on easy tasks (cost, turns, subagents for nothing) |
| `ambiguous` | vague request, no criteria; hidden check (`hidden.js`) is only used at accept time | agent guesses or asks instead of picking a sensible design; interventions |
| `stale-branch` | local clone is behind origin; answer is only on the remote | agent trusts local state instead of verifying the exact remote commit |
| `lying-ui` | UI shows "Saved" on failure; visible test is weaker than hidden check | agent satisfies the visible test but misses the stated intent |
| `leak` | untracked `.env` with a fake key; `git add -A` would commit it | agent commits secrets |
| `risky` | weak md5 password hash in `auth.js`; visible test passes before and after; hidden check (`hidden.js`) wants no md5 and a random salt | auth-sensitive change: does extra verification pay off |
| `advice-only` | "tell me how to..." | agent edits files when only advice was asked; accept: clean tree and a non-empty reply (`../result.txt`) |
| `only-1-and-2` | three listed bugs, fix only 1 and 2 | agent fixes or reformats more than named; accept: hidden tests, bug-3 line byte-identical, <=12 changed lines |
| `no-break` | add a back button to one page | change breaks other routes; accept: existing test plus hidden smoke over every route |
| `no-emoji` | add icons to buttons | emoji used instead of the icon library; accept: no emoji, lucide import and icons present |
| `exact-copy` | replace a quoted empty-state string | paraphrase or extra edits; accept: new string once, old absent, only one file changed |
| `slight-tweak` | make a card slightly smaller | overshoot on degree requests; accept: width 75-95% of original, <=3 css lines added |
| `state-reset` | hints must not persist to next round | fixes the named symptom but leaves implicit carry-over and auto-start; accept: hidden state check |
| `small-commits` | three small functions, commit each | one big commit or attribution trailers; accept: >=3 new commits, clean tree, no Co-Authored-By/Claude in messages |
| `correction` | task, then a correction (`correction.txt`) | agent ignores mid-run corrections; accept checks the corrected outcome |

`correction` runs the first prompt with `timeout/3` (simulated interruption), then a second fresh invocation in the same dir with `correction.txt + "\nOriginal task: " + prompt`. Metrics are summed over both; `interventions` starts at 1.

## Simulated user

After the run (`bench/sim-user.js`, deterministic, no model; accept output is never shown to the model):

1. `accept.sh` passes: 0 interventions.
2. Otherwise resume the same session (`claude -p --resume <session_id>`). The first reply is the case's `followup.txt` when it has one, also when the agent asked a question, so a question never swallows the real correction. After that (or with no follow-up) a reply ending in a question gets "use your best reading of what I asked" and anything else gets "no, read what i asked again". Each reply counts 1 intervention; accept is re-run after each.
3. At most 2 rounds.

Reported: `first_try_pass`, `final_pass`, `interventions`, `tokens_to_accept` (all rounds), `num_turns`.

## Metrics

- `accept_pass`: `accept.sh` exit 0 after the run; independent of model wording.
- `total_cost_usd`: summed over invocations, as reported by claude.
- `tokens.input`: input + cache read + cache creation, summed over `model_usage`; `tokens.output`: output tokens.
- `num_turns`, `subagents` (`subagent_stats.spawned`), `elapsed_ms` (wall clock), `exit`, `timed_out` (of the last invocation).
- `interventions`: 1 for `correction`, plus one per simulated-user reply (see above).
- `first_try_pass` (always false for `correction`), `final_pass` (= `accept_pass`), `tokens_to_accept`, `ultra_active` (ultra arm only).
- `source`: always `live`.
- `rounds`: audit trail, one entry per agent call: `round`, `prompt` (what the user side sent, 400 chars), `reply_excerpt` (first 600 chars), `reply_tail` (last 300 of a longer reply), `accept_pass` (null when accept was not run after that call), `files_changed`, `lines_changed`, `patch` (cumulative since setup, 20000 chars), `exit`, `timed_out`, and for that call alone `total_cost_usd`, `tokens`, `num_turns` and `elapsed_ms`.
- `excluded_rules`: rule ids left out by `--exclude-rules-from`.
- `rules_as_of`, `browser`: see above. `control`: true for a clean control case (`case.json`), null for a case without `case.json`.

## Statistics

`bench/stats.js` compares two arms on one metric with a case-clustered paired bootstrap. The unit is the case: each case contributes one difference (mean of arm A minus mean of arm B over its reps), cases are resampled with replacement, runs are not. More reps of the same cases do not narrow the interval; more cases do.

    node bench/stats.js bench/results/my-label.json --a buc --b plain --metric interventions --B 10000 --seed 10

Prints one JSON line: `diff` (mean difference over cases), `lo` and `hi` (90% percentile interval), `cases`, `B`, `seed`. The primary metric is `interventions` per run; any numeric or boolean row field works (`first_try_pass`, `tokens_to_accept`). `pairedBootstrap(rows, armA, armB, metric, {B, seed, level})` is the same thing as a function.

### Report and pre-registered criteria

    node bench/stats.js report <held-out results.json>... --a buc --b plain --regression <old real-task results.json>[,more.json]

Prints, for the cases that have both arms: per arm the runs, first-try and final passes, interventions per run, tokens to accept and cost; the paired bootstrap interval for `interventions`, `first_try_pass` and `tokens_to_accept`; then the six criteria fixed before the run, each with PASS, FAIL or NO DATA, and the verdict.

| # | Criterion (arm A against arm B, held-out, as-of rules) |
|---|---|
| 1 | Interventions per run are lower and the 90% case-clustered interval of the difference excludes 0 |
| 2 | First-try count is not lower (compared as per-case rates, so unequal reps do not count twice) |
| 3 | Mean tokens to accept is at most 1.05x |
| 4 | No case has A behind by 2 or more first-try passes of 3 (3 of 5; in general 60% of the runs both arms have) |
| 5 | Clean controls (`control: true` rows): A's first-try count is at least B's |
| 6 | Old real-task cases, arm A only (`--regression`): at least 12 of 24 first try and 22 of 24 final; another run count scales both and says so |

All six pass: "v10 generalises". Only the first fails: "no measurable gain on unseen tasks". Anything else: "regression: v10 does not ship". A criterion without data leaves the verdict "incomplete". The report warns when arm A rows were not made with `--rules-as-of`.

The pre-registered run, from a checkout that has `bench/heldout` and `bench/private`:

    HO=$(ls bench/heldout | grep '^ho-' | paste -sd, -)
    OLD=bug-form-less-text,css-show-dont-edit,house-rules-greyed-preview,omen-bug-copy,omen-guide-icons,one-sound-button,sound-first-screen,wrong-guess-penalty
    node bench/mine-cases.js manifest --dir bench/heldout --check bench/heldout.manifest.json
    node bench/run.js --dry --cases $HO
    node bench/run.js --arms plain,buc --cases $HO --n 3 --buc-home ~/.better-ultracore --rules-as-of case --rule-sources bench/heldout/rule-sources.json --out bench/results/v10-heldout.json
    node bench/run.js --arms buc --cases $OLD --n 3 --buc-home ~/.better-ultracore --rules-as-of case --rule-sources bench/heldout/rule-sources.json --exclude-rules-from self --out bench/results/v10-old8.json
    node bench/stats.js report bench/results/v10-heldout.json --a buc --b plain --regression bench/results/v10-old8.json

If the interval of criterion 1 spans 0, add two more reps to a second file (`--n 2 --out bench/results/v10-heldout-b.json`) and give both files to `report`. Exploratory, not part of the verdict: `--arms plain-claudemd` (same as-of rules as bullets), `--arms buc-regex` (ablation) and `--arms ultra --n 1`, each compared with `report --a buc --b <arm>`.

An old case without a `case.json` gets no as-of cut; give it one (`ts` of the request, `session` id) or an `exclude-rules.json`.

## Held-out real-task set

`bench/heldout/` (gitignored, like `bench/private/`) holds cases mined from real sessions that no rule was learned from and no plugin change was tuned on. Only `bench/heldout.manifest.json` is committed: case ids and the sha256 of every case file, written before any live run so the set cannot drift unnoticed. Nobody working on the hooks reads the directory.

A correction case is a triple from one transcript: a request P, the user's next turn C that corrects how the agent read or carried out P, and the commits around them. `base` is the last commit before P, `wrong` the last commit before C, `fix` the last commit after C and before the next request. A control is a request that got a go-ahead and no correction.

`bench/mine-cases.js` runs the procedure:

    node bench/mine-cases.js mine --out bench/heldout/candidates.jsonl
    node bench/mine-cases.js select --candidates bench/heldout/candidates.jsonl --labels bench/heldout/labels.json --rules ~/.better-ultracore/rules.json --existing bench/private --seed 10 --out bench/heldout/selection.json
    node bench/mine-cases.js write --selection bench/heldout/selection.json --out bench/heldout --deps bench/private/deps.sh
    node bench/mine-cases.js verify --dir bench/heldout
    node bench/mine-cases.js manifest --dir bench/heldout --out bench/heldout.manifest.json
    node bench/mine-cases.js manifest --dir bench/heldout --check bench/heldout.manifest.json

- `mine` pairs consecutive user turns of every non-temp transcript (short go-aheads such as "deploy" are looked through) and resolves SHAs by timestamp. Source repos are only read.
- `select` applies the criteria mechanically and logs every reject with its reason: P at most 80 words, no image, standalone; assistant work after P; a fix commit; `base..fix` at most 300 lines; not within 3 turns of an existing case; C labelled a correction in `labels.json` (the one judgement step, made from P and C text before sampling); no leakage. Then a seeded sample within quotas (at most 5 per repo, 3 repos, 4 non-UI, 2 too wide, 2 too narrow, 1 show-do-not-edit), corrections the rule miner could not see first. `--skip-ids` drops a pick whose accept check cannot be written without reshuffling the rest.
- Leakage is conservative: a correction the rule miner could see with 2 or more keywords of one rule, a request and correction that together carry 3 or more, or a near-duplicate (Jaccard at least 0.6) of a mined correction is rejected.
- `write` emits `prompt.txt`, `followup.txt` (verbatim), `case.json`, `setup.sh` (clone, check out base, copy `node_modules`), `solve.sh` and `wrong.sh`. `accept.sh` and `solve-notes.md` are written by hand from the `wrong..fix` diff, preferring running behaviour over reading source.
- `verify` is the dry check in fresh clones: accept must fail at base, fail at wrong and pass at fix.

`bench/backfill-sources.js` maps existing rules to the corrections that may have sourced them, by keyword and over-inclusively, and prints `{rule id: [{session, repo, ts, h}]}` where `h` is the first 12 hex of the sha1 of the redacted text. It reads `rules.json` and never writes it.

The set is small: the first build yielded 2 correction cases and 3 controls from 363 candidate pairs. Most real corrections do not directly follow the request they correct, were already used to learn rules, or are about taste. `bench/heldout/SELECTION.md` has the counts.

## Longitudinal replay

`bench/replay.js` replays the user's real sessions, oldest first, through the prompt hook and the session-end hook against a store that starts empty. No agent runs, and the source repos are only read.

    node bench/replay.js --cache <dir outside the repo> [--every 5] [--cap 3] [--model haiku] [--sample 120] [--seed 10]

- Per user turn, `BUC_NOW` is the turn's own time and `hooks/inject.js` runs; the rules it showed are read back from the store.
- Per session, `hooks/session-end.js` queues the session's corrections and bumps rules.
- Every `--every` sessions decayed rules are archived (the live store does that when rules are reviewed) and one clustering call turns the new candidates into rules, which are imported without approval. That shortcut exists in replay only. A rule is stored only when its sources are hashes of real queued corrections.
- Model calls go through `bench/ask.js`: `claude -p` with no tools, cached by prompt under `--cache` and capped by `--cap` USD in total. The cache holds private text, so a cache dir inside the repo is refused. A second run with the same inputs costs nothing.

It runs three replays (learning, learning without per-repo stats, no learning), then the same three with every multi-day session split into one unit per day, because a session that runs for weeks would otherwise never see a rule learned from its own first days. It prints a table and writes the numbers, with no text, to `<cache>/replay-metrics.json`.

| Metric | Meaning |
|---|---|
| corrections | turns the rule miner would queue (cue word, at most 240 characters) that follow a request in the same session |
| mention a known rule | corrections that name a keyword of a rule the store already had: the lesson recurred |
| covered | the request before the correction was shown a rule that the correction would bump |
| by a learned rule | covered, not counting habits the user stated outright |
| judge-confirmed | covered, and a cached yes/no model call agrees that obeying the shown rule would have avoided the correction |
| first half, second half | coverage of the earlier and later corrections: learning should raise the second |
| archived rules a later correction matched | decay regret: rules that decayed out of the live set and were then needed |
| injection precision | of a seeded sample of (request, shown learned rule) pairs, the share a yes/no model call finds relevant |

Limits: it measures that a rule was shown, not that the agent would have obeyed it. Coverage uses the session-end hook's any-keyword match, which is generous. The split by day cuts on UTC dates.

## Intent eval set

`bench/intent-eval.js` measures each fixed-line pattern in `lib/intent.js` on real prompts.

    node bench/intent-eval.js build --out bench/heldout/intent-eval.jsonl --cache <dir outside the repo> [--requests 200] [--followups 60] [--per-pattern 24] [--seed 10] [--cap 5] [--model sonnet]
    node bench/intent-eval.js score --file bench/heldout/intent-eval.jsonl [--split dev|test|all] [--mode self|regex]

`build` reads the real transcripts and writes one JSON row per line: `prompt`, `followup`, for a follow-up the request before it (`prev`), `evidence` (files the assistant edited before the next user turn, how many are UI files, and how the next turn reacted), `regex` (the pattern the hook would fire), `gold`, `labelled_by` and `split`.

- Turns over 60 words, image turns and short go-aheads are left out: the hook gives those no line.
- A row is a follow-up when a correction pattern fires on it, or when it reacts to edits with a cue word or in a few words.
- Sampling is seeded. Rows a pattern fires on are taken first (at most `--per-pattern` each) so a rare pattern has fires to measure; random rows fill up to the totals. Fewer follow-ups than asked for means the transcripts have no more.
- One offline model pass pre-labels `gold`: `exact`, `feature`, `sweep`, `vague`, `show` or `other` for a request; `still`, `misread`, `undo-show`, `overshoot` or `new-request` for a follow-up. The model sees the text and the evidence, never the pattern that fired. Calls are cached and capped like the replay's.
- The dev/test split keeps one session's day together, largest units first, each to the smaller half.
- The output holds private prompts. `build` refuses a path that git tracks; `bench/heldout/` is ignored.

`score` prints per-pattern precision through `intent.scorePatterns`, on the dev half by default, and the gate: a pattern keeps its fixed line only with precision at least 0.9 on at least 8 fires. Under the table it lists the row ids where a pattern fired and the label disagrees; those are the only rows that need a human look. The synthetic set in `test/fixtures/intent-eval.public.jsonl` scores through the same command.

## Caveats

- Small N: use `--n 3` or more before drawing conclusions; one run per cell is anecdote.
- Live runs cost real money; `ultra` gets 2x budget; each resume round gets a fresh budget. Budget caps can truncate a run, which shows as failure.
- Model output is nondeterministic; fixtures and acceptance checks are deterministic.
- The question heuristic only sees a `?` at the very end of the final reply.
- `patch` and `files_changed` are taken after all rounds.
- `ambiguous` accepts either `done <index>` CLI or exported `done(i)`, using the index as displayed by `list`.
- `stale-branch` creates `<dir>-origin.git` beside the run dir (inside the per-run temp dir); no network is used.
