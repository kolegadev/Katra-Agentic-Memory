# AGENTS.md — rules for agents working in this repo

## Private/deployment data NEVER goes into the repo

Personal setups — per-identity scripts, key files, machine names, home
paths, addresses, inbox policies — live **only** in the git-ignored
`private/` folder of each machine's checkout, or outside the repo
(`~/.katra/`, `~/.kolega/`).

- Copy files into `private/` with plain `cp` / `mv`. **Never** `git mv` or
  `git add` anything under `private/` — explicit adds bypass `.gitignore`
  and the file gets committed (CI `privacy lint` fails the PR on this).
- Before committing, verify: `git ls-files private/` must print nothing.
- Deleted-from-repo files still exist in git history; if a file with
  personal details was ever committed, say so in the PR — it may need a
  history scrub.

## Identities are deployment data, not code

No agent or operator names may appear in tracked code, tests, scripts, or
docs. The product is env-driven:

- Core identity: `KATRA_USER_ID` (default `katra`).
- Extra identities: `KATRA_EXTRA_IDENTITIES` (`user_id:Display Name` pairs).
- Allocation candidates: `KATRA_ALLOCATION_CANDIDATES`.
- Inbox loops: `KATRA_INBOX_EXTRA_LOOPS`.
- Generic tools (use these instead of per-person copies):
  `integrations/kolega-code/scripts/wake.sh`,
  `integrations/kolega-code/scripts/ensure-bridge.sh`,
  `integrations/kolega-code/scripts/katra_inbox.py`.

Deployment values go in the git-ignored `.env`, never in code.

## Changes go through PRs

- Open a PR against `main`; never push directly to `main` (branch
  protection enforces this).
- The PR body must state the verification evidence: `npx tsc --noEmit`
  clean (in `server/`), the relevant unit tests passing, and the CI
  `privacy lint` job green.
- If the change moves personal files out of the repo, list them and where
  they now live (per-machine `private/`).

## Definition of done

- CI green (typecheck & build, privacy lint).
- Repo-wide search shows no personal names, machine names, home paths, or
  addresses in tracked files.
- Existing deployments keep working: behavioral changes that were
  previously hardcoded are reproduced via `.env` (e.g. `KATRA_USER_ID`,
  `KATRA_ALLOCATION_CANDIDATES`) before merging.
