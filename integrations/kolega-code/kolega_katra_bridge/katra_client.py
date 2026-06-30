"""Async MCP client for Katra memory retrieval."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from .config import BridgeConfig

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MemoryItem:
    """One normalized memory result."""

    source: str
    content: str
    metadata: dict[str, Any]
    score: float = 0.0


class KatraClientError(RuntimeError):
    """Raised when Katra cannot be reached or returns an error."""


class KatraMCPClient:
    """Minimal async MCP client for Katra retrieval tools."""

    def __init__(self, config: BridgeConfig) -> None:
        self.config = config
        self._client: Optional[httpx.AsyncClient] = None
        self._mcp_session_id: Optional[str] = None

    async def __aenter__(self) -> "KatraMCPClient":
        timeout = httpx.Timeout(self.config.timeout_seconds, connect=2.0)
        self._client = httpx.AsyncClient(timeout=timeout)
        await self._initialize()
        return self

    async def __aexit__(self, *args: Any) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        self._mcp_session_id = None

    def _headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self._mcp_session_id:
            headers["mcp-session-id"] = self._mcp_session_id
        return headers

    async def _initialize(self) -> None:
        if self._client is None:
            raise KatraClientError("HTTP client not opened")

        init_payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "kolega-katra-bridge", "version": "0.1.0"},
            },
        }

        try:
            response = await self._client.post(
                self.config.mcp_url,
                headers=self._headers(),
                json=init_payload,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise KatraClientError(f"MCP initialize request failed: {exc}") from exc

        self._mcp_session_id = response.headers.get("mcp-session-id")
        if not self._mcp_session_id:
            raise KatraClientError("MCP initialize did not return mcp-session-id")

        # Notify initialized.
        await self._client.post(
            self.config.mcp_url,
            headers=self._headers(),
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        )

    async def _call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        if self._client is None:
            raise KatraClientError("HTTP client not opened")

        payload = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }

        try:
            response = await self._client.post(
                self.config.mcp_url,
                headers=self._headers(),
                json=payload,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise KatraClientError(f"tool {name} request failed: {exc}") from exc

        return _parse_sse_response(response.text)

    async def get_working_memory(self, session_id: str, limit: int = 20) -> list[MemoryItem]:
        """Fetch the Redis-backed working memory for the current session."""
        try:
            result = await self._call_tool(
                "working_memory",
                {"session_id": session_id, "action": "get", "limit": limit},
            )
        except KatraClientError:
            logger.warning("working_memory fetch failed")
            return []

        entries = _pluck_content_list(result)
        return [
            MemoryItem(
                source="working_memory",
                content=_text_from_entry(entry),
                metadata=_metadata_from_entry(entry, {"session_id": session_id}),
            )
            for entry in entries
        ]

    async def vector_search(self, query: str, limit: int = 5) -> list[MemoryItem]:
        """Run semantic vector search across stored memories."""
        args: dict[str, Any] = {
            "query": query,
            "user_id": self.config.user_id,
            "limit": limit,
        }
        if self.config.shared_id:
            args["shared_id"] = self.config.shared_id

        try:
            result = await self._call_tool("vector_search", args)
        except KatraClientError:
            logger.warning("vector_search failed")
            return []

        entries = _pluck_content_list(result)
        return [
            MemoryItem(
                source="vector_search",
                content=_text_from_entry(entry),
                metadata=_metadata_from_entry(entry, {"query": query}),
                score=_float_from_entry(entry, "score", 0.0),
            )
            for entry in entries
        ]

    async def search_memories(self, query: str, limit: int = 5) -> list[MemoryItem]:
        """Full-text + vector search across all memory collections (no embeddings needed)."""
        args: dict[str, Any] = {
            "query": query,
            "user_id": self.config.user_id,
            "limit": limit,
        }
        if self.config.shared_id:
            args["shared_id"] = self.config.shared_id

        try:
            result = await self._call_tool("search_memories", args)
        except KatraClientError:
            logger.warning("search_memories failed")
            return []

        entries = _pluck_content_list(result)
        return [
            MemoryItem(
                source="agent_message",
                content=_text_from_entry(entry),
                metadata=_metadata_from_entry(entry, {"query": query}),
                score=_float_from_entry(entry, "relevance_score", 0.5),
            )
            for entry in entries
        ]

    async def temporal_recall(
        self,
        from_iso: str,
        to_iso: str,
        limit: int = 10,
    ) -> list[MemoryItem]:
        """Fetch recent episodic events in a time range."""
        args: dict[str, Any] = {
            "user_id": self.config.user_id,
            "from": from_iso,
            "to": to_iso,
            "limit": limit,
        }
        if self.config.shared_id:
            args["shared_id"] = self.config.shared_id

        try:
            result = await self._call_tool("temporal_recall", args)
        except KatraClientError:
            logger.warning("temporal_recall failed")
            return []

        entries = _pluck_content_list(result)
        return [
            MemoryItem(
                source="temporal_recall",
                content=_text_from_entry(entry),
                metadata=_metadata_from_entry(entry, {"from": from_iso, "to": to_iso}),
            )
            for entry in entries
        ]

    async def get_temporal_context(self, session_id: str) -> list[MemoryItem]:
        """Fetch Katra's curated temporal context bundle for the session."""
        args: dict[str, Any] = {
            "user_id": self.config.user_id,
            "session_id": session_id,
        }
        if self.config.shared_id:
            args["shared_id"] = self.config.shared_id

        try:
            result = await self._call_tool("get_temporal_context", args)
        except KatraClientError:
            logger.warning("get_temporal_context failed")
            return []

        entries = _pluck_content_list(result)
        return [
            MemoryItem(
                source="temporal_context",
                content=_text_from_entry(entry),
                metadata=_metadata_from_entry(entry, {"session_id": session_id}),
            )
            for entry in entries
        ]

    async def get_daily_reflection(self, period_type: str = "daily") -> list[MemoryItem]:
        """Fetch the latest reflective journal entry from sleep consolidation."""
        args: dict[str, Any] = {
            "period_type": period_type,
            "user_id": self.config.user_id,
        }
        if self.config.shared_id:
            args["shared_id"] = self.config.shared_id

        try:
            result = await self._call_tool("get_daily_reflection", args)
        except KatraClientError:
            logger.warning("get_daily_reflection failed")
            return []

        entries = _pluck_content_list(result)
        return [
            MemoryItem(
                source="reflection",
                content=_text_from_entry(entry),
                metadata=_metadata_from_entry(entry, {"period_type": period_type}),
                score=0.8,
            )
            for entry in entries
        ]

    async def get_philosophical_insights(
        self, domain: str | None = None, status: str | None = None, limit: int = 5
    ) -> list[MemoryItem]:
        """Fetch abstracted principles from sleep consolidation."""
        args: dict[str, Any] = {
            "user_id": self.config.user_id,
            "limit": limit,
        }
        if domain:
            args["domain"] = domain
        if status:
            args["status"] = status
        if self.config.shared_id:
            args["shared_id"] = self.config.shared_id

        try:
            result = await self._call_tool("get_philosophical_insights", args)
        except KatraClientError:
            logger.warning("get_philosophical_insights failed")
            return []

        entries = _pluck_content_list(result)
        return [
            MemoryItem(
                source="reflection",
                content=_text_from_entry(entry),
                metadata=_metadata_from_entry(entry, {"domain": domain or "all"}),
                score=0.7,
            )
            for entry in entries
        ]

    async def get_unresolved_threads(self) -> list[MemoryItem]:
        """Fetch open questions and tensions from sleep consolidation."""
        args: dict[str, Any] = {"user_id": self.config.user_id}
        if self.config.shared_id:
            args["shared_id"] = self.config.shared_id

        try:
            result = await self._call_tool("get_unresolved_threads", args)
        except KatraClientError:
            logger.warning("get_unresolved_threads failed")
            return []

        entries = _pluck_content_list(result)
        return [
            MemoryItem(
                source="reflection",
                content=_text_from_entry(entry),
                metadata={},
                score=0.6,
            )
            for entry in entries
        ]

    async def store_memory(
        self,
        content: str,
        category: str = "event",
        confidence: float = 1.0,
        tags: list[str] | None = None,
    ) -> bool:
        """Store a memory back to Katra — enables agent-to-agent responses."""
        args: dict[str, Any] = {
            "content": content,
            "category": category,
            "user_id": self.config.user_id,
            "confidence": confidence,
            "source": "kolega-code",
            "tags": tags or [],
        }
        if self.config.shared_id:
            args["shared_id"] = self.config.shared_id

        try:
            result = await self._call_tool("store_memory", args)
            logger.info("store_memory succeeded: %s", result)
            return True
        except KatraClientError:
            logger.warning("store_memory failed")
            return False


# ---------------------------------------------------------------------------
# Response parsing helpers
# ---------------------------------------------------------------------------


def _parse_sse_response(text: str) -> Any:
    """Parse an MCP tools/call SSE response into the JSON-RPC result."""
    if not text:
        return None

    data_lines: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())

    if not data_lines:
        # Some transports return raw JSON; tolerate that.
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return None

    payload = "\n".join(data_lines)
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return None

    if isinstance(parsed, dict):
        if "result" in parsed:
            return parsed["result"]
        if "error" in parsed:
            logger.warning("MCP tool returned error: %s", parsed["error"])
            return None
    return parsed


def _pluck_content_list(result: Any) -> list[Any]:
    """Best-effort extraction of a list of memory entries from a tool result."""
    if result is None:
        return []
    if isinstance(result, list):
        return result
    if isinstance(result, dict):
        for key in ("memories", "results", "entries", "events", "facts", "content", "items"):
            if key in result and isinstance(result[key], list):
                return result[key]
        # The whole dict may be a single memory.
        return [result]
    return []


def _text_from_entry(entry: Any) -> str:
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict):
        for key in ("content", "text", "summary", "transcript", "value", "memory"):
            value = entry.get(key)
            if value is not None:
                return str(value)
    return str(entry)


def _metadata_from_entry(entry: Any, base: dict[str, Any]) -> dict[str, Any]:
    meta: dict[str, Any] = dict(base)
    if isinstance(entry, dict):
        for key, value in entry.items():
            if key not in ("content", "text", "summary", "transcript", "value", "memory"):
                meta[key] = value
    return meta


def _float_from_entry(entry: Any, key: str, default: float) -> float:
    if not isinstance(entry, dict):
        return default
    try:
        return float(entry[key])  # type: ignore[index]
    except (KeyError, TypeError, ValueError):
        return default
