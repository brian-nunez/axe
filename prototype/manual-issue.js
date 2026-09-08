// PROTOTYPE — throwaway. Answers ticket 009: can a manual issue be filed end to
// end from a selector alone? Delete once 011 names the tools.
//
// Scans a page, saves the test — which is what unlocks Add Manual Issue — then
// files one issue per entry in ISSUES, each identified by a CSS selector on the
// target page and a catalog query that must resolve to exactly one entry.
//
//   node prototype/manual-issue.js --extension=build/axe-extension --url=...
//   node prototype/manual-issue.js --extension=build/axe-extension --catalog
//
// `--catalog` dumps the issue catalog and files nothing; it is the data
// [Export the manual issue catalog](wayfinder/tickets/006-export-issue-catalog.md) asks for.

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsFromEnv, serverUrlFromEnv } from '../fixture/session.js';
import { launchSignedIn } from '../fixture/launch.js';
import { startSessionKeepAlive } from '../fixture/keepalive.js';

const EXTENSION_ID = 'lhdoppojpmngadmnindnejefpokejbdd';
const DEFAULT_URL = 'http://127.0.0.1:8731/';
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What to file, and against what.
 *
 * `issue` is a query into the catalog, not an identifier. The Deque instance id
 * is not unique — `2.4.4.a` names three different entries — so a skill file has
 * to carry enough of the label to single one out, and the run fails loudly if
 * the query matches anything other than exactly one entry.
 */
const ISSUES = [
  { selector: 'a#vague-link', issue: 'Link purpose not clear from link text alone' },
  { selector: 'img#chart', issue: 'Text alternative for the informative image is missing' },
];

const TEST_NAME = 'Manual issue — ticket 009';

function parseArgs(argv) {
  const args = { headless: true, url: DEFAULT_URL, out: 'build/manual-issue' };
  for (const arg of argv) {
    if (arg.startsWith('--extension=')) args.extensionPath = arg.slice(12);
    else if (arg.startsWith('--url=')) args.url = arg.slice(6);
    else if (arg.startsWith('--out=')) args.out = arg.slice(6);
    else if (arg.startsWith('--name=')) args.name = arg.slice(7);
    else if (arg === '--catalog') args.catalogOnly = true;
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
async function showPanel(dt, id) {
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

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await select();
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

/**
 * Click a panel button by its exact accessible name.
 *
 * Exact, because substring matching picks `Save Test` when asked for `Save` and
 * quietly reopens the wrong dialog. Dispatched on the element, because a real
 * pointer click is swallowed by the panel's tooltip layer without an error. And
 * filtered, because the panel keeps hidden and disabled duplicates of `Save`,
 * `Select` and `Next` in the DOM. All three cost a debugging cycle in
 * [Prototype driving the Structure IGT](wayfinder/tickets/008-drive-structure-igt.md).
 */
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

/** The issue catalog, straight out of the combobox's listbox. */
const readCatalog = (frame) =>
  frame.evaluate(() => {
    const listbox = document.querySelector('[role=listbox][id$="-listbox"]');
    if (!listbox) return null;
    return [...listbox.querySelectorAll('[role=option]')].map((option) => {
      const text = option.textContent.trim();
      const parsed = text.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      const ids = parsed ? parsed[2].split(',').map((id) => id.trim()) : [];
      return {
        label: parsed ? parsed[1] : text,
        instances: ids.filter((id) => !id.startsWith('rgaa-')),
        rgaa: ids.filter((id) => id.startsWith('rgaa-')),
        optionText: text,
      };
    });
  });

/**
 * Point the Element Selector at one element on the page, by CSS selector.
 *
 * The drawer's own selector search is the whole reason this is deterministic:
 * it expands the tree to the match wherever it is nested, and unlike the IGT
 * picker screens the `Select` button here genuinely commits the choice.
 */
async function selectElement(frame, selector) {
  const drawerOpen = await frame
    .locator('[role=treeitem]')
    .first()
    .evaluate((el) => el.getBoundingClientRect().width > 0)
    .catch(() => false);
  // Acting on the tree while the drawer is collapsed fails the way everything
  // does when the panel lacks layout: the nodes are there, sized 0x0.
  if (!drawerOpen) await press(frame, 'View element selector');

  const search = frame.locator('input[type=search]');
  if ((await search.count()) === 0) {
    await frame.locator('button[aria-controls="css-search-bar"]').first().click();
    await settle(1_500);
  }
  await frame.locator('input[type=search]').first().fill(selector);
  await frame.locator('input[type=search]').first().press('Enter');
  await settle(2_500);

  const hits = await frame.evaluate(
    () => document.body.innerText.match(/(\d+)\s+of\s+(\d+)/)?.slice(1, 3) ?? null,
  );
  if (!hits) throw new Error(`selector search reported no result for ${selector}`);

  await press(frame, 'Select');

  // The form prints the committed element as markup between its own two
  // headings; there is no container element that wraps just that region.
  const chosen = await frame.evaluate(() => {
    const text = document.body.innerText;
    const from = text.indexOf('Selected Element');
    const to = text.indexOf('Element Selector', from + 1);
    if (from < 0 || to < 0) return null;
    return text.slice(from, to).match(/<[a-zA-Z][^>]*>/)?.[0] ?? null;
  });
  if (!chosen) {
    const region = await frame.evaluate(() => {
      const text = document.body.innerText;
      const from = text.indexOf('Selected Element');
      return text.slice(from, from + 400);
    });
    throw new Error(`Select did not commit ${selector}; region reads:\n${region}`);
  }
  return { chosen, matches: Number(hits[1]) };
}

/**
 * File one manual issue against one element.
 *
 * This is the shape `add_manual_issue(selector, issue)` takes in the tool layer:
 * two strings in, a verified issue in the saved test out.
 */
async function addManualIssue(frame, { selector, issue }) {
  await press(frame, 'Add Manual Issue');

  const combobox = frame.locator('input[role=combobox]').first();
  await combobox.click();
  await combobox.pressSequentially(issue, { delay: 40 });
  await settle(2_000);

  const options = await frame.evaluate(() =>
    [...document.querySelectorAll('[role=listbox] [role=option]')]
      .filter((o) => o.getBoundingClientRect().width > 0)
      .map((o) => o.textContent.trim()),
  );
  if (options.length !== 1) {
    throw new Error(
      `catalog query ${JSON.stringify(issue)} matched ${options.length} entries: ${options.join(' | ')}`,
    );
  }
  await frame.evaluate(() =>
    [...document.querySelectorAll('[role=listbox] [role=option]')]
      .find((o) => o.getBoundingClientRect().width > 0)
      .click(),
  );
  await settle(1_500);

  const { chosen, matches } = await selectElement(frame, selector);
  await press(frame, 'Save');
  await settle(5_000);

  const landed = await frame.evaluate((wanted) => {
    const text = document.body.innerText;
    return {
      confirmed: /Manual issue successfully created/i.test(text),
      manualIssues: Number(text.match(/Manual Issues\s*\n\s*(\d+)/)?.[1] ?? -1),
      listed: text.includes(wanted),
    };
  }, options[0].replace(/\s*\([^)]*\)\s*$/, ''));
  if (!landed.confirmed || !landed.listed) {
    throw new Error(`issue ${JSON.stringify(issue)} did not land: ${JSON.stringify(landed)}`);
  }
  return { selector, issue: options[0], element: chosen, matches, ...landed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userDataDir = await mkdtemp(join(tmpdir(), 'axe-manual-'));
  await mkdir(args.out, { recursive: true });

  const { context, worker, ssoConfig, session } = await launchSignedIn({
    extensionPath: args.extensionPath,
    userDataDir,
    serverUrl: serverUrlFromEnv(),
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
    const frame = await showPanel(dt, axeTab);
    console.log(`onboarding: ${JSON.stringify(await clearOnboarding(frame))}`);

    await press(frame, 'Scan full page');
    await settle(12_000);
    const scanned = await frame.evaluate(
      () => document.body.innerText.match(/TOTAL ISSUES\s*\n\s*(\d+)/)?.[1] ?? '?',
    );
    console.log(`scan: ${scanned} issues`);

    // Add Manual Issue is aria-disabled until the test has been saved; the
    // manual issue has to attach to something that already exists server-side.
    await press(frame, 'Save Test');
    await frame.locator('[role=dialog] input').first().fill(args.name ?? TEST_NAME);
    await settle(1_000);
    await press(frame, 'Save', { within: '[role=dialog]' });
    await settle(8_000);
    console.log(`saved test: ${JSON.stringify(args.name ?? TEST_NAME)}`);

    if (args.catalogOnly) {
      await press(frame, 'Add Manual Issue');
      const catalog = await readCatalog(frame);
      const file = join(args.out, 'catalog.json');
      await writeFile(file, JSON.stringify(catalog, null, 2));
      const criteria = new Set(
        catalog.flatMap((e) => e.instances).map((i) => i.replace(/\.[a-z]+$/, '')),
      );
      console.log(`catalog: ${catalog.length} entries, ${criteria.size} success criteria → ${file}`);
      return;
    }

    const filed = [];
    for (const wanted of ISSUES) {
      const result = await addManualIssue(frame, wanted);
      filed.push(result);
      console.log(`filed  ${result.element}  ←  ${result.issue}`);
      console.log(`       manual issues now ${result.manualIssues}`);
    }

    const summary = await frame.evaluate(() =>
      document.body.innerText.replace(/\n{3,}/g, '\n\n').trim().slice(0, 1200),
    );
    await writeFile(join(args.out, 'filed.json'), JSON.stringify({ filed, summary }, null, 2));
    await dt.screenshot({ path: join(args.out, 'filed.png') });
    console.log(`\n${summary}`);
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
