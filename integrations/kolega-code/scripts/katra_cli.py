#!/usr/bin/env python3
"""Thin CLI wrapper around the Katra MCP bridge client.

Usage:
  python3 katra_cli.py search_memories '{"query": "my search", "limit": 5}'
  python3 katra_cli.py store_memory '{"content": "test", "category": "fact", "tags": ["test"]}'
  python3 katra_cli.py vector_search '{"query": "concept"}'
  python3 katra_cli.py get_unresolved_threads '{}'
  python3 katra_cli.py working_memory '{"session_id": "abc", "action": "get"}'
"""

import asyncio
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from kolega_katra_bridge.config import load_config
from kolega_katra_bridge.katra_client import KatraMCPClient


async def main():
    if len(sys.argv) < 3:
        print("Usage: katra_cli.py <tool_name> '<json_args>'", file=sys.stderr)
        sys.exit(1)

    tool_name = sys.argv[1]
    try:
        arguments = json.loads(sys.argv[2])
    except json.JSONDecodeError as e:
        print(f"Invalid JSON args: {e}", file=sys.stderr)
        sys.exit(1)

    config = load_config()
    async with KatraMCPClient(config) as client:
        result = await client._call_tool(tool_name, arguments)
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
