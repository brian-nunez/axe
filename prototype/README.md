# Prototypes

Throwaway code kept because something still runs it. Everything these proved is
written up in the tickets that cite them — read those, not these.

| File | Run by | What it is for |
|---|---|---|
| `igt-structure.js` | `make igt` | drives the Structure IGT with no model and no graph. The most reliable way to exercise a guided test. |
| `manual-issue.js` | `make manual-issue`, `make catalog` | files manual issues from selectors, and dumps the 418-entry catalog. |
| `ledger-check.js` | `make ledger-check` | breaks a real ledger five ways and proves the check catches each. This is a test, not a probe. |
| `panel-probe.js` | `make probe` | surveys what the panel offers as automation hooks. Ticket 007's evidence. |

`target/` is the bundled page state the v0 run audits — headings, a real list and
a fake one, an untagged French passage, and a video with no captions and no
transcript. It is not throwaway; `axe` runs against it when given no URL.

Deleted once their findings were recorded, all written up in the tickets that
cite them: `panel-diagnose.js` and `panel-select.js` (the `showView` versus
`selectTab` measurement behind ticket 007), `page-state-probe.js` with
`target-b/` (ticket 017), and `igt-console.js` (the FIFO exploration harness
that drove ticket 008).
