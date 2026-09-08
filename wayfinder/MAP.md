---
labels: [wayfinder:map]
---

# Map: v0 spine for agent-driven accessibility auditing

## Destination

A v0 spec an agent can implement without further decisions: a container that hands an agent a pre-staged browser, a tool layer that drives the axe DevTools panel, and a run that completes the Structure IGT and adds one manual issue.

## Notes

**Entry point:** [AGENTS.md](../AGENTS.md) — read order, how to run things, and the operating rules that cost hours to learn. The session driving this work reads [ORCHESTRATION.md](ORCHESTRATION.md) as well.

**Domain:** accessibility auditing at American Express. Read [CONTEXT.md](../CONTEXT.md) first — it holds the destination's *why*, the governing constraint, the license posture under *What we have*, and the verified panel-automation recipe. Do not re-derive that research, and do not ask about anything *What we have* already states.

**Skills:** `grilling` and `domain-modeling` for grilling tickets; `prototype` for prototype tickets; `research` for research tickets.

**Standing preferences:**
- Production-ready code only. No stubs, no placeholders, no illustrative examples.
- Prototype tickets may produce throwaway code; keep it on a `prototype/<name>` branch and link it from the ticket.
- Git is read-only for agents. Commits, branches, and pushes are Brian's to run.
- Playwright drives the browser.

**Tracker convention** (local markdown, no issue tracker configured):
- Tickets live in `wayfinder/tickets/NNN-slug.md`, one file each.
- Front matter carries `id`, `title`, `labels`, `state` (`open`/`closed`), `assignee`, `blocked-by`.
- Claim a ticket by setting `assignee` before any work.
- A ticket is unblocked when every id in `blocked-by` is `closed`.
- The frontier is every ticket that is `open`, unblocked, and unassigned.
- Resolve by appending a `## Resolution` section, setting `state: closed`, and adding a line to Decisions so far.

## Decisions so far

<!-- one line per closed ticket; the detail lives in the ticket -->

- [Confirm axe MCP entitlement and instance capability](tickets/001-confirm-axe-mcp-entitlement.md): the license excludes axe MCP Server, Automated IGT, and ML features — recorded in CONTEXT.md under *What we have*, which is the single source of truth for license posture. Playwright drives the panel — `chrome-devtools-mcp` cannot reach it and axe MCP is out of contract — so the tool layer is built, not bought.
- [Obtain the axe extension as an unpacked bundle](tickets/002-obtain-unpacked-extension.md): build from the CRX vendored at `vendor/axe-devtools/` with `tools/build-axe-extension.py` — a store CRX carries no `key`, so the publisher key is recovered from its signature header and injected; tested, the loaded extension keeps ID `lhdoppojpmngadmnindnejefpokejbdd`. License permits it — see CONTEXT.md *What we have*.
- [Log the extension in at fixture start](tickets/004-login-at-fixture-start.md): the harness mints a session with a direct grant and seeds it into `chrome.storage.local`; the extension renews only on panel mount, so `fixture/keepalive.js` sustains the session out of band — remounting the panel would destroy the ledger.
- [Choose the v0 auth path](tickets/015-v0-auth-path.md): log in at fixture start with `AXE_USER_EMAIL_ADDRESS` and `AXE_USER_PASSWORD` from the environment.
- [Research the auth flow for minting an extension session headlessly](tickets/003-research-headless-session-minting.md): the unpacked extension must keep its store ID or managed policy silently does nothing. **Token lifetimes here were wrong** — corrected by measurement in [Log the extension in at fixture start](tickets/004-login-at-fixture-start.md).
- [Prototype the panel DOM contract](tickets/007-panel-dom-contract.md): the DOM is readable — headings, button names, control ids and ARIA roles, with no test ids and hashed classes — but the panel *lifecycle* is the fragile part, so the tool layer budgets for selection stealing, layout races and an onboarding dialog chain rather than for selectors.
- [Prototype driving the Structure IGT](tickets/008-drive-structure-igt.md): an IGT is a read-classify-answer-advance loop over five screen shapes, ended by a `Finish` and a named save. The agent locates itself by the question's radio-group `name` — Deque's own question id — not by the step number, which spans several screens and skips inapplicable ones. Element picking goes through a page click, not the DOM tree drawer. `make igt` drives it end to end.
- [Prototype adding a manual issue through the DOM tree picker](tickets/009-add-manual-issue.md): yes, and from a CSS selector alone — the drawer's selector search plus `Select` commits the element, which is the opposite of what the IGT picker does. `Add Manual Issue` is disabled until the test is **saved**, so the fixture must hand over a saved test, not just a completed scan. The form is one combobox over a flat 418-entry catalog; the Deque instance id is not a unique key, so skill file branches must carry the label.

- [Settle the tool inventory and the MCP boundary](tickets/011-tool-inventory.md): our own MCP server in Node over the proven driver, Python graph as its client, and **the server is the fixture**. Twenty production tools in three groups — session, IGT path, manual path — plus six computed predicates covering the nine `computable` branches, and five primitives bound only for authoring. Every tool returns a discriminated result, no tool raises for a dead panel, and each sub-agent is bound a handful rather than the set.
- [Export the manual issue catalog](tickets/006-export-issue-catalog.md): all 92 checklist slugs hand-mapped to exact catalog entries in `reference/issue-mapping.json`, 84 high confidence and 8 flagged with reasons, verified by `make check-mapping`. The lookup key is **slug + success criterion**, not slug — nine slugs resolve to different entries under each of two criteria. Two branches have nothing fileable in Deque's catalog at all.
- [Detect ledger loss](tickets/010-ledger-loss-detection.md): `fixture/ledger.js` reads the panel *and* the server, because each alone is wrong in both directions. **Refreshing the extension does not destroy the saved test — it orphans the panel**, which then accepts writes and silently drops them, so `chrome.runtime.id` is a load-bearing check. Policy is abort, with one bounded recovery for a detached panel — a hidden one is already retried inside `checkLedger` before it returns a verdict, so [013](tickets/013-agent-graph.md) gives it no second attempt at the graph edge.
- [Settle what page state changes an in-progress IGT survives](tickets/017-igt-page-state-tolerance.md): the guard is `tabs.onUpdated` complete plus a re-resolution of the guide's `vitals`, so **the boundary is navigation, not URL** — same-origin to a different document kills, cross-origin to an identical one does not. Viewport resize, CSS injection, scroll and DOM mutation fire nothing, so page state test 9 is safe as specified. The warning is a non-terminal banner over a live question screen, which corrects [008](tickets/008-drive-structure-igt.md).
- [Settle how image-requiring branches are developed](tickets/018-vision-on-the-dev-model.md): vision is a hard requirement on the development model and costs nothing — every Gemma 4 size takes images. Nothing is held back, so coverage stays 13 of 16. But seeing is not judging, so **development proves shape and a production model signs off judgement** on any skill file with visual branches.

- [Settle the skill file format](tickets/012-skill-file-format.md): one Markdown file per page state test in `skills/page-state/`, written as a numbered procedure rather than a tree because the reader is a 2B model. A branch carries the catalog entry's full option text verbatim; a named leaf makes "which branch fired" a copy; `Evidence:` sits on the check, not the test. Six outcomes, including `unfileable` for the two branches Deque's catalog cannot carry. Writing it found that **the manual tool set can read the page but cannot act on it** — six of sixteen tests need that.

- [Settle the agent graph](tickets/013-agent-graph.md): LangGraph, three deterministic tiers over one model tier — **only the leaves hold a model**, and `bind_tools` is called once per sub-agent and nowhere else. A leaf is a separately compiled graph invoked from inside a node with a hand-built payload, never `add_node(subgraph)`, because shared channel names are how context leaks. 23 units, 22 ledger gates. A sub-agent returns two halves and the parent reconciles the model's claims against the tool transcript. **Sub-agents communicate through the ledger, never through the graph.** Abort splits into partial-draft and no-draft-at-all.

- [Key the issue mapping by branch, and check the skill files against it](tickets/022-mapping-by-branch.md): a mapping row now carries exactly one of `catalogOptionText`, `byCriterion` or `byBranch`, and a `byBranch` cell carries **`when` — the checklist condition verbatim** — because a branch name without it is an untestable claim. Completeness is asserted per branch: 103 branches, 103 distinct catalog entries, none shared. `check-mapping` gained a skill-file pass that catches a real, fileable catalog entry no mapping row sanctions, which was previously silent.

- [Amend the tool inventory and the report block for the graph](tickets/023-graph-tool-amendments.md): five contract changes the graph could not be built without — `restore_page` returns the panel to overview, plus `reopen_saved_test`, `save_progress_and_quit`, `page_state_warning`, and the closing report as `finish_unit`'s argument. **`finish_unit` is graph-provided, not MCP-served**, so [013](tickets/013-agent-graph.md)'s startup validation must allow it or all 23 skill files abort at second zero.
- [Add page-interaction tools to the manual path](tickets/020-page-interaction-tools.md): eight interaction tools plus two acting predicates, bound to manual leaves only. **The model names which element and which condition; the tool decides how** — no `click` or `press_key` in production. `operate_element(with: "both")` computes parity itself rather than asking a 2B model to compare two records. Tools restore global page conditions always, navigation always, and leave DOM and focus dirty by design. `12-tables.md` check 2 unblocked as the proof.
- [Make Verdict carry multiple leaves](tickets/021-verdict-leaves-plural.md): `leaf` becomes `leaves: string[]`, always a list. `check_table_semantics` gains `header-associations-wrong`; `check_text_contrast` turned out to need the plural too, since test 4 asks about unfocused *and* hovered.
- [Settle whether the 320px scroll branch is a seventh predicate](tickets/019-reflow-scroll-predicate.md): yes — `check_reflow`, honest about the two-dimensional-layout clause via `undecidable`. `requiresScreenshot` moves to the branch throughout the reference file, which also freed test 6's auditory branch: it was marked visual and is answered by reading text.

- [Settle what form fill and submit is actually for](tickets/024-form-fill-and-submit.md): **zero of 59 in-scope branches need one**, so no new tool. Brian's three verbs already land — *clicking* on `operate_element`, *typing into* on `change_setting`, *submitting as observed behaviour* on `probe_focus_effects`. The fourth thing, filling a form to *reach* a state, is fixture work before the scan: the saved test every unit writes into is a scan of the state the fixture handed over, so an agent that submits its way somewhere would file findings from two page states under one test name.

- [Settle the container spec](tickets/005-container-spec.md): 13 policy keys, `wcag22aa`, stdio transport, headful behind Xvfb for noVNC rather than for layout. **Not setting a policy key is not neutral — it chooses Deque's default**, and four of those defaults are ones this project would not pick, including telemetry to Deque's public usage service. Extension issue screenshots are ON, tested rather than inherited: the debugger attaches cleanly alongside Playwright and DevTools, and every issue the prototypes ever filed already carried a screenshot.
- [Settle observability for a four-hour run](tickets/014-observability.md): a run directory plus a JSON Lines trace, line-oriented because a killed run never closes a JSON document and because more than one process writes it. **The trace is an index; `units/` holds the material.** Replay is three operations in `docker/replay.sh`, and the one that matters is `--unit` — re-running the unit that died in one scan plus one unit, not four hours again. Four things replay cannot reproduce are digested so divergence is attributable.

- [Build v0 — MCP server and graph, end to end](tickets/025-build-v0.md): both layers exist and run. `make v0` against a real model, `make v0-scripted` with a scripted leaf in the same seat. Seventeen tools, two units, a `checkLedger` gate between them, a real saved test ending at 28 issues. **Five consecutive clean runs** on the local default: both units, no retries, no aborts, every manual unit filing a real catalog entry. Reopened once when the first close rested on a single success. The trigger for the early exits was a **naming collision** — `Screen.step` against the procedure's own numbered steps, now `panelStep`.

- [Amend the graph and the tool contract from what the build found](tickets/027-graph-amendments-from-the-build.md): the retry defect was a **spec contradiction** — 013's prose gated before retrying, its edge table did not, and the build implemented the table. Fixed by deleting `unit → unit` entirely: a retry is a new sub-agent on the same browser, indistinguishable from the next unit, so every boundary is cleanup → restore → gate. `wrong_screen` refusals are now structurally unable to omit the next action. The IGT screenshot policy table is populated and stays in the tool layer, because no IGT tool takes a `need` parameter — and filling it exposed an image path that was putting base64 inside the JSON envelope where no model could read it.

- [The local model will not reliably emit tool calls](tickets/026-local-model-tool-discipline.md): **the fault was the serving layer, and it was Ollama.** The same E2B weights complete both v0 units 6 of 6 under Docker Model Runner and 2 of 6 under Ollama, which returns an empty completion — no tool calls, no content — at the fourth tool call on every first attempt. Development moves to Docker Model Runner as an `openai:` provider with the base URL moved; `parallel_tool_calls=False` is honoured there for the first time, and screenshots survive inside tool results. Tool discipline is settled. **Judgement is not** — the leaf still picks the wrong branch in half its runs, and no production model has ever run against this fixture because no API key exists.

## Not yet specified

- **Authoring the remaining 15 page state skill files.** The format and one worked example exist; the rest is bulk work whose shape is now known but whose per-file cost is not. May graduate into several tickets or a generator.
- **Correctness measurement.** No ground truth assembled yet, deliberately. Becomes specifiable once v0 produces output worth grading.
- **Recovering a four-hour run.** A lost ledger means re-running from the fixture. Whether that stays acceptable depends on how often the panel actually dies — [Detect ledger loss](tickets/010-ledger-loss-detection.md) settled how to *notice*, not how often it happens.
- **Deployment shape.** Batch queue, autoscaling, priority lanes. Waits on a real per-page browser cost from v0.
- **A target page for v0 that is not the obvious one.** The W3C BAD demo sits behind a Cloudflare interstitial under this browser, so the IGT audits the challenge page. What v0 actually runs against, and whether real Amex page states have the same problem, is unspecified.

## Out of scope

- **Screen reader verification** — page state tests #2, #10, #13. Auditors run those by hand.
- **Page state discovery** — the agent runs against a state already determined to be unique.
- **Multi-page flows** — one URL per run.
- **Result submission** — the Custom Integration webhook and injected integration ID come after v0.
- **Deque ML features and advanced rules** — not in this enterprise license.
- **Offline Mode** — ruled out. The fixture logs in with real credentials.
- **Our own WCAG rule set** — the governing constraint. The agent answers the extension's questions.
