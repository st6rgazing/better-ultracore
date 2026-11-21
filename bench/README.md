# Benchmark harness

Compares four arms on small synthetic repos:

| arm | invocation |
|---|---|
| `plain` | `--no-plugin`, prompt as written |
| `plain-claudemd` | `--no-plugin`, prompt as written; `CLAUDE.md` with the rules from `fixtures/rules.json` as plain bullets is written into the run repo (git-excluded, so not in the patch) |
| `buc` | `--plugin-dir <repo>`, prompt as written (hooks do the work); gets its own copy of `--buc-home` as `BUC_HOME` |
| `ultra` | stock Ultracode: `--no-plugin`, prompt unchanged, `--settings '{"ultracode":true,"workflowSizeGuideline":"small"}' --effort xhigh`, budget = 2x `--budget`; `ultra_active` records whether `ultra_effort_enter` appears in the run's transcripts |

## Run

Live (spends real money, spawns `claude` directly; `BUC_CLAUDE_BIN` overrides the binary):

    node bench/run.js --arms plain,buc,ultra --cases trivial,ambiguous --n 1 --budget 1 --timeout-min 10 --out bench/results/my-label.json

`--buc-home <dir>` seeds each buc run with a fresh copy of that rules dir (e.g. one containing `rules.json` copied from `bench/fixtures/`); without it the buc arm starts with an empty `BUC_HOME`. All flags are optional (defaults: all arms, all cases, `--n 1 --budget 1 --timeout-min 10`, output under `bench/results/<timestamp>.json`).
Prints a markdown table per case x arm and writes the raw per-run JSON.

`--exclude-rules-from self` scores each case without the rules listed in its own `exclude-rules.json` (an array of rule ids mined from that case's session), so a case is never helped by a rule that encodes its answer. `--exclude-rules-from caseA,caseB` drops those cases' lists from every run instead. The buc arm's copied `rules.json` and the `plain-claudemd` bullets are both filtered; the row records `excluded_rules`.

`--cases` accepts names from `bench/cases` and `bench/private` (gitignored, may be absent). No-model check, listing the four arms and every case (setup + accept must fail, solve + accept must pass; cases without `solve.sh` are skipped for the solve half):

    node bench/run.js --dry

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
- `rounds`: audit trail, one entry per agent call: `round`, `prompt` (what the user side sent, 400 chars), `reply_excerpt` (first 600 chars), `reply_tail` (last 300 of a longer reply), `accept_pass` (null when accept was not run after that call), `files_changed`, `lines_changed`, `patch` (cumulative since setup, 20000 chars), `exit`, `timed_out`, `total_cost_usd`.
- `excluded_rules`: rule ids left out by `--exclude-rules-from`.

## Statistics

`bench/stats.js` compares two arms on one metric with a case-clustered paired bootstrap. The unit is the case: each case contributes one difference (mean of arm A minus mean of arm B over its reps), cases are resampled with replacement, runs are not. More reps of the same cases do not narrow the interval; more cases do.

    node bench/stats.js bench/results/my-label.json --a buc --b plain --metric interventions --B 10000 --seed 10

Prints one JSON line: `diff` (mean difference over cases), `lo` and `hi` (90% percentile interval), `cases`, `B`, `seed`. The primary metric is `interventions` per run; any numeric or boolean row field works (`first_try_pass`, `tokens_to_accept`). `pairedBootstrap(rows, armA, armB, metric, {B, seed, level})` is the same thing as a function.

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

## Caveats

- Small N: use `--n 3` or more before drawing conclusions; one run per cell is anecdote.
- Live runs cost real money; `ultra` gets 2x budget; each resume round gets a fresh budget. Budget caps can truncate a run, which shows as failure.
- Model output is nondeterministic; fixtures and acceptance checks are deterministic.
- The question heuristic only sees a `?` at the very end of the final reply.
- `patch` and `files_changed` are taken after all rounds.
- `ambiguous` accepts either `done <index>` CLI or exported `done(i)`, using the index as displayed by `list`.
- `stale-branch` creates `<dir>-origin.git` beside the run dir (inside the per-run temp dir); no network is used.
