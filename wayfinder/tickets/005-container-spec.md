---
id: 005
title: Settle the container spec
labels: [wayfinder:grilling]
state: closed
assignee: brian
blocked-by: []
---

## Question

What exactly does the fixture container contain, and what is pinned?

Decisions to make: base image; Chrome for Testing version and how it is pinned; Playwright version, pinned because `PW_CHROMIUM_ATTACH_TO_OTHER` is undocumented internals; Xvfb and noVNC layout; where the managed-storage policy file lands for the host OS; whether the browser runs headless or headful behind Xvfb given humans watch through noVNC.

The policy file pins server URL, accessibility standard, and login mode, and policy-set values lock in the extension UI — decide the full key set here so settings hold for the life of a run. Plain Chromium reads `/etc/chromium/policies/managed/`, confirmed from Chromium source; Playwright's bundled Chromium is an unbranded build, so that is the expected path.

[Obtain the axe extension as an unpacked bundle](002-obtain-unpacked-extension.md) settled two things this ticket assumed:

- **The full policy key set is `schema.json`, shipped inside the extension** — 20 keys, listed in 002's resolution. Read the shipped file, not Deque's docs.
- ~~**Playwright 1208 ships Chrome for Testing, not unbranded Chromium**, so the expected Linux policy path is `/etc/opt/chrome_for_testing/policies/managed/`.~~ **Wrong — disproven by the draft below.** That is true of the macOS artifact only; Playwright's *Linux* chromium-1208 is unbranded `Chromium 145.0.7632.0` and reads `/etc/chromium/policies/managed/`, exactly as this ticket originally assumed. Measured one directory at a time; the other three return `{}`.

**Verify the policy is actually read before designing around it.** Drop a policy file, launch through Playwright, open `chrome://policy`, and confirm the axe extension sees its keys. Two minutes, and the fixture design rests on it.

`.env` currently holds only the two credentials. The policy needs the on-prem server origin as `AxeURL`, so add `AXE_SERVER_URL` to `.env` and have the entrypoint render the policy file from it.

While verifying the policy, settle one more thing: **does Chrome auto-update a command-line-loaded extension whose manifest retains `update_url`?** The axe manifest keeps it. If updates fire, version pinning leaks at runtime and the build must strip `update_url` — which would make 002's pinned-CRX guarantee conditional on it.

Resolve with a spec concrete enough to write a Dockerfile from.

## Draft spec

**Left open deliberately.** This is a `wayfinder:grilling` ticket and the decisions at
the end are Brian's. Everything above that line is measured, and the image it
describes is built and running.

Written against `docker/Dockerfile`, `docker/entrypoint.sh` and
`docker/render-policy.py`. Built and exercised end to end on this machine
(`linux/arm64` under Docker Desktop) against `axe.deque.com` with the real
credentials from `.env`: policy applied, extension loaded as
`lhdoppojpmngadmnindnejefpokejbdd`, session minted, refresh grant accepted,
DevTools panel selected and laid out, noVNC serving.

### Two corrections to the record, both measured

**Playwright's Linux browser is not Chrome for Testing.** `browsers.json` labels
chromium-1208 "Chrome for Testing", and on macOS the artifact really is
`chrome-mac-arm64/Google Chrome for Testing.app`. The Linux artifact is not:
`chrome-linux/chrome --version` reports **`Chromium 145.0.7632.0`**, the binary
contains `/etc/chromium/policies` and `/etc/chromium/native-messaging-hosts` and
no branded product string at all. So 002's inference — that the container would
read `/etc/opt/chrome_for_testing/policies/managed/` — was macOS-shaped and does
not hold. This ticket's original assumption was right for the wrong reason.

**Headful is not what gives the panel layout.** Same image, same fixture, panel
selected via CONTEXT's `selectTab` recipe:

| Mode | Panel `document.body` box |
|---|---|
| Headful behind Xvfb | 554 × 693 |
| `headless: true`, `channel: "chromium"` | 554 × 693 |

Both pass. The panel is laid out either way, which matches 004's note that the
`showView` recipe works headless under `channel: "chromium"`. **Headful earns its
place because a human can watch it through noVNC, not because the panel needs
it.** Worth saying plainly so nobody later "optimises" to headless believing they
are fixing a layout risk, and loses the watch console for nothing.

One consequence for screen geometry: at a 1920×1080 window the panel measured
**554 × 913**. Docked DevTools width did not move; height tracked the screen. So
`AXE_SCREEN` height buys panel rows, width buys nothing until something changes
the dock.

### The managed-policy path, measured

Four candidate directories, one populated per launch, fresh profile each time,
reading the extension's own `chrome.storage.managed`:

| Directory | `chrome.storage.managed` |
|---|---|
| **`/etc/chromium/policies/managed/`** | **all keys present** |
| `/etc/opt/chrome/policies/managed/` | `{}` |
| `/etc/opt/chrome_for_testing/policies/managed/` | `{}` |
| `/etc/chromium-browser/policies/managed/` | `{}` |

A fifth launch with all four populated and a distinguishing `AxeURL` in each
returned the `/etc/chromium` value, confirming precedence is not the explanation:
the other three are simply not read.

**The file format cost more than the path did.** Writing the keys at the top
level of the JSON is the obvious thing and it is wrong. Chromium parses them as
*browser* policy: `chrome://policy` lists each as `Unknown policy` and
`chrome.storage.managed` stays `{}` — a failure with no symptom on the extension
side beyond settings quietly reverting to defaults. The extension policy format
is keyed on the extension ID:

```json
{"3rdparty": {"extensions": {"lhdoppojpmngadmnindnejefpokejbdd": { … }}}}
```

`docker/render-policy.py` writes that wrapper, takes the ID from the same lock
file the build pins, and refuses to write if the built manifest has lost its
`key` — because without the store ID the policy is read by nobody.

**Verified in the production image, headful behind Xvfb.** `chrome://policy`
grows a third table beside *Chrome Policies* and *Policy Precedence*, titled
**"axe DevTools - Web Accessibility Testing"**, listing all 13 keys with
`Source: Platform`, `Scope: Machine`, and no error or warning on any row. The
remaining 7 schema keys appear in the same table with empty values. The
extension's `chrome.storage.managed.get(null)` returns all 13.

### How the extension consumes policy

Read out of the shipped `panel.bundle.js` and `popup.bundle.js`, because it
changes what a wrong value does:

- Policy is read **once**, copied into `chrome.storage.local` under
  **`policySettings`**, and every key is type-checked on the way in
  (`typeof value === "string"` etc.). A key of the wrong JSON type is dropped
  silently — no console error, no `chrome://policy` warning.
- `AccessibilityStandard` is additionally validated against the panel's own
  ruleset table and falls back to the default if unrecognised. The accepted
  values are `all`, `wcag2a`, `wcag2aa`, `wcag2aaa`, `wcag21a`, `wcag21aa`,
  `wcag21aaa`, `wcag22a`, `wcag22aa`, `wcag22aaa`, `TTv5`, `EN-301-549`,
  `RGAAv4`. `render-policy.py` rejects anything else at container start rather
  than letting the run proceed against a silently different ruleset.
- `WCAGLevel` is only consulted when `AccessibilityStandard` is absent or
  invalid. Setting both is ambiguous by construction.
- **`chrome.storage.local.ignore_policies`, if truthy, disables the entire policy
  read.** The fixture seeds `storage.local`; it must never write that key. Noted
  here because it is a one-line way to break every setting in this section with
  no other visible effect.

### The key set: 20 declared, 13 set

Authoritative list is `schema.json` inside `build/axe-extension`.
`render-policy.py` validates every key it emits against that shipped file —
declared, correct type, matching any `pattern` — and exits non-zero otherwise. A
key Deque removes in a future release therefore fails the container start rather
than the run.

| Key | Value | Why |
|---|---|---|
| `AxeURL` | `$AXE_SERVER_URL` | Points the extension at our server and locks the field in Options. |
| `AccessibilityStandard` | `$AXE_ACCESSIBILITY_STANDARD`, default `wcag22aa` | The ruleset every issue list is filtered by. **Decision 1.** |
| `AxeVersion` | `$AXE_CORE_VERSION`, default `latest` | Selects among the axe-core releases bundled *inside the pinned CRX*, so `latest` here resolves to 4.12.1 and cannot drift while the CRX is pinned. Explicit values are limited to the nine numbered copies, 4.9.0 – 4.12.0. |
| `DisableIGT` | `false` | The IGT path is half the product. Set explicitly so no org-wide or per-user setting can remove it mid-run. |
| `EnableMachineLearning` | `false` | ML is outside the licence. Belt to `igt_start`'s unconditional untick of `#enableAiAssist`. |
| `DisableAllScreenshots` | `true` | Extension-side screenshots attach `chrome.debugger` to the inspected tab — the same channel Playwright drives the browser over. Evidence images come from Playwright. **Decision 4.** |
| `EnableIssueScreenshots` | `false` | Subordinate to the above, set explicitly so the value cannot be inherited. |
| `EnableAutomaticColorContrast` | `false` | The automatic contrast tool is a screenshot pass; `check_text_contrast` computes contrast from resolved styles. |
| `AutomaticColorContrastReview` | `"manual"` | Same reason, from the other side: it never runs on its own. |
| `DisableNeedsReview` | `false` | Needs-review issues stay visible — page state test 16's prerequisite reads the saved test for them. |
| `IncludeNeedsReviewInIssueCount` | `false` | …but they stay out of the automatic issue count, so a count a tool compares before and after an action moves only when the action moved it. This is what makes 011's `rejected` verdict trustworthy. |
| `RequireLogin` | `true` | The fixture always mints a real session. Closes the anonymous path; Offline Mode is out of scope. |
| `DataGather` | `false`, or `true` with a usage server | See below. |

Conditional, emitted only when `AXE_USAGE_SERVICE_URL` is set:
`UsageServiceURL`, `UsageServiceOrganization`, `UsageServiceDepartment`,
`UsageServiceApplication`, and `DataGather` flips to `true`. **Decision 3.**

Deliberately never set:

- **`WCAGLevel`** — deprecated in the shipped schema, and only a fallback for
  `AccessibilityStandard`. `render-policy.py` refuses any key the schema marks
  deprecated.
- **`OfflineLicenseKey`** — Offline Mode is ruled out in CONTEXT.
- **`HideSocialProviders`** — only affects a login screen the fixture never renders.

### `update_url`: no, and the build does not need to strip it

The axe manifest keeps `"update_url": "https://clients2.google.com/service/update2/crx"`.
Answered by a controlled experiment in the container — same browser, same
background-networking settings, same explicit trigger
(`chrome.developerPrivate.autoUpdate()`, which is what the *Update* button on
`chrome://extensions` calls), watching `--log-net-log` at
`--net-log-capture-mode=Everything`:

| Arm | How the extension is installed | Chromium's `location` | Requests to any update endpoint |
|---|---|---|---|
| A | `--load-extension` (ours) | `COMMAND_LINE` | **none** |
| C | policy `ExtensionInstallForcelist`, same ID | `EXTERNAL_POLICY_DOWNLOAD` | `clients2.google.com/service/update2/crx?…x=id%3Dlhdoppojpmngadmnindnejefpokejbdd%26v%3D0.0.0.0%26installedby%3Dpolicy…` |

Arm C is the positive control: it proves the updater is compiled in, the
endpoint is reachable and the observation channel sees it. Arm A produced
nothing, and the on-disk version was unchanged after. Corroborated across three
independent channels — a `--host-resolver-rules` sink, an HTTP proxy logging
`CONNECT`, and netlog — all with the same answer.

**Two independent reasons it cannot fire**, either of which suffices:

1. A command-line-loaded extension gets `location: COMMAND_LINE`, which Chromium
   does not enrol in the updater.
2. Playwright unconditionally passes `--disable-background-networking` (and
   `--disable-component-update`) in `chromiumSwitches`, which disables the
   extension updater outright regardless of location. Arms A and C above were run
   with `ignoreDefaultArgs` lifting both, precisely so reason 1 could be tested on
   its own. **Never pass `ignoreDefaultArgs` for those two switches in
   production**; that is the only way to remove the second reason.

**So 002's pinned-CRX guarantee is unconditional, and the build must not strip
`update_url`.** Stripping it would be a change with no measured benefit that
diverges our bundle from Deque's shipped manifest for no reason.

### The image

Base is `mcr.microsoft.com/playwright:v1.58.0-noble`, pinned by index digest
`sha256:35c7d48b4ccaf3aca5018f5f1bf7f50c7da7d61d176c530741f4f2e9ca336c34`. That
choice pins Playwright 1.58.0 and chromium-1208 together, which is what the
`PW_CHROMIUM_ATTACH_TO_OTHER` dependency requires, and brings Chrome for
Testing's runtime dependencies and Xvfb already installed and matched to the
build. `npm ci` runs with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so the image never
acquires a second browser copy.

Added on top: `tini` as PID 1, `x11vnc`, `novnc`, `websockify`, `x11-utils`, all
version-pinned in the `apt-get install`.

Build-time: `tools/build-axe-extension.py --lock …` unpacks the vendored CRX into
`/opt/axe/extension`, so a running container never fetches an extension.
`PW_CHROMIUM_ATTACH_TO_OTHER=1` is an image `ENV` rather than something the
launching process sets, because it has to be in place before Chromium attaches.

Start-up order in `entrypoint.sh`, and each step is ordered for a reason:

1. Fail fast on missing `AXE_SERVER_URL`, `AXE_USER_EMAIL_ADDRESS`, `AXE_USER_PASSWORD`.
2. Render the policy as root, root-owned `0644`, **before Chromium starts** —
   Chromium reads the directory at launch, and the browser must not be able to
   rewrite its own policy.
3. Xvfb on `$DISPLAY`, then poll `xdpyinfo` until it answers.
4. noVNC, if enabled.
5. `exec` the fixture as `pwuser` via `setpriv`, with `HOME` reset — `setpriv`
   does not touch the environment, and a `HOME` of `/root` puts the browser
   profile somewhere the dropped uid cannot write.

`CMD` is `node fixture/cli.js --headed --keep-open`; the entrypoint appends
`--extension=/opt/axe/extension` so no caller needs to know where the image put
it. **When 011's MCP server lands, that `CMD` is what changes** — see Decision 5.

`AXE_VNC_PASSWORD` gates the watch console: a run holds an authenticated axe
session and a live browser, so no password means no console, and a viewer is
view-only unless `AXE_VNC_INTERACTIVE=1`. x11vnc binds loopback; websockify is
what listens on `AXE_NOVNC_PORT` (6080).

```
docker build -f docker/Dockerfile -t axedevtools-fixture .
docker run --rm --env-file .env -e AXE_VNC_PASSWORD=… -p 6080:6080 axedevtools-fixture
```

### The renderer sandbox is off, and it is off on the Mac too

`chrome://sandbox` in the container reports *"You are NOT adequately sandboxed"*.
The cause is not the container: **Playwright's `chromiumSandbox` option defaults
to `false`, and `chromium.js` appends `--no-sandbox` whenever it is not
explicitly `true`.** So every launch in this repo today — `make login`, every
prototype, the Mac included — runs renderers unsandboxed. The container merely
made it visible.

Measured fixes, all in the same image:

| Run | `chromiumSandbox: true` |
|---|---|
| default `docker run` | fails to start: *"No usable sandbox!"* — Docker's default seccomp profile blocks the user-namespace `clone`/`unshare` |
| `--security-opt seccomp=unconfined` | **"You are adequately sandboxed"**, namespace layer, seccomp-BPF yes |
| `--cap-add=SYS_ADMIN` | same |

In both working cases the extension still loads with its store ID, all 13 policy
keys still arrive, and a real page renders. This is left as a decision rather
than applied, because turning it on means changing `fixture/launch.js` (004's
code) *and* requiring a runtime flag on every deployment.

### What still needs Brian

1. **`AccessibilityStandard` — `wcag22aa`, `wcag21aa`, or `TTv5`?**
   `reference/page-state-tests.json` records the conflict rather than resolving
   it: the Remaining Testing guide's own heading says WCAG 2.2 AA, but the panel
   we captured it under was set to WCAG 2.1 AA. This is the one policy value that
   changes which issues the automatic scan reports and therefore what every
   downstream count means. I defaulted to `wcag22aa` to match the checklist we
   are actually executing; if the enterprise instance's org-wide setting is 2.1
   AA, the policy will now silently disagree with it.

2. **Renderer sandbox: on with a runtime flag, or off?** Off is Playwright's
   default and what everything has run under so far. On costs
   `--security-opt seccomp=unconfined` (or `--cap-add=SYS_ADMIN`) on every
   `docker run`, plus `chromiumSandbox: true` in `fixture/launch.js`. The browser
   will be loading arbitrary Amex page states, so this is a real posture call and
   not mine to make.

3. **Usage telemetry.** `DataGather` plus `UsageServiceURL`,
   `UsageServiceOrganization`, `UsageServiceDepartment`, `UsageServiceApplication`
   are wired and off. No value for any of them exists anywhere in the repo. If
   the on-prem deployment runs a Usage Service, the four strings are Amex facts I
   cannot invent — and the answer may be that automated runs should be tagged
   distinctly from human ones so the usage data stays interpretable.

4. **Extension-side issue screenshots: keep them off?** Off today because
   `EnableIssueScreenshots` makes the extension call `chrome.debugger.attach` on
   the inspected tab, which is the channel Playwright already owns. **I have not
   measured whether that actually breaks anything** — proving it needs a saved
   test and a filed issue with screenshots on. The trade is a filed issue
   carrying a picture on Deque's side, which is real value to the human reviewer,
   against a debugger collision mid-run. Related and unresolved: 004 records that
   the dev instance short-circuits `/api/internal/server-info`, so we do not know
   whether the enterprise instance has `screenshotsEnabled` at all.

5. **How the graph reaches the container.** 011 settles that the MCP server *is*
   the fixture, but not what crosses the container boundary. Two shapes: stdio,
   where the Python graph runs `docker run -i` and owns the container's lifetime;
   or a listening port, where the container is long-lived and the graph connects
   to it. It decides `CMD`, whether `EXPOSE` grows a second port, and who is
   responsible for tearing a run down. Everything else in this spec is
   indifferent to the answer.

6. **Is 6080 published at all where this runs?** The console is password-gated
   and view-only by default, which is the safe end of the range. Whether humans
   should be able to *drive* the browser mid-run — `AXE_VNC_INTERACTIVE=1` — is a
   product question: it is an escape hatch for a stuck run and a way to
   contaminate an audit, and it depends on whether reproducible failure or human
   rescue matters more when a four-hour run stalls.

## Resolution

All six decided. Four are settled on evidence and need no further input; **two
need Brian and are marked so** — the renderer sandbox, which is a posture call
against a runtime cost, and usage telemetry, whose four values are Amex facts
nobody here has.

The draft spec above stands as written. Everything below either decides a
question it left open or corrects it with a measurement.

### One finding that moves three of the six

The extension's factory settings, read out of `panel.bundle.js`:

```js
{ enableBestPractices: false, enableScreenshots: true, enableAutomaticColorContrast: true,
  enableMachineLearning: true, enableAdvancedRules: true, ruleset: wcag21aa,
  axeVersion: "latest", includeNeedsReviewInIssueCount: true, disableNeedsReview: true,
  automaticColorContrastReview: "manual", enableExperimentalRules: false, aiDataSharing: true }
```

and, separately, `{ dataGather: true, usageServer: "https://usage.deque.com" }`.

**Not setting a policy key is not neutral. It is a choice of Deque's default**,
and four of those defaults are ones this project would not choose: telemetry on
and pointed at Deque's public usage service, ML on, needs-review counted in the
issue count, and the ruleset at WCAG 2.1 AA. The policy table's habit of setting
values "explicitly so they cannot be inherited" is therefore load-bearing rather
than tidy, and it reframes decisions 1, 3 and 4 below — each of them is a
question about whether to keep a Deque default, not about whether to add a
setting.

---

### 1. `AccessibilityStandard` — `wcag22aa`

**Decided: `wcag22aa`, and the conflict in `reference/page-state-tests.json` was
never a conflict between two chosen standards.**

`ruleset` defaults to `wcag21aa` in the shipped bundle. The panel the Remaining
Testing checklist was captured under was on that default — nobody set 2.1 AA, and
there is no evidence anywhere in this repo of an org-wide standard having been
chosen. So the disagreement the reference file records is between Deque's guide
heading, which says WCAG 2.2 AA, and Deque's own out-of-the-box default. Given a
choice between the standard the checklist we execute is written against and the
value the panel happened to boot with, the checklist wins.

`TTv5` is refused rather than deferred. It is a different checklist — Trusted
Tester's, not the 16 page state tests in `reference/` — and selecting it would
mean the automatic scan is filtered by one standard while the manual path
executes another. That is worse than either answer alone.

**What this setting does and does not reach.** It filters the automatic scan's
issue list, so it changes `TOTAL ISSUES`, the baseline `checkLedger` compares
against, and every count a tool reads before and after an action. It does **not**
filter the manual issue catalog: `reference/page-state-tests.json` already
records that the 418-entry dump taken under 2.1 AA still contains 2.4.11 and
2.5.8, so test 16 Target Size is fileable either way and no skill file branch
becomes unfileable under either value. The blast radius is counts, not coverage.

Wired as `AXE_ACCESSIBILITY_STANDARD`, defaulting to `wcag22aa`, validated
against the panel's own ruleset table at container start.

**Brian's review: one factual question, not a decision.** If the Amex on-prem
instance has an org-wide `AccessibilityStandard`, managed policy wins locally and
our counts will disagree with whatever that instance's dashboards report. Worth
one message to whoever administers it. Nothing in the design changes either way.

---

### 2. Renderer sandbox — **recommend on. This one is Brian's.**

**Recommendation: `chromiumSandbox: true`, with a seccomp profile that permits
the user-namespace calls rather than `seccomp=unconfined` in production.**

The default is not a security judgement anyone made. Verified in the pinned
Playwright:

```js
// node_modules/playwright-core/lib/server/chromium/chromium.js:289
if (options.chromiumSandbox !== true)
  chromeArguments.push("--no-sandbox");
```

So every launch in this repo — the container, every prototype, `make login`, the
Mac — runs renderers unsandboxed, because nothing ever passed the option. That is
a CI convenience default inherited by accident, not a posture.

**Why on.** The renderer parses arbitrary Amex page states, and the process it
would escape into holds a live authenticated axe DevTools session in
`chrome.storage.local`, a refresh token good for 20 days, and
`AXE_USER_PASSWORD` in its own environment. A renderer compromise without the
sandbox is a container compromise with credentials in it. For a bank that is the
whole argument; the counter-argument is a runtime flag.

**The cost, and the part that reads backwards.** Turning it on needs
`chromiumSandbox: true` in `fixture/launch.js` **and**
`--security-opt seccomp=unconfined` on every `docker run`, because Docker's
default seccomp profile blocks the `clone`/`unshare` that Chromium's own sandbox
is built out of. Removing Docker's filter to enable Chromium's looks like a
downgrade and is not: it trades one coarse syscall filter shared by every
container for a browser-aware layered sandbox — user namespaces plus
seccomp-BPF, which `chrome://sandbox` then reports as adequate. But
`seccomp=unconfined` genuinely does remove a control, so the production shape is
a **targeted seccomp profile** that permits those calls and keeps the rest of
Docker's, with `unconfined` acceptable for development. `--cap-add=SYS_ADMIN`
works and should not be used: it grants far more than the two syscalls at issue.

**Not applied here.** It requires editing `fixture/launch.js`, which belongs to
[004](004-login-at-fixture-start.md) and is under concurrent work for the MCP
server. What this ticket does instead is make the posture a recorded fact:
`AXE_CHROMIUM_SANDBOX` is part of the fixture environment written into every
run's provenance, so a run can always be asked which way it was launched. The
one-line change in `launch.js` is to read it.

**Brian's review: required.** Off is what everything has run under; on costs a
flag on every deployment. Nobody should discover this repo's posture by reading
`chrome://sandbox` later.

---

### 3. Usage telemetry — **off, plumbing wired, and Brian must supply four values**

**Decided: stays off. Not deferred — off is the correct state until an endpoint
exists**, for a reason the draft did not have.

Three things read out of the shipped bundles:

- The extension's default is `dataGather: true`, and `usageServerURL` of
  `"default"` resolves in the background worker to **`https://usage.deque.com`**.
  So a container with no `DataGather` key does not run without telemetry — it
  runs with telemetry pointed at Deque's public usage service. The explicit
  `DataGather: false` in the policy is what prevents that.
- **The usage client falls back to plain HTTP.** On `ECONNREFUSED` over `https:`
  it rewrites the scheme to `http:` and re-POSTs the same body. A misconfigured
  or unreachable on-prem usage endpoint therefore produces an unencrypted retry
  of every event. That is reason enough never to leave `UsageServiceURL` at
  `default` on a bank's network, and reason enough not to enable telemetry
  speculatively.
- With tracking off, `prepareEventData` returns `null` before anything is built,
  so nothing is queued, buffered or retried while `DataGather` is false. Off is
  genuinely off.

**What Brian must supply to turn it on**, all four, none of them inventable here:

| Variable | Policy key | What it is |
|---|---|---|
| `AXE_USAGE_SERVICE_URL` | `UsageServiceURL` | the on-prem Usage Service origin — an explicit URL, never `default` |
| `AXE_USAGE_ORGANIZATION` | `UsageServiceOrganization` | Amex's organisation string as that service expects it |
| `AXE_USAGE_DEPARTMENT` | `UsageServiceDepartment` | the owning department |
| `AXE_USAGE_APPLICATION` | `UsageServiceApplication` | the application tag |

Setting `AXE_USAGE_SERVICE_URL` flips `DataGather` to `true` and emits the other
three when present; `render-policy.py` validates each against the shipped
`schema.json` as it does every other key.

**A recommendation on the values, since it is the part that decides whether the
data is worth gathering.** Tag automated runs distinctly from human ones —
`UsageServiceApplication` naming this agent rather than the audited product. The
platform team's case for the licence rests on knowing how much testing happened
and by whom; 23 agent-driven tests landing in the same bucket as 23 auditor-hours
makes that harder to read, not easier.

**Brian's review: required.** Four Amex facts, and a call on whether automated
runs should be reported at all.

---

### 4. Extension issue screenshots — **on. The collision was measured and does not happen.**

**Decided: `DisableAllScreenshots: false`, `EnableIssueScreenshots: true`**,
gated by `AXE_ISSUE_SCREENSHOTS` (default on) so a deployment can turn it off
without an edit. This is a reversal of the draft, and it is the one decision here
that was tested rather than argued.

**The mechanism the draft named is the right one.** The manifest carries the
`debugger` permission and no host permissions at all, and there is no
`captureVisibleTab` path in the bundles: screenshots go through
`chrome.debugger.attach` plus `Page.captureScreenshot` with
`captureBeyondViewport`. So the concern was correctly aimed.

**Measured, on the pinned extension, against the real instance, headless and
headful.** The extension's own debugger namespace was attached to the exact tab
Playwright drives, with DevTools open on it as well — three CDP clients on one
target:

| | Headless (`channel: chromium`) | Headful |
|---|---|---|
| `chrome.debugger.attach` | **ok**, no error | **ok**, no error |
| `Page.captureScreenshot`, `captureBeyondViewport: true` | 109,896 B PNG | 253,344 B PNG |
| Playwright after: `title`, `hover`, `boundingBox`, `page.screenshot`, `evaluate` | all ok | all ok |
| DevTools front-end after, incl. the axe panel tab | ok | ok |
| page geometry before → after attach | 1280×720, body 821.875 → **unchanged** | 1280×720, body 821.875 → **unchanged** |

The geometry row is the one that mattered most and was not obvious. A debugging
infobar that stole page pixels, or an `Emulation.setDeviceMetricsOverride` left
behind by `captureBeyondViewport`, would have silently corrupted
`check_target_size`, `check_reflow` and `check_text_contrast`. Neither happens:
`innerWidth`/`innerHeight` and the body box are identical either side.

**And the strongest evidence was already on the server, unnoticed.** Because the
extension's default is `enableScreenshots: true` and no managed policy applies on
macOS, **every prototype run in this repo has been running with the debugger
attached the whole time.** Every issue those runs filed — 008's, 009's, 010's,
017's, manual and automatic alike — carries a non-null `screenshot_id` on
`GET /api/tests/{id}/issues`. The collision hypothesis has been disproven
repeatedly by work that was not looking for it.

Two more findings from the same read:

- **`/api/internal/server-info` answers on our instance**, which resolves the
  sub-question the draft left open: `screenshotsEnabled: true`, alongside
  `version: 6.1.0`, `isOnPrem: false`, `mlServiceEnabled: true`. The panel gates
  screenshots on that flag, so if the Amex on-prem instance reports `false` the
  extension disables them by itself and this policy becomes a no-op — a safe
  failure, and the only thing left to confirm on that deployment.
  **This corrects [004](004-login-at-fixture-start.md)'s note** that the dev
  instance short-circuits the endpoint. It does not, today.
- **The Table IGT declares `maintainDebuggerSession: true`**, and the panel
  attaches the debugger when that guide starts **regardless of the screenshot
  policy**. So turning screenshots off would never have avoided a debugger
  attach; it would only have avoided it during the automatic scan, and left it in
  place on the guided path where a collision would have cost an in-progress
  ledger. The draft's setting was buying nothing where it mattered.

For completeness on the error path: a second attach from the same extension
returns `Another debugger is already attached to the tab`, and the bundle's
`failedToAttach()` treats only `"Cannot attach to this target."` and the
cross-extension message as real failures — so an already-attached tab is a benign
no-op in Deque's own handling, not an error.

`EnableMachineLearning` and `EnableAutomaticColorContrast` stay `false` and are
unaffected: both are set explicitly, and the policy reader only falls back to the
`DisableAllScreenshots` umbrella when the specific key is absent.

**Brian's review: not needed.** Measured. One thing to confirm on the on-prem
instance when it is reachable: whether `screenshotsEnabled` is true there.

---

### 5. How the graph reaches the container — **stdio, and stdout is the transport**

**Decided: `docker run -i`. The graph owns the container's lifetime. `CMD` is
`node fixture/mcp-server.js`. No second port.**

[013](013-agent-graph.md) §1f already settled one MCP client for the whole run
over stdio transport, for a reason it calls catastrophic to get wrong: the server
*is* the fixture, so a second session is a second browser, a second scan and a
second saved test. A listening container would either contradict that or add a
transport hop for one process talking to its own child. So this decision is 013's
applied, not a new one — but three consequences are real and are now implemented.

**Why stdio is also right on its own terms:**

- **Lifetime.** The fixture's life and the run's life are the same object.
  A long-lived listening container invites a second client, a reconnect, and a
  resume — and 013 already establishes that resuming after a Python-side crash is
  meaningless, because the fixture died with it and a new fixture means a new
  `testId` and therefore a different run. stdio makes the only correct lifetime
  the only expressible one: stdin closes, the run ends.
- **Attack surface.** The container holds an authenticated axe session and a
  browser pointed at internal page states. A listening MCP port is remote control
  of exactly that, and securing it means inventing authentication for a parent
  talking to its own child.
- **One run, one console.** It is what makes decision 6 tractable: the noVNC
  console maps one-to-one onto a run rather than onto a container that has served
  several.

**Implemented in `docker/`:**

- **Nothing writes to stdout but the MCP stream.** `entrypoint.sh` logs to stderr
  throughout; `render-policy.py`, `record-provenance.py`, Xvfb, x11vnc and
  websockify all go to stderr. Verified: with the entrypoint rendering a policy,
  starting a display, starting noVNC and writing provenance, the container's
  stdout measured **0 bytes**. One stray line would corrupt the JSON-RPC session
  before the first tool call, which is a failure mode with no good symptom.
- `CMD` is `node fixture/mcp-server.js`, and the entrypoint fails in a second
  with a named error if that file is not in the image rather than after bringing
  up a display and a policy. The `--extension=` append is unchanged; everything
  else the fixture needs arrives through the environment, because `docker run -i`
  has no other channel.
- **`AXE_TARGET_URL` is now required** and fails fast. The container's whole
  purpose is to hand over a browser on a page state, and under stdio there is
  nowhere else for that to come from.
- `EXPOSE` does not grow a second port.
- Teardown: `tini` is PID 1, and the entrypoint traps `EXIT`/`INT`/`TERM` and
  kills the display and console children, so closing stdin or killing
  `docker run` tears the run down without orphaning a browser.

The graph's client entry, for a fresh run and for a replay respectively:

```python
{"transport": "stdio", "command": "docker",
 "args": ["run", "--rm", "-i", "--env-file", ".env",
          "-e", f"AXE_TARGET_URL={url}",
          "-v", f"{runs}:/opt/axe/runs", "axedevtools-fixture:005"]}

{"transport": "stdio", "command": "docker/replay.sh", "args": [str(run_dir)]}
```

Same transport either way — see [014](014-observability.md), which is what makes
the second line a real operation.

**Brian's review: not needed.** 013 decided it; this applies it.

---

### 6. noVNC exposure — **loopback, password-gated, view-only by default; interactive permitted and recorded**

**Recommendation: publish `-p 127.0.0.1:6080:6080`, never `0.0.0.0`. Keep the
password gate. Keep view-only as the default. Permit `AXE_VNC_INTERACTIVE=1`,
and record every use of it.**

x11vnc binds loopback inside the container and websockify listens on the
container's `0.0.0.0`, so the *publish* is what decides reachability and it
belongs in the run command. `make fixture` publishes to `127.0.0.1` and refuses
to start without `AXE_VNC_PASSWORD`.

**The product call, stated as a trade rather than a preference.** The console
shows a live browser and records nothing — [014](014-observability.md)'s opening
argument. Its value is watching an unattended four-hour run and rescuing a stuck
one; its cost is that a human can change what the audit saw, and a draft a human
reviews in 5–30 minutes rests on the findings being the agent's.

Those two are not actually in tension, because the requirement is not that nobody
touches a run. It is that **a run somebody touched must not look like a run
nobody touched.** So interactive is permitted, and made visible instead of
forbidden:

- provenance records `console.enabled` and `console.interactive` for every run;
- x11vnc's `-afteraccept` and `-gone` hooks append `console_attached` and
  `console_detached` to the run trace, with the client address and whether the
  session was drivable — implemented in `docker/vnc-event.sh`;
- a draft whose trace contains a `console_attached` during an interactive session
  should say so on its face.

Default stays off, which is the safe end and ships without a decision.

**Brian's review: required for the interactive half.** Whether an operator may
drive a run at all is a product call about what the draft is allowed to be. The
recommendation is yes, because a stuck four-hour run rescued is worth more than a
purity that gets abandoned the first time somebody needs it — provided the rescue
is on the record.

---

### What changed in `docker/`

Built and exercised end to end on this machine after every change: policy
applied, extension loaded as `lhdoppojpmngadmnindnejefpokejbdd`, session minted,
refresh grant accepted.

| File | Change |
|---|---|
| `Dockerfile` | `CMD` → `node fixture/mcp-server.js`; `AXE_SOURCE_REVISION` build arg and `AXE_BASE_IMAGE`/`AXE_RUNS_DIR`/`AXE_ISSUE_SCREENSHOTS` env; run directory created and owned by `pwuser`; the two new scripts copied |
| `entrypoint.sh` | every log line to stderr, for the stdio transport; `AXE_TARGET_URL` required; run directory and trace created before anything starts; fixture entrypoint existence checked before a display is brought up; VNC attach/detach hooks; provenance written after the policy and before the fixture |
| `render-policy.py` | issue screenshots on, gated by `AXE_ISSUE_SCREENSHOTS` |
| `record-provenance.py` | new — the container's half of a run's provenance |
| `vnc-event.sh` | new — console attach and detach as trace events |
| `replay.sh` | new — [014](014-observability.md)'s replay operation |
| `Makefile` | `make image`, `make fixture`, `make replay` |

### Notes for CONTEXT (not edited, per the constraint)

1. ***The fixture***: "Extension settings come from Chrome managed-storage policy
   baked into the image — server URL, accessibility standard, login mode." It is
   13 keys of 20, and the sentence is worth widening, because the reason it is 13
   is that **Deque's defaults are not neutral** — telemetry on and aimed at
   `usage.deque.com`, ML on, needs-review counted, ruleset 2.1 AA. The standard is
   `wcag22aa`.
2. ***The fixture*** needs a sentence on the renderer sandbox once decision 2 is
   made, in either direction. Today's posture — unsandboxed everywhere, by
   Playwright's default rather than by choice — is not recorded anywhere and
   should not be discovered from `chrome://sandbox`.
3. ***The fixture***: the container now takes `AXE_TARGET_URL` and keeps a run
   directory; the graph reaches it over stdio with `docker run -i`.
4. ***Design rules***, "Reserve screenshots for tests that are inherently
   visual", is about *our* evidence images and stands. Worth adding that the
   extension attaches its own screenshot to every filed issue, and that this was
   measured not to collide with Playwright's CDP session.
5. **A correction for [004](004-login-at-fixture-start.md)**, which I cannot edit:
   `/api/internal/server-info` does not short-circuit on the dev instance. It
   returns a full document including `screenshotsEnabled: true` and
   `version: 6.1.0`.
