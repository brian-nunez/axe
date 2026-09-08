---
test: 12
name: Tables
path: manual
status: active
scope: per-subject
find: "table, [role=table], [role=grid]"
tools: [check_ledger, find_elements, describe_element, check_sort_state,
        check_table_semantics, add_manual_issue, finish_unit]
visualSignoff: not-required
---

# Page state test 12 — Tables

Audit every data table on this page state. Three checks per table.

Run the steps in order. Do not skip a step. Do not add a check of your own.

`{table}` below always means the `selector` string that step 2 returned for the
table you are working on. Copy it exactly; do not shorten or rewrite it.

## Step 1 — confirm the ledger

Call `check_ledger()`.

- `ok: true` and `alive: true` → go to step 2.
- anything else → stop. Call `finish_unit` with exactly this report and do
  nothing else:

  ```yaml
  test: 12
  name: Tables
  status: aborted
  subjects: 0
  records:
    - check: "12.0"
      subject: page
      outcome: blocked
      leaf: "12.0.ledger-lost"
      note: "check_ledger did not return alive"
  ```

## Step 2 — find the subjects

Call `find_elements(query: "table, [role=table], [role=grid]")`.

- empty list → stop. Call `finish_unit` with exactly this report and do nothing
  else:

  ```yaml
  test: 12
  name: Tables
  status: complete
  subjects: 0
  records:
    - check: "12.0"
      subject: page
      outcome: not-applicable
      leaf: "12.0.no-tables"
      note: "no table, role=table or role=grid on this page state"
  ```

- one or more → work through them **one at a time**, in the order returned.
  For each, run step 3, then steps 4, 5 and 6. Finish a table before starting
  the next one.

## Step 3 — gate: is this a data table?

Call `describe_element(selector: "{table}", need: "text")`.

Ask: does this element present rows and columns of **data**, where a cell's
meaning depends on the row or column it sits in?

Signals it is a data table: a `<caption>`, header cells, a column of like values
under a label, a row of like values beside a label.

Signals it is a layout table: no header cells and no caption, and the cells hold
unrelated blocks — a logo beside a menu, a form beside an image — that would
still make sense in any order.

- data table → go to step 4.
- layout table → record this and move to the next subject:

  ```yaml
  - check: "12.0"
    subject: "{table}"
    outcome: not-applicable
    leaf: "12.0.layout-table"
    note: "presents layout, not data"
  ```

## Step 4 — CHECK 12.1 — first row is really a caption

Evidence: text.

Call `find_elements(query: "{table} tr, {table} [role=row]", limit: 3)`.

Ask: does the **first** row returned hold caption-like information — a title, a
description, a date range, a source note — rather than data or column headers?

- **yes** → leaf `12.1.captiony`.

  Call `add_manual_issue(selector: <the first row's selector>, issue: "First row of data table is really a caption (1.3.1.b)")`

  Record `outcome: fail`, `filed:` that same issue text.

  <!-- from: issue-mapping.json / table-data-headers-captiony @ 1.3.1 / high -->

- **no** → leaf `12.1.pass`. Record `outcome: pass`. File nothing.

## Step 5 — CHECK 12.2 — sort state

Computed. The tool decides. Answer nothing yourself here.

Call `check_sort_state(selector: "{table}")`.

The tool sorts the table itself. Do not sort it yourself, and do not run this
step before step 4 — sorting changes which row is first.

Read `outcome` first:

- `passes` → leaf `12.2.pass`. Record `outcome: pass`. File nothing.
- `not_applicable` → leaf `12.2.not-sortable`. Record `outcome: not-applicable`.
  File nothing.
- `fails` → read `leaves`. **For every name in that list**, do its row below.

| `leaves` entry | leaf | do |
|---|---|---|
| `sort-state` | `12.2.sort-state` | file `State: Table sort state is missing or incorrect (4.1.2.a, rgaa-7.1.1)` — record `outcome: fail` |

The file call is
`add_manual_issue(selector: "{table}", issue: "State: Table sort state is missing or incorrect (4.1.2.a, rgaa-7.1.1)")`.

Put the tool's `because` line into the record's `note`.

<!-- from: issue-mapping.json / state-table-sort @ 4.1.2 / high -->

## Step 6 — CHECK 12.3 — table semantics

Computed. The tool decides. Answer nothing yourself here.

Call `check_table_semantics(selector: "{table}")`.

Read `outcome` first:

- `passes` → leaf `12.3.pass`. Record `outcome: pass`. File nothing.
- `not_applicable` → leaf `12.3.not-applicable`. Record `outcome: not-applicable`.
  File nothing.
- `fails` → read `leaves`. **For every name in that list**, do its row below.
  Each row that files produces its own record.

| `leaves` entry | leaf | do |
|---|---|---|
| `role-markup` | `12.3.role-markup` | file `Grid: Grid is missing appropriate roles and/or attributes (4.1.2.b, rgaa-7.1.2)` — record `outcome: fail` and `note: "review — Deque's checklist cites 1.3.1 for this branch and this entry reports 4.1.2.b; no 1.3.1 entry describes missing row or cell roles"` |
| `header-markup` | `12.3.header-markup` | file `Data table has missing or incomplete header cell markup (1.3.1.b, rgaa-5.7.1, rgaa-5.7.2)` — record `outcome: fail` |
| `header-associations` | `12.3.header-associations` | file `Complex table is missing headers-id association (1.3.1.b, rgaa-5.6.4, rgaa-5.7.4)` — record `outcome: fail` |
| `header-associations-wrong` | `12.3.header-associations-wrong` | file `Complex table headers-id association is incorrect (1.3.1.b, rgaa-5.7.4)` — record `outcome: fail` |

Every file call is `add_manual_issue(selector: "{table}", issue: <the text above, verbatim>)`.

Copy the issue text between the backticks exactly, including the parentheses.
`add_manual_issue` fails `ambiguous` on anything else.

Put the tool's `because` line into each record's `note`, after the review text
where there is review text.

<!-- from: issue-mapping.json
     semantic-data-table @ 1.3.1 / low — its catalogOptionText covers
       header-markup only; the note says the role branch has no 1.3.1 entry and
       names the 4.1.2.b Grid entry used above. Branch override, filed with a
       review note.
     table-complex-no-header-associations @ 1.3.1 / high
     table-complex-association-incorrect @ 1.3.1 / high -->

## Step 7 — report the unit

Call `finish_unit(report: <the YAML block below>)`. That call is the last thing
you do. Write no text after it.

```yaml
test: 12
name: Tables
status: complete
subjects: <how many step 2 returned>
records:
  - check: "12.1"
    subject: "table#quarterly-rates"
    outcome: fail
    leaf: "12.1.captiony"
    filed: "First row of data table is really a caption (1.3.1.b)"
```

One record per check per subject, in the order you ran them. Fields:

| Field | Always | Value |
|---|---|---|
| `check` | yes | the check number, quoted |
| `subject` | yes | the `{table}` selector, or `page` |
| `outcome` | yes | `pass`, `fail`, `not-applicable` or `blocked` |
| `leaf` | yes | the leaf id from the step you took |
| `filed` | only after an `add_manual_issue` | the issue text you passed |
| `note` | only where a step asked for one | one line |

`blocked` is reachable from step 1 alone. Every other step ends in `pass`, `fail`
or `not-applicable`.

`status` is `complete` when every subject reached step 6, `aborted` when step 1
stopped the run.
