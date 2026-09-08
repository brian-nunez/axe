---
id: 019
title: Settle whether the 320px scroll branch is a seventh predicate
labels: [wayfinder:task]
state: closed
assignee: brian
blocked-by: []
---

## Question

`reference/page-state-tests.json` marks the whole of page state test 9 `requiresScreenshot: true`, and one of its branches does not deserve it.

*Is horizontal scrolling necessary to view content at a 320px viewport* is `scrollWidth > clientWidth` — a measurement against a bright-line threshold, the same species as `check_target_size`, not a judgement about a rendered picture. The other test 9 branches genuinely are visual: whether content or functionality is *lost* under doubled text, a 320px viewport, or injected text spacing needs eyes.

[Settle how image-requiring branches are developed](018-vision-on-the-dev-model.md) surfaced this. It is not a quiet edit to the reference file, because it adds a seventh computed predicate to the six [Settle the tool inventory and the MCP boundary](011-tool-inventory.md) named, and predicates are tools.

Two things to settle:

1. **Whether `requiresScreenshot` belongs on the branch rather than the test.** Test 9 would then carry it on three branches and not the fourth. Check the other tests for the same over-broad flag while you are there — test 5 already sets it per branch, so the file is inconsistent rather than wrong.
2. **Whether the scroll check becomes a tool.** If so it needs a name, a signature, and a return shape matching 011's `Result<Evidence>` envelope, and the viewport manipulation it requires has to respect whatever [Settle what page state changes an in-progress IGT survives](017-igt-page-state-tolerance.md) concludes — resizing to 320px is exactly the page state change that ticket is measuring.

Cheap either way. It matters because a branch wrongly marked visual burns vision tokens on every run and asks a 2B model for a judgement it does not need to make.

## Resolution

**Yes to both, and the over-broad flag was in two tests rather than one.**
Recorded as [011](011-tool-inventory.md) Amendment D, with the reference file
edited to match.

### 1. `requiresScreenshot` belongs on the branch

`reference/page-state-tests.json` now carries it on the branch only. The
test-level flag is gone from tests 6 and 9, and test 5 — which already set it per
branch — was the shape the other two should have had.

| Branch | Was | Now |
|---|---|---|
| 6.1 colour conveys information | test-level `true` | `true` |
| 6.2 instructions require perceiving shape, colour, size, location | test-level `true` | `true` |
| 6.3 instructions require perceiving **auditory** characteristics | test-level `true` | **`false`** |
| 9.1 content lost under doubled text | test-level `true` | `true` |
| 9.2 horizontal scrolling needed at 320px | test-level `true` | **`false`**, `computable: "partly"` |
| 9.3 content lost at 320px | test-level `true` | `true` |
| 9.4 content lost under injected text spacing | test-level `true` | `true` |

**Test 6's third branch is the one the ticket did not ask about and is the
clearest case of the two.** *Instructions require perceiving auditory
characteristics* — "when you hear the tone, press continue" — is answered by
reading the instruction, and a screenshot of the page answers nothing at all.
Test 6 was flagged visual as a whole because two of its three branches are.

So tests 6 and 9 both ship `visualSignoff: pending` under
[018](018-vision-on-the-dev-model.md) on account of one branch fewer than they
would have, and two branches per run stop asking a 2B model to look at a picture
to answer a question the picture does not contain.

`reference/README.md` now states that both flags are **ours**, not Deque's, and
therefore have to be re-applied after a re-capture — which was true before this
change and undocumented.

### 2. The scroll check becomes a predicate

```
check_reflow(width?: number = 320) → Verdict<ReflowMeasure>

ReflowMeasure = { width, scrollWidth, clientWidth, overflowBy,
                  overflowing: ElementRef[],
                  twoDimensionalCandidates: ElementRef[],
                  viewportRestored }
```

Leaf `horizontal-scroll`. The eighth predicate — the ticket guessed seventh, and
[020](020-page-interaction-tools.md) landed `check_sort_state` first.

**It returns `undecidable`, and that is the honest shape.** The branch has two
clauses and only one measures: *horizontal scrolling is needed* is
`scrollWidth > clientWidth`, and *the content does not require a two-dimensional
layout* is not computable at all. So:

- no overflow → `passes`, definitively;
- overflow whose subtree is entirely tables, images, SVG, `role=grid` or a
  deliberately `overflow-x` scrolling region → `undecidable`, with `because`
  naming what it found and `twoDimensionalCandidates` listing it;
- overflow anywhere else → `fails`.

That is `check_link_in_text_distinction`'s precedent exactly, and
[012](012-skill-file-format.md) already routes an `undecidable` to a judged
fallback step carrying its own `Evidence:` line. The branch is therefore
`computable: "partly"` in the reference file, for the same reason test 5's link
branch is — and note that even the judged half is a text question about *which
element overflows*, not a judgement about a rendered picture. The vision tokens
go either way.

### The viewport it needs

`check_reflow` owns the resize end to end: it sets the width, measures, restores
the viewport and reports `viewportRestored`, on its error path too. No
`set_viewport` primitive is bound in production, which is
[020](020-page-interaction-tools.md)'s rule and not a special case for this tool.

Against [017](017-igt-page-state-tolerance.md): a 320px resize was tolerated with
an IGT actually running, and it fires no guard because it is not a navigation.
The tool is bound to manual leaves only and the run is sequential, so no guided
test is in progress when it runs at all. **The restore is for measurement
correctness — 017 rule 2 — not for the ledger**, which does not care.

### What test 9's file will look like

One `Evidence: text` check and three `Evidence: image` ones — 9.2 through
`check_reflow`, the other three through
`capture_under("zoom-200" | "viewport-320" | "text-spacing")`. Written up in
012's Amendment D so the author of file 9 does not have to re-derive it.

Eleven computable branches across six tests now, collapsing to eight predicates.
