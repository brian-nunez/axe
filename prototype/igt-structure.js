// PROTOTYPE — throwaway. Answers ticket 008: what does stepping an IGT to
// completion actually take? Delete once 011 names the tools.
//
// Drives the Structure IGT from the home view to a saved test, without
// supervision. Every judgement it makes comes from ANSWERS below, keyed by the
// question's radio-group name — the panel's own machine-readable question id.
// That keying is the point: a skill file is an answer sheet, and the driver is
// a loop that reads a screen, looks up an answer, and advances.
//
//   node prototype/igt-structure.js --extension=build/axe-extension --url=...

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsFromEnv, serverUrlFromEnv } from '../fixture/session.js';
import { launchSignedIn } from '../fixture/launch.js';
import { startSessionKeepAlive } from '../fixture/keepalive.js';

const EXTENSION_ID = 'lhdoppojpmngadmnindnejefpokejbdd';
const DEFAULT_URL = 'http://127.0.0.1:8731/';
const MAX_SCREENS = 40;
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The answer sheet, keyed by the panel's own question id.
 *
 * `choice` answers a single-choice question. `select` names CSS selectors on
 * the target page for the element-picker screen that a "yes" opens up. A
 * question absent from this sheet stops the run rather than guessing.
 */
const ANSWERS = {
  'mispurposed-headings': { choice: 'no' },
  'missing-headings': { choice: 'no' },
  'list-misuse': { choice: 'no' },
  'missing-lists': { choice: 'yes', select: ['p.fake-list'] },
  'missing-langs': { choice: 'no' },
  'validate-document-title': { choice: 'yes' },
};

/** Per-element screens answer uniformly; a real skill file would judge each. */
const PER_ELEMENT_DEFAULT = 'yes';
const TEST_NAME = 'Structure IGT — ticket 008';

function parseArgs(argv) {
  const args = { headless: true, url: DEFAULT_URL, out: 'build/igt' };
  for (const arg of argv) {
    if (arg.startsWith('--extension=')) args.extensionPath = arg.slice(12);
    else if (arg.startsWith('--url=')) args.url = arg.slice(6);
    else if (arg.startsWith('--out=')) args.out = arg.slice(6);
    else if (arg.startsWith('--name=')) args.name = arg.slice(7);
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
 * Classify the screen and pull out everything an answer needs.
 *
 * The kinds are distinguishable without any hashed class name: a picker owns
 * the "Fields selected" counter, a multi-select owns `selection-*` checkboxes,
 * a per-element grid owns `yes-no-*` radio groups, and a single-choice question
 * owns `#yes-igt-radio`. Order matters — the results screen also carries a
 * tree, and the save dialog sits on top of the results screen.
 */
const readScreen = (frame) =>
  frame.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const named = (text) =>
      buttons.some((b) => (b.getAttribute('aria-label') ?? b.textContent).trim() === text);

    const step =
      [...document.querySelectorAll('button[aria-current=step]')]
        .map((b) => b.textContent.trim())
        .find(Boolean) ?? null;
    const question = document.getElementById('question-text')?.textContent.trim() ?? null;

    const dialog = [...document.querySelectorAll('[role=dialog]')].find(visible);
    if (dialog && dialog.querySelector('input')) return { kind: 'save-dialog', step, question };

    if (document.querySelector('h2,h3,h4') && named('Finish')) {
      const issues = [...document.querySelectorAll('li,tr')]
        .map((el) => el.textContent.trim())
        .filter((t) => /^\d+\s*\S/.test(t) && t.length < 300);
      return {
        kind: 'results',
        step,
        question,
        summary: document.body.innerText.replace(/\n{3,}/g, '\n\n').trim(),
        issues,
      };
    }

    if (/Fields selected:/.test(document.body.innerText)) {
      return {
        kind: 'element-picker',
        step,
        question,
        selected: Number(document.body.innerText.match(/Fields selected:\s*(\d+)/)?.[1] ?? 0),
        mouseSelection:
          document.querySelector('[role=switch][aria-label="Mouse Selection"]')?.getAttribute('aria-checked') ===
          'true',
      };
    }

    const multi = [...document.querySelectorAll('[role=checkbox][id^=selection-]')];
    if (multi.length) {
      return {
        kind: 'element-multiselect',
        step,
        question,
        options: multi.map((el) => ({ id: el.id, text: el.textContent.trim() })),
      };
    }

    const grid = [...document.querySelectorAll('input[type=radio]')].filter((el) =>
      /^(thumbnail-)?yes-no-/.test(el.getAttribute('name') ?? ''),
    );
    if (grid.length) {
      return {
        kind: 'per-element',
        step,
        question,
        groups: [...new Set(grid.map((el) => el.getAttribute('name')))],
      };
    }

    const single = document.getElementById('yes-igt-radio');
    if (single) {
      return {
        kind: 'single-choice',
        step,
        question,
        key: single.getAttribute('name'),
        options: [...document.querySelectorAll('#yes-igt-radio,#no-igt-radio')].map((el) => ({
          id: el.id,
          label:
            document.querySelector(`label[for="${el.id}"]`)?.textContent.trim() ?? el.value,
          checked: el.checked,
        })),
      };
    }

    return { kind: 'unknown', step, question, text: document.body.innerText.slice(0, 800) };
  });

/**
 * Pick elements on the target page for a picker screen.
 *
 * The Element Selector drawer looks like the keyboard path, but its Select
 * button never enables from tree navigation — the panel takes its answer from
 * clicks on the inspected page, with Mouse Selection armed. A CSS selector
 * still drives it: Playwright resolves the selector and clicks the element, so
 * nothing here depends on coordinates.
 */
async function pickElements(frame, page, selectors) {
  const toggle = frame.locator('[role=switch][aria-label="Mouse Selection"]');
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();

  // The picker keeps per-element state that ignores a re-click of something it
  // has just dropped; clearing first makes the sequence reproducible.
  const clear = frame.locator('button:has-text("Remove all selections")');
  if (await clear.isEnabled().catch(() => false)) {
    await clear.click();
    await settle(2_000);
  }

  for (const selector of selectors) {
    await page.locator(selector).first().click();
    await settle(2_500);
  }

  const { selected } = await readScreen(frame);
  if (selected !== selectors.length) {
    throw new Error(`picker took ${selected} of ${selectors.length} elements: ${selectors.join(', ')}`);
  }
  return selected;
}

/**
 * Click a panel button by its exact name.
 *
 * Two things bite here. The panel keeps hidden and disabled copies of its
 * controls in the DOM, so an unfiltered match picks one of those and the run
 * stalls on the same screen. And a real pointer click gets intercepted by the
 * panel's own tooltip layer, which swallows the press without an error — so
 * dispatch the click on the element itself, after filtering to what is
 * genuinely actionable.
 */
const press = async (frame, label) => {
  const outcome = await frame.evaluate((wanted) => {
    const name = (el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
    const match = [...document.querySelectorAll('button')]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true')
      .find((b) => name(b) === wanted);
    if (!match) return null;
    match.click();
    return wanted;
  }, label);
  if (!outcome) throw new Error(`no visible, enabled button named ${JSON.stringify(label)}`);
  await settle(5_000);
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userDataDir = await mkdtemp(join(tmpdir(), 'axe-igt-'));
  await mkdir(args.out, { recursive: true });
  const transcript = [];

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

    await press(frame, 'Structure');

    // Automated IGT arrives ticked and spends AI credits; it is outside the
    // licence this project is built against.
    const aiAssist = frame.locator('#enableAiAssist');
    if (await aiAssist.isChecked()) {
      await aiAssist.uncheck();
      console.log('automated IGT: unticked');
    }

    await press(frame, 'Start');
    await settle(9_000);

    let lastKey = null;
    for (let i = 0; i < MAX_SCREENS; i += 1) {
      const screen = await readScreen(frame);
      transcript.push(screen);
      console.log(`step ${screen.step ?? '-'}  ${screen.kind}  ${screen.question ?? ''}`);

      if (screen.kind === 'results') {
        console.log(`\n${screen.summary}\n`);
        await press(frame, 'Finish');
        continue;
      }

      if (screen.kind === 'save-dialog') {
        const dialog = frame.locator('[role=dialog]');
        await dialog.locator('input').first().fill(args.name ?? TEST_NAME);
        await press(frame, 'Save');
        await settle(9_000);
        console.log(`saved as ${JSON.stringify(args.name ?? TEST_NAME)}`);
        break;
      }

      if (screen.kind === 'single-choice') {
        lastKey = screen.key;
        const answer = ANSWERS[screen.key];
        if (!answer) throw new Error(`no answer for question ${JSON.stringify(screen.key)}`);
        await frame.locator(answer.choice === 'yes' ? '#yes-igt-radio' : '#no-igt-radio').click();
        await settle(1_000);
        await settle(1_500);
        console.log(`  ${screen.key} := ${answer.choice}`);
        await press(frame, 'Next');
        continue;
      }

      if (screen.kind === 'element-picker') {
        // A picker always follows the question that opened it, so the answer
        // sheet entry for the last question asked is the one that names the
        // elements to click.
        const selectors = ANSWERS[lastKey]?.select;
        if (!selectors) {
          throw new Error(`picker after ${JSON.stringify(lastKey)} names no selectors`);
        }
        console.log(`  picking ${selectors.join(', ')}`);
        await pickElements(frame, page, selectors);
        await press(frame, 'Next');
        continue;
      }

      if (screen.kind === 'element-multiselect') {
        console.log(`  offering ${screen.options.map((o) => o.text).join(' | ')}`);
        await press(frame, 'Next');
        continue;
      }

      if (screen.kind === 'per-element') {
        for (const group of screen.groups) {
          await frame
            .locator(`input[name="${group}"][id^="${PER_ELEMENT_DEFAULT === 'yes' ? 'true' : 'false'}-"]`)
            .click();
          await settle(800);
        }
        console.log(`  ${screen.groups.length} element(s) := ${PER_ELEMENT_DEFAULT}`);
        await press(frame, 'Next');
        continue;
      }

      throw new Error(`unrecognised screen:\n${screen.text}`);
    }

    const final = await frame.evaluate(() => document.body.innerText.replace(/\n{3,}/g, '\n\n').trim());
    await writeFile(join(args.out, 'transcript.json'), JSON.stringify({ transcript, final }, null, 2));
    await dt.screenshot({ path: join(args.out, 'completed.png') });
    console.log(`\n${final}`);
    console.log(`\ntranscript written to ${join(args.out, 'transcript.json')}`);
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
