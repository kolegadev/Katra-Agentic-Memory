# Contract: offline-reconnect skill toolbox (net-agent)

**Owner:** Satori · **Date:** 2026-09-05 · **Status:** BUILT + UNIT-VERIFIED (live outage drill pending)
**Governed by:** loop-director regime — every F-gate below has an independent test, and an independent verifier pass reviewed the whole toolbox.

## Goal (John's spec)

When thebrick loses internet: fall back to the **local LLM on the Vulkan iGPU** for exactly one task — reconnect the machine to router/WiFi and restore inference access. The model must not solve problems (it is small): it must **select** from a pre-built, pre-tested toolbox of deterministic skills. The loop **continues until the connection is solved**. Katra's vault holds the router credentials. Wakeup ritual engages the service.

## Architecture

```
watchdog (systemd timer 30s) ──fail──► dispatch loop (net-agent)
                                          │  per cycle:
                                          │  1. snapshot (deterministic diag JSON)
                                          │  2. deterministic hint (rule pre-classifier)
                                          │  3. small model picks ONE skill (tool call)
                                          │  4. skill executes (allowlisted commands only)
                                          │  5. s12 verify (independent contract check)
                                          │  repeat ≤8 cycles; exit 2 → timer re-arms
                                          └► exit 0 ONLY when s12 says online
wake ritual (satori-wake.sh / wake-check.sh) ──offline──► same loop, immediate
```

## The skill set (s01–s13)

| Skill | Risk | Purpose |
|---|---|---|
| s01_rfkill_recover | MUT | unblock soft-blocked radio |
| s02_nm_profile_up | MUT | bring up saved NM profile (PSK already stored) |
| s03_nm_rescan_connect | MUT | rescan + connect known SSIDs from vault-seeded config |
| s04_wpa_restart | MUT | restart wpa_supplicant + NetworkManager |
| s05_dhcp_renew | MUT | reapply / dhclient release+renew |
| s06_dns_recover | MUT | flush caches, test fallbacks, static resolv.conf last resort |
| s07_profile_rebuild | MUT | recreate NM profile from config (vault secrets) |
| s08_scan_survey | RO | list visible APs (read-only evidence) |
| s09_router_wan_check | RO | router admin WAN status → ISP-down detection |
| s10_driver_reload | MUT | modprobe -r/modprobe wlan driver |
| s11_marauder_survey | RO | ESP32 Marauder serial scan (optional hardware) |
| s12_verify_online | RO | **THE CONTRACT**: gateway + DNS + 2×TCP443 |
| s13_wait_monitor | RO | ISP-down: idle-poll, longer backoff |

## F-gates

- **F1 Model is a router, not a thinker.** One tool: `pick_skill(name)`. Commands never contain model text. Skills are static Python. *(test: catalog integrity; model-selection scenarios)*
- **F2 Only s12 may declare success.** Online verdict = gateway reachable AND DNS AND ≥1 TCP:443. The model can never self-declare. *(test: TestVerifyContract; loop tests)*
- **F3 The loop persists until solved.** Failed runs exit 2; `net-watchdog.timer` (Persistent=true) re-arms; per-run history persists to state JSON; wake ritual re-engages. *(test: test_loop_continues_across_runs_until_solved)*
- **F4 Safety budgets.** Max 8 cycles/run, mutation budget enforced at the `Ctx.run` choke point (a mutating command at/over budget returns `rc=-4`, so no skill can overshoot — verifier D1 fixed), STOP file (`/etc/net-agent/STOP`) halts everything, root-gated skills skip when unprivileged, watchdog exits 0 quietly when STOP exists. *(test: Ctx budget hard-stop, file_write budget, mutation budget, STOP file, root gate)*
- **F5 Invalid model output can't break the loop.** Unknown/unparseable picks fall back deterministically to s02; primary model errors retry once on `fallback_model`, then s02 (D4); skill exceptions are caught and returned as envelopes. *(test: invalid pick fallback, fallback-model retry, both-down s02)*
- **F6 Offline-safe end-to-end.** No internet dependency anywhere in the loop: Ollama is local, Katra is local Docker, verification probes are the only WAN touchpoints (and they're the thing being restored). DNS probes are subprocess-bounded (D8). Model calls measured at ~2 s/pick on Vulkan iGPU (qwen2.5-coder:7b warm).
- **F7 Deterministic hints reduce model load.** Rule-based pre-classifier emits a hint per cycle; measured 5/5 correct routing on both candidate models with hints.
- **F8 No secret leakage.** PSK/admin passwords only enter skills via config (installed root-only, mode 600); evidence/logs/state/Katra events never contain secrets (verifier audited all egress points). s06 no longer writes through the resolv.conf symlink — it prefers `resolvectl dns <iface>` and refuses symlinked paths (D2). Config precedence: explicit `--config` authoritative, then `/etc`, then repo-local (D3).

## Installation & privileges (checked on thebrick 2026-09-05)

- **Katra/docker needs no sudo**: native Docker engine 29.1.3 (not colima — colima is not installed on thebrick); johnpellew is in the `docker` group.
- The net-agent's host-network fixes (rfkill unblock, systemctl restart wpa_supplicant/NetworkManager, resolvectl, nmcli profile edits, modprobe) live **outside docker** and need root — but only once:
  - `./install.sh --user` — toolbox + user watchdog units, **no sudo**.
  - `sudo ./install.sh --grant-user $USER` — one-time NOPASSWD sudoers allowlist for exactly those commands (template in `install/net-agent-sudoers.in`, visudo-checked). After that, the loop runs fully passwordless as the user.
  - `sudo ./install.sh --root` — system-wide alternative.
- Skills use `elevated=True` on privileged commands → `sudo -n` prefix when not root; the privilege gate (`can_elevate`) checks `sudo -n true` once and caches.
- Ubuntu 24.04 has no `dhclient` by default — s05's nmcli reapply path is primary; dhclient path degrades gracefully (optional `isc-dhcp-client`).

## Verification evidence (this build)

- `python3 -m unittest discover -s tests` → **52/52 pass** (mocked; hermetic) — includes regression tests for every verifier defect fixed (D1–D8) and user-mode elevation (sudo-prefix, can_elevate probe, skip-without-grant).
- **Independent verifier pass**: full adversarial review → PASS-WITH-DEFECTS (3 MAJOR, 10 minor). All MAJORs fixed and regression-tested: D1 budget overshoot (now Ctx-enforced), D2 resolv.conf symlink write (now resolvectl-first + symlink refusal), D3 config precedence (explicit --config authoritative). Also fixed: D4 fallback-model retry, D5 Marauder whitelist now enforced, D6 watchdog backoff after repeated failures, D8 bounded DNS probes, D10 s07 evidence bug, D12 honest dry-run rc. D7 (state durability) mitigated with state_path fallback; D9/D11/D13 documented NITs.
## Live outage drill (2026-09-05, John supervising)

- **Attempt 1 (19:20)**: FAILED — drill script's launch was killed by the CLI harness (backgrounded with `&`), and the safety-net trap could not run `nmcli connection up` (not in the live sudoers grant). Watchdog DID engage, but a snapshot bug (`_sh` output-as-truth made `gw_ping` read "up" on every ping failure) steered every hint to s06-dns; the model dutifully repeated a failing skill 5×/run until the mutation budget cut in. Manual restore at 19:47.
- **Fixes shipped**: snapshot `gw_ping` now boolean returncode (`_sh_ok`); anti-repeat escalation ladder in the dispatcher (any skill that ran without restoring connectivity is never retried — next ladder rung forced); model history now says "NEVER pick these again"; drill trap uses non-sudo `nmcli connection up`; `connection up` added to the sudoers template. 60/60 tests including three new drill regressions.
- **Attempt 2 (20:03, launched as a true detached background session)**: **PASSED.** Outage 20:03:09 → watchdog engaged → hint correctly read "interface down, networks visible" → s02 profile-up (45s NM timeout) → **escalation forced s03** → rescan+connect `netis` → s12 verified → **ONLINE after 2 cycles, ~170s total**. All 10 bots active throughout the recovery. Katra episodic event stored and distilled into a semantic procedure ("s03 after 2 cycles resolves a disconnect/reconnect event").
- Remaining: none blocking — optional ESP32 Marauder hardware; 91D2F8 router admin creds unknown (left empty; reachability check needs none).

## Known gaps / next

1. Install as root (`install.sh`) + provision `config.json` from Katra vault (capability or manual).
2. Live outage drill on a maintenance window.
3. Optional ESP32 Marauder hardware for s11.
4. Katra cron offline-gate (§6.3 of the plan doc).
