"""
Katra MCP Client — Low-Level JSON-RPC Transport
===============================================

.. attention::
   Most users should use :class:`katra.KatraClient` which wraps this
   transport with Pythonic methods for every tool.

   Use :class:`KatraMCPClient` directly only when you need fine-grained
   control over the MCP handshake, tool discovery, or custom JSON-RPC
   calls.

Architecture
------------
The Katra MCP server speaks JSON-RPC 2.0 over HTTP with SSE (Server-Sent
Events) responses.  The flow is:

1. **Initialize** — POST ``{"jsonrpc":"2.0","method":"initialize",...}``
   The server responds with capabilities and a ``mcp-session-id`` header.
2. **Subsequent calls** — All later requests include that session-id.
3. **Tool calls** — ``{"jsonrpc":"2.0","method":"tools/call","params":{...}}``
4. **SSE parsing** — Responses arrive as ``data: `` lines which we parse.

Example
-------
>>> from katra import KatraMCPClient
>>> mcp = KatraMCPClient("http://localhost:3100", api_key="secret")
>>> caps = mcp.initialize()
>>> tools = mcp.list_tools()
>>> result = mcp.call_tool("search_memories", {"query": "AI", "limit": 5})
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Dict, List, Optional

import requests

from katra.exceptions import (
    KatraAuthError,
    KatraConnectionError,
    KatraError,
    KatraProtocolError,
    KatraTimeoutError,
    KatraToolError,
)

_LOGGER = logging.getLogger(__name__)

# Regex to extract individual SSE `data:` lines from a multi-line response body.
_SSE_DATA_RE = re.compile(r"^data:\s*(.+)$", re.MULTILINE)

# Request-ID counter (monotonically increasing per client instance).
# Shared across threads is fine for a tiny integer counter.
_ID_COUNTER = 0


def _next_id() -> int:
    global _ID_COUNTER
    _ID_COUNTER += 1
    return _ID_COUNTER


class KatraMCPClient:
    """Low-level MCP client that speaks JSON-RPC 2.0 over HTTP/SSE.

    Parameters
    ----------
    url : str
        Base URL of the Katra server (e.g. ``http://localhost:3100``).
        The MCP endpoint is ``{url}/mcp``.

    api_key : str | None
        API key matching the server's ``MCP_API_KEY`` or ``ADMIN_API_KEY``.
        If the server was started without authentication this can be ``None``.

    timeout : float
        Default request timeout in seconds (default 30).

    verify : bool | str
        TLS certificate verification.  Set to ``False`` for self-signed
        certs (development only), or pass a path to a CA bundle.
    """

    # ── Constants ───────────────────────────────────────────────

    MCP_ENDPOINT = "/mcp"
    """Relative URL path for MCP JSON-RPC requests."""

    HTTP_HEADERS_BASE: Dict[str, str] = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    """Headers sent with every request (minus Authorization)."""

    # ── Lifecycle ───────────────────────────────────────────────

    def __init__(
        self,
        url: str,
        api_key: str | None = None,
        timeout: float = 30.0,
        verify: bool | str = True,
    ) -> None:
        # Normalise base URL — strip trailing slash so we can append /mcp cleanly.
        self._base_url: str = url.rstrip("/")
        self._api_key: str | None = api_key
        self._timeout: float = timeout
        self._verify: bool | str = verify

        self._session_id: str | None = None
        """MCP session ID returned by the server on initialize."""

        self._server_info: Dict[str, Any] | None = None
        """Capabilities + server metadata from the initialize handshake."""

        self._tools: List[Dict[str, Any]] = []
        """Cached tool list from the last ``list_tools`` call."""

        self._session: requests.Session = self._build_session()

    # ── Public API ──────────────────────────────────────────────

    def initialize(self) -> Dict[str, Any]:
        """Perform the MCP initialize handshake.

        This MUST be called before any tool calls.  It negotiates
        capabilities and obtains a session ID from the server.

        Returns
        -------
        dict
            Server capabilities and metadata.

        Raises
        ------
        KatraConnectionError
            If the server is unreachable.
        KatraAuthError
            If authentication fails.
        KatraProtocolError
            If the server response is malformed.
        """
        response = self._rpc_request(
            method="initialize",
            params={
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {
                    "name": "katra-python-sdk",
                    "version": "1.0.0",
                },
            },
        )
        self._server_info = response.get("result", {})
        _LOGGER.info(
            "MCP initialized — server: %s v%s",
            self._server_info.get("serverInfo", {}).get("name", "katra"),
            self._server_info.get("serverInfo", {}).get("version", "?"),
        )
        return self._server_info

    def list_tools(self) -> List[Dict[str, Any]]:
        """Fetch the list of available MCP tools from the server.

        Returns
        -------
        list[dict]
            Tool definitions (name, description, inputSchema).

        Raises
        ------
        KatraProtocolError
            If the response is not a valid tool list.
        """
        response = self._rpc_request(method="tools/list")
        tools = response.get("result", {}).get("tools", [])
        self._tools = tools
        return tools

    def call_tool(self, name: str, arguments: Dict[str, Any] | None = None) -> Any:
        """Call a named MCP tool on the server.

        Parameters
        ----------
        name : str
            Tool name, e.g. ``"search_memories"``.
        arguments : dict | None
            Keyword arguments for the tool (optional).

        Returns
        -------
        Any
            Parsed result — usually a dict, list, or str.

        Raises
        ------
        KatraToolError
            If the server reports an error from the tool.
        KatraProtocolError
            If the response is malformed.
        """
        response = self._rpc_request(
            method="tools/call",
            params={"name": name, "arguments": arguments or {}},
        )
        result = response.get("result", {})
        if result.get("isError"):
            text = _extract_text(result.get("content", []))
            raise KatraToolError(name, text)
        return result

    def call_tool_text(self, name: str, arguments: Dict[str, Any] | None = None) -> str:
        """Call a tool and return just the text content.

        Convenience wrapper that extracts the ``text`` field from the
        first ``text`` content item in the MCP response.

        Parameters
        ----------
        name : str
            Tool name.
        arguments : dict | None
            Keyword arguments.

        Returns
        -------
        str
            Text response from the tool.
        """
        result = self.call_tool(name, arguments)
        return _extract_text(result.get("content", []))

    # ── Private helpers ─────────────────────────────────────────

    def _build_session(self) -> requests.Session:
        session = requests.Session()
        session.headers.update(self.HTTP_HEADERS_BASE)
        if self._api_key:
            session.headers["Authorization"] = f"Bearer {self._api_key}"
        return session

    def _rpc_request(
        self,
        method: str,
        params: Dict[str, Any] | None = None,
    ) -> Dict[str, Any]:
        """Send a JSON-RPC 2.0 request and return the parsed response object."""
        payload: Dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": _next_id(),
            "method": method,
        }
        if params is not None:
            payload["params"] = params

        headers: Dict[str, str] = {}
        if self._session_id:
            headers["mcp-session-id"] = self._session_id

        url = f"{self._base_url}{self.MCP_ENDPOINT}"
        _LOGGER.debug("→ POST %s  method=%s id=%d", url, method, payload["id"])

        try:
            raw_resp = self._session.post(
                url,
                json=payload,
                headers=headers,
                timeout=self._timeout,
                verify=self._verify,
            )
        except requests.exceptions.ConnectionError as exc:
            raise KatraConnectionError(
                f"Cannot reach Katra server at {url}: {exc}"
            ) from exc
        except requests.exceptions.Timeout as exc:
            raise KatraTimeoutError(
                f"Request to {url} timed out after {self._timeout}s"
            ) from exc
        except requests.exceptions.RequestException as exc:
            raise KatraConnectionError(f"Request failed: {exc}") from exc

        # Capture the session-id if present.
        sid = raw_resp.headers.get("mcp-session-id")
        if sid and sid != self._session_id:
            self._session_id = sid
            _LOGGER.debug("Got session-id: %s", sid)

        # Auth check.
        if raw_resp.status_code in (401, 403):
            raise KatraAuthError(
                f"Authentication failed (HTTP {raw_resp.status_code}) — "
                f"check your api_key. Server response: {raw_resp.text[:300]}",
                status_code=raw_resp.status_code,
            )

        # Non-200 that isn't auth.
        if raw_resp.status_code >= 400:
            raise KatraError(
                f"Server returned HTTP {raw_resp.status_code}: {raw_resp.text[:300]}",
                status_code=raw_resp.status_code,
            )

        return self._parse_response(raw_resp.text, payload["id"])

    def _parse_response(self, body: str, request_id: int) -> Dict[str, Any]:
        """Parse an SSE or JSON body into a JSON-RPC response dict."""
        # Optimistic: try direct JSON first (non-streaming responses).
        try:
            data = json.loads(body)
            if isinstance(data, dict) and "jsonrpc" in data:
                return data
        except json.JSONDecodeError:
            pass

        # SSE mode: extract all `data:` lines and parse the last one
        # (the final result) or merge them.
        matches = _SSE_DATA_RE.findall(body)
        if matches:
            # Try the last line first (often the final result/error).
            last = matches[-1].strip()
            try:
                data = json.loads(last)
                if isinstance(data, dict) and "jsonrpc" in data:
                    return data
            except json.JSONDecodeError:
                pass

            # Merge all non-empty JSON objects.
            for line in matches:
                line = line.strip()
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                    if isinstance(chunk, dict) and "result" in chunk:
                        return chunk
                except json.JSONDecodeError:
                    continue

        # If nothing matched, return the raw body as a result for debugging.
        _LOGGER.warning("Could not parse MCP response body. Raw: %.300s", body)
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {"content": [{"type": "text", "text": body}]},
        }


# ── module-level helpers ────────────────────────────────────────────


def _extract_text(content: List[Dict[str, Any]]) -> str:
    """Extract the concatenated ``text`` fields from MCP content items."""
    parts: List[str] = []
    for item in content or []:
        if item.get("type") == "text" and "text" in item:
            parts.append(item["text"])
    return "\n".join(parts) if parts else ""
