# net-agent — offline reconnect toolbox for thebrick

When thebrick loses internet, the local LLM (Ollama, Vulkan iGPU) does exactly
one job: pick repair skills from this pre-built, pre-tested toolbox. The loop
keeps running until connectivity returns. The wake ritual engages it too.

## Layout

```
skills/           s01–s13 deterministic skills (stdlib-only Python)
dispatcher/       snapshot, verify, ollama client, dispatch loop
watchdog/         net-watchdog.{sh,service,timer}, wake-check.sh
tests/            unit + loop + catalog + real-model routing tests
config.example.json   copy to /etc/net-agent/config.json (root-only)
install.sh        root install: config, systemd units, vault provisioning
docs/contract.md  F1–F8 contract (loop-director)
```

## Quick start (no root)

```bash
cd ~/Katra-Agentic-Memory/integrations/offline-reconnect
python3 -m unittest discover -s tests -q        # 39 hermetic tests
python3 dispatcher/dispatch.py --verify-only    # ONLINE/OFFLINE verdict (read-only)
python3 dispatcher/dispatch.py --snapshot-only  # diagnostic snapshot (read-only)
python3 tests/model_selection_live.py           # real-model routing (5 scenarios, ~12 s)
bash watchdog/wake-check.sh                     # wake-ritual step
python3 dispatcher/dispatch.py --dry-run        # full loop, mutations skipped
```

## Install

Katra/docker needs no sudo on thebrick (native docker engine, johnpellew is
in the `docker` group — colima is NOT installed). The toolbox's host-network
commands (rfkill, systemctl, resolvectl, modprobe) live outside docker and
need root — granted once, then everything runs passwordless as your user:

```bash
cd ~/Katra-Agentic-Memory/integrations/offline-reconnect
./install.sh --user                     # toolbox + user watchdog units (no sudo)
sudo ./install.sh --grant-user $USER    # ONE-TIME NOPASSWD allowlist (visudo-checked)
```

Alternative: `sudo ./install.sh --root` for a system-wide root install.
Config lives at `~/.config/net-agent/config.json` (mode 600) — fill in the
router credentials (vault-seeded). Recommended extra package:
`sudo apt-get install isc-dhcp-client` — gives s05 an independent DHCP
fallback (NM-unmanage → dhclient → re-manage) for when NetworkManager's own
DHCP is wedged. `python3-serial` (for s11 Marauder) is already present.

## Model behavior contract

- The model has exactly one tool: `pick_skill(name, why)`.
- Only `s12_verify_online` (deterministic probes) may declare success.
- Exit codes: `0` online · `2` still offline (timer re-arms) · `3` STOP file.
- Kill switch: `touch ~/.config/net-agent/STOP` (user mode) or
  `sudo touch /etc/net-agent/STOP` (root mode).
- Logs/state: `~/.local/state/net-agent/` (user) or `/var/lib/net-agent/` (root).

## Safety

- Commands are hardcoded inside skills; model text never becomes a command.
- Mutating skills are capped (default 5/run); root-gated skills skip when
  unprivileged; every skill returns a structured envelope.
- `s11_marauder_survey` (ESP32) is passive-only; attack commands are not exposed.
