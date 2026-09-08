---
id: 023
title: Amend the tool inventory and the report block for the graph
labels: [wayfinder:task]
state: closed
assignee: brian
blocked-by: []
---

## Question

[Settle the agent graph](013-agent-graph.md) could not be built from [Settle the tool inventory](011-tool-inventory.md) as written. Five amendments, each small, each blocking.

**Four to 011's inventory:**

1. **`restore_page()` must also return the panel to the overview.** A reload does not move the panel. A manual leaf that ends on the Add Manual Issue form leaves it there, and the next ledger gate reads `panel-elsewhere` almost every time — a recoverable verdict fired on every single unit, which trains everyone to ignore it.
2. **`reopen_saved_test()` does not exist.** [Detect ledger loss](010-ledger-loss-detection.md) names reopening the run's test from *view saved tests* as the bounded recovery for `panel-detached`, and 013 assigns that recovery to the graph because `fixture/ledger.js` has no reopen logic. Neither side has the tool.
3. **`save_progress_and_quit()` does not exist.** [Settle what page state changes an in-progress IGT survives](017-igt-page-state-tolerance.md) asked for it. Without it, a leaf that dies mid-IGT leaves a test in progress, and every later restore is unsafe. Note it lives in the `Options` menu, not on the question screen — 008's correction.
4. **`page_state_warning()` / `pageStateChanged` on `Screen`.** 017 asked for it and `readPanel` already computes it, so this is free. Without it the graph cannot tell a banner-carrying screen from a clean one.

**One to [Settle the skill file format](012-skill-file-format.md):**

5. **The closing YAML report should be the argument of a `finish_unit` tool, not free text.** Free text means the parent parses prose from a 2B model to learn whether the unit finished. A tool call is structured, and it gives the graph an unambiguous completion signal. Held-back files then carry `tools: [finish_unit]` rather than `tools: []` — still structurally unable to touch page or ledger.

Do these before the MCP server is built. Four of the five are contract changes, and retrofitting a tool contract after the graph is written costs more than the ten minutes it costs now.
