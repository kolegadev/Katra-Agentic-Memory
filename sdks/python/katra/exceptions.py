"""
Katra SDK Exceptions
====================

Hierarchy of exceptions raised by the Katra Python SDK.
All exceptions inherit from :class:`KatraError`.
"""

from __future__ import annotations


class KatraError(Exception):
    """Base exception for all Katra SDK errors."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class KatraConnectionError(KatraError):
    """Raised when the SDK cannot connect to the Katra server.

    Common causes: wrong URL, server not running, network issues, DNS failure.
    """


class KatraAuthError(KatraError):
    """Raised on authentication / authorization failures (HTTP 401 / 403).

    Common causes: missing *api_key*, wrong key, or server auth disabled.
    """


class KatraTimeoutError(KatraError):
    """Raised when a request to the Katra server times out."""


class KatraProtocolError(KatraError):
    """Raised when the MCP JSON-RPC protocol is violated by the server."""


class KatraToolError(KatraError):
    """Raised when a tool call returns an error from the server.

    The *tool_name* and *server_message* attributes carry diagnostic detail.
    """

    def __init__(
        self,
        tool_name: str,
        message: str,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message, status_code=status_code)
        self.tool_name = tool_name
