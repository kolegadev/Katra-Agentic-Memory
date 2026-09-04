# Katra Vault — User Instructions

The **Katra Vault** is Satori's built-in secure secret store for the team:
encrypted at rest, partitioned by identity, and wired so a secret never passes
through an LLM. Design rationale and threat model: [katra-vault-design.md](katra-vault-design.md).
Implementation shipped 2026-09-04 (main, commit `e1392f4`).

---

## What you get

| Guarantee | How |
|---|---|
| **Encrypted at rest** | AES-256-GCM envelope encryption; per-secret data keys wrapped by per-scope keys derived from `KATRA_VAULT_MASTER_KEY` (HKDF-SHA256) |
| **Partitioned access** | Private secrets are owned by one identity; team secrets (`shared_id: my-team`) are visible to everyone but usable only with an approval |
| **No secret ever reaches an LLM** | The vault collections are denylisted from the entire memory pipeline; tool results and audit rows are value-free |
| **Usage is gated + audited** | Secrets can only be *used* through approval-gated capability tools; every use writes a value-free audit row |
| **TOTP-ready** | RFC 6238 TOTP enrollment + short-lived session tokens shipped; enforcement cutover is opt-in per identity (see "Deferred") |

## Setup requirements

- `KATRA_VAULT_MASTER_KEY` in `.env` — generated automatically by `install.sh`
  for new installs; for existing installs add `KATRA_VAULT_MASTER_KEY=<64 hex chars>`
  (`openssl rand -hex 32`). The key is never committed.
- The admin key (`KATRA_API_KEY`) grants trusted (operator) access: create
  secrets for any owner, manage approvals, run migrations.

## Managing secrets

### Dashboard (recommended for humans)
Open `http://localhost:9012/dashboard/` → **Secrets** tab (enter the admin key
when prompted).

- **Create**: Name, Value (password field, cleared after submit), Scope
  (`private` shows an **Owner** field — e.g. `lilly`; `team` shares with
  everyone), Service (e.g. `agentmail`, `github`), Kind (`api_key`,
  `password`, `token`, `env`), Approval required, Rotatable.
- **List**: metadata only — the value is never displayed back.
- **Rotate**: re-encrypts with a fresh data key (value unchanged, new envelope).
- **Delete**: removes the secret.
- Name rules: non-empty, ≤128 chars, no `/`.

### REST (`/api/v1/vault/*`, admin key or identity key)
```bash
curl -X POST localhost:9012/api/v1/vault/secrets \
  -H "Authorization: Bearer $KATRA_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"agentmail-api-key","value":"...","scope":"private","ownerUserId":"lilly","service":"agentmail","kind":"api_key"}'
# → {"secret_id":"lilly/agentmail-api-key","created":true}

curl localhost:9012/api/v1/vault/secrets -H "Authorization: Bearer $KATRA_API_KEY"
curl -X POST localhost:9012/api/v1/vault/secrets/lilly%2Fagentmail-api-key/rotate -H "Authorization: Bearer $KATRA_API_KEY"
curl -X DELETE localhost:9012/api/v1/vault/secrets/lilly%2Fagentmail-api-key -H "Authorization: Bearer $KATRA_API_KEY"
```
Untrusted (identity-key) callers are always pinned to their own partition;
`ownerUserId` is honored only for the admin key.

### MCP tools (for agents)
`vault_put_secret` (operator only), `vault_list_secrets`, `vault_get_secret`
(redacted: returns length + `value: "<redacted>"`), `vault_delete_secret`,
`vault_rotate_secret`, `vault_audit`.

## Using a secret (capability layer)

Secrets are only *used* server-side. Two steps:

1. **Grant an approval** (operator): dashboard → Secrets → Approvals, or
   ```bash
   curl -X POST localhost:9012/api/v1/vault/approvals \
     -H "Authorization: Bearer $KATRA_API_KEY" -H "Content-Type: application/json" \
     -d '{"identity":"lilly","service":"agentmail","ttlDays":30}'
   ```
2. **Call the capability** (identity key):
   ```bash
   curl -X POST localhost:9012/api/v1/vault/capability/http \
     -H "Authorization: Bearer <lilly-key>" -H "Content-Type: application/json" \
     -d '{"secret_id":"lilly/agentmail-api-key","service":"agentmail","method":"GET","url":"https://api.agentmail.to/v0/inboxes","inject_header":"Authorization","inject_scheme":"Bearer"}'
   ```
   `inject_scheme` prefixes the header value (`Bearer <secret>`); omit it to
   send the raw secret. MCP tool: `vault_http`.

**Guardrails baked in:** approval required (per identity × service, wildcard
`*` allowed), SSRF pre-flight (https-only, port 443, private/loopback/link-local
IPs blocked, no redirects, 5 MB cap, 30 s timeout), and one value-free audit row
per attempt. Per-service drivers (AgentMail: `inbox_list`, `thread_list`,
`thread_reply`, `inbox_create`) build on the same core.

## TOTP agent auth (shipped, enforcement deferred)

- `auth_enroll_totp` (operator) → returns a one-time `otpauth://` QR URI; the
  secret is stored encrypted in the identity's private partition.
- `auth_issue_session` (identity + TOTP code) → short-lived session token
  (12 h interactive / 720 h unattended); replay-guarded atomically.
- `auth_revoke_session`, `auth_session_status`.
- **Deferred**: `require_totp` is `false` for every identity. Flip it per
  identity (policy lives in `system_settings.auth_policy`) only after the team
  has enrolled. Until then, static client keys work as before.

## Migration tooling (plaintext → vault)

`scripts/vault-migrate.sh` — dry-run by default, destructive only with `--apply`:
finds legacy plaintext secret docs, imports `~/.katra/keys/agentmail-lilly.key`
if present, hard-deletes flagged legacy docs (or redacts in place), and writes a
**redacted** audit report (`server/vault-migration-report-*.json`). The scanner
ignores redaction markers, placeholders, masked and short values, so a clean
scan honestly means zero plaintext secrets.

```bash
MONGODB_URI=mongodb://admin:change-me@<mongo>:27017/katra?authSource=admin \
  bash scripts/vault-migrate.sh --dry-run        # read-only report
# …review…
bash scripts/vault-migrate.sh --apply            # perform deletes/import
```

## Regression harness

`dashboard/qa/qa_vault_page.py` — 33-check Playwright suite over the live
dashboard (requires `playwright` + chromium, stack up, admin key in `.env`):
form mechanics, redaction, create/rotate/approval flows, and mechanical XSS
checks. Run: `python3 dashboard/qa/qa_vault_page.py`.

## Deferred / known limits

- TOTP **enforcement** on existing MCP/REST paths (cutover decision, see above).
- `vault_http` resolves the host for the SSRF pre-flight but `fetch` re-resolves
  independently — DNS-rebinding hardening (pin IP + SNI) is a recommended
  follow-up.
- 5 pre-existing identity-drift test failures (client-key count expectations
  after the `lilly` identity was added) remain to be fixed.
