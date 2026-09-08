#!/usr/bin/env bash
# Append a console-attachment event to the run trace.
#
# x11vnc calls this on -afteraccept and -gone with RFB_* in the environment. It
# exists so that "a human was watching, and could drive" is a recorded fact
# rather than an invisible one: an interactive console is the one way an audit
# can be contaminated without the graph knowing, and a trace that cannot show it
# cannot be used to explain a finding afterwards.
#
# One short line, appended to a file opened O_APPEND. Writes under PIPE_BUF do
# not interleave, so this is safe alongside the fixture writing the same trace.
set -euo pipefail

event="${1:?event name is required}"
trace="${AXE_RUN_DIR:-}/trace.jsonl"

[[ -n "${AXE_RUN_DIR:-}" && -d "${AXE_RUN_DIR}" ]] || exit 0

printf '{"ts":"%s","runId":"%s","event":"%s","client":"%s","interactive":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
    "${AXE_RUN_ID:-unknown}" \
    "${event}" \
    "${RFB_CLIENT_IP:-unknown}" \
    "$([[ "${AXE_VNC_INTERACTIVE:-0}" == "1" ]] && echo true || echo false)" \
    >> "${trace}"
