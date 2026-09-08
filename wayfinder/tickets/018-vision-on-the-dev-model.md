---
id: 018
title: Settle how image-requiring branches are developed
labels: [wayfinder:grilling]
state: closed
assignee: brian
blocked-by: [011]
---

## Question

Development runs on a small local model. Several branches only work if that model can see.

[Settle the tool inventory and the MCP boundary](011-tool-inventory.md) put `Evidence` in every tool's return, with an `image` variant. `reference/page-state-tests.json` says where it fires: the whole of page state test 6 Sensory Characteristics, the whole of test 9 Text Resize Reflow and Spacing, and one branch of test 5 Static Content. The IGT screenshot policy table will add more, since the same mechanism answers *does this look like a heading?* questions Deque asks in prose.

CONTEXT says production runs on Gemini, GPT, or Claude — all of which see — and development runs on a small local model, which may not. If it does not, three of the sixteen tests cannot be exercised locally at all, and the skill files for them get written against a model that cannot run them.

Decide: does the development model need vision as a hard requirement, or do the image branches get developed some other way — a text description synthesised by a tool, a deferred lane run only against a production model, or those tests held back the way the screen reader ones are?

Note that holding them back is not free: tests 6 and 9 are two of the thirteen that CONTEXT counts as v1's real coverage, and losing them takes that to eleven.

Resolve with a decision on the development model's vision requirement and, if it lacks vision, what happens to those branches.

## Resolution

**Vision is a hard requirement on the development model. It costs nothing — both models Brian named accept image input.** The image branches are developed exactly like every other branch, against the local model, with one qualification: the local model's *verdicts* on those branches are not evidence that the branch is right.

### What the models actually do

Researched against Google's own model cards and the DeepMind model page, not from memory.

Gemma 4 shipped **2 April 2026** under Apache 2.0 — E2B, E4B, 26B A4B MoE, 31B Dense — with a **12B Unified** added **3 June 2026**. Both names Brian gave are real, and the naming needs no correction: `E2B`/`E4B` originated with Gemma 3n but Gemma 4 carries the same convention forward, and Gemma 4 does have a 12B.

| Variant | Params | Context | Image input | Vision encoder |
|---|---|---|---|---|
| **E2B** | 2.3B effective | 128K | **yes** | ~150M |
| E4B | 4.5B effective | 128K | yes | ~150M |
| **12B Unified** | 11.95B | 256K | **yes** | encoder-free |
| 26B A4B MoE | 25.2B / 3.8B active | 256K | yes | ~550M |
| 31B Dense | 30.7B | 256K | yes | ~550M |

The model card is unambiguous: *"Gemma 4 models are multimodal, handling text and image input (with audio supported on E2B, E4B, and 12B models) and generating text output."* Every size sees. The claimed vision skills are the right ones for this project — screen and UI understanding, OCR, document parsing, chart comprehension — and images are accepted at variable aspect ratio and resolution through a configurable visual token budget of 70, 140, 280, 560 or 1120 tokens, with Google's own guidance to use the high end for OCR and small text.

So the ticket's premise — that the development model may not see — is false for the target Brian picked. E2B runs under 1.5 GB and still takes a screenshot.

**Seeing is not judging.** This is where the honest number sits:

| | E2B | E4B | 12B | 31B |
|---|---|---|---|---|
| MMMU Pro | 44.2% | 52.6% | 69.1% | 76.9% |
| OmniDocBench 1.5 (lower better) | 0.290 | 0.181 | 0.164 | 0.131 |

E2B accepts the image and answers. It answers 25 points worse than the 12B on multimodal reasoning. *Is this instruction relying on colour alone* is exactly the kind of question that gap eats.

### The decision

**1. Vision is a hard requirement on the development model.** Not a preference. A dev model without image input cannot exercise three of the sixteen tests, and the requirement is free — it rules out nothing Brian wants to run.

**2. No tool-synthesised text description.** The ticket's own framing settles it: a tool that describes a rendered page well enough to answer *does colour alone carry this* has made the judgement and handed the model a conclusion to transcribe. That is the design rule inverted — tools compute *decidable* things and return a verdict with a named leaf; they do not narrate a page so the model can pretend to judge it. The rule that keeps `check_link_in_text_distinction` honest with `undecidable` is the same rule that forbids this.

**3. Nothing is held back. Coverage stays at 13 of 16.** Holding tests 6 and 9 back would trade 15% of the deliverable for a problem that does not exist. The screen reader exclusion is not a precedent here — tests 2, 10 and 13 are out because *no* model in the design, production included, drives a screen reader. Tests 6 and 9 run fine on Gemini, GPT and Claude, and now on the dev model too. An excuse that applies only to the development environment is not a reason to cut what ships.

**4. Development proves the plumbing; a production model signs off the judgement.** This is the one real concession, and it is narrower than the ticket's "deferred lane".

Two different things get confirmed for tests 5 (graphical contrast branch), 6 and 9:

- **Shape** — the tool returns an `Evidence` with `kind: "image"`, the image reaches the model through the local runtime, the model routes to a named leaf, `add_manual_issue` files the mapped catalog entry, the ledger count rises. That is authoring, it is what the other thirteen skill files prove, and E2B proves it.
- **Judgement** — the leaf that fired is the right leaf for that page. That is not settled locally. A green run of skill file 6 against E2B means the file is wired, not that it is correct.

So: **a skill file whose branches carry `requiresScreenshot` is not done until it has been run once against a production model on the same fixture and the leaves agree.** One extra run per file, three files. It is the cheapest gate in the project and it stops E2B's 44% from being mistaken for a passing grade.

### Implementation notes

- **Pin the visual token budget at the top of the range (1120) wherever an image is passed to the dev model.** Test 6 asks about error text, focus indication and small icon cues; a page screenshot at 70 or 140 tokens will not carry them. The budget is a per-request knob, so this is configuration, not architecture.
- **Smoke-test the image path through the local runtime before authoring skill file 6.** Ollama serves Gemma 4 edge models with image input on its multimodal engine, and llama.cpp has the multimodal projections published — but the failure mode for local vision is almost never the weights, it is the serving layer or the LangGraph message adapter silently dropping the image part. One round trip proving a screenshot arrives is worth more here than any of the above.
- **The fallback tripwire is named, not felt.** Brian's "12B if the smaller one struggles" gets a concrete trigger: if skill files 5, 6 or 9 disagree with the production model's leaves on more than an occasional page, move development to 12B. Those three files are where E2B's weakness surfaces first; the other thirteen will not tell you anything. 12B runs locally on 16 GB of VRAM or unified memory, so the fallback is real, not aspirational.

### For Brian

**CONTEXT.md** — one clause, in *Run shape*. Current text reads:

> Production runs on Gemini, GPT, or Claude; development runs on a small local model.

Suggested:

> Production runs on Gemini, GPT, or Claude; development runs on a small local model, which **must accept image input** — tests 5, 6 and 9 hand the model a screenshot, and a dev model that cannot see cannot run three of the sixteen.

**A follow-up worth opening.** Test 9's `requiresScreenshot: true` sits on the whole test, and one of its four branches does not deserve it: *at a 320px viewport width, horizontal scrolling is needed* is `scrollWidth > clientWidth` — a measurement with a bright-line threshold, the same species as `check_target_size`, not a judgement about a picture. Computing it does not make the tool the judge. That would take test 9 from four visual branches to three and shrink the surface that depends on the model's eyes at all. It is a seventh predicate against 011's six, so it belongs in its own ticket rather than here.
