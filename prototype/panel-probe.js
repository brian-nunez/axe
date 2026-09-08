// PROTOTYPE — throwaway. Answers ticket 007: can the panel's state be read
// from its DOM reliably enough to act on? Delete once 011 names the tools.
//
//   node prototype/panel-probe.js --extension=build/axe-extension [--url=...] [--headed]

// Must be set before Chromium attaches: without it Playwright detaches from
// every devtools:// target and ctx.pages() never shows the DevTools window.
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsFromEnv, serverUrlFromEnv } from '../fixture/session.js';
import { launchSignedIn } from '../fixture/launch.js';

const EXTENSION_ID = 'lhdoppojpmngadmnindnejefpokejbdd';
const DEFAULT_URL = 'https://www.w3.org/WAI/demos/bad/before/home.html';
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { headless: true, url: DEFAULT_URL };
  for (const arg of argv) {
    if (arg.startsWith('--extension=')) args.extensionPath = arg.slice(12);
    else if (arg.startsWith('--url=')) args.url = arg.slice(6);
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

/** The panel iframe as the DevTools document sees it; it lives in shadow DOM. */
const panelIframeBox = (dt) =>
  dt.evaluate(() => {
    const walk = (root, out = []) => {
      for (const el of root.querySelectorAll('iframe')) out.push(el);
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot, out);
      return out;
    };
    const frame = walk(document).find((f) => (f.getAttribute('src') ?? '').endsWith('panel.html'));
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height) };
  });

/**
 * Select the extension panel and return its frame, once it truly has layout.
 *
 * Three things have to line up, and only the last one is a reliable signal:
 *   - showView(id) creates the panel target but leaves the tab unselected
 *   - selectTab activates it, but not always on the first call while the
 *     panel is still initialising
 *   - the iframe can report a box while the panel's own document is still
 *     0x0, and in that state every Playwright action fails as "not visible"
 *
 * So poll the panel document's own body box, re-selecting until it lands.
 */
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
    return box && box.w > 0 && box.h > 0 ? { frame, ...box } : null;
  };

  const deadline = Date.now() + 90_000;
  let attempts = 0;
  while (Date.now() < deadline) {
    await select();
    attempts += 1;
    for (let i = 0; i < 10; i += 1) {
      await settle(500);
      const laid = await bodyBox();
      if (!laid) continue;
      // DevTools can steal the selection back while it finishes starting up,
      // so require the layout to still be there a beat later.
      await settle(2_500);
      const still = await bodyBox();
      if (still) return { ...still, attempts };
      break;
    }
  }
  throw new Error('panel never held layout');
}

/** Re-assert selection before acting; a stolen tab makes every action fail. */
async function ensurePanel(dt, id, frame) {
  const ok = await frame
    .evaluate(() => document.body.getBoundingClientRect().width > 0)
    .catch(() => false);
  if (ok) return false;
  await showPanel(dt, id);
  return true;
}

/**
 * What a tool layer would need to identify the current view and act on it.
 *
 * Counts hooks by kind rather than scraping content: the judgment this ticket
 * turns on is whether stable hooks exist at all.
 */
const survey = (frame, label) =>
  frame.evaluate((viewLabel) => {
    const all = [...document.querySelectorAll('*')];
    const distinct = (selector, attr) =>
      [...new Set([...document.querySelectorAll(selector)].map((el) => el.getAttribute(attr)))]
        .filter(Boolean)
        .sort();

    const classes = new Set();
    for (const el of all) for (const c of el.classList) classes.add(c);
    const classList = [...classes];
    // Hashed CSS-module names are the brittleness tell: nothing to anchor on.
    const hashed = classList.filter((c) => /(^|[_-])[a-z0-9]{5,}$/i.test(c) && /\d/.test(c));

    const named = (selector) =>
      [...document.querySelectorAll(selector)]
        .map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim())
        .filter(Boolean);

    return {
      view: viewLabel,
      elements: all.length,
      testIds: distinct('[data-testid]', 'data-testid'),
      dataAttrs: [
        ...new Set(all.flatMap((el) => [...el.attributes].map((a) => a.name)))
      ].filter((n) => n.startsWith('data-')).sort(),
      roles: distinct('[role]', 'role'),
      landmarks: [...document.querySelectorAll('h1,h2,h3,h4,[role=heading]')].map((h) =>
        h.textContent.trim(),
      ),
      buttons: named('button'),
      links: named('a').slice(0, 25),
      inputs: [...document.querySelectorAll('input,select,textarea')].map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        name: el.getAttribute('aria-label') ?? el.getAttribute('name') ?? el.id ?? null,
      })),
      hashedClassRatio: classList.length ? +(hashed.length / classList.length).toFixed(2) : 0,
      text: document.body.innerText.replace(/\n{2,}/g, '\n').trim().slice(0, 2000),
    };
  }, label);

/**
 * Which locator strategies actually resolve inside the panel frame?
 *
 * The tool layer has to pick one, so measure rather than assume: an
 * aria-hidden ancestor removes a node from the accessibility tree and
 * getByRole stops seeing it, while CSS and text locators still do.
 */
async function locatorStrategies(frame, name) {
  const count = async (locator) => {
    try {
      return await locator.count();
    } catch {
      return 'error';
    }
  };
  return {
    'querySelectorAll(button)': await frame.evaluate(
      (n) => [...document.querySelectorAll('button')]
        .filter((b) => b.textContent.trim().toLowerCase().includes(n)).length,
      name.toLowerCase(),
    ),
    'getByRole(button,name)': await count(frame.getByRole('button', { name: new RegExp(name, 'i') })),
    'getByText': await count(frame.getByText(new RegExp(name, 'i'))),
    'locator(button:has-text)': await count(frame.locator(`button:has-text("${name}")`)),
  };
}

/** Does the panel frame have layout? Playwright actionability needs a box. */
const measureLayout = (frame) =>
  frame.evaluate(() => {
    const box = document.body.getBoundingClientRect();
    const button = document.querySelector('button');
    const bbox = button?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      body: { width: Math.round(box.width), height: Math.round(box.height) },
      firstButton: bbox ? { width: Math.round(bbox.width), height: Math.round(bbox.height) } : null,
    };
  });

/**
 * Drive React-controlled inputs from the DOM.
 *
 * React installs its own value setter on the element prototype and ignores a
 * plain assignment, so write through the native setter and then dispatch the
 * events React listens for. Needed because Playwright's own actions require
 * layout the DevTools frame does not have when headless.
 */
const domInteract = (frame) =>
  frame.evaluate(() => {
    const log = [];
    const setNative = (el, value) => {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, el.type === 'checkbox' ? 'checked' : 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const select = document.querySelector('select');
    if (select) {
      // The placeholder carries a real value ("unselected"), so skip by label.
      const option = [...select.options].find(
        (o) => o.value && !/^(unselected|)$/i.test(o.value) && !/please select/i.test(o.textContent),
      );
      if (option) {
        setNative(select, option.value);
        log.push(`select := ${option.value}`);
      } else {
        log.push(`select: no usable option in ${JSON.stringify([...select.options].map((o) => o.value))}`);
      }
    }
    for (const box of document.querySelectorAll('input[type=checkbox]')) {
      if (box.id === 'terms-and-services-checkbox' || /terms/i.test(box.id)) {
        setNative(box, true);
        log.push(`${box.id} := true`);
      }
    }
    return log;
  });

const OPEN_DIALOG = '[role=dialog].Dialog--show';

/**
 * Clear the onboarding dialogs.
 *
 * The extension shows a chain of them on a fresh profile — a role/terms form,
 * then informational modals — and each one intercepts pointer events for the
 * whole panel until dismissed.
 */
async function clearDialogs(frame, max = 6) {
  const cleared = [];
  for (let i = 0; i < max; i += 1) {
    const dialog = frame.locator(OPEN_DIALOG).first();
    if ((await dialog.count()) === 0) break;

    const title = (await dialog.locator('h1,h2,h3,[id^=dialog-title]').first().textContent()
      .catch(() => null))?.trim() ?? '(untitled)';

    // The role/terms form gates its own submit button.
    const role = dialog.locator('select#user-job-role');
    if (await role.count()) {
      await role.selectOption('Developer');
      await dialog.locator('#terms-and-services-checkbox').check();
    }

    const action = dialog.locator(
      'button:has-text("Start using axe DevTools"), button:has-text("Got it"), ' +
      'button:has-text("Continue"), button:has-text("Close"), button:has-text("Dismiss"), ' +
      'button:has-text("OK")',
    ).first();

    if (await action.count()) {
      await action.click();
    } else {
      await frame.press('body', 'Escape').catch(() => {});
    }
    await settle(2_000);
    cleared.push(title);
  }
  return cleared;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userDataDir = await mkdtemp(join(tmpdir(), 'axe-probe-'));
  const surveys = [];

  const { context } = await launchSignedIn({
    extensionPath: args.extensionPath,
    userDataDir,
    serverUrl: serverUrlFromEnv(),
    credentials: credentialsFromEnv(),
    headless: args.headless,
    openDevtools: true,
  });

  try {
    const target = context.pages().find((p) => !p.url().startsWith('devtools://'));
    await target.goto(args.url, { waitUntil: 'domcontentloaded' });

    const dt = await poll(
      () => context.pages().find((p) => p.url().startsWith('devtools://')),
      { what: 'a devtools:// page' },
    );

    // The extension's devtools_page calls panels.create() asynchronously.
    const axeTab = await poll(
      async () => (await listTabIds(dt)).find((id) => id.includes(EXTENSION_ID)),
      { what: 'the axe panel to register' },
    );
    const { frame, w, h, attempts } = await showPanel(dt, axeTab);
    console.log(`panel body ${w}x${h} after ${attempts} selectTab call(s)`);
    await settle(2_000);

    console.log('\nlocator strategies, first-run modal button:');
    console.log(JSON.stringify(await locatorStrategies(frame, 'Start using axe DevTools'), null, 2));
    console.log('locator strategies, "Structure" behind the modal:');
    console.log(JSON.stringify(await locatorStrategies(frame, 'Structure'), null, 2));

    console.log(`\nlayout     ${JSON.stringify(await measureLayout(frame))}`);
    console.log(`re-assert  ${(await ensurePanel(dt, axeTab, frame)) ? 'was stolen, re-selected' : 'held'}`);
    console.log(`dialogs    cleared ${JSON.stringify(await clearDialogs(frame))}`);
    surveys.push(await survey(frame, 'home'));

    console.log('locator strategies, "Structure" after the modal:');
    console.log(JSON.stringify(await locatorStrategies(frame, 'Structure'), null, 2));

    // Open one IGT — the shape ticket 008 will drive.
    const structure = frame.locator('button:has-text("Structure")').first();
    if (await structure.count()) {
      await structure.click();
      await settle(6_000);
      surveys.push(await survey(frame, 'igt:structure'));

      // Only visible controls are actionable; the panel keeps many hidden.
      const visibleButtons = await frame.evaluate(() =>
        [...document.querySelectorAll('button')]
          .filter((b) => b.getBoundingClientRect().width > 0 && !b.disabled)
          .map((b) => (b.getAttribute('aria-label') ?? b.textContent).trim())
          .filter(Boolean),
      );
      console.log(`igt actions ${JSON.stringify(visibleButtons)}`);

      // Step once, to see whether a question view is readable.
      const step = frame.locator('button').filter({ hasText: /^(Next|Start test|Begin)$/ }).first();
      if (await step.count()) {
        await step.click();
        await settle(5_000);
        surveys.push(await survey(frame, 'igt:structure:step2'));
      }
    }

    await writeFile('build/panel-survey.json', JSON.stringify(surveys, null, 2));

    for (const s of surveys) {
      console.log(`\n${'='.repeat(60)}\nVIEW  ${s.view}`);
      console.log(`elements ${s.elements}   testIds ${s.testIds.length}   ` +
        `roles ${s.roles.length}   hashed-classes ${(s.hashedClassRatio * 100).toFixed(0)}%`);
      console.log(`data-*   ${JSON.stringify(s.dataAttrs)}`);
      console.log(`roles    ${JSON.stringify(s.roles)}`);
      console.log(`headings ${JSON.stringify(s.landmarks)}`);
      console.log(`buttons  ${JSON.stringify(s.buttons.slice(0, 25))}`);
      console.log(`inputs   ${JSON.stringify(s.inputs.slice(0, 15))}`);
      console.log(`\n--- text ---\n${s.text}`);
    }
    console.log('\nfull survey written to build/panel-survey.json');
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
