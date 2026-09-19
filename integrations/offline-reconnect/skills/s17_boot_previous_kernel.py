"""s17: LAST RESORT — one-shot reboot into the previous kernel.

Invokes the fixed root wrapper /usr/local/sbin/net-agent-boot-previous.sh
(no args): it finds the newest non-running kernel in /boot, sets it as the
next boot entry via grub-reboot and reboots. If the wrapper returns, the
reboot was refused (no previous kernel / no grub entry / grub-reboot failed).
"""
from skills.base import Ctx, skill


@skill("s17_boot_previous_kernel",
       when="LAST RESORT: a new kernel/driver left wifi broken beyond all repair skills — boot the previous kernel once",
       effect="grub-reboot to the previous installed kernel and reboot immediately",
       risk="mutating", needs_root=True)
def run(ctx: Ctx) -> dict:
    r = ctx.run(["/usr/local/sbin/net-agent-boot-previous.sh"],
                timeout=90, mutating=True, elevated=True)
    if r["rc"] != 0:
        return ctx.result("failed",
                          evidence="boot-previous wrapper rc=%s: %s"
                                   % (r["rc"], (r["err"] or r["out"])[:160]),
                          changed=True)
    # rc==0 means the machine is rebooting; the dispatcher dies mid-cycle and
    # the watchdog re-engages after boot.
    return ctx.result("ok",
                      evidence="rebooting into previous kernel",
                      changed=True)
