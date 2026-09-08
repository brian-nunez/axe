---
id: 007
title: Prototype the panel DOM contract
labels: [wayfinder:prototype]
state: closed
assignee: brian
blocked-by: [002, 004]
---

## Question

Can the agent read the panel's state from its DOM reliably enough to act on?

This is the largest remaining technical unknown. The panel is Deque's React application, and its internals carry no compatibility promise. Everything downstream — driving an IGT, adding an issue, detecting a dead ledger — rests on being able to answer, from the DOM: which view is showing, what question is being asked, what options exist, what the scan found.

Build the smallest thing that reaches the panel and extracts that state as structured data. Then judge the shape of what comes back: whether stable hooks exist, or whether reading it means matching on rendered text and structure.

Resolve with a working extraction plus an honest read on how brittle it is, because that judgement sets how much the tool layer must absorb.

## Resolution

**Yes — and the brittleness is not where this ticket assumed.** Prototypes in [`prototype/`](../../prototype), runnable with `make probe`. Full capture in `build/panel-survey.json`.

### The judgment

**The DOM is readable and reasonably stable. The panel *lifecycle* is the fragile part.** Budget the tool layer for lifecycle management, not selector archaeology.

Anchors that exist and read well:

| Anchor | Evidence |
|---|---|
| **Headings** identify the view | `Guided Testing: Structure`, `Page Scan`, `Intelligent Guided Tests (IGTs)`, `Element Selector` |
| **Button accessible names** are the controls | `Scan full page`, `Structure`, `Start`, `Cancel`, `Save progress & quit`, `Restart test`, `View element selector` |
| **Stable ids on every form control** | `user-job-role`, `terms-and-services-checkbox`, `advanced-scans-checkbox`, `enableAiAssist` |
| **ARIA roles carry real structure** | the IGT view exposes `tree` / `treeitem` — the Element Selector DOM picker [Prototype adding a manual issue](009-add-manual-issue.md) needs |
| **Step state is enumerable** | the Structure IGT renders buttons `1`–`7`; seven steps, individually addressable |

Absent or unusable:

- **Zero `data-testid`, zero `data-*` attributes of any kind**, across every view.
- **Hashed CSS-module class names** — `igtsButton_f2c725c3`, `splashPanel_defc8b99` — 10–32% of all classes depending on view. Never anchor on these.

So anchor on headings, button names, control ids, and ARIA roles. That is a content contract rather than a test contract, and it will move when Deque rewords the UI — a *visible* break, not a silent one. Acceptable.

### The real finding: three lifecycle traps, all silent

**1. `showView(id)` does not select the panel.** It creates the target, leaves the tab unselected, and navigates DevTools to *Sources*. The iframe then holds a 0×0 box, every element inside inherits it, and every Playwright action fails as `element is not visible`. Measured across four calls (`prototype/panel-select.js`):

| Call | Selected tab | Iframe |
|---|---|---|
| `showView(id)` | `sources` | 0×0 |
| `showView(id, true, true)` | the axe panel | 554×693 |
| `tabbedPane.selectTab(id, true)` | the axe panel | 554×693 |
| `InspectorView.showPanel(id)` | the axe panel | 554×693 |

CONTEXT carried the `showView` recipe and has been corrected to `selectTab`.

**2. DevTools steals the selection back while it finishes starting up.** Selection succeeds, layout appears, and seconds later the panel is 0×0 again. Reproduced repeatedly. Selection is not a one-shot step: poll the **panel document's own `document.body` box** and require it to still be non-zero a beat later. The iframe's box is not sufficient — it can report 554×693 while the panel document is still 0×0.

**3. A chain of onboarding dialogs blocks everything on a fresh profile.** Observed: `Welcome to axe DevTools` (gated — needs a role selected and terms accepted before its submit enables), then `More AI-powered automated IGTs available`. Each intercepts pointer events for the whole panel. The fixture must clear the chain, not a single modal.

### Locator strategy, measured

`getByRole` returns **0 while the panel lacks layout and 1 once it has it** — accessibility-tree locators work, but only after traps 1 and 2 are handled. That makes `getByRole` a useful liveness probe: it also correctly returns 0 for a control behind an open modal, which is exactly the signal you want.

CSS and text locators (`locator('button:has-text(…)')`, `getByText`) resolve regardless of layout. So: text locators to *detect* state, `getByRole` to *act* on it.

Once laid out, ordinary Playwright actions work and React honours them. The native-setter workaround in `prototype/panel-diagnose.js` is unnecessary and should not be carried forward — React ignored those writes and the submit button stayed disabled.

### Facts for later tickets

- **The Structure IGT has 7 steps**, entered via `Start`, with `Save progress & quit` and `Restart test` throughout. Shape for [Prototype driving the Structure IGT](008-drive-structure-igt.md).
- **`role=tree` / `role=treeitem` is the Element Selector**, so [Prototype adding a manual issue](009-add-manual-issue.md) can drive the tree as planned rather than clicking the page.
- **Panel viewport is 554×693** at default DevTools sizing.
- **Extension 4.135.0 bundles axe-core 4.12.1.**
- **Only visible, non-disabled buttons are actionable.** The panel keeps hidden controls in the DOM — a hidden `Restart test` matched a text locator and cost a debugging cycle. Filter on `getBoundingClientRect().width > 0` before acting.
- **A liveness check for [Detect ledger loss](010-ledger-loss-detection.md) falls out for free**: if `document.body` is 0×0 or the expected heading is missing, the panel is not showing and no finding can be recorded.

### Two things needing attention, both outside this ticket

**The fixture is pointed at SaaS on a free trial, not the on-prem enterprise instance.** `AXE_SERVER_URL` resolves to `axe.deque.com`, and the panel renders `Your free trial of axe DevTools ends in 14 days. Subscribe Now`. CONTEXT's *What we have* says enterprise, on-premises, self-hosted. Raised as [Point the fixture at the enterprise instance](016-point-fixture-at-enterprise.md).

**The trial account offers `Enable automated IGT (uses AI credits)`** on the Structure IGT entry screen. CONTEXT records Automated IGT as outside the contract; on this account it is present. Noted, not acted on — the design still assumes its absence.
