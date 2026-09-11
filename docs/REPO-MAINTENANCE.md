# Repository Maintenance & Promotion Checklist

A maintainer-facing distillation of current public-repo best practice
(2024–2026). Use it as a periodic checklist and before any social-media push.
GitHub's own score is **Insights → Community standards** — target **8/8**.

## Community standards (8/8)

| Check | Where it lives here |
|---|---|
| Description / About | Repo settings → General (set: *"Katra — cognitive memory for AI agents…"*) |
| README | `README.md` (hero → quickstart → features → docs links) |
| Code of conduct | `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) |
| Contributing | `CONTRIBUTING.md` |
| License | `LICENSE` (BSL 1.1) |
| Security policy | `SECURITY.md` |
| Issue templates | `.github/ISSUE_TEMPLATE/` (bug + feature forms) |
| Pull request template | `.github/PULL_REQUEST_TEMPLATE.md` |

## Essential hygiene

- **Never commit** `.env`, keys, tokens, `.DS_Store`, `node_modules/`, or build
  artifacts. `.env` and `private/` are gitignored; if a file is gitignored but
  already tracked, untrack it with `git rm --cached <path>`.
- **Secret scanning + push protection** are on (free for public repos).
  Rotate anything that ever leaks — rewriting history does *not* un-leak a token.
- **Dependabot** (`dependabot.yml`) keeps server + GitHub Actions deps current.
- **CodeQL** + **OpenSSF Scorecard** run in CI for code + supply-chain analysis.

## CI / build

- `CI` (`.github/workflows/ci.yml`) runs `npm ci` → `npm run typecheck` →
  `npm run build` on push and pull request. Keep the badge green.
- `npm >= 11` is required to resolve the server dependency graph.
- Run locally before pushing:
  ```bash
  cd server && npm ci && npm run typecheck && npm run build && npm test
  ```

## Branch & merge conventions

- Default branch `main`; feature work on `chore|feat|fix/<scope>` branches.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, …) — see
  `CONTRIBUTING.md`.
- A ruleset protects `main`: pull requests required, one approving review,
  and the `typecheck & build` check must pass.

## Release cadence

- Tag a release (`v0.x.y`) when there is a user-visible change; keep
  `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
  + [SemVer](https://semver.org/).
- Answer first-time issues/PRs within ~48 hours — responsiveness drives repeat
  contribution.
- Triage labels weekly: `bug`, `enhancement`, `documentation`, `question`,
  `good first issue`, `needs-triage`, `duplicate`, `wontfix`.

## Social-ready checklist (before sharing)

1. License at root — done (BSL 1.1, described as *source-available*).
2. About: description + 5–12 topics + social preview image
   (`assets/katra-social-preview.png`, 1280×640) uploaded in
   Settings → Social preview.
3. README hero: one-liner + install command + working example above the fold.
4. Community standards **8/8**.
5. CI green on `main`.
6. `.gitignore` clean — no `node_modules`, `.DS_Store`, `.env`.
7. At least one GitHub Release with notes.
8. Commit activity recent (an empty graph reads as abandoned).

## Known decisions (leave as-is until revisited)

- **License**: Business Source License 1.1 (converts to AGPL-3.0-or-later on
  2030-08-11). Marketed as *source-available*, not OSI open source.
- **Git history**: older commits (pre `fix(privacy)` #34) contain deployment
  hostnames/network details. See the internal decision record before
  considering a `git filter-repo` rewrite.
