# Learned preferences

Local, opt-in. Nothing is read or stored until you run `buc prefs import` on explicit transcript paths.

## Storage

- General: `${BUC_HOME:-~/.claude/better-ultracore}/prefs.json`
- Project: `<repo>/.claude/buc-prefs.json`
- Forgotten ids: `tombstones.json` in the same directory. A forgotten record is never re-imported.
- Raw transcripts are never copied. Corrections are redacted (keys, tokens, JWTs, private keys, `password=`, long high-entropy strings) before storing.
- Records never carry permission fields; the store rejects keys like `allow`, `permission`, `tools`.

## Import

`buc prefs import <path.jsonl>... [--scope project|global] [--dry-run]`

Only user text turns are read (tool results are skipped); all text is untrusted. `always`/`never` corrections become `confirmed`; other corrections (`don't`, `stop`, `I said`, `no,`, `please keep`, `look at main`, `check after refresh`) become `suggested`. A suggested correction seen in two or more distinct sessions becomes an advisory `check`: ask once before making it a blocker.
