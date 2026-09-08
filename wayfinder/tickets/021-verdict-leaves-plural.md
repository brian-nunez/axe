---
id: 021
title: Make Verdict carry multiple leaves
labels: [wayfinder:task]
state: closed
assignee: brian
blocked-by: []
---

## Question

[Settle the tool inventory and the MCP boundary](011-tool-inventory.md) gave `Verdict` a singular `leaf`. [Settle the skill file format](012-skill-file-format.md) found that is wrong for at least one predicate.

`check_table_semantics` covers three checklist branches — row and cell roles, header markup, and header associations — and they **co-occur constantly**. A table with the wrong cell roles usually also has the wrong header markup. A singular `leaf` files one and silently drops the others, which is under-reporting dressed as a pass.

Two changes:

1. **`leaf: string` becomes `leaves: string[]`.** A predicate returns every branch that fired. The skill file's routing table already reads as a per-leaf lookup, so `12-tables.md` needs no reshaping — its computed check says *for every name in that list, do its row below* and already assumes this.
2. **`check_table_semantics` needs a fourth leaf, `header-associations-wrong`.** Deque's association branch cites both `table-complex-no-header-associations` and `table-complex-association-incorrect` — missing versus incorrect — and that is a distinction the tool already computes internally. Collapsing them loses the more actionable of the two.

Check the other five predicates for the same problem while you are here. A predicate covering one branch keeps a single-element list rather than a special case; uniformity is worth more than the saved character.

Cheap, and worth doing before fifteen more skill files are written against the singular shape.

## Resolution

**Both changes, plus a second predicate that needed the same widening.** Recorded
as [011](011-tool-inventory.md) Amendment C.

```
Verdict<M> = { outcome: "fails" | "passes" | "not_applicable" | "undecidable",
               leaves: string[],   // every branch that fired; [] otherwise
               because,
               measured: M }
```

**`leaves` is always a list** — `[]` on `passes`, `not_applicable` and
`undecidable`, one entry for a single-branch predicate, no special case. The
uniformity is the point: a computed check reads `outcome` first and only ever
iterates `leaves` under `fails`, which is the same three lines in every skill
file. `12-tables.md` was already written this way and needed no reshaping.

**`check_table_semantics` gains `header-associations-wrong`.** Deque's
association branch cites both `table-complex-no-header-associations` and
`table-complex-association-incorrect`, and *missing* versus *incorrect* — no
`headers` attribute at all, versus one pointing at ids that do not resolve — is
already the distinction the tool computes internally. Four leaves:
`role-markup`, `header-markup`, `header-associations`,
`header-associations-wrong`.

### The other predicates, checked as asked

Five were single-branch, and one was not.

**`check_text_contrast` is the second predicate the plural earns its keep on.**
Test 4's branch reads *with the element unfocused **and** hovered* — two states,
either of which can fail independently. So `state` becomes optional in the way
that matters: omitted, the tool measures every state the element supports and
returns one leaf per failing state (`contrast-unfocused`, `contrast-hovered`,
`contrast-placeholder`); passed explicitly, it measures exactly that one, which
is what test 5's placeholder branch wants. Asking the model to call twice and
combine the two answers is the same under-reporting the singular `leaf` produced.

The rest are genuinely single: `check_accessible_name`'s `mismatch` and `order`
are mutually exclusive by definition, and `check_link_in_text_distinction`,
`check_autocomplete_purpose` and `check_target_size` each cover one branch. They
carry one-element lists.

The two predicates the neighbouring tickets add — `check_sort_state` from
[020](020-page-interaction-tools.md), which landed just before this one, and
`check_reflow` from [019](019-reflow-scroll-predicate.md), which lands just
after — are both single-branch, and both are stated in the plural. That is what
the widening is for: a predicate written next year gets the list without anyone
deciding whether its branch can co-occur with another.

**Eight predicates now return `leaves`, and two of them can return more than
one.** Cheap, and done before fifteen more files were written against the
singular shape.
