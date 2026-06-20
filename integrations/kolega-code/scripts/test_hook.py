"""Test the hook end-to-end with the live Katra server."""

import asyncio
from types import SimpleNamespace

from kolega_katra_bridge.config import load_config
from kolega_katra_bridge.hook import on_user_prompt
from kolega_katra_bridge.retriever import MemoryRetriever


def main():
    # Direct retriever test to see raw results.
    cfg = load_config()
    print("Config sources:", cfg.sources)

    async def run_retriever():
        retriever = MemoryRetriever(cfg)
        memories = await retriever.retrieve("what were we working on?", "test-session")
        print(f"Retriever returned {len(memories)} memories")
        for m in memories:
            print(f"  [{m.source}] {m.content[:120]!r}")

    asyncio.run(run_retriever())

    # Hook test.
    event = SimpleNamespace(
        payload={"user_message": "what were we working on?"},
        session_id="test-session",
    )
    result = asyncio.run(on_user_prompt(event))
    if result:
        print("\n--- additional_context ---")
        print(result.get("additional_context", ""))
    else:
        print("\nNo additional context returned")


if __name__ == "__main__":
    main()
