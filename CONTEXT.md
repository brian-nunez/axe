# axedevtools

An agent that completes an accessibility audit of a single page state by driving the axe DevTools browser extension, so a human reviews findings instead of producing them.

*New here? [AGENTS.md](AGENTS.md) has the read order, the commands, and the operating rules. This file is the design.*

## Why

American Express publishes millions of pages, emails, PDFs, and mobile screens. Six developers own the scanning platform. Full assessment authority takes four weeks of training, and two subject matter experts company-wide hold final say.

Automated axe-core scanning already runs at scale. It stops before the Intelligent Guided Tests and the 16 page state tests. Those remaining tests cost roughly four auditor-hours per page state, and third-party auditing runs north of $100 per page. Development teams ship daily. Hiring cannot close that gap.

The agent produces a thorough draft. A human confirms, corrects, or rejects each finding in 5–30 minutes, because reviewing is faster than auditing.

## The governing constraint

**Drive the extension. Answer its questions. Keep no rules of our own.**

The enterprise license buys Deque's expertise, not just their software. The extension carries logic worth having — walking every image, every heading — and Deque maintains it as WCAG evolves.

So the agent answers whatever the extension asks. When Deque changes a question, the agent answers the new question. No rule set to maintain, no standards treadmill, no derivative-work exposure.

This one decision drives most of what follows.

## What we have

Settled. Treat as fact; do not re-ask.

**Enterprise license, on-premises, self-hosted.** We run the axe DevTools Server ourselves and control it. We were the first customers on this license, so the feature set does not necessarily match current public docs.

**The license permits what this project does.** It covers use, and software that interacts with Deque software. Driving the extension with our own automation is within terms — settled, not a standing risk.

**Not included:** axe MCP Server. Automated IGT. ML features and advanced rules. These are not gaps to close — they are outside the contract, and the design assumes their absence.

**Included and in use today:** the axe DevTools extension with Intelligent Guided Tests, manual issues, and the Custom Integration submit path. The extension is currently training material — people are taught to drive it by hand. Nothing is automated.

**Credentials** live in `.env` as `AXE_USER_EMAIL_ADDRESS` and `AXE_USER_PASSWORD`.

**Greenfield.** No existing implementation, no backward compatibility, nothing to preserve.

## Scope

**In:** the IGTs and the 16 page state tests. Operating form controls is part of that — activating them by pointer or key, changing a control's setting, and observing a submit the page performs on its own. Filling a form out and submitting it to *reach* a state is not.

**Out, v1:** screen reader verification — tests #2 Page Meaning, #10 Status Messages, #13 Time Limits. Auditors run those by hand. Roughly 13 of 16 get real coverage, against a baseline of zero.

**Out:** page state discovery, multi-page flows. The agent runs against a page state already determined to be unique. A state that only a submission produces — a validation error, a confirmation — is a page state of its own and gets its own run, because the saved test every unit writes into is a scan of the state the fixture handed over.

## The fixture

The container hands the agent a browser that is already correct: target page loaded, extension signed in with `AXE_USER_EMAIL_ADDRESS` and `AXE_USER_PASSWORD` from the environment, DevTools open, axe panel shown, automated scan complete **and the test saved**. Saving is not tidiness — *Add Manual Issue* stays disabled until the test exists server-side.

The agent's job starts at *read the panel*. It handles no credentials, orchestrates no scan, manages no browser lifecycle.

**The harness keeps the session alive out of band.** The access token lives 90 minutes, so a four-hour run crosses two expiries. The extension renews itself only when the panel mounts, and re-mounting means refreshing the extension — which destroys the ledger. So `fixture/keepalive.js` runs the refresh grant on a timer, writes the result into `chrome.storage.local`, and announces it on the extension's own `auth` BroadcastChannel. The panel is never touched.

The graph reaches the container over **stdio** — `docker run -i`, one MCP client for the whole run, no second port. `AXE_TARGET_URL` names the page state; the run writes to a run directory.

**Extension settings come from Chrome managed-storage policy baked into the image, and there are 13 of them because not setting a key is not neutral — it chooses Deque's default.** Four of those defaults are ones this project would not pick, the sharpest being `dataGather: true` against a `usageServerURL` that resolves to Deque's public usage service. Policy-set values are locked in the extension UI, so settings hold for the life of the run. The standard is `wcag22aa`; `wcag21aa` was never a competing choice, only the factory default the checklist happened to be captured under.

**Renderer sandbox: currently off.** Playwright defaults `chromiumSandbox` to false, so the renderer parses arbitrary Amex pages while the process holds a live session, a 20-day refresh token and `AXE_USER_PASSWORD`. That is an inherited CI convenience, not a chosen posture. Every run records `AXE_CHROMIUM_SANDBOX` in its provenance so the posture is at least auditable while the decision is open.

The payoff is reproducible failure. A four-hour run that breaks at hour three replays through `docker/replay.sh` — and the replay that actually gets used is **one unit**, not the whole run: the same scan and save, then just the unit that died. `--check` verifies the image digest, the CRX hash, and re-renders the policy inside the recorded image to diff it key by key. Four things replay cannot reproduce — the page, the model, the server, the catalog — are recorded as digests so any divergence is attributable rather than mysterious.

## The ledger

Every IGT answer and manual issue accumulates in the extension's saved test.

**The saved test lives on the server, not in the panel.** It is readable out of band with the token the keepalive already holds — `GET /api/tests/{id}`, `/issues`, `/manifests` — so a health check never has to touch the panel to know whether the findings are still there. Send `Accept: application/json`: the SPA answers `200 text/html` to any unrouted path, so a check without it reads success out of a web page.

**The danger is not losing the test. It is writing into a panel that no longer connects to it.** Refreshing the extension leaves the saved test and every filed issue untouched, and leaves the panel document looking entirely healthy — right test name, right issue counts, a working *Add Manual Issue* form. But `chrome.runtime.id` reads `null`, and **that orphaned panel accepts a complete manual issue flow, reports no error, and drops it**. Nothing visible changes. This is why `fixture/ledger.js` reads both the panel and the server, and why `chrome.runtime.id` is one of its five checks.

**What an in-progress IGT survives is decided by navigation, not by URL.** The guard fires on `tabs.onUpdated` with `status === 'complete'` — full loads and same-document navigation alike, a bare hash change included — and then re-resolves the running guide's declared `vitals` against the new DOM. So same-origin navigation to a *different* document kills the test, while cross-origin navigation to an *identical* one does not. Deleting every heading without navigating raises nothing at all; the guard is a detector bolted to navigation, not a protection.

**Viewport resize, CSS injection, scroll and DOM mutation fire nothing.** Page state test 9 is safe as specified — a 320px viewport and the WCAG text-spacing stylesheet were both tolerated with an IGT running. Restore the viewport afterwards for measurement correctness, not for the ledger's sake.

**The page-state warning is a banner, not a wall, and not terminal.** It renders as a sibling of a fully live question screen; `Back`, `Next` and `View element selector` stay enabled and pressing `Next` advances with the banner still up. Navigating away and back clears it and the test resumes on the same question.

Losing the ledger means re-running the page from the fixture. At $20–50 per scan against a quarterly reporting window, that is an acceptable recovery — and it is the only one.

Call `checkLedger` between sub-agents: three HTTP calls, ~2 seconds, **five checks yielding eight verdicts**. Abort on a real loss. The one bounded recovery the graph owns is `panel-detached`, where it reopens the run's saved test — `panel-hidden` is already retried *inside* `checkLedger`, which re-selects and re-reads before returning a verdict, so retrying it again at the graph edge would be the second attempt the policy forbids.

**Abort has two shapes, and they are not interchangeable.** If the panel is dead but the ledger is intact server-side, emit the draft from the server read, marked partial, listing what never ran. If the test or its issues are gone, emit **no draft at all** — a silently under-reporting draft that a human reviews believing it thorough is worse than nothing, which is the argument this whole section rests on.

**The baseline advances on every `intact` gate.** Otherwise issues filed *during* the run are invisible to the comparison and a later loss still reads `intact`.

## Run shape

Strictly sequential. Nothing runs in parallel.

1. Main takes the fixture.
2. IGT phase → one sub-agent per IGT category, in series.
3. Manual phase → one sub-agent per page state test, in series.

23 units: 7 IGT categories and all 16 page state tests. The three screen-reader tests stay in the queue rather than being filtered out — a held-back file is executable, costs nothing, and is the difference between a draft that says *test 13 was not run, and why* and a draft silently missing a test.

**Only the leaves hold a model.** Main, IGT and manual are not agents despite the names — they are `StateGraph`s with no model bound, because popping the next unit, restoring the page, gating the ledger and routing on the verdict is mechanical, and a model there buys nondeterminism exactly where the run is most expensive to lose. `bind_tools` is called once per sub-agent and nowhere else.

Each sub-agent starts fresh: its own message list, one skill file, a narrow tool binding closed over by the graph rather than requested in a prompt. Fresh context per test is the point, not throughput — sequencing costs nothing against a three-month window.

**Sub-agents communicate through the ledger, never through the graph.** Page state test 16 reads the saved test for what test 4 filed; it does not receive test 3's report. That keeps every unit's context genuinely its own.

Parents restore the page between units — viewport, injected CSS, DOM state, and the panel view back to the overview. Not for the ledger's sake, which tolerates all of it, but for measurement correctness and because a leaf left on the Add Manual Issue form makes the next gate read `panel-elsewhere`.

LangGraph holds the agent graph, in Python. Production runs on Gemini, GPT, or Claude; development runs on a small local model — Gemma 4 E2B, with 12B as the fallback — served by **Docker Model Runner**, which is llama.cpp behind an OpenAI-compatible API. The runtime is part of the specification, not an installation detail: the same E2B weights complete the Structure IGT six times in six under Docker Model Runner and twice in six under Ollama, because Ollama returns an empty completion mid-procedure. So the provider is `openai:` with the base URL moved, and a run's provenance records the endpoint as well as the model.

**The development model must accept image input.** Page state tests 5, 6 and 9 hand it a screenshot, so a dev model that cannot see cannot run three of the sixteen. Every Gemma 4 size takes images, so this rules nothing out. But seeing is not judging — E2B scores 44.2% on MMMU Pro against 12B's 69.1% — so **development proves shape, a production model signs off judgement**: a skill file with `requiresScreenshot` branches is not done until it has run once against a production model on the same fixture and the leaves agree. **That gate is currently unmet and has a name: no API key for any production provider exists on the development machine**, so no such run has ever happened.

**The tool layer is an MCP server of our own, in Node, and it is the fixture.** It launches the browser, holds the panel through its lifecycle, scans, saves, and keeps the session alive, then serves checklist-shaped tools to the graph. Every trap the panel sets lives there, once, rather than in 23 skill files. To be unambiguous, because the names collide: this is **not** Deque's axe MCP Server, which *What we have* records as outside the contract. It is our own code driving our own licensed extension.

## Two paths

The IGT path and the manual path are different machines. Keep them apart — tools, skill files, and sub-agents alike.

**IGT path — Deque asks, we answer.** Five screen shapes, the question identified by the `name` on its answer radios, an element picked by clicking the inspected page. We contribute no checklist and compute no branches; the agent reads the question, answers it, and advances.

**Manual path — our checklist decides, we write.** The 16 page state tests, one decision tree each, every leaf naming a catalog entry, the element picked through the Element Selector's selector search. This is the only path with branches of ours to compute.

The 16 page state tests belong to the manual path alone. So does the design rule below about computing branches.

## Design rules

**Tools return verdicts; the agent routes.** A small local model will not judge whether an accessible name contains the visible text in the same order. It will reliably call a tool that computes the answer and record the result. Every checklist branch that can be computed, is. The agent reports which branch fired. **This is a manual-path rule** — the IGTs carry no branches of ours, so on that path the agent answers Deque's question and picks an element, and that is the whole job.

**A branch can become a measurement without a new predicate tool.** Handing `find_elements` a selector that answers the branch turns a judgement into a verdict — page state test 11's captions check went from a false negative in half its runs to correct in five of five that way, with no tool added. Look for that before writing a predicate.

**When a tool acts on the page, the model names *which element* and *which condition*; the tool decides *how*** — which key, which pointer sequence, which width, in what order, with what settle time — and restores what it changed. Acting is where a small model does the most damage, so there is no `click` or `press_key` in any production binding. The primitives that make skill-file authoring possible are nine, and none is ever bound to a leaf.

**Source material lives in [`reference/`](reference/).** The 16 page state tests are captured there as structured data — each branch's Deque issue identifier, and flags for which branches are computable and which need a screenshot. The checklist is a login-gated page served by our own axe DevTools Server, so it cannot be fetched from code. Its issue slugs are a *different vocabulary* from the manual issue catalog's ids and do not join to it; the two share only the WCAG success criterion, which names a family rather than an entry.

**The tool layer is our own MCP server over the Node panel driver.** The LangGraph side is Python and talks to it as an MCP client. It owns the browser for the life of a run — launch, keepalive, scan, save, then serve tools — because the panel frame handle, the keepalive timer and the selection re-assertion all need one long-lived object. Production sub-agents are bound only the checklist-shaped tools; the primitives that make skill-file authoring possible live on the same server, bound only for authoring and debugging. This is ours, and unrelated to Deque's axe MCP Server, which is outside the contract.

**Map skill file branches to catalog entries at authoring time.** Add Manual Issue takes one entry from a flat catalog of 418, each labelled `description (instance id, rgaa mappings)`; the success criterion rides inside the instance id, and there is no separate field for it. The id is not a unique key — `4.1.2.a` names 31 different entries — so a branch stores the **label**. Pre-mapping means the agent picks no issue types at runtime.

**Select elements by CSS selector, not by coordinates.** Playwright resolves the selector and clicks what it finds, so nothing depends on pixel accuracy. Which surface takes the click varies by form. In **Add Manual Issue** the Element Selector drawer works as advertised: its selector search expands the tree to the match at any depth and `Select` commits it. On **IGT picker screens** the same drawer is inspection-only — `Select` never enables — and the panel reads a click on the inspected page instead, with `Mouse Selection` armed.

**Read the panel as DOM.** `frameLocator` reaches the panel document. Reserve screenshots for tests that are inherently visual — #5 graphical contrast, #6 sensory characteristics, #9 content loss.

**Anchor on headings, button names, control ids, and ARIA roles.** The panel ships no `data-testid` and no `data-*` attributes at all, and its CSS-module class names are hashed. Text locators detect state regardless of layout; `getByRole` acts on it, and usefully returns nothing when the panel is unlaid-out or a modal is blocking. Filter to visible, non-disabled elements before acting — the panel keeps hidden controls in the DOM. Check `aria-disabled` as well as the native property: *Add Manual Issue* is `aria-disabled="true"` while `button.disabled` reads `false`, so a property-only filter clicks a dead button.

## Driving the panel

Confirmed working, headless included.

```js
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';
const ctx = await chromium.launchPersistentContext(profile, {
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--auto-open-devtools-for-tabs',
  ],
});
const dt = ctx.pages().find(p => p.url().startsWith('devtools://'));

// Selecting the tab is what gives the panel layout. showView(id) creates the
// target but leaves the tab unselected — the iframe stays 0x0 and every
// element inside it is unclickable.
await dt.evaluate(
  id => import('./ui/legacy/legacy.js')
    .then(UI => UI.InspectorView.InspectorView.instance().tabbedPane.selectTab(id, true)),
  panelId,
);

const panel = dt.frameLocator('iframe[src$="/panel.html"]');
```

**Selection is not a one-shot step.** DevTools steals the tab back while it finishes starting up, so poll the panel document's own `document.body` box and require it to still be non-zero a beat later. The iframe's box is not sufficient — it can report 554×693 while the panel document is still 0×0, and in that state every action fails as "not visible".

Details that cost time to find:

- Panels register under `chrome-extension://<extid><PanelTitle>`, no separator. Locate them with `tabbedPane.tabIds()`. DevTools is shadow-DOM'd, so DOM-level tab discovery returns nothing, and extension panels can sit in the overflow menu.
- The extension's `devtools_page` calls `panels.create()` asynchronously, so the tab is absent for a moment after DevTools opens. Poll for it.
- A fresh profile shows a chain of onboarding dialogs that intercept pointer events for the whole panel. Clear the chain, not one modal.
- `PW_CHROMIUM_ATTACH_TO_OTHER` is undocumented Playwright internals, so pin the version. Deque's own `axe-mcp-server` sets the same variable, which gives it production weight.
- Playwright removed the `devtools: true` option in 1.58. Use `--auto-open-devtools-for-tabs`.
- `chrome-devtools-mcp` cannot reach the panel. The panel is an out-of-process iframe, its accessibility tree returns `childIds: 0`, and upstream cross-origin iframe support is closed as not planned.

## Held back on purpose

**Authority.** The output is a draft. A human signs off.

**Submission.** v1 prints the agent's output. The Custom Integration webhook and the injected integration ID come later.

**Reaching a state behind a form.** The fixture takes a page state a URL reaches. A target whose state only a fill-and-submit produces needs a per-target preamble that runs before the scan and before the save — fixture work, not a tool. An agent that could navigate to its own page state would be auditing a state nobody determined was unique, against a scan of somewhere else.

**Somewhere to file two findings.** Two checklist branches have no entry in Deque's catalog — a browser-shortcut collision under 2.1.1, and a non-form change of context under 3.2.2, whose wording exists only under 3.2.5. A skill file records those as `unfileable`, so they reach the run output but never the saved test. That is tolerable while v1 prints its output; it becomes invisible the day submission ships through the webhook.

**Our own WCAG rules.** See the governing constraint.

## v0

Built. `make v0` runs it; `make v0-scripted` runs the identical graph with a scripted leaf in the model's seat.

Two units — the Structure IGT and page state test 11 — over the MCP server, with a `checkLedger` gate between them, against a target page in `fixture/target/`. Seventeen tools: session, IGT, manual read/write. Two skill files, `skills/igt/procedure.md` and `skills/page-state/11-alternatives-for-timed-media.md`.

**The spine holds, and the local model holds once it is served properly.** The deterministic tiers behaved correctly in every run of every batch — no ledger lost, no draft printed that should not have been, and every fail leaf reported without a matching write flagged as `claimed_not_filed`. The model half was a **serving-layer** failure, not a weights failure: under Ollama the IGT leaf stopped at the fourth tool call on six of six first attempts, returning an `AIMessage` with no tool calls and no content — it was never narrating instead of acting, it was saying nothing at all. Under Docker Model Runner the same `gemma-4-E2B-it-Q4_K_M` file completes both units six times in six.

**What is still unproven is judgement.** Five consecutive clean runs complete both units and file real catalog entries, but the branches left as judgements still wobble: two of five Structure walks found a guided issue and three found none, and three of five manual reports claimed a `filed:` that no call had made — each stripped and named on the draft by the reconciliation, which is the check earning its place. The one branch converted from a judgement to a measurement was right five times in five. Development proves shape; a production model has still never run against this fixture, because no API key exists on the development machine.
