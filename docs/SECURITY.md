# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Satori, please report it privately via GitHub Security Advisories at [github.com/kolegadev/katra/security/advisories](https://github.com/kolegadev/katra/security/advisories). Do not open a public issue.

## Architecture Overview

Satori implements defense-in-depth across multiple layers:

### Authentication

- **API keys**: SHA-256 hashed in MongoDB. Plaintext never stored at rest.
- **Timing-safe comparison**: All key validation uses `timingSafeEqual` to prevent timing side-channel attacks.
- **Dual-key system**: `MCP_API_KEY` for agent access, `KATRA_API_KEY` for admin operations.
- **Stdio transport**: Refuses to start unless `MCP_API_KEY` is configured.
- **Auto-generation**: If no keys are set, cryptographically random keys are generated on first boot (256-bit entropy).

### Authorization & User Scoping

- **All database queries include `user_id` filter** — no query returns data across users.
- **Memory scope service** — `buildScopeFilter()` never returns an empty `{}` filter. Falls back to `DEFAULT_USER_ID` in all modes (personal, shared, hybrid).
- **Route-level auth** — every route file has `validateKatraKey` middleware. No route serves data without auth.
- **Admin gating** — `set_memory_scope` and `configure_llm` require `KATRA_API_KEY` (admin), not just `MCP_API_KEY`.
- **IDOR prevention** — user identity is bound server-side, never accepted from client body/query params.

### Input Validation

| Protection | Mechanism |
|-----------|-----------|
| Prototype pollution | `__proto__`, `constructor`, `prototype` keys rejected in working memory content |
| Request body size | Capped at 10MB for MCP requests |
| Working memory size | Capped at 5MB per item |
| Metadata injection | Caller-supplied metadata stripped of internal fields (`processed`, `created_at`, `cascade_depth`) |
| API key regeneration | Requires `?confirm=true` query parameter |
| Rate limiting | Sliding window, Redis-backed. Ingestion: 120 req/min. Admin: per-endpoint limits. |
| SSRF prevention | LLM base URL validation — blocks localhost, metadata service, private IPs, enforces HTTPS |

### Data Protection

| Protection | Mechanism |
|-----------|-----------|
| Extraction audit log | Stores **summary only** (counts), not raw extracted data |
| Error logs | Sanitized — only error messages, no stack traces with file paths |
| Hostname exposure | Removed from processor IDs (uses `proc-{pid}` instead) |
| LLM API key | Stored in `system_settings` with access restricted to admin endpoints |
| Credential masking | Extraction patterns detect and mask API keys, tokens, and secrets in facts |

### Database-Level Hardening

- All collections scoped by `user_id` or `tenant_id`
- `findOneAndUpdate` operations use `$setOnInsert` for `created_at` (never double-write)
- Retry counters use `$inc` at the top level (not inside `$set` — logic bug fixed)
- `$and` used for embedding queries to prevent `keywordFilter` from overriding user scoping

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

The test suite includes 18 dedicated security regression tests that run on every build:

```bash
npm run test:security
```

These verify:
- `buildScopeFilter` never returns `{}`
- All DB queries include `user_id` filter
- Prototype pollution keys are blocked
- `$inc` is not inside `$set`
- `keywordFilter` cannot override `user_id`
- Admin tools require admin key
- Routes reject unauthenticated requests
- Size limits are enforced

## Responsible Disclosure Timeline

| Date | Event |
|------|-------|
| Jun 20-23, 2026 | Initial vulnerability fixes applied (18 security commits) |
| Jun 24, 2026 | Comprehensive security audit: 51 issues found across 19 files |
| Jun 24, 2026 | All 51 fixes applied, deployed, and verified |
| Jun 24, 2026 | Test suite created: 87 tests, 9 files, 0 failures |
| Jun 24, 2026 | Security policy published |

## Dependency Security

- `npm audit` run on every build
- Production dependencies minimized (242 packages in runtime image)
- Build-time only dependencies isolated in builder stage (multi-stage Dockerfile)
- `@xenova/transformers` (ONNX runtime) requires glibc — `node:20-slim` used, not Alpine

## Acknowledgments

Security review and fixes by the Satori team. Particular attention to:
- User scoping on all database queries
- Empty filter prevention in memory scope service
- Timing-safe API key comparison
- Prototype pollution in working memory
- SSRF in LLM base URL configuration
