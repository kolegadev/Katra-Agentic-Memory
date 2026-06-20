"""Quick inspection script for Katra tool responses."""

import asyncio
from datetime import datetime, timedelta, timezone

from kolega_katra_bridge.config import load_config
from kolega_katra_bridge.katra_client import KatraMCPClient


async def main():
    cfg = load_config()
    async with KatraMCPClient(cfg) as client:
        print("--- working_memory ---")
        for m in await client.get_working_memory("test-session", limit=5):
            print("SRC", m.source)
            print("META", m.metadata)
            print("CONTENT", repr(m.content[:300]))

        print("\n--- vector_search ---")
        for m in await client.vector_search("Katra memory fixes", limit=3):
            print("SRC", m.source)
            print("META", m.metadata)
            print("CONTENT", repr(m.content[:300]))

        print("\n--- temporal_recall ---")
        now = datetime.now(timezone.utc)
        for m in await client.temporal_recall(
            (now - timedelta(days=7)).isoformat(),
            now.isoformat(),
            limit=3,
        ):
            print("SRC", m.source)
            print("META", m.metadata)
            print("CONTENT", repr(m.content[:300]))

        print("\n--- get_temporal_context ---")
        for m in await client.get_temporal_context("test-session"):
            print("SRC", m.source)
            print("META", m.metadata)
            print("CONTENT", repr(m.content[:300]))


if __name__ == "__main__":
    asyncio.run(main())
