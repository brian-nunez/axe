// PROTOTYPE — throwaway. Finds the call that actually SELECTS the axe panel.
// showView() resolves without selecting it, leaving the iframe 0x0 and every
// element inside unclickable.
//
//   node prototype/panel-select.js --extension=build/axe-extension

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsFromEnv, serverUrlFromEnv } from '../fixture/session.js';
import { launchSignedIn } from '../fixture/launch.js';

const EXTENSION_ID = 'lhdoppojpmngadmnindnejefpokejbdd';
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const extensionPath = process.argv.slice(2)
  .find((a) => a.startsWith('--extension='))?.slice(12);

async function poll(fn, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await settle(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const state = (dt) =>
  dt.evaluate(() =>
    import('./ui/legacy/legacy.js').then((UI) => {
      const pane = UI.InspectorView.InspectorView.instance().tabbedPane;
      const iframe = (() => {
        const walk = (root, out = []) => {
          for (const el of root.querySelectorAll('iframe')) out.push(el);
          for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot, out);
          return out;
        };
        const f = walk(document).find((x) => (x.getAttribute('src') ?? '').endsWith('panel.html'));
        if (!f) return null;
        const r = f.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })();
      return { selected: pane.selectedTabId, iframe };
    }),
  );

const attempts = [
  {
    name: 'showView(id)',
    run: (dt, id) => dt.evaluate((i) => import('./ui/legacy/legacy.js')
      .then((UI) => UI.ViewManager.ViewManager.instance().showView(i)), id),
  },
  {
    name: 'showView(id, true, true)',
    run: (dt, id) => dt.evaluate((i) => import('./ui/legacy/legacy.js')
      .then((UI) => UI.ViewManager.ViewManager.instance().showView(i, true, true)), id),
  },
  {
    name: 'tabbedPane.selectTab(id, true)',
    run: (dt, id) => dt.evaluate((i) => import('./ui/legacy/legacy.js')
      .then((UI) => UI.InspectorView.InspectorView.instance().tabbedPane.selectTab(i, true)), id),
  },
  {
    name: 'InspectorView.showPanel(id)',
    run: (dt, id) => dt.evaluate((i) => import('./ui/legacy/legacy.js')
      .then((UI) => UI.InspectorView.InspectorView.instance().showPanel(i)), id),
  },
];

const main = async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'axe-select-'));
  const { context } = await launchSignedIn({
    extensionPath,
    userDataDir,
    serverUrl: serverUrlFromEnv(),
    credentials: credentialsFromEnv(),
    headless: true,
    openDevtools: true,
  });

  try {
    const target = context.pages().find((p) => !p.url().startsWith('devtools://'));
    await target.goto('https://www.w3.org/WAI/demos/bad/before/home.html', {
      waitUntil: 'domcontentloaded',
    });
    const dt = await poll(
      () => context.pages().find((p) => p.url().startsWith('devtools://')),
      'devtools page',
    );
    const id = await poll(
      async () => (await dt.evaluate(() => import('./ui/legacy/legacy.js')
        .then((UI) => UI.InspectorView.InspectorView.instance().tabbedPane.tabIds())))
        .find((t) => t.includes(EXTENSION_ID)),
      'axe panel registration',
    );
    console.log(`panel id       ${id}`);
    console.log(`initial        ${JSON.stringify(await state(dt))}\n`);

    for (const attempt of attempts) {
      // Park on another tab so each attempt starts from the same place.
      await dt.evaluate(() => import('./ui/legacy/legacy.js')
        .then((UI) => UI.InspectorView.InspectorView.instance().tabbedPane.selectTab('console', true)))
        .catch(() => {});
      await settle(500);
      let error = null;
      try {
        await attempt.run(dt, id);
      } catch (e) {
        error = e.message.split('\n')[0].slice(0, 80);
      }
      await settle(2_500);
      const after = await state(dt);
      const ok = after.selected === id && after.iframe && after.iframe.w > 0;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${attempt.name.padEnd(30)} ` +
        `selected=${after.selected} iframe=${JSON.stringify(after.iframe)}` +
        (error ? `  error=${error}` : ''));
    }
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
};

main().catch((e) => {
  console.error(e.stack ?? e.message);
  process.exitCode = 1;
});
