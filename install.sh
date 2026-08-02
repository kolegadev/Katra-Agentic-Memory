#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  Katra — Cognitive Memory for AI Agents
#  install.sh — one-command installer
#
#  Remote (clones into ~/.katra/src):
#    curl -fsSL https://raw.githubusercontent.com/kolegadev/Katra-Agentic-Memory/main/install.sh | bash
#
#  From a clone (uses the checkout you're standing in):
#    ./install.sh
#
#  This script is non-interactive by design: it never prompts, so it
#  behaves identically when piped from curl, run in CI, or driven by an
#  agent. Everything is controlled by flags or environment variables.
#
#  It is idempotent. Re-running it against an existing install preserves
#  your .env and never rotates credentials that are already in use.
# ════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Configuration (all overridable by env) ─────────────────────────
KATRA_HOME="${KATRA_HOME:-$HOME/.katra}"
KATRA_REPO_URL="${KATRA_REPO_URL:-https://github.com/kolegadev/Katra-Agentic-Memory.git}"
KATRA_REF="${KATRA_REF:-main}"
KATRA_WITH_WATCHER="${KATRA_WITH_WATCHER:-0}"
KATRA_WITH_SYSTEMD="${KATRA_WITH_SYSTEMD:-0}"
KATRA_START="${KATRA_START:-1}"
KATRA_YES="${KATRA_YES:-0}"
ACTION="install"
PURGE=0

SRC_DIR=""
ENV_FILE=""

# ── Output helpers ────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
    C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""
fi

step()  { printf '%s\n%s==>%s %s%s\n' "" "$C_CYAN$C_BOLD" "$C_RESET" "$C_BOLD$*" "$C_RESET"; }
info()  { printf '    %s\n' "$*"; }
ok()    { printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()   { printf '\n%serror:%s %s\n' "$C_RED$C_BOLD" "$C_RESET" "$*" >&2; exit 1; }

usage() {
    cat <<'EOF'
Katra installer

Usage:
  install.sh [options]
  curl -fsSL <raw-url>/install.sh | bash -s -- [options]

Options:
  --with-watcher      Also install the host-side session watcher
  --with-systemd      Install the boot unit so Katra starts on reboot (needs sudo)
  --no-start          Write config and prepare, but do not start containers
  --dir PATH          Where to clone/find the source (default: ~/.katra/src)
  --ref REF           Git tag, branch or SHA to install (default: main)
  --rebuild           Rebuild and recreate the server container only, then verify
  --uninstall         Stop the stack and remove units, config and watcher
  --purge             With --uninstall, also delete the data directory
  --yes               Confirm destructive operations (required for --purge)
  -h, --help          Show this help

Environment equivalents:
  KATRA_HOME, KATRA_REF, KATRA_REPO_URL, KATRA_WITH_WATCHER=1,
  KATRA_WITH_SYSTEMD=1, KATRA_START=0, KATRA_YES=1

Notes:
  This installer never prompts and never rotates existing credentials.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --with-watcher) KATRA_WITH_WATCHER=1 ;;
        --with-systemd) KATRA_WITH_SYSTEMD=1 ;;
        --no-start)     KATRA_START=0 ;;
        --dir)          shift; [ $# -gt 0 ] || die "--dir needs a path"; SRC_DIR="$1" ;;
        --ref)          shift; [ $# -gt 0 ] || die "--ref needs a value"; KATRA_REF="$1" ;;
        --rebuild)      ACTION="rebuild" ;;
        --uninstall)    ACTION="uninstall" ;;
        --purge)        PURGE=1 ;;
        --yes|-y)       KATRA_YES=1 ;;
        -h|--help)      usage; exit 0 ;;
        *)              die "unknown option: $1 (try --help)" ;;
    esac
    shift
done

# ── Preflight ─────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

preflight() {
    step "Checking prerequisites"

    local os; os="$(uname -s)"
    case "$os" in
        Linux|Darwin) ok "platform: $os" ;;
        *) die "unsupported platform: $os (Linux, macOS and WSL are supported)" ;;
    esac

    if ! have docker; then
        printf '\n' >&2
        case "$os" in
            Darwin) warn "Docker is required. Install Docker Desktop: https://docs.docker.com/desktop/install/mac-install/" ;;
            *)      warn "Docker is required. Install it with: curl -fsSL https://get.docker.com | sh" ;;
        esac
        die "docker not found"
    fi

    if ! docker compose version >/dev/null 2>&1; then
        die "Docker Compose v2 not found. 'docker compose version' failed — you may have the old standalone docker-compose."
    fi

    # Nothing in --no-start touches Docker, so a stopped daemon is not fatal
    # there. This is what makes the script testable on machines (and CI
    # runners) that have the client but no running daemon.
    if ! docker info >/dev/null 2>&1; then
        local daemon_hint
        case "$os" in
            Darwin) daemon_hint="Start Docker Desktop and try again." ;;
            *)      daemon_hint="Start it with: sudo systemctl start docker — or if it is running, add yourself to the 'docker' group: sudo usermod -aG docker \$USER (then log out and back in)." ;;
        esac
        if [ "$KATRA_START" = 1 ]; then
            die "the Docker daemon is not reachable. $daemon_hint"
        fi
        warn "the Docker daemon is not reachable, but --no-start does not need it — continuing. $daemon_hint"
        ok "docker client $(docker version --format '{{.Client.Version}}' 2>/dev/null || echo '?'), compose $(docker compose version --short 2>/dev/null || echo '?')"
    else
        ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'), compose $(docker compose version --short 2>/dev/null || echo '?')"
    fi

    have git || die "git not found — install git and re-run"
    ok "git present"
}

# Report whether a TCP port is already bound on the host.
port_busy() {
    local port="$1"
    if have ss; then
        ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$port\$"
    elif have lsof; then
        lsof -iTCP:"$port" -sTCP:LISTEN -n >/dev/null 2>&1
    else
        return 1   # cannot tell; let Docker report the conflict
    fi
}

check_ports() {
    local mcp="$1" api="$2" busy=0
    for p in "$mcp" "$api"; do
        if port_busy "$p"; then
            # Our own already-running stack is not a conflict.
            if docker compose ps --format '{{.Publishers}}' 2>/dev/null | grep -q ":$p->"; then
                info "port $p is bound by this Katra install (fine)"
            else
                warn "port $p is already in use by something else"
                busy=1
            fi
        fi
    done
    if [ "$busy" = 1 ]; then
        warn "set HOST_MCP_PORT / HOST_API_PORT in $ENV_FILE to free ports, then re-run"
    fi
}

# ── Source acquisition ────────────────────────────────────────────
# Returns the directory this script lives in, or fails when piped.
script_dir() {
    local s="${BASH_SOURCE[0]:-}"
    [ -n "$s" ] && [ -f "$s" ] || return 1
    (cd "$(dirname "$s")" && pwd)
}

is_katra_checkout() {
    [ -f "$1/docker-compose.yml" ] && [ -f "$1/Dockerfile" ] && [ -d "$1/server" ]
}

acquire_source() {
    step "Locating Katra source"

    # Explicit --dir wins.
    if [ -n "$SRC_DIR" ]; then
        if is_katra_checkout "$SRC_DIR"; then
            SRC_DIR="$(cd "$SRC_DIR" && pwd)"
            ok "using existing checkout: $SRC_DIR"
            return
        fi
        info "will clone into $SRC_DIR"
    else
        # Running from inside a clone? Use it — don't clone over the top.
        local here
        if here="$(script_dir)" && is_katra_checkout "$here"; then
            SRC_DIR="$here"
            ok "running inside a checkout: $SRC_DIR"
            return
        fi
        SRC_DIR="$KATRA_HOME/src"
    fi

    if is_katra_checkout "$SRC_DIR"; then
        SRC_DIR="$(cd "$SRC_DIR" && pwd)"
        ok "using existing checkout: $SRC_DIR"
        info "leaving it at its current revision — run 'git -C $SRC_DIR pull' to update"
        return
    fi

    mkdir -p "$(dirname "$SRC_DIR")"
    info "cloning $KATRA_REPO_URL @ $KATRA_REF"
    git clone --depth 1 --branch "$KATRA_REF" "$KATRA_REPO_URL" "$SRC_DIR" 2>&1 | sed 's/^/    /' \
        || die "clone failed (is '$KATRA_REF' a valid tag, branch or SHA?)"
    SRC_DIR="$(cd "$SRC_DIR" && pwd)"
    ok "cloned to $SRC_DIR"
}

# ── Secrets ───────────────────────────────────────────────────────
gen_secret() {
    local bytes="${1:-24}"
    if have openssl; then
        openssl rand -hex "$bytes"
    elif [ -r /dev/urandom ]; then
        LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c $((bytes * 2))
    elif have python3; then
        python3 -c "import secrets,sys; sys.stdout.write(secrets.token_hex($bytes))"
    else
        die "no source of randomness found (need openssl, /dev/urandom or python3)"
    fi
}

# Read a key from .env, matching how Docker Compose parses the file:
# an unquoted value ends at the first whitespace-preceded '#', and
# surrounding quotes are stripped.
env_get() {
    [ -f "$ENV_FILE" ] || return 1
    local line value
    line="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1)" || return 1
    [ -n "$line" ] || return 1
    value="${line#*=}"
    case "$value" in
        \"*\") value="${value#\"}"; value="${value%\"}" ;;
        \'*\') value="${value#\'}"; value="${value%\'}" ;;
        *)
            # Strip an inline comment, then trailing whitespace.
            value="$(printf '%s' "$value" | sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//')"
            ;;
    esac
    [ -n "$value" ] || return 1
    printf '%s' "$value"
}

# Set a key in .env, replacing an existing (even commented) definition.
env_set() {
    local key="$1" value="$2" tmp
    # Explicit template: bare `mktemp` is not portable to BSD/macOS.
    tmp="$(mktemp "${TMPDIR:-/tmp}/katra-env.XXXXXX")"
    if [ -f "$ENV_FILE" ] && grep -qE "^#?$key=" "$ENV_FILE"; then
        # Use awk so special characters in the value need no escaping.
        awk -v k="$key" -v v="$value" '
            !done && ($0 ~ "^#?" k "=") { print k "=" v; done=1; next }
            { print }
        ' "$ENV_FILE" > "$tmp"
    else
        [ -f "$ENV_FILE" ] && cat "$ENV_FILE" > "$tmp"
        printf '%s=%s\n' "$key" "$value" >> "$tmp"
    fi
    cat "$tmp" > "$ENV_FILE"
    rm -f "$tmp"
}

is_placeholder() {
    case "$1" in
        ""|change-me|your-*|*-here) return 0 ;;
        *) return 1 ;;
    esac
}

configure_env() {
    step "Configuring environment"
    ENV_FILE="$SRC_DIR/.env"

    if [ -f "$ENV_FILE" ]; then
        ok "existing .env found — keeping your settings"
        audit_existing_secrets
        return
    fi

    [ -f "$SRC_DIR/.env.example" ] || die "$SRC_DIR/.env.example is missing"
    cat "$SRC_DIR/.env.example" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "created .env from .env.example (mode 600)"

    # Mongo: the password appears twice — as MONGO_PASS and inline in
    # MONGODB_URI. Setting only one of them breaks authentication.
    local mongo_user mongo_pass db
    mongo_user="$(env_get MONGO_USER || echo admin)"
    is_placeholder "$mongo_user" && mongo_user="admin"
    mongo_pass="$(gen_secret 24)"
    db="$(env_get DATABASE_NAME || echo katra)"
    is_placeholder "$db" && db="katra"
    env_set MONGO_USER "$mongo_user"
    env_set MONGO_PASS "$mongo_pass"
    env_set MONGODB_URI "mongodb://${mongo_user}:${mongo_pass}@mongo:27017/${db}?authSource=admin&retryWrites=true&w=majority"
    ok "generated MongoDB credentials (MONGO_PASS and MONGODB_URI kept in sync)"

    # MinIO: the server authenticates with the same pair it was seeded
    # with, so MINIO_USER/MINIO_PASS and the AWS_* keys must match.
    # MinIO requires a user of 3+ chars and a password of 8+ chars.
    local minio_user minio_pass
    minio_user="katra-$(gen_secret 4)"
    minio_pass="$(gen_secret 24)"
    env_set MINIO_USER "$minio_user"
    env_set MINIO_PASS "$minio_pass"
    env_set AWS_ACCESS_KEY_ID "$minio_user"
    env_set AWS_SECRET_ACCESS_KEY "$minio_pass"
    ok "generated MinIO credentials (MINIO_* and AWS_* kept in sync)"

    # API keys. .env.example ships these commented out so the server
    # self-generates on first boot; we set them explicitly instead so the
    # values are knowable now and printable at the end.
    env_set MCP_API_KEY "$(gen_secret 32)"
    env_set KATRA_API_KEY "$(gen_secret 32)"
    ok "generated MCP_API_KEY and KATRA_API_KEY"
}

# Warn — never silently rewrite — when an existing install is on defaults.
audit_existing_secrets() {
    local found=0 k v
    for k in MONGO_PASS MINIO_USER MINIO_PASS AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
        v="$(env_get "$k" || true)"
        if [ "$v" = "change-me" ]; then
            warn "$k is still the insecure default 'change-me'"
            found=1
        fi
    done
    if [ "$found" = 1 ]; then
        warn ""
        warn "This installer will NOT rotate them. MongoDB stores its users inside"
        warn "the database, so editing MONGO_PASS in .env does not change the"
        warn "password — it just locks the server out. MinIO re-reads its root"
        warn "credentials on every start, so that pair is safer to change."
        warn "For the correct procedure for each, see:"
        warn "  docs/DEPLOYMENT.md → 'Rotating credentials'"
    fi
}

# ── Bring the stack up ────────────────────────────────────────────
compose() { docker compose --project-directory "$SRC_DIR" "$@"; }

start_stack() {
    local mcp_port api_port
    mcp_port="$(env_get HOST_MCP_PORT || echo 3112)"
    api_port="$(env_get HOST_API_PORT || echo 9012)"

    check_ports "$mcp_port" "$api_port"

    step "Building and starting Katra"
    info "first run pulls ~2GB of images and builds the server — this takes a few minutes"
    # --wait blocks until healthchecks pass and exits non-zero if they do not.
    compose up -d --build --wait 2>&1 | sed 's/^/    /' \
        || die "the stack failed to come up healthy. Inspect it with: docker compose --project-directory $SRC_DIR logs --tail 50"
    ok "containers are up and healthy"
}

verify() {
    # Deliberately probes the REST endpoint on the API port, not /health on
    # the MCP port. This is the same URL the container's own HEALTHCHECK uses,
    # it needs no auth, and it is the path that is known good on older
    # revisions — /health on the MCP port crashed the process before the fix
    # in server/src/mcp-server.ts, so an installer must not be the thing that
    # triggers it.
    local api_port; api_port="$(env_get HOST_API_PORT || echo 9012)"
    step "Verifying"

    local body=""
    if have curl; then
        for _ in $(seq 1 30); do
            if body="$(curl -fsS -m 5 "http://localhost:${api_port}/api/v1/health" 2>/dev/null)"; then
                break
            fi
            sleep 2
        done
    fi

    if [ -z "$body" ]; then
        # The container healthcheck is authoritative; a failed curl here can
        # just mean a sandboxed or restricted shell.
        if [ "$(docker inspect --format '{{.State.Health.Status}}' katra-server 2>/dev/null || echo unknown)" = "healthy" ]; then
            warn "could not reach the health endpoint from this shell, but the container reports healthy"
            return 0
        fi
        die "health check failed. Logs: docker compose --project-directory $SRC_DIR logs --tail 50 server"
    fi

    # A restart count above zero means the server has been crash-looping even
    # though it currently answers. Worth surfacing at install time.
    local restarts
    restarts="$(docker inspect --format '{{.RestartCount}}' katra-server 2>/dev/null || echo 0)"
    if [ "${restarts:-0}" -gt 0 ] 2>/dev/null; then
        warn "the server container has restarted $restarts time(s) — check: docker logs katra-server 2>&1 | grep -iE 'error|exception'"
    fi

    ok "health endpoint responding"
    if have python3; then
        python3 - "$body" <<'PY' 2>/dev/null || true
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
svc = d.get("services", {})
for name in ("mongodb", "redis", "llm", "embeddings"):
    if name in svc:
        print(f"    • {name}: {svc[name]}")
mi = d.get("memory_integrity") or {}
if "episodic_events" in mi:
    print(f"    • episodic events: {mi['episodic_events'].get('total', '?')}")
if "semantic_facts" in mi:
    print(f"    • semantic facts: {mi['semantic_facts'].get('total', '?')}")
PY
    fi
}

# ── Boot unit ─────────────────────────────────────────────────────
install_systemd() {
    [ "$(uname -s)" = "Linux" ] || { warn "--with-systemd is Linux-only; skipping on $(uname -s)"; return 0; }
    have systemctl || { warn "systemctl not found (WSL without systemd?); skipping boot unit"; return 0; }

    local template="$SRC_DIR/katra.service.template"
    [ -f "$template" ] || { warn "$template not found; skipping boot unit"; return 0; }

    step "Installing boot unit"

    local sudo_cmd=""
    if [ "$(id -u)" != 0 ]; then
        have sudo || { warn "need root or sudo to install to /etc/systemd/system; skipping"; return 0; }
        sudo_cmd="sudo"
        info "this needs sudo to write /etc/systemd/system/katra.service"
    fi

    # Prefer SUDO_USER: if someone runs the whole installer under sudo,
    # `id -un` is root, and the unit would be written with User=root while
    # the compose project and data directory belong to the real user.
    local unit_user="${SUDO_USER:-$(id -un)}"

    local rendered; rendered="$(mktemp "${TMPDIR:-/tmp}/katra-unit.XXXXXX")"
    sed -e "s|__KATRA_DIR__|$SRC_DIR|g" \
        -e "s|__KATRA_USER__|$unit_user|g" \
        -e "s|__DOCKER_BIN__|$(command -v docker)|g" \
        "$template" > "$rendered"

    $sudo_cmd install -m 644 "$rendered" /etc/systemd/system/katra.service
    rm -f "$rendered"
    $sudo_cmd systemctl daemon-reload
    $sudo_cmd systemctl enable katra.service >/dev/null 2>&1 || warn "could not enable katra.service"
    ok "katra.service installed for user $unit_user at $SRC_DIR"
    info "it starts the stack at boot; the containers' own restart policy keeps them running"
}

# ── Watcher ───────────────────────────────────────────────────────
install_watcher() {
    step "Installing session watcher"

    have python3 || { warn "python3 not found — skipping watcher (the server is unaffected)"; return 0; }

    local wsrc="$SRC_DIR/watcher"
    [ -d "$wsrc" ] || { warn "$wsrc not found; skipping watcher"; return 0; }

    mkdir -p "$KATRA_HOME"
    local f
    for f in katra_watcher.py katra_opencode_extractor.py claude_history_extractor.py kolega_code_extractor.py; do
        if [ -f "$wsrc/$f" ]; then
            install -m 644 "$wsrc/$f" "$KATRA_HOME/$f"
        else
            warn "$f missing from $wsrc"
        fi
    done
    ok "extractors installed to $KATRA_HOME"

    # Config: generate once, then leave alone.
    local cfg="$KATRA_HOME/watcher-config.json"
    local mcp_port api_key
    mcp_port="$(env_get HOST_MCP_PORT || echo 3112)"
    api_key="$(env_get MCP_API_KEY || true)"
    [ -n "$api_key" ] || api_key="$(env_get KATRA_API_KEY || true)"

    if [ -f "$cfg" ]; then
        ok "watcher-config.json already exists — keeping it"
    elif [ -f "$wsrc/watcher-config.example.json" ] && have python3; then
        python3 - "$wsrc/watcher-config.example.json" "$cfg" "$mcp_port" "$api_key" <<'PY'
import json, sys
src, dst, port, key = sys.argv[1:5]
with open(src) as fh:
    cfg = json.load(fh)
cfg["mcp_url"] = f"http://localhost:{port}/mcp"
if key:
    cfg["api_key"] = key
with open(dst, "w") as fh:
    json.dump(cfg, fh, indent=2)
    fh.write("\n")
PY
        chmod 600 "$cfg"
        ok "wrote watcher-config.json (mcp_url and api_key filled in)"
    else
        warn "could not generate watcher-config.json; copy watcher-config.example.json manually"
        return 0
    fi

    # Backfill existing history once, so memory is not empty on day one.
    info "backfilling existing session history (this can take a few minutes)"
    if python3 "$KATRA_HOME/katra_watcher.py" --once --config "$cfg" >"$KATRA_HOME/backfill.log" 2>&1; then
        ok "backfill complete"
    else
        warn "backfill exited non-zero — see $KATRA_HOME/backfill.log"
    fi

    case "$(uname -s)" in
        Linux)  install_watcher_systemd ;;
        Darwin) install_watcher_launchd ;;
    esac
}

install_watcher_systemd() {
    have systemctl || { warn "systemctl not found; watcher installed but not scheduled"; return 0; }
    local template="$SRC_DIR/watcher/katra-watcher.service.template"
    [ -f "$template" ] || { warn "watcher unit template missing; watcher installed but not scheduled"; return 0; }

    local dest="$HOME/.config/systemd/user"
    mkdir -p "$dest"
    sed -e "s|__PYTHON__|$(command -v python3)|g" \
        -e "s|__KATRA_HOME__|$KATRA_HOME|g" \
        "$template" > "$dest/katra-watcher.service"

    systemctl --user daemon-reload 2>/dev/null || { warn "systemctl --user unavailable (no user session bus?)"; return 0; }
    systemctl --user enable --now katra-watcher.service 2>/dev/null \
        && ok "katra-watcher.service running as a user unit" \
        || warn "could not enable katra-watcher.service — start it with: systemctl --user enable --now katra-watcher"
    info "to keep it running when logged out: sudo loginctl enable-linger $(id -un)"
}

install_watcher_launchd() {
    local template="$SRC_DIR/watcher/com.katra.watcher.plist.template"
    [ -f "$template" ] || { warn "launchd plist template missing; watcher installed but not scheduled"; return 0; }

    local dest="$HOME/Library/LaunchAgents"
    mkdir -p "$dest"
    sed -e "s|__PYTHON__|$(command -v python3)|g" \
        -e "s|__KATRA_HOME__|$KATRA_HOME|g" \
        "$template" > "$dest/com.katra.watcher.plist"

    launchctl unload "$dest/com.katra.watcher.plist" 2>/dev/null || true
    launchctl load -w "$dest/com.katra.watcher.plist" 2>/dev/null \
        && ok "com.katra.watcher loaded via launchd" \
        || warn "could not load the launch agent — try: launchctl load -w $dest/com.katra.watcher.plist"
}

# ── Rebuild ───────────────────────────────────────────────────────
do_rebuild() {
    acquire_source
    ENV_FILE="$SRC_DIR/.env"
    [ -f "$ENV_FILE" ] || die "no .env at $ENV_FILE — run the installer without --rebuild first"

    step "Rebuilding the server image"
    if [ -d "$SRC_DIR/.git" ]; then
        info "revision: $(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    fi
    compose build server 2>&1 | sed 's/^/    /' || die "build failed"
    ok "image built"

    step "Recreating the server container"
    compose up -d --force-recreate --wait server 2>&1 | sed 's/^/    /' \
        || die "server did not come back healthy. Logs: docker compose --project-directory $SRC_DIR logs --tail 50 server"
    ok "server recreated"

    verify
    printf '\n%sRebuild complete.%s\n\n' "$C_GREEN$C_BOLD" "$C_RESET"
}

# ── Uninstall ─────────────────────────────────────────────────────
do_uninstall() {
    if [ "$PURGE" = 1 ] && [ "$KATRA_YES" != 1 ]; then
        die "--purge deletes your memory database permanently. Re-run with --yes to confirm."
    fi

    acquire_source
    ENV_FILE="$SRC_DIR/.env"

    step "Stopping the stack"
    compose down 2>&1 | sed 's/^/    /' || warn "docker compose down reported an error"
    ok "containers stopped"

    step "Removing units"
    if have systemctl; then
        systemctl --user disable --now katra-watcher.service 2>/dev/null || true
        rm -f "$HOME/.config/systemd/user/katra-watcher.service"
        systemctl --user daemon-reload 2>/dev/null || true
        if [ -f /etc/systemd/system/katra.service ]; then
            local sudo_cmd=""; [ "$(id -u)" != 0 ] && have sudo && sudo_cmd="sudo"
            $sudo_cmd systemctl disable --now katra.service 2>/dev/null || true
            $sudo_cmd rm -f /etc/systemd/system/katra.service
            $sudo_cmd systemctl daemon-reload 2>/dev/null || true
        fi
    fi
    if [ "$(uname -s)" = "Darwin" ] && [ -f "$HOME/Library/LaunchAgents/com.katra.watcher.plist" ]; then
        launchctl unload "$HOME/Library/LaunchAgents/com.katra.watcher.plist" 2>/dev/null || true
        rm -f "$HOME/Library/LaunchAgents/com.katra.watcher.plist"
    fi
    ok "units removed"

    step "Removing watcher files"
    rm -f "$KATRA_HOME"/katra_watcher.py "$KATRA_HOME"/katra_opencode_extractor.py \
          "$KATRA_HOME"/claude_history_extractor.py "$KATRA_HOME"/kolega_code_extractor.py \
          "$KATRA_HOME"/watcher-config.json "$KATRA_HOME"/watcher-state.json "$KATRA_HOME"/backfill.log
    ok "watcher files removed from $KATRA_HOME"

    if [ "$PURGE" = 1 ]; then
        local data_dir; data_dir="$(env_get DATA_DIR 2>/dev/null || echo ./data)"
        case "$data_dir" in
            /*) : ;;
            *)  data_dir="$SRC_DIR/${data_dir#./}" ;;
        esac
        step "Purging data"
        if [ -d "$data_dir" ]; then
            rm -rf "$data_dir" 2>/dev/null || { warn "some data needed root to remove; retrying with sudo"; have sudo && sudo rm -rf "$data_dir"; }
            ok "deleted $data_dir"
        else
            info "no data directory at $data_dir"
        fi
    else
        info "your data was left in place — add --purge --yes to delete it"
    fi

    printf '\n%sKatra removed.%s The source checkout at %s was left alone.\n\n' "$C_BOLD" "$C_RESET" "$SRC_DIR"
}

# ── Final report ──────────────────────────────────────────────────
print_next_steps() {
    local mcp_port api_port mcp_key
    mcp_port="$(env_get HOST_MCP_PORT || echo 3112)"
    api_port="$(env_get HOST_API_PORT || echo 9012)"
    mcp_key="$(env_get MCP_API_KEY || true)"
    [ -n "$mcp_key" ] || mcp_key="<see: docker compose logs server | grep -i 'api key'>"

    cat <<EOF

${C_GREEN}${C_BOLD}Katra is installed.${C_RESET}

  ${C_BOLD}Endpoints${C_RESET}
    MCP         http://localhost:${mcp_port}/mcp
    REST API    http://localhost:${api_port}
    Dashboard   http://localhost:${api_port}/dashboard/
    Health      http://localhost:${mcp_port}/health

  ${C_BOLD}Connect Claude Code${C_RESET}
    claude mcp add katra --transport http http://localhost:${mcp_port}/mcp \\
      --header "Authorization: Bearer ${mcp_key}"

  ${C_BOLD}Connect anything else${C_RESET} (mcp.json / mcpServers config)
    {
      "katra": {
        "type": "http",
        "url": "http://localhost:${mcp_port}/mcp",
        "headers": { "Authorization": "Bearer ${mcp_key}" }
      }
    }

  ${C_BOLD}Manage${C_RESET}
    Logs        docker compose --project-directory ${SRC_DIR} logs -f server
    Rebuild     ${SRC_DIR}/install.sh --rebuild
    Stop        docker compose --project-directory ${SRC_DIR} down
    Remove      ${SRC_DIR}/install.sh --uninstall

  ${C_DIM}Credentials are in ${ENV_FILE} (mode 600). Keep it out of version control.${C_RESET}

EOF

    if [ "$KATRA_WITH_WATCHER" != 1 ]; then
        printf '  %sNo watcher installed.%s Your agent can store memories over MCP, but past\n' "$C_BOLD" "$C_RESET"
        printf '  session history will not be ingested. Add it with: %s --with-watcher\n\n' "$SRC_DIR/install.sh"
    fi
}

# ── Main ──────────────────────────────────────────────────────────
main() {
    printf '%s\n  Katra — Cognitive Memory for AI Agents%s\n' "$C_BOLD" "$C_RESET"

    case "$ACTION" in
        uninstall) preflight; do_uninstall; return ;;
        rebuild)   preflight; do_rebuild;   return ;;
    esac

    preflight
    acquire_source
    configure_env

    if [ "$KATRA_START" = 1 ]; then
        start_stack
        verify
    else
        step "Skipping start (--no-start)"
        info "start it later with: docker compose --project-directory $SRC_DIR up -d --build"
    fi

    [ "$KATRA_WITH_SYSTEMD" = 1 ] && install_systemd
    [ "$KATRA_WITH_WATCHER" = 1 ] && install_watcher

    print_next_steps
}

main
