// PROTOTYPE — throwaway. Narrows two unknowns ticket 007 hit:
//   1. why every element reports a 0x0 box
//   2. why the first-run modal's submit button stays disabled after a
//      native-setter write that React should honour
//
//   node prototype/panel-diagnose.js --extension=build/axe-extension [--headed]

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsFromEnv, serverUrlFromEnv } from '../fixture/session.js';
import { launchSignedIn } from '../fixture/launch.js';

const EXTENSION_ID = 'lhdoppojpmngadmnindnejefpokejbdd';
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const args = { headless: true, extensionPath: null };
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--extension=')) args.extensionPath = arg.slice(12);
  else if (arg === '--headed') args.headless = false;
}

async function poll(fn, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await settle(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const main = async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'axe-diag-'));
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
    await target.goto('https://www.w3.org/WAI/demos/bad/before/home.html', {
      waitUntil: 'domcontentloaded',
    });
    const dt = await poll(
      () => context.pages().find((p) => p.url().startsWith('devtools://')),
      'devtools page',
    );
    const axeTab = await poll(
      async () =>
        (
          await dt.evaluate(() =>
            import('./ui/legacy/legacy.js').then((UI) =>
              UI.InspectorView.InspectorView.instance().tabbedPane.tabIds(),
            ),
          )
        ).find((id) => id.includes(EXTENSION_ID)),
      'axe panel registration',
    );

    await dt.evaluate(
      (id) =>
        import('./ui/legacy/legacy.js').then((UI) =>
          UI.ViewManager.ViewManager.instance().showView(id),
        ),
      axeTab,
    );
    await settle(6_000);

    // Did the tab actually activate? An unselected panel is never laid out.
    const tabState = await dt.evaluate(() =>
      import('./ui/legacy/legacy.js').then((UI) => {
        const pane = UI.InspectorView.InspectorView.instance().tabbedPane;
        return { selected: pane.selectedTabId, visible: pane.isShowing?.() ?? null };
      }),
    );
    console.log(`selected tab   ${tabState.selected}`);
    console.log(`tabbedPane vis ${tabState.visible}`);

    // How big is the panel iframe as the DevTools document sees it?
    const iframeBox = await dt.evaluate(() => {
      const walk = (root, out = []) => {
        for (const el of root.querySelectorAll('iframe')) out.push(el);
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot, out);
        return out;
      };
      return walk(document).map((f) => {
        const r = f.getBoundingClientRect();
        const cs = getComputedStyle(f);
        return {
          src: (f.getAttribute('src') ?? '').slice(-24),
          width: Math.round(r.width),
          height: Math.round(r.height),
          display: cs.display,
          visibility: cs.visibility,
        };
      });
    });
    console.log(`iframes        ${JSON.stringify(iframeBox)}`);

    const frame = await poll(
      () => dt.frames().find((f) => f.url().endsWith('/panel.html')),
      'panel frame',
    );

    const report = await frame.evaluate(() => {
      const find = (text) =>
        [...document.querySelectorAll('button')].find((b) =>
          b.textContent.trim().toLowerCase().includes(text.toLowerCase()),
        );
      const describe = (el) => {
        if (!el) return null;
        const chain = [];
        for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const cs = getComputedStyle(node);
          chain.push({
            tag: node.tagName.toLowerCase(),
            cls: (node.className || '').toString().slice(0, 40),
            box: `${Math.round(r.width)}x${Math.round(r.height)}`,
            display: cs.display,
            visibility: cs.visibility,
            position: cs.position,
          });
          if (chain.length >= 6) break;
        }
        return chain;
      };

      const setNative = (el, value) => {
        const prop = el.type === 'checkbox' ? 'checked' : 'value';
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), prop);
        desc.set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };

      const select = document.querySelector('select');
      const tos = document.getElementById('terms-and-services-checkbox');
      const before = {
        selectValue: select?.value ?? null,
        options: select ? [...select.options].map((o) => ({ v: o.value, t: o.textContent.trim() })) : [],
        tosChecked: tos?.checked ?? null,
        submitDisabled: find('start using axe')?.disabled ?? null,
      };

      if (select) {
        const option = [...select.options].find((o) => /developer/i.test(o.textContent));
        if (option) setNative(select, option.value);
      }
      if (tos) setNative(tos, true);

      return {
        docReady: document.readyState,
        bodyChildren: document.body.children.length,
        rootBox: (() => {
          const root = document.body.firstElementChild;
          if (!root) return null;
          const r = root.getBoundingClientRect();
          return { tag: root.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) };
        })(),
        before,
        submitChain: describe(find('start using axe')),
        structureChain: describe(find('structure')),
      };
    });

    await settle(1_500);
    const after = await frame.evaluate(() => {
      const submit = [...document.querySelectorAll('button')].find((b) =>
        /start using axe/i.test(b.textContent),
      );
      const select = document.querySelector('select');
      const tos = document.getElementById('terms-and-services-checkbox');
      return {
        selectValue: select?.value ?? null,
        tosChecked: tos?.checked ?? null,
        submitDisabled: submit?.disabled ?? null,
      };
    });

    console.log(`\ndocument       readyState=${report.docReady} bodyChildren=${report.bodyChildren}`);
    console.log(`root element   ${JSON.stringify(report.rootBox)}`);
    console.log(`\nbefore write   ${JSON.stringify(report.before.slice ? report.before : {
      selectValue: report.before.selectValue,
      tosChecked: report.before.tosChecked,
      submitDisabled: report.before.submitDisabled,
    })}`);
    console.log(`options        ${JSON.stringify(report.before.options)}`);
    console.log(`after write    ${JSON.stringify(after)}`);
    console.log(`\nsubmit chain   ${JSON.stringify(report.submitChain, null, 1)}`);
    console.log(`structure chain${JSON.stringify(report.structureChain, null, 1)}`);

    await writeFile('build/panel-diagnose.json', JSON.stringify({ tabState, iframeBox, report, after }, null, 2));
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
};

main().catch((e) => {
  console.error(e.stack ?? e.message);
  process.exitCode = 1;
});
