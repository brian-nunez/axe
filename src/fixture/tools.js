/**
 * The tool layer: checklist-shaped tools over the panel driver.
 *
 * This is the v0 subset of the inventory — the session and graph group, the IGT
 * group, and manual read and write. The eight page-interaction tools and the
 * eight predicates serve the sixteen page state tests, which v0 does not run.
 *
 * Two rules hold across every tool here:
 *
 *   **No tool raises for a dead panel.** Every one returns a discriminated
 *   `Result`. A thrown error is a bug in this file, not a run-ending event, and
 *   the wrapper in `mcp-server.js` turns one into `ok: false` rather than an
 *   MCP transport error.
 *
 *   **Every action tool verifies its own effect.** The IGT element picker
 *   silently ignores a re-click of something it has just dropped, and the only
 *   evidence is a counter that fails to move. A tool that reports a success it
 *   did not achieve is the failure this whole design is built to avoid, so each
 *   one reads back and returns `rejected` instead.
 */

import { checkLedger, readLedger, readManifests, readPanel } from './ledger.js';
import {
  IGT_SCREENS,
  controls,
  has,
  menuItems,
  panelBody,
  press,
  pressAny,
  pressMenuItem,
  readScreen,
  settle,
} from './panel.js';

const ok = (value) => ({ ok: true, value });

/**
 * A refusal, and what `retryable` promises.
 *
 * `retryable: true` means **another call from this leaf can still succeed**, and
 * `detail` says which one. `retryable: false` means nothing the leaf can call
 * changes the answer, so the honest next move is to establish the ledger verdict
 * and report the unit blocked.
 *
 * **Retryable is the default, and terminal is the exception a call site has to
 * ask for**, because the two facts a refusal carries have to agree: a refusal
 * whose `detail` names the tool to call next and whose flag says *terminal*
 * contradicts itself, and [025](../wayfinder/tickets/025-build-v0.md) records a
 * run where the model believed the flag and abandoned a healthy guided test on
 * the second-to-last question. Defaulting the other way makes the safe answer
 * the one a forgotten argument produces.
 *
 * Per code, and the reasoning is the same each time — *is there a different call
 * that gets past this?*
 *
 * | Code | Retryable | Because |
 * |---|---|---|
 * | `wrong_screen` | always | the refusal names the tool the showing screen wants, and carries that screen |
 * | `not_found` | usually | a different selector, ref or category resolves — **except** a saved test that is gone, which is a ledger loss |
 * | `ambiguous` | always | a narrower argument resolves to one entry, and the candidates are listed |
 * | `rejected` | usually | the panel refused an argument or did not take an action, and state is unchanged — **except** a panel that cannot reach *Add Manual Issue*, which no bound tool can move |
 * | `panel_unavailable` | usually | the panel was mid-relayout or the server blinked, and one more read answers — **except** a panel orphaned from its extension, which is the unrecoverable one |
 *
 * There is no `page_lost` code. Navigation that costs the guided test surfaces
 * as the panel's own page-state banner, which
 * [017](../wayfinder/tickets/017-igt-page-state-tolerance.md) measured as a
 * banner over a live question screen rather than a lost run, and it reaches the
 * leaf as `Screen.pageStateChanged` rather than as a refusal.
 */
const err = (error, detail, retryable = true) => ({ ok: false, error, detail, retryable });

/** The refusal a leaf cannot act its way out of. */
const terminal = (error, detail) => err(error, detail, false);

/**
 * Which of Deque's questions want a picture rather than text, keyed on the
 * panel's own question id — the `name` on the answer radios, per
 * [008](../wayfinder/tickets/008-drive-structure-igt.md).
 *
 * **This is not a checklist of ours.** It says nothing about what a correct
 * finding is; it says which modality a question Deque already wrote can be
 * answered in. The line is drawn by Deque's own wording: a question that turns
 * on how something *appears* cannot be answered from the DOM, which is exactly
 * why it is a guided test rather than an axe-core rule — Deque reports the
 * finding as *"Content appears like a list but is not marked up as such."* A
 * question the panel's own text already answers gets text, because returning
 * both would burn vision tokens on every screen of every IGT.
 *
 * It lives here and not in a skill file because there is nowhere else it could
 * be consulted from: no IGT tool takes a `need` parameter, so an IGT leaf cannot
 * ask for evidence — the screen arrives carrying it. A skill file could only
 * express this as prose a small model has to obey, and one shared procedure
 * serves all seven categories, so it would carry every category's table into
 * every unit's context.
 *
 * The six ids are Structure's, the only category anybody has walked. The other
 * six categories' ids are unknown, fall back to text, and log — and mapping the
 * known text ones explicitly is what keeps that log a signal rather than a
 * constant a reader learns to ignore.
 */
const IGT_EVIDENCE_POLICY = new Map([
  // Appearance. The markup is by definition not the evidence: each of these
  // asks whether something *looks* like a heading or a list without being
  // marked up as one.
  ['mispurposed-headings', 'image'],
  ['missing-headings', 'image'],
  ['list-misuse', 'image'],
  ['missing-lists', 'image'],
  // Text. The tagged passage and the document title are the whole evidence, and
  // the panel already renders them.
  ['missing-langs', 'text'],
  ['validate-document-title', 'text'],
]);

/**
 * One tool answers every IGT screen, and this is `Screen.answerWith`.
 *
 * It was five — one per screen shape — and a screen that names its own answerer
 * ought to have been enough. It was not. A small model carries momentum: after
 * six `single_choice` screens in a row it calls `igt_answer_choice` again on the
 * grid that follows, and
 * [025](../wayfinder/tickets/025-build-v0.md)'s reopened runs show it doing the
 * same on the **results** screen — two refusals, no `igt_finish`, the guided
 * test abandoned and Deque recording nothing, while the unit's own draft
 * reported a finding. A refusal that names the right tool costs a turn and
 * usually recovers; on the results screen it is the last turn there is.
 *
 * With one tool the momentum has nowhere to go. The screen still says what to
 * send — `Screen.send` names the argument — and the results screen takes any
 * argument at all, because on that screen there is nothing to answer and only
 * one thing to do.
 */
const ANSWER_TOOL = 'igt_answer';

/**
 * How many page elements a screen's `pageOutline` carries.
 *
 * A budget, not a measurement: enough that a page state's own content is all
 * there, small enough that the two screens that carry it do not cost a small
 * model its window.
 */
const PAGE_OUTLINE_LIMIT = 60;

/** The argument each screen shape wants — this is `Screen.send`. */
const ANSWER_FIELD = {
  single_choice: 'choice',
  element_multiselect: 'refs',
  per_element: 'answers',
  element_picker: 'refs',
  results: 'nothing',
};

/**
 * What to do next, given what the panel is actually showing.
 *
 * Each IGT screen is answered by the one tool, so those rows are derived from
 * `ANSWER_FIELD` and cannot drift from `answerWith` and `send`. The views that
 * are not an IGT screen are not answered at all, so they get the honest
 * instruction rather than a guess.
 */
const NEXT_ACTION = {
  ...Object.fromEntries(
    Object.entries(ANSWER_FIELD).map(([kind, field]) => [
      kind,
      field === 'nothing'
        ? `Deque has asked its last question. Call ${ANSWER_TOOL}() with no argument to finish the test.`
        : `Call ${ANSWER_TOOL} and send ${field}.`,
    ]),
  ),
  overview: 'No guided test is running. Call igt_start(category) to begin one.',
  overview_igt: 'No guided test is running. Call igt_start(category) to begin one.',
  igt_entry: 'The category is open but not started. Call igt_start(category).',
  save_dialog: `A dialog is asking for a test name. Call ${ANSWER_TOOL}() to complete it.`,
};

const UNRECOGNISED_SCREEN =
  `Call igt_current() to re-read the screen, then call ${ANSWER_TOOL} with what its send names.`;

/**
 * The screen as the model reads it, from the panel's raw read.
 *
 * Shared by the success path and the refusal path, so a refusal hands back the
 * same object the answering tool would have — same fields, same `answerWith`,
 * same question text.
 *
 * **`panelStep` rather than `step`.** It is Deque's stepper label, reported for
 * the transcript, and nothing routes on it: one number spans several screens and
 * inapplicable numbers never render. Under the bare name it collided with the
 * numbered steps of `skills/igt/procedure.md`, and
 * [025](../wayfinder/tickets/025-build-v0.md)'s failing runs both quit the
 * guided test on the screen labelled `step: "4"` — the number of the procedure's
 * own recovery step, two screens before the results. The prefix says whose
 * numbering it is.
 */
function shapeScreen(raw) {
  const screen = {
    kind: raw.kind,
    panelStep: raw.step,
    questionId: raw.questionId ?? null,
    question: raw.question,
    help: raw.help,
    answerWith: ANSWER_FIELD[raw.kind] ? ANSWER_TOOL : null,
    send: ANSWER_FIELD[raw.kind] ?? null,
    pageStateChanged: Boolean(raw.pageStateChanged),
  };
  if (raw.kind === 'single_choice' || raw.kind === 'element_multiselect') {
    screen.options = raw.options;
  }
  if (raw.kind === 'per_element') screen.groups = raw.groups;
  if (raw.kind === 'element_picker') screen.alreadySelected = raw.alreadySelected;
  if (raw.kind === 'results') screen.issueCount = raw.issueLines.length;
  return screen;
}

/**
 * The only constructor for a `wrong_screen` refusal, so the next action is not
 * optional.
 *
 * "This tool does not apply to the screen showing" is true and useless on its
 * own: a small model reading it has no route back, and the unit dies there.
 * [025](../wayfinder/tickets/025-build-v0.md) reports that a refusal naming the
 * tool to call instead is what rescued both IGT runs that completed. Building
 * the envelope here rather than at each call site is what makes that a contract
 * instead of a habit — there is no way to return `wrong_screen` without a next
 * action, because there is no other way to return `wrong_screen`.
 *
 * **The refusal carries the screen, so it is also the recovery.** Naming
 * `igt_answer_choice` still left the model a turn short: it had the tool and not
 * the question, and 025's failing runs spent that turn on an abandoned unit
 * rather than on `igt_current()`. Shipping the screen inside the refusal makes
 * the wrong call cost one turn and no information — the model reads
 * `screen.answerWith`, reads `screen.question`, and answers.
 *
 * `extra` carries the one thing the screen kind cannot say: why this particular
 * tool was the wrong call, as against what to do now.
 */
const wrongScreen = (tool, wanted, raw, extra = '') => {
  const showing = IGT_SCREENS.has(raw.kind) ? shapeScreen(raw) : null;
  return {
    ...err(
      'wrong_screen',
      // The instruction leads, because the first clause is the one a small model
      // acts on and everything after it is justification.
      `${NEXT_ACTION[raw.kind] ?? UNRECOGNISED_SCREEN}` +
        (showing ? ' The screen is in `screen` below; read it and answer it.' : '') +
        ` The panel is showing ${raw.kind}, and ${tool} answers ${wanted}.` +
        (extra ? ` ${extra}` : ''),
    ),
    screen: showing,
  };
};

/**
 * The shared guard.
 *
 * A panel that is not laid out is not necessarily lost — DevTools takes the tab
 * back on its own while it finishes starting up — so one re-selection is spent
 * here before anything is called a failure. That is the same single bounded
 * attempt the loss policy allows, which is why the graph gives `panel-hidden`
 * no retry of its own.
 */
async function ensurePanel(fixture) {
  let body = await panelBody(fixture.frame);
  if (!body.unreadable && body.box.w > 0 && body.box.h > 0) return null;
  await fixture.reselect().catch(() => {});
  body = await panelBody(fixture.frame);
  if (!body.unreadable && body.box.w > 0 && body.box.h > 0) return null;
  return err('panel_unavailable', body.unreadable ?? `panel body is ${JSON.stringify(body.box)}`, true);
}

/** The in-page element reader. One definition, used by every page-side tool. */
const PAGE_ELEMENTS = ([query, limit]) => {
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 10) {
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const twins = node.parentElement
        ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName)
        : [];
      parts.unshift(twins.length > 1 ? `${tag}:nth-of-type(${twins.indexOf(node) + 1})` : tag);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const accessibleName = (el) => {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const text = labelled
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
      if (text) return text;
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    if (el.tagName === 'IMG') return (el.getAttribute('alt') ?? '').trim();
    return (el.textContent ?? '').trim().slice(0, 200);
  };
  let found;
  try {
    found = [...document.querySelectorAll(query)];
  } catch (error) {
    return { invalid: error.message };
  }
  return {
    elements: found.slice(0, limit).map((el) => {
      const box = el.getBoundingClientRect();
      return {
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        name: accessibleName(el),
        text: (el.textContent ?? '').trim().slice(0, 400),
        box: {
          x: Math.round(box.x),
          y: Math.round(box.y),
          w: Math.round(box.width),
          h: Math.round(box.height),
        },
      };
    }),
    total: found.length,
  };
};

/**
 * The page as a picker screen's options.
 *
 * An element_picker asks the auditor to *click something on the page*, and the
 * panel offers nothing to click in the panel: its own text is the question, the
 * counter and the read-back. A human answers it by looking at the page. The
 * screen therefore arrives carrying the page, in the same shape a multi-select
 * carries the candidates the panel found — one option per element, each with the
 * ref an answer names.
 *
 * This is a read, not a rule. It says nothing about which element answers the
 * question; it is the same page read `find_elements` performs on the manual
 * path, delivered by the screen because an IGT leaf has no tool to ask with.
 *
 * An element earns a row by rendering text of its own, or by being one of the
 * wrappers Deque's own picker asks for — *"click on the wrapping list
 * elements"*. Text is the element's own, not its subtree's, so a section does
 * not repeat every paragraph inside it.
 */
const PAGE_OUTLINE = ([limit]) => {
  const WRAPPERS = new Set([
    'UL', 'OL', 'DL', 'TABLE', 'FIGURE', 'VIDEO', 'AUDIO', 'IMG', 'IFRAME', 'SVG',
  ]);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 10) {
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const twins = node.parentElement
        ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName)
        : [];
      parts.unshift(twins.length > 1 ? `${tag}:nth-of-type(${twins.indexOf(node) + 1})` : tag);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const options = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (SKIP.has(el.tagName) || el.tagName.startsWith('AXE-')) continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const own = [...el.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const wrapper = WRAPPERS.has(el.tagName);
    if (!own && !wrapper) continue;
    options.push({
      ref: `o${options.length + 1}`,
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: (own || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    });
    if (options.length >= limit) break;
  }
  return options;
};

/** Short handles, so a small model passes a token rather than re-typing a selector. */
function register(fixture, element) {
  fixture.refCounter += 1;
  const ref = `e${fixture.refCounter}`;
  const withRef = { ref, ...element };
  fixture.refs.set(ref, withRef);
  return withRef;
}

/** A ref or a selector, both accepted; a ref resolves to the selector it stands for. */
const resolveSelector = (fixture, value) => fixture.refs.get(value)?.selector ?? value;

// ---------------------------------------------------------------------------
// Session and graph group
// ---------------------------------------------------------------------------

async function checkLedgerTool(fixture) {
  const verdict = await checkLedger({
    frame: fixture.frame,
    reselect: () => fixture.reselect(),
    serverUrl: fixture.serverUrl,
    accessToken: fixture.accessToken,
    baseline: fixture.baseline,
  });
  const ledger = verdict.ledger ?? null;
  const igt =
    ledger && ledger.exists
      ? await readManifests({
          serverUrl: fixture.serverUrl,
          accessToken: fixture.accessToken,
          testId: fixture.testId,
          guideCounts: ledger.guideCounts ?? {},
        }).catch(() => [])
      : [];

  return ok({
    alive: verdict.verdict === 'intact',
    verdict: verdict.verdict,
    action: verdict.action,
    testName: ledger?.name ?? fixture.testName,
    testUrl: ledger?.url ?? fixture.url,
    totals: ledger?.issues ?? null,
    igt,
    panelView: verdict.panel?.view ?? null,
    checks: verdict.checks,
    ledger,
  });
}

/**
 * The saved test's issues, gated on the panel.
 *
 * The read itself is server-side, because the panel renders a title and a count
 * per issue and hides the selector behind a per-issue expand — nineteen expands
 * is a lot of clicking on a view a sub-agent may be part-way through, and the
 * extension stores the selector anyway. What makes this a panel tool, and what
 * [013](../wayfinder/tickets/013-agent-graph.md) relies on when it refuses to
 * source a partial draft from here, is the gate: a dead or detached panel gets
 * `panel_unavailable`, never a list of issues.
 */
async function readTestResults(fixture, { match = null } = {}) {
  const guard = await ensurePanel(fixture);
  if (guard) return guard;

  const panel = await readPanel(fixture.frame);
  if (panel.unreadable) return err('panel_unavailable', panel.unreadable, true);
  if (!panel.runtimeId) {
    return terminal(
      'panel_unavailable',
      'the panel has outlived its extension and cannot be trusted',
    );
  }

  const ledger = await readLedger({
    serverUrl: fixture.serverUrl,
    accessToken: fixture.accessToken,
    testId: fixture.testId,
  }).catch((error) => ({ error: error.message }));
  if (ledger.error) return err('panel_unavailable', ledger.error, true);
  if (!ledger.exists) return terminal('not_found', `test ${fixture.testId} is gone`);

  const raw = await fetchIssues(fixture);
  if (!raw) return err('panel_unavailable', 'the issues endpoint did not answer with JSON', true);

  // The server records one issue per element rather than one issue with many
  // elements, so identical findings are folded back together here — which is
  // the shape the Overview renders and the shape test 16's prerequisite reads.
  const folded = new Map();
  for (const issue of raw) {
    const title = issue.help ?? issue.description ?? issue.summary ?? '(untitled)';
    const source = issue.manifest_guide ? 'guided' : issue.is_manual ? 'manual' : 'automatic';
    const key = `${source}::${title}`;
    if (!folded.has(key)) {
      folded.set(key, { title, count: 0, source, impact: issue.impact ?? null, elements: [] });
    }
    const entry = folded.get(key);
    entry.count += 1;
    entry.elements.push({
      selector: Array.isArray(issue.selector) ? issue.selector.join(' | ') : (issue.selector ?? null),
      snippet: issue.summary ?? issue.description ?? null,
    });
  }

  const issues = [...folded.values()];
  const needle = match?.toLowerCase();
  return ok(
    needle
      ? issues.filter(
          (issue) =>
            issue.title.toLowerCase().includes(needle) ||
            issue.elements.some((e) => (e.snippet ?? '').toLowerCase().includes(needle)),
        )
      : issues,
  );
}

/**
 * Put the panel back on a view that renders the ledger.
 *
 * Cheap exits first — a modal, the manual issue form — then the one path 010
 * proved end to end: `view saved tests` and the run's own entry. A panel still
 * inside a guided test is left alone and reported: quitting a test is
 * `save_progress_and_quit`, which is a parent-tier decision and not this one's.
 */
async function returnToOverview(fixture) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const screen = await readScreen(fixture.frame);
    if (screen.kind === 'overview') return screen.kind;
    if (screen.kind === 'overview_igt') {
      // Both views satisfy the ledger gate, but only the issue overview carries
      // `Add Manual Issue`, and a run that finishes an IGT is left on the Guided
      // Tests tab. Landing on the overview costs one tab press and is what the
      // next unit needs.
      const moved = await pressAny(fixture.frame, 'Overview', { settleMs: 3_000 }).catch(() => null);
      if (!moved) return screen.kind;
      const now = await readScreen(fixture.frame);
      return now.kind === 'overview' ? now.kind : screen.kind;
    }
    if (IGT_SCREENS.has(screen.kind)) return screen.kind;

    if (screen.kind === 'save_dialog') {
      await press(fixture.frame, 'Cancel', { within: '[role=dialog]', settleMs: 3_000 }).catch(
        () => {},
      );
      continue;
    }
    if (screen.buttons?.includes('Cancel') && screen.buttons?.includes('Save')) {
      await press(fixture.frame, 'Cancel', { siblingOf: 'Save', settleMs: 4_000 }).catch(() => {});
      continue;
    }
    const reopened = await reopenSavedTest(fixture);
    if (!reopened.ok) break;
  }
  const screen = await readScreen(fixture.frame);
  return screen.kind;
}

async function restorePage(fixture) {
  await fixture.page.setViewportSize(fixture.fixtureViewport).catch(() => {});
  // Reload, never navigate: pointing the tab at a different URL replaces the
  // panel with a page-state warning that offers only quit or restart.
  await fixture.page.goto(fixture.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await settle(2_000);

  await fixture.reselect().catch(() => {});
  const panelView = await returnToOverview(fixture);

  const verdict = await checkLedger({
    frame: fixture.frame,
    reselect: () => fixture.reselect(),
    serverUrl: fixture.serverUrl,
    accessToken: fixture.accessToken,
    baseline: fixture.baseline,
  });

  // A panel this could not return still yields ok: the ledger gate is the one
  // authority on whether a view is a loss, and a tool deciding that for itself
  // is a second opinion in a design with room for one.
  return ok({
    reloaded: fixture.page.url(),
    viewport: fixture.page.viewportSize(),
    panelView,
    ledgerAlive: verdict.verdict === 'intact',
    ledgerVerdict: verdict.verdict,
  });
}

/**
 * Reopen the run's own saved test.
 *
 * It takes no argument on purpose. The test id is the one the fixture resolved
 * once at setup; letting a caller name a test is precisely the state
 * `panel-detached` exists to detect.
 */
async function reopenSavedTest(fixture) {
  const guard = await ensurePanel(fixture);
  if (guard) return guard;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const panel = await readPanel(fixture.frame);
    if (panel.testName === fixture.testName) {
      return ok({ testId: fixture.testId, testName: fixture.testName, panelView: panel.view });
    }
    await press(fixture.frame, 'view saved tests', { settleMs: 5_000 }).catch(() => {});
    // The saved-tests list offers each test as an `<a>`, not a button.
    const clicked = await pressAny(fixture.frame, fixture.testName, { settleMs: 8_000 }).catch(
      () => null,
    );
    if (!clicked && attempt === 2) {
      return err('not_found', `no saved test named ${JSON.stringify(fixture.testName)} in the list`);
    }
    await fixture.reselect().catch(() => {});
  }

  const panel = await readPanel(fixture.frame);
  return panel.testName === fixture.testName
    ? ok({ testId: fixture.testId, testName: fixture.testName, panelView: panel.view })
    : err('not_found', `panel still shows ${JSON.stringify(panel.testName)}`);
}

/**
 * Quit a guided test that is still running, through the Options menu.
 *
 * Through the menu and not as a button: the control is absent from every
 * question, picker and grid screen, and appears top-level only on the
 * page-state warning banner.
 */
async function saveProgressAndQuit(fixture) {
  const guard = await ensurePanel(fixture);
  if (guard) return guard;

  const screen = await readScreen(fixture.frame);
  const running = IGT_SCREENS.has(screen.kind) || screen.pageStateChanged;
  if (!running) {
    return wrongScreen('save_progress_and_quit', 'a guided test that is still running', screen);
  }

  if (screen.buttons?.includes('Save progress & quit')) {
    await press(fixture.frame, 'Save progress & quit', { settleMs: 8_000 });
  } else {
    await pressAny(fixture.frame, 'Options', { settleMs: 2_000 }).catch(() => {});
    const items = await menuItems(fixture.frame);
    const took = await pressMenuItem(fixture.frame, /save progress|quit|exit|abandon/i);
    if (!took) {
      return err('rejected', `the Options menu offered ${JSON.stringify(items)}`);
    }
  }

  const panelView = await returnToOverview(fixture);
  const category = fixture.currentIgtCategory ?? null;
  fixture.currentIgtCategory = null;
  return ok({ quit: !IGT_SCREENS.has(panelView), category, panelView });
}

async function pageStateWarning(fixture) {
  const guard = await ensurePanel(fixture);
  if (guard) return guard;
  const panel = await readPanel(fixture.frame);
  if (panel.unreadable) return err('panel_unavailable', panel.unreadable, true);
  return ok({
    changed: Boolean(panel.pageStateChanged),
    view: panel.view,
    message: panel.pageStateChanged
      ? 'The state of your page has changed. Please put it in the state you started testing.'
      : null,
  });
}

// ---------------------------------------------------------------------------
// IGT path
// ---------------------------------------------------------------------------

/** Everything the model is given about the screen it is on. */
async function toScreen(fixture, raw) {
  if (raw.kind === 'unreadable') return err('panel_unavailable', raw.error, true);

  const questionId = raw.questionId ?? null;
  const need = IGT_EVIDENCE_POLICY.get(questionId) ?? 'text';
  if (questionId && !IGT_EVIDENCE_POLICY.has(questionId)) {
    fixture.log(`unmapped question id ${JSON.stringify(questionId)}; evidence defaults to text`);
  }

  const evidence = [];
  const images = [];
  if (need === 'image') {
    // Full page, not the viewport. Every mapped question asks about the page —
    // "is there content that appears like a list" — and a viewport capture
    // silently answers it about the top 720px instead, which is the class of
    // quiet wrong answer every other tool here reads back to avoid.
    const shot = await fixture.page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
    if (shot) {
      // The bytes ride beside the envelope, as MCP image content, exactly as
      // `describe_element` sends them. Base64 inside the JSON would reach the
      // model as text it cannot see, and it would defeat the leaf's
      // strip-stale-images pass, which is what keeps a small model's window
      // survivable across a ten-screen IGT.
      images.push({ data: shot.toString('base64'), mimeType: 'image/png' });
      evidence.push({
        kind: 'image',
        element: null,
        image: { mimeType: 'image/png' },
        caption: `the inspected page while answering ${questionId}`,
      });
    }
  } else if (raw.kind === 'element_multiselect' || raw.kind === 'per_element') {
    // Only the element-bearing screens carry evidence. A single_choice screen's
    // "elements" are its own two answer labels, which are already in `options`;
    // repeating them is tokens a small model has to read twice.
    for (const item of raw.options ?? raw.groups ?? []) {
      evidence.push({
        kind: 'text',
        element: { ref: item.ref, selector: null, tag: null, role: null, name: item.label, text: item.label, box: null },
        context: null,
      });
    }
  }

  const screen = { ...shapeScreen(raw), evidence };
  if (raw.kind === 'results') {
    screen.issues = raw.issueLines.map((title) => ({ title, elements: [] }));
    screen.summary = raw.summary;
  }
  // Two screens cannot be answered from the panel alone, and both are answered
  // from the page.
  //
  // An `element_picker` asks the auditor to click something on the inspected
  // page, and the panel offers nothing to click: its text is the question, a
  // counter and a read-back. Without the page in front of it a leaf can only
  // guess a CSS selector for an element whose class name it has never seen.
  //
  // A `single_choice` under the `text` evidence policy is a question about page
  // content that a picture cannot answer. Structure's `missing-langs` — *are
  // there sections of content which differ from the page-wide language?* —
  // arrived with `evidence: []`, and the leaf answered "no" to a page carrying
  // an untagged French paragraph, in every run. The panel's own words on that
  // screen say only that everything it *could* detect is highlighted, which on
  // that page is nothing at all.
  //
  // It is a read, not a rule: the same page read `find_elements` performs on the
  // manual path, delivered by the screen because an IGT leaf has no tool to ask
  // with (027). It says nothing about which element answers the question.
  if (raw.kind === 'element_picker' || (raw.kind === 'single_choice' && need === 'text')) {
    const outline = await fixture.page.evaluate(PAGE_OUTLINE, [PAGE_OUTLINE_LIMIT]).catch(() => []);
    // Kept for the life of the screen, so the refs an answer names are the refs
    // the screen offered. The page does not change under a running guided test,
    // and re-reading it per call would renumber every row between the two.
    if (raw.kind === 'element_picker') {
      fixture.pickerOptions = new Map(outline.map((row) => [row.ref, row.selector]));
    }
    screen.pageOutline = outline;
  }
  return images.length ? { ...ok(screen), images } : ok(screen);
}

/** Two screens are the same screen when everything a caller routes on matches. */
const signature = (raw) =>
  JSON.stringify([
    raw.kind,
    raw.questionId ?? null,
    raw.question ?? null,
    raw.step ?? null,
    (raw.options ?? raw.groups ?? []).map((o) => o.ref ?? o.value),
  ]);

/** Press Next and confirm the panel actually moved. */
async function advance(fixture, before) {
  await press(fixture.frame, 'Next', { settleMs: 5_000 });
  let after = await readScreen(fixture.frame);
  if (signature(after) === signature(before)) {
    await settle(4_000);
    after = await readScreen(fixture.frame);
  }
  if (signature(after) === signature(before)) {
    return { moved: false, raw: after };
  }
  return { moved: true, raw: after };
}

async function igtList(fixture) {
  const guard = await ensurePanel(fixture);
  if (guard) return guard;

  if (!(await has(fixture.frame, 'Guided Tests'))) await returnToOverview(fixture);
  await pressAny(fixture.frame, 'Guided Tests', { settleMs: 4_000 }).catch(() => {});

  const named = await controls(fixture.frame);
  const categories = named
    .map((control) => control.name.match(/^Start (.+) Run$/)?.[1])
    .filter(Boolean);

  const detail = await fixture.frame.evaluate((names) => {
    const text = document.body.innerText;
    return names.map((category) => {
      const at = text.indexOf(category);
      const block = at < 0 ? '' : text.slice(at, at + 400);
      return {
        category,
        runs: Number(block.match(/Runs:?\s*(\d+)/i)?.[1] ?? 0),
        issues: Number(block.match(/(?:Total )?issues:?\s*(\d+)/i)?.[1] ?? 0),
        completed: /Completed/i.test(block),
      };
    });
  }, categories);

  return ok(detail);
}

async function igtStart(fixture, { category }) {
  const guard = await ensurePanel(fixture);
  if (guard) return guard;

  // Entering a test that is already running is the mistake a small model makes
  // most, and the honest refusal is "wrong screen", not "no such control": the
  // entry button is genuinely absent, but that is a symptom. Naming the tool to
  // call instead is what turns a dead unit into a recovered one.
  const showing = await readScreen(fixture.frame);
  if (IGT_SCREENS.has(showing.kind)) {
    return wrongScreen(
      'igt_start',
      'a view with no guided test running',
      showing,
      'A guided test is already running. Do not start it again.',
    );
  }

  // "Structure" as a plain button exists only on the fresh home view. Inside a
  // saved test the card's start control is named "Start Structure Run".
  if (!(await has(fixture.frame, category)) && !(await has(fixture.frame, `Start ${category} Run`))) {
    await pressAny(fixture.frame, 'Guided Tests', { settleMs: 4_000 }).catch(() => {});
  }
  const entry = (await has(fixture.frame, category)) ? category : `Start ${category} Run`;
  const entered = await pressAny(fixture.frame, entry, { settleMs: 5_000 }).catch(() => null);
  if (!entered) {
    return err(
      'not_found',
      `no control named ${JSON.stringify(category)} or ${JSON.stringify(entry)}; the view offers ` +
        JSON.stringify((await controls(fixture.frame)).map((c) => c.name)),
    );
  }

  // Automated IGT arrives ticked, spends AI credits, and is outside the
  // contract. It disappears once the test begins, so there is no second chance
  // and no reason to let a caller opt in.
  const aiAssist = fixture.frame.locator('#enableAiAssist');
  if ((await aiAssist.count()) && (await aiAssist.isChecked().catch(() => false))) {
    await aiAssist.uncheck().catch(() => {});
  }

  await press(fixture.frame, 'Start', { settleMs: 9_000 });
  fixture.currentIgtCategory = category;
  return toScreen(fixture, await readScreen(fixture.frame));
}

const igtCurrent = async (fixture) => {
  const guard = await ensurePanel(fixture);
  if (guard) return guard;
  return toScreen(fixture, await readScreen(fixture.frame));
};

async function igtAnswerChoice(fixture, { choice }) {
  const guard = await ensurePanel(fixture);
  if (guard) return guard;

  const before = await readScreen(fixture.frame);
  if (before.kind !== 'single_choice') {
    return wrongScreen(ANSWER_TOOL, 'a single_choice screen', before);
  }
  if (choice !== 'yes' && choice !== 'no') {
    return err('rejected', `choice must be "yes" or "no", not ${JSON.stringify(choice)}`);
  }

  // Every question arrives pre-answered and the default is usually "Yes", so
  // the answer is always set explicitly rather than left alone.
  await fixture.frame.locator(choice === 'yes' ? '#yes-igt-radio' : '#no-igt-radio').click();
  await settle(2_000);
  const set = await fixture.frame
    .locator(choice === 'yes' ? '#yes-igt-radio' : '#no-igt-radio')
    .isChecked()
    .catch(() => false);
  if (!set) return err('rejected', `the panel did not take ${choice} for ${before.questionId}`);

  const { moved, raw } = await advance(fixture, before);
  if (!moved) return err('rejected', `Next did not leave ${before.questionId}`);
  return toScreen(fixture, raw);
}

async function igtAnswerElements(fixture, { refs }) {
  const guard = await ensurePanel(fixture);
  if (guard) return guard;

  const before = await readScreen(fixture.frame);
  if (before.kind !== 'element_multiselect') {
    return wrongScreen(ANSWER_TOOL, 'an element_multiselect screen', before);
  }
  const offered = new Set(before.options.map((o) => o.ref));
  const unknown = refs.filter((ref) => !offered.has(ref));
  if (unknown.length) {
    return err('not_found', `no option ${unknown.join(', ')}; the screen offers ${[...offered].join(', ')}`);
  }

  for (const ref of refs) {
    await fixture.frame.evaluate((id) => document.getElementById(id)?.click(), ref);
    await settle(800);
  }

  const after = await readScreen(fixture.frame);
  const checked = new Set(after.options.filter((o) => o.checked).map((o) => o.ref));
  const missed = refs.filter((ref) => !checked.has(ref));
  if (missed.length) return err('rejected', `the panel did not take ${missed.join(', ')}`);

  const { moved, raw } = await advance(fixture, after);
  if (!moved) return err('rejected', 'Next did not leave the multi-select screen');
  return toScreen(fixture, raw);
}

/**
 * Normalise `answers` to a plain ref → yes/no map.
 *
 * The wire shape is a **list of `{ ref, answer }`**, which is the shape a small
 * model gets right. The first shape tried here was a free-form object with a
 * JSON-Schema `additionalProperties` constraint, and a local runtime rendered
 * that constraint into the argument itself — nineteen refusals in one Structure
 * walk, every one of them `{"answers": {"additionalProperties": {...}}}`. A list
 * of two-field objects has no such construct to leak.
 *
 * A plain object is still accepted, because it is the shape the scripted leaf
 * sends and it was never the thing that failed.
 */
function answerMap(answers) {
  if (Array.isArray(answers)) {
    return Object.fromEntries(
      answers.filter((entry) => entry && typeof entry === 'object').map((entry) => [entry.ref, entry.answer]),
    );
  }
  return answers && typeof answers === 'object' ? answers : {};
}

async function igtAnswerEach(fixture, { answers: sent }) {
  const guard = await ensurePanel(fixture);
  if (guard) return guard;

  const before = await readScreen(fixture.frame);
  if (before.kind !== 'per_element') {
    return wrongScreen(ANSWER_TOOL, 'a per_element screen', before);
  }

  const answers = answerMap(sent);
  // A partial map is refused rather than filled in. Every question arrives
  // pre-answered, so a missing ref would silently record a problem the agent
  // never asserted.
  const wanted = before.groups.map((g) => g.ref);
  const missing = wanted.filter((ref) => !(ref in answers));
  if (missing.length) {
    return err(
      'rejected',
      `every element must be answered; missing ${missing.join(', ')}. Send answers as a list, ` +
        `one entry per ref: [{"ref": "${wanted[0]}", "answer": "yes"}, ...].`,
    );
  }
  const bad = Object.entries(answers).filter(([, v]) => v !== 'yes' && v !== 'no');
  if (bad.length) return err('rejected', `answers must be "yes" or "no": ${JSON.stringify(bad)}`);

  for (const ref of wanted) {
    const prefix = answers[ref] === 'yes' ? 'true-' : 'false-';
    await fixture.frame.locator(`input[name="${ref}"][id^="${prefix}"]`).click();
    await settle(700);
  }

  const after = await readScreen(fixture.frame);
  const wrong = after.groups.filter((g) => g.answered !== answers[g.ref]);
  if (wrong.length) {
    return err('rejected', `the panel did not take ${wrong.map((g) => g.ref).join(', ')}`);
  }

  const { moved, raw } = await advance(fixture, after);
  if (!moved) return err('rejected', 'Next did not leave the per-element screen');
  return toScreen(fixture, raw);
}

/**
 * Pick elements on the inspected page for a picker screen.
 *
 * The Element Selector drawer looks like the keyboard path and is not: its
 * `Select` never enables here. The panel takes its answer from a click on the
 * page, with Mouse Selection armed. A CSS selector still drives it — Playwright
 * resolves the selector and clicks what it finds, so nothing depends on
 * coordinates — and the counter is the only confirmation the panel offers.
 */
async function igtPickElements(fixture, { selectors = [], refs = [] }) {
  const guard = await ensurePanel(fixture);
  if (guard) return guard;

  const before = await readScreen(fixture.frame);
  if (before.kind !== 'element_picker') {
    return wrongScreen(ANSWER_TOOL, 'an element_picker screen', before);
  }

  // A ref names one of the screen's `pageOutline` rows — the page, as the picker
  // presents it. A raw CSS selector is still a legitimate answer and is what the
  // scripted leaf's answer sheet sends, so both are accepted and refs go first.
  const offered = fixture.pickerOptions ?? new Map();
  const unknown = refs.filter((ref) => !offered.has(ref));
  if (unknown.length) {
    return err(
      'not_found',
      `no element ${unknown.join(', ')} in this screen's pageOutline; it lists ` +
        `${[...offered.keys()].join(', ') || 'none'}`,
    );
  }
  const wanted = [...refs.map((ref) => offered.get(ref)), ...selectors];

  const toggle = fixture.frame.locator('[role=switch][aria-label="Mouse Selection"]');
  if ((await toggle.count()) && (await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click();
    await settle(1_000);
  }

  // The picker keeps per-element state and silently ignores a re-click of
  // something it has just dropped; clearing first makes the sequence
  // reproducible.
  const clear = fixture.frame.locator('button:has-text("Remove all selections")');
  if (await clear.isEnabled().catch(() => false)) {
    await clear.click();
    await settle(2_000);
  }

  for (const selector of wanted) {
    const target = fixture.page.locator(selector).first();
    if ((await target.count()) === 0) return err('not_found', `no element matches ${selector}`);
    await target.click({ timeout: 10_000 }).catch(() => {});
    await settle(2_500);
  }

  const picked = await readScreen(fixture.frame);
  if (picked.alreadySelected !== wanted.length) {
    return err(
      'rejected',
      `the picker took ${picked.alreadySelected} of ${wanted.length}; it silently refuses ` +
        'elements it does not consider valid candidates',
    );
  }

  const { moved, raw } = await advance(fixture, picked);
  if (!moved) return err('rejected', 'Next did not leave the picker screen');
  return toScreen(fixture, raw);
}

/**
 * Finish the guided test.
 *
 * The results screen is read before Finish is pressed, because Finish is what
 * replaces it. The *Save your results* dialog is handled if it appears and not
 * required to: against a test that already exists server-side it may not, and
 * this is the one place the inventory was inferring rather than reporting.
 */
async function igtFinish(fixture, { name = null } = {}) {
  const guard = await ensurePanel(fixture);
  if (guard) return guard;

  const results = await readScreen(fixture.frame);
  // A save dialog is a results screen that has already been pressed: the panel
  // reached it through `Finish` and is asking for a name. Refusing it would
  // leave the only tool that can close the dialog unreachable from the screen
  // the dialog is on.
  const onDialog = results.kind === 'save_dialog';
  if (results.kind !== 'results' && !onDialog) {
    return wrongScreen(ANSWER_TOOL, 'a results screen', results);
  }

  const issueLines = results.issueLines ?? [];
  const durationMinutes = Number(results.summary?.match(/(\d+)\s*min/i)?.[1] ?? 0) || null;
  if (!onDialog) await press(fixture.frame, 'Finish', { settleMs: 6_000 });

  let savedAs = fixture.testName;
  const after = onDialog ? results : await readScreen(fixture.frame);
  if (after.kind === 'save_dialog') {
    savedAs = name ?? fixture.testName;
    await fixture.frame.locator('[role=dialog] input').first().fill(savedAs);
    await settle(1_000);
    await press(fixture.frame, 'Save', { within: '[role=dialog]', settleMs: 9_000 });
  }

  const category = fixture.currentIgtCategory;
  fixture.currentIgtCategory = null;
  const panelView = await returnToOverview(fixture);
  if (IGT_SCREENS.has(panelView)) {
    return err('rejected', `Finish left the panel on ${panelView}`);
  }

  return ok({
    // The one field the graph routes on. `igt_answer` answers a question screen
    // and finishes the test through the same tool name, so the transcript tells
    // the two apart by what came back rather than by which tool was called —
    // and a unit whose walk never produced this flag is a unit Deque recorded
    // nothing for, whatever the unit's own report says.
    finished: true,
    category,
    issueCount: issueLines.length,
    issues: issueLines.map((title) => ({ title, elements: [] })),
    durationMinutes,
    savedAs,
    panelView,
  });
}

/**
 * Answer whatever screen the guided test is showing.
 *
 * The one answering tool, and the whole of the walk after `igt_start`. It reads
 * the panel, decides which shape is showing, and applies the argument that shape
 * takes — so a leaf cannot answer the wrong screen, because there is no other
 * screen it could have meant to answer.
 *
 * The results screen is the reason this is one tool rather than five. It is the
 * last turn of the unit and the only one that cannot be recovered from: a wrong
 * call there costs the guided test, and Deque writes its issues on Finish, so an
 * abandoned walk files nothing at all. Here it takes **any** argument, including
 * none — on a results screen there is nothing to answer and exactly one thing to
 * do, and a model that arrives still holding the previous screen's argument does
 * the right thing with it.
 */
async function igtAnswer(fixture, args = {}) {
  const guard = await ensurePanel(fixture);
  if (guard) return guard;

  const showing = await readScreen(fixture.frame);
  switch (showing.kind) {
    case 'single_choice':
      return igtAnswerChoice(fixture, args);
    case 'element_multiselect':
      return igtAnswerElements(fixture, { refs: args.refs ?? [] });
    case 'per_element':
      return igtAnswerEach(fixture, args);
    case 'element_picker':
      return igtPickElements(fixture, { refs: args.refs ?? [], selectors: args.selectors ?? [] });
    case 'results':
    case 'save_dialog':
      return igtFinish(fixture, { name: args.name ?? null });
    default:
      return wrongScreen(ANSWER_TOOL, 'a screen of a running guided test', showing);
  }
}

// ---------------------------------------------------------------------------
// Manual path — read and write
// ---------------------------------------------------------------------------

async function findElements(fixture, { query, pass = 'static', limit = 50 }) {
  const result = await fixture.page.evaluate(PAGE_ELEMENTS, [query, limit]).catch((error) => ({
    invalid: error.message,
  }));
  if (result.invalid) return err('not_found', `invalid selector ${JSON.stringify(query)}: ${result.invalid}`);
  // An empty match is this tool's answer, not its failure. `find_elements` is
  // the search that opens a per-subject test, and *this page state has none of
  // those* is the verdict the skill file routes on — a legitimate
  // `not-applicable`, which the design rule says a tool computes and the agent
  // reports. Returned as `not_found` it read as a fault: it put a tool error on
  // the draft for a page that was simply media-free, and it handed a small model
  // a refusal to recover from where there was nothing to recover.

  const elements = [];
  for (const element of result.elements) {
    if (pass === 'focused') {
      const focused = await fixture.page
        .evaluate((selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          el.focus();
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return {
            tookFocus: document.activeElement === el,
            outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
            boxShadow: style.boxShadow,
            box: {
              x: Math.round(box.x),
              y: Math.round(box.y),
              w: Math.round(box.width),
              h: Math.round(box.height),
            },
          };
        }, element.selector)
        .catch(() => null);
      elements.push(register(fixture, { ...element, focusedState: focused }));
    } else {
      elements.push(register(fixture, element));
    }
  }
  if (pass === 'focused') await fixture.page.evaluate(() => document.activeElement?.blur()).catch(() => {});
  return ok(elements);
}

async function describeElement(fixture, { selector, need = 'text' }) {
  const target = resolveSelector(fixture, selector);
  const result = await fixture.page.evaluate(PAGE_ELEMENTS, [target, 2]).catch((error) => ({
    invalid: error.message,
  }));
  if (result.invalid) return err('not_found', `invalid selector ${JSON.stringify(target)}: ${result.invalid}`);
  if (!result.elements.length) return err('not_found', `no element matches ${JSON.stringify(target)}`);
  if (result.total > 1) {
    return err('ambiguous', `${JSON.stringify(target)} matches ${result.total} elements`);
  }
  const element = register(fixture, result.elements[0]);

  if (need === 'image') {
    const shot = await fixture.page
      .locator(target)
      .first()
      .screenshot({ type: 'png' })
      .catch(() => null);
    if (!shot) return err('rejected', `${JSON.stringify(target)} could not be captured`);
    return {
      ...ok({
        kind: 'image',
        element,
        image: { mimeType: 'image/png' },
        caption: `${element.tag}${element.name ? ` — ${element.name}` : ''}`,
      }),
      images: [{ data: shot.toString('base64'), mimeType: 'image/png' }],
    };
  }

  // `context` carries relational text: what *follows* the element, for the
  // questions that ask whether something describes what comes after it.
  // `markup` carries the element's own tags, because half of what an auditor
  // judges is markup that renders as nothing — a missing captions track, an
  // absent `alt`, a role that is not there.
  const read = await fixture.page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const parts = [];
      let node = el.nextElementSibling;
      while (node && parts.length < 2) {
        parts.push((node.textContent ?? '').trim());
        node = node.nextElementSibling;
      }
      return {
        context: parts.join('\n').trim().slice(0, 400) || null,
        markup: el.outerHTML.replace(/\s+/g, ' ').trim().slice(0, 800),
      };
    }, target)
    .catch(() => null);

  return ok({ kind: 'text', element, context: read?.context ?? null, markup: read?.markup ?? null });
}

/**
 * File one manual issue against one element.
 *
 * The whole write path lives here: open the form, filter the combobox to one
 * catalog entry, commit an element through the Element Selector's selector
 * search — which, unlike the IGT picker, genuinely selects — save, and confirm
 * the manual issue count rose.
 *
 * `issue` is the exact catalog option text. The tool fails `ambiguous` unless it
 * filters the 418 entries to precisely one, listing the candidates: an ambiguous
 * branch is an authoring bug, not a runtime choice.
 */
async function addManualIssue(fixture, { selector, issue }) {
  const guard = await ensurePanel(fixture);
  if (guard) return guard;

  const target = resolveSelector(fixture, selector);
  const onPage = await fixture.page.evaluate(PAGE_ELEMENTS, [target, 2]).catch(() => ({ invalid: 'x' }));
  if (onPage.invalid || !onPage.elements?.length) {
    return err('not_found', `no element matches ${JSON.stringify(target)} on the page`);
  }

  if (!(await has(fixture.frame, 'Add Manual Issue'))) {
    await returnToOverview(fixture);
    if (!(await has(fixture.frame, 'Add Manual Issue'))) {
      // The same rule as a wrong-screen refusal: name the next action. This one
      // is not `wrong_screen` because the panel is not on a screen a tool of the
      // model's could answer, and it cannot put itself back — `restore_page` is
      // bound to no leaf. So the honest next action is to establish the verdict
      // and report the unit blocked, rather than to keep trying to write.
      return terminal(
        'rejected',
        'Add Manual Issue is absent or aria-disabled; the panel is not on the saved test. ' +
          'Nothing you can call will move it — call check_ledger() and report this unit ' +
          'blocked with the verdict it returns.',
      );
    }
  }
  await press(fixture.frame, 'Add Manual Issue', { settleMs: 4_000 });

  const before = await manualIssueCount(fixture);

  // The combobox filters on the human-readable label; the parenthesised ids are
  // part of the option's text but not of what it matches on. So the label half
  // does the filtering and the full text does the identifying.
  const label = issue.replace(/\s*\([^)]*\)\s*$/, '');
  const combobox = fixture.frame.locator('input[role=combobox]').first();
  await combobox.click();
  await combobox.pressSequentially(label, { delay: 30 });
  await settle(2_500);

  const options = await fixture.frame.evaluate(() =>
    [...document.querySelectorAll('[role=listbox] [role=option]')]
      .filter((o) => o.getBoundingClientRect().width > 0)
      .map((o) => o.textContent.trim()),
  );

  const exact = options.filter((option) => option === issue);
  const chosen = exact.length === 1 ? exact[0] : options.length === 1 ? options[0] : null;
  if (!chosen) {
    await abandonForm(fixture);
    return options.length === 0
      ? err('not_found', `no catalog entry matches ${JSON.stringify(issue)}`)
      : err(
          'ambiguous',
          `${JSON.stringify(issue)} filtered to ${options.length} entries: ${options.join(' | ')}`,
        );
  }

  const clicked = await fixture.frame.evaluate((wanted) => {
    const option = [...document.querySelectorAll('[role=listbox] [role=option]')]
      .filter((o) => o.getBoundingClientRect().width > 0)
      .find((o) => o.textContent.trim() === wanted);
    if (!option) return false;
    option.click();
    return true;
  }, chosen);
  if (!clicked) {
    await abandonForm(fixture);
    return err('rejected', `the listbox did not take ${JSON.stringify(chosen)}`);
  }
  await settle(1_500);

  const selected = await selectElementInDrawer(fixture, target);
  if (!selected.ok) {
    await abandonForm(fixture);
    return selected;
  }

  await press(fixture.frame, 'Save', { siblingOf: 'Cancel', settleMs: 6_000 });

  const landed = await fixture.frame.evaluate((wanted) => {
    const text = document.body.innerText;
    return {
      confirmed: /Manual issue successfully created/i.test(text),
      listed: text.includes(wanted),
    };
  }, chosen.replace(/\s*\([^)]*\)\s*$/, ''));
  const after = await manualIssueCount(fixture);
  if (!landed.confirmed || after === null || (before !== null && after <= before)) {
    return err(
      'rejected',
      `the panel reported no new manual issue (${before} -> ${after}, confirmed=${landed.confirmed})`,
    );
  }

  return ok({
    selector: target,
    issue: chosen,
    element: selected.value.committed,
    recordedLocation: await recordedLocation(fixture),
    manualIssueCount: after,
  });
}

const manualIssueCount = (fixture) =>
  fixture.frame
    .evaluate(() => {
      const found = document.body.innerText.match(/Manual Issues\s*\n\s*(\d+)/);
      return found ? Number(found[1]) : null;
    })
    .catch(() => null);

/** Leave the manual issue form without filing, so the next gate reads a checkpoint. */
const abandonForm = (fixture) =>
  press(fixture.frame, 'Cancel', { siblingOf: 'Save', settleMs: 4_000 }).catch(() => {});

/**
 * The selector the extension itself stored for the newest manual issue.
 *
 * Read from the server rather than by expanding the filed issue in the panel:
 * the extension constructs a CSS selector of its own and keeps it, so a finding
 * round-trips without an extra click on a view the next unit has to inherit.
 */
/** The saved test's issues, straight from the API, or null when it did not answer. */
async function fetchIssues(fixture) {
  const response = await fetch(`${fixture.serverUrl}/api/tests/${fixture.testId}/issues`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${fixture.accessToken}` },
  }).catch(() => null);
  if (!response?.ok) return null;
  // The SPA shell answers 200 text/html to any path it does not route, so a
  // check that trusts the status code reads success out of a web page.
  if (!(response.headers.get('content-type') ?? '').includes('json')) return null;
  const body = await response.json().catch(() => null);
  return Array.isArray(body) ? body : null;
}

async function recordedLocation(fixture) {
  const issues = await fetchIssues(fixture);
  if (!issues) return null;
  const manual = issues.filter((issue) => issue.is_manual && !issue.manifest_guide);
  const newest = manual[manual.length - 1];
  const node = (newest?.nodes ?? newest?.elements ?? [])[0];
  const stored = node?.target ?? node?.selector ?? newest?.selector ?? null;
  // The server stores the target as an array of selectors, one per frame depth.
  // A finding on the top document is a single-element array, and a selector is
  // what round-trips, so it is returned as one.
  return Array.isArray(stored) ? (stored.length === 1 ? stored[0] : stored.join(' | ')) : stored;
}

/**
 * Point the Element Selector at one element, by CSS selector.
 *
 * The drawer's own selector search is what makes this deterministic: it expands
 * the tree to the match wherever it is nested, and here — unlike on an IGT
 * picker screen — `Select` genuinely commits. Acting on the tree while the
 * drawer is collapsed fails silently, so the drawer is opened first.
 */
async function selectElementInDrawer(fixture, selector) {
  const drawerOpen = await fixture.frame
    .locator('[role=treeitem]')
    .first()
    .evaluate((el) => el.getBoundingClientRect().width > 0)
    .catch(() => false);
  if (!drawerOpen) {
    await press(fixture.frame, 'View element selector', { settleMs: 3_000 }).catch(() => {});
  }

  if ((await fixture.frame.locator('input[type=search]').count()) === 0) {
    await fixture.frame.locator('button[aria-controls="css-search-bar"]').first().click();
    await settle(1_500);
  }
  const search = fixture.frame.locator('input[type=search]').first();
  await search.fill(selector);
  await search.press('Enter');
  await settle(2_500);

  const hits = await fixture.frame.evaluate(
    () => document.body.innerText.match(/(\d+)\s+of\s+(\d+)/)?.slice(1, 3) ?? null,
  );
  if (!hits) return err('not_found', `the selector search found nothing for ${selector}`);

  await press(fixture.frame, 'Select', { settleMs: 3_000 });

  // The form prints the committed element as markup between two headings; there
  // is no container that wraps just that region.
  const committed = await fixture.frame.evaluate(() => {
    const text = document.body.innerText;
    const from = text.indexOf('Selected Element');
    const to = text.indexOf('Element Selector', from + 1);
    if (from < 0 || to < 0) return null;
    return text.slice(from, to).match(/<[a-zA-Z][^>]*>/)?.[0] ?? null;
  });
  if (!committed) return err('rejected', `Select did not commit ${selector}`);
  return ok({ committed, matches: Number(hits[1]) });
}

// ---------------------------------------------------------------------------
// The served set
// ---------------------------------------------------------------------------

const str = (description) => ({ type: 'string', description });

export function buildTools(fixture) {
  const define = (name, description, properties, required, handler) => ({
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    handler: (args) => handler(fixture, args ?? {}),
  });

  return [
    // Session and graph
    define(
      'check_ledger',
      'Is the saved test still there and can the panel still write to it? Reads the panel and ' +
        'the server. Returns alive plus one of eight verdicts. Never raises.',
      {},
      [],
      checkLedgerTool,
    ),
    define(
      'read_test_results',
      "Every issue on the run's saved test, optionally filtered to those whose text contains " +
        'match. Refuses when the panel is dead.',
      { match: str('substring to filter issue titles and element snippets by') },
      [],
      readTestResults,
    ),
    define(
      'restore_page',
      "Reload the fixture's URL, reset the viewport, re-assert panel selection, return the panel " +
        'to the overview, and confirm the ledger survived.',
      {},
      [],
      restorePage,
    ),
    define(
      'reopen_saved_test',
      "Press 'view saved tests' and open the run's own test. Takes no argument.",
      {},
      [],
      reopenSavedTest,
    ),
    define(
      'save_progress_and_quit',
      'Quit a guided test that is still running, through the Options menu.',
      {},
      [],
      saveProgressAndQuit,
    ),

    // IGT path
    define('igt_list', 'The guided test categories, with run counts and completion.', {}, [], igtList),
    define(
      'igt_start',
      'Start a guided test category. Call this once, from the overview, before any other igt tool. ' +
        'Returns the first screen.',
      { category: str('the category name, e.g. "Structure"') },
      ['category'],
      igtStart,
    ),
    define(
      'igt_current',
      'Re-read the screen the guided test is on, without answering it. Returns the same Screen the ' +
        'answer tools return.',
      {},
      [],
      igtCurrent,
    ),
    define(
      ANSWER_TOOL,
      'Answer the guided test screen showing, and advance. This is the only tool that answers an ' +
        'IGT screen: every screen names it in answerWith and names the argument it takes in send. ' +
        'single_choice takes choice; per_element takes answers; element_multiselect and ' +
        'element_picker takes refs from the screen\'s pageOutline; results takes nothing and ' +
        'finishes the test, returning its issues in Deque\'s own words.',
      {
        choice: { type: 'string', enum: ['yes', 'no'], description: "a single_choice screen: 'yes' or 'no'" },
        answers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: str("a ref from the screen's groups"),
              answer: { type: 'string', enum: ['yes', 'no'], description: "'yes' or 'no'" },
            },
            required: ['ref', 'answer'],
            additionalProperties: false,
          },
          description:
            'a per_element screen: one entry per group ref the screen listed, each with its yes or no',
        },
        refs: {
          type: 'array',
          items: { type: 'string' },
          description:
            'an element_multiselect screen: the ref of each option that applies. An ' +
            "element_picker screen: the ref of each of the screen's pageOutline rows to pick. " +
            'An empty list is a real answer.',
        },
        selectors: {
          type: 'array',
          items: { type: 'string' },
          description:
            'an element_picker screen: CSS selectors on the inspected page, as an alternative to refs',
        },
        name: str('a save dialog: the test name, used only if the panel asks for one'),
      },
      [],
      igtAnswer,
    ),
    define(
      'page_state_warning',
      'Is the page-state warning banner up? A cheap read that performs no clicks.',
      {},
      [],
      pageStateWarning,
    ),

    // Manual path — read and write
    define(
      'find_elements',
      'Every element on the page matching a CSS selector, as element refs. An empty list is a ' +
        'real answer: the page state holds none of them.',
      {
        query: str('a CSS selector'),
        pass: {
          type: 'string',
          enum: ['static', 'focused'],
          description: "'focused' focuses each match before capturing it",
        },
        limit: { type: 'integer', description: 'how many matches to return, default 50' },
      },
      ['query'],
      findElements,
    ),
    define(
      'describe_element',
      'One element as evidence: text with the content that follows it, or an image.',
      {
        selector: str('a CSS selector, or a ref from find_elements'),
        need: { type: 'string', enum: ['text', 'image'], description: 'the evidence kind' },
      },
      ['selector'],
      describeElement,
    ),
    define(
      'add_manual_issue',
      'File one manual issue against one element. issue is the exact catalog option text.',
      {
        selector: str('a CSS selector, or a ref from find_elements'),
        issue: str('the catalog entry, full option text including the parenthesised ids'),
      },
      ['selector', 'issue'],
      addManualIssue,
    ),
  ];
}
