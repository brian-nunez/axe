# Moving onto the enterprise instance

Everything in this repo was built and measured against **`axe.deque.com` on a free trial account**. That is not a detail to fix later: the extension hardcodes capability for that hostname, the checklist and catalog were captured from it, and the trial's feature set is not the enterprise one. Until this runbook is done, **no measurement here describes your real instance.**

Work the phases in order. Each ends in a check that fails loudly rather than a step that looks like it worked.

---

## Phase 0 — what you need before starting

| | Where it comes from |
|---|---|
| The on-prem axe DevTools Server origin | your Account Portal, or the team that installed it |
| An enterprise account with a Pro seat | your own, or a service account — see Phase 2 |
| Network reach to that origin from wherever the container runs | your network team. VPN or allowlist |
| The private CA bundle, if the instance uses one | your PKI team |
| A production model API key | still missing everywhere. See Phase 6 |

If the instance is unreachable from a developer machine, that is itself the answer and it changes the plan — say so and stop at Phase 1.

---

## Phase 1 — reach the instance

```bash
export AXE=https://axe.your-domain.example
curl -sS -H 'Accept: application/json' "$AXE/api/internal/server-info" | jq
```

**Expect** `isOnPrem: true` and a `version`. On SaaS this returns `isOnPrem: false` — if you see that, `AXE` is still pointing at Deque.

`Accept: application/json` is not optional. The SPA answers `200 text/html` to any unrouted path, so a check without it reads success out of a web page.

Record `mlServiceEnabled`, `screenshotsEnabled` and `advancedRulesEnabled` — CONTEXT assumes ML features are absent, and this is where that gets confirmed rather than believed.

**Private CA.** If TLS fails, the instance uses an internal CA. Two places need it, and missing either produces a different confusing error:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/ca-bundle.pem   # Node's fetch
# Chromium reads its own store — the container installs into ~/.pki/nssdb
```

**Check:** `server-info` returns JSON with `isOnPrem: true`.

---

## Phase 2 — credentials and the auth flow

Put the enterprise values in `.env`:

```
AXE_SERVER_URL=https://axe.your-domain.example
AXE_USER_EMAIL_ADDRESS=...
AXE_USER_PASSWORD=...
```

The fixture does **not** drive the login form. It mints a session with a direct grant against your Keycloak and seeds it into `chrome.storage.local`. That path is discovered at runtime:

```bash
curl -sS -H 'Accept: application/json' "$AXE/api/sso-config" | jq
```

**Expect** `url`, `realm`, `publicClientId`. The fixture builds the token endpoint from those.

**The one thing that may not carry over:** the direct grant needs **Direct Access Grants** enabled on that public client. It is on by default for new Keycloak clients, but an enterprise realm may have had it turned off deliberately. If Phase 2's check fails with `invalid_grant` or `unauthorized_client`, that is what happened — ask whoever administers the realm, and see *Fallbacks* at the end.

**Prefer a service account over a person.** A run holds a live session, a refresh token good for weeks, and the password in the environment. Tie that to a provisioned identity, not to someone's staff account, and tag it so agent runs are distinguishable from human ones in any audit.

```bash
make login
```

**Check:** prints `loaded as lhdoppojpmngadmnindnejefpokejbdd`, your realm and client id, a token lifetime, and `refresh_token true`. Note the lifetime — ours was 90 minutes; yours may differ, and `fixture/keepalive.js` renews at half of whatever it is.

---

## Phase 3 — re-capture Deque's material from *your* instance

**Do not skip this.** `reference/` holds Deque content captured from the SaaS trial. Your instance serves its own copy, and the extension you run may be a different version.

### The 16 page state tests

The Remaining Testing guide is served by *your* server:

```
$AXE/coverage-page-state
```

It is a login-gated SPA — an unauthenticated fetch returns an empty shell — so open it in a signed-in browser and compare against [`reference/page-state-tests.json`](reference/page-state-tests.json). Check the test count, the branch conditions, and the issue slugs. If they differ, re-capture; [`reference/README.md`](reference/README.md) documents the shape and which parts are paraphrase versus verbatim.

### The manual issue catalog

```bash
make catalog        # writes build/manual-issue/catalog.json
make check-mapping
```

**Check:** `check-mapping` passes. It re-derives the slug set from the checklist, matches every option text verbatim against the catalog, and verifies every skill file files something the mapping sanctions.

**If it fails, that is the migration working.** A different extension version means different catalog entries, and [`reference/issue-mapping.json`](reference/issue-mapping.json) is 103 hand-mapped branches keyed to exact option text. The checker tells you precisely which rows moved. Fix those rows; do not weaken the checker.

---

## Phase 4 — re-pin the extension

Your instance may expect a version other than the pinned 4.135.0, and the server validates the calling extension origin against its installer's `--extension-id`.

```bash
make crx-latest     # downloads the current release
```

Then move the CRX into `vendor/axe-devtools/`, update `crx`, `version`, `sha256` and `retrieved` in `vendor/axe-devtools/axe-extension.lock.json`, and:

```bash
make extension
```

**Check:** the build succeeds and `make login` still reports `loaded as lhdoppojpmngadmnindnejefpokejbdd`. If the ID changed, the manifest lost its CRX `key` and **managed policy will silently apply to nothing** — the build refuses this, which is why it is a hard failure rather than a mystery later.

---

## Phase 5 — policy and container

`docker/render-policy.py` builds the managed-storage policy from `.env`. Confirm the key set is right for you — 13 of the extension's 20 keys are set deliberately, because **not setting a key chooses Deque's default**, and four of those defaults are ones this project would not pick.

Two you must decide before running at volume:

- **`DataGather` and the four `UsageService*` values.** Telemetry is off, and the plumbing is wired but empty. Left at Deque's default it ships to `https://usage.deque.com`, and the client **downgrades to plain HTTP on connection refusal** — scan telemetry about Amex pages, in the clear. Supply an explicit internal `AXE_USAGE_SERVICE_URL` and the organization / department / application strings, or leave it off.
- **`AccessibilityStandard`.** Set to `wcag22aa`. If your instance has an org-wide standard configured, policy wins locally and would silently disagree with your dashboards.

```bash
make image
make fixture TARGET_URL=https://www.americanexpress.com/some-page
```

**Check:** `chrome://policy` in the container shows a table titled *axe DevTools - Web Accessibility Testing* with all 13 keys at Source `Platform`, Scope `Machine`, and no errors. Watch it through noVNC.

**Renderer sandbox is currently off** — Playwright's default, inherited rather than chosen. The renderer parses arbitrary pages while the process holds a live session and the password. For a bank this is a posture decision, not a container detail: turning it on needs a line in `fixture/launch.js` and a targeted seccomp profile.

---

## Phase 6 — the model

**Development** runs Gemma 4 E2B on Docker Model Runner. It reaches the bar locally but its *judgement* is unproven — it picks the right branch about half the time on judged branches.

**Production** runs Gemini, GPT or Claude. Nothing has ever run against a production model here, because no API key exists on the development machine. It is one line:

```bash
make v0 AXE_MODEL=anthropic:claude-sonnet-5 AXE_TARGET_URL=...
```

**Two things to settle at enterprise scale:**

**Docker Model Runner does not exist on GKE.** It is a Docker Desktop feature. If any production path is meant to use a local model, it needs a served llama.cpp endpoint of its own — the graph talks OpenAI-compatible, so any such server works via `AXE_MODEL_KWARGS`. If production is hosted models only, this is moot.

**Egress.** A hosted model means the page content the agent reasons about leaves your network. That is a review your security team owns, and it is the reason a local model path may matter to you more than it does to the design.

---

## Phase 7 — verify end to end

```bash
make v0-scripted                                   # deterministic, no model
make v0 AXE_TARGET_URL=https://<a real page state>
```

**Check the ledger line, not the unit dispositions.** A unit can report `completed` while its guided test was abandoned and nothing reached the saved test. What you want:

```
ledger  N issues — N automatic, >=1 guided, >=1 manual
```

Then open the saved test in the extension and confirm the issues are there in Deque's own words. **The saved test is what travels to the auditor; the draft is not.**

Run it five times. One success is one success.

---

## Phase 8 — for your Deque rep

Questions that have been outstanding through the whole build and only they can answer:

1. **A distributable extension bundle** for containerised use — is extracting from the Web Store CRX the expected path for a self-hosted customer, or do you supply one?
2. **Driving the extension programmatically at volume** — automated, unattended, many page states per day. Within terms?
3. **Version pinning.** The Web Store endpoint serves only the current release. Is there a supported way to pin, and what is the release cadence? Our tool layer reads the panel's DOM, so a release that rewords the UI is a break.
4. **Two checklist branches have nothing fileable in your catalog** — a browser-shortcut collision under 2.1.1, and a non-form change of context under 3.2.2 whose wording exists only under 3.2.5. Those findings currently reach our output and never the saved test.
5. **A saved test shows an abandoned IGT as `completed: true`** with zero issues, because *Save progress & quit* marks the guide as run. To a reviewer that reads as "checked and clean". Is there a way to distinguish it?

---

## Fallbacks, if a phase fails

**Direct Access Grants disabled (Phase 2).** The fixture would have to drive Keycloak's HTML login form — brittle, and the reason it was avoided. Before building that, ask whether a service-account client with the grant enabled can be provisioned for this use.

**The instance is unreachable from developer machines (Phase 1).** Then development moves to a host inside the network, and `.env` plus the container go with it. Nothing in the design assumes a developer's laptop; the fixture is a container and the graph talks to it over stdio.

**`check-mapping` fails after re-capture (Phase 3).** Expected if the extension version moved. The checker names each row that no longer resolves. This is hand work on `reference/issue-mapping.json`, and it is the one place where being wrong files a wrong issue on a real audit — so fix the rows, and leave a row `low` confidence rather than guessing it `high`.
