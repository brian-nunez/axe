// PROTOTYPE — throwaway. Answers ticket 017: what page state changes does an
// in-progress IGT survive? Delete once 011 names the tools.
//
// One browser, one saved test carrying a filed manual issue, and one trial per
// perturbation. Each trial takes a Structure IGT two screens in, does one thing
// to the page, and then reads three answers:
//
//   is the in-progress IGT still there?
//   can it still advance, or does the guard fire late?
//   is the saved test in the ledger untouched?
//
// The third is read from the server rather than the panel, so a perturbation
// that costs the panel its view does not also cost us the measurement.
//
//   node prototype/page-state-probe.js --extension=build/axe-extension

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsFromEnv, serverUrlFromEnv } from '../fixture/session.js';
import { launchSignedIn } from '../fixture/launch.js';
import { startSessionKeepAlive } from '../fixture/keepalive.js';
import { ledgerBaseline, readLedger, readPanel, resolveSavedTest } from '../fixture/ledger.js';

const EXTENSION_ID = 'lhdoppojpmngadmnindnejefpokejbdd';
const BASE_URL = 'http://127.0.0.1:8731/';
const SAME_ORIGIN_URL = 'http://127.0.0.1:8731/other.html';
const OTHER_ORIGIN_SAME_PORT = 'http://localhost:8731/';
const CROSS_ORIGIN_URL = 'http://localhost:8732/';
// 8731 and 8732 serve the same directory, so those two trials change the URL
// and nothing else. These two separate the URL from the content: same origin
// with the same headings, and a different origin with different ones.
const SAME_ORIGIN_SAME_CONTENT = 'http://127.0.0.1:8731/copy.html';
const CROSS_ORIGIN_DIFFERENT_CONTENT = 'http://localhost:8733/';
const MANUAL_ISSUE = {
  selector: 'a#vague-link',
  query: 'Link purpose not clear from link text alone',
};

// WCAG 1.4.12, the values the text-spacing bookmarklet applies. Page state test
// 9 requires this at every breakpoint.
const TEXT_SPACING_CSS = `
  * {
    line-height: 1.5 !important;
    letter-spacing: 0.12em !important;
    word-spacing: 0.16em !important;
  }
  p, li, h1, h2, h3, h4 { margin-bottom: 2em !important; }
`;

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { headless: true, out: 'build/page-state', only: null };
  for (const arg of argv) {
    if (arg.startsWith('--extension=')) args.extensionPath = arg.slice(12);
    else if (arg.startsWith('--out=')) args.out = arg.slice(6);
    else if (arg.startsWith('--only=')) args.only = arg.slice(7).split(',');
    else if (arg === '--dump') args.dump = true;
    else if (arg === '--no-ledger') args.noLedger = true;
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
      await settle(2_500);
      const still = await bodyBox();
      if (still) return still;
      break;
    }
  }
  throw new Error('panel never held layout');
}

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
async function press(frame, label, { within, settleMs = 3_000 } = {}) {
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
  await settle(settleMs);
}

/**
 * Click by exact name across every control kind the panel uses.
 *
 * The Overview / Guided Tests switch is not a button — the panel builds it out
 * of tabs — so a button-only press cannot reach it. Same dispatch rule applies:
 * the tooltip layer swallows real pointer clicks without an error.
 */
async function pressAny(frame, label, { settleMs = 3_000 } = {}) {
  const clicked = await frame.evaluate((wanted) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    // On a saved test's Guided Tests tab an IGT is entered through an icon
    // button with no text at all: its whole accessible name arrives through
    // aria-labelledby, pointing at a hidden tooltip. A resolver that reads only
    // aria-label and textContent sees an unnamed button and skips it.
    const name = (el) => {
      const labelled = el.getAttribute('aria-labelledby');
      if (labelled) {
        const text = labelled
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
        if (text) return text;
      }
      return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
    };
    const match = [...document.querySelectorAll('button,a,[role=tab],[role=button],[role=link]')]
      .filter(visible)
      .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true')
      .find((el) => name(el) === wanted);
    if (!match) return null;
    match.click();
    return match.tagName.toLowerCase() + (match.getAttribute('role') ? `[role=${match.getAttribute('role')}]` : '');
  }, label);
  if (!clicked) throw new Error(`no visible, enabled control named ${JSON.stringify(label)}`);
  await settle(settleMs);
  return clicked;
}

/** Every named control on the current view, for when a name does not resolve. */
const controls = (frame) =>
  frame.evaluate(() =>
    [...document.querySelectorAll('button,a,[role=tab],[role=button],[role=link]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 60),
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
      }))
      .filter((el) => el.name),
  );

const has = async (frame, label) =>
  frame.evaluate((wanted) => {
    const name = (el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
    return [...document.querySelectorAll('button')]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true')
      .some((b) => name(b) === wanted);
  }, label);

/**
 * Everything a trial needs to say what happened to the test it was running.
 *
 * The question's radio-group `name` is the panel's own machine-readable id for
 * the question, so "same screen" is decidable rather than a guess about prose.
 */
const readScreen = (frame) =>
  frame
    .evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const name = (el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
      const text = document.body.innerText;
      const buttons = [...document.querySelectorAll('button')]
        .filter(visible)
        .filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true')
        .map(name)
        .filter(Boolean);

      const question = document.getElementById('question-text')?.textContent.trim() ?? null;
      const questionId =
        document.getElementById('yes-igt-radio')?.getAttribute('name') ??
        [...document.querySelectorAll('input[type=radio]')]
          .map((el) => el.getAttribute('name'))
          .find(Boolean) ??
        null;

      let kind = 'unknown';
      if (/The state of your page has changed/i.test(text)) kind = 'page-state-warning';
      else if ([...document.querySelectorAll('[role=dialog]')].some(visible)) kind = 'dialog';
      else if (buttons.includes('Finish')) kind = 'results';
      else if (/Fields selected:/.test(text)) kind = 'element-picker';
      else if (document.querySelector('[role=checkbox][id^=selection-]')) kind = 'element-multiselect';
      else if (
        [...document.querySelectorAll('input[type=radio]')].some((el) =>
          /^(thumbnail-)?yes-no-/.test(el.getAttribute('name') ?? ''),
        )
      )
        kind = 'per-element';
      else if (document.getElementById('yes-igt-radio')) kind = 'single-choice';
      else if (/TOTAL ISSUES/.test(text)) kind = 'overview';
      else if (buttons.includes('Scan full page')) kind = 'scan';

      return {
        kind,
        question,
        questionId,
        step:
          [...document.querySelectorAll('button[aria-current=step]')]
            .map((b) => b.textContent.trim())
            .find(Boolean) ?? null,
        buttons,
        body: (() => {
          const r = document.body.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height) };
        })(),
      };
    })
    .catch((error) => ({ kind: 'unreadable', error: error.message }));

/** The screens that mean a test is still in progress. */
const IGT_SCREENS = new Set([
  'single-choice',
  'per-element',
  'element-multiselect',
  'element-picker',
  'results',
  'page-state-warning',
]);

/** Answer whatever screen is showing with the least destructive answer, and advance. */
async function advanceOne(frame, { answer = 'no' } = {}) {
  const screen = await readScreen(frame);
  if (screen.kind === 'single-choice') {
    await frame.locator(answer === 'yes' ? '#yes-igt-radio' : '#no-igt-radio').click();
    await settle(1_500);
    await press(frame, 'Next', { settleMs: 4_000 });
    return screen;
  }
  if (screen.kind === 'per-element') {
    const groups = await frame.evaluate(() => [
      ...new Set(
        [...document.querySelectorAll('input[type=radio]')]
          .map((el) => el.getAttribute('name'))
          .filter((n) => /^(thumbnail-)?yes-no-/.test(n ?? '')),
      ),
    ]);
    for (const group of groups) {
      await frame.locator(`input[name="${group}"][id^="false-"]`).click();
      await settle(600);
    }
    await press(frame, 'Next', { settleMs: 4_000 });
    return screen;
  }
  if (screen.kind === 'element-multiselect' || screen.kind === 'element-picker') {
    await press(frame, 'Next', { settleMs: 4_000 });
    return screen;
  }
  throw new Error(`cannot advance a ${screen.kind} screen`);
}

/**
 * Enter the Structure IGT and stop two questions in.
 *
 * Automated IGT arrives ticked and spends AI credits on a capability outside
 * this licence; it has to come off before Start, and it disappears afterwards.
 */
async function startIgtMidway(frame, depth = 1, untilPicker = false) {
  if (!(await has(frame, 'Structure'))) await pressAny(frame, 'Guided Tests', { settleMs: 4_000 });
  // "Structure" as a plain button only exists on the fresh home view. Inside a
  // saved test the card's start control is named "Start Structure Run".
  const entry = (await has(frame, 'Structure')) ? 'Structure' : 'Start Structure Run';
  await pressAny(frame, entry, { settleMs: 5_000 }).catch(async (error) => {
    throw new Error(`${error.message}; controls were ${JSON.stringify(await controls(frame))}`);
  });

  const aiAssist = frame.locator('#enableAiAssist');
  if ((await aiAssist.count()) && (await aiAssist.isChecked())) await aiAssist.uncheck();

  await press(frame, 'Start', { settleMs: 9_000 });
  const walked = [];
  if (untilPicker) {
    // The element picker is the only screen that reads the inspected page
    // directly, so it is the obvious candidate for where a page-change guard
    // would live. Answering "yes" is what opens one.
    for (let i = 0; i < 8; i += 1) {
      const here = await readScreen(frame);
      if (here.kind === 'element-picker') break;
      walked.push(await advanceOne(frame, { answer: 'yes' }));
    }
  } else {
    for (let i = 0; i < depth; i += 1) walked.push(await advanceOne(frame));
  }
  const second = await readScreen(frame);
  return { first: walked[0], walked, second };
}

/** Leave whatever screen we are on and get back to the saved test's overview. */
async function leaveIgt(frame, escapeHatch) {
  const path = [];
  for (let i = 0; i < 12; i += 1) {
    const screen = await readScreen(frame);
    path.push({ kind: screen.kind, buttons: screen.buttons });
    // Anything that is not one of the IGT's own screens means we are out —
    // except that a screen the classifier cannot name is still inside the test
    // if it carries the test's own controls. about:blank produces exactly that.
    const inTest =
      IGT_SCREENS.has(screen.kind) ||
      screen.kind === 'dialog' ||
      (screen.buttons ?? []).includes('View element selector');
    if (!inTest) return path;

    const offered = screen.buttons ?? [];
    if (offered.includes('Save progress & quit')) {
      await press(frame, 'Save progress & quit', { settleMs: 8_000 });
      continue;
    }
    if (screen.kind === 'results' && offered.includes('Finish')) {
      await press(frame, 'Finish', { settleMs: 5_000 });
      continue;
    }
    if (screen.kind === 'dialog') {
      const input = frame.locator('[role=dialog] input').first();
      if (await input.count()) await input.fill(`page-state probe ${Date.now()}`);
      await press(frame, 'Save', { within: '[role=dialog]', settleMs: 8_000 }).catch(() =>
        press(frame, 'Cancel', { within: '[role=dialog]', settleMs: 4_000 }),
      );
      continue;
    }
    // The question screens carry no quit control of their own — only Close,
    // Options, View element selector, Back and Next. The way out is the
    // Options menu.
    if (offered.includes('Options')) {
      await pressAny(frame, 'Options', { settleMs: 2_000 }).catch(() => {});
      const menu = await frame.evaluate(() =>
        [...document.querySelectorAll('[role=menuitem],[role=menu] li,[role=option]')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .map((el) => (el.textContent ?? '').trim())
          .filter(Boolean),
      );
      path.push({ menu });
      const took = await frame.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const item = [...document.querySelectorAll('[role=menuitem],[role=menu] li,[role=option]')]
          .filter(visible)
          .find((el) => /quit|exit|abandon|save progress|stop test/i.test(el.textContent ?? ''));
        if (!item) return null;
        item.click();
        return (item.textContent ?? '').trim();
      });
      if (took) {
        path.push({ tookMenuItem: took });
        await settle(8_000);
        continue;
      }
      await frame.press('body', 'Escape').catch(() => {});
      await settle(1_000);
    }
    if (offered.includes('Cancel')) {
      await press(frame, 'Cancel', { settleMs: 4_000 });
      continue;
    }
    if (offered.includes('Close')) {
      await press(frame, 'Close', { settleMs: 5_000 });
      continue;
    }
    // Last resort: trip the page-state guard deliberately. It is the one screen
    // that always offers a way out of an in-progress test.
    if (escapeHatch) {
      path.push({ escapeHatch: 'tripped the page-state guard' });
      await escapeHatch();
      await settle(6_000);
      continue;
    }
    break;
  }
  return path;
}

/**
 * The perturbations, each one thing done to the page and its undo.
 *
 * `restore` is what a parent agent would have to do between sub-agents, which
 * is the whole reason the boundary matters.
 */
const PERTURBATIONS = [
  {
    key: 'scroll',
    what: 'window.scrollTo(0, 600)',
    apply: (page) => page.evaluate(() => window.scrollTo(0, 600)),
    restore: (page) => page.evaluate(() => window.scrollTo(0, 0)),
  },
  {
    key: 'dom-mutation',
    what: 'script writes new nodes into the page',
    apply: (page) =>
      page.evaluate(() => {
        document.getElementById('mutable').innerHTML =
          '<h2>Injected section</h2><ul><li>added by script</li></ul>';
      }),
    restore: (page) =>
      page.evaluate(() => {
        document.getElementById('mutable').innerHTML = '';
      }),
  },
  {
    key: 'text-spacing-css',
    what: 'WCAG 1.4.12 text-spacing stylesheet injected (page state test 9)',
    apply: (page, css) =>
      page.evaluate((rules) => {
        const style = document.createElement('style');
        style.id = 'wcag-text-spacing';
        style.textContent = rules;
        document.head.append(style);
      }, css),
    restore: (page) =>
      page.evaluate(() => document.getElementById('wcag-text-spacing')?.remove()),
  },
  {
    key: 'viewport-320',
    what: 'viewport resized to 320px wide (page state test 9)',
    apply: (page) => page.setViewportSize({ width: 320, height: 800 }),
    restore: (page) => page.setViewportSize({ width: 1280, height: 800 }),
  },
  {
    key: 'hash-change',
    what: "location.hash = '#findings'",
    apply: (page) =>
      page.evaluate(() => {
        window.location.hash = '#findings';
      }),
    restore: (page) =>
      page.evaluate(() => history.replaceState({}, '', window.location.pathname)),
  },
  {
    key: 'pushstate-query',
    what: "history.pushState to the same path with ?probe=1",
    apply: (page) =>
      page.evaluate(() => history.pushState({}, '', `${window.location.pathname}?probe=1`)),
    restore: (page) => page.evaluate(() => history.replaceState({}, '', window.location.pathname)),
  },
  {
    key: 'pushstate-path',
    what: "history.pushState to a different path on the same origin",
    apply: (page) => page.evaluate(() => history.pushState({}, '', '/other.html')),
    restore: (page) => page.evaluate(() => history.replaceState({}, '', '/')),
  },
  {
    key: 'reload-same-url',
    what: 'page.reload() of the same URL',
    apply: (page) => page.reload({ waitUntil: 'domcontentloaded' }),
    restore: () => Promise.resolve(),
  },
  {
    key: 'form-submit-and-back',
    what: 'form submitted, then history back to the original URL',
    apply: async (page) => {
      await page.locator('#subscribe button[type=submit]').click();
      await page.waitForLoadState('domcontentloaded');
      await settle(1_500);
      await page.goBack({ waitUntil: 'domcontentloaded' });
    },
    restore: () => Promise.resolve(),
  },
  {
    key: 'same-origin-nav',
    what: `navigate to ${SAME_ORIGIN_URL}`,
    apply: (page) => page.goto(SAME_ORIGIN_URL, { waitUntil: 'domcontentloaded' }),
    restore: (page) => page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }),
  },
  {
    key: 'other-origin-same-content',
    what: `navigate to ${OTHER_ORIGIN_SAME_PORT} — same document, different host`,
    apply: (page) => page.goto(OTHER_ORIGIN_SAME_PORT, { waitUntil: 'domcontentloaded' }),
    restore: (page) => page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }),
  },
  {
    key: 'cross-origin-nav',
    what: `navigate to ${CROSS_ORIGIN_URL}`,
    apply: (page) => page.goto(CROSS_ORIGIN_URL, { waitUntil: 'domcontentloaded' }),
    restore: (page) => page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }),
  },
  {
    key: 'nav-away-and-back',
    what: `navigate to ${SAME_ORIGIN_URL} (which trips the guard), then straight back to ${BASE_URL}`,
    apply: async (page) => {
      await page.goto(SAME_ORIGIN_URL, { waitUntil: 'domcontentloaded' });
      await settle(6_000);
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    },
    restore: () => Promise.resolve(),
  },
  {
    key: 'same-origin-nav-same-headings',
    what: `navigate to ${SAME_ORIGIN_SAME_CONTENT} — different URL, identical headings`,
    apply: (page) => page.goto(SAME_ORIGIN_SAME_CONTENT, { waitUntil: 'domcontentloaded' }),
    restore: (page) => page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }),
  },
  {
    key: 'cross-origin-nav-different-headings',
    what: `navigate to ${CROSS_ORIGIN_DIFFERENT_CONTENT} — different origin and different headings`,
    apply: (page) => page.goto(CROSS_ORIGIN_DIFFERENT_CONTENT, { waitUntil: 'domcontentloaded' }),
    restore: (page) => page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }),
  },
  {
    key: 'remove-headings',
    what: 'script deletes every heading, no navigation at all',
    apply: (page) =>
      page.evaluate(() => {
        document.querySelectorAll('h1,h2,h3,h4').forEach((h) => h.remove());
      }),
    restore: (page) => page.reload({ waitUntil: 'domcontentloaded' }),
  },
  {
    key: 'remove-headings-then-hash',
    what: 'script deletes every heading, then a hash change fires the navigation check',
    apply: async (page) => {
      await page.evaluate(() => {
        document.querySelectorAll('h1,h2,h3,h4').forEach((h) => h.remove());
      });
      await settle(2_000);
      await page.evaluate(() => {
        window.location.hash = '#after-removal';
      });
    },
    restore: (page) => page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }),
  },
  {
    key: 'blank-nav',
    what: 'navigate to about:blank',
    apply: (page) => page.goto('about:blank', { waitUntil: 'domcontentloaded' }),
    restore: (page) => page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }),
  },
  {
    key: 'unreachable-nav',
    what: 'navigate to a port nothing is listening on',
    apply: (page) => page.goto('http://127.0.0.1:9/', { waitUntil: 'domcontentloaded' }).catch(() => {}),
    restore: (page) => page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }),
  },
  {
    key: 'cross-origin-nav-deep',
    what: `navigate to ${CROSS_ORIGIN_URL} from four screens in`,
    depth: 4,
    apply: (page) => page.goto(CROSS_ORIGIN_URL, { waitUntil: 'domcontentloaded' }),
    restore: (page) => page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }),
  },
  {
    key: 'cross-origin-nav-at-picker',
    what: `navigate to ${CROSS_ORIGIN_URL} while an element picker is open`,
    untilPicker: true,
    apply: (page) => page.goto(CROSS_ORIGIN_URL, { waitUntil: 'domcontentloaded' }),
    restore: (page) => page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }),
  },
  {
    key: 'cross-origin-nav-settled',
    what: `navigate to ${CROSS_ORIGIN_URL}, then wait 25s before reading the panel`,
    settleMs: 25_000,
    apply: (page) => page.goto(CROSS_ORIGIN_URL, { waitUntil: 'domcontentloaded' }),
    restore: (page) => page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }),
  },
];

async function scanAndSave(frame, name) {
  await press(frame, 'Scan full page');
  await settle(12_000);
  await press(frame, 'Save Test');
  await frame.locator('[role=dialog] input').first().fill(name);
  await settle(1_000);
  await press(frame, 'Save', { within: '[role=dialog]', settleMs: 8_000 });
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
  await press(frame, 'Save', { settleMs: 6_000 });
  return chosen.text;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userDataDir = await mkdtemp(join(tmpdir(), 'axe-pagestate-'));
  await mkdir(args.out, { recursive: true });
  const serverUrl = serverUrlFromEnv();
  const results = [];

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
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    const dt = await poll(() => context.pages().find((p) => p.url().startsWith('devtools://')), {
      what: 'a devtools:// page',
    });
    const axeTab = await poll(
      async () => (await listTabIds(dt)).find((id) => id.includes(EXTENSION_ID)),
      { what: 'the axe panel to register' },
    );
    let frame = await showPanel(dt, axeTab);
    // The panel loses its layout during page navigation, not only at startup.
    const live = async () => {
      const ok = await frame
        .evaluate(() => document.body.getBoundingClientRect().width > 0)
        .catch(() => false);
      if (!ok) frame = await showPanel(dt, axeTab, { timeoutMs: 60_000 });
      return frame;
    };
    console.log(`onboarding: ${JSON.stringify(await clearOnboarding(frame))}`);

    // The ledger under test: a saved test carrying one filed manual issue.
    const testName = `Page state probe - 017 - ${new Date().toISOString()}`;
    let saved = null;
    let baseline = null;
    if (!args.noLedger) {
      const savedAfter = new Date(Date.now() - 60_000).toISOString();
      await scanAndSave(frame, testName);
      saved = await resolveSavedTest({
        serverUrl,
        accessToken: token(),
        userId: user.id,
        name: testName,
        createdAfter: savedAfter,
      });
      await addManualIssue(frame, MANUAL_ISSUE);
      baseline = ledgerBaseline(await readLedger({ serverUrl, accessToken: token(), testId: saved.id }));
      console.log(`ledger ${saved.id} ${JSON.stringify(baseline.issues)}`);
    } else {
      console.log('no-ledger mode: entering the IGT from the fresh home view, as ticket 008 did');
    }
    if (args.dump) {
      await pressAny(frame, 'Guided Tests', { settleMs: 5_000 });
      const rich = await frame.evaluate(() =>
        [...document.querySelectorAll('*')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            return (
              el.tagName === 'BUTTON' ||
              el.tagName === 'A' ||
              el.hasAttribute('role') ||
              el.hasAttribute('tabindex') ||
              /^H[1-6]$/.test(el.tagName)
            );
          })
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            tabindex: el.getAttribute('tabindex'),
            cls: el.className?.toString().slice(0, 60),
            text: (el.textContent ?? '').trim().slice(0, 70),
          })),
      );
      await writeFile(join(args.out, 'guided-tab.json'), JSON.stringify(rich, null, 2));
      await writeFile(join(args.out, 'guided-tab.html'), await frame.content());
      console.log(`dumped ${rich.length} elements to ${join(args.out, 'guided-tab.json')}`);
      return;
    }

    const overviewControls = await controls(frame);
    console.log(`overview controls: ${JSON.stringify(overviewControls.map((c) => `${c.tag}${c.role ? `[${c.role}]` : ''} ${c.name}`))}`);

    // Navigating to a different origin is the reliable way to make the panel
    // offer a way out of a test it will not otherwise let go of.
    const escapeHatch = async () => {
      await page.goto(CROSS_ORIGIN_URL, { waitUntil: 'domcontentloaded' });
      await settle(5_000);
      await live();
    };

    /** Put the panel back on the run's own saved test, from wherever it is. */
    const reopenSavedTest = async () => {
      if (args.noLedger) return false;
      await live();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if ((await readPanel(frame)).testName === testName) return true;
        await press(frame, 'view saved tests', { settleMs: 5_000 }).catch(() => {});
        await frame
          .evaluate((name) => {
            const visible = (el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            };
            const match = [...document.querySelectorAll('button,a,[role=button],[role=link]')]
              .filter(visible)
              .find((el) => (el.textContent ?? '').trim() === name);
            if (match) match.click();
          }, testName)
          .catch(() => {});
        await settle(8_000);
        await live();
      }
      return (await readPanel(frame)).testName === testName;
    };

    const trials = args.only
      ? PERTURBATIONS.filter((p) => args.only.includes(p.key))
      : PERTURBATIONS;

    for (const perturbation of trials) {
      console.log(`\n=== ${perturbation.key} — ${perturbation.what}`);
      const trial = { key: perturbation.key, what: perturbation.what };
      try {
        await live();
        trial.startedFromSavedTest = await reopenSavedTest();
        const entered = await startIgtMidway(frame, perturbation.depth ?? 1, perturbation.untilPicker ?? false);
        trial.before = {
          kind: entered.second.kind,
          questionId: entered.second.questionId,
          step: entered.second.step,
        };
        console.log(`    mid-test on ${entered.second.questionId} (${entered.second.kind})`);

        await perturbation.apply(page, TEXT_SPACING_CSS);
        await settle(perturbation.settleMs ?? 6_000);
        trial.pageUrl = page.url();
        trial.viewport = page.viewportSize();

        await live();
        const after = await readScreen(frame);
        trial.after = {
          kind: after.kind,
          questionId: after.questionId,
          step: after.step,
          buttons: after.buttons,
        };
        trial.igtSurvived =
          after.kind === trial.before.kind && after.questionId === trial.before.questionId;
        console.log(
          `    after: ${after.kind} ${after.questionId ?? ''} — IGT ${trial.igtSurvived ? 'survived' : 'LOST'}`,
        );

        // The guard is not necessarily a watcher. It may only fire when a step
        // actually needs the page, so surviving the moment of the change proves
        // nothing — walk the rest of the test and record where, if anywhere, it
        // fires. Reaching the results screen means the change was tolerated all
        // the way through, and the results carry the URL the test believes it
        // audited, which is how a silently-stale run would show itself.
        trial.walk = [];
        trial.guardFiredAt = null;
        if (after.kind === 'page-state-warning') {
          // The warning arrives as a banner above the question, not instead of
          // it: Back, Next and the element selector are all still offered. So
          // ask the question that matters — can an agent simply ignore it?
          try {
            await press(frame, 'Next', { settleMs: 6_000 });
            await live();
            const past = await readScreen(frame);
            trial.ignoredGuard = {
              kind: past.kind,
              questionId: past.questionId,
              step: past.step,
              advanced: past.questionId !== trial.before.questionId,
              warningStillShown: past.kind === 'page-state-warning',
            };
          } catch (error) {
            trial.ignoredGuard = { error: error.message };
          }
          console.log(`    ignoring the warning: ${JSON.stringify(trial.ignoredGuard)}`);
        }
        if (trial.igtSurvived) {
          for (let stepIndex = 0; stepIndex < 14; stepIndex += 1) {
            await live();
            const screen = await readScreen(frame);
            trial.walk.push({
              kind: screen.kind,
              questionId: screen.questionId,
              step: screen.step,
            });
            if (screen.kind === 'page-state-warning') {
              trial.guardFiredAt = { after: stepIndex, buttons: screen.buttons };
              break;
            }
            if (screen.kind === 'results') {
              trial.reachedResults = true;
              trial.resultsText = await frame
                .evaluate(() => document.body.innerText.replace(/\n{3,}/g, '\n\n').trim().slice(0, 1200))
                .catch(() => null);
              break;
            }
            try {
              await advanceOne(frame);
            } catch (error) {
              trial.walk.push({ stuck: error.message });
              break;
            }
          }
          console.log(
            `    walk: ${trial.walk.map((s) => s.kind ?? 'stuck').join(' -> ')}` +
              `${trial.guardFiredAt ? `  GUARD after ${trial.guardFiredAt.after} step(s)` : ''}` +
              `${trial.reachedResults ? '  reached results' : ''}`,
          );
          if (trial.resultsText) {
            const url = trial.resultsText.match(/https?:\/\/\S+/)?.[0] ?? null;
            trial.resultsUrl = url;
            console.log(`    results report URL ${url}`);
          }
        }

        const ledger = saved
          ? await readLedger({ serverUrl, accessToken: token(), testId: saved.id })
          : { exists: null, issues: null };
        trial.ledger = saved ? {
          exists: ledger.exists,
          issues: ledger.issues ?? null,
          survived:
            ledger.exists &&
            ledger.issues.total >= baseline.issues.total &&
            ledger.issues.manual >= baseline.issues.manual,
        } : null;
        console.log(`    ledger: ${JSON.stringify(trial.ledger)}`);

        await live();
        trial.panelAfter = await readPanel(frame).then((p) => ({ view: p.view, testName: p.testName }));
        trial.exitPath = await leaveIgt(await live(), escapeHatch);
        console.log(`    panel now ${JSON.stringify(trial.panelAfter)}; exit ${JSON.stringify(trial.exitPath)}`);
      } catch (error) {
        trial.error = error.message;
        console.log(`    ERROR ${error.message}`);
        trial.recovery = await leaveIgt(await live(), escapeHatch).catch((e) => [`unrecoverable: ${e.message}`]);
      }

      // Put the page back the way a parent agent would have to.
      await perturbation.restore(page).catch(() => {});
      if (page.url() !== BASE_URL) await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
      await settle(3_000);
      await live();

      // Whatever the perturbation did to the panel, the run needs the saved
      // test open again before the next trial.
      const panel = await readPanel(frame);
      if (!args.noLedger && panel.testName !== testName) {
        trial.neededReopen = { was: panel.view, testName: panel.testName };
        trial.reopened = await reopenSavedTest();
        console.log(`    reopened the saved test: ${trial.reopened}`);
      }

      results.push(trial);
    }

    const finalLedger = saved
      ? await readLedger({ serverUrl, accessToken: token(), testId: saved.id })
      : null;
    await writeFile(
      join(args.out, 'page-state.json'),
      JSON.stringify({ testId: saved?.id ?? null, testName, baseline, overviewControls, results, finalLedger }, null, 2),
    );

    console.log('\n=== summary');
    for (const trial of results) {
      console.log(
        `${trial.key.padEnd(26)} survived=${String(trial.igtSurvived ?? 'error').padEnd(6)} ` +
          `guard=${String(trial.guardFiredAt ? `after ${trial.guardFiredAt.after}` : '-').padEnd(9)} ` +
          `results=${String(trial.reachedResults ?? '-').padEnd(6)} ` +
          `ledger=${String(trial.ledger?.survived ?? '-').padEnd(6)} ` +
          `at=${trial.after?.kind ?? trial.error ?? '-'}`,
      );
    }
    console.log(`\nfinal ledger ${JSON.stringify(finalLedger?.issues ?? null)}`);
    console.log(`written to ${join(args.out, 'page-state.json')}`);
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
