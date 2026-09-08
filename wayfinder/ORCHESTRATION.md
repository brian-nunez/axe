# Orchestration — for the session driving this work

Written for the main session, to survive a compaction. Everything else in this repo describes the *system*; this describes the *job*, and the parts of it that live only in conversation.

Read [AGENTS.md](../AGENTS.md) and [CONTEXT.md](../CONTEXT.md) for the system. Do not restate them here.

## The product, in Brian's terms

American Express runs an accessibility platform over millions of pages, emails, PDFs and mobile screens. Six developers own it. Automated axe-core scanning already runs at scale.

**What it does not cover is the four hours of human work after the scan** — the Intelligent Guided Tests, and the 16 page state tests. Full assessment authority takes four weeks of training; two subject matter experts in the whole company hold final say. Third-party auditing runs north of $100 a page, and development teams ship daily, so hiring cannot close the gap.

**The goal is not to replace auditors.** It is to move four hours of auditing into an agent, so a human *reviews* instead of *produces* — 5 to 30 minutes, because reviewing is faster than auditing.

Constraints Brian set, in his words or close to them:

- **"We're not going to recreate it."** The licence buys Deque's expertise. When Deque changes a question, the agent answers the new question. No rule set of ours, no standards treadmill, no derivative-work exposure.
- **Throughput is quarterly, not real-time.** Three months to scan a page. A run taking a week is fine. Priority queueing later if wanted.
- **$20–50 a scan is fine.** The incumbent is $100+. Worry about whether it works, not what it costs.
- **Screen reader tests are out.** Auditors run those by hand. 13 of 16 is the target, against a baseline of zero.
- **It must run on any model**, which is why LangChain and not a vendor SDK.
- **One URL, one page state.** The agent does not discover states.

## What "done" means

**A completion criterion a unit can satisfy without doing its job is not a bar.**

This was the expensive lesson of the whole effort. Ticket 025 was closed on *"a run that completes both units"* — and a unit completes while its guided test is abandoned and nothing reaches the saved test. Five clean runs by that bar had a guided-issue column of `1, 1, 0, 0, 0`. The work was reported as done; it could not complete one test.

So, when setting a bar:

- **Name the artefact, not the activity.** "≥1 guided issue in the ledger", not "the IGT unit completes".
- **A rate, not an instance.** One success is one success. Five consecutive is a claim.
- **Verify by running it yourself.** An agent's report of its own success is the least reliable artefact available — which is exactly what the graph's own reconciliation says about a model's account of what it filed.

## True state

Current as of the last verified run. Check [MAP.md](MAP.md) for anything closed since.

**Works, verified by running it directly:**
- `make v0-scripted` — deterministic, clean every time: 1 guided, 2 manual.
- `make v0` with the local model — **one run** at the real bar: 7 guided issues, 2 manual, IGT completed on attempt 1, no retry, no halt.
- The fixture, the MCP server, the graph, the ledger check, the container, the catalog mapping, the pinned extension build.

**Not done:**
- **One finding still lost to fabrication** ([029](tickets/029-unfiled-fail-leaves.md)). A leaf declares a `fail`, names the catalog entry, never calls `add_manual_issue`. The reconciliation catches and strips it, so nothing wrong is filed — but the finding never reaches the saved test. *The fix is known:* the issue string sits in the skill file where the model can copy it into the report; `add_manual_issue` returns `recordedLocation`, Deque's own selector construction, which is not guessable. Require that in the record and fabrication becomes impossible.
- **One run is not a rate.** The model bar has been met once.
- **14 of 16 page state tests have no skill file**, and most need predicates that do not exist.
- **No production model has ever run against this fixture** — no API key on the machine. This blocks every judgement question in [018](tickets/018-vision-on-the-dev-model.md) and [026](tickets/026-local-model-tool-discipline.md).
- **No request timeout on the model client** ([028](tickets/028-model-request-timeout.md)). A stalled turn hangs a run with no disposition covering it.
- **Everything is measured against a SaaS trial account, not the on-prem instance** ([016](tickets/016-point-fixture-at-enterprise.md)). The extension hardcodes capability flags for `axe.deque.com`, so nothing measured tells us what the real instance reports. **Only Brian can close this** — the URL and the network are his.

## Working with Brian

- **Bullets, not prose. State the problem, then the exact fix.** Long paragraphs go unread.
- **Answer the question asked.** He asked *why did it end* three times while I explained mechanism, then design, then the model — none of which was the question. When a question repeats, the answer is wrong, not the phrasing.
- **Do not report progress as completion.** He caught this directly: *"you didn't explain why you told me it was done when it can't even complete 1 test."*
- **When he says go, go.** He pre-approves and expects execution, not another round of options. Offering to do the thing he just asked for reads as stalling.
- **He is often right about tooling.** Ollama was my pick and it manufactured a false finding — 2/6 vs 6/6 on identical weights. He called it "not effective" before any evidence existed. Take that class of correction seriously and immediately.
- **Own errors plainly and move on.** State the correction, do not ruminate, do not tally.

## Things I got wrong, so they are not repeated

- **Chose Ollama, then measured through it, then wrote the result into CONTEXT as a fact about the model.** Ticket 026's own instruction was to check the serving layer first. The tell was there: the leaf died at *exactly* four tool calls, six times — a constant, not a distribution.
- **Closed 025 on one successful run**, and let an agent's framing — *"the spine holds, the local model does not"* — become my summary. That sentence assigns blame between components; it does not say whether the thing works.
- **Wrote a policy uniformly without asking where it fit.** `retryable: false` on `wrong_screen` came from the ledger-loss argument, applied to a refusal that names its own recovery. Three layers all said *stop* and none distinguished "the ledger is gone" from "you called the wrong tool for this screen".
- **Armed a watcher on a file the harness rewrote**, so it polled forever — the same orphan I had criticised agents for an hour earlier.
- **Put the wrong Linux policy path into two tickets** by generalising a macOS fact, overriding a correct assumption in the process.

## Running agents

- **Give a bar, not a task.** Name the artefact, forbid the shortcuts explicitly — *do not swap the model to pass, do not weaken the check to pass, do not lower the bar; if you cannot reach it, say so in the first line with the evidence.*
- **Serialise anything that runs the browser.** Two agents measuring at once stalled both and killed one for 600s of no progress.
- **Give file ownership per agent** and say who owns what, or they collide.
- **Tell them not to edit `MAP.md` or `CONTEXT.md`** — consolidate those yourself, or concurrent agents fight over one file.
- **Expect the report to be optimistic.** Read the numbers, not the summary. Check the column that matters rather than the one they led with.
