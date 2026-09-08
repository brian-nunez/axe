#!/usr/bin/env python3
"""Record what the fixture's starting state was made of, before anything runs.

This is the container's half of a run's provenance. Replay is only a real
operation if the inputs that produced a fixture can be re-supplied exactly, so
everything that shapes the browser the agent is handed is written here at
start-up: the image and its base, the browser and Playwright builds, the pinned
extension and the CRX it came from, the managed policy verbatim, the screen
geometry, and whether a human could reach the run through noVNC.

The fixture writes the other half — the resolved test id, the baseline counts and
the axe DevTools Server's own version — once it has a session. Neither half is
useful without the other, and both are read by `docker/replay.sh`.

Credentials are never recorded. The account's email address is, because who ran
an audit is part of the audit; the password is not written, hashed or referenced.
"""

import hashlib
import json
import os
import pathlib
import subprocess
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent

# The environment that shapes the fixture. Anything here changes the browser the
# agent is handed, so a replay that does not restore it is not a replay.
FIXTURE_ENV = (
    "AXE_SERVER_URL",
    "AXE_TARGET_URL",
    "AXE_ACCESSIBILITY_STANDARD",
    "AXE_CORE_VERSION",
    "AXE_USAGE_SERVICE_URL",
    "AXE_USAGE_ORGANIZATION",
    "AXE_USAGE_DEPARTMENT",
    "AXE_USAGE_APPLICATION",
    "AXE_SCREEN",
    "AXE_MODEL",
    # The endpoint, not just the model id. A local model's behaviour is a
    # property of what serves it as much as of its weights, so a run recorded
    # without the base URL cannot be told apart from the same weights on a
    # different runtime.
    "AXE_MODEL_KWARGS",
    "AXE_ISSUE_SCREENSHOTS",
    "AXE_CHROMIUM_SANDBOX",
    "AXE_ONLY_UNITS",
    "AXE_EXTENSION_DIR",
    "AXE_POLICY_FILE",
)


def digest(path):
    if not path.is_file():
        return None
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def chromium_version():
    """Ask the browser Playwright actually resolves, not a path we guessed."""
    try:
        executable = subprocess.run(
            [
                "node",
                "-e",
                "process.stdout.write(require('playwright').chromium.executablePath())",
            ],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=ROOT,
        )
        if executable.returncode != 0 or not executable.stdout.strip():
            return {"error": executable.stderr.strip()[:300] or "no executable path"}
        path = executable.stdout.strip()
        version = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=60)
        return {"executable": path, "version": version.stdout.strip() or None}
    except (OSError, subprocess.SubprocessError) as error:
        return {"error": str(error)[:300]}


def playwright_version():
    package = ROOT / "node_modules/playwright-core/package.json"
    if not package.is_file():
        return None
    return json.loads(package.read_text()).get("version")


def main():
    run_dir = pathlib.Path(os.environ["AXE_RUN_DIR"])
    destination = run_dir / "provenance"
    destination.mkdir(parents=True, exist_ok=True)

    extension_dir = pathlib.Path(os.environ.get("AXE_EXTENSION_DIR", "/opt/axe/extension"))
    policy_file = pathlib.Path(
        os.environ.get("AXE_POLICY_FILE", "/etc/chromium/policies/managed/axe-devtools.json")
    )
    lock = json.loads((ROOT / "vendor/axe-devtools/axe-extension.lock.json").read_text())
    manifest = json.loads((extension_dir / "manifest.json").read_text())

    record = {
        "runId": os.environ["AXE_RUN_ID"],
        # Set by docker/replay.sh. A replay's provenance points at the run it
        # was replaying, so a chain of attempts at one failure reads as a chain
        # rather than as unrelated runs.
        "replayOf": os.environ.get("AXE_REPLAY_OF"),
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "actor": os.environ.get("AXE_USER_EMAIL_ADDRESS"),
        "image": {
            # The running image cannot know its own digest, so the launcher
            # passes the reference it resolved. replay.sh sets both.
            "ref": os.environ.get("AXE_IMAGE_REF"),
            "digest": os.environ.get("AXE_IMAGE_DIGEST"),
            "base": os.environ.get("AXE_BASE_IMAGE"),
            "sourceRevision": os.environ.get("AXE_SOURCE_REVISION"),
        },
        "browser": chromium_version(),
        "playwright": playwright_version(),
        "extension": {
            "id": lock["extension_id"],
            "version": manifest.get("version"),
            "crx": lock.get("crx"),
            "crxSha256": lock.get("sha256"),
            "hasManifestKey": manifest.get("key") is not None,
        },
        "policy": {
            "path": str(policy_file),
            "document": json.loads(policy_file.read_text()) if policy_file.is_file() else None,
            "digest": digest(policy_file),
        },
        "display": {
            "display": os.environ.get("DISPLAY"),
            "screen": os.environ.get("AXE_SCREEN"),
        },
        "console": {
            # Recorded because an interactive console is a way for a human to
            # change what the audit saw. A run nobody could touch and a run
            # somebody could must not look the same afterwards.
            "enabled": bool(os.environ.get("AXE_VNC_PASSWORD")),
            "interactive": os.environ.get("AXE_VNC_INTERACTIVE") == "1",
            "port": os.environ.get("AXE_NOVNC_PORT"),
        },
        "environment": {name: os.environ[name] for name in FIXTURE_ENV if os.environ.get(name)},
    }

    target = destination / "container.json"
    target.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    print(f"provenance      {target}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
