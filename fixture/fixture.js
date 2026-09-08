/**
 * The fixture: one long-lived object that owns the browser for the life of a run.
 *
 * CONTEXT's contract is that the agent's job starts at *read the panel*. This is
 * what makes that true. On `start()` it launches Chromium with the unpacked
 * extension, seeds a minted session, opens the target page, selects the panel
 * and holds it through the layout race, clears the onboarding chain, runs the
 * full-page scan, **saves the test** — Add Manual Issue stays aria-disabled
 * until the test exists server-side — resolves the saved test's id, takes the
 * ledger baseline, and starts the keepalive timer. Only then does anything
 * serve tools.
 *
 * The panel frame handle, the keepalive timer and the selection re-assertion all
 * need the same object, which is why the MCP server is the fixture rather than a
 * client of one.
 */

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launchSignedIn } from './launch.js';
import { credentialsFromEnv, serverUrlFromEnv } from './session.js';
import { startSessionKeepAlive } from './keepalive.js';
import { ledgerBaseline, readLedger, resolveSavedTest } from './ledger.js';
import {
  clearOnboarding,
  findPanelTab,
  has,
  press,
  readScreen,
  selectPanel,
  settle,
} from './panel.js';

const SCAN_SETTLE_MS = 12_000;
// How long the scan total is waited for beyond that settle, and how often it is
// re-read while waiting.
const SCAN_POLL_MS = 90_000;
const SCAN_POLL_STEP_MS = 3_000;
const SAVE_SETTLE_MS = 8_000;
// The save round-trips to the server before the panel enables filing.
const SAVE_POLL_MS = 60_000;

export class Fixture {
  constructor(state) {
    Object.assign(this, state);
  }

  /** The token the keepalive currently holds; it rotates under a long run. */
  get accessToken() {
    return this.keepAlive.session.access_token;
  }

  get userId() {
    return this.user.id;
  }

  /**
   * Re-assert panel selection and hand back the live frame.
   *
   * Passed to `checkLedger` as its `reselect` callback, which is what spends the
   * one bounded re-selection attempt the loss policy allows — so the graph gives
   * `panel-hidden` no second attempt of its own.
   */
  async reselect() {
    this.frame = await selectPanel(this.dt, this.tabId, { timeoutMs: 30_000 });
    return { frame: this.frame };
  }

  /** The fixture's own viewport, which `restore_page` resets the page to. */
  get viewport() {
    return this.fixtureViewport;
  }

  async close() {
    this.keepAlive.stop();
    await this.context.close().catch(() => {});
    if (this.ephemeralProfile) {
      await rm(this.userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  static async start({
    extensionPath,
    url,
    testName,
    headless = true,
    userDataDir = null,
    serverUrl = serverUrlFromEnv(),
    credentials = credentialsFromEnv(),
    log = () => {},
  }) {
    const profile = userDataDir ?? (await mkdtemp(join(tmpdir(), 'axe-fixture-')));
    const ephemeralProfile = !userDataDir;

    const { context, worker, ssoConfig, session, user } = await launchSignedIn({
      extensionPath,
      userDataDir: profile,
      serverUrl,
      credentials,
      headless,
      openDevtools: true,
    });
    log(`signed in as ${user.email ?? user.id} against ${new URL(serverUrl).host}`);

    const keepAlive = startSessionKeepAlive({
      worker,
      ssoConfig,
      session,
      onError: (error) => log(`keepalive: ${error.message}`),
    });

    try {
      const page = context.pages().find((p) => !p.url().startsWith('devtools://'));
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const fixtureViewport = page.viewportSize();
      log(`target ${url} at ${fixtureViewport.width}x${fixtureViewport.height}`);

      const { dt, tabId } = await findPanelTab(context);
      const frame = await selectPanel(dt, tabId);
      const cleared = await clearOnboarding(frame);
      log(`onboarding cleared: ${cleared.length ? cleared.join(', ') : 'none shown'}`);

      // The scan is timed by the page, not by us: a heavier page state takes
      // longer, and a fixed settle that reads once turns that into a run that
      // never starts. So the total is polled for until it renders, and the
      // settle becomes the floor rather than the whole budget.
      await press(frame, 'Scan full page', { settleMs: SCAN_SETTLE_MS });
      const readTotal = () =>
        frame
          .evaluate(() => document.body.innerText.match(/TOTAL ISSUES\s*\n\s*(\d+)/)?.[1] ?? null)
          .catch(() => null);
      let scanned = await readTotal();
      for (let waited = 0; scanned === null && waited < SCAN_POLL_MS; waited += SCAN_POLL_STEP_MS) {
        await settle(SCAN_POLL_STEP_MS);
        scanned = await readTotal();
      }
      if (scanned === null) throw new Error('the full-page scan produced no issue total');
      log(`scan complete: ${scanned} issues`);

      // Saving is not tidiness. Add Manual Issue is aria-disabled until the test
      // exists server-side, so a fixture that scans without saving hands over a
      // panel that cannot file anything.
      const savedAfter = new Date(Date.now() - 60_000).toISOString();
      await press(frame, 'Save Test', { settleMs: 3_000 });
      await frame.locator('[role=dialog] input').first().fill(testName);
      await settle(1_000);
      await press(frame, 'Save', { within: '[role=dialog]', settleMs: SAVE_SETTLE_MS });
      // Polled for the same reason the scan total is: the save round-trips to the
      // server, and *Add Manual Issue* enabling is the panel catching up with it.
      // A single read after a fixed settle turns a slow answer into a run that
      // never starts.
      let filable = await has(frame, 'Add Manual Issue').catch(() => false);
      for (let waited = 0; !filable && waited < SAVE_POLL_MS; waited += SCAN_POLL_STEP_MS) {
        await settle(SCAN_POLL_STEP_MS);
        filable = await has(frame, 'Add Manual Issue').catch(() => false);
      }
      if (!filable) {
        throw new Error('the test did not save: Add Manual Issue is still disabled');
      }

      const saved = await resolveSavedTest({
        serverUrl,
        accessToken: keepAlive.session.access_token,
        userId: user.id,
        name: testName,
        createdAfter: savedAfter,
      });
      const ledger = await readLedger({
        serverUrl,
        accessToken: keepAlive.session.access_token,
        testId: saved.id,
      });
      const baseline = ledgerBaseline(ledger);
      log(`saved test ${saved.id} (${JSON.stringify(testName)}), baseline ${JSON.stringify(baseline.issues)}`);

      return new Fixture({
        context,
        worker,
        page,
        dt,
        tabId,
        frame,
        keepAlive,
        ssoConfig,
        user,
        serverUrl,
        url,
        testId: saved.id,
        testName,
        baseline,
        fixtureViewport,
        userDataDir: profile,
        ephemeralProfile,
        refs: new Map(),
        refCounter: 0,
        log,
      });
    } catch (error) {
      keepAlive.stop();
      await context.close().catch(() => {});
      if (ephemeralProfile) await rm(profile, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}

/** What the graph is told about the fixture at startup, and nothing more. */
export const describeFixture = (fixture) => ({
  testId: fixture.testId,
  testName: fixture.testName,
  url: fixture.url,
  viewport: fixture.fixtureViewport,
  serverUrl: fixture.serverUrl,
  userId: fixture.userId,
  baseline: fixture.baseline,
});

export { readScreen };
