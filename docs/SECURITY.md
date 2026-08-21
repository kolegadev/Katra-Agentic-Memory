# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Katra, please report it privately via GitHub Security Advisories at [github.com/kolegadev/Katra-Agentic-Memory/security/advisories](https://github.com/kolegadev/Katra-Agentic-Memory/security/advisories). Do not open a public issue.

## Architecture Overview

Katra implements defense-in-depth across multiple layers:

### Authentication — key-based identity

- **Identity from the presented key**: every request's caller is resolved by `resolveCallerIdentity()` from the key presented in `X-MCP-Auth`, `Authorization: Bearer ...`, or `?token=` — never from client self-report.
- **SHA-256-only client keys**: `system_settings.client_keys` stores only key hashes, mapped to identities (`satori`, `shoshin`, `zanshin`). Plaintext keys are never stored at rest; the shoshin/zanshin keys are printed exactly once at provisioning.
- **Trusted satori**: loopback callers and the admin key (`KATRA_API_KEY`) authenticate as trusted satori; key-mapped clients are untrusted identities.
- **Timing-safe comparison**: All key validation uses `timingSafeEqual` to prevent timing side-channel attacks.
- **Loud rejection**: a valid-but-unmapped key is rejected with **401 + reason** (and an explanatory log line with the presented key's sha256 prefix) — no silent fallback to another identity.
- **Retired legacy env keys**: `MCP_API_KEY`, `ADMIN_API_KEY`, and `BACKUP_MCP_KEYS` no longer authenticate. They were deliberately unmapped at the 2026-08-21 cutover so machines still holding them fail loudly instead of writing memories under Satori's identity.
- **Auto-generation**: If no admin key is set, a cryptographically random key is generated on first boot (256-bit entropy) and its hash persisted.

### Authorization & Per-Caller Scoping (the IDOR boundary)

- **Per-caller scoping** — every MCP tool call and REST request runs inside a resolved caller identity (AsyncLocalStorage). Identity is bound server-side; a client-supplied `user_id` from an untrusted caller is ignored.
- **Trusted callers only** — only loopback and the admin key may act for a named user; everyone else is pinned to their own identity.
- **Write scope policy** (`write-scope-policy.ts`) — personal kinds (`journal`, `reflection`, `emotional`, `insight`) are always private to the writer, even when a shared write is requested; every other write defaults to shared `my-team` unless `private: true`.
- **Read scoping** — reads return the caller's own private memories + `my-team` shared memories; another identity's private data is never visible (`hybrid_visible_user_ids` is pinned to `[]` at boot).
- **Memory scope service** — `buildScopeFilter()` never returns an empty `{}` filter. Falls back to the safe default user scope in all modes (personal, shared, hybrid).
- **Admin gating** — `set_memory_scope` and `configure_llm` require `KATRA_API_KEY` (admin), and `GET /api/v1/admin/identity?user_id=X` / `PUT /api/v1/admin/identity` enforce the admin key themselves.

### Input Validation

| Protection | Mechanism |
|-----------|-----------|
| Prototype pollution | `__proto__`, `constructor`, `prototype` keys rejected in working memory content |
| Request body size | Capped at 10MB for MCP requests |
| Working memory size | Capped at 5MB per item |
| Metadata injection | Caller-supplied metadata stripped of internal fields (`processed`, `created_at`, `cascade_depth`) |
| Tenant key regeneration | Requires `?confirm=true` query parameter (multi-tenant mode) |
| Rate limiting | Sliding window, Redis-backed. Ingestion: 120 req/min. Admin: per-endpoint limits. |
| SSRF prevention | LLM base URL validation — blocks localhost, metadata service, private IPs, enforces HTTPS (except trusted Docker-internal Ollama) |

### Data Protection

| Protection | Mechanism |
|-----------|-----------|
| Extraction audit log | Stores **summary only** (counts), not raw extracted data |
| Error logs | Sanitized — only error messages, no stack traces with file paths |
| Hostname exposure | Removed from processor IDs (uses `proc-{pid}` instead) |
| LLM API key | Stored in `system_settings` with access restricted to admin endpoints |
| Credential masking | Extraction patterns detect and mask API keys, tokens, and secrets in facts |

### Database-Level Hardening

- All memory collections scoped by `user_id` and/or `shared_id` (tenant_id in multi-tenant mode)
- `findOneAndUpdate` operations use `$setOnInsert` for `created_at` (never double-write)
- Retry counters use `$inc` at the top level (not inside `$set` — logic bug fixed)
- `$and` used for embedding queries to prevent `keywordFilter` from overriding user scoping

## Identity Separation & Scope Policy (2026-08-21)

The 2026-08-21 identity separation release replaced the dual-key model with caller-bound identities:

- **F1 — caller-bound identities**: `resolveCallerIdentity()` + `client_keys` (sha256-only) + AsyncLocalStorage propagation. Identity is never taken from client self-report; valid-but-unmapped keys are rejected loudly with 401.
- **F2 — write scope policy**: personal kinds forced private, `my-team` shared default, `hybrid_visible_user_ids` pinned to `[]` at boot.
- **F3 — allocation candidates**: the autonomous executive allocates work only to `satori`, `shoshin`, `zanshin`; the `gas-law-watcher` tool actor is never allocated.
- **Legacy key retirement**: `MCP_API_KEY` / `ADMIN_API_KEY` / `BACKUP_MCP_KEYS` no longer authenticate (see above). Non-loopback consumers must hold a `client_keys`-mapped key.

## Security Fixes Applied (June 2026 Audit)

A comprehensive security audit identified and fixed **51 issues** across 7 batches:

| Batch | Category | Fixes |
|-------|----------|-------|
| 1 | DB query scoping | Added `user_id` to all read/write operations (11 fixes) |
| 2 | Route auth | Added `validateKatraKey` to unauthenticated routes (5 fixes) |
| 3 | Log sanitization | Removed debug data dumps, sanitized error logs, summary-only audit logs (8 fixes) |
| 4 | MCP hardening | Stdio auth, conversation history scoping, admin gating (5 fixes) |
| 5 | User ID binding | All endpoints derive user_id from server context, not client input (5 fixes) |
| 6 | Input validation | Size limits, prototype pollution, metadata sanitization, request body caps (8 fixes) |
| 7 | Code quality | Key regeneration confirmation, debug endpoint guards, admin role checks (9 fixes) |

## Regression Testing

The security regression suite (in `server/tests/security/`, run on every build via `server/tests/run-all.sh`) covers:

```bash
npm run test:security
```

These verify:
- `buildScopeFilter` never returns `{}`
- All DB queries include `user_id` filter
- Prototype pollution keys are blocked
- `$inc` is not inside `$set`
- `keywordFilter` cannot override `user_id`
- Admin tools require the admin key
- Routes reject unauthenticated requests
- Size limits are enforced
- Tenant key regeneration requires `confirm=true`

## Responsible Disclosure Timeline

| Date | Event |
|------|-------|
| Jun 20-23, 2026 | Initial vulnerability fixes applied (18 security commits) |
| Jun 24, 2026 | Comprehensive security audit: 51 issues found across 19 files |
| Jun 24, 2026 | All 51 fixes applied, deployed, and verified |
| Jun 24, 2026 | Test suite created: 87 tests, 9 files, 0 failures |
| Jun 24, 2026 | Security policy published |
| Aug 21, 2026 | Identity separation shipped: caller-bound identities, write scope policy, client_keys (sha256-only), legacy env keys retired |

## Dependency Security

- `npm audit` run on every build
- Production dependencies minimized (242 packages in runtime image)
- Build-time only dependencies isolated in builder stage (multi-stage Dockerfile)
- `@xenova/transformers` (ONNX runtime) requires glibc — `node:20-slim` used, not Alpine

## Acknowledgments

Security review and fixes by the Satori team. Particular attention to:
- Per-caller scoping on all database queries (the IDOR boundary)
- Empty filter prevention in memory scope service
- Write scope policy (personal kinds forced private, `my-team` default)
- SHA-256-only client key storage and loud 401 rejection of unmapped keys
- Timing-safe API key comparison
- Prototype pollution in working memory
- SSRF in LLM base URL configuration
