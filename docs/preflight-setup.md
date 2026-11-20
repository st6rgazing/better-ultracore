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

## What is verified by the tool

| check | how |
|---|---|
| secrets | added lines of `git diff base..head` and every commit in range; every file under dist, including `sourcesContent` of `.map` files. Findings hold rule, file, line, commit and a salted 8-hex fingerprint, never the value. Allowlist by fingerprint or path under `secrets.allow`. |
| build | runs `build.cmd` (default `npm run build`) in the app dir |
| dist-no-sourcemaps | fails on any `.map` in dist unless `build.allowMaps` |
| browser | runs `npx playwright test` in the app dir; Playwright missing gives `unverified` |
| deps (V14) | `npm audit --omit=dev`; high or critical fails; no registry access gives `unverified` |
| prodConfig (V14) | static scan of `serverFile` for x-powered-by off, security headers, NODE_ENV |
| sessions (V3) | static scan of `serverFile`; cookies need httpOnly, secure, sameSite; none set gives `not_applicable` |
| perRecord (V4) | each `/:id` route in config names an existing test file containing the route, else `unverified` |
| inputValidation (V5) | each POST route names an existing test containing the route and a `400`, else `unverified` |
| auth (V2) | `noAuth: true` gives `not_applicable`; otherwise needs `test` evidence file, else `unverified` |
| promote | manifest `{sha, artifact_sha256}`; verify compares it with the artifact and the live `/__version` |

Test existence is evidence, not proof: the tool does not run those tests (the
browser check does).

## What needs setup outside the tool

The tool can only report these as `unverified` until you supply evidence.

- Branch protection and required reviews: produce evidence with
  `gh api repos/OWNER/REPO/branches/main/protection > gh-protection.json`
  (needs a token with repo admin) and pass `--evidence gh-protection.json`.
  It passes only when required reviews and required status checks are present.
- Required status check: mark the `preflight` job as required in branch protection.
- Environments with required reviewers for the production deploy job.
- OIDC deploy credentials at the cloud or hosting provider, and CODEOWNERS for
  workflows and server code.
- A `/__version` endpoint returning `{sha, artifact_sha256}` on the host.
- Authentication (V2): add a test file and set `test` on the `auth` item.

See `examples/promote.yml` and `.github/workflows/preflight.yml`.

## Browser regression fixture

```
npm --prefix fixtures/vite-express install
npm --prefix fixtures/vite-express run e2e                 # passes
VITE_LYING_UI=1 npm --prefix fixtures/vite-express run e2e # must fail
```

With `VITE_LYING_UI=1` the UI shows "Saved" after a failed backend call, and
the "backend failure shows an error and not Saved" test fails.

Fast tests (no browser): `npm test`.
