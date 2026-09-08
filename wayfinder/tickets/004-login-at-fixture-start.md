---
id: 004
title: Log the extension in at fixture start
labels: [wayfinder:task]
state: closed
assignee: brian
blocked-by: [002]
---

## Question

Make the container start with the extension already signed in, using `AXE_USER_EMAIL_ADDRESS` and `AXE_USER_PASSWORD`.

The fixture's value is that the agent never handles credentials and never touches a login form. This ticket delivers the step that makes that true: the entrypoint signs in once during fixture setup, before the agent takes over.

Assume the extension's own login flow driven with those credentials. If that flow proves flaky under automation, the same two credentials work as a direct grant against the walnut Keycloak public client, seeded into `chrome.storage.local` — see [Research the auth flow for minting an extension session headlessly](003-research-headless-session-minting.md).

**Settle one fact first, because it decides whether login is a one-time step or a recurring one.** Log in by hand, dump `chrome.storage.local`, and check whether a `refresh_token` is present alongside `access_token`. The observed session shape has none. If that holds, the extension cannot refresh itself, the access token expires in five minutes, and a four-hour run needs the harness to keep the session alive — silently losing auth at hour two would be indistinguishable from the panel misbehaving.

Resolve when a container boots, opens DevTools, shows the axe panel signed in with no agent involvement, and is still signed in four hours later.

## Resolution

Implemented in [`fixture/`](../../fixture). A launch signs the extension in with no UI interaction, and the harness keeps it signed in for the life of a run.

### The blocking fact: a refresh token **is** present

Read from `chrome.storage.local` for the extension, persisted at
`~/Library/Application Support/Microsoft Edge/Default/Local Extension Settings/lhdoppojpmngadmnindnejefpokejbdd/`.
Session lives under the storage key **`session`**. All values redacted; only derived facts recorded.

| Field | Value |
|---|---|
| `access_token` | JWT, `typ=Bearer`, lifetime **90 min** |
| `refresh_token` | JWT, `typ=Refresh`, lifetime **~20 days** |
| `id_token` | JWT, `typ=ID`, lifetime 90 min |
| also stored | `expires_at`, `expires_in`, `refresh_expires_at`, `refresh_expires_in`, `scope`, `session_state`, `token_type`, `not-before-policy` |

**Three assumptions in the map were wrong:**

1. **`refresh_token` is present.** This ticket and [Research the auth flow](003-research-headless-session-minting.md) both recorded "the observed session shape has none."
2. **The access token lives 90 minutes, not 5.** 003 cited the Keycloak realm default; this realm is configured to 5400s.
3. **The refresh token lives ~20 days, not a 10-hour SSO Session Max.**

**And the extension refreshes itself.** Both `background.bundle.js` and `panel.bundle.js` contain the same routine: read `session` and `sso-config` from storage, `POST` to `sso-config.tokenUrl` with `grant_type=refresh_token`, `refresh_token`, and `client_id=publicClientId`; on 400/401 it logs out.

**So login is a one-time fixture step.** A four-hour run fits inside a 90-minute access token that the extension renews itself against a refresh token good for weeks. The harness does not need to sustain the session. That removes the silent-auth-loss failure mode this ticket was written to guard against.

### How the extension authenticates

1. `GET {AXE_SERVER_URL}/api/sso-config` → `{url, realm, publicClientId, mcpClientId}`
2. `openIdConnectUrl = {url}/auth/realms/{realm}/protocol/openid-connect`
3. Stores an `sso-config` object under that storage key: `publicClientId`, `redirectUrl`, `loginUrl`, `logoutUrl`, `tokenUrl` (`{openIdConnectUrl}/token`)
4. UI login is an **authorization-code** flow — `loginUrl` in a tab, Keycloak form, redirect with `code`, exchanged via `grant_type=authorization_code`
5. On success, stores `session`, plus `user` and `hasSeenFirstTimeContent`

Automating (4) in a container means driving a Keycloak HTML form. The direct grant from 003 avoids it entirely and is the more robust fixture path — recommend making it primary rather than fallback, once the target server is settled.

### Capability flags — answers [Confirm axe MCP entitlement and instance capability](001-confirm-axe-mcp-entitlement.md)'s residual

`GET {server}/api/internal/server-info` returns `mlServiceEnabled`, `screenshotsEnabled`, `isOnPrem`, `billingServiceEnabled`, `productInfo`. That is the endpoint 001 wanted.

> **Corrected by [Settle the container spec](005-container-spec.md).** The claim that followed here — that the extension short-circuits the endpoint for `https://axe.deque.com` and never calls it — is wrong. The endpoint **does** answer on our instance, returning `screenshotsEnabled: true` and `version 6.1.0`. Read it rather than inferring capability.

### The extension renews itself only on panel mount

Tested, not inferred. Seed an expired access token, then:

| Trigger | Renewed? |
|---|---|
| Extension popup opened | no |
| **DevTools panel mounted** (`showView`) | **yes** |
| Token expired again with the panel already mounted, page reloaded | no, 60s |

The panel's mount effect calls the refresh routine once. Nothing renews on expiry.

**So login is not a one-time step after all.** A four-hour run crosses two 90-minute boundaries, and the extension will not cross them by itself. Worse, the one native trigger is unusable mid-run: re-mounting the panel means refreshing the extension, which destroys the saved test — the only record of findings until submission.

### The harness sustains the session out of band

[`fixture/keepalive.js`](../../fixture/keepalive.js) renews at half the access token's life: refresh grant, write the result into `chrome.storage.local`, and announce it on the `auth` BroadcastChannel the extension itself uses, so a mounted panel picks up the new token. The panel is never touched, so the ledger is never at risk.

Verified with a compressed 10-second period: three consecutive renewals landed in storage, each valid for a further 90 minutes, panel untouched.

### Login path: direct grant, not the authorization-code flow

The extension's own login is an authorization-code redirect through a Keycloak HTML form. The harness skips it: the same public client accepts `grant_type=password`, confirmed working, and the extension cannot tell the difference once the records land in storage. This was 003's fallback; it is the primary path, because driving an HTML login form in a container is the brittle part of fixture setup and buys nothing.

Seeded into `chrome.storage.local`: `session`, `sso-config`, `user`, `axeServerURL`, `hasSeenFirstTimeContent`.

### How to run it

```bash
python3 tools/build-axe-extension.py --lock vendor/axe-devtools/axe-extension.lock.json --dest build/axe-extension
node fixture/cli.js --extension=build/axe-extension            # login and verify
node fixture/cli.js --extension=build/axe-extension --prove-keepalive
```

Everything is parameterised by `AXE_SERVER_URL`; nothing is hardcoded to a particular server. `sso-config` is discovered at runtime from `GET {server}/api/sso-config`.

### Facts for later tickets

- **The panel id is `chrome-extension://lhdoppojpmngadmnindnejefpokejbddaxeDevTools`** and CONTEXT's `showView` recipe works verbatim under Playwright 1.58.0 headless with `channel: "chromium"`. Confirmed for [Prototype the panel DOM contract](007-panel-dom-contract.md).
- **Playwright is pinned to 1.58.0**, the version whose bundled Chromium is revision 1208 (Chrome for Testing 145.0.7632.6). Extensions cannot load in the bundled headless shell; `channel: "chromium"` runs the full browser headless and can.
- **The extension detects automation.** It checks the user agent for `playwright` and `chromepuppeteer` and suppresses its install-success tab. Benign, and a sign Deque expects automated use.
- **`GET {server}/api/logged-in`** returns the `user` record the extension stores.
- **Development runs against SaaS.** `AXE_SERVER_URL` is currently `https://axe.deque.com`; the enterprise URL and credentials get swapped in later. The extension short-circuits `/api/internal/server-info` when the server is exactly `https://axe.deque.com`, returning `isOnPrem: false, mlServiceEnabled: true, screenshotsEnabled: true` — so capability flags observed in development will not match the enterprise instance. Do not read dev flags as fact.
