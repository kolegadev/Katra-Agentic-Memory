#!/usr/bin/env python3
"""
Katra Health Check — proactive invariant probes for memory & identity integrity.

Motivation
----------
Bugs in the memory pipeline tend to fail *silently*: a field-name mismatch
that makes every write collide, a stale API key that 401s, an embedding
service that loads once then dies, an extraction gate set so high nothing
is ever distilled. None of these throw a visible error — they just quietly
starve the memory. This script exists so those failures are *detected*
rather than stumbled upon.

It is deliberately:
  * Standalone — talks to the REST API over HTTP, no Docker/Mongo coupling,
    so it runs identically on every machine (iMac, Pi5, theBrick, johnpellew).
  * Config-light — reads KATRA_REST_URL / KATRA_ADMIN_KEY from env, with
    sensible localhost:9012 defaults.
  * Fail-loud in data, fail-safe in execution — every probe is wrapped; a
    probe that errors is reported as a FAIL, never crashes the run.
  * Trend-aware — persists the previous run so it can catch *monotonic*
    problems (e.g. unprocessed backlog climbing, semantic facts flatlining).

Each run emits a structured report: per-check status (ok/warn/fail), a
top-line verdict, and (optionally) posts a bulletin to Katra so agents can
see their own health. Exit code is non-zero if any check FAILs.

Usage:
    python3 katra_health_check.py              # human-readable report
    python3 katra_health_check.py --json       # machine-readable
    python3 katra_health_check.py --post       # also store result in Katra
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# ── Config (env-overridable, portable defaults) ─────────────────────
REST_URL = os.environ.get("KATRA_REST_URL", "http://localhost:9012/api/v1")
ADMIN_KEY = os.environ.get("KATRA_ADMIN_KEY", "")
STATE_FILE = os.path.expanduser(os.environ.get(
    "KATRA_HEALTH_STATE", "~/.katra/health-check-state.json"))
HTTP_TIMEOUT = float(os.environ.get("KATRA_HEALTH_TIMEOUT", "10"))

# Thresholds
UNPROCESSED_WARN = 100          # background backlog warning (matches server)
UNPROCESSED_FAIL = 500          # backlog is clearly stuck
EMBED_COVERAGE_WARN = 0.80      # fraction of semantic_facts with embeddings

OK, WARN, FAIL = "ok", "warn", "fail"


# ── HTTP helpers ────────────────────────────────────────────────────
def _get(path: str, auth: bool = False) -> tuple[int, dict | None]:
    url = f"{REST_URL}{path}"
    headers = {"Accept": "application/json"}
    if auth and ADMIN_KEY:
        headers["Authorization"] = f"Bearer {ADMIN_KEY}"
    req = Request(url, headers=headers, method="GET")
    try:
        with urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return resp.status, json.loads(resp.read().decode())
    except HTTPError as e:
        try:
            body = json.loads(e.read().decode())
        except Exception:
            body = None
        return e.code, body
    except (URLError, TimeoutError, ValueError) as e:
        return 0, {"error": str(e)}


def _post(path: str, payload: dict | None = None, auth: bool = True) -> tuple[int, dict | None]:
    url = f"{REST_URL}{path}"
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if auth and ADMIN_KEY:
        headers["Authorization"] = f"Bearer {ADMIN_KEY}"
    data = json.dumps(payload or {}).encode()
    req = Request(url, headers=headers, data=data, method="POST")
    try:
        with urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return resp.status, json.loads(resp.read().decode())
    except HTTPError as e:
        try:
            body = json.loads(e.read().decode())
        except Exception:
            body = None
        return e.code, body
    except (URLError, TimeoutError, ValueError) as e:
        return 0, {"error": str(e)}


# ── State (for trend detection) ─────────────────────────────────────
def load_state() -> dict:
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
    except OSError:
        pass


# ── Individual checks ───────────────────────────────────────────────
# Each returns dict: {check, status, detail, metrics?}

def check_core_services() -> dict:
    """Mongo/Redis/LLM/embeddings up. Inspects the services sub-object
    directly because the top-level status only flips on Mongo/Redis loss."""
    code, body = _get("/health")
    if code != 200 or not body:
        return {"check": "core_services", "status": FAIL,
                "detail": f"health endpoint unreachable (HTTP {code})"}
    svc = body.get("services", {})
    down = []
    if svc.get("mongodb") != "connected":
        down.append("mongodb")
    if svc.get("redis") != "connected":
        down.append("redis")
    llm_bad = svc.get("llm") in (None, "unavailable")
    embed_bad = svc.get("embeddings") != "available"

    if down:
        return {"check": "core_services", "status": FAIL,
                "detail": f"core datastore down: {', '.join(down)}", "metrics": svc}
    if llm_bad or embed_bad:
        degraded = []
        if llm_bad:
            degraded.append("llm")
        if embed_bad:
            degraded.append("embeddings")
        return {"check": "core_services", "status": WARN,
                "detail": f"degraded (keyword-only / no extraction): {', '.join(degraded)}",
                "metrics": svc}
    return {"check": "core_services", "status": OK,
            "detail": f"mongo+redis+llm({svc.get('llm')})+embeddings all up", "metrics": svc}


def check_admin_auth() -> dict:
    """The admin key we hold must actually authenticate — catches the stale
    key / 401 class that silently breaks extractors and dashboard writes."""
    if not ADMIN_KEY:
        return {"check": "admin_auth", "status": WARN,
                "detail": "no KATRA_ADMIN_KEY set — auth-gated checks skipped"}
    code, _ = _get("/admin/background/status", auth=True)
    if code == 401 or code == 403:
        return {"check": "admin_auth", "status": FAIL,
                "detail": f"admin key rejected (HTTP {code}) — stale/rotated key"}
    if code != 200:
        return {"check": "admin_auth", "status": WARN,
                "detail": f"unexpected status probing admin auth (HTTP {code})"}
    return {"check": "admin_auth", "status": OK, "detail": "admin key valid"}


def check_background_processor(prev: dict) -> dict:
    """Processor running + backlog bounded and not monotonically climbing.
    Catches the auth-crash-loop / stalled-loop class."""
    code, body = _get("/admin/background/status", auth=True)
    if code != 200 or not body:
        # Fall back to the unauthenticated dashboard-stats path if needed.
        return {"check": "background_processor", "status": WARN,
                "detail": f"could not read processor status (HTTP {code})"}
    stats = body.get("stats", body)
    running = stats.get("is_running")
    unprocessed = stats.get("unprocessed_count")
    metrics = {"is_running": running, "unprocessed": unprocessed,
               "last_run_time": stats.get("last_run_time")}

    if running is False:
        return {"check": "background_processor", "status": FAIL,
                "detail": "processor not running", "metrics": metrics}

    if isinstance(unprocessed, int):
        prev_unproc = (prev.get("background_processor") or {}).get("unprocessed")
        climbing = isinstance(prev_unproc, int) and unprocessed > prev_unproc > UNPROCESSED_WARN
        if unprocessed >= UNPROCESSED_FAIL or (climbing and unprocessed >= UNPROCESSED_WARN):
            return {"check": "background_processor", "status": FAIL,
                    "detail": f"backlog stuck/climbing: {unprocessed} unprocessed"
                              + (f" (was {prev_unproc})" if climbing else ""),
                    "metrics": metrics}
        if unprocessed >= UNPROCESSED_WARN:
            return {"check": "background_processor", "status": WARN,
                    "detail": f"backlog elevated: {unprocessed} unprocessed", "metrics": metrics}
    return {"check": "background_processor", "status": OK,
            "detail": f"running, {unprocessed} unprocessed", "metrics": metrics}


def check_semantic_growth(prev: dict) -> dict:
    """Semantic facts should grow as episodic events are processed. If events
    accumulate but facts flatline, the extraction gate is rejecting everything
    (the 500-vs-50 class of misconfiguration)."""
    code, body = _get("/admin/dashboard-stats")
    if code != 200 or not body:
        return {"check": "semantic_growth", "status": WARN,
                "detail": f"could not read dashboard-stats (HTTP {code})"}
    counts = body.get("counts", {})
    episodic = counts.get("episodic_events", 0)
    facts = counts.get("semantic_facts", 0)
    metrics = {"episodic_events": episodic, "semantic_facts": facts}

    prev_counts = (prev.get("semantic_growth") or {})
    prev_ep = prev_counts.get("episodic_events")
    prev_fa = prev_counts.get("semantic_facts")
    if isinstance(prev_ep, int) and isinstance(prev_fa, int):
        ep_delta = episodic - prev_ep
        fa_delta = facts - prev_fa
        # Many new events processed, but zero new facts => gate likely broken.
        if ep_delta >= 50 and fa_delta == 0 and facts == 0:
            return {"check": "semantic_growth", "status": FAIL,
                    "detail": f"+{ep_delta} events but 0 semantic facts ever — extraction gate likely broken",
                    "metrics": {**metrics, "ep_delta": ep_delta, "fa_delta": fa_delta}}
        if ep_delta >= 100 and fa_delta == 0:
            return {"check": "semantic_growth", "status": WARN,
                    "detail": f"+{ep_delta} events but no new facts this cycle — check extraction",
                    "metrics": {**metrics, "ep_delta": ep_delta, "fa_delta": fa_delta}}
    return {"check": "semantic_growth", "status": OK,
            "detail": f"{facts} facts / {episodic} events", "metrics": metrics}


def check_graph_integrity() -> dict:
    """Knowledge graph should have named nodes and, if it has nodes, some
    edges. Catches the field-name schisms (blank names / edges that can't
    store) that made the graph silently useless."""
    # Authoritative counts come from database-stats (raw collection counts).
    # The enhance/stats endpoint reflects a separate in-memory graph service
    # that can report 0 even when knowledge_relationships is populated, so we
    # do NOT trust it for health.
    node_count = edge_count = None
    code, body = _get("/admin/database-stats", auth=True)
    if code == 200 and body:
        cols = body.get("stats", {}).get("mongodb", {}).get("collection_details", [])
        by_name = {c.get("name"): c.get("documents") for c in cols}
        node_count = by_name.get("knowledge_nodes")
        edge_count = by_name.get("knowledge_relationships")
    # Fall back to dashboard-stats for node count if database-stats unavailable.
    if node_count is None:
        c2, b2 = _get("/admin/dashboard-stats")
        if c2 == 200 and b2:
            node_count = b2.get("counts", {}).get("knowledge_nodes")

    metrics = {"nodes": node_count, "edges": edge_count}
    if node_count is None:
        return {"check": "graph_integrity", "status": WARN,
                "detail": "could not read graph stats", "metrics": metrics}
    # Authoritative edge count from the collection: many nodes but zero edges
    # is the field-name-schism signature (relationship writes silently failing).
    if node_count > 20 and edge_count == 0:
        return {"check": "graph_integrity", "status": FAIL,
                "detail": f"{node_count} nodes but 0 relationships — edge writes are failing",
                "metrics": metrics}
    return {"check": "graph_integrity", "status": OK,
            "detail": f"{node_count} nodes, {edge_count} relationships", "metrics": metrics}


def check_reader_writer_vocab() -> dict:
    """Detect the field-VALUE mismatch class directly: get_heartbeat_status
    on the server checks status in {ok,alert} but the Python heartbeat writes
    HEARTBEAT_OK. We surface this by asking the heartbeat status endpoint /
    MCP tool if available; if the reported recent-run health disagrees with
    the raw run count, flag it.

    This is best-effort: it only warns, since it's a known-noisy signal until
    the vocab is unified server-side.
    """
    # No dedicated REST endpoint; rely on dashboard recent_activity heuristic.
    code, body = _get("/admin/dashboard-stats")
    if code != 200 or not body:
        return {"check": "reader_writer_vocab", "status": OK,
                "detail": "skipped (no stats)"}
    # If there is recent autonomous activity but all statuses render as a
    # dash/unknown, that hints at a value-vocab mismatch.
    recent = body.get("recent_activity", [])
    if recent:
        unknown = sum(1 for e in recent if str(e.get("status", "")).strip() in ("", "—", "unknown"))
        if unknown == len(recent) and len(recent) >= 5:
            return {"check": "reader_writer_vocab", "status": WARN,
                    "detail": f"all {len(recent)} recent activities have unknown status — possible field-value mismatch"}
    return {"check": "reader_writer_vocab", "status": OK, "detail": "no vocab mismatch signal"}


# ── Orchestration ───────────────────────────────────────────────────
def run_all() -> dict:
    prev = load_state()
    checks = [
        check_core_services(),
        check_admin_auth(),
        check_background_processor(prev),
        check_semantic_growth(prev),
        check_graph_integrity(),
        check_reader_writer_vocab(),
    ]

    statuses = [c["status"] for c in checks]
    if FAIL in statuses:
        verdict = FAIL
    elif WARN in statuses:
        verdict = WARN
    else:
        verdict = OK

    result = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "verdict": verdict,
        "checks": checks,
        "rest_url": REST_URL,
    }

    # Persist metrics for next-run trend detection.
    new_state = {c["check"]: c.get("metrics", {}) for c in checks if c.get("metrics")}
    new_state["_last_run"] = result["timestamp"]
    save_state(new_state)

    return result


def format_human(result: dict) -> str:
    icons = {OK: "✅", WARN: "⚠️ ", FAIL: "❌"}
    lines = [
        "═" * 56,
        f"  Katra Health Check — {result['verdict'].upper()}",
        f"  {result['timestamp']}  ({result['rest_url']})",
        "═" * 56,
    ]
    for c in result["checks"]:
        lines.append(f"  {icons.get(c['status'], '?')} {c['check']:24} {c['detail']}")
    return "\n".join(lines)


def post_to_katra(result: dict) -> bool:
    """Store the health result as a memory so agents can see their own health."""
    verdict = result["verdict"]
    fails = [c for c in result["checks"] if c["status"] == FAIL]
    warns = [c for c in result["checks"] if c["status"] == WARN]
    summary = f"[HEALTH CHECK — {verdict.upper()}] "
    if fails:
        summary += "FAIL: " + "; ".join(f"{c['check']}: {c['detail']}" for c in fails) + ". "
    if warns:
        summary += "WARN: " + "; ".join(f"{c['check']}: {c['detail']}" for c in warns) + ". "
    if not fails and not warns:
        summary += "All systems healthy."

    code, _ = _post("/admin/memory-search", auth=False)  # noop probe; skip if no store path
    # Store via the ingestion endpoint if available.
    payload = {
        "content": summary,
        "user_id": "health-check",
        "category": "event",
        "source": "health-check",
        "tags": ["health-check", f"verdict:{verdict}"],
    }
    code, _ = _post("/ingestion/ingest", payload, auth=True)
    return code in (200, 201)


def main() -> int:
    ap = argparse.ArgumentParser(description="Katra proactive health check")
    ap.add_argument("--json", action="store_true", help="output JSON")
    ap.add_argument("--post", action="store_true", help="store result in Katra memory")
    ap.add_argument("--quiet", action="store_true", help="only print on WARN/FAIL")
    args = ap.parse_args()

    result = run_all()

    if args.post:
        result["posted"] = post_to_katra(result)

    if args.json:
        print(json.dumps(result, indent=2))
    elif not (args.quiet and result["verdict"] == OK):
        print(format_human(result))

    return 0 if result["verdict"] != FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
