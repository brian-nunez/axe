#!/usr/bin/env bash
# Re-run a fixture from a recorded run's provenance.
#
# The fixture's whole claim is reproducible failure: a four-hour run that breaks
# at hour three replays from an identical starting state instead of re-deriving
# its own. That claim is only worth anything if replaying is a command somebody
# can type, so this is it.
#
#   docker/replay.sh build/runs/<run-id>            # replay the whole run
#   docker/replay.sh build/runs/<run-id> --unit manual:12
#   docker/replay.sh build/runs/<run-id> --check    # verify drift, launch nothing
#   docker/replay.sh build/runs/<run-id> --print    # show the command, run nothing
#
# It restores the fixture inputs, refuses to launch if any of them has drifted
# since the recorded run, and then **execs the container on the caller's stdio**.
# That matters: a replay is not a different mechanism from a run, it is the same
# `docker run -i` with its inputs read off disk. The Python graph can therefore
# use this script directly as its MCP stdio command and replay a run without
# knowing anything about how a fixture is built.
#
# Everything this script says goes to stderr, because stdout is the MCP
# transport.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(dirname "${here}")

say() { printf '%s\n' "$*" >&2; }
die() { printf 'replay: %s\n' "$*" >&2; exit 1; }

run_dir=""
unit=""
mode=run
docker_args=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --check) mode=check ;;
        --print) mode=print ;;
        --unit) unit="${2:?--unit needs a unit id}"; shift ;;
        --unit=*) unit="${1#--unit=}" ;;
        --env-file) env_file="${2:?--env-file needs a path}"; shift ;;
        --env-file=*) env_file="${1#--env-file=}" ;;
        --) shift; docker_args+=("$@"); break ;;
        -*) die "unrecognised option: $1" ;;
        *) [[ -n "${run_dir}" ]] && die "only one run directory"; run_dir="$1" ;;
    esac
    shift
done

: "${env_file:=${root}/.env}"
[[ -n "${run_dir}" ]] || die "usage: replay.sh <run directory> [--unit ID] [--check|--print]"
[[ -d "${run_dir}" ]] || die "no such run directory: ${run_dir}"
[[ -f "${env_file}" ]] || die "no credentials file at ${env_file}"

container_json="${run_dir}/provenance/container.json"
[[ -f "${container_json}" ]] || die "no provenance at ${container_json}; that run recorded nothing to replay from"

read_json() {
    python3 -c '
import json, sys
document = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    document = (document or {}).get(key) if isinstance(document, dict) else None
print("" if document is None else document)
' "${container_json}" "$1"
}

image_ref=$(read_json image.ref)
image_digest=$(read_json image.digest)
source_revision=$(read_json image.sourceRevision)
recorded_crx_sha=$(read_json extension.crxSha256)
recorded_run_id=$(read_json runId)
[[ -n "${image_ref}" ]] || die "the recorded run did not name its image; it cannot be replayed"

say "replay of      ${recorded_run_id}"
say "image          ${image_ref}${image_digest:+ (${image_digest})}"
say "source         ${source_revision:-unknown}"

# --- drift ----------------------------------------------------------------
# Three things have to be what they were, and each fails loudly rather than
# producing a fixture that is nearly the same. A nearly-identical fixture is
# worse than no replay: it reproduces a different run and looks like a result.

docker image inspect "${image_ref}" >/dev/null 2>&1 \
    || die "image ${image_ref} is not present locally; pull or rebuild it before replaying"

if [[ -n "${image_digest}" ]]; then
    present=$(docker image inspect --format '{{json .RepoDigests}}{{.Id}}' "${image_ref}")
    [[ "${present}" == *"${image_digest}"* ]] \
        || die "image ${image_ref} no longer matches the recorded digest ${image_digest}"
fi

local_crx_sha=$(python3 -c '
import json, sys
print(json.load(open(sys.argv[1])).get("sha256", ""))
' "${root}/vendor/axe-devtools/axe-extension.lock.json")
if [[ -n "${recorded_crx_sha}" && "${local_crx_sha}" != "${recorded_crx_sha}" ]]; then
    die "the pinned extension has moved since that run (recorded ${recorded_crx_sha}, now ${local_crx_sha})"
fi

# The policy is re-rendered inside the recorded image from the recorded inputs
# and compared with the policy that run actually used. This is the check that
# catches a change nothing else would: a render-policy.py edit, or a Deque
# schema that no longer declares a key, both of which change the extension's
# settings while leaving the image tag and the lock file alone.
env_args=()
while IFS= read -r pair; do
    [[ -n "${pair}" ]] && env_args+=(-e "${pair}")
done < <(python3 -c '
import json, sys
for key, value in (json.load(open(sys.argv[1])).get("environment") or {}).items():
    print(f"{key}={value}")
' "${container_json}")

rendered=$(docker run --rm --entrypoint sh "${env_args[@]}" \
    -e AXE_POLICY_FILE=/tmp/policy.json "${image_ref}" -c \
    'python3 /opt/axe/docker/render-policy.py >/dev/null && cat /tmp/policy.json') \
    || die "the recorded inputs no longer render a valid policy in ${image_ref}"

if ! python3 -c '
import json, sys
recorded = json.load(open(sys.argv[1])).get("policy", {}).get("document")
rendered = json.loads(sys.argv[2])
sys.exit(0 if recorded == rendered else 1)
' "${container_json}" "${rendered}"; then
    say "policy drift:"
    python3 -c '
import json, sys
recorded = json.load(open(sys.argv[1]))["policy"]["document"]["3rdparty"]["extensions"]
rendered = json.loads(sys.argv[2])["3rdparty"]["extensions"]
was = next(iter(recorded.values()))
now = next(iter(rendered.values()))
for key in sorted(set(was) | set(now)):
    if was.get(key) != now.get(key):
        print(f"  {key}: {was.get(key)!r} -> {now.get(key)!r}", file=sys.stderr)
' "${container_json}" "${rendered}"
    die "the extension policy has changed since that run; the fixture would not be identical"
fi

say "drift          none: image, extension and policy all match the recorded run"

if [[ "${mode}" == check ]]; then
    exit 0
fi

# --- the command ----------------------------------------------------------
replay_id="replay-$(date -u +%Y%m%dT%H%M%SZ)-${recorded_run_id##*-}"
command=(docker run --rm -i
    --env-file "${env_file}"
    "${env_args[@]}"
    -e "AXE_IMAGE_REF=${image_ref}"
    -e "AXE_IMAGE_DIGEST=${image_digest}"
    -e "AXE_RUN_ID=${replay_id}"
    -e "AXE_REPLAY_OF=${recorded_run_id}"
    -v "$(cd "${root}" && pwd)/build/runs:/opt/axe/runs")

# A single-unit replay is the diagnostic loop the fixture exists for: the run
# that died on unit nineteen is reproduced by one scan and one unit rather than
# by four hours. The graph reads this and loads a one-unit queue.
[[ -n "${unit}" ]] && command+=(-e "AXE_ONLY_UNITS=${unit}")

command+=("${docker_args[@]}" "${image_ref}")

if [[ "${mode}" == print ]]; then
    printf '%q ' "${command[@]}" >&2
    printf '\n' >&2
    exit 0
fi

say "replay as      ${replay_id}${unit:+ (unit ${unit} only)}"
exec "${command[@]}"
