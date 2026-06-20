"""
Katra Python SDK — v1.0.0
=========================

Katra is a standalone cognitive memory server providing 29 memory primitives
for agentic LLMs: store, recall, search, summarize, pattern-detect, and more.

This SDK provides a clean Pythonic interface to both the MCP (JSON-RPC over HTTP/SSE)
and REST API endpoints of a Katra memory server.

Quick Start
-----------
>>> from katra import KatraClient
>>> client = KatraClient("http://localhost:3112", api_key="your-api-key")
>>> client.store_memory("User prefers dark mode", category="preference")
>>> results = client.search_memories("dark mode")

For advanced MCP usage:
>>> from katra import KatraMCPClient
>>> mcp = KatraMCPClient("http://localhost:3112", api_key="your-api-key")
>>> mcp.initialize()
>>> result = mcp.call_tool("search_memories", {"query": "dark mode"})
"""

__version__ = "1.0.0"
__all__ = [
    "KatraClient",
    "KatraMCPClient",
    "KatraError",
    "KatraAuthError",
    "KatraConnectionError",
]

from katra.client import KatraClient
from katra.mcp_client import KatraMCPClient
from katra.exceptions import KatraError, KatraAuthError, KatraConnectionError
