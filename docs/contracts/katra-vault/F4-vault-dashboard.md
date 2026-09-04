# CONTRACT — F4: Katra Vault dashboard (operator secret management UI)

Source of truth: `docs/katra-vault-design.md` §2.2 ("Dashboard — the natural home
for secret entry"), §7.2, §9.

## Goal
Add a **Secrets** section to the existing Katra dashboard (single-file
`dashboard/index.html`) that lets an operator create/list/rotate/delete vault
secrets through the F3 REST API — with the same hard redaction in the UI:
secret values are entered but never displayed back, echoed in errors, or
written to browser storage.

## Boundaries — MUST NOT touch
- `server/**` entirely (no routes, store, MCP, crypto, or index changes)
- No new files besides the one dashboard file (dashboard/index.html is
  self-contained; do not add new JS/CSS files)
- Do not restructure existing dashboard sections; ADD a new section in the
  same visual/JS idiom.

## Files this feature may create/modify
- MODIFY `dashboard/index.html` only.

## Requirements
1. **Auth**: reuse the exact mechanism the dashboard already uses for its
   existing API calls (find how it authenticates against `/api/v1/...` — the
   dashboard's existing key/config management already talks to the API; copy
   that pattern verbatim for `/api/v1/vault/*` calls).
2. **Create form**: name, value (password-type input), scope (private/team),
   optional service, optional kind (api_key/password/token/env), approvalRequired,
   rotatable. POST `/api/v1/vault/secrets` → show success with `secret_id` (never
   the value) or the API error text (which itself must not contain the value —
   assert in tests by inspection).
3. **List**: GET `/api/v1/vault/secrets` → table of SecretMeta
   (secret_id, name, scope, service, kind, created_at, last_used_at,
   rotation_due_at, approval_required, rotatable). **Never render envelope or
   value fields** — even if the API accidentally returned them, the UI must
   only display the meta keys.
4. **Row actions**: Delete and Rotate buttons → DELETE `/api/v1/vault/secrets/:id`
   and POST `/api/v1/vault/secrets/:id/rotate`, then refresh the list. Errors
   shown from the API text only.
5. **Redaction hygiene**: after a successful create, CLEAR the value input.
   No `localStorage`/`sessionStorage` writes containing the value. No
   `console.log` of the value. 404/403/503 responses rendered without echoing
   the submitted value (the API never returns it — the UI must not resend it
   into the DOM either).
6. **No new external assets**: no new CDN scripts/fonts/images; reuse what
   index.html already loads.

## Success criteria (all must pass)
1. The dashboard file parses: extracting inline `<script>` blocks and running
   `node --check` on each (after stripping nothing — they must be plain JS,
   no TS) reports zero syntax errors; the HTML remains well-formed enough to
   pass a basic tag-balance check (`python3 -c` with html.parser, no parser
   errors).
2. Static audit: the new section references exactly the F3 endpoints
   (`/api/v1/vault/secrets`, `/api/v1/vault/secrets/:id` DELETE + `/rotate`,
   no others) and uses the same auth header mechanism as the dashboard's
   pre-existing API calls (grep the pre-existing calls and compare).
3. Static audit: the UI renders only SecretMeta keys — grep the new code for
   `envelope|ciphertext|dek_wrapped|iv|tag` → zero occurrences in rendering
   paths (variable names for request payloads must not collide either).
4. Static audit: no `localStorage`/`sessionStorage`/`console.log` calls that
   involve the secret value variable.
5. Existing dashboard sections untouched: diff shows only additive changes
   (new section markup + new functions); no existing function bodies or
   existing element handlers modified.
6. `npm test` in server/: zero NEW failures (5 known pre-existing allowed).
7. Functional smoke (Verifier does this): serve `dashboard/index.html`
   statically (`python3 -m http.server` from the dashboard dir), fetch it with
   curl — 200 and contains the new section title. (Full interactive testing
   happens at the human gate with the live stack.)

## Acceptance command
```
cd dashboard && python3 -m http.server 8137 &  # smoke
curl -s http://localhost:8137/index.html | grep -i "vault"
cd ../server && npm test   # zero new failures
```

## Implementation notes
- Match the dashboard's existing section structure (titles, forms, tables,
  fetch wrappers) — the file already manages API keys and LLM config; the
  Secrets section should look native to it.
- The value input must be `type="password"` and cleared after submit.
- `encodeURIComponent` the secret_id in URL paths.
- Keep the diff additive and small (~150-250 lines).
