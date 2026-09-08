---
id: 006
title: Export the manual issue catalog
labels: [wayfinder:task]
state: closed
assignee: brian
blocked-by: []
---

## Question

Capture the full catalog of manual issue types the extension offers, as data.

Add Manual Issue takes a WCAG success criterion and then a Deque-specific instance chosen from a fixed list. Skill file branches map to those instances at authoring time, so the agent picks no issue type at runtime — which is what keeps the small local model viable.

Produce a machine-readable dump: success criterion, Deque instance identifier, and the human-readable label as it appears in the picker. Confirm along the way that the identifiers cited in the 16 page state tests resolve to real catalog entries.

This can be done by hand against a local extension install; it does not wait on the container.

**The open half is bigger than this ticket assumed.** [Settle the tool inventory](011-tool-inventory.md) measured the checklist's 92 issue slugs against the 418-entry dump: **none of them match**. `structure-skiplink-broken` and `4.1.2.a` are two separate Deque vocabularies sharing only the WCAG success criterion, and a criterion names a family — `4.1.2.a` covers 31 entries. So nothing resolves automatically. This ticket's remaining work is **92 hand-mapped rows**, each pinning a checklist branch to one exact catalog label, and the mapping lives beside the skill files rather than in the tool layer.

**The dump already exists.** [Prototype adding a manual issue through the DOM tree picker](009-add-manual-issue.md) produced it as a by-product: `make catalog` writes all 418 entries to `build/manual-issue/catalog.json`, and 009 records the catalog's shape — 90 Deque instance ids over 69 success criteria, ids that are emphatically *not* unique keys, and one malformed entry. What remains here is the second half: confirming that the identifiers cited by the 16 page state tests resolve to real entries, and settling what a skill file branch actually stores given that the label, not the id, is what singles an entry out.

## Resolution

**All 92 slugs mapped, 8 of them flagged for a human.** The mapping is
[`reference/issue-mapping.json`](../../reference/issue-mapping.json); the check
that keeps it honest is [`tools/check-issue-mapping.mjs`](../../tools/check-issue-mapping.mjs),
run by `make check-mapping`.

| | |
|---|---|
| Slugs mapped | 92 of 92 |
| High confidence | 84 |
| Low confidence — flagged, with a note saying why | 8 |
| Unmapped | 0 |
| Distinct catalog entries used | 101 of 418 |

101 entries against 92 slugs because nine slugs are cited under two success
criteria and resolve differently under each. No two branches file the same entry.

### What a branch stores

The **full option text**, verbatim — label and parenthesised ids together, e.g.
`Skip link is broken (2.4.1.a, rgaa-12.7.2)`. Confirmed again here: the instance
id is not a key, and one label (*Audio description is incorrect or inadequate*)
exists twice. The row also carries `catalogInstances` so a consumer can see
mechanically which criterion an entry actually reports.

**Nine slugs are cited under two criteria** and need both rows, because the
catalog splits on exactly the distinction the criterion makes:
`captions-missing` is *Captions are not available for recorded multimedia*
under 1.2.2 and *…for live multimedia* under 1.2.4. Same for the other six
`captions-*` slugs, plus `nonvisual-description-missing` (video-only 1.2.1 vs
multimedia 1.2.3) and `audio-description-inadequate` — which is the catalog's
one duplicate label, 1.2.3.a and 1.2.5.a, separable only by full option text.
Those rows carry `byCriterion` rather than a single `catalogOptionText`; the
branch's own criterion selects.

### The eight flagged rows

Three kinds of failure, none of them guessable:

**No entry in the family matches the branch.**

- `unexpected-change-on-interaction` (3.2.2) — the branch is generic (changing
  any component's setting) but 3.2.2 offers only form-field and dropdown
  specifics. The exact wording exists as *A change of context not requested*, but
  under 3.2.5.a.
- `keyboard-shortcut-conflict` (2.1.1) — the catalog names no shortcut conflict
  anywhere. *Action cannot be performed with a screen reader turned on* describes
  the symptom when the collision is with a screen reader command; a collision
  with a browser shortcut is not covered by anything.

**Several entries match equally.**

- `modal-unclosable` (2.1.1) — four modal entries split the branch between them
  (ESC does not close, ESC is the only way, no close button, dismiss mechanism
  inaccessible) and the branch condition does not say which applies.
- `unexpected-change-select` (3.2.2) — *Arrow keys activate dropdown menu
  options* is narrower than the slug; *Form field causes unexpected change* is
  the better literal match but is claimed by the row above.
- `captcha-requires-vision` (1.1.1) — three 1.1.1.g CAPTCHA entries describe the
  same failure from the alt-text side and the one-modality side.

**One slug, two branches that mean different things.**

- `dual-role` (4.1.2) — cited both by the mouse/keyboard parity branch (closer to
  *Function cannot be performed by keyboard alone*, 2.1.1.a) and by the
  WAI-ARIA-Authoring-Practices conformance branch (closer to *Custom user
  interface component is not compatible with AT*, 4.1.2.c). The entry that
  matches the slug's name matches neither branch cleanly.
- `semantic-data-table` (1.3.1) — cited by the header-markup branch, which it
  fits, and by the role=table/grid row-and-cell-roles branch, which has no 1.3.1
  entry at all.

**And one criterion shift.**

- `semantic-hidden` — *aria-hidden="true" is used incorrectly* is the catalog's
  only aria-hidden entry and an exact match for the branch, but it carries
  1.3.2.a while the checklist cites 1.3.1. Filing it reports a different success
  criterion. Nothing under 1.3.1 describes hidden informative content.

### The check is not decorative

`make check-mapping` fails the build on a mapping that would file nothing or file
the wrong thing. It re-derives the slug set from `page-state-tests.json` (so a
re-captured checklist that adds or drops a slug fails immediately), matches every
option text by exact string equality against the 418-entry dump, compares
`catalogInstances` to the dump's own, requires a note on every non-high row, and
**refuses a high-confidence row whose entry carries a criterion other than the
one cited** — which is what keeps `semantic-hidden` honest. Verified by mutation:
pointing one row at a plausible-but-absent option text and promoting
`semantic-hidden` to high produced four failures and a non-zero exit.

Re-run it after any checklist re-capture and after any `make catalog` against a
new extension version. Deque revising either vocabulary is what breaks this file.

### Two notes for whoever authors the skill files

**The confidence field is the deliverable, not garnish.** A high row can be filed
unattended. A low row should reach the reviewer with its note attached, because
its five seconds of human attention is cheaper than a wrong issue on a real audit.

**Out-of-scope tests are mapped anyway.** Tests 2, 10 and 13 need a screen reader
and are out for v1, but their 10 slugs are mapped — the mapping is authoring-time
data, and leaving holes in it would make the check unable to assert completeness.
