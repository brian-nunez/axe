---
id: 024
title: Settle what form fill and submit is actually for
labels: [wayfinder:grilling]
state: closed
assignee: brian
blocked-by: []
---

## Question

[CONTEXT.md](../../CONTEXT.md) *Scope* lists **form fill and submit** as in scope for v1. Brian named it explicitly when the map was charted: *"clicking forms, typing into forms, submitting forms are part of the test that we do need to cover, but not multiple pages."*

[Add page-interaction tools to the manual path](020-page-interaction-tools.md) went looking for the branch that needs it and could not find one. No page state test branch requires filling a form. `change_setting` comes closest, and it exists to answer *changing the setting of a component causes a change of context*, not to complete and submit a form. Nothing in the 33-tool inventory does it.

So one of three things is true, and the map cannot close until we know which:

1. **It is for reaching the page state under test.** A form must be filled and submitted to get to the state that gets audited — an error state, a confirmation, a logged-in view. That would make it fixture work, not tool work, and it collides with *page state discovery* which CONTEXT records as out of scope.
2. **It is for triggering conditions the tests then examine.** Submitting an invalid form produces the error messaging that test 6's `form-errors-color-only` branch and test 10's status messages are about. That would make it a tool, and it would need to say which branches depend on it.
3. **It was scoped in error**, or is genuinely covered by `change_setting` and `operate_element` between them, and the scope line should be corrected.

Reading (2) as the intent, the branches it would serve are mostly on the screen-reader side — test 10 is out of v1 — which is why 020 found nothing that needs it. That is worth checking rather than assuming.

Resolve with either a tool and the branches it serves, a fixture responsibility and its boundary against page state discovery, or a corrected scope line. Do not invent a `fill_form` tool that no branch calls.

## Resolution

**Reading (3), with the piece of (1) that is real named rather than dropped.**
No branch of the sixteen — and no branch of ours anywhere — requires a form to be
filled out and submitted before it can be evaluated. **No new tool.** The scope
line is corrected, and the one genuine form-shaped requirement underneath Brian's
sentence is recorded where it belongs: in the fixture, before the scan, and not
in v1.

Three separate things were riding on one phrase. Two of them are already built
and bound; the third is not agent work at all.

### The evidence: all sixteen tests, branch by branch

67 checks across the 16 tests, 59 of them in the 13 that are active in v1. Read
against one question — *can this branch be evaluated on the page state as the
fixture hands it over, or must a form first be filled in and submitted?*

| Test | Branches | Needs a fill+submit first? |
|---|---|---|
| 1 Automatic Behavior | 3 | **No.** All three are statements about time — `observe_page_activity`, and `operate_element(..., observeSeconds)` for the pause control. |
| 2 Page Meaning | 1 | No. Reading order under a screen reader. Held back. |
| 3 Page Structure | 4 | **No.** Heading order, skip link, nav grouping. The skip-link branch activates a link; `operate_element` already does. |
| 4 Interactive Elements | 18 | **No — and this is where the phrase came closest.** See below. |
| 5 Static Content | 6 | **No, and one branch is actively harmed by filling.** See below. |
| 6 Sensory Characteristics | 3 | **No.** See `form-errors-color-only` below — it is a filing option on 6.1, not a branch of its own. |
| 7 Forms | 1 | **No.** The whole test is `check_autocomplete_purpose` reading an attribute. See below. |
| 8 Focus Management | 1 | **No.** Activate a component, observe where focus lands — `operate_element(with: "keyboard")`. See below. |
| 9 Text Resize, Reflow, Spacing | 4 | **No.** Viewport, zoom, injected stylesheet. |
| 10 Status Messages | 2 | No. Screen reader, held back. See below. |
| 11 Alternatives for Timed Media | 7 | **No.** Transcripts, captions, audio description. |
| 12 Tables | 5 | **No.** `check_table_semantics`, `check_sort_state`. |
| 13 Time Limits | 5 | No. Screen reader, held back. |
| 14 Shortcuts | 2 | **No.** `probe_single_key_shortcuts` probes with focus on `document.body`, and with focus scoped into a component — never into a field it is typing values into. |
| 15 Motion and Gestures | 4 | **No.** Drag, path gesture, device motion. |
| 16 Target Size | 1 | **No.** Geometry over a candidate set from the saved test. |

**Zero of 59 in-scope branches.** Zero of 67 including the held-back three.

Now the five the ticket asked to check carefully, plus the two it did not name.

**6.1 `form-errors-color-only` — a filing option, not a branch.** The branch reads
*colour conveys information, indicates an action, prompts a response, or
distinguishes an element, with no equivalent non-colour visual cue*, and Deque
offers two identifiers for it: `information-color` and `form-errors-color-only`.
Per the reference file's own `structureNote`, a leaf listing several identifiers
means *Deque offers all of them for that branch and the auditor picks the one
that fits*. `issue-mapping.json` confirms it: `form-errors-color-only` is cited
by test 6 alone, under 1.4.1, and resolves to `Color alone is used to identify
error(s) (1.4.1.a, rgaa-3.1.4)`. So the branch fires when the page state on
screen shows colour-only error styling — and if the state the fixture handed over
does not show it, the branch does not fire for errors and still evaluates every
other colour-conveyed cue on the page. **Submitting an invalid form to make error
styling appear does not evaluate this branch. It manufactures a different page
state** — one whose uniqueness nobody determined, that the automated scan never
covered, and that every other unit in the run would then be measuring against a
saved test describing somewhere else. The error state is a page state of its own,
and it gets its own run.

**10 Status Messages — real, and out twice over.** A submit is indeed one way to
produce a status message. Test 10 is screen-reader and held back in v1, and even
in scope the branch asks whether the message *is announced* and whether it
*disappears while still applying* — properties of the state on screen, not of the
act that produced it. This is 020's finding restated: the branches that reading
(2) would serve sit on the screen-reader side, which is why 020 found nothing.

**7 Forms — the most static test of the sixteen.** Named *Forms*, and it reads an
attribute. The reference file calls it *fully deterministic; the highest-confidence
test of the sixteen*, and 011 names `check_autocomplete_purpose` as the first
predicate worth building. It requires the field to be **empty and untouched**, not
filled. The test's name is the likeliest source of the intuition that the agent
must fill forms; the test itself is the strongest evidence it does not.

**4 `change_setting` — and it must not submit.** The branch is *changing the
setting of a component causes a change of context without warning beforehand*.
That is WCAG 3.2.2 On Input, whose entire subject is the change happening
**without** an explicit submit action. A tool that filled the form and pressed
Submit would be testing the opposite of the branch: an expected change of context
following a deliberate submission is exactly the conforming case. 020 was right
to keep these apart, and it is not a near miss — it is the wrong direction.

**8 Focus Management — the one branch that legitimately submits, and already can.**
*Activating a component by keyboard transitions the page to a new state and focus
does not move somewhere that preserves the meaning and operability of the page.*
Where the component is a submit control, `operate_element(selector, with:
"keyboard")` activates it today: the tool derives the key from the role, records
`focusAfter`, `dialogOpened`, `navigated` and the before/after digest, detects a
navigation, restores it, and verifies the URL. **Whether the fields were filled
first does not change what the branch measures.** An empty submit that lands on
client-side validation is a state transition; a filled one that lands on a
confirmation is a state transition; the question in both cases is where focus
went. Filling the fields first would change *which* state you land in, which is
choosing a page state — the thing that is out of scope — and it would not make the
branch any more decidable.

**Two the ticket did not name, both already covered.**

- **4's `focus-submits-form`** — *moving focus submits a form* — is the branch
  that mentions submission most explicitly, and it is about a submit **the page
  performs on its own**. `probe_focus_effects` returns `formSubmitted` for exactly
  it. Detecting it needs no field values: the submit either fires on focus or it
  does not.
- **5's placeholder contrast branch** is where filling would do damage.
  `check_text_contrast(state: "placeholder")` measures placeholder text against
  its background, and placeholder text exists only while the field is empty. A
  tool that typed into the field would delete the evidence and return a pass.

### The decision

**The scope line is corrected. No `fill_form` tool.** Inventing one was the risk
this ticket was written to avoid, and 59 branches of evidence say there is nothing
to bind it to. `operate_element` and `change_setting` between them already cover
every branch that touches a form control, which is reading (3) as the ticket
phrased it — with one addition the ticket's third reading did not anticipate.

Brian's sentence names three things, and they land in three different places:

| What was named | Where it lives | Status |
|---|---|---|
| *clicking forms* — activating a control, by pointer or by key | `operate_element(selector, with)` — tests 8, 4 dual-role, 3, 1 | **Built.** 011 Amendment B |
| *typing into forms* — changing a control's setting | `change_setting(selector, to?)` — test 4's change-of-context branch | **Built.** 011 Amendment B |
| *submitting forms* — as a page behaviour the audit observes | `probe_focus_effects.formSubmitted` (4), `operate_element` (8), and the navigation contract that detects, restores and verifies a submit that leaves the document | **Built.** 011 Amendment B |
| *filling a form out to **reach** the state being audited* | the fixture, before the scan | **Not built, and not v1.** Below |

### The collision, and why it settles the fourth row

The ticket asks what reading (1) collides with. It collides with two things, and
the second is the decisive one.

1. **Page state discovery.** An agent that fills and submits its way to an error
   state has chosen a page state. CONTEXT puts discovery out of scope and says the
   agent runs against *a page state already determined to be unique* — determined
   by a human, before the container starts. A submit that lands on a different
   document is also a multi-page flow, which is out by name.
2. **The scan came first.** The fixture hands over a browser whose automated scan
   is *complete and the test saved*, and every unit of the run writes into that
   saved test. A fill-and-submit performed by the agent lands on a state the scan
   never covered, and the ledger would carry findings from two different page
   states under one test name. So even if reaching a state behind a form were
   wanted, **it cannot be agent work** — it has to happen before the scan, which
   puts it in the fixture by construction rather than by preference.

Deque says the same thing on their own IGT start screen, captured in
`build/panel-survey.json`: *"Before you hit Start, make sure you have put your
site into the state you wish to test it."* Reaching the state is a preamble, and
it is somebody else's job. This is also the shape
[001](001-confirm-axe-mcp-entitlement.md) recorded of Deque's own MCP server —
`before` steps for form filling, run ahead of the scan — which is the most likely
origin of the scope line and confirms the placement rather than contradicting it.

**v1's fixture reaches a page state by URL, and that is all.** Nothing in
`fixture/` fills a form today and nothing needs to: [004](004-login-at-fixture-start.md)
deliberately authenticates by direct grant rather than driving the Keycloak
login form, so the one form the system might have had to fill, it already avoids.

### What this changes

- **[011](011-tool-inventory.md) is unamended.** Thirty-three production tools
  stands. This ticket adds none and removes none.
- **[020](020-page-interaction-tools.md)'s open item is closed.** *"Nothing in the
  inventory fills or submits a form"* was correct, and correct to leave alone.
  Nothing needs to.
- **No skill file changes.** No branch's routing moves.
- **CONTEXT's *Scope* section gets the wording below**, and *Held back on purpose*
  gains one entry.

### The exact CONTEXT wording

Replace the first line of *Scope*:

> **In:** the IGTs, the 16 page state tests, form fill and submit.

with:

> **In:** the IGTs and the 16 page state tests. Operating form controls is part of that — activating them by pointer or key, changing a control's setting, and observing a submit the page performs on its own. Filling a form out and submitting it to *reach* a state is not.

Replace the third line:

> **Out:** page state discovery, multi-page flows. The agent runs against a page state already determined to be unique.

with:

> **Out:** page state discovery, multi-page flows. The agent runs against a page state already determined to be unique. A state that only a submission produces — a validation error, a confirmation — is a page state of its own and gets its own run, because the saved test every unit writes into is a scan of the state the fixture handed over.

Add to *Held back on purpose*:

> **Reaching a state behind a form.** The fixture takes a page state a URL reaches. A target whose state only a fill-and-submit produces needs a per-target preamble that runs before the scan and before the save — fixture work, not a tool. An agent that could navigate to its own page state would be auditing a state nobody determined was unique, against a scan of somewhere else.

### Residual, recorded rather than guessed

**The Forms IGT is un-prototyped.** Seven categories exist — Table, Keyboard,
Modal Dialog, Interactive Elements, Structure, Images, Forms — and
[008](008-drive-structure-igt.md) drove Structure only. If a Forms IGT question
turns out to ask about error messaging, the answer is unchanged and needs no
tool: the IGT path contributes no branches of ours, the agent answers what is on
screen, and what is on screen is the state the fixture handed over — which is what
Deque's own start screen instructs. Worth confirming when the Forms IGT is first
driven, not worth speculating about now.
