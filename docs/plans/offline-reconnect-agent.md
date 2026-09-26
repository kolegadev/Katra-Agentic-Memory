# Plan: Offline Reconnect Agent for the workstation

**Author:** Satori · **Date:** 2026-09-05 · **Status:** RESEARCH + PLAN (not yet built)
**Requested by:** John — when the workstation loses internet, fall back to the local LLM already loaded on the box for exactly one task: get the machine reconnected to the router/WiFi and back to LLM inference. Use the `/loop` skill to keep retrying until success. Katra's vault already holds the router SSID/passwords. Investigate Flipper Zero / ESP32 Marauder-style WiFi capabilities to help find and connect to the local network.

---

## 1. Verified machine facts (checked on the workstation today)

| Fact | Value | Implication |
|---|---|---|
| Host | `the workstation`, workspace `/home/<user>` | agent runs here, no SSH hop |
| WiFi NIC | the WiFi interface, supports monitor mode, radio not blocked | host NIC can do passive scans; while offline there is no live connection to disrupt |
| Net stack | the standard Linux network stack (NetworkManager + wpa_supplicant + systemd-networkd); default route via the LAN gateway on the WiFi interface | `nmcli` is the control plane; saved NM connection profile already contains the PSK (root-only) |
| Local LLM | Ollama 0.31.1 serving `llama3.1:8b`, `qwen2.5-coder:7b`, `llama3.2:3b`, `mistral:7b`, `qwen2.5:7b`, + large agent models. **GPU: AMD Phoenix1 iGPU (RDNA3) via Vulkan (RADV)** — unit has `OLLAMA_VULKAN=1` + `OLLAMA_IGPU_ENABLE=1`, `vulkan/` runner present, `Vulkan0` KV/compute buffers confirmed in llama.cpp logs. Measured steady-state: `qwen2.5-coder:7b` **14.9 t/s gen / 183.6 t/s prompt**; `llama3.1:8b` **13.6 t/s gen / 69.8 t/s prompt**. Tool calls work (7b returns call JSON in `content`; `llama3.1:8b` supports native `tool_calls`). Cold model load adds ~30 s → keep ONE model resident during the loop | a 3–5 tool-call repair cycle ≈ 30–90 s GPU-bound; per John's direction the loop runs on Vulkan/GPU, not CPU |
| Katra vault | Holds the home-router credentials (two routers = two candidate networks) | credentials available offline (Katra is local Docker) |
| Vault auth | Secret reveal is gated by TOTP-backed vault sessions (`POST /api/v1/vault/session`) and/or approved capabilities | autonomous offline recovery needs a **pre-approved, narrow-scoped capability token**, or it must rely on the NM saved profile (see §5) |
| Tailscale | `tailscale0` exists | irrelevant for recovery (needs underlying connectivity) but a useful post-recovery sanity check |
| Cron | root crontab runs graphify compaction, RankPilot sessions, bridge guard every 5 min, etc. | these would fail/waste cycles offline → need an offline gate (§6.3) |

## 2. Prior art found in research

- **network-doctor** (`chrisspen/network-doctor`) — closest existing tool: systemd service that watches NM state + ping, then escalates: `rfkill unblock` → `nmcli connection up` → `nmcli device disconnect/connect` → optional USB device reset (driver hangs). Also ships `network-doctor-collect`, which dumps a full diagnostic report (NM, wpa_supplicant, `rfkill`, `dmesg`, kernel logs) — exactly the deterministic "state snapshot" an LLM needs. **We vendor/reimplement this ladder as Tier 1 rather than inventing one.**
- **ESP32 Marauder** (`justcallmekoko/ESP32Marauder`) — open-source ESP32 firmware; full **CLI over USB serial at 115200** (pyserial-scriptable, no Flipper needed): `scanall`, `list -a` (APs w/ RSSI/channel), `sniffbeacon`, `sniffprobe`, `select -f "contains <ssid>"`, `channel`, `stopscan`, `reboot`. Attack commands exist (deauth, beacon spam, Evil Portal) but are **irrelevant and legally out of scope** — our wrapper exposes only the passive scan/sniff subset.
- **Flipper Zero** adds nothing for this use case: its WiFi app is a front-end for an ESP32 devboard running Marauder. The open-source equivalent of that capability is a ~$5–10 ESP32 devboard flashed with Marauder.
- **Linux-native equivalents**: `iw dev <wifi-iface> scan` (managed-mode passive scan, no disruption), `airodump-ng`/`wifite2` (monitor mode), `bettercap` `wifi.recon` (can run its WiFi module on a *separate* interface while the main NIC stays managed — relevant if we add a $10 USB monitor-mode dongle).
- **LLM-driven NetOps**: Packt "Building AI Agents for Network Operations" (Ollama + validated CLI tool calls + RACE prompts) confirms the pattern: local Ollama + strict approved-tool list + evidence-grounded prompts.

## 3. Architecture — four tiers

```
[Internet down]
     │  systemd timer 30s: net-watchdog  (NM state + ping + HTTPS, 2 misses = trigger)
     ▼
Tier 0  DETECT ──► write /run/net-agent/trigger, start net-agent (oneshot, no overlap)
     ▼
Tier 1  DETERMINISTIC LADDER  (no LLM; network-doctor style, ~200 LOC)
        rfkill unblock → nmcli connection up <saved profile> → device disconnect/connect
        → restart wpa_supplicant → (optional USB reset)   · verify after each step
        ✔ fixed? log to Katra, done.    ✘ → Tier 2
     ▼
Tier 2  LLM REPAIR LOOP (the /loop part; local Ollama, offline)
        diag snapshot → LLM proposes ≤3 allowlisted actions → execute → independent
        verifier probes → loop, with per-attempt Katra episodic events + working memory
        so state survives restarts/compaction. Timer keeps re-arming ⇒ "until success".
     ▼
Tier 3  OUT-OF-BAND SCANNING (only when host radio can't scan or SSID not found)
        a) built-in phy0 in monitor mode (safe: we're offline, nothing to disrupt)
        b) optional $10 USB monitor-mode dongle (bettercap wifi.recon / airodump-ng)
        c) optional ESP32 Marauder via USB serial (scanall → list -a → sniffbeacon)
        Distinguishes "router off / SSID gone" from "host NIC wedged" — the LLM
        cannot fix an off router, so this evidence routes the loop to wait-and-notify.
```

## 4. The loop contract (loop-director mapping)

- **Contract (F1):** "Internet is restored" — defined operationally, not by the LLM: DNS resolves AND TCP:443 opens to two independent endpoints AND gateway responds to ARP/ICMP. Only the **independent verifier** (`net-verify`, a static script with zero LLM input) may flip SUCCESS/FAIL. The LLM can never self-declare success — that is the Generator/Verifier split the shadow-bot build already proved.
- **Generator:** `net-agent` (Python) = diag collector → Ollama on the Vulkan iGPU (`llama3.1:8b` native tool calls, `qwen2.5-coder:7b` fallback; handle both `tool_calls` and JSON-in-`content` formats, since that's what the 7b emits) → structured actions. One model stays loaded for the whole outage (cold-load is ~30 s; both models measure ~14 t/s generation on Vulkan).
- **Verifier:** `net-verify` runs out-of-process after every action batch. Its verdict alone decides loop exit or next cycle.
- **Persistence:** every cycle writes an episodic event (`event_type: net_recovery_attempt`) + a working-memory slot (`net-recovery-state`) in Katra (local, so offline-safe). A new cycle is seeded with the previous cycle's actions-and-results, so the loop is cumulative across restarts — this is the "keep working until success" property.
- **Backoff:** failed cycles back off 1→2→5 min (cap), timer re-triggers; on ANY positive connectivity moment the agent verifies and exits cleanly.

## 5. Katra vault integration

- **Happy path needs no vault:** the NM saved connection profile on the workstation already holds the WiFi PSK (root-only). `nmcli connection up` reuses it — the vast majority of outages are fixed without revealing any secret.
- **Vault is the fallback source of truth** when the profile is lost/corrupt, or to log into the router admin UI (the LAN gateway) to check WAN status:
  1. John pre-approves a **capability** (existing `/api/v1/vault/approvals` + `/capability/http` flow) for identity `net-agent` scoped to exactly the two router secrets, read-only.
  2. Token stored root-only at `/etc/net-agent/capability.json` (mode 600). Offline-safe: Katra is local Docker; retrieval is localhost HTTP.
  3. If the capability path can't be used yet, interim: John re-seals the two secrets into `/etc/net-agent/routers.json` (mode 600) with the same schema, and we swap to the capability once approved. Flag this in build.
- The agent never logs secret values; router admin passwords are used only inside `curl` bodies to the router, and redacted in Katra events.

## 6. Tool allowlist, safety, and scope-lock

**Scope-lock (John's constraint):** the offline LLM does exactly ONE task — reconnect. It does not run distillations, does not touch bots/docker/Katra config, has no general-purpose shell. Enforced structurally (allowlist in the runner), not by prompt.

**Read-only diagnostics** (always allowed): `ip addr/link/route`, `nmcli device/connection/status`, `iw dev ... scan`, `wpa_cli status`, `rfkill list`, `ping`/`curl` probes, `dmesg --ctime | tail`, `resolvectl status`, `journalctl -u NetworkManager/wpa_supplicant`, `dhclient -v` dry info, `arp -n`, `ethtool`/`iw phy info`.

**Mutations** (allowlisted, max N=3 per cycle, each logged to journald + Katra):
`rfkill unblock wifi`, `nmcli connection up|down|modify|reload`, `nmcli device disconnect|connect|wifi rescan|wifi connect <ssid> password <psk>`, `systemctl restart wpa_supplicant|NetworkManager` (net units only — hardcoded list, not user input), `dhclient -r && dhclient`, `ip link set <wifi-iface> up|down`, `iw dev <wifi-iface> set type monitor|managed`, `nmcli connection add` (re-create profile from vault), router-admin `curl` (login + WAN status page only), `reboot` as last resort after ≥6 failed cycles (configurable, default off).

**Explicitly blocked** (runner-level filter + prompt): deauth, beacon spam, Evil Portal, MAC changes, anything touching `/etc/NetworkManager` other than NM-managed profiles, any command matching `(sudo|apt|rm|dd|mkfs|shutdown|reboot(?! policy))` outside the allowlist, all filesystem writes outside `/run/net-agent`, `/var/log/net-agent`, NM-managed profile paths.

**Kill switch:** presence of `/etc/net-agent/STOP` (root-only) disables the whole subsystem immediately.

**Katra offline gate (§6.3):** cron jobs (graphify compaction, RankPilot sessions, weekly reflection) get a one-line `net-verify --quick || exit 0` prefix so they don't burn cycles or write garbage offline. Bridge guard (5-min) keeps running — it's local and harmless.

## 7. ESP32 Marauder component (optional hardware, P2)

- Hardware: any ESP32 devboard with USB (e.g. ESP32-S2/S3 mini, ~$5–10), flashed with `ESP32Marauder` (prebuilt bins available). Flipper Zero is NOT needed — the open-source capability is the devboard itself.
- Driver: `net-agent` includes a `marauder.py` module (pyserial, 115200, newline-delimited, 10 s command timeout): `scanall` → `list -a` → parse AP table (SSID/BSSID/RSSI/channel) → `select -f "contains <ssid-from-vault>"` → `sniffbeacon`/`sigmon` to confirm the router is beaconing and measure signal.
- Command filter: hardcoded whitelist of passive commands only (`help, channel, clearlist, stopscan, scanall, sniffbeacon, sniffprobe, sniffpmkid(listen only), sigmon, packetcount, list, select, reboot`). Attack family (`attack -t ...`, `evilportal`, `blespam`, `spoofat`) is not callable from the agent wrapper.
- Decision value: if `list -a` shows the vault SSIDs beaconing but the host NIC reports "no networks", the host radio/driver is the problem (→ driver reload path); if the SSIDs are absent on both host and ESP32, the router is down (→ wait-and-notify mode, nothing an agent can fix).
- Legal note: everything here is John's own network; passive scanning of your own SSIDs is fine. The attack features exist in Marauder but are deliberately not exposed.

## 8. Failure modes the design covers

| Symptom | Detection | Action path |
|---|---|---|
| Soft rfkill / NM glitch | `rfkill`, NM state | Tier 1 ladder |
| Saved profile corrupt/lost | `nmcli connection` missing | re-create from vault secrets (Tier 2) |
| DHCP lease lost | no v4 addr on the WiFi interface | `dhclient` renew / `nmcli up` |
| DNS dead but route OK | `net-verify` DNS stage fails, TCP to 1.1.1.1 IP works | `resolvectl` flush/reapply, try 1.1.1.1/8.8.8.8 directly |
| Router up but WAN down (ISP) | gateway+router admin reachable, HTTPS fails | **wait-and-notify**: loop throttles to 5-min retries, logs router WAN status, keeps monitoring (correct behavior — nothing local can fix upstream) |
| SSID hidden / band issue | `iw scan` vs vault SSID | explicit `nmcli wifi connect <ssid>` + try 2.4 GHz BSSID (ESP32 `list -a` gives channels) |
| Driver wedge | scans return empty, dmesg shows firmware errors | module reload (`modprobe -r/…` for the wlan driver only), USB reset if dongle |
| NIC can't scan at all | host scan empty vs ESP32 shows APs | Tier 3 routes to driver path; ESP32 keeps providing ground truth |
| Both routers listed | vault has 2 secrets | try each in turn (order configurable) |

## 9. Implementation phases (loop-director, contract-first)

Each phase = a contract doc in `docs/contracts/offline-reconnect/` + generator + **independent verifier** (the pattern John already approved for shadow-bots):

- **P0 (no purchases, ~half a day of build):** `net-watchdog.service/.timer`; `net-diag-collect`; `net-verify` (the contract); Tier 1 deterministic ladder (vendor `network-doctor` logic, ~200 LOC, root systemd unit); Katra episodic logging of every recovery. This alone fixes most outages with zero LLM.
- **P1 (the /loop core):** `net-agent` Python runner — allowlist engine, Ollama chat loop with tool schema, JSON-in-content parsing, per-cycle verifier, backoff, STOP kill-switch, `/etc/net-agent/capability.json` vault retrieval for profile re-creation, wait-and-notify mode, Katra working-memory slot so loops resume after restarts. F-gates: F1 verifier independence, F2 allowlist enforcement (verifier tries to escape it), F3 offline Ollama roundtrip (no internet during test — test with WiFi off), F4 Katra logging while offline, F5 backoff/no-runaway.
- **P2 (optional hardware):** ESP32 Marauder USB scanner + `marauder.py` module + `select -f` confirmation flow; optionally a $10 monitor-mode USB dongle with bettercap/airodump as a host-side alternative.
- **P3 (Katra hygiene):** offline gate on cron jobs (§6.3); optional Katra UI/log view of recovery attempts.

## 10. Open questions for John (non-blocking for P0/P1)

1. Buy an ESP32 devboard (~$5–10) for P2, or try the built-in phy0 monitor-mode path first?
2. OK to pre-approve a read-only vault capability for identity `net-agent` (2 router secrets only)? Interim fallback is a root-only `/etc/net-agent/routers.json` — which do you prefer?
3. Auto-reboot as last-resort action: enable (after N failed cycles) or leave manual?
4. Primary Ollama model for the loop: `llama3.1:8b` (native tool calls) — agree, or keep `qwen2.5-coder:7b` (faster prompt eval on Vulkan: 183 vs 70 t/s, similar 14 t/s generation)? Either way the loop pins one model resident so the GPU path isn't paying cold-load repeatedly.
