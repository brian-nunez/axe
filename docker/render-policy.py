#!/usr/bin/env python3
"""Render the Chrome managed-storage policy for the axe DevTools extension.

Three things make this a script rather than a baked-in file.

The server URL is deployment-specific and arrives as AXE_SERVER_URL, so the file
cannot be a build-time constant.

The key set is validated against `schema.json` *shipped inside the extension we
build*, not against Deque's documentation. schema.json is the contract the
installed version actually honours; a key it does not declare is dropped by
Chromium with an "Unknown policy" note that nothing in a run would surface.

And the file must be keyed on the extension ID. Chromium's Linux policy format
for extension managed storage is:

    {"3rdparty": {"extensions": {"<extension id>": { ...keys... }}}}

Keys written at the top level instead are parsed as *browser* policy: they show
up at chrome://policy as unknown, and `chrome.storage.managed` stays empty. That
failure is silent from the extension's side, which is why this script writes the
wrapper and verifies the ID against the same lock file the build pins.
"""

import json
import os
import pathlib
import re
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent

TRUE = {"1", "true", "yes", "on"}
FALSE = {"0", "false", "no", "off"}

# Valid `AccessibilityStandard` values, read out of the panel bundle's own
# ruleset table. The extension validates against this list and silently falls
# back to its default when the value is not in it.
RULESETS = {
    "all",
    "wcag2a", "wcag2aa", "wcag2aaa",
    "wcag21a", "wcag21aa", "wcag21aaa",
    "wcag22a", "wcag22aa", "wcag22aaa",
    "TTv5", "EN-301-549", "RGAAv4",
}


def require(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is not set")
    return value


def flag(name, default):
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    if raw in TRUE:
        return True
    if raw in FALSE:
        return False
    raise SystemExit(f"{name} must be a boolean, got {raw!r}")


def load_schema(extension_dir):
    schema = json.loads((extension_dir / "schema.json").read_text())
    properties = schema.get("properties")
    if not isinstance(properties, dict) or not properties:
        raise SystemExit(f"{extension_dir}/schema.json declares no properties")
    return properties


def validate(policy, properties):
    """Fail closed on anything the shipped schema would not accept."""
    types = {"string": str, "boolean": bool, "integer": int, "number": (int, float)}
    for key, value in policy.items():
        declared = properties.get(key)
        if declared is None:
            raise SystemExit(f"{key} is not declared in the extension's schema.json")
        if declared.get("deprecated"):
            raise SystemExit(f"{key} is deprecated in the extension's schema.json")
        expected = types.get(declared.get("type"))
        if expected is None:
            raise SystemExit(f"schema.json declares an unhandled type for {key}")
        if isinstance(value, bool) != (expected is bool) or not isinstance(value, expected):
            raise SystemExit(
                f"{key} must be {declared['type']}, got {type(value).__name__}"
            )
        pattern = declared.get("pattern")
        if pattern and not re.match(pattern, value):
            raise SystemExit(f"{key} value {value!r} does not match schema pattern {pattern}")


def build_policy():
    server_url = require("AXE_SERVER_URL").rstrip("/")

    standard = os.environ.get("AXE_ACCESSIBILITY_STANDARD", "wcag22aa").strip()
    if standard not in RULESETS:
        raise SystemExit(
            f"AXE_ACCESSIBILITY_STANDARD must be one of {', '.join(sorted(RULESETS))}, "
            f"got {standard!r}"
        )

    policy = {
        # Pins the extension at our server and locks the field in Options.
        "AxeURL": server_url,
        # The ruleset every issue list is filtered by, locked for the run.
        "AccessibilityStandard": standard,
        # Which bundled axe-core release the automatic scan uses. The releases
        # ship inside the pinned CRX, so this selects among frozen copies.
        "AxeVersion": os.environ.get("AXE_CORE_VERSION", "latest").strip(),
        # The IGT path is half the product. Set explicitly so no org-wide or
        # per-user setting can take it away mid-run.
        "DisableIGT": False,
        # ML features are outside the licence (CONTEXT.md, "What we have").
        "EnableMachineLearning": False,
        # Extension-side screenshots attach chrome.debugger to the inspected
        # tab. That was assumed to collide with the CDP session Playwright
        # drives the browser over; measured, it does not — Chromium allows
        # several debugger clients on one tab, the attach succeeds with
        # DevTools open and Playwright attached, Page.captureScreenshot returns
        # a real image, and the page's own geometry does not move. Every issue
        # the prototypes have ever filed already carries a screenshot_id,
        # because the extension's own default is on. Turning it off would
        # remove a picture the human reviewer gets for free.
        "DisableAllScreenshots": not flag("AXE_ISSUE_SCREENSHOTS", True),
        "EnableIssueScreenshots": flag("AXE_ISSUE_SCREENSHOTS", True),
        # The automatic colour-contrast tool is a screenshot pass. The tool
        # layer computes contrast from resolved styles, so it never runs.
        "EnableAutomaticColorContrast": False,
        "AutomaticColorContrastReview": "manual",
        # Needs-review issues stay visible — page state test 16 reads the saved
        # test for them — but they are kept out of the automatic issue count, so
        # the count a tool compares before and after an action moves only when
        # the action moved it.
        "DisableNeedsReview": False,
        "IncludeNeedsReviewInIssueCount": False,
        # The fixture always mints a real session. Offline Mode is out of scope,
        # and this closes the anonymous path the extension would otherwise allow.
        "RequireLogin": True,
        # Usage telemetry is off unless a usage server is configured below.
        "DataGather": False,
    }

    usage_url = os.environ.get("AXE_USAGE_SERVICE_URL", "").strip()
    if usage_url:
        policy["UsageServiceURL"] = usage_url.rstrip("/")
        policy["DataGather"] = flag("AXE_USAGE_DATA_GATHER", True)
        for key, var in (
            ("UsageServiceOrganization", "AXE_USAGE_ORGANIZATION"),
            ("UsageServiceDepartment", "AXE_USAGE_DEPARTMENT"),
            ("UsageServiceApplication", "AXE_USAGE_APPLICATION"),
        ):
            value = os.environ.get(var, "").strip()
            if value:
                policy[key] = value

    return policy


def main():
    extension_dir = pathlib.Path(os.environ.get("AXE_EXTENSION_DIR", ROOT / "build/axe-extension"))
    destination = pathlib.Path(
        os.environ.get("AXE_POLICY_FILE", "/etc/chromium/policies/managed/axe-devtools.json")
    )
    lock = json.loads((ROOT / "vendor/axe-devtools/axe-extension.lock.json").read_text())
    extension_id = lock["extension_id"]

    manifest = json.loads((extension_dir / "manifest.json").read_text())
    if manifest.get("key") is None:
        raise SystemExit(
            f"{extension_dir}/manifest.json has no key; the extension would load under a "
            "path-derived ID and this policy would never be read"
        )

    policy = build_policy()
    validate(policy, load_schema(extension_dir))

    document = {"3rdparty": {"extensions": {extension_id: policy}}}
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=destination.parent, suffix=".tmp")
    with os.fdopen(handle, "w") as stream:
        json.dump(document, stream, indent=2, sort_keys=True)
        stream.write("\n")
    os.chmod(temporary, 0o644)
    os.replace(temporary, destination)

    print(f"policy          {destination}")
    print(f"extension id    {extension_id}")
    print(f"keys            {len(policy)} set, {' '.join(sorted(policy))}")


if __name__ == "__main__":
    sys.exit(main())
