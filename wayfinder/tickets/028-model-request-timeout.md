---
id: 028
title: The model client has no request timeout
labels: [wayfinder:task]
state: open
assignee:
blocked-by: []
---

## Question

`graph/run.py` builds the leaf's model with no request timeout. [Build v0](025-build-v0.md)'s five-run sequence hit the consequence: two agents contended for the single local model runtime and **one unit stalled past 40 minutes** with no error, no log line, and nothing in the graph that could tell it from progress.

That is the one failure shape none of the design covers. [013](013-agent-graph.md) has six dispositions and a `steps` cap, but every one of them assumes turns are *happening*. A model call that never returns consumes no steps, trips no cap, and produces no disposition. [010](010-ledger-loss-detection.md)'s gate never runs because the unit never ends. Against a four-hour budget across 23 units, one silent stall eats the run.

Settle:

1. **A per-request timeout on the model client**, sized against what a leaf turn actually costs — the five-run sequence recorded turn latencies to size it from, and an IGT turn carrying four screenshots is the expensive case.
2. **What the graph does on a timeout.** It is not a ledger verdict and not a tool refusal; it is a new failure mode. Most likely a disposition of its own, since a stalled turn says nothing about whether the ledger is intact and the existing retry rule — retry once if nothing was filed — may well apply unchanged.
3. **A wall-clock budget per unit**, separate from the `steps` cap. A unit that spends forty minutes making slow progress is as fatal to a four-hour run as one that hangs, and the steps cap cannot see the difference.

Worth doing before 23 units run unattended: the whole reason a four-hour run is acceptable is that it is unattended, and an unattended run that can hang forever is not.
