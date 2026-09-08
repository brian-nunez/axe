/**
 * The panel driver: every lifecycle trap the panel sets, in one place.
 *
 * The prototypes for tickets 007, 008, 009, 010 and 017 each carried their own
 * copy of these. They live here once, so the tool layer above them — and the
 * skill files above that — never has to know about any of it:
 *
 *   selectTab, not showView          `showView(id)` creates the target and
 *                                    leaves the tab unselected; the iframe then
 *                                    holds a 0x0 box and every action inside it
 *                                    fails as "not visible".
 *   layout is not a one-shot step    DevTools steals the tab back while it
 *                                    finishes starting up, so the panel
 *                                    document's own body box is sampled twice
 *                                    with a beat between.
 *   the onboarding chain             a fresh profile shows several dialogs in
 *                                    sequence, each intercepting pointer events
 *                                    for the whole panel. Clear the chain.
 *   dispatch, do not click           the panel's tooltip layer swallows a real
 *                                    pointer press on a button without raising.
 *   exact names, filtered            `Save Test` and `Save` are different
 *                                    buttons, and the panel keeps hidden and
 *                                    disabled duplicates of both in the DOM.
 *   aria-disabled counts             `Add Manual Issue` is aria-disabled while
 *                                    `button.disabled` reads false.
 *
 * `visible`, `actionable` and `named` are written out inside every in-page
 * snippet rather than shared. Playwright serialises one function across the CDP
 * boundary and the panel is an extension document, so a helper cannot be
 * imported and cannot be rebuilt with `new Function` under the extension's CSP.
 * Three repeated lines are the cost of that, and they are the same three lines.
 */

export const EXTENSION_ID = 'lhdoppojpmngadmnindnejefpokejbdd';

export const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function poll(fn, { timeoutMs = 30_000, everyMs = 250, what }) {
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

const selectTab = (dt, tabId) =>
  dt.evaluate(
    (id) =>
      import('./ui/legacy/legacy.js').then((UI) =>
        UI.InspectorView.InspectorView.instance().tabbedPane.selectTab(id, true),
      ),
    tabId,
  );

/** The panel document's own box, or null when the frame is gone or unlaid-out. */
async function laidOutFrame(dt) {
  const frame = dt.frames().find((f) => f.url().endsWith('/panel.html'));
  if (!frame) return null;
  const box = await frame
    .evaluate(() => {
      const r = document.body.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })
    .catch(() => null);
  return box && box.w > 0 && box.h > 0 ? frame : null;
}

/**
 * Select the panel and return its frame, once its own document holds layout and
 * still holds it a beat later.
 *
 * The iframe's box is not sufficient: it can report 554x693 while the panel
 * document inside it is still 0x0, and in that state every action fails.
 */
export async function selectPanel(dt, tabId, { timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await selectTab(dt, tabId).catch(() => {});
    for (let i = 0; i < 10; i += 1) {
      await settle(500);
      if (!(await laidOutFrame(dt))) continue;
      await settle(2_500);
      const still = await laidOutFrame(dt);
      if (still) return still;
      break;
    }
  }
  throw new Error('panel never held layout');
}

/** Find the DevTools page and the axe panel's tab id, both of which arrive late. */
export async function findPanelTab(context) {
  const dt = await poll(() => context.pages().find((p) => p.url().startsWith('devtools://')), {
    what: 'a devtools:// page',
  });
  const tabId = await poll(
    async () => (await listTabIds(dt).catch(() => [])).find((id) => id.includes(EXTENSION_ID)),
    { what: 'the axe panel to register' },
  );
  return { dt, tabId };
}

/**
 * Clear the onboarding dialog chain.
 *
 * The first dialog is gated: its submit stays disabled until a job role is
 * chosen and the terms box is ticked. The rest are dismissable. Each one
 * intercepts pointer events for the whole panel, so clearing one is never
 * enough.
 */
export async function clearOnboarding(frame) {
  const cleared = [];
  for (let i = 0; i < 6; i += 1) {
    const dialog = frame.locator('[role=dialog].Dialog--show').first();
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
      await role.selectOption('Developer').catch(() => {});
      await dialog
        .locator('#terms-and-services-checkbox')
        .check()
        .catch(() => {});
    }

    // Dispatched on the element, never a pointer click. The panel's own tooltip
    // layer swallows a real click on its buttons — no error, no effect — so a
    // pointer click here dismissed nothing and the loop simply ran six times
    // against the same dialog and reported all six as cleared.
    const acted = await dialog.evaluate((node) => {
      const wanted = [
        'start using axe devtools',
        'got it',
        'continue',
        'close',
        'accept',
        'ok',
      ];
      const button = [...node.querySelectorAll('button')].find((b) => {
        const label = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().toLowerCase();
        return !b.disabled && wanted.some((w) => label.includes(w));
      });
      if (!button) return null;
      button.click();
      return (button.getAttribute('aria-label') ?? button.textContent ?? '').trim();
    });

    if (acted === null) await frame.press('body', 'Escape').catch(() => {});
    await settle(1_500);

    // A dialog that is still up did not clear, and saying so beats reporting it
    // as cleared six times: the run is about to audit a page it cannot reach.
    const stillOpen =
      (await frame.locator('[role=dialog].Dialog--show').count()) > 0 &&
      (
        await frame
          .locator('[role=dialog].Dialog--show')
          .first()
          .locator('h1,h2,h3,[id^=dialog-title]')
          .first()
          .textContent()
          .catch(() => null)
      )?.trim() === title;

    if (stillOpen) {
      throw new Error(
        `onboarding dialog ${JSON.stringify(title)} did not close` +
          (acted ? ` after pressing ${JSON.stringify(acted)}` : ' and offered no button'),
      );
    }
    cleared.push(title);
  }
  return cleared;
}

const ANY_CONTROL = 'button,a,[role=tab],[role=button],[role=link]';

/**
 * Press a control by its exact accessible name.
 *
 * `selector` widens the search past `button`: the Overview / Guided Tests
 * switch is a tab, and the saved-tests list offers each test as an `<a>`.
 * `within` scopes it, because the manual issue form carries two visible
 * `Cancel` buttons and the save dialog carries its own `Save`. `siblingOf`
 * disambiguates two same-named controls on one screen by naming a control that
 * shares the wanted one's container.
 *
 * The name resolver reads `aria-labelledby` first: on a saved test's Guided
 * Tests tab an IGT is entered through an icon button with no text at all, whose
 * whole name arrives through a hidden tooltip it points at.
 */
export async function press(
  frame,
  label,
  { within = null, selector = 'button', settleMs = 3_000, siblingOf = null } = {},
) {
  const clicked = await frame.evaluate(
    ({ wanted, scope, sel, sibling }) => {
      const root = scope ? document.querySelector(scope) : document;
      if (!root) return null;
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const actionable = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      const named = (el) => {
        const by = el.getAttribute('aria-labelledby');
        if (by) {
          const text = by
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
            .trim();
          if (text) return text;
        }
        return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
      };

      let matches = [...root.querySelectorAll(sel)]
        .filter(visible)
        .filter(actionable)
        .filter((el) => named(el) === wanted);
      if (sibling && matches.length > 1) {
        const narrowed = matches.filter((el) =>
          [...(el.parentElement?.querySelectorAll('button') ?? [])].some(
            (b) => named(b) === sibling,
          ),
        );
        if (narrowed.length) matches = narrowed;
      }
      const match = matches[0];
      if (!match) return null;
      match.click();
      return (
        match.tagName.toLowerCase() +
        (match.getAttribute('role') ? `[role=${match.getAttribute('role')}]` : '')
      );
    },
    { wanted: label, scope: within, sel: selector, sibling: siblingOf },
  );
  if (!clicked) {
    throw new Error(`no visible, enabled control named ${JSON.stringify(label)}`);
  }
  await settle(settleMs);
  return clicked;
}

/** Press by exact name across every control kind the panel uses. */
export const pressAny = (frame, label, opts = {}) =>
  press(frame, label, { selector: ANY_CONTROL, ...opts });

/** Is there a visible, enabled control with this exact name? */
export const has = (frame, label, selector = ANY_CONTROL) =>
  frame
    .evaluate(
      ({ wanted, sel }) => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const actionable = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
        const named = (el) => {
          const by = el.getAttribute('aria-labelledby');
          if (by) {
            const text = by
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? '')
              .join(' ')
              .trim();
            if (text) return text;
          }
          return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
        };
        return [...document.querySelectorAll(sel)]
          .filter(visible)
          .filter(actionable)
          .some((el) => named(el) === wanted);
      },
      { wanted: label, sel: selector },
    )
    .catch(() => false);

/** Every named control on the current view, for when a name does not resolve. */
export const controls = (frame) =>
  frame
    .evaluate((sel) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const named = (el) => {
        const by = el.getAttribute('aria-labelledby');
        if (by) {
          const text = by
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
            .trim();
          if (text) return text;
        }
        return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
      };
      return [...document.querySelectorAll(sel)]
        .filter(visible)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          name: named(el).slice(0, 80),
          disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
        }))
        .filter((el) => el.name);
    }, ANY_CONTROL)
    .catch(() => []);

/** Open menu items, for the Options menu that holds `Save progress & quit`. */
export const menuItems = (frame) =>
  frame
    .evaluate(() =>
      [...document.querySelectorAll('[role=menuitem],[role=menu] li,[role=option]')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((el) => (el.textContent ?? '').trim())
        .filter(Boolean),
    )
    .catch(() => []);

/** Click the first open menu item whose text matches, dispatched on the element. */
export async function pressMenuItem(frame, pattern, { settleMs = 6_000 } = {}) {
  const clicked = await frame.evaluate((source) => {
    const re = new RegExp(source, 'i');
    const item = [...document.querySelectorAll('[role=menuitem],[role=menu] li,[role=option]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .find((el) => re.test(el.textContent ?? ''));
    if (!item) return null;
    item.click();
    return (item.textContent ?? '').trim();
  }, pattern.source ?? String(pattern));
  if (clicked) await settle(settleMs);
  return clicked;
}

/**
 * The panel document's own box, text and extension binding, with no clicks and
 * no navigation. The cheap liveness read every tool's guard starts from.
 */
export const panelBody = (frame) =>
  frame
    .evaluate(() => {
      const r = document.body.getBoundingClientRect();
      return {
        box: { w: Math.round(r.width), h: Math.round(r.height) },
        runtimeId: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || null,
      };
    })
    .catch((error) => ({ unreadable: error.message, box: { w: 0, h: 0 } }));

/**
 * Classify the screen showing and pull out everything an answer needs.
 *
 * Order matters. The results screen also carries a tree, the save dialog sits on
 * top of the results screen, and the page-state warning renders as a sibling of
 * a fully live question screen — so the warning is reported as a flag on the
 * screen underneath rather than as a screen of its own.
 *
 * `questionId` is the `name` on the answer radios: Deque's own identifier for
 * the question. `step` is reported and nothing routes on it — one step number
 * spans several screens and inapplicable steps never render at all.
 */
export const readScreen = (frame) =>
  frame
    .evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const actionable = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      const named = (el) => {
        const by = el.getAttribute('aria-labelledby');
        if (by) {
          const text = by
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
            .trim();
          if (text) return text;
        }
        return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
      };

      /**
       * Which element a per-element row is asking about.
       *
       * The row is a pill carrying the element's tag and its text, and the
       * yes/no radiogroup beside it points at that pill by id:
       * `aria-labelledby="<n>-accessible-name question-text"`. That attribute is
       * the anchor, because the panel's class names are hashed and the pill has
       * no ancestor that `closest('li,tr,fieldset,[role=group]')` matches — the
       * nearest match was the `<label>` around the radio, so every group on
       * every grid came back labelled "Yes" and the model was answering six
       * indistinguishable rows.
       *
       * Text is gathered leaf by leaf rather than as one `textContent`, because
       * the tag and the text are separate elements and running them together
       * reads `H1Quarterly accessibility notes`.
       */
      const rowLabel = (input) => {
        const group = input.closest('[role=radiogroup]');
        const holder = (group?.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .find((el) => el && el.contains(input));
        const scope = holder ?? group?.parentElement ?? input.parentElement;
        if (!scope) return null;
        const parts = [];
        const walk = (node) => {
          for (const child of node.children) {
            if (child.getAttribute('role') === 'radiogroup' || child.tagName === 'BUTTON') continue;
            if (child.children.length) walk(child);
            else {
              const own = (child.textContent ?? '').trim();
              if (own) parts.push(own);
            }
          }
        };
        walk(scope);
        return parts.join(' ').slice(0, 300) || null;
      };

      const text = document.body.innerText;
      const buttons = [...document.querySelectorAll('button')]
        .filter(visible)
        .filter(actionable)
        .map(named)
        .filter(Boolean);

      const step =
        [...document.querySelectorAll('button[aria-current=step]')]
          .map((b) => b.textContent.trim())
          .find(Boolean) ?? null;

      const base = {
        step,
        question: document.getElementById('question-text')?.textContent.trim() ?? null,
        help: document.getElementById('question-help')?.textContent.trim() ?? null,
        buttons,
        pageStateChanged: /The state of your page has changed/i.test(text),
      };

      const dialog = [...document.querySelectorAll('[role=dialog]')].filter(visible).pop();
      if (dialog && dialog.querySelector('input')) return { ...base, kind: 'save_dialog' };

      if (buttons.includes('Finish')) {
        // An issue row is a row that still says something once its own controls
        // are taken out of it. Reading every visible `li` instead picks up the
        // seven stepper buttons and each row's Highlight / Inspect / More info,
        // which is how a one-issue results screen reports eleven.
        const candidates = [];
        for (const row of document.querySelectorAll('li,tr,[role=listitem]')) {
          if (!visible(row)) continue;
          const clone = row.cloneNode(true);
          for (const control of clone.querySelectorAll('button,a')) control.remove();
          const title = clone.textContent
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^\d+\s*/, '');
          if (title.length >= 20) candidates.push(title);
        }
        // A nested row's text is also inside its container's, so only the
        // longest form of each finding is kept.
        const issueLines = candidates.filter(
          (title, index) =>
            candidates.indexOf(title) === index &&
            !candidates.some((other) => other !== title && other.includes(title)),
        );
        return {
          ...base,
          kind: 'results',
          summary: text.replace(/\n{3,}/g, '\n\n').trim(),
          issueLines,
        };
      }

      if (/Fields selected:/.test(text)) {
        return {
          ...base,
          kind: 'element_picker',
          alreadySelected: Number(text.match(/Fields selected:\s*(\d+)/)?.[1] ?? 0),
          mouseSelection:
            document
              .querySelector('[role=switch][aria-label="Mouse Selection"]')
              ?.getAttribute('aria-checked') === 'true',
          readBack: (text.match(/Fields selected:\s*\d+\s*\n([\s\S]{0,400})/) ?? [])[1] ?? null,
        };
      }

      const multi = [...document.querySelectorAll('[role=checkbox][id^=selection-]')].filter(
        visible,
      );
      if (multi.length) {
        return {
          ...base,
          kind: 'element_multiselect',
          // No question id. `questionId` is Deque's own identifier, read off the
          // `name` on the answer radios; a multi-select's controls are named
          // `selection-<n>` for the panel's element index, which identifies an
          // element and not a question. Writing the screen shape into this slot
          // instead put a constant of ours where a Deque id belongs — it keyed
          // the evidence policy on a screen shape, which is the wrong
          // granularity, and it made the "unmapped question id" log cry wolf on
          // every run, which is how a log that exists to announce a new Deque
          // question stops being read.
          questionId: null,
          options: multi.map((el) => ({
            ref: el.id,
            label: el.textContent.trim(),
            checked: el.getAttribute('aria-checked') === 'true',
          })),
        };
      }

      const grid = [...document.querySelectorAll('input[type=radio]')].filter((el) =>
        /^(thumbnail-)?yes-no-/.test(el.getAttribute('name') ?? ''),
      );
      if (grid.length) {
        return {
          ...base,
          kind: 'per_element',
          // No question id, for the same reason: these radios are named
          // `yes-no-<n>` / `thumbnail-yes-no-<n>` for the panel's own element
          // index, which 008 measured is not even list order. `kind` already
          // carries the screen's identity.
          questionId: null,
          groups: [...new Set(grid.map((el) => el.getAttribute('name')))].map((group) => {
            const members = grid.filter((el) => el.getAttribute('name') === group);
            const checked = members.find((el) => el.checked);
            return {
              ref: group,
              label: (members[0] && rowLabel(members[0])) ?? '',
              answered: checked ? (checked.id.startsWith('true-') ? 'yes' : 'no') : null,
            };
          }),
        };
      }

      const single = document.getElementById('yes-igt-radio');
      if (single) {
        return {
          ...base,
          kind: 'single_choice',
          questionId: single.getAttribute('name'),
          options: [...document.querySelectorAll('#yes-igt-radio,#no-igt-radio')].map((el) => ({
            value: el.id === 'yes-igt-radio' ? 'yes' : 'no',
            label: document.querySelector(`label[for="${el.id}"]`)?.textContent.trim() ?? el.value,
            checked: el.checked,
          })),
        };
      }

      if (/TOTAL ISSUES/.test(text)) return { ...base, kind: 'overview' };
      if (/Intelligent Guided Tests/i.test(text) && /Testing Progress/i.test(text)) {
        return { ...base, kind: 'overview_igt' };
      }
      if (buttons.includes('Scan full page')) return { ...base, kind: 'scan' };
      if (/Guided Testing:/i.test(text)) return { ...base, kind: 'igt_entry' };
      return { ...base, kind: 'unknown', text: text.slice(0, 1200) };
    })
    .catch((error) => ({ kind: 'unreadable', error: error.message, buttons: [] }));

/** The screens that mean a guided test is still in progress. */
export const IGT_SCREENS = new Set([
  'single_choice',
  'per_element',
  'element_multiselect',
  'element_picker',
  'results',
]);
