// PROTOTYPE — throwaway. Answers ticket 010: how does a run notice the ledger
// is gone? Delete once 011 names the tools.
//
// Builds a real ledger — scan, save, file a manual issue — takes a baseline,
// then breaks the ledger three different ways and shows `checkLedger` from
// `fixture/ledger.js` catching each one with the right verdict.
//
// The breaks are deliberate and destructive. This runs its own browser and its
// own saved test; never point it at a run in progress.
//
//   node prototype/ledger-check.js --extension=build/axe-extension --url=...

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsFromEnv, serverUrlFromEnv } from '../fixture/session.js';
import { launchSignedIn } from '../fixture/launch.js';
import { startSessionKeepAlive } from '../fixture/keepalive.js';
import {
  checkLedger,
  ledgerBaseline,
  readLedger,
  readPanel,
  listSavedTests,
  resolveSavedTest,
} from '../fixture/ledger.js';

const EXTENSION_ID = 'lhdoppojpmngadmnindnejefpokejbdd';
const DEFAULT_URL = 'http://127.0.0.1:8731/';
const MANUAL_ISSUE = {
  selector: 'a#vague-link',
  query: 'Link purpose not clear from link text alone',
};

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { headless: true, url: DEFAULT_URL, out: 'build/ledger' };
  for (const arg of argv) {
    if (arg.startsWith('--extension=')) args.extensionPath = arg.slice(12);
    else if (arg.startsWith('--url=')) args.url = arg.slice(6);
    else if (arg.startsWith('--out=')) args.out = arg.slice(6);
    else if (arg === '--headed') args.headless = false;
    else throw new Error(`unrecognised argument: ${arg}`);
  }
  if (!args.extensionPath) throw new Error('--extension=<unpacked directory> is required');
  return args;
}

async function poll(fn, { timeoutMs = 30_000, everyMs = 250, what }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await settle(everyMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const listTabIds = (dt) =>
  dt.evaluate(() =>
    import('./ui/legacy/legacy.js').then((UI) =>
      UI.InspectorView.InspectorView.instance().tabbedPane.tabIds(),
    ),
  );

/** Select the panel and return its frame, once its own document holds layout. */
async function showPanel(dt, id, { timeoutMs = 90_000 } = {}) {
  const select = () =>
    dt.evaluate(
      (viewId) =>
        import('./ui/legacy/legacy.js').then((UI) =>
          UI.InspectorView.InspectorView.instance().tabbedPane.selectTab(viewId, true),
        ),
      id,
    );

  const bodyBox = async () => {
    const frame = dt.frames().find((f) => f.url().endsWith('/panel.html'));
    if (!frame) return null;
    const box = await frame
      .evaluate(() => {
        const r = document.body.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })
      .catch(() => null);
    return box && box.w > 0 && box.h > 0 ? frame : null;
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await select().catch(() => {});
    for (let i = 0; i < 10; i += 1) {
      await settle(500);
      if (!(await bodyBox())) continue;
      // DevTools steals the selection back while it finishes starting up.
      await settle(2_500);
      const still = await bodyBox();
      if (still) return still;
      break;
    }
  }
  throw new Error('panel never held layout');
}

/** Clear the onboarding dialog chain; each one blocks the whole panel. */
async function clearOnboarding(frame) {
  const cleared = [];
  for (let i = 0; i < 6; i += 1) {
    const dialog = frame.locator('[role=dialog].Dialog--show').first();
    if ((await dialog.count()) === 0) break;
    const title =
      (await dialog.locator('h1,h2,h3,[id^=dialog-title]').first().textContent().catch(() => null))
        ?.trim() ?? '(untitled)';
    const role = dialog.locator('select#user-job-role');
    if (await role.count()) {
      await role.selectOption('Developer');
      await dialog.locator('#terms-and-services-checkbox').check();
    }
    const action = dialog
      .locator(
        'button:has-text("Start using axe DevTools"), button:has-text("Got it"), ' +
          'button:has-text("Continue"), button:has-text("Close")',
      )
      .first();
    if (await action.count()) await action.click();
    else await frame.press('body', 'Escape').catch(() => {});
    await settle(2_000);
    cleared.push(title);
  }
  return cleared;
}

/** Exact name, visible and enabled only, dispatched on the element. */
async function press(frame, label, { within } = {}) {
  const clicked = await frame.evaluate(
    ({ wanted, scope }) => {
      const root = scope ? document.querySelector(scope) : document;
      if (!root) return null;
      const name = (el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
      const match = [...root.querySelectorAll('button')]
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true')
        .find((b) => name(b) === wanted);
      if (!match) return null;
      match.click();
      return wanted;
    },
    { wanted: label, scope: within ?? null },
  );
  if (!clicked) throw new Error(`no visible, enabled button named ${JSON.stringify(label)}`);
  await settle(3_000);
}

const visibleButtons = (frame) =>
  frame.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((b) => ({
        name: (b.getAttribute('aria-label') ?? b.textContent ?? '').trim(),
        disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
      }))
      .filter((b) => b.name),
  );

/** Scan the page and save the test, which is what unlocks Add Manual Issue. */
async function scanAndSave(frame, name) {
  await press(frame, 'Scan full page');
  await settle(12_000);
  await press(frame, 'Save Test');
  await frame.locator('[role=dialog] input').first().fill(name);
  await settle(1_000);
  await press(frame, 'Save', { within: '[role=dialog]' });
  await settle(8_000);
}

async function addManualIssue(frame, { selector, query }) {
  await press(frame, 'Add Manual Issue');
  const combobox = frame.locator('input[role=combobox]').first();
  await combobox.click();
  await combobox.pressSequentially(query, { delay: 40 });
  await settle(2_000);

  const chosen = await frame.evaluate(() => {
    const options = [...document.querySelectorAll('[role=listbox] [role=option]')].filter(
      (o) => o.getBoundingClientRect().width > 0,
    );
    if (options.length !== 1) return { error: `matched ${options.length} entries` };
    const text = options[0].textContent.trim();
    options[0].click();
    return { text };
  });
  if (chosen.error) throw new Error(`catalog query ${JSON.stringify(query)} ${chosen.error}`);
  await settle(1_500);

  const treeOpen = await frame
    .locator('[role=treeitem]')
    .first()
    .evaluate((el) => el.getBoundingClientRect().width > 0)
    .catch(() => false);
  if (!treeOpen) await press(frame, 'View element selector');

  if ((await frame.locator('input[type=search]').count()) === 0) {
    await frame.locator('button[aria-controls="css-search-bar"]').first().click();
    await settle(1_500);
  }
  await frame.locator('input[type=search]').first().fill(selector);
  await frame.locator('input[type=search]').first().press('Enter');
  await settle(2_500);
  await press(frame, 'Select');
  await press(frame, 'Save');
  await settle(6_000);
  return chosen.text;
}

const report = (label, verdict) => {
  console.log(`\n--- ${label}`);
  console.log(`    verdict ${verdict.verdict}   action ${verdict.action}`);
  for (const check of verdict.checks) {
    console.log(`    ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}  ${JSON.stringify(check.detail)}`);
  }
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userDataDir = await mkdtemp(join(tmpdir(), 'axe-ledger-'));
  await mkdir(args.out, { recursive: true });
  const serverUrl = serverUrlFromEnv();
  const transcript = [];
  const note = (step, detail) => {
    transcript.push({ step, detail });
    return detail;
  };

  const { context, worker, ssoConfig, session, user } = await launchSignedIn({
    extensionPath: args.extensionPath,
    userDataDir,
    serverUrl,
    credentials: credentialsFromEnv(),
    headless: args.headless,
    openDevtools: true,
  });
  const keepAlive = startSessionKeepAlive({
    worker,
    ssoConfig,
    session,
    onError: (error) => console.log(`[keepalive] ${error.message}`),
  });
  const token = () => keepAlive.session.access_token;

  try {
    const page = context.pages().find((p) => !p.url().startsWith('devtools://'));
    await page.goto(args.url, { waitUntil: 'domcontentloaded' });

    const dt = await poll(() => context.pages().find((p) => p.url().startsWith('devtools://')), {
      what: 'a devtools:// page',
    });
    const axeTab = await poll(
      async () => (await listTabIds(dt)).find((id) => id.includes(EXTENSION_ID)),
      { what: 'the axe panel to register' },
    );
    let frame = await showPanel(dt, axeTab);
    const reselect = async () => ({ frame: (frame = await showPanel(dt, axeTab, { timeoutMs: 20_000 })) });
    console.log(`onboarding: ${JSON.stringify(await clearOnboarding(frame))}`);

    // ---------------------------------------------------------------- ledger
    const testName = `Ledger check - 010 - ${new Date().toISOString()}`;
    const savedAfter = new Date(Date.now() - 60_000).toISOString();
    await scanAndSave(frame, testName);
    const saved = await resolveSavedTest({
      serverUrl,
      accessToken: token(),
      userId: user.id,
      name: testName,
      createdAfter: savedAfter,
    });
    console.log(`saved test ${saved.id}`);
    const filed = await addManualIssue(frame, MANUAL_ISSUE);
    console.log(`filed ${JSON.stringify(filed)}`);

    const started = Date.now();
    const ledger = await readLedger({ serverUrl, accessToken: token(), testId: saved.id });
    const baseline = ledgerBaseline(ledger);
    note('baseline', { baseline, readMs: Date.now() - started, bytes: ledger.bytes });
    console.log(`baseline ${JSON.stringify(baseline.issues)}  ${ledger.bytes} bytes in ${Date.now() - started} ms`);

    // -------------------------------------------------------------- intact
    let began = Date.now();
    let verdict = await checkLedger({ frame, reselect, serverUrl, accessToken: token(), baseline });
    report(`healthy ledger (${Date.now() - began} ms)`, verdict);
    note('healthy', { verdict: verdict.verdict, action: verdict.action, ms: Date.now() - began, checks: verdict.checks });

    /** Open a saved test by exact name from the saved-tests list. */
    const openSavedTest = async (wanted) => {
      await press(frame, 'view saved tests');
      await settle(5_000);
      const opened = await frame.evaluate((name) => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const candidates = [...document.querySelectorAll('button,a,[role=button],[role=link]')].filter(visible);
        const match = candidates.find((el) => (el.textContent ?? '').trim() === name);
        if (!match) {
          return { error: `no entry named ${JSON.stringify(name)}`, offered: candidates.map((el) => (el.textContent ?? '').trim()).slice(0, 30) };
        }
        match.click();
        return { tag: match.tagName.toLowerCase() };
      }, wanted);
      await settle(8_000);
      return opened;
    };

    // --------------------------------------- break 1a: the panel walks away
    // "start new scan" leaves the saved test untouched on the server and puts
    // the panel on a fresh, unsaved one. Live panel, no ledger under it —
    // every finding recorded from here lands nowhere the run can find.
    await press(frame, 'start new scan');
    await settle(4_000);
    began = Date.now();
    verdict = await checkLedger({ frame, reselect, serverUrl, accessToken: token(), baseline });
    report(`break 1a — start new scan (${Date.now() - began} ms)`, verdict);
    note('break:start-new-scan', { verdict: verdict.verdict, action: verdict.action, checks: verdict.checks, panelView: verdict.panel.view, panelTestName: verdict.panel.testName });

    // ---------------------------- break 1b: the panel opens the wrong ledger
    const otherTests = await listSavedTests({ serverUrl, accessToken: token(), userId: user.id });
    const decoy = otherTests.find((t) => t.name !== testName)?.name ?? null;
    if (decoy) {
      const openedDecoy = await openSavedTest(decoy);
      began = Date.now();
      verdict = await checkLedger({ frame, reselect, serverUrl, accessToken: token(), baseline });
      report(`break 1b — a different saved test opened (${JSON.stringify(decoy)}, ${Date.now() - began} ms)`, verdict);
      note('break:wrong-test-open', { decoy, openedDecoy, verdict: verdict.verdict, action: verdict.action, checks: verdict.checks, panelView: verdict.panel.view, panelTestName: verdict.panel.testName });
    }

    // ------------------------------------------------ recovery from break 1
    let recovered = null;
    try {
      note('saved-tests view', {
        buttons: (await visibleButtons(frame)).slice(0, 40),
      });
      const opened = await openSavedTest(testName);
      began = Date.now();
      recovered = await checkLedger({ frame, reselect, serverUrl, accessToken: token(), baseline });
      report(`recovery — reopen from saved tests (${JSON.stringify(opened)}, ${Date.now() - began} ms)`, recovered);
      note('recovery:reopen', { opened, verdict: recovered.verdict, action: recovered.action, checks: recovered.checks });
    } catch (error) {
      console.log(`recovery attempt failed: ${error.message}`);
      note('recovery:reopen', { error: error.message, panel: await readPanel(frame) });
    }

    // ------------------------- break 2: the test is deleted out from under us
    // The dangerous case, staged deliberately: the panel is alive and showing
    // the run's test while the ledger behind it is gone.
    const deleted = await fetch(`${serverUrl}/api/tests/${saved.id}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token()}` },
    });
    console.log(`\ndeleted test ${saved.id}: HTTP ${deleted.status}`);
    began = Date.now();
    verdict = await checkLedger({ frame, reselect, serverUrl, accessToken: token(), baseline });
    report(`break 2 — saved test deleted server-side (${Date.now() - began} ms)`, verdict);
    note('break:test-deleted', {
      http: deleted.status,
      verdict: verdict.verdict,
      action: verdict.action,
      checks: verdict.checks,
      panelStillShowing: verdict.panel.body,
      panelStillNamesTest: verdict.panel.testName,
    });

    // -------------------------------- break 3: refresh the extension itself
    // Needs a live ledger to be interesting, so build a second one first.
    await press(frame, 'start new scan');
    await settle(4_000);
    const secondName = `Ledger check - 010 - second - ${new Date().toISOString()}`;
    const secondAfter = new Date(Date.now() - 60_000).toISOString();
    await scanAndSave(frame, secondName);
    const second = await resolveSavedTest({
      serverUrl,
      accessToken: token(),
      userId: user.id,
      name: secondName,
      createdAfter: secondAfter,
    });
    await addManualIssue(frame, MANUAL_ISSUE);
    const secondLedger = await readLedger({ serverUrl, accessToken: token(), testId: second.id });
    const secondBaseline = ledgerBaseline(secondLedger);
    console.log(`\nsecond ledger ${second.id} ${JSON.stringify(secondBaseline.issues)}`);

    began = Date.now();
    verdict = await checkLedger({ frame, reselect, serverUrl, accessToken: token(), baseline: secondBaseline });
    report(`second ledger, before the refresh (${Date.now() - began} ms)`, verdict);

    // Stamp the panel document so the reload's effect is measurable. If the
    // stamp survives, the document was never replaced and the refresh did not
    // touch the panel — which is the opposite of what CONTEXT records.
    const stamp = `ledger-probe-${Date.now()}`;
    await frame.evaluate((value) => {
      window.__ledgerProbe = value;
    }, stamp);
    const workersBefore = context.serviceWorkers().length;
    const reloadError = await worker
      .evaluate(() => chrome.runtime.reload())
      .then(() => null)
      .catch((error) => error.message);
    await settle(15_000);
    const afterReload = {
      reloadError,
      workersBefore,
      workersAfter: context.serviceWorkers().length,
      stampSurvived: await frame.evaluate(() => window.__ledgerProbe ?? null).catch((e) => `unreadable: ${e.message}`),
      expectedStamp: stamp,
      panelFrameStillAttached: dt.frames().some((f) => f.url().endsWith('/panel.html')),
    };
    console.log(`\nafter chrome.runtime.reload(): ${JSON.stringify(afterReload)}`);

    began = Date.now();
    verdict = await checkLedger({
      frame,
      reselect,
      serverUrl,
      accessToken: token(),
      baseline: secondBaseline,
    });
    report(`break 3 — extension refreshed (${Date.now() - began} ms)`, verdict);

    // Does the orphaned panel still record? This is the question the verdict
    // rests on: a panel that renders the ledger but cannot write to it is the
    // exact failure the check exists to catch.
    let stillRecords;
    try {
      await addManualIssue(frame, {
        selector: 'img#chart',
        query: 'Text alternative for the informative image is missing',
      });
      const after = await readLedger({ serverUrl, accessToken: token(), testId: second.id });
      stillRecords = { filed: true, issues: after.issues };
    } catch (error) {
      const after = await readLedger({ serverUrl, accessToken: token(), testId: second.id });
      stillRecords = { filed: false, error: error.message, issues: after.issues };
    }
    console.log(`orphaned panel can still record: ${JSON.stringify(stillRecords)}`);
    note('break:extension-refresh', {
      ...afterReload,
      verdict: verdict.verdict,
      action: verdict.action,
      checks: verdict.checks,
      stillRecords,
      serverSide: verdict.ledger ?? null,
    });

    // ---------------------------------- break 4: DevTools closed under the run
    // The panel goes with it. The findings do not: this is exactly the case the
    // panel half of the check exists to separate from the server half.
    await dt.close();
    await settle(3_000);
    began = Date.now();
    verdict = await checkLedger({
      frame,
      reselect: async () => {
        throw new Error('devtools window is gone');
      },
      serverUrl,
      accessToken: token(),
      baseline: secondBaseline,
    });
    report(`break 4 — DevTools closed (${Date.now() - began} ms)`, verdict);
    note('break:devtools-closed', {
      verdict: verdict.verdict,
      action: verdict.action,
      checks: verdict.checks,
      serverSide: verdict.ledger ?? null,
    });

    await writeFile(join(args.out, 'ledger-check.json'), JSON.stringify(transcript, null, 2));
    console.log(`\ntranscript written to ${join(args.out, 'ledger-check.json')}`);
  } finally {
    keepAlive.stop();
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
