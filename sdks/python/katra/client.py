"""
Katra Client — High-Level Pythonic Interface
============================================

The :class:`KatraClient` wraps the low-level MCP transport with
discoverable, type-annotated methods for every Katra memory tool.

Each method maps 1:1 to an MCP tool and handles:

* Automatic MCP initialize / session handshake (lazy, on first call)
* Type-safe parameter validation via Python kwargs
* Structured return values (dict or list)
* Sensible defaults
* Automatic fallback to REST API when MCP is unavailable (opt-in)

Basic Usage
-----------
>>> from katra import KatraClient
>>> client = KatraClient("http://localhost:3112", api_key="my-key")
>>>
>>> # Core memory
>>> client.store_memory("User loves Python", category="preference")
>>> results = client.search_memories("Python", limit=5)
>>>
>>> # Vector search
>>> similar = client.vector_search("machine learning")
>>>
>>> # Temporal
>>> history = client.temporal_recall("user-123")
>>> ctx = client.get_temporal_context("user-123", "sess-456")
>>>
>>> # Patterns & summaries
>>> patterns = client.detect_patterns("user-123")
>>> blocks = client.get_time_block_summaries("user-123")
>>>
>>> # Journal
>>> client.store_journal("user-123", "Great session on RL today")
>>> entries = client.get_journal("user-123")
>>>
>>> # Missions
>>> mission = client.create_mission("user-123", "Build a trading bot")
>>> client.update_mission_task("user-123", mission["id"], "task-1", "completed")
>>>
>>> # Diagnostics
>>> health = client.get_health()
>>> diag = client.get_memory_diagnostics()
>>>
>>> # Working memory
>>> client.working_memory("sess-456", "store", content="temp context")
>>> wm = client.working_memory("sess-456", "get")
>>>
>>> # Knowledge graph
>>> graph = client.explore_graph(query="Python", include_edges=True)
>>>
>>> # Assets & audit
>>> assets = client.list_assets()
>>> log = client.get_transaction_log(since="2026-01-01")
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from katra.exceptions import KatraError
from katra.mcp_client import KatraMCPClient, _extract_text


class KatraClient:
    """High-level typed client for the Katra cognitive memory server.

    Parameters
    ----------
    url : str
        Base URL of the Katra server (e.g. ``http://localhost:3100``).

    api_key : str | None
        API key matching ``MCP_API_KEY`` / ``ADMIN_API_KEY`` on the server.
        Optional if the server runs without authentication.

    timeout : float
        HTTP request timeout in seconds (default 30).

    auto_init : bool
        If ``True`` (default) the client lazily performs the MCP initialize
        handshake on the first tool call.  Set to ``False`` to call
        :meth:`initialize` manually.

    verify : bool | str
        TLS certificate verification (default ``True``).
    """

    def __init__(
        self,
        url: str,
        api_key: str | None = None,
        timeout: float = 30.0,
        auto_init: bool = True,
        verify: bool | str = True,
    ) -> None:
        self._auto_init = auto_init
        self._mcp = KatraMCPClient(
            url=url,
            api_key=api_key,
            timeout=timeout,
            verify=verify,
        )
        self._initialized: bool = False
        # REST base URL for fallback endpoints.
        self._rest_base: str = url.rstrip("/")

    # ── Lifecycle ───────────────────────────────────────────────

    def initialize(self) -> Dict[str, Any]:
        """Perform the MCP initialize handshake.

        Called automatically before the first tool call if *auto_init*
        is ``True`` (the default).  You can call it explicitly to
        pre-warm the connection.

        Returns
        -------
        dict
            Server capabilities + metadata.
        """
        caps = self._mcp.initialize()
        self._initialized = True
        return caps

    def list_tools(self) -> List[Dict[str, Any]]:
        """Return the list of available MCP tools on the server.

        Returns
        -------
        list[dict]
            Each item has ``name``, ``description``, and ``inputSchema``.
        """
        self._ensure_init()
        return self._mcp.list_tools()

    # ── Core Memory ─────────────────────────────────────────────

    def store_memory(
        self,
        content: str,
        user_id: str | None = None,
        shared_id: str | None = None,
        category: str = "general",
        confidence: float = 0.8,
    ) -> Dict[str, Any]:
        """Store a new memory in the long-term semantic memory.

        Parameters
        ----------
        content : str
            The memory content to store.
        user_id : str | None
            Optional user identifier (defaults to server-side ``mcp-user``).
        shared_id : str | None
            Optional shared ID for communal memory (used in shared/hybrid mode).
            The server ignores this if scope is ``personal``.
        category : str
            One of ``fact``, ``preference``, ``insight``, ``event``, ``general``.
        confidence : float
            Confidence in the memory (0.0 – 1.0).

        Returns
        -------
        dict
            Parsed result with stored memory details.

        Example
        -------
        >>> client.store_memory("User is a Python developer", category="fact")
        """
        self._ensure_init()
        args: Dict[str, Any] = {
            "content": content,
            "category": category,
            "confidence": confidence,
        }
        if user_id:
            args["user_id"] = user_id
        if shared_id:
            args["shared_id"] = shared_id
        result = self._mcp.call_tool("store_memory", args)
        return _normalize_tool_result(result)

    def search_memories(
        self,
        query: str,
        user_id: str | None = None,
        limit: int = 10,
    ) -> Dict[str, Any]:
        """Search episodic and semantic memories by keyword.

        Parameters
        ----------
        query : str
            Search keywords.
        user_id : str | None
            Optional user filter.
        limit : int
            Max results (1–50, default 10).

        Returns
        -------
        dict
            Parsed result with episodic and semantic matches.

        Example
        -------
        >>> results = client.search_memories("Docker strategy")
        """
        self._ensure_init()
        args: Dict[str, Any] = {"query": query, "limit": limit}
        if user_id:
            args["user_id"] = user_id
        return _normalize_tool_result(self._mcp.call_tool("search_memories", args))

    def vector_search(
        self,
        query: str,
        user_id: str | None = None,
        limit: int = 10,
    ) -> Dict[str, Any]:
        """Search memories by semantic vector similarity.

        Finds conceptually related memories even when keywords don't match
        (e.g. "containerization" matches "Docker strategy").

        Falls back to keyword search if the embedding model is unavailable.

        Parameters
        ----------
        query : str
            Natural-language search query.
        user_id : str | None
            Optional user filter.
        limit : int
            Max results (1–20, default 10).

        Returns
        -------
        dict
            Parsed result with ranked matches.
        """
        self._ensure_init()
        args: Dict[str, Any] = {"query": query, "limit": limit}
        if user_id:
            args["user_id"] = user_id
        return _normalize_tool_result(self._mcp.call_tool("vector_search", args))

    def get_conversation_history(
        self,
        session_id: str,
        limit: int = 20,
    ) -> Dict[str, Any]:
        """Retrieve raw conversation history for a session.

        Parameters
        ----------
        session_id : str
            Session identifier.
        limit : int
            Max events to return (default 20).

        Returns
        -------
        dict
            Parsed result with chronologically ordered events.
        """
        self._ensure_init()
        return _normalize_tool_result(
            self._mcp.call_tool(
                "get_conversation_history",
                {"session_id": session_id, "limit": limit},
            )
        )

    # ── Temporal Memory ─────────────────────────────────────────

    def temporal_recall(
        self,
        user_id: str,
        from_date: str | None = None,
        to_date: str | None = None,
        limit: int = 50,
        event_type: str | None = None,
        role: str | None = None,
    ) -> Dict[str, Any]:
        """Query episodic events within a date/time range.

        Parameters
        ----------
        user_id : str
            User identifier.
        from_date : str | None
            ISO 8601 start datetime (defaults to 24h ago).
        to_date : str | None
            ISO 8601 end datetime (defaults to now).
        limit : int
            Max events (1–200, default 50).
        event_type : str | None
            Filter by event type.
        role : str | None
            Filter by role (``user`` or ``assistant``).

        Returns
        -------
        dict
            Parsed result with events sorted by timestamp descending.

        Example
        -------
        >>> events = client.temporal_recall("user-123", from_date="2026-05-01")
        """
        self._ensure_init()
        args: Dict[str, Any] = {"user_id": user_id, "limit": limit}
        if from_date:
            args["from"] = from_date
        if to_date:
            args["to"] = to_date
        if event_type:
            args["event_type"] = event_type
        if role:
            args["role"] = role
        return _normalize_tool_result(self._mcp.call_tool("temporal_recall", args))

    def temporal_search(
        self,
        user_id: str,
        query: str,
        limit: int = 20,
    ) -> Dict[str, Any]:
        """Search episodic events by keyword with time context.

        Parameters
        ----------
        user_id : str
            User identifier.
        query : str
            Search keywords.
        limit : int
            Max results (1–50, default 20).

        Returns
        -------
        dict
            Parsed result with matching events and timestamps.
        """
        self._ensure_init()
        return _normalize_tool_result(
            self._mcp.call_tool(
                "temporal_search",
                {"user_id": user_id, "query": query, "limit": limit},
            )
        )

    def get_time_block_summaries(
        self,
        user_id: str,
        from_date: str | None = None,
        to_date: str | None = None,
        block_type: str | None = None,
        limit: int = 20,
    ) -> Dict[str, Any]:
        """Query LLM-generated time-block summaries.

        Parameters
        ----------
        user_id : str
            User identifier.
        from_date : str | None
            ISO 8601 start (defaults to 30 days ago).
        to_date : str | None
            ISO 8601 end (defaults to now).
        block_type : str | None
            Granularity: ``day``, ``week``, or ``month``.
        limit : int
            Max summaries (1–50, default 20).

        Returns
        -------
        dict
            Parsed result with pre-computed AI summaries.
        """
        self._ensure_init()
        args: Dict[str, Any] = {"user_id": user_id, "limit": limit}
        if from_date:
            args["from"] = from_date
        if to_date:
            args["to"] = to_date
        if block_type:
            args["block_type"] = block_type
        return _normalize_tool_result(
            self._mcp.call_tool("get_time_block_summaries", args)
        )

    def summarize_time_blocks(
        self,
        user_id: str,
        block_type: str = "week",
        lookback_days: int = 90,
        max_blocks: int = 20,
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        """Trigger LLM summarization of conversation activity across time blocks.

        Parameters
        ----------
        user_id : str
            User identifier.
        block_type : str
            Granularity: ``day``, ``week``, or ``month`` (default ``week``).
        lookback_days : int
            Days to look back (1–365, default 90).
        max_blocks : int
            Max number of blocks to summarize (1–52, default 20).
        dry_run : bool
            If ``True``, preview without storing summaries.

        Returns
        -------
        dict
            Parsed result with blocks processed and summaries generated.
        """
        self._ensure_init()
        return _normalize_tool_result(
            self._mcp.call_tool(
                "summarize_time_blocks",
                {
                    "user_id": user_id,
                    "block_type": block_type,
                    "lookback_days": lookback_days,
                    "max_blocks": max_blocks,
                    "dry_run": dry_run,
                },
            )
        )

    def detect_patterns(
        self,
        user_id: str,
        lookback_weeks: int = 12,
        min_confidence: float = 0.5,
        dormant_threshold_days: int = 14,
    ) -> Dict[str, Any]:
        """Detect temporal patterns in user activity.

        Analyses: recurring topics, session rhythm, topic regressions,
        and dormant topics.

        Parameters
        ----------
        user_id : str
            User identifier.
        lookback_weeks : int
            Weeks to analyse (1–52, default 12).
        min_confidence : float
            Minimum confidence threshold (0–1, default 0.5).
        dormant_threshold_days : int
            Days of inactivity before a topic is "dormant" (1–365, default 14).

        Returns
        -------
        dict
            Parsed result with pattern categories and summary.

        Example
        -------
        >>> patterns = client.detect_patterns("user-123", lookback_weeks=4)
        """
        self._ensure_init()
        return _normalize_tool_result(
            self._mcp.call_tool(
                "detect_patterns",
                {
                    "user_id": user_id,
                    "lookback_weeks": lookback_weeks,
                    "min_confidence": min_confidence,
                    "dormant_threshold_days": dormant_threshold_days,
                },
            )
        )

    def get_temporal_context(
        self,
        user_id: str,
        session_id: str,
    ) -> Dict[str, Any]:
        """Get current temporal context for a session.

        Includes recent events, working memory state, and semantic facts.

        Parameters
        ----------
        user_id : str
            User identifier.
        session_id : str
            Session identifier.

        Returns
        -------
        dict
            Parsed result with recent events, working memory, and semantic facts.
        """
        self._ensure_init()
        return _normalize_tool_result(
            self._mcp.call_tool(
                "get_temporal_context",
                {"user_id": user_id, "session_id": session_id},
            )
        )

    # ── Journal ─────────────────────────────────────────────────

    def get_journal(
        self,
        user_id: str,
        source: str = "all",
        limit: int = 20,
    ) -> Dict[str, Any]:
        """Read journal entries for a user.

        Parameters
        ----------
        user_id : str
            User identifier.
        source : str
            ``auto`` (AI-generated), ``manual``, or ``all`` (default).
        limit : int
            Max entries (1–50, default 20).

        Returns
        -------
        dict
            Parsed result with journal entries.
        """
        self._ensure_init()
        return _normalize_tool_result(
            self._mcp.call_tool(
                "get_journal",
                {"user_id": user_id, "source": source, "limit": limit},
            )
        )

    def store_journal(
        self,
        user_id: str,
        entry: str,
        source: str = "manual",
        tags: List[str] | None = None,
        shared_id: str | None = None,
    ) -> Dict[str, Any]:
        """Write a journal entry to the user's memory.

        Parameters
        ----------
        user_id : str
            User identifier.
        entry : str
            Journal entry text.
        source : str
            ``manual`` (default) or ``system``.
        tags : list[str] | None
            Optional tags for categorisation.
        shared_id : str | None
            Optional shared ID for communal memory (used in shared/hybrid mode).

        Returns
        -------
        dict
            Parsed result with stored entry ID.

        Example
        -------
        >>> client.store_journal("user-123", "Finished refactoring the API layer",
        ...                      tags=["coding", "milestone"])
        """
        self._ensure_init()
        args: Dict[str, Any] = {
            "user_id": user_id,
            "entry": entry,
            "source": source,
        }
        if tags:
            args["tags"] = tags
        if shared_id:
            args["shared_id"] = shared_id
        return _normalize_tool_result(self._mcp.call_tool("store_journal", args))

    def get_auto_journal(
        self,
        user_id: str,
        since: str | None = None,
        limit: int = 20,
    ) -> Dict[str, Any]:
        """Query auto-generated journal entries distilled by the AI.

        These are different from manual journal entries — they contain
        AI-distilled insights, patterns, and observations.

        Parameters
        ----------
        user_id : str
            User identifier.
        since : str | None
            ISO 8601 date to filter entries after.
        limit : int
            Max entries (1–50, default 20).

        Returns
        -------
        dict
            Parsed result with auto-generated entries.
        """
        self._ensure_init()
        args: Dict[str, Any] = {"user_id": user_id, "limit": limit}
        if since:
            args["since"] = since
        return _normalize_tool_result(self._mcp.call_tool("get_auto_journal", args))

    # ── Missions / Goals ────────────────────────────────────────

    def list_missions(
        self,
        user_id: str,
        limit: int = 10,
    ) -> Dict[str, Any]:
        """List all missions (goals) for a user.

        Parameters
        ----------
        user_id : str
            User identifier.
        limit : int
            Max missions (1–50, default 10).

        Returns
        -------
        dict
            Parsed result with mission summaries (status, progress, task counts).
        """
        self._ensure_init()
        return _normalize_tool_result(
            self._mcp.call_tool(
                "list_missions", {"user_id": user_id, "limit": limit}
            )
        )

    def get_mission(
        self,
        user_id: str,
        mission_id: str,
    ) -> Dict[str, Any]:
        """Get full mission details including task tree and journal.

        Parameters
        ----------
        user_id : str
            User identifier.
        mission_id : str
            Mission identifier.

        Returns
        -------
        dict
            Parsed result with task tree, self-journal, and metadata.
        """
        self._ensure_init()
        return _normalize_tool_result(
            self._mcp.call_tool(
                "get_mission",
                {"user_id": user_id, "mission_id": mission_id},
            )
        )

    def create_mission(
        self,
        user_id: str,
        goal: str,
        title: str | None = None,
        tasks: List[str] | None = None,
    ) -> Dict[str, Any]:
        """Create a new mission (goal) with optional task breakdown.

        Parameters
        ----------
        user_id : str
            User identifier.
        goal : str
            Mission goal / description.
        title : str | None
            Optional short title (defaults to goal text).
        tasks : list[str] | None
            Optional list of task titles.

        Returns
        -------
        dict
            Parsed result with the new mission ID.

        Example
        -------
        >>> m = client.create_mission("user-123", "Ship the API v2",
        ...                           tasks=["Write docs", "Add tests", "Deploy"])
        """
        self._ensure_init()
        args: Dict[str, Any] = {"user_id": user_id, "goal": goal}
        if title:
            args["title"] = title
        if tasks:
            args["tasks"] = tasks
        return _normalize_tool_result(self._mcp.call_tool("create_mission", args))

    def update_mission_task(
        self,
        user_id: str,
        mission_id: str,
        task_id: str,
        status: str,
    ) -> Dict[str, Any]:
        """Update the status of a task within a mission.

        Parameters
        ----------
        user_id : str
            User identifier.
        mission_id : str
            Mission identifier.
        task_id : str
            Task identifier.
        status : str
            One of ``pending``, ``in_progress``, ``completed``, or ``blocked``.

        Returns
        -------
        dict
            Parsed result with updated task status.
        """
        self._ensure_init()
        return _normalize_tool_result(
            self._mcp.call_tool(
                "update_mission_task",
                {
                    "user_id": user_id,
                    "mission_id": mission_id,
                    "task_id": task_id,
                    "status": status,
                },
            )
        )

    # ── Working Memory ──────────────────────────────────────────

    def working_memory(
        self,
        session_id: str,
        action: str,
        content: str | None = None,
        limit: int = 10,
    ) -> Dict[str, Any]:
        """Read, store, or delete short-term working memory for a session.

        Parameters
        ----------
        session_id : str
            Session identifier.
        action : str
            ``get`` (retrieve), ``store`` (add item), or ``delete`` (clear session).
        content : str | None
            Content to store (required for ``store`` action).
        limit : int
            Max items to return for ``get`` action (1–50, default 10).

        Returns
        -------
        dict
            Parsed result.

        Example
        -------
        >>> client.working_memory("sess-456", "store", content="user is debugging")
        >>> wm = client.working_memory("sess-456", "get")
        >>> client.working_memory("sess-456", "delete")
        """
        self._ensure_init()
        args: Dict[str, Any] = {
            "session_id": session_id,
            "action": action,
            "limit": limit,
        }
        if content:
            args["content"] = content
        return _normalize_tool_result(self._mcp.call_tool("working_memory", args))

    # ── Knowledge Graph ─────────────────────────────────────────

    def explore_graph(
        self,
        query: str | None = None,
        limit: int = 20,
        include_edges: bool = True,
    ) -> Dict[str, Any]:
        """Explore the knowledge graph: entities and relationships.

        Parameters
        ----------
        query : str | None
            Optional keyword filter for nodes.
        limit : int
            Max nodes to return (1–100, default 20).
        include_edges : bool
            Include relationships between nodes (default ``True``).

        Returns
        -------
        dict
            Parsed result with nodes and edges.

        Example
        -------
        >>> graph = client.explore_graph(query="Docker", include_edges=True)
        """
        self._ensure_init()
        args: Dict[str, Any] = {"limit": limit, "include_edges": include_edges}
        if query:
            args["query"] = query
        return _normalize_tool_result(self._mcp.call_tool("explore_graph", args))

    # ── Memory Scope ────────────────────────────────────────────

    def get_memory_scope(self) -> Dict[str, Any]:
        """Get the current memory scope configuration.

        Returns the mode (personal/shared/hybrid), shared_id, and visible
        user IDs for hybrid mode.

        Returns
        -------
        dict
            Parsed result with scope settings.
        """
        self._ensure_init()
        return _normalize_tool_result(self._mcp.call_tool("get_memory_scope", {}))

    def set_memory_scope(
        self,
        mode: str,
        shared_id: str | None = None,
        hybrid_visible_user_ids: List[str] | None = None,
    ) -> Dict[str, Any]:
        """Set the memory scope mode.

        Parameters
        ----------
        mode : str
            ``personal``, ``shared``, or ``hybrid``.
        shared_id : str | None
            Shared ID (required for shared/hybrid modes).
        hybrid_visible_user_ids : list[str] | None
            User IDs visible in hybrid mode (in addition to caller).

        Returns
        -------
        dict
            Parsed result confirming the new scope.
        """
        self._ensure_init()
        args: Dict[str, Any] = {"mode": mode}
        if shared_id:
            args["shared_id"] = shared_id
        if hybrid_visible_user_ids:
            args["hybrid_visible_user_ids"] = hybrid_visible_user_ids
        return _normalize_tool_result(self._mcp.call_tool("set_memory_scope", args))

    # ── Diagnostics & Health ────────────────────────────────────

    def get_memory_diagnostics(
        self,
        user_id: str | None = None,
    ) -> Dict[str, Any]:
        """Get comprehensive memory system diagnostics.

        Includes document counts by collection, processing backlog,
        embedding coverage, index status, and overall health.

        Parameters
        ----------
        user_id : str | None
            Optional user filter for per-user counts.

        Returns
        -------
        dict
            Parsed diagnostic data.
        """
        self._ensure_init()
        args: Dict[str, Any] = {}
        if user_id:
            args["user_id"] = user_id
        return _normalize_tool_result(
            self._mcp.call_tool("get_memory_diagnostics", args)
        )

    def get_background_status(self) -> Dict[str, Any]:
        """Check background processor status.

        Includes queue depth, last run time, processing interval, and errors.

        Returns
        -------
        dict
            Parsed status data.
        """
        self._ensure_init()
        return _normalize_tool_result(
            self._mcp.call_tool("get_background_status", {})
        )

    def get_health(self) -> Dict[str, Any]:
        """Check the health of all backend services.

        Monitors: MongoDB, Redis, LLM, and embedding model status.

        Returns
        -------
        dict
            Parsed health check data.
        """
        self._ensure_init()
        return _normalize_tool_result(self._mcp.call_tool("get_health", {}))

    def get_heartbeat_status(self) -> Dict[str, Any]:
        """Check heartbeat scheduler status.

        Includes running state, last/next run times, interval, and recent history.

        Returns
        -------
        dict
            Parsed heartbeat status data.
        """
        self._ensure_init()
        return _normalize_tool_result(
            self._mcp.call_tool("get_heartbeat_status", {})
        )

    # ── Assets ──────────────────────────────────────────────────

    def list_assets(
        self,
        user_id: str | None = None,
        content_type: str | None = None,
        limit: int = 20,
    ) -> Dict[str, Any]:
        """List uploaded assets stored in the server.

        Parameters
        ----------
        user_id : str | None
            Optional user filter.
        content_type : str | None
            Filter by MIME type prefix (e.g. ``image/``).
        limit : int
            Max assets (1–100, default 20).

        Returns
        -------
        dict
            Parsed result with asset metadata.
        """
        self._ensure_init()
        args: Dict[str, Any] = {"limit": limit}
        if user_id:
            args["user_id"] = user_id
        if content_type:
            args["content_type"] = content_type
        return _normalize_tool_result(self._mcp.call_tool("list_assets", args))

    # ── Transaction Log ─────────────────────────────────────────

    def get_transaction_log(
        self,
        user_id: str | None = None,
        action: str | None = None,
        since: str | None = None,
        limit: int = 50,
    ) -> Dict[str, Any]:
        """Query the audit trail of agent actions.

        Includes heartbeat runs, autonomous ticks, tool executions, and
        system events.

        Parameters
        ----------
        user_id : str | None
            Optional user filter.
        action : str | None
            Filter by action type (e.g. ``heartbeat_run``, ``autonomous_tick``).
        since : str | None
            ISO 8601 date to filter entries after.
        limit : int
            Max entries (1–100, default 50).

        Returns
        -------
        dict
            Parsed result with transaction log entries.
        """
        self._ensure_init()
        args: Dict[str, Any] = {"limit": limit}
        if user_id:
            args["user_id"] = user_id
        if action:
            args["action"] = action
        if since:
            args["since"] = since
        return _normalize_tool_result(
            self._mcp.call_tool("get_transaction_log", args)
        )

    # ── Private helpers ─────────────────────────────────────────

    def _ensure_init(self) -> None:
        """Lazily initialize if auto_init is enabled."""
        if self._auto_init and not self._initialized:
            self.initialize()


# ── module-level helpers ────────────────────────────────────────────


def _normalize_tool_result(result: Dict[str, Any]) -> Dict[str, Any]:
    """Normalise an MCP tool-call result into a Python dict.

    MCP responses wrap tool output in ``result.content`` (list of text
    items).  This helper extracts the text, attempts JSON parsing,
    and falls back to the raw text in ``_raw_text``.

    If the result is already a plain dict (REST-style), passes it through.
    """
    # Already a plain dict (no content wrapper)
    content = result.get("content")
    if content is None:
        return result

    text = _extract_text(content)
    if not text:
        return result

    # Try to parse as JSON if possible.
    try:
        import json as _json

        parsed = _json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except (ValueError, TypeError):
        pass

    # Return the text as the payload.
    return {"_raw_text": text, "_content": result}
