# Release preflight

`buc preflight` checks a Vite + Express release in CI and writes
`preflight.json` and `preflight.md` to `--out` (default `.buc/preflight`).
It exits 1 if any required check is `failed` or `unverified`.

```
buc preflight [--dir <app>] [--base <sha>] [--head <sha>] [--dist dist]
              [--config buc.preflight.json] [--skip-build] [--skip-browser]
              [--out .buc/preflight] [--evidence gh-protection.json]
buc preflight promote --sha <sha> --artifact dist.tgz [--manifest m.json]
buc preflight promote --verify --manifest m.json [--artifact dist.tgz] [--url https://host/__version]
```

Statuses are exactly `passed`, `failed`, `not_applicable`, `unverified`.
Skipped checks report `unverified`; set `"required": {"build": false}` in the
config to make them non-blocking. Config paths resolve relative to `--dir`.
