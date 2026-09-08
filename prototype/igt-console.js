// PROTOTYPE — throwaway. Answers ticket 008: what does stepping an IGT to
// completion actually take? Delete once 011 names the tools.
//
// An interactive console over one browser lifetime. The saved test is the only
// record of findings, and the panel must never be refreshed or closed, so
// exploring the IGT means holding a single session open and issuing commands
// into it rather than re-launching per question.
//
//   node prototype/igt-console.js --extension=build/axe-extension --fifo=/path/to/cmd
//
// Commands arrive one per line on the FIFO; output goes to stdout.
//
//   state                  structured read of the current panel view
//   click <name>           click a visible, enabled button by accessible name
//   click-nth <n> <name>   same, disambiguated by index
//   radio <name>           check a radio/checkbox by its label text
//   tree                   dump the Element Selector tree
//   js <expression>        evaluate inside the panel frame
//   page <expression>      evaluate inside the target page
//   html [file]            write the panel frame's HTML
//   shot <file>            screenshot the DevTools window
//   goto <url>             navigate the target page
//   quit

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsFromEnv, serverUrlFromEnv } from '../fixture/session.js';
import { launchSignedIn } from '../fixture/launch.js';
import { startSessionKeepAlive } from '../fixture/keepalive.js';

const EXTENSION_ID = 'lhdoppojpmngadmnindnejefpokejbdd';
const DEFAULT_URL = 'https://www.w3.org/WAI/demos/bad/before/home.html';
const OPEN_DIALOG = '[role=dialog].Dialog--show';
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { headless: true, url: DEFAULT_URL, out: 'build/igt' };
  for (const arg of argv) {
    if (arg.startsWith('--extension=')) args.extensionPath = arg.slice(12);
    else if (arg.startsWith('--url=')) args.url = arg.slice(6);
    else if (arg.startsWith('--fifo=')) args.fifo = arg.slice(7);
    else if (arg.startsWith('--out=')) args.out = arg.slice(6);
    else if (arg === '--headed') args.headless = false;
    else throw new Error(`unrecognised argument: ${arg}`);
  }
  if (!args.extensionPath) throw new Error('--extension=<unpacked directory> is required');
  if (!args.fifo) throw new Error('--fifo=<path> is required');
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
      // DevTools steals the selection back while it finishes starting up.
      await settle(2_500);
      const still = await bodyBox();
      if (still) return { ...still, attempts };
      break;
    }
  }
  throw new Error('panel never held layout');
}

/** Clear the onboarding dialog chain; each one blocks the whole panel. */
async function clearDialogs(frame, max = 6) {
  const cleared = [];
  for (let i = 0; i < max; i += 1) {
    const dialog = frame.locator(OPEN_DIALOG).first();
    if ((await dialog.count()) === 0) break;

    const title =
      (
        await dialog
          .locator('h1,h2,h3,[id^=dialog-title]')
          .first()
          .textContent()
          .catch(() => null)
      )?.trim() ?? '(untitled)';

    const role = dialog.locator('select#user-job-role');
    if (await role.count()) {
      await role.selectOption('Developer');
      await dialog.locator('#terms-and-services-checkbox').check();
    }

    const action = dialog
      .locator(
        'button:has-text("Start using axe DevTools"), button:has-text("Got it"), ' +
          'button:has-text("Continue"), button:has-text("Close"), button:has-text("Dismiss"), ' +
          'button:has-text("OK")',
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
 * Everything a step-driving agent would read before deciding what to do.
 *
 * Reports only what is visible and enabled: the panel keeps hidden controls in
 * the DOM, and acting on one costs a debugging cycle.
 */
const readState = (frame) =>
  frame.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const name = (el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
    const labelFor = (el) => {
      const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (byFor) return byFor.textContent.trim();
      const wrapper = el.closest('label');
      if (wrapper) return wrapper.textContent.trim();
      return el.getAttribute('aria-label') ?? null;
    };

    const buttons = [...document.querySelectorAll('button')]
      .filter(visible)
      .map((b, i) => ({
        i,
        name: name(b),
        disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
        pressed: b.getAttribute('aria-pressed'),
        current: b.getAttribute('aria-current'),
        expanded: b.getAttribute('aria-expanded'),
        cls: b.className,
      }))
      .filter((b) => b.name);

    const controls = [...document.querySelectorAll('input,select,textarea')]
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        id: el.id || null,
        nameAttr: el.getAttribute('name'),
        label: labelFor(el),
        checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked : undefined,
        value: el.tagName === 'SELECT' ? el.value : undefined,
      }));

    return {
      dialog: [...document.querySelectorAll('[role=dialog]')]
        .filter(visible)
        .map((d) => d.textContent.trim().slice(0, 300)),
      headings: [...document.querySelectorAll('h1,h2,h3,h4,[role=heading]')]
        .filter(visible)
        .map((h) => ({ tag: h.tagName.toLowerCase(), text: h.textContent.trim() })),
      buttons,
      controls,
      roles: [...new Set([...document.querySelectorAll('[role]')].map((el) => el.getAttribute('role')))].sort(),
      treeItems: document.querySelectorAll('[role=treeitem]').length,
      progressAria: [...document.querySelectorAll('[aria-valuenow],[role=progressbar],[role=tablist],[role=tab]')].map(
        (el) => ({
          role: el.getAttribute('role'),
          label: el.getAttribute('aria-label'),
          now: el.getAttribute('aria-valuenow'),
          selected: el.getAttribute('aria-selected'),
        }),
      ),
      text: document.body.innerText.replace(/\n{3,}/g, '\n\n').trim(),
    };
  });

/** Click a visible, enabled button by accessible name. */
const clickButton = (frame, wanted, nth = 0) =>
  frame.evaluate(
    ({ wanted: w, nth: n }) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const name = (el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
      const matches = [...document.querySelectorAll('button')]
        .filter(visible)
        .filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true')
        .filter((b) => name(b).toLowerCase() === w.toLowerCase() || name(b).toLowerCase().includes(w.toLowerCase()));
      if (!matches[n]) return `no visible enabled button matching ${JSON.stringify(w)} at index ${n}; saw ${JSON.stringify(matches.map(name))}`;
      matches[n].click();
      return `clicked ${JSON.stringify(name(matches[n]))} (${matches.length} match(es))`;
    },
    { wanted, nth },
  );

/** Check a radio or checkbox by its label text, through a real click. */
const chooseOption = (frame, wanted) =>
  frame.evaluate((w) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const labelText = (el) => {
      const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (byFor) return byFor.textContent.trim();
      return el.closest('label')?.textContent.trim() ?? el.getAttribute('aria-label') ?? '';
    };
    const inputs = [...document.querySelectorAll('input[type=radio],input[type=checkbox]')];
    const target = inputs.find((el) => labelText(el).toLowerCase().includes(w.toLowerCase()));
    if (!target) return `no option matching ${JSON.stringify(w)}; saw ${JSON.stringify(inputs.map(labelText))}`;
    const clickable = visible(target)
      ? target
      : (target.id && document.querySelector(`label[for="${CSS.escape(target.id)}"]`)) || target.closest('label');
    clickable.click();
    return `chose ${JSON.stringify(labelText(target))}, checked=${target.checked}`;
  }, wanted);

const dumpTree = (frame) =>
  frame.evaluate(() =>
    [...document.querySelectorAll('[role=treeitem]')].slice(0, 80).map((el) => ({
      level: el.getAttribute('aria-level'),
      expanded: el.getAttribute('aria-expanded'),
      selected: el.getAttribute('aria-selected'),
      text: el.textContent.trim().slice(0, 120),
    })),
  );

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userDataDir = await mkdtemp(join(tmpdir(), 'axe-igt-'));
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

  const target = context.pages().find((p) => !p.url().startsWith('devtools://'));
  await target.goto(args.url, { waitUntil: 'domcontentloaded' });

  const dt = await poll(() => context.pages().find((p) => p.url().startsWith('devtools://')), {
    what: 'a devtools:// page',
  });
  const axeTab = await poll(async () => (await listTabIds(dt)).find((id) => id.includes(EXTENSION_ID)), {
    what: 'the axe panel to register',
  });

  let { frame, w, h, attempts } = await showPanel(dt, axeTab);
  console.log(`[ready] panel ${w}x${h} after ${attempts} selectTab call(s)`);
  console.log(`[ready] dialogs cleared ${JSON.stringify(await clearDialogs(frame))}`);
  console.log('[ready] awaiting commands');

  /** A stolen tab makes every action fail; re-assert before each command. */
  const live = async () => {
    const ok = await frame
      .evaluate(() => document.body.getBoundingClientRect().width > 0)
      .catch(() => false);
    if (!ok) {
      const again = await showPanel(dt, axeTab);
      frame = again.frame;
      console.log('[panel] selection was stolen, re-selected');
    }
    return frame;
  };

  const commands = {
    async state() {
      console.log(JSON.stringify(await readState(await live()), null, 2));
    },
    async click(rest) {
      console.log(await clickButton(await live(), rest));
      await settle(2_500);
    },
    async 'click-nth'(rest) {
      const [n, ...name] = rest.split(' ');
      console.log(await clickButton(await live(), name.join(' '), Number(n)));
      await settle(2_500);
    },
    async radio(rest) {
      console.log(await chooseOption(await live(), rest));
      await settle(1_500);
    },
    async tree() {
      console.log(JSON.stringify(await dumpTree(await live()), null, 2));
    },
    // Real CDP input, as opposed to `js`, which can only synthesise events.
    async press(rest) {
      const [selector, key] = rest.split(' :: ');
      await (await live()).locator(selector).first().press(key);
      console.log(`pressed ${key} on ${selector}`);
      await settle(2_000);
    },
    async key(rest) {
      await (await live()).page().keyboard.press(rest);
      console.log(`pressed ${rest} on the focused element`);
      await settle(2_000);
    },
    async css(rest) {
      const [selector, ...action] = rest.split(' :: ');
      const locator = (await live()).locator(selector).first();
      if (action[0]) await locator.fill(action[0]);
      else await locator.click();
      console.log(`${action[0] ? 'filled' : 'clicked'} ${selector}`);
      await settle(2_000);
    },
    async option(rest) {
      const [selector, value] = rest.split(' :: ');
      await (await live()).locator(selector).first().selectOption(value);
      console.log(`selected ${JSON.stringify(value)} in ${selector}`);
      await settle(2_000);
    },
    async type(rest) {
      const [selector, text] = rest.split(' :: ');
      const field = (await live()).locator(selector).first();
      await field.click();
      await field.pressSequentially(text, { delay: 60 });
      console.log(`typed ${JSON.stringify(text)} into ${selector}`);
      await settle(2_000);
    },
    async 'page-click'(rest) {
      await target.locator(rest).first().click();
      console.log(`clicked ${rest} on the target page`);
      await settle(2_000);
    },
    async js(rest) {
      const value = await (await live()).evaluate(`(async () => (${rest}))()`);
      console.log(JSON.stringify(value, null, 2));
    },
    async page(rest) {
      const value = await target.evaluate(`(async () => (${rest}))()`);
      console.log(JSON.stringify(value, null, 2));
    },
    async html(rest) {
      const file = join(args.out, rest || 'panel.html');
      await writeFile(file, await (await live()).content());
      console.log(`wrote ${file}`);
    },
    async shot(rest) {
      const file = join(args.out, rest || 'panel.png');
      await dt.screenshot({ path: file });
      console.log(`wrote ${file}`);
    },
    async goto(rest) {
      await target.goto(rest, { waitUntil: 'domcontentloaded' });
      console.log(`target at ${target.url()}`);
    },
    async wait(rest) {
      await settle(Number(rest || 3000));
      console.log('waited');
    },
    async dialogs() {
      console.log(JSON.stringify(await clearDialogs(await live())));
    },
  };

  let done;
  const finished = new Promise((resolve) => {
    done = resolve;
  });

  // A FIFO reopens at EOF, so each `echo > fifo` is a fresh stream.
  const listen = () => {
    const rl = createInterface({ input: createReadStream(args.fifo) });
    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const [verb, ...rest] = trimmed.split(' ');
      console.log(`\n>>> ${trimmed}`);
      if (verb === 'quit') return done();
      const handler = commands[verb];
      if (!handler) {
        console.log(`unknown command ${JSON.stringify(verb)}; know ${Object.keys(commands).join(', ')}`);
      } else {
        try {
          await handler(rest.join(' '));
        } catch (error) {
          console.log(`ERROR ${error.message}`);
        }
      }
      console.log('<<< done');
    });
    rl.on('close', () => setImmediate(listen));
  };
  listen();

  await finished;
  keepAlive.stop();
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
  console.log('[closed]');
  process.exit(0);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
