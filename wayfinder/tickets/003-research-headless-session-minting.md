---
id: 003
title: Research the auth flow for minting an extension session headlessly
labels: [wayfinder:research]
state: closed
assignee: brian
blocked-by: []
---

## Question

How does a headless container obtain a valid axe DevTools session against a self-hosted axe DevTools Server?

## Resolution

Superseded on the main question: v0 logs in with `AXE_USER_EMAIL_ADDRESS` and `AXE_USER_PASSWORD` at fixture start. See [Choose the v0 auth path](015-v0-auth-path.md). The findings below stay live because they bear on how a session survives a four-hour run.

> **Corrected by measurement.** The lifetimes below are Keycloak defaults, not this realm's. Measured: access token **90 min**, refresh token **~20 days**, and a `refresh_token` *is* present. See [Log the extension in at fixture start](004-login-at-fixture-start.md).

**Token lifetimes are the risk, not obtaining the token.** Keycloak realm defaults: access token 5 minutes, SSO Session Idle 30 minutes (reset by each refresh), SSO Session Max 10 hours. A four-hour run sits comfortably inside Session Max and far outside a single access token's life. Whether that matters depends on whether the extension holds a refresh token — settled empirically in [Log the extension in at fixture start](004-login-at-fixture-start.md).

**Fallback if UI login resists automation.** The same two credentials work as a direct grant: `POST {auth-service-url}/realms/{realm}/protocol/openid-connect/token` with `grant_type=password` and `client_id={auth-service-public-client-id}` — the same public client the extension uses. Direct Access Grants is enabled by default on new OIDC clients, so no server reconfiguration. Seed the result into `chrome.storage.local` through the extension's MV3 service worker after `launchPersistentContext`, before showing the panel.

**Two traps on the extension ID**, consequential for [Obtain the axe extension as an unpacked bundle](002-obtain-unpacked-extension.md):

- Managed policy is keyed on extension ID `lhdoppojpmngadmnindnejefpokejbdd`. An unpacked copy keeps that ID **only if `manifest.json` retains the CRX `key` field**. Otherwise Chrome derives the ID from the absolute path and the policy silently does nothing.
- The on-prem installer takes `--extension-id`, so the server likely validates the calling `chrome-extension://` origin. A repacked extension with a different ID may be rejected server-side too.

**Chromium policy paths, confirmed from Chromium source** (`components/policy/core/common/policy_paths.cc`): plain Chromium reads `/etc/chromium/policies`, branded Chrome reads `/etc/opt/chrome/policies`, Chrome for Testing reads `/etc/opt/chrome_for_testing/policies`. Deque documents only Windows registry and macOS plist, but the `3rdparty/extensions` mechanism is browser-level and platform-independent.

**`@deque/axe-auth` is out for containers.** It requires a working D-Bus Secret Service; Deque's own docs warn that headless environments may not have one.

**Undocumented, needs a Deque rep:** whether the on-prem Account Portal issues API keys at all, and whether any API key can authenticate the *browser extension* rather than the MCP server or CLI. Nothing documents the extension accepting one — treat it as false until told otherwise.
