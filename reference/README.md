# reference

Source material the agent is written against, captured because it is not otherwise reachable from code.

## `page-state-tests.json`

Deque's 16 Page State Tests — the "Advanced Testing Coverage" / Remaining Testing checklist, which is the whole of the manual path. Structure, branch conditions, and the Deque issue identifier each leaf raises.

**Where it comes from.** `${AXE_SERVER_URL}/coverage-page-state`, linked from *Remaining Testing* in the extension. On a self-hosted instance that URL is served by our own axe DevTools Server, so this content ships with the deployment we run. The page is a login-gated SPA — fetching it unauthenticated returns an empty shell — which is why a snapshot lives here rather than a fetch.

**What is verbatim and what is not.** Branch conditions are paraphrased into a machine-readable shape. Issue identifiers are verbatim.

### These identifiers do not join to the catalog

An earlier version of this file claimed they were the join key. **They are not.** Measured against the 418-entry dump: **0 of 92 slugs** appear in any catalog option text. `structure-skiplink-broken` is Deque's vocabulary for the Remaining Testing guide; `4.1.2.a` is Deque's vocabulary for the manual issue picker. Two naming systems, no overlap.

What *is* shared is the WCAG success criterion — all 37 cited here exist in the catalog. But a criterion names a *family*: 64 of the catalog's 90 ids cover more than one entry, and `4.1.2.a` alone covers 31.

So resolving a branch to a fileable catalog entry is **hand work, not a lookup**: 92 slugs need mapping to exact catalog labels, and only the entry's full option text — label and parentheses together — is unique. That hand work is done, and lives in `issue-mapping.json` below. It is why a skill file branch carries the resolved option text rather than an identifier from this file.

**Fields worth knowing:**

| Field | Meaning |
|---|---|
| `screenReader` | true for tests 2, 10, 13 — out of scope for v1, auditors run them by hand |
| `computable` | the branch is decidable in a tool rather than judged by the model; the design rule that keeps a small local model viable |
| `requiresScreenshot` | the branch is inherently visual, so the tool returns an image rather than text |
| `pass` | test 4 only, which runs once across all interactive elements and once per focused element |
| `prerequisite` | test 16 only, which reads the saved test rather than the page |

**`computable` and `requiresScreenshot` are ours, not Deque's, and both sit on the branch.** Deque ships neither; they are annotations that map the checklist onto the tool set, so a re-capture wipes them and they have to be re-applied. Both were branch-level in places and test-level in others until [Settle whether the 320px scroll branch is a seventh predicate](../wayfinder/tickets/019-reflow-scroll-predicate.md) made them uniform — a test-level `requiresScreenshot` was marking branches visual that are not, which burns vision tokens on every run and asks a 2B model for a judgement it does not have to make.

**Staleness.** This is a snapshot of a document Deque maintains. It is the one place in this repo that copies their content, and it exists because the manual path has no API. When Deque revises the checklist this file is what goes out of date — re-capture it from the server rather than editing it by hand.

## `issue-mapping.json`

The join the two vocabularies do not make on their own: every one of the 92 Deque
issue slugs cited above, mapped by hand to the one manual issue catalog entry a
skill file branch should file.

**Keyed by slug, resolved per branch.** A row carries the slug, the success
criterion the checklist cites, the page state tests that cite it, the exact
catalog `optionText` — label *and* parentheses, which is the only unique key —
and a confidence.

The unit that has to resolve is the **branch**, not the slug: the checklist cites
92 slugs across 103 branches, and a row carries exactly one of three shapes.

| Shape | When | How a branch selects |
|---|---|---|
| `catalogOptionText` | the slug is cited once | nothing to select |
| `byCriterion` | nine slugs cited under two success criteria (`captions-missing` under 1.2.2 for recorded media, 1.2.4 for live) | the branch's own criterion |
| `byBranch` | two slugs cited twice under **one** criterion by branches that mean different things | the branch name |

`byBranch` covers `dual-role` — the mouse/keyboard parity branch and the
WAI-ARIA-Authoring-Practices conformance branch — and `semantic-data-table`,
where the header-markup branch fits its entry and the `role=table`/`role=grid`
row-and-cell-roles branch has no 1.3.1 entry at all and files the 4.1.2.b Grid
entry with a review note. Each branch cell carries the checklist condition it
serves in `when`, verbatim from `page-state-tests.json`; that string is what lets
the check assert the mapping's branches and the checklist's branches are the same
set. `semantic-data-table`'s branch names are `check_table_semantics`' leaf names,
so a skill file's routing table and the mapping speak one vocabulary.

`counts` rolls a slug up across its branches — a slug is low if any branch of it
is, which is why it still reads 84/8/0. `branchCounts` is the per-branch tally,
94 high and 9 low, and is the number the completeness assertion covers.

**Confidence is the point, not decoration.** `high` means the entry is an
unambiguous match under the criterion the checklist cites. `low` means a human
should look before filing — several entries in the family match equally, none
matches well, or the closest one sits under a different criterion — and every
low row says which in a `note`. A wrong mapping files a wrong issue on a real
audit; a flagged one costs a reviewer five seconds.

**Verify it, don't trust it.** `make check-mapping` re-derives every branch the
checklist cites from `page-state-tests.json` and requires each one to resolve to
exactly one mapping cell, matches every option text verbatim against
`build/manual-issue/catalog.json`, and refuses a high-confidence row whose entry
carries a criterion other than the one cited. Re-run it after any edit to this
file or to the checklist, and after re-dumping the catalog against a new
extension version.

**It also checks `skills/`.** A skill file names its catalog entry by full option
text, inline, and records the mapping row it came from in an HTML comment
(`slug @ criterion / confidence`, optionally `slug#branch @ …`). The check reads
both directions: every option-text-shaped string in a skill file must be a real
catalog entry that some mapping branch resolves to and that the mapping resolves
for that file's own page state test, and every audit trail must name a row that
exists at the confidence it claims. So a skill file cannot quietly file a valid
entry the mapping never sanctioned, and a citation cannot rot when a row moves.

## `deque-api.yaml`

OpenAPI 3.1 for every Deque HTTP endpoint the fixture calls — eight of them,
across getting a session and reading the saved test.

**Deque publishes none of this.** It was recovered by reading the shipped
extension bundle and watching what it calls, then confirmed against a live
instance. That is the reason the file exists: the knowledge is expensive to
re-derive and easy to lose, and nothing upstream will remind us of it.

Every operation carries a **why** as well as a what — which failure it catches,
or which thing the panel cannot do. Three traps are recorded there rather than
in anyone's memory:

- **`Accept: application/json` is not optional.** The SPA answers `200
  text/html` to any unrouted path, so a check without it reads success out of a
  web page.
- **`is_manual` does not mean "added by hand".** It covers both human paths;
  `manifest_guide` is what separates a manual issue from an IGT finding.
- **`completed` on an IGT run is not evidence of completion.** *Save progress &
  quit* sets it, so an abandoned guided test reads as finished with zero issues.
