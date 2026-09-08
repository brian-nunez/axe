# Prototypes — throwaway

Built to resolve [Prototype the panel DOM contract](../wayfinder/tickets/007-panel-dom-contract.md),
[Prototype driving the Structure IGT](../wayfinder/tickets/008-drive-structure-igt.md),
[Prototype adding a manual issue through the DOM tree picker](../wayfinder/tickets/009-add-manual-issue.md),
[Detect ledger loss](../wayfinder/tickets/010-ledger-loss-detection.md), and
[Settle what page state changes an in-progress IGT survives](../wayfinder/tickets/017-igt-page-state-tolerance.md).
Kept as evidence for the findings recorded there. Delete once
[Settle the tool inventory](../wayfinder/tickets/011-tool-inventory.md) names the real tools.

| File | The question it answered |
|---|---|
| `panel-select.js` | Which DevTools call actually *selects* the axe panel. `showView(id)` does not — it creates the target, leaves the tab unselected, and navigates to Sources. |
| `panel-diagnose.js` | Why every element reported a 0×0 box, and why the first-run modal's submit button stayed disabled under native-setter writes. |
| `panel-probe.js` | The survey itself: what hooks the panel offers, across the home view and the Structure IGT. |
| `igt-console.js` | The exploration tool for 008. Holds one browser open and takes commands on a FIFO, because the saved test is the only record of findings and re-launching per question would destroy it. |
| `igt-structure.js` | The answer for 008: drives the Structure IGT from the home view to a saved test, unattended, from a declarative answer sheet. |
| `manual-issue.js` | The answer for 009: files manual issues from a CSS selector and a catalog query, and dumps the 418-entry catalog with `--catalog`. |
| `ledger-check.js` | The proof for 010: builds a real ledger, then breaks it five ways — panel walked away, wrong test opened, test deleted server-side, extension refreshed, DevTools closed — and shows `fixture/ledger.js` returning the right verdict for each. **Destructive**: it deletes a saved test on purpose. |
| `page-state-probe.js` | The answer for 017: one trial per page state change, each taking a Structure IGT part-way, doing one thing to the page, then walking the rest of the test to see whether the guard ever fires. |
| `target/` | The page every prototype audits: headings, a real list and a fake one, an untagged French passage, `a#vague-link`, `img#chart` with no alt, and a form that navigates away and back. `other.html` is a different document on the same origin; `copy.html` is the same document at a different URL. |
| `target-b/` | An unrelated page, so 017's cross-origin trials change the content as well as the origin. Without it, serving the same directory on two ports makes a cross-origin trial secretly a same-content trial — which is how the boundary hid for a full matrix run. |

Run the survey with `make probe` (or `make probe-headed`), the Structure run with
`make igt`, manual issues with `make manual-issue`, the catalog dump with
`make catalog`, and the ledger-loss proof with `make ledger-check`. All load
`.env` and point at the built extension.

`prototype/page-state-probe.js` has no make target — it is a long matrix run,
takes roughly half an hour, and files real issues into a real saved test:

```
python3 -m http.server 8731 --directory prototype/target  &
python3 -m http.server 8732 --directory prototype/target  &   # same content, other origin
python3 -m http.server 8733 --directory prototype/target-b &  # other content, other origin
node prototype/page-state-probe.js --extension=build/axe-extension
```

`--only=key,key` runs a subset, and `--no-ledger` enters the IGT from the fresh
home view instead of from a saved test.

`build/panel-survey.json` holds the full captured survey,
`build/igt/transcript.json` the screen-by-screen record of a Structure run,
`build/manual-issue/filed.json` what was filed and what the panel confirmed,
`build/manual-issue/catalog.json` the manual issue catalog,
`build/ledger/ledger-check.json` the verdict for each deliberate ledger break, and
`build/page-state/page-state.json` the per-perturbation record behind 017's table.

`make igt` needs a target page. Any page with headings, lists and a
`lang`-tagged passage will exercise every step; `--url=` points it at one.
