---
id: 012
title: Settle the skill file format
labels: [wayfinder:grilling]
state: closed
assignee: brian
blocked-by: [006, 008, 011]
---

## Source material

The 16 page state tests are now in [`reference/page-state-tests.json`](../../reference/page-state-tests.json) — structure, branch conditions, and the Deque issue identifier each leaf raises, captured from `${AXE_SERVER_URL}/coverage-page-state`. Branches carry `computable` and `requiresScreenshot` flags. Read [`reference/README.md`](../../reference/README.md) first: the Deque instance id is not a unique catalog key, which changes what a branch has to store.

## Question

What does one skill file look like, such that 23 of them can be written and a small local model can follow any of them?

The page state tests are decision trees with named outcomes — each leaf either raises a specific catalog issue or does not. Decide how a file expresses that tree, how a branch names its catalog entry, how the agent reports which branch fired, and where a branch declares that it needs a screenshot.

Write one file for a page state test as the worked example, and let the format fall out of it. Pick a test with real branching — #3 Page Structure or #12 Tables — rather than the easiest one.

Resolve with the format plus that one file.

## Resolution

**One Markdown file per page state test, in `skills/page-state/`, written as a
numbered procedure rather than a tree.** The worked example is
[`skills/page-state/12-tables.md`](../../skills/page-state/12-tables.md).

Manual path only. The IGT path gets no file of this shape — Deque asks those
questions and `Screen.answerWith` already names the next tool, so an IGT
sub-agent needs a category name and nothing else.

### Why a procedure and not a tree

The reader is Gemma 4 E2B — 2.3B effective parameters. A nested decision tree
asks it to hold a traversal in its head; a numbered list asks it to do one thing
and read the next line. Every construct below exists to move a decision out of
the model's head and onto the page:

- one question per step, phrased as yes/no
- a shared precondition becomes a **gate step** in front of the checks it guards,
  never a conjunction inside a condition
- the leaf name to report is written next to the answer, so reporting is copying
- computed checks state the tool call and a routing table, and ask no question at
  all

### The file

Front matter is the contract; the body is the run.

```yaml
---
test: 12                     # page state test number
name: Tables
path: manual
status: active               # active | held-back
scope: per-subject           # per-page | per-subject
find: "table, [role=table], [role=grid]"   # only when scope is per-subject
tools: [check_ledger, find_elements, describe_element,
        check_table_semantics, add_manual_issue]
visualSignoff: not-required  # not-required | pending | <model>@<date>
---
```

`tools` is the binding [Settle the tool inventory](011-tool-inventory.md)
describes, declared in the file so the file and the binding cannot drift.

`find` is passed verbatim to `find_elements`. It is a **CSS selector**, not a
natural-language query — 011 said test 12's per-table scope "is expressed as the
query", and the only version of that a small model can compose is one it copies.
Everything downstream substitutes `{table}` into a template string, which is
string substitution rather than selector authoring.

`visualSignoff` carries [018](018-vision-on-the-dev-model.md)'s gate on the
file's face. A file with
`requiresScreenshot` branches ships at `pending` and is not done until a
production model has run it on the same fixture and the leaves agree; the field
is then set to the model and date. Files 5, 6 and 9 carry it; the other thirteen
are born `not-required`.

### A check

Every check is one step. Judged checks look like this:

```markdown
## Step 4 — CHECK 12.1 — first row is really a caption

Evidence: text.

Call `find_elements(query: "{table} tr, {table} [role=row]", limit: 3)`.

Ask: does the **first** row returned hold caption-like information — a title,
a description, a date range, a source note — rather than data or column headers?

- **yes** → leaf `12.1.captiony`.
  Call `add_manual_issue(selector: <the first row's selector>, issue: "First row of data table is really a caption (1.3.1.b)")`
  Record `outcome: fail`, `filed:` that same issue text.
  <!-- from: issue-mapping.json / table-data-headers-captiony @ 1.3.1 / high -->

- **no** → leaf `12.1.pass`. Record `outcome: pass`. File nothing.
```

Five things are load-bearing.

**`Evidence:` is where a branch declares it needs a screenshot.** Every check
carries the line, and it is written out even when it says `text`, so the model
never infers it. `text` and `image` are the two values, and they are the `need`
argument of `describe_element` unchanged. Putting it on the check rather than the
test is deliberate and is the position [019](019-reflow-scroll-predicate.md) is
arguing for: test 9's flag sits on the test today and one of its four branches
does not deserve it. The format has no test-level evidence flag to be wrong with.

**A branch names its catalog entry by full option text, verbatim, inline in the
tool call.** Not by slug, not by instance id, not by a lookup the model performs.
`add_manual_issue` fails `ambiguous` unless the string filters the 418 entries to
one, so a typo is a loud failure at the boundary rather than a wrong issue on a
real audit.

**An HTML comment beside the leaf names the mapping row it came from** — slug,
criterion, confidence. It is invisible to the model and it is the audit trail: it
is what lets a checker join a skill file back to `reference/issue-mapping.json`,
and what tells the next author why this entry and not a sibling. The criterion is
in the comment because the lookup key is slug **plus** criterion; nine slugs
resolve differently under each of two.

**The leaf id is `<test>.<check>.<name>`.** It is written next to the answer, so
"the agent reports which branch fired" is a copy, not a paraphrase. Pass leaves
are named too (`12.1.pass`) — an unnamed pass is a hole in the report.

**Each outcome carries its whole action.** File-or-not, record-what, move-where.
No step ends with the model holding state it must apply later.

### A computed check

The tool decides and the file routes. The check asks the model nothing:

```markdown
Computed. The tool decides. Answer nothing yourself here.

Call `check_table_semantics(selector: "{table}")`.

Read `outcome` first:
- `passes` → leaf `12.3.pass`. Record `outcome: pass`. File nothing.
- `not_applicable` → leaf `12.3.not-applicable`. Record `outcome: not-applicable`.
- `fails` → read `leaves`. For every name in that list, do its row below.
```

Then a two-column table from the tool's leaf name to the leaf id and the action.

**The condition prose is absent from a computed check.** Deque's wording for
these three branches is 60 words of markup rules, and printing it beside a tool
call invites a 2B model to answer it. The rule is: a predicate's leaf names are
the tool's vocabulary, and the file's routing table is the only place they are
joined to leaf ids. Nothing else in the file mentions them.

`undecidable` — 011's fourth `Verdict` outcome, which only
`check_link_in_text_distinction` returns — routes to a judged fallback step in
the same file, and that step carries its own `Evidence:` line. Test 12 has no
such branch; test 5 does, and its file will carry the shape.

### Six outcomes

| Outcome | Means |
|---|---|
| `pass` | the check ran and found nothing |
| `fail` | the branch fired and the entry was filed |
| `unfileable` | the branch fired and nothing in the catalog can carry it |
| `not-applicable` | the check's subject is not on this page state |
| `blocked` | the check cannot run with the tools bound |
| `not-run` | held back from v1 |

`not-applicable` earning its own outcome is the point of the set. *No tables on
this page* and *the tables are fine* are the same silence and opposite findings,
and a reviewer working from a draft has to be able to tell them apart.

**A file lists only the outcomes its own steps can produce.** `12-tables.md`
names four. Teaching a small model outcomes it can never reach is a way to get
them.

### The report

One YAML block at the end, one record per check per subject:

```yaml
test: 12
name: Tables
status: complete            # complete | not-run | aborted
subjects: 2
records:
  - check: "12.1"
    subject: "table#quarterly-rates"
    outcome: fail
    leaf: "12.1.captiony"
    filed: "First row of data table is really a caption (1.3.1.b)"
    note: "…"               # only where a step asked for one
```

`filed` appears only after an `add_manual_issue`, so the report and the ledger
can be reconciled without reading the panel. What the parent does with this is
[Settle the agent graph](013-agent-graph.md)'s business; this is the shape it
receives.

### The eight low-confidence mappings

**Filed, with the note attached to the record.** [006](006-export-issue-catalog.md)
settled the reasoning — five seconds of reviewer attention beats a wrong issue —
and the format's job is to make sure the note travels. A low-confidence leaf
carries `note:` text that says what is uncertain, in the reviewer's words:

```markdown
| `role-markup` | `12.3.role-markup` | file `Grid: Grid is missing appropriate roles and/or attributes (4.1.2.b, rgaa-7.1.2)` — record `outcome: fail` and `note: "review — Deque's checklist cites 1.3.1 for this branch and this entry reports 4.1.2.b; no 1.3.1 entry describes missing row or cell roles"` |
```

**Not filing them was considered and rejected.** The output is a draft a human
confirms, corrects or rejects. A flagged entry in the ledger costs one rejection;
a withheld one is a finding the reviewer never sees.

Two of the eight are *one slug, two branches* (`semantic-data-table`,
`dual-role`), where the mapping's `catalogOptionText` fits one branch and its
`note` names a better entry for the other. The file resolves per branch and
records the override in its authoring comment — `12-tables.md` does exactly this
for `role-markup`. See the amendment below.

### The two branches with nothing fileable

`unexpected-change-on-interaction` and `keyboard-shortcut-conflict` are not
uniformly unfileable. Each splits, and the split is what the mapping's note
already says. So the format's answer is a **two-leaf check**, not a special case.

Test 14, check 1 — a custom shortcut conflicts with an existing shortcut:

```markdown
- **it collides with a screen reader command** → leaf `14.1.screenreader`.
  Call `add_manual_issue(selector: "{element}", issue: "Action cannot be performed with a screen reader turned on (2.1.1.a, rgaa-7.3.1)")`
  Record `outcome: fail` and `note: "review — filed as the screen-reader symptom; Deque's catalog names no shortcut conflict"`.
  <!-- from: issue-mapping.json / keyboard-shortcut-conflict @ 2.1.1 / low -->

- **it collides with a browser shortcut** → leaf `14.1.unfileable`.
  File nothing. Record `outcome: unfileable` and
  `note: "custom shortcut collides with a browser shortcut; nothing under 2.1.1 covers it"`.
  Include the shortcut and what it collides with in the note.
```

Test 4, the *changing a setting causes an unwarned change of context* check,
splits the same way: a form field files
`Form field causes unexpected change (3.2.2.a, rgaa-7.4.1, rgaa-13.2.1)`; a
non-form widget goes `unfileable`, because the exact wording exists as
`A change of context not requested` but under 3.2.5.a, and filing it would report
a criterion the checklist does not cite.

**What `unfileable` costs, said plainly.** The finding reaches the run output and
never reaches the extension's saved test. For v1 that is survivable — CONTEXT
holds submission back and v1 prints the agent's output, so the reviewer sees the
whole report. It stops being survivable the moment the Custom Integration webhook
ships, because that path submits the saved test and an `unfileable` finding is
invisible to it. Recorded below as something CONTEXT should say.

### A held-back branch

`status: held-back` on the test, or on a single check where only part of a test
is out. A held-back file is complete and executable — it emits one record and
stops — and **its `tools` list is empty**, so a held-back sub-agent structurally
cannot touch the ledger.

````markdown
---
test: 13
name: Time Limits
path: manual
status: held-back
heldBackReason: "the warning and extension checks require a screen reader and waiting out the limit; auditors run this by hand"
scope: per-page
tools: []
visualSignoff: not-required
---

# Page state test 13 — Time Limits

Not run in v1. Emit this report and stop. Call no tool.

```yaml
test: 13
name: Time Limits
status: not-run
subjects: 0
records:
  - check: "13.0"
    subject: page
    outcome: not-run
    leaf: "13.0.held-back"
    note: "requires a screen reader; auditors run this by hand"
```

## Mapped entries, for the screen-reader lane

Authoring-time data. The run above never reaches it.

| Branch | Criterion | Catalog entry |
|---|---|---|
| … | … | … |
````

The mapped entries stay in the file rather than living only in
`reference/issue-mapping.json`. They are what makes the file runnable the day the
screen-reader lane exists, and keeping them here is what lets a checker assert
that every one of the 92 slugs is claimed by some skill file — the completeness
property [006](006-export-issue-catalog.md) built `make check-mapping` for.

Tests 2, 10 and 13 take this shape. **Test 10 is the one to revisit first**: its
own `outOfScopeReason` says "the announcement half requires a screen reader;
detecting live regions does not", and its second branch — a status message
disappearing while the status still applies — needs no screen reader at all. That
is a check-level `status: held-back` waiting to be lifted, not a test-level one.
Not lifted here; scope says the test is out.

### Why `skills/page-state/12-tables.md`

A new top-level `skills/`, split by path.

`reference/` is explicitly *source material captured because it is not otherwise
reachable from code* — Deque's, snapshot-and-re-capture, never hand-edited. Skill
files are the opposite on every axis: ours, hand-authored, the thing the project
produces. Putting them there would corrupt the one directory whose staleness rule
matters.

`skills/page-state/` rather than `skills/` flat, because CONTEXT's *Two paths*
says keep the machines apart, and an `skills/igt/` directory is the natural home
for whatever thin per-category files the IGT path turns out to need. Numbering by
test id (`12-tables.md`) matches the ticket convention already in the repo and
makes the binding table in 011 a filename lookup.

The format itself lives in this ticket, not in a `skills/README.md`, because
that is where this repo puts specs — 011's tool inventory is the precedent — and
because a second copy is a second thing to keep true.

## Found by writing the file

Four things a worked example surfaced that the specs did not.

### 1. The manual tool set can read the page but cannot act on it

This is the significant one. [011](011-tool-inventory.md) binds a manual
sub-agent `find_elements`, `describe_element`, `add_manual_issue` and its
predicates. None of them clicks, types, presses a key, or resizes the viewport.
At least six of the sixteen tests need to act on the page:

| Test | Needs |
|---|---|
| 1 Automatic Behavior | operate the pause/stop control to see whether it works |
| 4 Interactive Elements | activate a component, hover it, change a select's value |
| 8 Focus Management | activate a component by keyboard, then observe where focus went |
| 9 Text Resize, Reflow, Spacing | set zoom, set a 320px viewport, inject the text-spacing stylesheet |
| 12 Tables | sort the table, then re-read the sorted header |
| 14 Shortcuts, 15 Motion and Gestures | press the shortcut, perform the gesture |

`find_elements(query, { pass: "focused" })` covers focusing and nothing else.
[017](017-igt-page-state-tolerance.md) has already measured that the viewport and
CSS half is safe — resize, CSS injection, scroll and DOM mutation fire no guard —
so the blocker is a missing tool, not a risk.

`12-tables.md` handles it honestly rather than pretending: check 12.2 gates on
*is this table sortable*, records `not-applicable` when it is not, and records
`blocked` when it is, with the table's selector and one line of reason. Reading
`aria-sort` as the page arrives would pass every table nobody has sorted yet,
which is a false pass on a real audit. The file carries the completed leaf in an
authoring comment, so the day the tool exists the check is a two-line edit.

**This wants its own ticket** — a page-interaction tool set for the manual path,
sized against those six tests, respecting 017's navigation boundary.

### 2. `Verdict.leaf` has to be `leaves`

011 gives `Verdict` a singular `leaf`, and `check_table_semantics` covers three
branches that co-occur constantly: a grid missing row roles usually also has
broken header markup. A singular leaf files one and drops the others.

`12-tables.md` is written against `leaves: string[]`, and routes each name in the
list through the same table. Iterating a short list of strings against a
two-column table is within a 2B model; reasoning over `measured` to discover a
second failure is not.

The other five predicates are single-branch and unaffected, so this is a widening
of the type, not a redesign: `leaves` is `[]` on a pass and one entry everywhere
except `check_table_semantics`.

While there: `check_table_semantics` needs a **fourth** leaf. Deque's
association branch cites two issues, and *missing* versus *incorrect* is exactly
the distinction the tool is already computing — no `headers` attribute at all
versus a `headers` attribute pointing at ids that do not resolve. Leaves:
`role-markup`, `header-markup`, `header-associations`,
`header-associations-wrong`.

### 3. `issue-mapping.json` needs a `byBranch`, for two rows

The mapping is keyed slug + criterion. `semantic-data-table` and `dual-role` are
one slug cited by two branches that mean different things, and 006 says so in
prose — the fitting entry sits in `catalogOptionText`, the other branch's entry
is named only inside the `note`.

`12-tables.md` therefore files an option text that is not a field of the row it
came from: the Grid entry for `role-markup` lives in `semantic-data-table`'s note.
That works, and it is unverifiable — `make check-mapping` cannot see it.

Two ways to close it, and they compose:

- **`byBranch` on those two rows**, shaped like the existing `byCriterion`, so
  every entry a skill file can file is a field somewhere.
- **A skill-file pass in the checker**: every `issue:` string in every
  `skills/**` file must equal a catalog `optionText` verbatim, and every
  `<!-- from: -->` comment must resolve to a mapping row. That is the check that
  makes the format enforceable rather than conventional, and it catches the typo
  class `add_manual_issue` would otherwise catch only at runtime, four hours in.

Both are cheap. Neither is in this ticket's scope.

### 4. Every filed issue needs an element, and one branch has none

`add_manual_issue(selector, issue)` requires a selector. Test 3's
`structure-major-problems` — *no heading at the top of main content, no main
landmark, and no skip link* — is a finding about the **absence** of elements.
`12-tables.md` never hits this; `3-page-structure.md` will, on its first run
against a bad page.

The format's answer, for the author of file 3: the check files against the
element the missing structure should have wrapped — the first block of main
content, found by `find_elements` — and the note says the issue is an absence.
That is what a human auditor does with the same form. Worth stating once here so
sixteen authors do not each invent something different.

## For Brian

**CONTEXT.md**, under *Held back on purpose*, beside *Submission*. One sentence,
because the gap only opens when submission ships:

> A finding the catalog cannot carry is recorded in the run output and **not** in
> the saved test. v1 prints the output, so a reviewer sees it. The Custom
> Integration webhook submits the saved test, so those findings become invisible
> the day it ships — closing that is part of the submission work, not before it.

**Three follow-up tickets**, in this order:

1. **A page-interaction tool set for the manual path.** Blocks six of the sixteen
   files. Biggest single gap between 011's inventory and what the checklist
   actually asks for.
2. **`leaves` on `Verdict`, plus `check_table_semantics`'s fourth leaf.** Small,
   and file 12 is already written against it.
3. **`byBranch` in `issue-mapping.json`, and a skill-file pass in
   `check-mapping`.** Makes the format enforceable.

---

# Amendments

Everything above is the resolution as it closed. Each section below is an
amendment, named for the ticket that caused it.

## Amendment A — from [023](023-graph-tool-amendments.md): the report is a tool argument

**The closing YAML block is delivered as the argument of `finish_unit`, not as
free text at the end of a message.**

Free text means the parent parses prose from a 2B model to learn whether the unit
finished. A tool call is structured, it gives the parent a parse point instead of
a scrape, and it gives [013](013-agent-graph.md) an unambiguous completion signal
in the same move.

The format is otherwise unchanged. The file still shows one YAML block, still one
record per check per subject; the last step now reads *call
`finish_unit(report: <the block>)`* rather than *emit the block*. The argument is
the YAML **verbatim and unparsed** — a 2B model copying the shape it was shown is
a task it can do, and filling a nested tool schema is not.

Three consequences for the front matter:

- **Every `tools:` list gains `finish_unit`.**
- **A held-back file carries `tools: [finish_unit]`, not `tools: []`.** The
  example above shows test 13 with an empty list; it needs the one tool, or
  *"emit this report and stop"* is something the file cannot actually do. A
  held-back leaf is still structurally unable to touch the page or the ledger,
  which was the whole point of the empty list.
- **`finish_unit` is not an MCP tool** — the leaf graph provides it. 013's
  startup cross-check of front matter against served tools must resolve names
  against the MCP set **plus `finish_unit`**, or all twenty-three files fail
  validation at second zero. Recorded in
  [011](011-tool-inventory.md)'s Amendment A5.

Test 13's front matter, corrected:

```yaml
tools: [finish_unit]
```

## Amendment B — from [020](020-page-interaction-tools.md): the manual path can act on the page

*Found by writing the file §1* is resolved. The eight page-interaction tools and
the two acting predicates are in
[011](011-tool-inventory.md)'s Amendment B and D. Three things follow for the
format.

**1. `12-tables.md` check 12.2 is no longer `blocked`.** It is a computed check
routing on `check_sort_state`, and the finished leaf the authoring comment
carried is now the live one. The file is the proof 020 asked for.

**2. A file lists only the outcomes its own steps can produce — so a file that
loses its last `blocked` step drops `blocked` from its list.** `12-tables.md`
keeps it only because step 1's ledger check can still record it. The rule bites
in both directions and is worth restating: teaching a small model an outcome it
can never reach is a way to get it.

**3. New format rule — a step that follows a tool which invalidates refs re-finds
its elements, and the file says so.** Several interaction tools reload or
navigate, and each reports `aftermath.refsInvalidated`. An `ElementRef` handed
out before one of those is void. The model must not be the thing that remembers
this: the step after such a call repeats its `find_elements` explicitly, as a
written instruction, exactly the way a gate step is written out rather than
folded into a condition.

**Where an interaction tool's own restore replaces an instruction**, the file
says nothing at all. `capture_under` and `check_reflow` put the viewport back
themselves; a skill file that also told the model to restore it would be handing
a 2B model a duty it does not have and cannot verify.

## Amendment C — from [021](021-verdict-leaves-plural.md): `leaves` confirmed

`Verdict.leaves: string[]` is settled in
[011](011-tool-inventory.md)'s Amendment C, together with
`check_table_semantics`'s fourth leaf. **The format needed no change** —
*Found by writing the file §2* had already written `12-tables.md` and the
computed-check shape above against the plural.

One clarification the widening adds: **`leaves` is `[]` on `passes`,
`not_applicable` and `undecidable`**, so a computed check reads `outcome` first
and only ever iterates `leaves` under `fails`. That is what the example above
already does, and it is now the rule rather than the example's habit.

`check_text_contrast` is the second predicate that can return more than one leaf
— test 4's branch asks about the unfocused *and* hovered states and either can
fail. A file binding it therefore routes it through a table, exactly as
`12-tables.md` routes `check_table_semantics`, rather than reading a single
answer out of it.

## Amendment D — from [019](019-reflow-scroll-predicate.md): `Evidence:` on the check is vindicated

`requiresScreenshot` has moved from the test to the branch in
`reference/page-state-tests.json`, which is the position this format already
took: `Evidence:` sits on the check, and the format has no test-level evidence
flag to be wrong with.

The concrete shape for the file that motivated it — test 9, when it is written —
is one `Evidence: text` check and three `Evidence: image` ones:

| Check | Line | Tool |
|---|---|---|
| 9.1 content lost under doubled text | `Evidence: image.` | `capture_under(condition: "zoom-200")` |
| 9.2 horizontal scrolling at 320px | `Evidence: text.` | `check_reflow()` — computed, routes an `undecidable` to a judged fallback step |
| 9.3 content lost at 320px | `Evidence: image.` | `capture_under(condition: "viewport-320")` |
| 9.4 content lost under text spacing | `Evidence: image.` | `capture_under(condition: "text-spacing", width: <breakpoint>)` |

So test 9 ships `visualSignoff: pending` on account of three checks, not four,
and 9.2 asks the model for nothing at all.

## Amendment E — from [025](025-build-v0.md)'s reopening: the most concrete object in a file is the one the model reaches for

The format's worked example is `12-tables.md` and the format's rules are about
steps, checks and leaves. It says nothing about **which artefact in a file is the
most copyable**, and that turns out to decide what a small model does when it is
unsure.

### E1. A file carries exactly one fully-worked report, and it is a completed one.

`skills/igt/procedure.md` shipped with a complete, fill-in-the-blank `aborted`
report inside step 1 — testing the ledger, the first step of the file, in the
system message from the first token. It was **the only fully-worked report in the
document**. The closing report at the end was a template with placeholders; the
abort was a finished object with two blanks.

A model that hits anything it cannot resolve reaches for the nearest complete
artefact. It reached for that one, and 025's failing run copied it almost
verbatim — `status: aborted`, `outcome: blocked`, `leaf: "0.ledger-lost"` — over
an intact ledger, on a guided test two screens from its results. The leaf name
alone should have been impossible: nothing had lost a ledger.

The rule the format now carries:

> **The one fully-worked report in a file is the one a unit that did its work
> writes.** Every other ending — blocked, not-applicable, nothing found — is
> described as a variation on it: which `status`, which single record, which
> `leaf`. A row in a table, not a block to copy.

`skills/igt/procedure.md` and `11-alternatives-for-timed-media.md` are both
written this way now: one YAML block, then a three-row table of the shapes a unit
can end in. An abort is reachable, spelled out, and not the easiest thing in the
file to copy.

This generalises past reports. **A complete copyable artefact beats an
instruction the model has to synthesise**, so the format's authors should place
the concrete object on the path they want taken, and describe the paths they do
not.

### E2. A file states one abort rule, in one place.

The same file said two contradictory things: step 6 said abort when `igt_finish`
returns `ok: false`, and step 4 said a refused tool is never a reason to abort.
The model followed the abort.

The single source of truth is the refusal contract in
[011](011-tool-inventory.md) Amendment F1 — `retryable` says whether another call
can succeed — so a skill file needs no per-step abort rule at all. One step
reads a refusal and routes on it; every other step is silent about refusals. A
second step that mentions aborting is a second definition, and two definitions of
one fact drift.

### E3. Steering by prohibition is out of the format.

Both v0 files opened with *Do not skip a step. Do not add a check of your own*,
and the IGT file's recovery step read *A refused tool is not a lost ledger: do
not write an `aborted` report*. Naming the forbidden behaviour is what puts it in
context — the report the model wrote was the one that sentence forbade, in the
step that forbade it.

The format prompts the positive: *Work the steps in order, and run every step you
are sent to*; *A refusal is the tool telling you which call does work*. A
prohibition earns a place only as a guardrail with no positive phrasing, and
neither of those was.

### E4. A branch leads with its tool call.

Every filing branch in `11-alternatives-for-timed-media.md` was written as *leaf
name, then the `add_manual_issue` call, then what to record*. A run reached the
right branch, named the right leaf, and never called the tool — it wrote the
finished record as prose instead.

The branch now leads with the call and follows with the bookkeeping:

```markdown
- **there are no captions** → call `add_manual_issue(selector: "{media}", issue: "...")`

  Then record `outcome: fail`, `leaf: "11.4.captions-missing"`, `filed:` that same issue text.
```

Same information, and the first thing on the line is the thing that has to
happen. The leaf name is bookkeeping for the report; the call is the audit.

### E5. A per-subject file says how the subject loop ends.

`11-alternatives-for-timed-media.md` closed each terminal check with *Then move
to the next subject*, and said nowhere what to do when there is no next subject.
On a page state with one medium the model ran out of instructions at exactly the
point it was supposed to report, and answered in prose.

A per-subject file closes the loop explicitly: *Then take the next subject from
step 2 and run step 3 on it. When every subject has been worked, go to step
&lt;the report step&gt;.*

## Amendment F — from [025](025-build-v0.md)'s five-run bar: a check can be computed without a predicate tool

[011](011-tool-inventory.md) computes a branch by building a **predicate tool**
for it, and its table says the other eleven page state tests get no predicates at
all — *four tools each, and the model does the judging Deque's checklist asks
for*. Test 11 is one of the eleven, and one of its checks turned out to be
measurable with the tools it already has.

Check 11.4's first half is *is a captions track there*. As prose it read *are
there captions, and do they carry all the dialogue, stay in sync, name every
speaker and describe the important sounds* — a conjunction inside a condition,
which this format already forbids, and the model answered the whole thing `pass`
against markup with no `<track>` in it. Twice.

Split, the first half is a selector:

```markdown
Call `find_elements(query: "{media} track[kind=captions], {media} track[kind=subtitles]")`

- **an empty list** → this medium has no captions track → call `add_manual_issue(...)`
```

**The format's rule, stated once:** a check whose condition is *does an element
like this exist* is written as a `find_elements` call and a routing table, not as
a question. `find` in front matter already establishes that a skill file composes
CSS selectors for the tool layer to resolve; this is the same move inside a
check. The routing is on an empty list against a non-empty one, which is a
distinction a 2B model makes reliably and a judgement it does not.

Two things this depends on, both settled in [011](011-tool-inventory.md)
Amendment F4: `find_elements` answers an empty match with an **empty list**
rather than `not_found`, and an empty list is that check's verdict rather than
its failure.

**Measured.** Across the five consecutive runs that closed 025, the converted
check filed the right catalog entry five times in five. The checks left as
judgements in the same file are the ones that still wobble — three of the five
reports claimed a `filed:` for a judged branch that no call had filed. That is
the strongest argument the format has for the rule: **look for the selector
before writing the question.**

One limit worth writing down. Only the *existence* half converts. Whether a
transcript that exists covers what is shown as well as what is said is not a
selector, and 11.6's second half stays a judgement — as does the whole of 11.5's
question about information carried only visually. The rule is not *compute
everything*; it is *do not phrase as a judgement something a selector answers*.
