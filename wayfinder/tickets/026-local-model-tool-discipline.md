---
id: 026
title: The local model will not reliably emit tool calls
labels: [wayfinder:grilling]
state: closed
assignee: brian
blocked-by: []
---

## Question

[Build v0](025-build-v0.md) ran the finished graph nine times against `gemma4:e2b`. The deterministic tiers were correct in all nine — retry, `igt_abandon`, restore, gate, next unit, no ledger lost, no draft printed that should not have been. **Two runs completed both units.**

| Leaf | Completed | Filed |
|---|---|---|
| manual:11 | 7 of 9 | 5 of 9 |
| igt:structure | **2 of 9** | — (both on the retry) |

**The failure has one shape: the model stops emitting tool calls and answers in prose.** `gemma4:12b` was no better, so this is not a parameter-count problem and the fallback CONTEXT records does not fix it.

This threatens a premise the whole design rests on. [Settle how image-requiring branches are developed](018-vision-on-the-dev-model.md) checked whether the development model could *see* and found it could. Nobody checked whether it could reliably *call a tool*, which turns out to be the binding constraint. Every design decision aimed at the 2B reader — the numbered procedure over a tree in [012](012-skill-file-format.md), verdicts over judgements in [011](011-tool-inventory.md), leaf names written next to answers — was aimed at comprehension. None of it helps a model that comprehends and then narrates instead of acting.

Before choosing, establish where the fault actually is. In order of how cheap they are to rule out:

1. **The serving layer.** Ollama's tool-call handling for this model family, the template, whether `parallel_tool_calls=False` is honoured, whether the tool schemas exceed what the template renders cleanly. [018](018-vision-on-the-dev-model.md) warned that local capability fails at the serving layer far more often than at the weights, and said so about images; it applies here.
2. **The adapter.** How LangChain's Ollama binding renders tool schemas, and whether a refusal to call is visible as a distinct failure or arrives as ordinary content.
3. **The prompt surface.** 025 found that a `wrong_screen` refusal naming the next action is what rescued both successful IGT runs. That is evidence the model can be steered back — which suggests recoverable, not incapable.
4. **The weights.** Only after the first three.

Then decide. The options are not equal and the cheap one may be right:

- **Keep the local gate and make the harness carry it** — a refusal-to-call is already detectable, so a bounded reprompt naming the expected tool may close most of the gap. 025's evidence points here.
- **Demote the local model to the scripted-leaf role.** `make v0-scripted` already proves the deterministic tiers perfectly and repeatably. If the local model's job is proving *shape*, a scripted leaf does it better, and development moves to a production model for judgement — which is the split [018](018-vision-on-the-dev-model.md) already drew for visual branches, generalised.
- **Change the local model.** Not to a bigger Gemma, which was tested. To a family with stronger tool-calling discipline.

The IGT path is where it hurts most and that is not a coincidence: an IGT is a long loop of read-classify-answer-advance with no natural stopping point, so a single lapse into prose ends the unit. The manual path's short procedures survive better. Any decision should be judged against the IGT leaf, not the manual one.

Resolve with the fault located, the decision, and whatever CONTEXT's *Run shape* should say instead of "development runs on a small local model".

## Resolution

**The fault is the serving layer — item 1 on this ticket's own list — and it is
Ollama.** The weights were never the problem. The same
`gemma-4-E2B-it-Q4_K_M` file, served by llama.cpp through Docker Model Runner
instead of by Ollama, completes the IGT leaf **six times out of six** where
Ollama completes it twice. Development now runs on Docker Model Runner, and the
Makefile default is `openai:docker.io/ai/gemma4:e2b`.

### The switch

Docker Model Runner is llama.cpp behind an **OpenAI-compatible** API on
`http://localhost:12434/engines/v1`, so through `init_chat_model` it is the
`openai:` provider with the base URL moved — not a runtime binding of its own.
The model id is the full repository name the endpoint lists.

```
AXE_MODEL        = openai:docker.io/ai/gemma4:e2b
AXE_MODEL_KWARGS = {"base_url": "http://localhost:12434/engines/v1", "api_key": "docker"}
```

The key is required by the client and ignored by the server.
[`graph/requirements.txt`](../../graph/requirements.txt) carries
`langchain-openai` in place of `langchain-ollama`, and `make model` — a new
target `v0` depends on — fails early with the `docker model pull` line rather
than letting a missing runtime surface as a connection error on the first leaf.

**Nothing in `docker/` needed an endpoint.** The container is the fixture and
holds no model; the graph runs `docker run -i` from the host, so the model
client is host-side. The one change there is that
[`docker/record-provenance.py`](../../docker/record-provenance.py) now records
`AXE_MODEL_KWARGS` alongside `AXE_MODEL` — after this ticket, a run recorded
without its base URL cannot be told apart from the same weights on a different
runtime, which is exactly the distinction that turned out to matter. For the day
the graph does move inside a container: the bare
`http://model-runner.docker.internal/engines/v1` does **not** resolve under a
plain `docker run` on this machine. It needs
`--add-host model-runner.docker.internal:host-gateway` and the port kept. That
is recorded as a comment in the Makefile rather than as plumbing nothing uses.

### Tool calling survives, and so does vision

Checked before anything was measured, because 026 said a failure here outranks
every number in the ticket.

| Property | Docker Model Runner | Ollama |
|---|---|---|
| All 17 tool schemas bound (5.8 KB) | yes | yes |
| Tool call emitted from a 17-tool binding | yes | yes |
| Multi-turn loop, tool results fed back | **6+ turns, one call a turn** | breaks (below) |
| `parallel_tool_calls=False` at bind | accepted | accepted |
| `parallel_tool_calls=False` at **invoke** | **honoured** | **`TypeError`** |
| Image in a `HumanMessage` | read correctly | — |
| Image in a **`ToolMessage`** | **read correctly** | — |

Two of those are load-bearing.

**`parallel_tool_calls=False` is honoured for the first time.** 025 recorded it
as accepted at bind and refused at invoke, and
[`graph/leaf.py`](../../graph/leaf.py) drops the flag on first refusal because of
it. That refusal is Ollama's — `Client.chat() got an unexpected keyword argument
'parallel_tool_calls'` — and Docker Model Runner takes it at both ends. Without
the flag this model emits two calls in a turn, one of which `act` has to answer
with *only one tool runs per turn*; with it, one call a turn, every turn. The
defensive drop stays, because it costs nothing and the next runtime may refuse
again.

**Images survive inside tool results.** This was the real risk in moving to an
`openai:` provider, and it is the path CONTEXT depends on — the IGT leaf receives
four screenshots per Structure walk, and they arrive as `ToolMessage` content
blocks, not as user turns. Both the adapter-native `{"type": "image", "base64":
…}` block and the `image_url` form round-trip, and the model answers from the
image. [018](018-vision-on-the-dev-model.md)'s smoke test, done again on the new
runtime.

### What Ollama was actually doing

025 recorded the failure as *the model stops emitting tool calls and answers in
prose*. **The second half of that is wrong, and the correction is the whole
finding.** The model does not narrate. Ollama returns an `AIMessage` with **no
tool calls and no content at all** — an empty completion, `done_reason: stop`,
which `after_think` correctly routes to `END` and the run correctly reports as
`incomplete`. There is nothing to steer back, because nothing was said.

It reproduces in four turns with no browser anywhere near it: bind the 17
schemas, feed back three canned tool results, and turn four comes back empty.
Three trials, three identical stops. That is a serving-layer defect visible for
the cost of a script, and 026 was right that it was the cheapest thing to rule
out.

The live runs match. Across six Ollama runs the IGT leaf died on **exactly four
tool calls, on all six first attempts** — not a distribution, a constant. A
stochastic weakness in the weights does not produce the same integer six times.

### The measurement

Six runs per arm, `make v0` against `fixture/target/`, both arms interleaved on
one machine, every run stamped with the revision of the files it ran against and
every one verified unchanged across its own run.

**Skill revision:** `skills/igt/procedure.md` `a2037e0886`,
`skills/page-state/11-alternatives-for-timed-media.md` `4b9426448a`,
`fixture/tools.js` `ef31fef0e5`, `fixture/mcp-server.js` `15ccff4533` — that is,
**after** the concurrent procedure and tool-error-contract fixes, not before. An
earlier pair of batches straddled those edits and is discarded; it agreed
anyway.

**Ground truth on that revision**, from `make v0-scripted`: one guided issue, and
**two** manual issues — `11.4.captions-missing` and `11.6.transcript-missing`.

| Model | Runs | IGT completed | Manual completed | Manual filed | Both units | Failure shapes |
|---|---|---|---|---|---|---|
| `openai:docker.io/ai/gemma4:e2b` (Docker Model Runner) | 6 | **6 / 6** (5 on attempt 1) | 6 / 6 | 3 / 6 | **6 / 6** | wrong branch — `11.4.pass` on a video with no captions, 3 of 6; `claimed_not_filed` — a fail leaf reported with no `add_manual_issue` behind it, 3 of 6 |
| `ollama:gemma4:e2b` | 6 | **2 / 6** (**0** on attempt 1) | 6 / 6 | 6 / 6 | **2 / 6** | empty completion, 6 of 6 first attempts, always at the fourth tool call; wrong branch — `11.1.transcript-missing`, the audio-only branch, 6 of 6 |
| a production model | **0** | — | — | — | — | **no key present.** `.env` carries only the axe server credentials, and no `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GOOGLE_API_KEY`/`GEMINI_API_KEY` is set anywhere this run can reach |

Ollama's 2 of 6 reproduces 025's 2 of 9 on a graph that no longer exists and a
skill file since rewritten, which is worth noting on its own: **the skill and
tool-contract fixes moved Ollama's IGT rate not at all.** The runtime moved it
from 2 to 6.

A Docker Model Runner run takes five to nine minutes against Ollama's three and
a half to four and a half. Almost all of that gap is turns the Ollama runs never
took — thirteen to sixteen tool calls through a completed Structure walk, against
four and then four again on an abandoned one.

### What did not improve, and must not be read as if it had

**Judgement did not improve. It may be worse.** Both runtimes get the branch
wrong on the manual leaf, in different directions:

- Ollama picks `11.1.transcript-missing` — the *audio-only* branch — in all six
  runs. Consistently wrong, and consistent enough to look like a result.
- Docker Model Runner reaches the right pair, `11.4` + `11.6`, in three runs, and
  declares `11.4.pass` — captions present on a video that has none — in the other
  three. **A false negative on a real failure is the worse error of the two**,
  and it is the error the new runtime makes.

It reached the exact ground-truth pair once in six.

**The deterministic tiers caught every one of those gaps.** No ledger was lost,
no run halted, and every fail leaf reported without a matching write came back as
a `claimed_not_filed` reconciliation on the draft. The tier that is supposed to
stop a silently under-reporting draft did so, on the runtime that produces the
most of them. That is the design working, not an excuse for the model.

So [018](018-vision-on-the-dev-model.md)'s split survives this ticket and gets
sharper: **the dev model now proves shape reliably, and proves nothing else.**
The production sign-off 018 requires for visual branches is unmet and cannot be
met from this machine until a key exists.

### The decision

**Keep the local model, on Docker Model Runner.** This is 026's first option —
*keep the local gate and make the harness carry it* — reached without the harness
having to carry anything. No bounded reprompt was added, because the failure it
would have caught was an empty message from a runtime that is no longer in use.

The other two options are declined, and for reasons the measurement supplies:

- **Demoting the local model to the scripted-leaf role** was the right call
  against 2 of 6 and is the wrong call against 6 of 6. `make v0-scripted` keeps
  its job — it is the ground truth this ticket's *filed* column is graded
  against, and it is better than a model at proving the deterministic tiers. But
  a model leaf that completes both units every time is proving something a
  scripted leaf structurally cannot: that a real model, reading a real skill
  file, reaches the end of the procedure.
- **Changing the model family** is not indicated. The family was never the
  binding constraint. E2B walks a full IGT under a runtime that renders its
  template properly, and 026 was explicit that the weights come last.

**The tripwire is judgement, not tool discipline.** 018 named the fallback to 12B
against skill files 5, 6 and 9 disagreeing with a production model. Test 11's
`11.4.pass` false negative is the same signal arriving early on a non-visual
file, so the trigger widens: **if the local model's leaves disagree with a
production model's on the same fixture beyond the occasional page, development
moves to 12B — and that comparison cannot be run until an API key exists.**
Getting one is now the blocking item for judgement, exactly as 025 said it would
be.

### For CONTEXT.md — not edited, per the constraint

**1. *Run shape*, last paragraph.** Currently:

> LangGraph holds the agent graph, in Python. Production runs on Gemini, GPT, or
> Claude; development runs on a small local model — Gemma 4 E2B, with 12B as the
> fallback.

Should read:

> LangGraph holds the agent graph, in Python. Production runs on Gemini, GPT, or
> Claude; development runs on a small local model — Gemma 4 E2B, with 12B as the
> fallback — served by **Docker Model Runner**, which is llama.cpp behind an
> OpenAI-compatible API. The runtime is part of the specification, not an
> installation detail: the same E2B weights complete the Structure IGT six times
> in six under Docker Model Runner and twice in six under Ollama, because Ollama
> returns an empty completion mid-procedure. So the provider is `openai:` with
> the base URL moved, and a run's provenance records the endpoint as well as the
> model.

**2. *v0*, the paragraph beginning "The spine holds. The local model does not."**
Its diagnosis is now wrong twice over — the rate and the failure shape. Suggested
replacement for the whole paragraph and the one after it:

> **The spine holds, and the local model holds once it is served properly.** The
> deterministic tiers behaved correctly in every run of every batch — no ledger
> lost, no draft printed that should not have been, and every fail leaf reported
> without a matching write flagged as `claimed_not_filed`. The model half was a
> **serving-layer** failure, not a weights failure: under Ollama the IGT leaf
> stopped at the fourth tool call on six of six first attempts, returning an
> `AIMessage` with no tool calls and no content — it was never narrating instead
> of acting, it was saying nothing at all. Under Docker Model Runner the same
> `gemma-4-E2B-it-Q4_K_M` file completes both units six times in six.
>
> **What is still unproven is judgement.** The leaf reaches the end of the
> procedure reliably and picks the right branch in three runs of six, including a
> false negative on a real captions failure. Development proves shape; a
> production model has still never run against this fixture, because no API key
> exists on the development machine.

**3. *The development model must accept image input*, closing sentence.** It
requires a visual skill file to have "run once against a production model on the
same fixture". That gate is unmet and now has a name — no key is present — which
is worth stating there rather than leaving as an assumption that it happens.

### For MAP.md — not edited, per the constraint

The 025 bullet's closing clause, *"The failure is always the model narrating
instead of calling a tool, and 12B is no better"*, is superseded. Suggested entry
for 026, alongside the other resolved tickets:

> - [Settle the local model's tool discipline](tickets/026-local-model-tool-discipline.md):
>   **the fault was the serving layer, and it was Ollama.** The same E2B weights
>   complete both v0 units 6 of 6 under Docker Model Runner and 2 of 6 under
>   Ollama, which returns an empty completion — no tool calls, no content — at the
>   fourth tool call on every first attempt. Development moves to Docker Model
>   Runner as an `openai:` provider with the base URL moved; `parallel_tool_calls=False`
>   is honoured there for the first time, and screenshots survive inside tool
>   results. Tool discipline is settled. **Judgement is not** — the leaf still
>   picks the wrong branch in half its runs, and no production model has ever run
>   against this fixture because no API key exists.

### Not done, and why

- **No bounded reprompt on a refusal to call.** It would have been the fix for a
  model that answers in prose. The model does not answer in prose, and on the
  runtime now in use there is no refusal to reprompt.
- **No third local candidate.** A family with stronger tool-calling discipline
  was 026's option three, gated behind the first three layers. The first layer
  explained the whole gap.
- **No production run.** There is no key. This is the one thing this ticket asked
  for that could not be produced, and it is now the blocking item for every
  judgement question in [018](018-vision-on-the-dev-model.md) and here.
