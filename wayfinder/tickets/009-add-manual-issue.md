---
id: 009
title: Prototype adding a manual issue through the DOM tree picker
labels: [wayfinder:prototype]
state: closed
assignee: brian
blocked-by: [007]
---

## Question

Can a manual issue be filed end to end from a selector alone?

The write path for all 16 page state tests. Add Manual Issue offers page clicking or an expanded DOM tree; the tree is the target, because it takes a selector rather than pixel-accurate coordinates.

Drive it: enter a success criterion, choose a catalog instance, select an element through the tree, save. Then confirm the issue lands in the saved test.

Resolve with a working `add_manual_issue(selector, issue_id)` path and a note on where the tree picker resists automation.

Do not assume the tree works here. [Prototype driving the Structure IGT](008-drive-structure-igt.md) found that on IGT picker screens the Element Selector drawer is inspection-only — its `Select` button never enables, and the panel takes its answer from a click on the inspected page instead. Add Manual Issue is a different form and may well behave differently, but confirm it rather than inherit the assumption. 008 also records the working page-click path, in case the tree resists here too.

## Resolution

**Yes — from a selector alone, and the tree does work here.** [`prototype/manual-issue.js`](../../prototype/manual-issue.js) files manual issues unattended; `make manual-issue` runs it, `make catalog` dumps the catalog. Verified record in `build/manual-issue/filed.json`.

Two issues filed in one unattended run against a local page, taking the test from 17 automatic issues to 19 with **Manual Issues: 2**, both listed by name and both reopened from the saved-tests list afterwards:

| Selector | Catalog entry |
|---|---|
| `a#vague-link` | Link purpose not clear from link text alone (2.4.4.a, rgaa-6.1.1, rgaa-6.1.3) |
| `img#chart` | Text alternative for the informative image is missing (1.1.1.b, rgaa-1.1.1, rgaa-1.1.5, rgaa-1.1.8) |

### The tree accepts a selection here

**This is the finding the ticket existed for, and it goes the other way from [Prototype driving the Structure IGT](008-drive-structure-igt.md).** Same drawer, same `role=tree` / `role=treeitem`, same toolbar — but in Add Manual Issue the `Select` button is **enabled from the moment the drawer opens**, and pressing it commits: the *Selected Element* region fills with the element's markup and the tree item gains `Selected.` alongside `Highlighted.`

Better still, **the drawer's CSS selector search is the way in**. The magnifying-glass button toggles `aria-controls="css-search-bar"`, revealing an `input[type=search]` placeheld *Search by selector*. Typing a selector and pressing Enter expands the tree to the match wherever it is nested — `a#vague-link` sits inside a `<p>` and never appears among the tree's top-level items — reports *1 of 1*, and leaves `Select` ready. In the IGT picker that same search correctly reported *1 of 1* and `Select` stayed `disabled`; here the whole path works.

So `add_manual_issue(selector, issue)` is genuinely selector-driven end to end. No page clicking, no coordinates, no fallback to 008's Mouse Selection path — though `Mouse Selection` is on by default here too and remains available.

One inherited trap holds: **the drawer is collapsed to 0×0 until `View element selector` is pressed**, and the tree nodes are present in the DOM the whole time. Acting on them while collapsed fails silently, exactly as everything does when the panel lacks layout.

### The gate nobody mentions

**`Add Manual Issue` is `aria-disabled="true"` until the test has been saved.** It appears on the scan results view carrying its own explanatory tooltip, and no amount of scanning enables it — the manual issue has to attach to something that already exists server-side. The sequence is therefore fixed:

```
Scan full page  →  Save Test  →  name it  →  Save
                →  Add Manual Issue now enabled
```

Note it is `aria-disabled`, not the native `disabled`, so `button.disabled` reads `false` and a filter that checks only the DOM property will happily click a dead button. Filter on both.

The fixture already promises "automated scan complete"; it must also promise **saved**, or every manual issue fails at the first step. That is a change to what the container hands the agent.

### The form

Two fields, and fewer than the ticket assumed.

**There is no separate WCAG success criterion field.** Issue Details holds exactly one required control — an `input[role=combobox]` labelled *Issue Description*, with `aria-autocomplete="list"` over a listbox of **418 options**. The success criterion is not entered; it is carried inside the catalog entry's own label. Picking the entry picks the criterion.

Below that, *Selected Element* with the `Mouse Selection` switch and the Element Selector drawer. Then `Cancel` and `Save`. That is the whole form.

Driving the combobox: click it, type enough of the label to filter, then click the single remaining `[role=option]`. The listbox's option ids (`combobox-option474`) are **render-scoped and shift between renders** — the same entry had a different id before and after filtering — so never key on them.

### The catalog, for [Export the manual issue catalog](006-export-issue-catalog.md)

`make catalog` writes all 418 entries to `build/manual-issue/catalog.json`. The whole listbox is in the DOM even while collapsed, so the dump costs nothing beyond opening the form.

Every entry is one flat string:

```
Accessible name does not contain visible label (2.5.3.a, rgaa-6.1.5, rgaa-11.2.5, rgaa-11.9.2)
```

— a human-readable label, then a parenthesised list of the Deque instance id and any RGAA (French accessibility standard) mappings. There are no groups, no headings, no hierarchy: 418 siblings.

Shape:

| | |
|---|---|
| Entries | 418 |
| Distinct Deque instance ids | 90 |
| Distinct WCAG success criteria | 69 |
| Entries carrying more than one instance id | 18 |
| Entries with no RGAA mapping | 111 |
| Spread by WCAG principle | 218 Perceivable, 99 Operable, 65 Understandable, 65 Robust |

**The instance id is not a key.** 64 of the 90 ids name more than one entry; `4.1.2.a` alone covers 31, `4.1.2.b` 30, `1.3.1.b` 21. This matters directly to CONTEXT's rule *map skill file branches to catalog entries at authoring time*: a branch that records `4.1.2.a` has recorded almost nothing. **It must carry the label.**

And the label is *almost* unique — one collision, *Audio description is incorrect or inadequate*, which exists twice under `1.2.3.a` and `1.2.5.a`. So the only truly unique key is the full option text, label and parenthesis together. The prototype takes a query string and **fails loudly unless it filters to exactly one entry**, which is the right behaviour for authoring-time mapping: an ambiguous branch is an authoring bug, not a runtime choice.

One entry is malformed in the extension itself: *Focused element is covered by user-controlled content ()* — empty parentheses, no instance id at all.

### What the extension records

Expanding the filed issue shows what actually landed:

```
Element Location:  body > p:nth-of-type(4) > a#vague-link:nth-of-type(1)
                   <a id="vague-link">
Found:             Manually
Impact:            moderate
                   best-practice
```

**The extension stores the target as a CSS selector of its own construction**, which is a useful symmetry — a selector goes in, a selector comes out — and means a filed issue can be matched back to the element the skill file named. Impact and best-practice classification come from the catalog entry, not from us.

### Where it resists automation

- **`Save` is not `Save`.** The results view carries `Save Test` and the dialog carries `Save`; a substring match on "Save" picks the wrong one, quietly reopens the wrong dialog, and in one attempt here dropped the whole unsaved scan. Exact-match button names, always. Same hazard with the two visible `Cancel` buttons on the form — one belongs to the selector search, one to the form.
- **Panel buttons still need the click dispatched on the element**, per 008. Real pointer clicks on the combobox, the search field and the tree items are fine; it is the buttons that the tooltip layer swallows.
- **The form has no read-back container.** *Selected Element* is a heading with the committed markup printed after it as a sibling — no wrapping element — so verification means slicing `document.body.innerText` between that heading and the next one. Ugly, but it is a real confirmation and worth doing: `Select` silently does nothing if the drawer is collapsed.

### What follows

CONTEXT's design rule and the fixture's contract both need amending — done. The catalog dump does not resolve [Export the manual issue catalog](006-export-issue-catalog.md), whose second half is confirming the identifiers cited by the 16 page state tests, but it removes that ticket's manual work.
