# Kolega Katra Bridge

Dynamic Katra memory retrieval for Kolega Code.

This package is part of the Katra repo (`integrations/kolega-code`). It
provides a Kolega Code lifecycle hook that automatically fetches relevant
memories from Katra on every `UserPromptSubmit` and injects them into the
agent's context.

## Installation

```bash
cd integrations/kolega-code
uv pip install --python ~/.local/share/uv/tools/kolega-code/bin/python -e .
```

## Configuration

1. Copy or edit `~/Library/Application Support/kolega-code/katra-hook.json`.
2. Add the hook to `~/Library/Application Support/kolega-code/hooks.json`:

```json
{
  "schema_version": 1,
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "python",
            "callable": "kolega_katra_bridge.hook:on_user_prompt",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

## How it works

On each user prompt, the hook:

1. Loads runtime config from `katra-hook.json`.
2. Queries Katra's `working_memory`, `get_temporal_context`, `vector_search`, and `temporal_recall` tools.
3. Ranks, deduplicates, and truncates results to a configurable token budget.
4. Returns formatted memory context as `additional_context`.

If Katra is unreachable or the query fails, the hook returns empty context so
Kolega Code continues normally.

## Testing

```bash
cd integrations/kolega-code
/Users/johnpellew/.local/share/uv/tools/kolega-code/bin/python scripts/test_hook.py
```

To inspect raw Katra tool responses:

```bash
/Users/johnpellew/.local/share/uv/tools/kolega-code/bin/python scripts/inspect_katra.py
```
