---
id: 002
title: Obtain the axe extension as an unpacked bundle
labels: [wayfinder:task]
state: closed
assignee: brian
blocked-by: []
---

## Question

How does a reproducible, license-clean copy of the axe DevTools extension get into the container?

`--load-extension` takes an unpacked directory. The extension ships through the Chrome Web Store. Three routes to weigh: ask Deque for a distributable bundle, extract from a store install, or pull it from a Deque-published artifact.

Ask Deque first — the enterprise relationship makes this a supported-path question rather than a packaging trick, and it settles the license question at the same time. Two things to ask in that conversation: whether a distributable bundle exists for containerized use, and whether the license permits driving the extension programmatically at volume.

**The extension ID decides whether the bundle works at all.** Policy is keyed on `lhdoppojpmngadmnindnejefpokejbdd`, and an unpacked copy keeps that ID only if `manifest.json` retains the CRX `key` field — otherwise Chrome derives the ID from the absolute path and the managed policy silently does nothing. The on-prem installer also takes `--extension-id`, so the server likely validates the calling `chrome-extension://` origin and may reject a repacked copy outright. Verify the loaded extension's ID before trusting any bundle.

Resolve with: where the bundle comes from, how a build pins its version, whether the loaded extension keeps its store ID, and what the license permits. Every prototype ticket waits on this.

## Resolution

**The bundle is built from a pinned CRX by [`tools/build-axe-extension.py`](../../tools/build-axe-extension.py).** Tested end to end on this Mac against Chrome for Testing 145.0.7632.6 and axe DevTools 4.135.0.

### The ID question, answered empirically

Four launches, reading the ID Chrome actually assigned from the profile's `Secure Preferences` (`extensions.settings`, `location: 8` = loaded from command line):

| Bundle | Loaded ID | |
|---|---|---|
| Installed copy, `key` intact, loaded from a temp path | `lhdoppojpmngadmnindnejefpokejbdd` | store ID kept |
| Same copy with `key` deleted | `nbjgppcbhhniiaicladfedegfmikacen` | derived from path |
| Built from store CRX via the recipe below | `lhdoppojpmngadmnindnejefpokejbdd` | store ID kept |
| `tools/build-axe-extension.py` output | `lhdoppojpmngadmnindnejefpokejbdd` | store ID kept |
| Vendored CRX built via `--lock` | `lhdoppojpmngadmnindnejefpokejbdd` | store ID kept |

So: **`key` present, ID preserved regardless of path.** The negative control proves causation rather than correlation.

### The trap that would have bitten

**A Web Store CRX does not contain the `key` field.** The browser injects it at install time from the CRX signature header. Unzip a CRX, point `--load-extension` at it, and you get a path-derived ID and managed policy that silently does nothing — exactly the failure [Research the auth flow](003-research-headless-session-minting.md) warned about, reached by the most obvious route.

Recovering the key has a second trap: a Web Store CRX carries **three** signature proofs, and the first is Google's countersignature, not the publisher's. Selecting it yields `lfoeajgcchlidpicbabpmckkejpckcfb`. The correct selector is the `crx_id` in the header's `signed_header_data` — pick the proof whose `sha256(public_key)[:16]` equals it. The tool does this and refuses to build otherwise.

### Where the bundle comes from, and how a build pins it

Source is the Web Store update endpoint, the same one `manifest.json`'s `update_url` names. **It serves the current release only — there is no version parameter.** So a build-time fetch is unpinned by construction, and the extension would change under a quarterly reporting window. That defeats the fixture's stated payoff.

Therefore the CRX is the pinned artifact, not the fetch:

1. The CRX is **vendored in the repo** at `vendor/axe-devtools/lhdoppojpmngadmnindnejefpokejbdd-4.135.0.crx` — 4.8 MB, 20 MB unpacked, sha256 `47077e6fc7babcf61baf102c4acc3999e67fcb855d21afc0a592e13341c853b4`.
2. `vendor/axe-devtools/axe-extension.lock.json` pins the ID, version, digest, and source URL. The image build runs `build-axe-extension.py --lock vendor/axe-devtools/axe-extension.lock.json --dest <path>`, which verifies the digest, verifies the version, recovers the publisher key, unpacks, and injects `key`.
3. Every check is fail-closed — verified: a tampered digest in the lock exits 1 without writing a bundle. A wrong version or a header whose proofs do not match its `crx_id` aborts the same way.
4. The upgrade procedure is in [`vendor/axe-devtools/README.md`](../../vendor/axe-devtools/README.md): download, update four fields in the lock, rebuild, confirm the ID, delete the superseded CRX in the same commit.

Upgrading axe DevTools is then a deliberate act: fetch a new CRX, record its digest, change two arguments.

### Facts for later tickets

- **`schema.json` is the managed-storage contract** — 20 keys, shipped inside the extension. This is the full key set [Settle the container spec](005-container-spec.md) asks for: `AxeURL`, `UsageServiceURL`, `UsageServiceOrganization`, `UsageServiceDepartment`, `UsageServiceApplication`, `DataGather`, `DisableIGT`, `EnableIssueScreenshots`, `WCAGLevel` (deprecated), `AccessibilityStandard`, `AxeVersion`, `IncludeNeedsReviewInIssueCount`, `AutomaticColorContrastReview`, `EnableMachineLearning`, `EnableAutomaticColorContrast`, `DisableAllScreenshots`, `DisableNeedsReview`, `OfflineLicenseKey`, `RequireLogin`, `HideSocialProviders`. Read the shipped file rather than Deque's docs — it is authoritative for the installed version.
- **Playwright 1208 ships Chrome for Testing on macOS only.** `Google Chrome for Testing 145.0.7632.6` is the macOS artifact; the Linux artifact is unbranded `Chromium 145.0.7632.0`. ~~The branded build reads `/etc/opt/chrome_for_testing/policies/managed/` on Linux.~~ **Corrected by [Settle the container spec](005-container-spec.md):** in the container the path is `/etc/chromium/policies/managed/`, measured. The claim above was macOS-shaped and does not hold where it matters.
- **The extension is installed in Edge on this machine, not Chrome**, at `~/Library/Application Support/Microsoft Edge/Default/Extensions/lhdoppojpmngadmnindnejefpokejbdd/4.135.0_0`. Immaterial to the build (the ID comes from the publisher key, not the browser), but it is where to look for a hand-installed copy.
- **8.6 MB of the 20 MB is `axe-versions`**, the bundled axe-core releases the `AxeVersion` policy key selects between.
- **Unverified:** whether Chrome auto-updates a command-line-loaded extension whose manifest retains `update_url`. If it does, pinning leaks at runtime and the manifest needs `update_url` stripped. 005 should check this while it verifies policy loading.

### License half — answered

**The license permits use, and software that interacts with Deque software.** Driving the extension with our own automation is within terms. Recorded in [CONTEXT.md](../../CONTEXT.md) under *What we have*, which is the source of truth for license posture; it is settled and should not resurface as a project risk.

That also settles the sourcing route. We are licensed to use the extension, so building from the Web Store CRX we are entitled to install needs no separate permission.

**Residual questions for the rep — operational, not licensing, and none of them blocking:**

1. Do you supply a **distributable bundle** for containerized use? We no longer need one — `tools/build-axe-extension.py` produces a correct bundle from the store CRX — but a supported artifact would be less brittle than depending on CRX3 header layout.
2. Does the on-prem server **validate the calling `chrome-extension://` origin** against the installer's `--extension-id`? We keep the store ID, so this should be moot. Confirm rather than assume.
3. What is the **release cadence**, and is there notice before a release changes panel markup? This is the live one: our tool layer reads the panel's DOM, so an unannounced release is the standing risk to the run, now that licensing is not.
