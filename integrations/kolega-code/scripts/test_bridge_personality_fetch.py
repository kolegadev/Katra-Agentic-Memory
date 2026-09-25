#!/usr/bin/env python3
"""Regression test — the bridge fetches its OWN identity's personality.

Run:  python3 integrations/kolega-code/scripts/test_bridge_personality_fetch.py
      (from the repository root; stdlib only — no httpx, no pytest, no network)

ITER-3 made the personality fetch authenticated and per-identity: the bridge
talks to the caller-pinned `GET /api/v1/admin/personality`, which serves the
resolved caller's record, so the bridge must name itself and present its key.
This script drives the real bridge code with a request-capturing fake client
(`_fetch_server_personality`'s injectable seam) and proves:

  1. the request is `GET {rest_base}/admin/personality?user_id=<identity>` with
     `Authorization: Bearer <key>` when a key is configured, and NO
     Authorization header at all when it is not (never a bare "Bearer ");
  2. the cache entry is per identity — two identities hold two independent
     entries, a second call inside the TTL does not refetch, and an entry that
     has aged past the TTL does (the TTL itself is unchanged at 60 s);
  3. a 401/403 is reported in operational language once per TTL window per
     identity, and the fetch still fails open (returns None, raises nothing)
     so the caller keeps its locally-configured personality;
  4. a success merges the server's values and surfaces the server-reported
     `version`/`origin` on the returned config, logged at debug when debug is
     on — and only the server's own vocabulary is surfaced;
  5. garbage (non-dict config, non-success envelope, unparseable body, 4xx/5xx,
     a transport that raises, an unparseable mcp_url) is rejected safely:
     None, no exception, nothing cached, no warning;
  6. the default transport is still `httpx.Client(timeout=3.0)` (proved with a
     stub `httpx` module, because httpx is optional and may not be installed);
  7. the two new BridgeConfig fields default to None and were APPENDED, so
     positional construction keeps its meaning.
"""

from __future__ import annotations

import logging
import os
import sys
import types
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
BRIDGE_PARENT = HERE.parent  # .../integrations/kolega-code
sys.path.insert(0, str(BRIDGE_PARENT))  # this checkout's bridge wins

from kolega_katra_bridge import config as bridge_config  # noqa: E402

IDENTITY_A = "agent-a"
IDENTITY_B = "agent-b"
MCP_URL = "http://memory.invalid:3112/mcp"
REST_BASE = bridge_config._rest_base_from_mcp(MCP_URL) or ""
KEY_A = "bridge-key-a"
KEY_B = "bridge-key-b"

PERSONALITY_PATH = "/api/v1/admin/personality"

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  PASS  {label}")
    else:
        failures.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


# ── fakes: the whole point of the seam is that these need no HTTP library ──


class FakeResponse:
    """A captured HTTP response: a status plus a JSON body."""

    def __init__(self, status_code: int = 200, payload: Any = None, unparseable: bool = False) -> None:
        self.status_code = status_code
        self._payload = payload
        self._unparseable = unparseable

    def json(self) -> Any:
        if self._unparseable:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self._payload


class FakeClient:
    """Records every request; serves queued responses (the last one repeats)."""

    def __init__(self, *responses: Any) -> None:
        self._responses = list(responses) or [FakeResponse(200, {"success": True, "config": {}})]
        self.requests: list[dict[str, Any]] = []

    @property
    def calls(self) -> int:
        return len(self.requests)

    def get(self, url: str, headers: Any = None, **kwargs: Any) -> FakeResponse:
        self.requests.append({"url": url, "headers": dict(headers or {}), "kwargs": kwargs})
        if len(self._responses) == 1:
            return self._responses[0]
        return self._responses.pop(0)


class ExplodingClient:
    """A transport that fails the way a dead socket does."""

    def get(self, *args: Any, **kwargs: Any) -> Any:
        raise OSError("connect: connection refused")


class StubHttpx:
    """A fake `httpx` module, so the default-transport branch is exercised
    even where httpx is not installed (it stays an optional dependency)."""

    def __init__(self, responder: Any) -> None:
        self.clients: list[Any] = []
        self._responder = responder
        holder = self

        class Client:
            def __init__(self, timeout: float | None = None, **kwargs: Any) -> None:
                self.timeout = timeout
                self.requests: list[dict[str, Any]] = []
                holder.clients.append(self)

            def __enter__(self) -> "Client":
                return self

            def __exit__(self, *exc: Any) -> bool:
                return False

            def get(self, url: str, headers: Any = None, **kwargs: Any) -> Any:
                self.requests.append({"url": url, "headers": dict(headers or {})})
                return holder._responder(url, headers)

        self.module = types.ModuleType("httpx")
        self.module.Client = Client
        self._previous: Any = None

    def __enter__(self) -> "StubHttpx":
        self._previous = sys.modules.get("httpx")
        sys.modules["httpx"] = self.module
        return self

    def __exit__(self, *exc: Any) -> bool:
        if self._previous is None:
            sys.modules.pop("httpx", None)
        else:
            sys.modules["httpx"] = self._previous
        return False


class CaptureLogs(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def warnings(self) -> list[str]:
        return [r.getMessage() for r in self.records if r.levelno >= logging.WARNING]

    def debugs(self) -> list[str]:
        return [r.getMessage() for r in self.records if r.levelno == logging.DEBUG]


def capture_logs() -> CaptureLogs:
    handler = CaptureLogs()
    logging.getLogger(bridge_config.__name__).addHandler(handler)
    return handler


def release_logs(handler: CaptureLogs) -> None:
    logging.getLogger(bridge_config.__name__).removeHandler(handler)


# ── helpers ───────────────────────────────────────────────────────────────


def reset_state() -> None:
    """Start a case from a cold cache (the state is module-global by design)."""
    bridge_config._SERVER_PERSONALITY_CACHE.clear()
    bridge_config._SERVER_PERSONALITY_WARNED_AT.clear()


def cache_key(identity: str) -> str:
    return f"{REST_BASE}|{identity}"


def age(identity: str, seconds: float) -> bool:
    """Move a cached entry `seconds` into the past; False when it is absent."""
    entry = bridge_config._SERVER_PERSONALITY_CACHE.get(cache_key(identity))
    if entry is None:
        return False
    bridge_config._SERVER_PERSONALITY_CACHE[cache_key(identity)] = (entry[0], entry[1] - seconds)
    return True


def query_of(url: str) -> dict[str, list[str]]:
    return parse_qs(urlsplit(url).query)


def body(config: dict, **envelope: Any) -> dict:
    return {"success": True, "config": config, **envelope}


def config_for(identity: str = IDENTITY_A, key: str = KEY_A, **kwargs: Any) -> Any:
    return bridge_config.BridgeConfig(mcp_url=MCP_URL, api_key=key, user_id=identity, **kwargs)


def fetch(cfg: Any, client: Any = None) -> Any:
    """Call the fetch and report (only) an escaped exception as a failure."""
    try:
        return bridge_config._fetch_server_personality(cfg, client=client)
    except Exception as exc:  # noqa: BLE001 - the seam must never raise
        failures.append("_fetch_server_personality raised")
        print(f"  FAIL  _fetch_server_personality raised {exc!r}")
        return "RAISED"


# ── cases ─────────────────────────────────────────────────────────────────


def case_request_is_authenticated_and_named() -> None:
    print("\n1. the request names this bridge's identity and carries its key")
    reset_state()
    payload_body = body(
        {"personality": "scholar", "source_weights": {"vector_search": 7}, "scoring": {}, "max_context_tokens": 8000},
        origin="identity",
        version=4,
    )
    client = FakeClient(FakeResponse(200, payload_body))
    cfg = config_for()

    payload = bridge_config._fetch_server_personality(cfg, client)  # positional: the documented seam

    check("exactly one request was issued", client.calls == 1, str(client.calls))
    if not client.requests:
        return
    request = client.requests[0]
    split = urlsplit(request["url"])
    check("the path is /api/v1/admin/personality", split.path == PERSONALITY_PATH, request["url"])
    check("the request hits the configured REST base", request["url"].startswith(f"{REST_BASE}/admin/personality"), request["url"])
    check("user_id is the only query parameter", list(query_of(request["url"])) == ["user_id"], request["url"])
    check("user_id names this identity", query_of(request["url"]).get("user_id") == [IDENTITY_A], request["url"])
    check(
        "Authorization carries the key as a Bearer token",
        request["headers"].get("Authorization") == f"Bearer {KEY_A}",
        str(request["headers"]),
    )
    check("no header beyond Authorization is sent", set(request["headers"]) == {"Authorization"}, str(request["headers"]))
    check("the server's config came back", isinstance(payload, dict) and payload.get("personality") == "scholar", repr(payload))


def case_empty_key_sends_no_header() -> None:
    print("\n2. an empty key sends no Authorization header at all")
    reset_state()
    client = FakeClient(FakeResponse(200, body({"personality": "balanced"})))
    cfg = config_for(key="")

    fetch(cfg, client)

    check("a request was still made", client.calls == 1, str(client.calls))
    headers = client.requests[0]["headers"] if client.requests else {}
    check("no Authorization header is present", "Authorization" not in headers, str(headers))
    check("no empty 'Bearer ' placeholder is sent", "Bearer" not in str(headers), str(headers))
    check("the identity is still named", query_of(client.requests[0]["url"]).get("user_id") == [IDENTITY_A])


def case_cache_is_per_identity() -> None:
    print("\n3. the cache is per identity, and holds for the TTL")
    reset_state()
    client = FakeClient(
        FakeResponse(200, body({"personality": "scholar", "source_weights": {"vector_search": 7}}, origin="identity", version=4)),
        FakeResponse(200, body({"personality": "sentinel", "source_weights": {"missions": 8}}, origin="identity", version=1)),
    )
    cfg_a = config_for(IDENTITY_A, KEY_A)
    cfg_b = config_for(IDENTITY_B, KEY_B)

    a_first = fetch(cfg_a, client)
    b_first = fetch(cfg_b, client)
    a_second = fetch(cfg_a, client)
    b_second = fetch(cfg_b, client)

    check("the first call per identity fetched (2 requests)", client.calls == 2, str(client.calls))
    check("A got A's record", isinstance(a_first, dict) and a_first.get("personality") == "scholar", repr(a_first))
    check("B got B's record", isinstance(b_first, dict) and b_first.get("personality") == "sentinel", repr(b_first))
    check("the two identities' payloads are independent", a_first != b_first)
    check("no refetch inside the TTL", client.calls == 2, str(client.calls))
    check("A's repeat call returned A's entry", a_second == a_first)
    check("B's repeat call returned B's entry", b_second == b_first)
    if client.calls == 2:
        check("A's request named agent-a", query_of(client.requests[0]["url"]).get("user_id") == [IDENTITY_A], client.requests[0]["url"])
        check("B's request named agent-b", query_of(client.requests[1]["url"]).get("user_id") == [IDENTITY_B], client.requests[1]["url"])
        check("B's request carried B's key", client.requests[1]["headers"].get("Authorization") == f"Bearer {KEY_B}", str(client.requests[1]["headers"]))
    check(
        "one cache entry per identity (not one per REST base)",
        set(bridge_config._SERVER_PERSONALITY_CACHE) == {cache_key(IDENTITY_A), cache_key(IDENTITY_B)},
        str(sorted(bridge_config._SERVER_PERSONALITY_CACHE)),
    )
    check("the cache keys embed the identity", all(k.endswith(f"|{i}") for k, i in ((cache_key(IDENTITY_A), IDENTITY_A), (cache_key(IDENTITY_B), IDENTITY_B))))


def case_ttl_expiry_refetches() -> None:
    print("\n4. an entry past the TTL is refetched (TTL unchanged)")
    reset_state()
    client = FakeClient(
        FakeResponse(200, body({"personality": "scholar"}, origin="identity", version=1)),
        FakeResponse(200, body({"personality": "dreamer"}, origin="identity", version=2)),
    )
    cfg = config_for()

    first = fetch(cfg, client)
    fetch(cfg, client)
    check("the entry is reused inside the TTL", client.calls == 1 and first is not None, str(client.calls))
    check(
        "the TTL is unchanged at 60 s",
        bridge_config._SERVER_PERSONALITY_TTL_SECONDS == 60.0,
        str(bridge_config._SERVER_PERSONALITY_TTL_SECONDS),
    )
    check("the entry was cached", age(IDENTITY_A, bridge_config._SERVER_PERSONALITY_TTL_SECONDS + 1))

    refreshed = fetch(cfg, client)
    check("the fetch happened again after the TTL", client.calls == 2, str(client.calls))
    check(
        "the refreshed value is the server's new one",
        isinstance(refreshed, dict) and refreshed.get("personality") == "dreamer" and refreshed.get("version") == 2,
        repr(refreshed),
    )
    check("the cache now holds the refreshed entry", bridge_config._SERVER_PERSONALITY_CACHE[cache_key(IDENTITY_A)][0] == refreshed)


def case_rejected_key_warns_once_and_fails_open() -> None:
    print("\n5. a rejected key is reported once per window and fails open")
    reset_state()
    client = FakeClient(FakeResponse(401, {"success": False, "error": "Unauthorized"}))
    cfg = config_for(key="stale-key", personality="pragmatist")

    logger = logging.getLogger(bridge_config.__name__)
    logs = capture_logs()
    try:
        first = bridge_config._fetch_server_personality(cfg, client=client)
        second = bridge_config._fetch_server_personality(cfg, client=client)
        third = bridge_config._fetch_server_personality(cfg, client=client)
    except Exception as exc:  # noqa: BLE001 - fail-open is the property under test
        first = second = third = f"RAISED {exc!r}"
    finally:
        release_logs(logs)

    check("a 401 fails open: None, no exception", first is None and second is None and third is None, repr(first))
    emitted = logs.warnings()
    check("exactly one warning for the window", len(emitted) == 1, str(emitted))
    message = emitted[0] if emitted else ""
    check("the warning names the cause", "rejected the bridge key" in message, message)
    check("the warning says the local personality stays in force", "local" in message and "personality" in message, message)
    check("the warning quotes the HTTP status", "401" in message, message)
    check("nothing was cached for a rejected key", cache_key(IDENTITY_A) not in bridge_config._SERVER_PERSONALITY_CACHE)

    # The rejection is re-reported once the window has passed.
    warned_at = bridge_config._SERVER_PERSONALITY_WARNED_AT.get(cache_key(IDENTITY_A))
    check("the warning was rate-limit stamped", warned_at is not None)
    bridge_config._SERVER_PERSONALITY_WARNED_AT[cache_key(IDENTITY_A)] = (warned_at or 0.0) - (
        bridge_config._SERVER_PERSONALITY_TTL_SECONDS + 1
    )
    logs = capture_logs()
    try:
        bridge_config._fetch_server_personality(cfg, client=client)
    finally:
        release_logs(logs)
    check("a new window reports it again", len(logs.warnings()) == 1, str(logs.warnings()))

    # 403 (an identity the key is not mapped to) behaves the same way.
    reset_state()
    forbidden = FakeClient(FakeResponse(403, {"success": False, "error": "Forbidden"}))
    logs = capture_logs()
    try:
        payload = bridge_config._fetch_server_personality(cfg, client=forbidden)
    finally:
        release_logs(logs)
    check("a 403 also fails open", payload is None, repr(payload))
    check("a 403 is reported the same way", len(logs.warnings()) == 1 and "403" in logs.warnings()[0], str(logs.warnings()))

    # Fail-open through the real merge path: the local config survives.
    reset_state()

    def dead_transport(url: str, headers: Any) -> Any:
        raise OSError("connect: connection refused")

    stub = StubHttpx(dead_transport)
    with stub:
        merged = bridge_config._apply_server_personality(cfg)
    check("the merge kept the local personality", merged.personality == "pragmatist", merged.personality)
    check("no provenance is claimed for a local config", merged.personality_version is None and merged.personality_origin is None)
    check("the local transport settings are untouched", merged.api_key == "stale-key" and merged.user_id == IDENTITY_A)


def case_success_merges_and_surfaces_provenance() -> None:
    print("\n6. a success merges the server's values and surfaces version/origin")
    reset_state()
    server_body = body(
        {
            "personality": "scholar",
            "source_weights": {"vector_search": 7},
            "scoring": {"relevance_multiplier": 3},
            "max_context_tokens": 8000,
            "updated_at": "2026-09-25T10:00:00.000Z",
        },
        origin="identity",
        version=4,
        resolved_for=IDENTITY_A,
        per_identity_enabled=True,
    )
    client = FakeClient(FakeResponse(200, server_body))
    cfg = config_for(personality="balanced", max_context_tokens=5000, debug=True)

    bridge_config._fetch_server_personality(cfg, client=client)  # populate this identity's entry
    logger = logging.getLogger(bridge_config.__name__)
    previous_level = logger.level
    logs = capture_logs()
    logger.setLevel(logging.DEBUG)
    try:
        merged = bridge_config._apply_server_personality(cfg)
    finally:
        logger.setLevel(previous_level)
        release_logs(logs)

    check("the server's profile wins", merged.personality == "scholar", merged.personality)
    check("the server's weights win", merged.source_weights.get("vector_search") == 7, str(merged.source_weights))
    check("the server's scoring wins", merged.scoring.get("relevance_multiplier") == 3, str(merged.scoring))
    check("the server's budget wins", merged.max_context_tokens == 8000, str(merged.max_context_tokens))
    check("the record version is surfaced", merged.personality_version == 4, repr(merged.personality_version))
    check("the record origin is surfaced", merged.personality_origin == "identity", repr(merged.personality_origin))
    check("transport settings stay local", merged.api_key == KEY_A and merged.user_id == IDENTITY_A and merged.mcp_url == MCP_URL)
    check("the merge reused the cached entry (no refetch)", client.calls == 1, str(client.calls))
    debug_lines = logs.debugs()
    check(
        "the sync is logged at debug with its version and origin",
        any("version=4" in line and "origin=identity" in line for line in debug_lines),
        str(debug_lines[-3:]),
    )

    # A legacy/default resolution is surfaced as-is, and only the server's own
    # vocabulary is trusted (a bogus origin or a non-int version is dropped).
    for label, envelope, expected in (
        ("legacy", {"origin": "legacy", "version": 0}, ("legacy", 0)),
        ("default", {"origin": "default", "version": 0}, ("default", 0)),
        ("bogus origin + string version", {"origin": "sorcery", "version": "4"}, (None, None)),
        ("no provenance", {}, (None, None)),
    ):
        reset_state()
        probe = FakeClient(FakeResponse(200, body({"personality": "scholar"}, **envelope)))
        probe_cfg = config_for()
        bridge_config._fetch_server_personality(probe_cfg, client=probe)
        probe_merged = bridge_config._apply_server_personality(probe_cfg)
        got = (probe_merged.personality_origin, probe_merged.personality_version)
        check(f"{label} → origin/version {expected}", got == expected, str(got))


def case_garbage_is_rejected_safely() -> None:
    print("\n7. garbage and failures are rejected safely")
    cases = (
        ("a non-dict config", FakeResponse(200, {"success": True, "config": "balanced"})),
        ("a list body", FakeResponse(200, ["success"])),
        ("a non-success envelope", FakeResponse(200, {"success": False, "error": "nope"})),
        ("a missing config", FakeResponse(200, {"success": True})),
        ("an unparseable body", FakeResponse(200, unparseable=True)),
        ("HTTP 500", FakeResponse(500, {"success": False})),
        ("HTTP 404", FakeResponse(404, {"success": False})),
    )
    for label, response in cases:
        reset_state()
        client = FakeClient(response)
        logs = capture_logs()
        try:
            payload = fetch(config_for(), client)
        finally:
            release_logs(logs)
        check(f"{label} → None, no exception", payload is None, repr(payload))
        check(f"{label} → nothing cached", bridge_config._SERVER_PERSONALITY_CACHE == {})
        check(f"{label} → no warning (only 401/403 are operational)", logs.warnings() == [], str(logs.warnings()))

    reset_state()
    payload = fetch(config_for(), ExplodingClient())
    check("a transport that raises → None, no exception", payload is None, repr(payload))

    reset_state()
    previous_port = os.environ.get("KATRA_REST_PORT")
    os.environ["KATRA_REST_PORT"] = "not-a-port"
    try:
        client = FakeClient(FakeResponse(200, body({"personality": "scholar"})))
        payload = fetch(config_for(), client)
    finally:
        if previous_port is None:
            os.environ.pop("KATRA_REST_PORT", None)
        else:
            os.environ["KATRA_REST_PORT"] = previous_port
    check("an unusable mcp_url/rest port → None", payload is None, repr(payload))
    check("no request was attempted for an unresolvable REST base", client.calls == 0, str(client.calls))


def case_default_transport_is_still_httpx() -> None:
    print("\n8. the default transport is still httpx.Client(timeout=3.0)")
    reset_state()
    stub = StubHttpx(lambda url, headers: FakeResponse(200, body({"personality": "scholar"}, origin="identity", version=3)))
    cfg = config_for()

    with stub:
        payload = fetch(cfg)

    check("a client was constructed", len(stub.clients) == 1, str(len(stub.clients)))
    check("its timeout is 3.0 s", bool(stub.clients) and stub.clients[0].timeout == 3.0, str([c.timeout for c in stub.clients]))
    check("the response was parsed through that client", isinstance(payload, dict) and payload.get("personality") == "scholar", repr(payload))
    if stub.clients and stub.clients[0].requests:
        request = stub.clients[0].requests[0]
        check("the default path names the identity too", query_of(request["url"]).get("user_id") == [IDENTITY_A], request["url"])
        check(
            "the default path carries the key too",
            request["headers"].get("Authorization") == f"Bearer {KEY_A}",
            str(request["headers"]),
        )
    else:
        check("the default path issued a request", False, "no request captured")


def case_new_fields_are_appended_and_optional() -> None:
    print("\n9. the provenance fields are optional and appended, not inserted")
    default = bridge_config.BridgeConfig()
    check("personality_version defaults to None", default.personality_version is None)
    check("personality_origin defaults to None", default.personality_origin is None)

    positional = bridge_config.BridgeConfig(
        MCP_URL,  # mcp_url
        "key",  # api_key
        IDENTITY_A,  # user_id
        "shared",  # shared_id
        False,  # enabled
        8.0,  # timeout_seconds
        4321,  # max_context_tokens
        ["reflection"],  # sources
        30.0,  # cache_ttl_seconds
        False,  # include_thinking
        True,  # debug
        "scholar",  # personality
        {"vector_search": 7},  # source_weights
        {"relevance_multiplier": 3},  # scoring
        False,  # sync_personality_from_server
        9,  # personality_version
        "legacy",  # personality_origin
    )
    check("the old field order still means what it did", positional.personality == "scholar" and positional.scoring == {"relevance_multiplier": 3}, str(positional))
    check("the flag field did not move", positional.sync_personality_from_server is False)
    check("the new fields sit at the end", (positional.personality_version, positional.personality_origin) == (9, "legacy"), str(positional))
    check("sources are still expanded", positional.sources == ["daily_reflection", "philosophical_insights", "unresolved_threads"], str(positional.sources))


def main() -> int:
    if not REST_BASE:
        print("FAILED: could not derive a REST base from the test mcp_url")
        return 1
    case_request_is_authenticated_and_named()
    case_empty_key_sends_no_header()
    case_cache_is_per_identity()
    case_ttl_expiry_refetches()
    case_rejected_key_warns_once_and_fails_open()
    case_success_merges_and_surfaces_provenance()
    case_garbage_is_rejected_safely()
    case_default_transport_is_still_httpx()
    case_new_fields_are_appended_and_optional()
    reset_state()

    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s): {', '.join(failures)}")
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
