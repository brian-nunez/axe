---
id: 029
title: The manual leaf reports findings it never filed
labels: [wayfinder:task]
state: open
assignee: brian
blocked-by: []
---

## Question

[Build v0](025-build-v0.md) closed on five consecutive clean runs and recorded, as
the thing still wobbling, that *three of the five manual reports claimed a
`filed:` that no call had made*. [026](026-local-model-tool-discipline.md) counted
the same shape at three of six. It recurs. From an independent run, verbatim:

```
manual:11  [completed]  7 tool calls, ledger after: intact
  filed  Captions are not available for recorded multimedia (1.2.2.a, rgaa-4.3.1)
         against body > video#briefing:nth-of-type(1)
  check 11.4  fail  leaf 11.4.captions-missing  subject #briefing
  check 11.5  pass  leaf 11.5.pass  subject #briefing
  check 11.6  fail  leaf 11.6.transcript-missing  subject #briefing
         UNVERIFIED claim, stripped: No text or audio description available for multimedia content (1.2.3.a, rgaa-4.1.3)
  reconciliation [claimed_not_filed] the report claims '…' but no tool filed it
```

Check 11.4 filed correctly. Check 11.6 declared a `fail`, named the catalog
entry, and never called `add_manual_issue`.

[013](013-agent-graph.md)'s reconciliation caught it, which is the design
working. But **a stripped claim is a lost finding**: the page genuinely carries a
video with no transcript, and the saved test the auditor opens does not say so.
Catching a fabrication is not the same as filing the issue.

Find out why the leaf writes a `fail` record without making the call, and fix it.
The reconciliation does not move — it is the check that caught this and it stays
exactly as strict. The default model does not move either.

**Closes on five consecutive `make v0` runs where the manual unit's report
carries no `claimed_not_filed` entry, and every `fail` leaf it reports has a
matching filed issue in the saved test.**
