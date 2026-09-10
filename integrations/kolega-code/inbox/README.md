# Inbox Dispatch Config

Version-controlled dispatch configuration for the inbox auto-reply loops.
Loops are identity-agnostic: one loop per configured identity, driven by the
environment.

- **Installer:** `install-cron.sh` — idempotently installs the `*/3` cron
  entries for the local identity (`KATRA_USER_ID`, default `katra`) plus one
  loop per identity in `KATRA_EXTRA_IDENTITIES` (override the extra set with
  `KATRA_INBOX_EXTRA_LOOPS`). Run after cloning the repo on the Katra host:
  `bash integrations/kolega-code/inbox/install-cron.sh`
- **Policies:** deployment-specific agent policies live in the git-ignored
  `private/` folder — `private/integrations/kolega-code/inbox-agent/AGENTS.md`
  (local identity) and `private/integrations/kolega-code/inbox-agent-<id>/AGENTS.md`
  (extras) — three-tier autonomy policy, FULL capability with the needs-owner
  category for destructive/access-change requests (deletions, IAM/credential
  grants, billing, irreversible actions).
- **Dispatcher:** `../scripts/katra_inbox.py` — poll → headless dispatch →
  threaded reply. Identity-generic via `KATRA_AGENT_ID` / `KATRA_AGENT_NAMES`
  / `KATRA_INBOX_DIR`.
- **Runtime state** (not version-controlled — machine state):
  `~/.katra/inbox/<agent>.json` (handled/attempts/dispatch caps),
  `<agent>.lock`, `cron.log`, `<id>-cron.log`, `dispatch.log`,
  `needs-owner.md` (escalations the operator reviews).
- **Hard limits carried in every dispatch goal:** one reply per message,
  no secrets/credentials in replies or commits, needs-owner category never
  acted in-session.

Full walkthrough: `private/docs/AGENT-COMMUNICATION-SETUP.md` § "The Automated
Inbox Auto-Reply Loop".

