# Long-horizon cognitive control — the record

This directory is the **design, contract and review record** for the long-horizon cognitive-control
plane. It is here so that the reasoning behind the capability lives with the code that implements it,
in one repository, under version control.

It was delivered as a standalone unversioned directory (`~/katra-long-horizon`, 1.1 MB, no git
history). The code had already landed here; the record had not. That is what this import fixes.

## Where the capability actually lives

| artefact | location in this repo | note |
|---|---|---|
| the plane itself | `server/src/services/mission-cognition/` — 30 modules | the implementation, not a copy |
| its MCP tools | `server/src/mcp-server.ts` | 84 tools today |
| its schemas | `server/src/services/mission-cognition/schemas/` | **authoritative** — see below |
| its skills (9) | `server/src/skills/{operational,decision,troubleshooting}/` | installed, not duplicated here |
| its tests | `server/tests/unit/mission-cognition-*.test.ts`, `cognitive-team*.test.ts` | |
| this record | `docs/long-horizon/` | what you are reading |

## Authority order, when these disagree

1. **The source.** `server/src/services/mission-cognition/schemas/*.schema.json` is what the running
   service validates against, and it carries eight phases of change.
2. **The phase contracts** (`contracts/`). Each states the acceptance criteria for one phase.
3. **The design documents** (`brief/`). The phase-1 scoping and plan — the intent, before the build.

## The delivered schemas are NOT copied here, deliberately

The handoff package shipped six schemas. They are the **phase-1 sketch**; the source copies are the
contract as built. Copying them in would create a second source of truth that is wrong by a factor of
three:

| schema | delivered | source | delta |
|---|---:|---:|---|
| `agent-cognitive-profile.schema.json` | 32 | 93 | source has +17 keys the sketch never had |
| `cognitive-baton.schema.json` | 41 | 162 | |
| `cognitive-work-item.schema.json` | 34 | 131 | |
| `epistemic-entry.schema.json` | 45 | 192 | |
| `mission-state.schema.json` | 75 | 333 | source adds `stop_conditions_history`, `from`, `delta_id`, `at` |
| `state-delta.schema.json` | 42 | 187 | source adds delta `status` (`proposed`/`accepted`/`rejected`/`conflict`/`duplicate`), `applied_at` |

If you need the delivered copies, they remain in the original package, whose integrity is recorded in
`MANIFEST.sha256` and `contracts/MANIFEST.sha256`.

## What was changed on import, and why

* **Three absolute home paths were scrubbed.** `harness/run.sh` and the two harness `.mjs` files
  defaulted to `/home/<user>/Katra-Agentic-Memory`. They now use `$HOME` / `$KATRA_REPO`, because the
  repository's CI privacy lint fails on absolute home paths in tracked files. No behaviour changes:
  the same default resolves, and the env overrides still win.
* **Nothing else was edited.** The documents are as delivered, including their phase-scoped numbers.
  A number quoted in a phase contract is a claim about that phase's rules, not a current result.

## What this is not

It is not a second implementation, not a changelog, and not authoritative over the source. If a
document here and the code disagree, the code is right and the document is a record of what was
intended — which is itself worth keeping, because it is the only place the *intent* is written down.
