"""Show which Katra sources contribute to the hook context."""

import asyncio
from types import SimpleNamespace

from kolega_katra_bridge.config import load_config
from kolega_katra_bridge.hook import on_user_prompt


def main():
    cfg = load_config()
    print("Active sources:", cfg.sources)

    event = SimpleNamespace(
        payload={"user_message": "what were we working on?"},
        session_id="test-session",
    )
    result = asyncio.run(on_user_prompt(event))
    context = result.get("additional_context", "")

    print(f"\nContext length: {len(context)} chars")
    print("\nSources found in context:")
    for line in context.splitlines():
        if line.startswith("[") and "Source:" in line:
            print(f"  {line.strip()}")

    print("\n--- first 1200 chars of context ---")
    print(context[:1200])


if __name__ == "__main__":
    main()
