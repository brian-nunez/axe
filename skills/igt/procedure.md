---
path: igt
status: active
scope: per-category
tools: [check_ledger, igt_start, igt_current, igt_answer, page_state_warning, finish_unit]
visualSignoff: pending  # the tool layer answers four of Structure's questions with a screenshot (027)
---

# Intelligent Guided Test — the procedure

One shared procedure serves every category. Deque asks the questions; you answer
them, one screen at a time, until Deque says the test is over.

**`igt_answer` answers every screen.** There is one answering tool and there is
no screen it is the wrong call for. What changes from screen to screen is the
argument, and the screen names it in its `send` field.

Deque decides when the test ends, and it says so by handing you a screen whose
`kind` is `results`. Until that screen arrives, there is another question to
answer, however many you have already answered.

## Step 1 — confirm the ledger

Call `check_ledger()`.

- `ok: true` and `alive: true` → go to step 2.
- anything else → go straight to step 5 and report the unit blocked, using the
  `verdict` the tool returned.

## Step 2 — start the guided test

Call `igt_start(category: "<the category you were asked to run>")` once.

It returns your first `Screen`. Go to step 3.

From here on the panel is inside a running test, and `igt_current()` is how you
re-read where you are.

## Step 3 — answer the screen

Read `send`. Call `igt_answer` with that argument. It returns the next screen.
Do step 3 again on that screen.

| `kind` | `send` | What to send |
|---|---|---|
| `single_choice` | `choice` | Read `question` and `help`. Decide `yes` or `no`. |
| `per_element` | `answers` | Read `groups`. Each entry is one element of the page, named in its `label`. Decide `yes` or `no` for **every** `ref`: `answers: [{"ref": "<ref>", "answer": "yes"}, {"ref": "<ref>", "answer": "no"}]` |
| `element_multiselect` | `refs` | Read `options`. Send the `ref` of each option that applies. An empty list is a real answer; send `refs: []` when none does. |
| `element_picker` | `refs` | Read `pageOutline`. Send the `ref` of each element that answers the question the screen asks. Send `refs: []` if none does. |
| `results` | `nothing` | Deque has asked its last question. Call `igt_answer()` with no argument. Go to step 4. |

Three things about answering, and they are the ones that go wrong:

**Some screens arrive with a picture of the page.** When `evidence` holds an
entry whose `kind` is `image`, a screenshot of the whole page is attached to that
tool result. Look at it. Those questions ask how the page *appears* — what looks
like a heading, what looks like a list — and neither the markup nor the panel's
own text can answer them.

**Some screens arrive with `pageOutline`: the page under test, element by
element, each with its tag, its text and a `ref`.** It is there because the
panel's own words cannot answer the question — Deque is asking about the page,
and the page is what the outline is. Read it before you answer, and on an
`element_picker` answer from it.

**Every question arrives pre-answered, and the default is usually "Yes".** The
`checked: true` you see in `options` is a control's starting position, not an
answer anybody gave. Always send the answer you mean.

**`answers` wants every ref.** A `per_element` screen records only a complete
set, so that a finding is always one you asserted.

### When a tool answers `ok: false`

A refusal is the tool telling you what the screen showing actually wants, and it
hands you what you need to send:

- `detail` names the argument.
- `screen` holds the screen the panel is on, in the same shape step 3 reads —
  `send`, `question`, `help`, `options` or `groups`.

Answer that screen, per step 3. If a refusal arrives without a `screen`, call
`igt_current()` and answer what it returns.

A refusal leaves the guided test running and the ledger intact. The unit carries
on from the screen you are on.

## Step 4 — read what the guided test found

`igt_answer()` on the `results` screen is what writes the run into the saved
test. It returns the category, the issue count, and each issue in Deque's own
words. Those issues are what you report. Go to step 5.

## Step 5 — report the unit

Call `finish_unit(report: <the YAML block below>)`. That call is the last thing
you do, and the report is the only place you write prose.

One record per issue the guided test reported, in the order it reported them:

```yaml
test: <category>
name: <category>
status: complete
subjects: 1
records:
  - check: "<category-in-lower-case>.1"
    subject: page
    outcome: fail
    leaf: "<category-in-lower-case>.deque-reported"
    note: "<the issue's title, copied exactly>"
```

Three shapes of that block, and every unit ends as exactly one of them:

| What happened | `status` | `records` |
|---|---|---|
| the guided test reported issues | `complete` | one `fail` record per issue, as above |
| the guided test reported none | `complete` | one record: `check: "<category>.0"`, `outcome: pass`, `leaf: "<category>.no-issues"` |
| step 1's ledger check said otherwise | `aborted` | one record: `check: "<category>.0"`, `outcome: blocked`, `leaf: "<category>.ledger-lost"`, `note:` the verdict `check_ledger` returned |

`outcome` is `fail` for an issue Deque reported, `pass` when it reported none,
and `blocked` for the ledger. A guided test that ran and found nothing is a pass:
the whole page was examined and came back clean.

**The guided test files its own issues** into the saved test when it finishes.
`add_manual_issue` is not one of your tools, and this path has no use for one.

## The page-state warning

Some screens carry `pageStateChanged: true`, and the panel shows *The state of
your page has changed*.

It is a banner over a live question screen: `Back`, `Next` and the element
selector all still work, and the answer you send is recorded. Answer the screen
per step 3, and add one line to the note of the record you write in step 5:

```
note: "the page-state warning was showing from <questionId> onward"
```
