---
id: 016
title: Point the fixture at the enterprise instance
labels: [wayfinder:task]
state: open
assignee:
blocked-by: []
---

## Question

The fixture authenticates against `axe.deque.com` with an account whose panel reads *"Your free trial of axe DevTools ends in 14 days."* [CONTEXT.md](../../CONTEXT.md) records the licence as enterprise, on-premises, self-hosted.

Which is right, and what should `AXE_SERVER_URL` be?

This matters beyond tidiness:

- **A trial expires.** Every prototype and skill file built against this account stops working on a known date.
- **Capability differs.** [Log the extension in at fixture start](004-login-at-fixture-start.md) found the extension short-circuits `/api/internal/server-info` when the server URL is exactly `https://axe.deque.com`, returning a hardcoded `isOnPrem: false, mlServiceEnabled: true, screenshotsEnabled: true`. So nothing measured against SaaS tells us what the enterprise instance reports.
- **The panel differs.** The trial offers `Enable automated IGT (uses AI credits)`, which CONTEXT records as outside the contract. Findings about which controls exist are not transferable between the two.
- **Managed policy targets a server.** [Settle the container spec](005-container-spec.md) renders `AxeURL` from this value.

Resolve by setting `AXE_SERVER_URL` to the on-prem origin and re-running `make login` and `make probe` against it, or by recording in CONTEXT that development runs against SaaS deliberately and what that costs.

If the enterprise instance is unreachable from a developer machine — VPN, allowlist — that is itself the answer, and the constraint belongs in CONTEXT so nobody rediscovers it.
