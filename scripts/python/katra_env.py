"""Compatibility shim: katra_env.get_key -> satori_env.get_key.

Post-cutover rename (2026-08-21): the .env loader lives in satori_env.py.
Older service scripts (wake_service, inter_agent_bridge, opencode_background)
still import katra_env; keep this shim so they work from the current repo.
"""
from satori_env import get_key  # noqa: F401
