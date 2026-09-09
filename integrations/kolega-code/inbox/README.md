# Inbox Dispatch Config (thebrick)

Version-controlled dispatch configuration for the inbox auto-reply loops.

- **Installer:** `install-cron.sh` — idempotently installs the `*/3` cron
  entries for the Satori and Zefir loops (the full capability variant,
  John 2026-09-09). Run after cloning the repo on thebrick:
  `bash integrations/kolega-code/inbox/install-cron.sh`
- **Policies:** `../inbox-agent/AGENTS.md` (Satori) and
  `../inbox-agent-zefir/AGENTS.md` (Zefir) — three-tier autonomy policy,
  FULL capability with the needs-john category for destructive/access-change
  requests (deletions, IAM/credential grants, billing, irreversible actions).
- **Dispatcher:** `../scripts/satori_inbox.py` — poll → headless dispatch →
  threaded reply. Identity-generic via `KATRA_AGENT_ID` / `KATRA_AGENT_NAMES`
  / `KATRA_INBOX_DIR`.
- **Runtime state** (not version-controlled — machine state):
  `~/.katra/inbox/<agent>.json` (handled/attempts/dispatch caps),
  `<agent>.lock`, `cron.log`, `zefir-cron.log`, `dispatch.log`,
  `needs-john.md` (escalations John reviews).
- **Hard limits carried in every dispatch goal:** one reply per message,
  no secrets/credentials in replies or commits, needs-john category never
  acted in-session.

Full walkthrough: `docs/AGENT-COMMUNICATION-SETUP.md` § "The Automated Inbox
Auto-Reply Loop".
