#!/usr/bin/env bash
# Bring up everything the fixture needs, then hand the container over to it.
#
# Order matters. The managed policy must be on disk before Chromium starts,
# because Chromium reads /etc/chromium/policies/managed once at launch and the
# extension copies it into storage on its first panel render. Xvfb must be up
# before the browser, because the fixture runs headful: the axe panel is a
# DevTools iframe, and without a real display its document measures 0x0 and every
# element inside it is unclickable.
#
# **Nothing here writes to stdout.** The container's stdout is the MCP stdio
# transport — the Python graph runs `docker run -i` and speaks JSON-RPC over it —
# so one stray log line corrupts the session before the first tool call. Every
# message below goes to stderr, which Docker keeps separate and which is where
# the run's own logs belong anyway.
set -euo pipefail

log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

: "${AXE_SERVER_URL:?AXE_SERVER_URL is not set}"
: "${AXE_TARGET_URL:?AXE_TARGET_URL is not set}"
: "${AXE_USER_EMAIL_ADDRESS:?AXE_USER_EMAIL_ADDRESS is not set}"
: "${AXE_USER_PASSWORD:?AXE_USER_PASSWORD is not set}"
: "${AXE_EXTENSION_DIR:=/opt/axe/extension}"
: "${DISPLAY:=:99}"
: "${AXE_SCREEN:=1920x1080x24}"
: "${AXE_NOVNC_PORT:=6080}"
: "${AXE_RUNS_DIR:=/opt/axe/runs}"
: "${AXE_RUN_ID:=$(date -u +%Y%m%dT%H%M%SZ)-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
: "${AXE_RUN_DIR:=${AXE_RUNS_DIR}/${AXE_RUN_ID}}"

export DISPLAY AXE_RUN_ID AXE_RUN_DIR

if [[ ! -f "${AXE_EXTENSION_DIR}/manifest.json" ]]; then
    log "FATAL  no extension at ${AXE_EXTENSION_DIR}"
    exit 1
fi

# The command is resolved before anything is brought up, so a missing fixture
# fails in a second rather than after a display, a policy and a VNC server.
if [[ "${1:-}" == "node" && "${2:-}" != -* && -n "${2:-}" && ! -f "/opt/axe/${2#/opt/axe/}" ]]; then
    log "FATAL  no such fixture entrypoint: $2"
    exit 1
fi

# --- run directory --------------------------------------------------------
# One directory per run, created before the fixture starts, because the first
# thing worth recording is what the fixture was made of. Bind-mount it to keep a
# run after the container exits: -v "$PWD/build/runs:/opt/axe/runs".
mkdir -p "${AXE_RUN_DIR}/provenance" "${AXE_RUN_DIR}/units" "${AXE_RUN_DIR}/ledger"
: > "${AXE_RUN_DIR}/trace.jsonl"
log "run     ${AXE_RUN_ID} -> ${AXE_RUN_DIR}"

# --- managed policy -------------------------------------------------------
# Written as root, owned by root, world-readable. The browser runs as pwuser and
# must not be able to rewrite its own policy.
if [[ "$(id -u)" -eq 0 ]]; then
    uv run --no-project --python python3 /opt/axe/docker/render-policy.py >&2
else
    log "WARN   running as $(id -un); leaving ${AXE_POLICY_FILE:-the policy file} as it is"
fi

children=()
cleanup() {
    local status=$?
    for pid in "${children[@]:-}"; do
        [[ -n "${pid}" ]] && kill "${pid}" 2>/dev/null || true
    done
    exit "${status}"
}
trap cleanup EXIT INT TERM

# --- display --------------------------------------------------------------
screen_number="${DISPLAY#:}"
rm -f "/tmp/.X11-unix/X${screen_number}" "/tmp/.X${screen_number}-lock"
Xvfb "${DISPLAY}" -screen 0 "${AXE_SCREEN}" -nolisten tcp -noreset >&2 &
children+=("$!")

for _ in $(seq 1 50); do
    if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
        break
    fi
    sleep 0.2
done
if ! xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
    log "FATAL  Xvfb did not come up on ${DISPLAY}"
    exit 1
fi
log "display ${DISPLAY} at ${AXE_SCREEN}"

# --- noVNC ----------------------------------------------------------------
# A run holds an authenticated axe DevTools session and a live browser, so the
# watch console is password-gated and view-only by default. No password, no
# console: the fixture still runs, humans just cannot watch it.
#
# Every attachment and disconnection is written to the run trace. An interactive
# console is the one channel through which a human can change what an audit saw
# without the graph observing it, so the trace records that the channel was open
# and that somebody used it.
if [[ -n "${AXE_VNC_PASSWORD:-}" ]]; then
    passwd_file=/home/pwuser/.axe/vncpasswd
    mkdir -p "$(dirname "${passwd_file}")"
    x11vnc -storepasswd "${AXE_VNC_PASSWORD}" "${passwd_file}" >/dev/null 2>&1
    chmod 600 "${passwd_file}"

    view_only=(-viewonly)
    if [[ "${AXE_VNC_INTERACTIVE:-0}" == "1" ]]; then
        view_only=()
        log "vnc     interactive: viewers can drive the browser"
    fi

    x11vnc -display "${DISPLAY}" -rfbauth "${passwd_file}" -localhost -rfbport 5900 \
        -forever -shared -noxdamage -quiet "${view_only[@]}" \
        -afteraccept "/opt/axe/docker/vnc-event.sh console_attached" \
        -gone "/opt/axe/docker/vnc-event.sh console_detached" >&2 &
    children+=("$!")

    websockify --web=/usr/share/novnc "0.0.0.0:${AXE_NOVNC_PORT}" 127.0.0.1:5900 \
        >/dev/null 2>&1 &
    children+=("$!")
    log "novnc   http://localhost:${AXE_NOVNC_PORT}/vnc.html"
else
    log "novnc   disabled (set AXE_VNC_PASSWORD to watch a run)"
fi

# --- provenance -----------------------------------------------------------
# After the policy is rendered, because the policy document is part of what
# replay has to restore; before the fixture, because a run that dies during
# start-up still has to be explainable.
uv run --no-project --python python3 /opt/axe/docker/record-provenance.py

# --- the fixture ----------------------------------------------------------
# The fixture owns the browser for the life of a run: it launches Chromium with
# the extension, mints and seeds the session, opens and holds the panel, scans,
# saves, runs keepalive, and then serves the MCP tool set over stdio. It is
# handed the extension path here so no caller has to know where the image put
# it; the target page, the server and the run directory arrive through the
# environment, which is the only channel a `docker run -i` caller has.
# The page state under audit is an argument, not an environment variable the
# server reads for itself. Without this the fixture silently audits its own
# bundled target instead of the URL the caller asked for — a wrong answer that
# looks like a right one, which is the worst shape of bug this project can have.
# Always headful. This container brings up Xvfb and noVNC so a human can watch
# a run, and a headless browser draws nothing on that display — the console is
# then a black screen that looks broken and is in fact empty. The server
# defaults to headless, so the display owner is the one that has to say so.
set -- "$@" "--extension=${AXE_EXTENSION_DIR}" "--url=${AXE_TARGET_URL}" "--headed"
if [[ -n "${AXE_TEST_NAME:-}" ]]; then
    set -- "$@" "--name=${AXE_TEST_NAME}"
fi

log "fixture $*"
if [[ "$(id -u)" -eq 0 ]]; then
    # The renderer sandbox needs a non-root uid regardless of how it is
    # configured, and dropping one costs nothing. setpriv leaves the environment
    # alone, so HOME is set here or the browser profile lands in /root and the
    # launch fails.
    chown -R pwuser:pwuser "${AXE_RUN_DIR}"
    exec setpriv --reuid=pwuser --regid=pwuser --init-groups --inh-caps=-all -- \
        env HOME=/home/pwuser "$@"
fi
exec "$@"
