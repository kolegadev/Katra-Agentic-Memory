# Inbox Dispatch Config

Version-controlled dispatch configuration for the inbox auto-reply loops.

- **Installer:** `install-cron.sh` — idempotently installs the `*/3` cron
  entries for the Satori and Zefir loops (the full capability variant,
  operator-approved 2026-09-09). Run after cloning the repo on the Katra
  host: `bash integrations/kolega-code/inbox/install-cron.sh`
- **Policies:** deployment-specific agent policies live in the git-ignored
  `private/` folder — `private/integrations/kolega-code/inbox-agent/AGENTS.md`
  (Satori) and `private/integrations/kolega-code/inbox-agent-zefir/AGENTS.md`
  (Zefir) — three-tier autonomy policy, FULL capability with the needs-owner
  category for destructive/access-change requests (deletions, IAM/credential
  grants, billing, irreversible actions).
- **Dispatcher:** `../scripts/satori_inbox.py` — poll → headless dispatch →
  threaded reply. Identity-generic via `KATRA_AGENT_ID` / `KATRA_AGENT_NAMES`
  / `KATRA_INBOX_DIR`.
- **Runtime state** (not version-controlled — machine state):
  `~/.katra/inbox/<agent>.json` (handled/attempts/dispatch caps),
  `<agent>.lock`, `cron.log`, `zefir-cron.log`, `dispatch.log`,
  `needs-owner.md` (escalations the operator reviews).
- **Hard limits carried in every dispatch goal:** one reply per message,
  no secrets/credentials in replies or commits, needs-owner category never
  acted in-session.

Full walkthrough: `private/docs/AGENT-COMMUNICATION-SETUP.md` § "The Automated
Inbox Auto-Reply Loop".

