---
id: 022
title: Key the issue mapping by branch, and check the skill files against it
labels: [wayfinder:task]
state: closed
assignee: brian
blocked-by: []
---

## Question

[Export the manual issue catalog](006-export-issue-catalog.md) keyed `reference/issue-mapping.json` by slug, then by slug plus success criterion for the nine slugs cited under two criteria. [Settle the skill file format](012-skill-file-format.md) found a third case the key does not cover.

Two slugs are cited by **two branches that mean different things**, and 006 flagged both as low confidence for exactly that reason:

- `dual-role` — the mouse/keyboard parity branch and the WAI-ARIA-Authoring-Practices conformance branch want different catalog entries.
- `semantic-data-table` — the header-markup branch fits it; the `role=table`/`role=grid` row-and-cell-roles branch has no 1.3.1 entry at all.

`skills/page-state/12-tables.md` already files a Grid entry that exists only inside `semantic-data-table`'s prose note. It works, and **`make check-mapping` cannot see it** — the mapping has no row for that branch, so the checker cannot assert the skill file filed something legitimate.

Two changes:

1. **Add `byBranch` to the mapping**, alongside the existing `byCriterion`, so a slug cited by two branches carries a row per branch. The checker's completeness assertion then covers branches rather than slugs.
2. **Give `check-mapping` a skill-file pass.** Every `add_manual_issue` option text in `skills/` must appear in the mapping, and every HTML-comment audit trail (`slug @ criterion / confidence`) must name a row that exists. That closes the loop 012 opened: today a skill file can file a perfectly valid entry the mapping never sanctioned, and nothing notices.

Do this before the remaining fifteen files are authored. Retrofitting a checker across sixteen files costs more than building it against one.

## Resolution

**The mapping resolves branches, not slugs, and the checker now reads
`skills/`.** The checklist cites **103 branches across 92 slugs**, and every one
of the 103 resolves to a distinct catalog entry. `make check-mapping` proves it,
and proves the one skill file written so far files nothing the mapping has not
sanctioned.

```
reference/issue-mapping.json: 103 branches across 92 slugs, all resolving to entries in the 418-entry catalog
  by branch: high 94   low 9   unmapped 0
  by slug:   high 84   low 8   unmapped 0
  103 distinct catalog entries used
skills/: 1 file(s), 6 catalog citation(s) and 5 audit trail(s), all sanctioned by the mapping
```

### 1. `byBranch`

A row now carries **exactly one** of three shapes, and the checker enforces the
exclusivity:

| Shape | Rows | Selected by |
|---|---|---|
| `catalogOptionText` | 81 | nothing — one branch |
| `byCriterion` | 9 | the branch's own success criterion |
| `byBranch` | 2 | the branch name |

`byBranch` is shaped like `byCriterion`, with one addition that makes it
checkable: **each branch cell carries `when`, the checklist condition it serves,
verbatim from `page-state-tests.json`.** That string is the join. Without it a
branch name is an assertion about the checklist that nothing can test; with it,
the checker requires the mapping's branch set and the checklist's branch set to
be the same set, in both directions.

```json
"semantic-data-table": {
  "slug": "semantic-data-table",
  "successCriterion": "1.3.1",
  "pageStateTests": [12],
  "byBranch": {
    "role-markup": {
      "when": "the table has role=table or role=grid and a row is neither a tr nor role=row, …",
      "successCriterion": "1.3.1",
      "catalogOptionText": "Grid: Grid is missing appropriate roles and/or attributes (4.1.2.b, rgaa-7.1.2)",
      "catalogInstances": ["4.1.2.b"],
      "confidence": "low",
      "note": "Criterion shift. Nothing in the 1.3.1 family describes rows or cells missing their roles…"
    },
    "header-markup": {
      "when": "header cells do not carry the markup their header structure requires — …",
      "successCriterion": "1.3.1",
      "catalogOptionText": "Data table has missing or incomplete header cell markup (1.3.1.b, rgaa-5.7.1, rgaa-5.7.2)",
      "catalogInstances": ["1.3.1.b"],
      "confidence": "high"
    }
  },
  "confidence": "low"
}
```

**The Grid entry is now a field, not prose.** It was named only inside the old
row's `note` — which is exactly why `12-tables.md` could file it and no check
could see it. `role-markup` stays `low` because it is a real criterion shift
(4.1.2.b filed against a branch the checklist cites under 1.3.1), so the record
still reaches a reviewer with its note; `header-markup` is `high`, which the old
single row could not say because its sibling dragged it down.

`semantic-data-table`'s branch names are `check_table_semantics`' leaf names.
That is deliberate: the tool's vocabulary, the skill file's routing table and the
mapping now use one set of words for one set of branches.

**`dual-role` splits the way 006 said it should.** The mouse/keyboard parity
branch keeps `The element functions as if it has two roles. (4.1.2.b,
rgaa-7.1.1)` — an element that answers the mouse and the keyboard differently is
the entry's literal reading, and the alternative 006 named, *Function cannot be
performed by keyboard alone* (2.1.1.a), reports a criterion the checklist does
not cite here and covers only half the branch. The WAI-ARIA-Authoring-Practices
branch moves to `Custom user interface component is not compatible with AT
(4.1.2.c)`, which 006 named as its closer match. **Both stay `low`**: 4.1.2.c is
under the cited criterion, so `high` would pass the checker, but it names AT
incompatibility rather than departure from the Authoring Practices' keyboard
pattern — a widget can follow neither and still be announced correctly — and
nothing in the catalog names the Authoring Practices at all. Confidence is the
deliverable; a reviewer should still see this one.

**Two count fields, both checked.** `counts` is unchanged at 84/8/0 — it rolls a
slug up across its branches, and a slug is low if any branch of it is.
`branchCounts` is the new per-branch tally, **94 high, 9 low, 0 unmapped**, and
it is what the completeness assertion covers. 006's property survives the split
and is now stated by the checker: **103 branches, 103 distinct catalog entries,
no entry filed by two branches.**

### 2. The skill-file pass

Both directions of the join, over every `skills/**/*.md`.

**Catalog citations.** A catalog option text always ends in its parenthesised ids
— one WCAG instance id, then any RGAA mappings — so any quoted or backticked
string in a skill file matching that shape is a citation, wherever it sits. That
matters: `12-tables.md` cites entries from an `add_manual_issue` call, from a
routing table, from a report example, and from an authoring comment, and a
scanner that only read tool calls would miss three of the four. Six citations
found in that file, and each one must be

1. a verbatim catalog entry,
2. an entry some mapping branch resolves to, and
3. resolved by the mapping **for that file's own page state test**, read from
   the front matter's `test:`.

Rule 2 is 022's whole point. Rule 3 is nearly free and catches filing test 3's
entry out of test 12's file.

**Audit trails.** Every `slug @ criterion / confidence` inside an HTML comment
must name a row that exists, cited under that criterion, at that confidence.
Five found in `12-tables.md`; all five resolve. The parser also accepts an
optional branch qualifier — `slug#branch @ criterion / confidence` — because
`semantic-data-table @ 1.3.1` is now two rows and only the confidence separates
them. **That is a format addition and belongs to
[012](012-skill-file-format.md)**; nothing is required to use it, and
`12-tables.md` was not touched.

### Verified by mutation

Two runs, both against an isolated copy of the tree so the live
`12-tables.md` was never edited.

**Skill-file mutations — five deliberate breaks, five distinct messages, exit 1:**

```
  skills/page-state/12-tables.md: files "Skip link is broken (2.4.1.a, rgaa-12.7.2)", which the mapping resolves only for page state test 3, not 12
  skills/page-state/12-tables.md: files "ESC key does not close modal (2.1.1.a)" — a real catalog entry, but no mapping row resolves to it
  skills/page-state/12-tables.md: files "Complex table headers-id association is wrong (1.3.1.b, rgaa-5.7.4)", which appears nowhere in the catalog dump
  skills/page-state/12-tables.md: audit trail cites "table-data-headers-caption", which is not a mapping row
  skills/page-state/12-tables.md: audit trail cites table-complex-no-header-associations @ 1.3.1 / low, but the mapping reads high
```

`ESC key does not close modal` is the mutation that matters: a real, fileable
catalog entry that no mapping row sanctions. Before this ticket that was silent.

**Mapping-side mutations.** Deleting the `role-markup` branch — reverting the
gap 022 was opened for — produced six failures, including the skill file going
unsanctioned as a consequence:

```
  semantic-data-table: no mapping row serves the branch "the table has role=table or role=grid and a row is neither a…" (test 12, 1.3.1)
  counts.high reads 84, actual 85
  branchCounts.low reads 9, actual 8
  skills/page-state/12-tables.md: files "Grid: Grid is missing appropriate roles and/or attributes (4.1.2.b, rgaa-7.1.2)" — a real catalog entry, but no mapping row resolves to it
  skills/page-state/12-tables.md: audit trail cites semantic-data-table @ 1.3.1 / low, but the mapping reads high
```

Collapsing `semantic-data-table` back to one `catalogOptionText`, and detaching a
`dual-role` branch's `when` from the checklist:

```
  dual-role #aria-practices: "when" matches no checklist branch citing this slug
  dual-role: no mapping row serves the branch "the element is a known widget type (accordion, button, check…" (test 4, 4.1.2)
  semantic-data-table: cited by 2 branches under the one criterion 1.3.1, so it needs a byBranch row
```

Every mutation exited 1; restoring each produced a clean run at exit 0.

### Also changed

- `reference/README.md` — the `issue-mapping.json` section documents the three
  row shapes, the two count fields, and the skill-file pass.
- `Makefile` — `check-mapping`'s help line now says it reads `skills/` too.

`skills/page-state/12-tables.md` needed no change and got none. It passes as
written.

## For Brian

**One optional tightening of `12-tables.md`, for whoever owns it next.** Its step
6 comment cites `semantic-data-table @ 1.3.1 / low` once, for the Grid override,
and does not cite the `high` header-markup branch it also files. That passes —
the checker does not require a comment per filed entry, and requiring one would
be a format change 012 has not made. But with `byBranch` the file can now be
exact:

```
<!-- from: issue-mapping.json
     semantic-data-table#role-markup @ 1.3.1 / low — branch override, filed with a review note
     semantic-data-table#header-markup @ 1.3.1 / high
     table-complex-no-header-associations @ 1.3.1 / high
     table-complex-association-incorrect @ 1.3.1 / high -->
```

Not made here: the file is being edited concurrently, and the `#branch` syntax is
012's to ratify.

**Nothing needs to change in CONTEXT.md for this ticket.** *Design rules* already
says branches are mapped to catalog entries at authoring time and that a branch
stores the label; keying that mapping by branch is the same rule made to work,
not a new one. 012's outstanding CONTEXT note about `unfileable` findings and the
submission webhook is unaffected and still open.
