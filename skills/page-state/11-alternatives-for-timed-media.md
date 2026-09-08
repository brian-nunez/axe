---
test: 11
name: Alternatives for Timed Media
path: manual
status: active
scope: per-subject
find: "audio, video, iframe[src*='youtube'], iframe[src*='vimeo']"
tools: [check_ledger, find_elements, describe_element, add_manual_issue, finish_unit]
visualSignoff: not-required
---

# Page state test 11 — Alternatives for Timed Media

Audit every piece of timed media on this page state.

Work the steps in order, and run every step you are sent to.

`{media}` below always means the `selector` string that step 2 returned for the
medium you are working on. Send that selector itself: for a medium whose
selector is `#hero-video`, `{media} track[kind=captions]` is
`#hero-video track[kind=captions]`.

Every check here is answered from **markup and visible text**. `describe_element`
returns the medium's `markup` and the `context` that follows it, and
`find_elements` measures anything a CSS selector can reach. That is your
evidence.

Two words are used precisely, and they mean the same thing on every check:

- **missing** — the alternative is not there at all.
- **inadequate** — it is there and it is wrong, incomplete, out of sync, does not
  name the speakers, or does not describe the important sounds.

## Step 1 — confirm the ledger

Call `check_ledger()`.

- `ok: true` and `alive: true` → go to step 2.
- anything else → go straight to step 11 and report the unit blocked, using the
  `verdict` the tool returned.

## Step 2 — find the subjects

Call `find_elements(query: "audio, video, iframe[src*='youtube'], iframe[src*='vimeo']")`.

- an empty list → this page state carries no timed media. Go to step 11 and
  report one `not-applicable` record, leaf `11.0.no-media`.

- one or more → work through them **one at a time**, in the order returned.
  For each, run step 3 and then only the checks step 3 sends you to. Finish one
  medium before starting the next one.

## Step 3 — gate: what kind of media is this?

Evidence: text.

Call `describe_element(selector: "{media}", need: "text")`. One call per medium:
the `markup` and `context` it returns are the evidence for every check below.

Answer one question — **which of these four is it?** — and go straight to the
steps its row names.

| It is | How you can tell | Run |
|---|---|---|
| **video with sound, recorded** | a `<video>` element or an embedded player, and none of the three rows below fits | steps 4, 5 and 6 |
| **audio only** | an `<audio>` element, or a player described as a recording, a podcast or a call | step 7 |
| **video with no sound** | a `<video>` marked `muted`, or described as silent, an animation or a screen recording without narration | steps 8 and 9 |
| **video with sound, live** | described as live, a livestream, or a broadcast happening now | step 10 |

Write the kind down; the report names it. Then go to the first step that row
names and run it.

If none of the four fits — an element that is not really media, a decorative
background clip with no content — record `check: "11.0"`,
`subject: "{media}"`, `outcome: not-applicable`,
`leaf: "11.0.not-timed-media"`, and go on to the next medium.

## Step 4 — CHECK 11.4 — captions for recorded video with sound

Evidence: text.

**First question — is a captions track there?** This one is measured rather than
judged. Call

`find_elements(query: "{media} track[kind=captions], {media} track[kind=subtitles]")`

and route on what comes back:

- **an empty list** → this medium has no captions track → call `add_manual_issue(selector: "{media}", issue: "Captions are not available for recorded multimedia (1.2.2.a, rgaa-4.3.1)")`

  Then record `outcome: fail`, `leaf: "11.4.captions-missing"`, `filed:` the `issue` value that call returned.

  <!-- from: issue-mapping.json / captions-missing @ 1.2.2 / high -->

**Second question, only when the list came back with a track in it: do the
captions carry all the dialogue, stay in sync, name every speaker and describe
the important sounds?** For an embedded player with no `<track>` of its own,
`context` is where it says whether it captions itself.

- **something about them is wrong** → call `add_manual_issue(selector: "{media}", issue: "Captions for recorded media are incorrect or inadequate (1.2.2.a, rgaa-4.4.1)")`

  Then record `outcome: fail`, `leaf: "11.4.captions-inadequate"`, `filed:` the `issue` value that call returned, and `note:` naming what is wrong with them.

  <!-- from: issue-mapping.json / captions-inadequate @ 1.2.2 / high -->

- **they are complete and correct** → leaf `11.4.pass`. Record `outcome: pass`.

Then go to step 5.

## Step 5 — CHECK 11.5 — audio description for recorded video with sound

Evidence: text.

**First question — is an audio description track there?** Measured, like step 4.
Call

`find_elements(query: "{media} track[kind=descriptions]")`

- **an empty list** → second question: does this video show information that the
  soundtrack never says — text on screen, a chart, a gesture, an action?

  - **yes** → call `add_manual_issue(selector: "{media}", issue: "Audio description is not available (1.2.5.a, rgaa-4.1.2, rgaa-4.1.3, rgaa-4.5.1, rgaa-4.5.2)")`

    Then record `outcome: fail`, `leaf: "11.5.audio-description-missing"`, `filed:` the `issue` value that call returned.

    <!-- from: issue-mapping.json / audio-description-missing @ 1.2.5 / high -->

  - **no, everything it shows is also said** → leaf `11.5.pass`. Record
    `outcome: pass`.

- **a track came back, and it leaves out something essential** → call `add_manual_issue(selector: "{media}", issue: "Audio description is incorrect or inadequate (1.2.5.a)")`

  Then record `outcome: fail`, `leaf: "11.5.audio-description-inadequate"`, `filed:` the `issue` value that call returned, and `note:` naming what it leaves out.

  <!-- from: issue-mapping.json / audio-description-inadequate @ 1.2.5 / high -->

- **a track came back and it covers everything** → leaf `11.5.pass`. Record
  `outcome: pass`.

Copy the issue text between the backticks exactly, including the parentheses.
The catalog carries *Audio description is incorrect or inadequate* twice, under
two different criteria, and only the parentheses tell them apart.

Then go to step 6.

## Step 6 — CHECK 11.6 — transcript for recorded video with sound

Evidence: text.

**First question — is a transcript there?** Measured, like steps 4 and 5. A
transcript is marked as one: the region that holds it, or the link that reaches
it, carries the word in its `id`, its `class` or its `href`. Call

`find_elements(query: "[id*='transcript' i], [class*='transcript' i], [href*='transcript' i]")`

and route on what comes back:

- **an empty list** → this page state carries no transcript → call `add_manual_issue(selector: "{media}", issue: "No text or audio description available for multimedia content (1.2.3.a, rgaa-4.1.3)")`

  Then record `outcome: fail`, `leaf: "11.6.transcript-missing"`, `filed:` the `issue` value that call returned.

  <!-- from: issue-mapping.json / nonvisual-description-missing @ 1.2.3 / high -->
  <!-- The selector is the whole existence half, per 012 Amendment F. It reaches
       a transcript that is marked as one and not a transcript whose only marker
       is its own link text, so it over-reports on a page that names one that
       way. That is the direction to be wrong in: a false negative on a real
       failure is the error 026 calls the worse one, and a reviewer rejects a
       flagged finding in five seconds. -->

**Second question, only when the list came back with something in it: is what it
found this medium's transcript, and does it describe both what is said and what
is shown?** `context` from step 3 is what says which medium it belongs to.

- **it covers only what is said** → call `add_manual_issue(selector: "{media}", issue: "Text description is incorrect or inadequate (1.2.3.a, rgaa-1.3.1)")`

  Then record `outcome: fail`, `leaf: "11.6.transcript-inadequate"`, `filed:` the `issue` value that call returned, and `note:` naming what it leaves out.

  <!-- from: issue-mapping.json / text-alternative-inadequate @ 1.2.3 / high -->

- **it covers both** → leaf `11.6.pass`. Record `outcome: pass`.

This medium is done. Take the next subject from step 2 and run step 3 on it.
When every subject has been worked, go to step 11.

## Step 7 — CHECK 11.1 — transcript for audio-only media

Evidence: text.

**First question — is a transcript there?** A transcript is the recording's words
written out on the page, or a link beside it whose text names a transcript. Read
`context`. A link that says only *click here*, *more*, or *details* names no
transcript.

- **`context` holds no transcript and no link naming one** → call `add_manual_issue(selector: "{media}", issue: "Transcript is not provided (1.2.1.a, rgaa-4.1.1)")`

  Then record `outcome: fail`, `leaf: "11.1.transcript-missing"`, `filed:` the `issue` value that call returned.

  <!-- from: issue-mapping.json / text-transcript-missing @ 1.2.1 / high -->
  <!-- Judged, where step 6's twin is measured. Converting this half wants the
       same selector, and it was left alone on purpose: written the same way as
       step 6 it reads as a continuation of it, and a run walked straight out of
       step 6 into this step and reported 11.1 on a video with sound. Convert it
       against a page state that actually carries audio-only media. -->

**Second question, only when one is there: does it carry all the dialogue, name
every speaker, and describe the important sounds?**

- **it is wrong or incomplete** → call `add_manual_issue(selector: "{media}", issue: "Transcript is incorrect or inadequate (1.2.1.a, rgaa-4.1.2)")`

  Then record `outcome: fail`, `leaf: "11.1.transcript-inadequate"`, `filed:` the `issue` value that call returned, and `note:` naming what is wrong with it.

  <!-- from: issue-mapping.json / text-transcript-inadequate @ 1.2.1 / high -->

- **it is complete** → leaf `11.1.pass`. Record `outcome: pass`.

This medium is done. Take the next subject from step 2 and run step 3 on it.
When every subject has been worked, go to step 11.

## Step 8 — CHECK 11.2 — the description a silent video does have

Evidence: text.

Only run this when there **is** a text or audio description. If there is none at
all, this check is `not-applicable` and step 9 is the one that fires.

Ask: does the description that is there actually convey what the video shows?

- **it is there and it does not** → call `add_manual_issue(selector: "{media}", issue: "Text/audio description is inadequate (1.2.1.b, rgaa-4.2.1, rgaa-4.2.2, rgaa-4.2.3)")`

  Then record `outcome: fail`, `leaf: "11.2.description-inadequate"`, `filed:` the `issue` value that call returned, and `note:` naming what it leaves out.

  <!-- from: issue-mapping.json / nonvisual-description-inadequate @ 1.2.1 / high -->

- **it is there and it does** → leaf `11.2.pass`. Record `outcome: pass`.
- **there is none** → leaf `11.2.not-applicable`. Record `outcome: not-applicable`.

Then go to step 9.

## Step 9 — CHECK 11.3 — no description at all for a silent video

Evidence: text.

Ask: does this silent video have **neither** an audio description track **nor** a
transcript?

- **yes, it has neither** → call `add_manual_issue(selector: "{media}", issue: "No text or audio description available for video-only content (1.2.1.b, rgaa-4.1.3)")`

  Then record `outcome: fail`, `leaf: "11.3.description-missing"`, `filed:` the `issue` value that call returned.

  <!-- from: issue-mapping.json / nonvisual-description-missing @ 1.2.1 / high -->

- **no, it has one of them** → leaf `11.3.pass`. Record `outcome: pass`.

This medium is done. Take the next subject from step 2 and run step 3 on it.
When every subject has been worked, go to step 11.

## Step 10 — CHECK 11.7 — captions for live video with sound

Evidence: text.

Judged, and it is the one captions question that is. A live stream carries its
captions in the stream rather than in a `<track>`, so no selector reaches them:
`markup` and `context` from step 3 are the whole evidence, and `context` is where
a player says whether it captions live.

**First question — are there live captions at all?**

- **there are none** → call `add_manual_issue(selector: "{media}", issue: "Captions are not available for live multimedia (1.2.4.a)")`

  Then record `outcome: fail`, `leaf: "11.7.captions-missing"`, `filed:` the `issue` value that call returned.

  <!-- from: issue-mapping.json / captions-missing @ 1.2.4 / high -->

**Second question, only when there are: do they carry all the dialogue, name
every speaker and describe the important sounds?**

- **something about them is wrong** → call `add_manual_issue(selector: "{media}", issue: "Captions for live media are incorrect or inadequate (1.2.4.a)")`

  Then record `outcome: fail`, `leaf: "11.7.captions-inadequate"`, `filed:` the `issue` value that call returned, and `note:` naming what is wrong with them.

  <!-- from: issue-mapping.json / captions-inadequate @ 1.2.4 / high -->

- **the live captions are complete and correct** → leaf `11.7.pass`. Record
  `outcome: pass`.

This medium is done. Take the next subject from step 2 and run step 3 on it.
When every subject has been worked, go to step 11.

## Step 11 — report the unit

Call `finish_unit(report: <the YAML block below>)`. The block travels as the
`report` argument of that call, which is the only way it reaches the run. That
call is the last thing you do, and the report is the only place you write prose.

```yaml
test: 11
name: Alternatives for Timed Media
status: complete
subjects: <how many step 2 returned>
records:
  - check: "<the check number>"
    subject: "<the selector step 2 returned>"
    outcome: <pass, fail or not-applicable>
    leaf: "<the leaf id of the branch you took>"
    filed: "<the issue value in that call's result>"
```

One record per check per subject, in the order you ran them, and a record only
for the checks step 3 sent you to and you have already run. A check that filed
carries `filed:`; a check that filed nothing has no `filed:` line at all.

Every `filed:` line is a value you have already read in an `add_manual_issue`
result.

Fields:

| Field | Always | Value |
|---|---|---|
| `check` | yes | the check number, quoted |
| `subject` | yes | the `{media}` selector, or `page` |
| `outcome` | yes | `pass`, `fail`, `not-applicable` or `blocked` |
| `leaf` | yes | the leaf id from the step you took |
| `filed` | only after `add_manual_issue` returned `ok: true` | the `issue` value in its result |
| `note` | only where a step asked for one | one line |

Write one record for each check step 3 sent you to. A check that did not apply to
this medium is silent; `not-applicable` is for the three places a step above asks
for it by name.

Two steps above end the unit early, and each is the same block with one record:

| What happened | `status` | `subjects` | The one record |
|---|---|---|---|
| step 2 found no timed media | `complete` | `0` | `check: "11.0"`, `subject: page`, `outcome: not-applicable`, `leaf: "11.0.no-media"` |
| step 1's ledger check said otherwise | `aborted` | `0` | `check: "11.0"`, `subject: page`, `outcome: blocked`, `leaf: "11.0.ledger-lost"`, `note:` the verdict `check_ledger` returned |

`status` is `complete` when every subject reached its last check, and `aborted`
only from step 1.
