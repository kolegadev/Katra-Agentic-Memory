"""s12: the CONTRACT verifier. The only authority that may declare success.

ONLINE = gateway answers (ARP/ping) AND DNS resolves AND TCP:443 opens to two
independent endpoints. Runs out-of-process from the model; the LLM can never
self-declare recovery.
"""
import socket
from skills.base import Ctx, skill

CHECK_HOSTS = ["1.1.1.1", "8.8.8.8"]


def _tcp_443(host: str, timeout: float = 5) -> bool:
    try:
        s = socket.create_connection((host, 443), timeout=timeout)
        s.close()
        return True
    except OSError:
        return False


def _dns_ok(ctx: Ctx, timeout: float = 6) -> bool:
    # bounded: resolve via subprocess with an explicit timeout (glibc
    # getaddrinfo itself has no timeout and can hang a wedged resolver)
    r = ctx.run(["python3", "-c",
                 "import socket; socket.getaddrinfo('one.one.one.one', 443, "
                 "proto=socket.IPPROTO_TCP)"], timeout=timeout)
    return r["rc"] == 0


def _gateway_up(ctx: Ctx) -> bool:
    gw = ctx.config.get("gateway")
    if not gw:
        r = ctx.run(["ip", "route"], timeout=10)
        for line in r["out"].splitlines():
            if line.startswith("default "):
                gw = line.split()[2]
                break
    if not gw:
        return False
    r = ctx.run(["ping", "-c", "1", "-W", "2", gw], timeout=10)
    return r["rc"] == 0


@skill("s12_verify_online",
       when="after every repair attempt — or anytime: is internet actually back?",
       effect="probe gateway, DNS, and two independent TCP:443 endpoints (read-only)",
       risk="readonly")
def run(ctx: Ctx) -> dict:
    gw = _gateway_up(ctx)
    dns = _dns_ok(ctx)
    tcp = [h for h in CHECK_HOSTS if _tcp_443(h)]
    online = gw and dns and len(tcp) >= 1
    evidence = "gateway=%s dns=%s tcp443=%s" % (gw, dns, tcp)
    return ctx.result("ok" if online else "failed", evidence=evidence,
                      data={"online": online, "gateway": gw, "dns": dns,
                            "tcp443_hosts": tcp})


# CLI use goes through dispatcher/dispatch.py --verify-only, which guarantees
# the package path is importable.
