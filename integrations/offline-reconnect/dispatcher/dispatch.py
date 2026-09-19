"""net-agent dispatcher — the loop that runs skills until connectivity returns.

Loop contract:
  * every cycle = snapshot → model picks ONE skill → execute → verify (s12)
  * ONLY s12 (deterministic, out-of-model) may declare success
  * safety: max cycles, mutation budget, STOP file
  * exit 0 = online, exit 2 = still offline (watchdog timer re-arms),
    exit 3 = fatal/stopped

The watchdog re-invokes this program after backoff, so the loop as a whole
"continues until the connection is solved" — exactly the requested behavior.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from skills.base import Ctx, SKILLS, catalog_text, load_all, run_skill  # noqa: E402
import snapshot as snapshot_mod  # noqa: E402
from ollama_client import ask as model_ask  # noqa: E402

DEFAULTS = {
    "max_cycles": 8,
    "mutation_budget": 5,
    "cycle_sleep_s": 20,
    "model": "llama3.1:8b",
    "fallback_model": "qwen2.5-coder:7b",
    "iface": "wlp3s0",
    "gateway": None,
    "routers": [],
    "katra_url": "http://localhost:9012",
    "katra_api_key_path": None,
    "state_dir": "/var/lib/net-agent",
}


def load_config(path: str | None) -> dict:
    cfg = dict(DEFAULTS)
    if path and os.path.exists(path):
        # explicit --config is authoritative — nothing else is merged
        try:
            cfg.update(json.loads(open(path).read()))
        except Exception as e:
            print("config load failed for %s: %s" % (path, e), file=sys.stderr)
        return cfg
    # fallback chain: /etc (root-only install) first, repo-local example last
    for cand in ["/etc/net-agent/config.json", str(ROOT / "config.json")]:
        if os.path.exists(cand):
            try:
                cfg.update(json.loads(open(cand).read()))
            except Exception as e:
                print("config load failed for %s: %s" % (cand, e), file=sys.stderr)
    return cfg


def state_path(cfg: dict, name: str) -> Path:
    """State location: cfg state_dir if writable, else /tmp fallback."""
    d = Path(cfg["state_dir"])
    try:
        d.mkdir(parents=True, exist_ok=True)
        probe = d / ".probe"
        probe.write_text("")
        probe.unlink()
        return d / name
    except OSError:
        d = Path("/tmp/net-agent-%d" % os.getuid())
        d.mkdir(parents=True, exist_ok=True)
        return d / name


LADDER = ["s01_rfkill_recover", "s02_nm_profile_up", "s03_nm_rescan_connect",
          "s05_dhcp_renew", "s04_wpa_restart", "s06_dns_recover",
          "s08_scan_survey", "s09_router_wan_check", "s13_wait_monitor"]


def escalate(skill: str) -> str:
    """Deterministic next rung when a skill keeps failing."""
    if skill in LADDER:
        i = LADDER.index(skill)
        return LADDER[(i + 1) % len(LADDER)]
    return LADDER[0]


def deterministic_hint(snap: dict) -> str:
    """Rule-based pre-classification so the small model barely has to think."""
    if snap.get("rfkill_wifi_blocked"):
        return "WiFi radio is soft-blocked; s01_rfkill_recover is the standard first fix"
    if snap.get("gw_ping") == "up" and not snap.get("dns_resolves"):
        return "gateway reachable but DNS broken; s06_dns_recover likely"
    if snap.get("gw_ping") == "up" and snap.get("dns_resolves"):
        return "LAN looks fine but internet still down; s09_router_wan_check to test WAN"
    if snap.get("ipv4") in (None, "") and snap.get("link") == "up":
        return "associated but no IPv4; s05_dhcp_renew is the likely fix"
    if snap.get("link") != "up":
        if snap.get("visible_ssids"):
            return "interface down but networks visible; s02_nm_profile_up likely"
        return "no networks visible at all; consider s08_scan_survey then s10_driver_reload"
    return ""


def katra_log(cfg: dict, event: dict) -> None:
    """Best-effort episodic event to Katra (local, offline-safe). Never fatal."""
    try:
        import urllib.request
        key = ""
        p = cfg.get("katra_api_key_path")
        if p and os.path.exists(p):
            key = open(p).read().strip()
        body = json.dumps(event).encode()
        req = urllib.request.Request(
            cfg["katra_url"] + "/api/v1/memory/episodic/events", data=body,
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + key})
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


def load_state(cfg: dict) -> dict:
    try:
        p = state_path(cfg, "net-agent-state.json")
        if p.exists():
            return json.loads(p.read_text())
    except Exception:
        pass
    return {"history": [], "consecutive_failures": 0}


def save_state(cfg: dict, state: dict) -> None:
    try:
        state_path(cfg, "net-agent-state.json").write_text(
            json.dumps(state, indent=1))
    except Exception:
        pass


def stopped(cfg: dict) -> bool:
    for p in [state_path(cfg, "STOP"), Path("/run/net-agent/STOP"),
              Path("/etc/net-agent/STOP")]:
        if p.exists():
            return True
    return False


def run_loop(cfg: dict, ask_fn=None, dry_run: bool = False,
             collect=None, verify=None) -> int:
    collect = collect or snapshot_mod.collect
    load_all(str(ROOT / "skills"))
    catalog = catalog_text()
    state = load_state(cfg)
    ctx = Ctx(cfg, dry_run=dry_run,
              log_path=str(state_path(cfg, "net-agent.log"))
              if not dry_run else None,
              mutation_budget=cfg["mutation_budget"])
    model = cfg["model"]

    if stopped(cfg):
        print("STOP file present; exiting", file=sys.stderr)
        return 3

    online_at_start = _verify_now(cfg, ctx)
    if online_at_start:
        state["consecutive_failures"] = 0
        save_state(cfg, state)
        print("already online; nothing to do")
        return 0

    for cycle in range(1, cfg["max_cycles"] + 1):
        if stopped(cfg):
            return 3
        try:
            snap = collect(cfg)
        except Exception as e:
            print("snapshot failed: %s" % e, file=sys.stderr)
            time.sleep(cfg["cycle_sleep_s"])
            continue

        hint = deterministic_hint(snap)
        if ask_fn is None:
            name, why, _raw = ask_with_fallback(cfg, model, snap, catalog,
                                                state["history"][-6:], hint)
        else:
            try:
                name, why, _raw = ask_fn(model, snap, catalog,
                                         state["history"][-6:],
                                         extra_hint=hint)
            except Exception as e:
                name, why = "s02_nm_profile_up", "model error: %s" % str(e)[:80]
        if name not in SKILLS:
            name, why = "s02_nm_profile_up", "invalid pick; deterministic fallback"
        # anti-repeat escalation: any skill that ran this run WITHOUT
        # restoring connectivity must not be retried — keep climbing the
        # ladder until an unused rung is found.
        used = [h["skill"] for h in state["history"][-8:]
                if not h.get("online_after")]
        guard = 0
        while name in used and guard <= len(LADDER) + 1:
            forced = escalate(name)
            why = "%s | ESCALATION: %s already tried (still offline); forcing %s" \
                  % (why, name, forced)
            name = forced
            guard += 1

        print("[cycle %d] hint=%r -> %s (%s)" % (cycle, hint, name, why))
        res = run_skill(name, ctx)
        print("  result: %s %s" % (res.get("status"), res.get("evidence", "")[:200]))

        entry = {"cycle": cycle, "ts": time.time(), "skill": name, "why": why,
                 "result": res.get("status"), "evidence": res.get("evidence", "")[:300],
                 "online_after": None}
        state["history"].append(entry)
        state["history"] = state["history"][-40:]

        # contract verification after EVERY skill
        v = _verify_now(cfg, ctx)
        entry["online_after"] = v
        if v:
            state["consecutive_failures"] = 0
            save_state(cfg, state)
            katra_log(cfg, {"session_id": "net-agent", "event_type":
                            "net_recovery_success", "content": {
                                "role": "assistant",
                                "message": "reconnected after %d cycles; winning "
                                           "skill %s" % (cycle, name),
                                "history_tail": state["history"][-4:]},
                            "metadata": {"agent": "net-agent"}})
            print("ONLINE after %d cycles (skill %s)" % (cycle, name))
            return 0

        if ctx.mutations >= cfg["mutation_budget"]:
            print("mutation budget exhausted (%d); stopping this run"
                  % ctx.mutations, file=sys.stderr)
            break
        if res.get("status") == "failed" and name == "s13_wait_monitor":
            print("ISP-down mode; longer backoff", file=sys.stderr)
            break
        time.sleep(cfg["cycle_sleep_s"])

    state["consecutive_failures"] = state.get("consecutive_failures", 0) + 1
    save_state(cfg, state)
    katra_log(cfg, {"session_id": "net-agent", "event_type": "net_recovery_attempt",
                    "content": {"role": "assistant",
                                "message": "run ended offline after cycles",
                                "history_tail": state["history"][-6:]},
                    "metadata": {"agent": "net-agent",
                                 "consecutive_failures": state["consecutive_failures"]}})
    print("still offline after this run; exit 2 (watchdog re-arms)")
    return 2


def ask_with_fallback(cfg: dict, model, snap, catalog, history, hint):
    """Try cfg model, then fallback_model, then deterministic s02."""
    errs = []
    for m in (cfg["model"], cfg.get("fallback_model")):
        if not m:
            continue
        try:
            name, why, raw = model_ask(m, snap, catalog, history,
                                       extra_hint=hint)
            return name, why, raw
        except Exception as e:
            errs.append("%s: %s" % (m, str(e)[:80]))
    return "s02_nm_profile_up", "model unreachable (%s); deterministic fallback" \
           % "; ".join(errs), "error"


def _verify_now(cfg: dict, ctx: Ctx) -> bool:
    res = run_skill("s12_verify_online", ctx)
    return bool(res.get("data", {}).get("online"))


def main() -> int:
    ap = argparse.ArgumentParser(description="net-agent dispatcher loop")
    ap.add_argument("--config", default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify-only", action="store_true",
                    help="run the contract verifier once and exit")
    ap.add_argument("--snapshot-only", action="store_true")
    args = ap.parse_args()

    cfg = load_config(args.config)
    if args.verify_only:
        ctx = Ctx(cfg)
        load_all(str(ROOT / "skills"))
        print(json.dumps(run_skill("s12_verify_online", ctx), indent=1))
        return 0
    if args.snapshot_only:
        print(json.dumps(snapshot_mod.collect(cfg), indent=1))
        return 0
    return run_loop(cfg, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
