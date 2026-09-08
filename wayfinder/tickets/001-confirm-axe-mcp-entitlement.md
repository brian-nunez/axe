---
id: 001
title: Confirm axe MCP entitlement and instance capability
labels: [wayfinder:task]
state: closed
assignee: brian
blocked-by: []
---

## Question

Does this enterprise license include the axe MCP Server, and what does the on-prem instance actually report as enabled?

Deque documents axe MCP Server as part of the `axe DevTools for Web` bundle rather than Extension Pro. Whether this license carries it is an account portal lookup or one question to the Deque rep — it cannot be determined from outside.

The answer changes the plan materially. Deque's MCP server drives the panel with the same technique this project would, and covers the automated scan, `before` steps for form filling, and up to three IGTs. If it is available, part of the tool layer is bought rather than built.

Record what the instance reports for `isOnPrem`, `mlServiceEnabled`, `screenshotsEnabled`, and `advancedRulesEnabled`, so later tickets stop guessing at capability.

## Resolution

**No axe MCP Server.** The license excludes it, along with Automated IGT and ML features and advanced rules. Recorded in [CONTEXT.md](../../CONTEXT.md) under *What we have*, which is the single source of truth for license posture. We were the first customers on this license, so public Deque docs do not describe our feature set — do not reason about entitlement from them.

**Playwright drives the panel.** That was the decision underneath this ticket, and all three candidates are now settled:

- **`chrome-devtools-mcp` — out.** It cannot reach the panel: the panel is an out-of-process iframe, its accessibility tree returns `childIds: 0`, and upstream cross-origin iframe support is closed as not planned. Tested, not speculated.
- **axe MCP Server — out.** Outside the contract. It was never a separate driver in any case: Deque's `axe-mcp-server` sets the same `PW_CHROMIUM_ATTACH_TO_OTHER`, so it drives the panel with Playwright too. It would have competed at the tool layer, not the driver layer.
- **Playwright — in.** Confirmed working, headless included. The recipe is in CONTEXT.md under *Driving the panel*.

**Consequence:** the tool layer is built, not bought. [Settle the tool inventory and the MCP boundary](011-tool-inventory.md) stays a naming decision — name the tools and their return shapes — rather than a boundary-drawing one, since there is no purchased layer to draw a boundary against.

**Capability flags.** `mlServiceEnabled` and `advancedRulesEnabled` are answered by contract: false. `isOnPrem` is true by definition — we self-host the server. `screenshotsEnabled` is the one flag CONTEXT does not settle; it bears on page state tests #5 graphical contrast, #6 sensory characteristics, and #9 content loss, all outside v0. Ticket it when those tests get built, not before.
