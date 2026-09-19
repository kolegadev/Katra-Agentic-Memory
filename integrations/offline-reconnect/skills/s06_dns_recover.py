"""s06: repair DNS when routing is fine but resolution fails.

Deterministic: flush caches, then test fallback resolvers directly.
Writes a static resolv.conf only as the last step and only when the
systemd-resolved stub is unreachable AND a direct test against the
fallback resolver over the gateway succeeds.
"""
from skills.base import Ctx, skill

FALLBACKS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"]


def _resolve_works(ctx: Ctx, server: str) -> bool:
    r = ctx.run(["getent", "hosts", "one.one.one.one"], timeout=15)
    if r["rc"] == 0:
        return True
    # direct UDP query against a specific resolver: A? google.com
    query_hex = "aabb0100000100000000000006676f6f676c6503636f6d0000010001"
    code = ("import socket;"
            "s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);"
            "s.settimeout(4);"
            "s.connect(('%s',53));"
            "s.send(bytes.fromhex('%s'));"
            "print('dns-ok' if len(s.recv(512))>0 else 'dns-empty')"
            % (server, query_hex))
    r = ctx.run(["python3", "-c", code], timeout=15)
    return r["rc"] == 0 and "dns-ok" in r["out"]


@skill("s06_dns_recover",
       when="gateway pings OK but DNS resolution fails (verify fails at DNS stage)",
       effect="resolvectl flush + set per-link fallback DNS; static resolv.conf only if not a symlink",
       risk="mutating", needs_root=True)
def run(ctx: Ctx) -> dict:
    iface = ctx.config.get("iface", "wlp3s0")
    ctx.run(["resolvectl", "flush-caches"], timeout=15, mutating=True, elevated=True)
    if _resolve_works(ctx, "system"):
        return ctx.result("ok", evidence="DNS recovered after cache flush", changed=True)
    for srv in FALLBACKS:
        if not _resolve_works(ctx, srv):
            continue
        # preferred: set per-link DNS via resolvectl (no file writes, plays
        # well with the systemd-resolved stub)
        r = ctx.run(["resolvectl", "dns", iface, srv], timeout=15, mutating=True, elevated=True)
        if r["rc"] == 0:
            return ctx.result("ok",
                              evidence="resolvectl dns %s %s set" % (iface, srv),
                              changed=True)
        # last resort: static resolv.conf — ONLY when it is a real file
        # (never follow a symlink to the resolved stub, which would be
        # clobbered and then overwritten by resolved anyway)
        import os
        rc_path = "/etc/resolv.conf"
        if os.path.islink(rc_path):
            return ctx.result("failed",
                              evidence="/etc/resolv.conf is a symlink (resolved stub); "
                                       "resolvectl failed: %s"
                                       % (r["err"] or "rc=%s" % r["rc"])[:140],
                              changed=True)
        w = ctx.file_write(rc_path,
                           "# net-agent s06 fallback\nnameserver %s\n" % srv)
        if w["rc"] != 0:
            return ctx.result("failed", evidence="resolv.conf write failed: %s"
                              % w["err"][:120], changed=True)
        return ctx.result("ok", evidence="wrote static resolv.conf -> %s" % srv,
                          changed=True)
    return ctx.result("failed",
                      evidence="no fallback resolver reachable; DNS stage is not the only fault")
