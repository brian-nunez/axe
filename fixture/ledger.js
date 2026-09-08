/**
 * Is the ledger still there?
 *
 * The extension's saved test is the only record of findings until submission,
 * and losing it is silent: a four-hour run that loses the panel and keeps
 * working produces nothing. So the orchestrator calls `checkLedger` between
 * every sub-agent, and the check reads two independent places:
 *
 *   the panel   — can a finding still be recorded? Read from the panel's own
 *                 document, no clicks, no navigation.
 *   the server  — do the findings already recorded still exist? Read over HTTP
 *                 with the token the keepalive already holds, so the panel is
 *                 never touched.
 *
 * Neither half is sufficient. A dead panel with an intact test is recoverable.
 * A live panel over a lost test is the dangerous case — the run keeps
 * answering questions into nothing — and only the server half sees it.
 */

const JSON_HEADERS = { Accept: 'application/json' };

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The saved test lives at `${AXE_SERVER_URL}/api/...` behind the same bearer
 * token the extension uses. The SPA shell answers 200 to any path it does not
 * route, so a non-JSON response means the path is wrong, not that the test is
 * gone — worth distinguishing, because one is a bug and the other aborts a run.
 */
async function getJson(serverUrl, path, accessToken) {
  const response = await fetch(`${serverUrl}${path}`, {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${accessToken}` },
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  if (!contentType.includes('json')) {
    throw new Error(`GET ${path} returned ${contentType || 'no content type'}, not JSON`);
  }
  return { status: response.status, bytes: body.length, body: JSON.parse(body) };
}

/**
 * The per-IGT run record, keyed by guide name.
 *
 * A better completion signal for a whole run than the panel's progressbar, and
 * readable without touching the panel. `check_ledger` folds it into the
 * `Ledger.igt` array the tool inventory promises; nothing in the five checks
 * depends on it, so a server that does not route the path costs a field rather
 * than a verdict.
 */
export async function readManifests({ serverUrl, accessToken, testId, guideCounts = {} }) {
  const { status, body } = await getJson(serverUrl, `/api/tests/${testId}/manifests`, accessToken);
  if (status !== 200) return [];
  // The response is keyed by guide name, each key holding one record per run.
  const records = Array.isArray(body)
    ? body
    : Object.entries(body ?? {}).flatMap(([guide, runs]) =>
        (Array.isArray(runs) ? runs : [runs]).map((run) => ({ guide, ...run })),
      );

  const byGuide = new Map();
  for (const record of records) {
    const guide = record?.guide ?? record?.manifest_guide ?? 'unknown';
    if (!byGuide.has(guide)) byGuide.set(guide, { category: guide, runs: 0 });
    byGuide.get(guide).runs += 1;
  }

  return [...byGuide.values()]
    .map((entry) => ({
      ...entry,
      issues: guideCounts[entry.category] ?? 0,
      // A manifest record is written when a run *ends* — by Finish, or by
      // `Save progress & quit`. So this reads "a run was recorded", which is
      // what the record can actually support; the server carries no flag for
      // "every question was answered" and inventing one would be a claim.
      completed: entry.runs > 0,
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/** Every saved test this account owns, newest first. */
export async function listSavedTests({ serverUrl, accessToken, userId, limit = 25 }) {
  const { body } = await getJson(serverUrl, `/api/users/${userId}/tests?limit=${limit}`, accessToken);
  return body;
}

/**
 * Find the test the fixture just saved, so the run has an id to hold onto.
 *
 * The panel never shows the id, and the name is not unique across runs — the
 * same fixture run twice produces two tests called the same thing. Pass
 * `createdAfter` from just before the save and the newest match is the one.
 */
export async function resolveSavedTest({ serverUrl, accessToken, userId, name, createdAfter }) {
  const tests = await listSavedTests({ serverUrl, accessToken, userId });
  const since = createdAfter ? new Date(createdAfter).getTime() : 0;
  const match = tests.find(
    (test) => test.name === name && new Date(test.created_at).getTime() >= since,
  );
  if (!match) {
    throw new Error(
      `no saved test named ${JSON.stringify(name)} created at or after ` +
        `${new Date(since).toISOString()}; newest is ${JSON.stringify(tests[0]?.name ?? null)}`,
    );
  }
  return match;
}

/**
 * What the server holds for one test.
 *
 * `is_manual` is true for everything a person contributed, which is both paths
 * at once; `manifest_guide` is what separates them. An issue from Add Manual
 * Issue carries no guide, an issue produced by an IGT carries the guide's name.
 * Counting them apart is the point — a run can lose one path's work and keep
 * the other's, and a single total would hide that.
 */
export async function readLedger({ serverUrl, accessToken, testId }) {
  const test = await getJson(serverUrl, `/api/tests/${testId}`, accessToken);
  if (test.status === 404) {
    return { testId, exists: false, bytes: test.bytes };
  }
  if (test.status !== 200) {
    throw new Error(`GET /api/tests/${testId} returned ${test.status}`);
  }

  const issues = await getJson(serverUrl, `/api/tests/${testId}/issues`, accessToken);
  if (issues.status !== 200) {
    throw new Error(`GET /api/tests/${testId}/issues returned ${issues.status}`);
  }

  const manual = issues.body.filter((issue) => issue.is_manual && !issue.manifest_guide);
  const guided = issues.body.filter((issue) => issue.manifest_guide);

  return {
    testId,
    exists: true,
    isActive: test.body.is_active,
    name: test.body.name,
    url: test.body.url,
    updatedAt: test.body.updated_at,
    issues: {
      total: issues.body.length,
      automatic: issues.body.length - manual.length - guided.length,
      manual: manual.length,
      guided: guided.length,
    },
    guides: [...new Set(guided.map((issue) => issue.manifest_guide))].sort(),
    // Per-guide counts, so a caller wanting the IGT breakdown does not fetch
    // every issue a second time. A run can lose one guide's work and keep
    // another's, and a single guided total hides exactly that.
    guideCounts: guided.reduce((counts, issue) => {
      counts[issue.manifest_guide] = (counts[issue.manifest_guide] ?? 0) + 1;
      return counts;
    }, {}),
    bytes: test.bytes + issues.bytes,
  };
}

/** The shape a later check compares against: what was true when the run began. */
export function ledgerBaseline(ledger) {
  if (!ledger.exists) throw new Error('cannot take a baseline from a test that does not exist');
  return {
    testId: ledger.testId,
    name: ledger.name,
    url: ledger.url,
    issues: { ...ledger.issues },
  };
}

/**
 * Read the panel without touching it.
 *
 * Everything here comes from the panel document's own text and geometry.
 * No clicks: a check that navigates the panel to find out whether the panel is
 * healthy can itself be what loses the view a sub-agent was mid-way through.
 *
 * The body box is measured rather than the iframe's, because the iframe can
 * report a real size while the panel document inside it is still 0x0 — the
 * state in which every action fails as "not visible".
 */
export function readPanel(frame) {
  return frame
    .evaluate(() => {
      const box = document.body.getBoundingClientRect();
      const text = document.body.innerText;
      const number = (pattern) => {
        const found = text.match(pattern);
        return found ? Number(found[1]) : null;
      };
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      return {
        body: { w: Math.round(box.width), h: Math.round(box.height) },
        // Refreshing the extension orphans the panel document without
        // unrendering it: the view still reads correctly, every count still
        // shows, and nothing it does reaches the extension again. Chrome
        // clears `chrome.runtime.id` on an invalidated context, which is the
        // only cheap tell that the panel has stopped being connected to
        // anything. Geometry and text alone report this panel as healthy.
        runtimeId: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || null,
        headings: [...document.querySelectorAll('h1,h2,h3,h4,[role=heading]')]
          .filter(visible)
          .map((h) => h.textContent.trim())
          .filter(Boolean),
        // Which view the panel is on. The ledger's counts are only rendered on
        // the overview, so a check that finds the panel anywhere else has not
        // found a broken ledger — it has found a sub-agent that did not put the
        // panel back. Those are different failures with different fixes.
        view: (() => {
          if (/The state of your page has changed/i.test(text)) return 'page-state-warning';
          if (/TOTAL ISSUES/.test(text)) return 'overview';
          if (document.getElementById('question-text')) return 'igt-question';
          if (/Intelligent Guided Tests/i.test(text) && /Testing Progress/i.test(text)) return 'overview-igt';
          if (/Guided Testing:/i.test(text)) return 'igt';
          // "view saved tests" is a button on nearly every view, so the entry
          // screen has to be identified by its own action, not by that phrase.
          if (
            [...document.querySelectorAll('button')].some(
              (b) => visible(b) && (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === 'Scan full page',
            )
          ) {
            return 'scan';
          }
          return 'unknown';
        })(),
        testName:
          (text.match(/Test Name\s*\n\s*(.+)/) ?? [])[1]?.trim() ??
          // The overview of a test with no automated scan drops the labelled
          // field and renders the name as the heading under the view tabs.
          (text.match(/Guided Tests\s*\n\s*(.+)\n\s*Testing Progress/) ?? [])[1]?.trim() ??
          null,
        testUrl: (text.match(/Test URL\s*\n\s*(\S+)/) ?? [])[1]?.trim() ?? null,
        counts: {
          total: number(/TOTAL ISSUES\s*\n\s*(\d+)/),
          automatic: number(/Automatic Issues\s*\n\s*(\d+)/),
          guided: number(/Guided Issues\s*\n\s*(\d+)/),
          manual: number(/Manual Issues\s*\n\s*(\d+)/),
        },
        // The page-state guard is an advisory banner above the question, not a
        // replacement for it: Back, Next and the element selector stay live
        // underneath. So this is a flag the caller must act on, not a state the
        // panel enforces.
        pageStateChanged: /The state of your page has changed/i.test(text),
        savedTestsButton: [...document.querySelectorAll('button')]
          .filter(visible)
          .some((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === 'view saved tests'),
      };
    })
    .catch((error) => ({ unreadable: error.message }));
}

/**
 * One verdict, and what the orchestrator should do about it.
 *
 * The verdicts are ordered by how much of the run they cost, and only the last
 * two are actually ledger loss:
 *
 *   intact          continue
 *   panel-hidden    re-assert the panel selection and check again; DevTools
 *                   takes the tab back on its own, and that is a transient, not
 *                   a loss. This is why the free liveness signal from the panel
 *                   DOM contract cannot be the whole check — used alone it
 *                   aborts healthy runs.
 *   panel-orphaned  the panel document survived a refresh of the extension it
 *                   belongs to. It still renders the test and every count, and
 *                   it can no longer reach the extension. Nothing recorded into
 *                   it will land. Abort — the panel cannot be reconnected.
 *   panel-elsewhere the panel is healthy but not on a view that renders the
 *                   ledger — mid-IGT, on the saved-tests list, on a scan. Not a
 *                   loss: a sub-agent left the panel somewhere. Bring it back
 *                   to the overview and check again.
 *   panel-detached  the panel is live but no longer showing the run's test.
 *                   The findings are safe on the server; the binding is what
 *                   broke. One bounded recovery, then abort.
 *   test-lost       the saved test is gone or deactivated server-side. Abort.
 *   issues-lost     the test is there and holds fewer findings than the run
 *                   already filed. Abort.
 */
export async function checkLedger({
  frame,
  reselect,
  serverUrl,
  accessToken,
  baseline,
  settleMs = 1_500,
}) {
  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    return ok;
  };

  let panel = await readPanel(frame);
  // A panel that is laid out now and 0x0 a beat later was never really shown:
  // DevTools steals the tab back while it finishes starting up, and an action
  // taken in the gap fails as "not visible".
  if (!panel.unreadable && panel.body.w > 0) {
    await settle(settleMs);
    panel = await readPanel(frame);
  }

  const laidOut = !panel.unreadable && panel.body.w > 0 && panel.body.h > 0;
  if (!laidOut && reselect) {
    const reselected = await reselect().catch((error) => ({ error: error.message }));
    if (reselected?.frame) frame = reselected.frame;
    panel = await readPanel(frame);
    record('panel re-selected', !panel.unreadable && panel.body.w > 0, panel.body ?? panel);
  }

  const showing = !panel.unreadable && panel.body.w > 0 && panel.body.h > 0;
  record('panel laid out', showing, panel.body ?? panel);

  const connected = showing && record('panel connected to the extension', Boolean(panel.runtimeId), {
    runtimeId: panel.runtimeId ?? null,
  });

  const ledger = await readLedger({ serverUrl, accessToken, testId: baseline.testId }).catch(
    (error) => ({ error: error.message }),
  );

  if (ledger.error) {
    record('saved test readable', false, ledger.error);
    return { ok: false, verdict: 'server-unreachable', action: 'retry-then-abort', checks, panel };
  }

  const exists = record('saved test exists', ledger.exists && ledger.isActive !== false, {
    exists: ledger.exists,
    isActive: ledger.isActive ?? null,
  });

  const held = ledger.issues ?? { total: 0, manual: 0, guided: 0 };
  const holds =
    exists &&
    record(
      'saved test holds its issues',
      held.total >= baseline.issues.total &&
        held.manual >= baseline.issues.manual &&
        held.guided >= baseline.issues.guided,
      { baseline: baseline.issues, now: held },
    );

  // The join between the two halves: this panel, showing this run's test. A
  // panel that has been sent back to a fresh scan is live, and useless.
  const atCheckpoint =
    showing &&
    record('panel at a checkpoint view', panel.view === 'overview' || panel.view === 'overview-igt', {
      view: panel.view,
    });
  const bound =
    atCheckpoint &&
    record('panel bound to the saved test', panel.testName === baseline.name, {
      expected: baseline.name,
      panel: panel.testName,
    });

  if (!exists) {
    return { ok: false, verdict: 'test-lost', action: 'abort', checks, panel, ledger };
  }
  if (!holds) {
    return { ok: false, verdict: 'issues-lost', action: 'abort', checks, panel, ledger };
  }
  if (!showing) {
    return { ok: false, verdict: 'panel-hidden', action: 'reselect-then-abort', checks, panel, ledger };
  }
  if (!connected) {
    return { ok: false, verdict: 'panel-orphaned', action: 'abort', checks, panel, ledger };
  }
  if (!atCheckpoint) {
    return { ok: false, verdict: 'panel-elsewhere', action: 'return-to-overview', checks, panel, ledger };
  }
  if (!bound) {
    return { ok: false, verdict: 'panel-detached', action: 'reopen-then-abort', checks, panel, ledger };
  }
  return { ok: true, verdict: 'intact', action: 'continue', checks, panel, ledger };
}
