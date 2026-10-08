// Helper library for the `aside repl` session of a scenario. lib.sh evaluates this file once per
// session; afterwards every step of a scenario is one short line such as
//
//   M.out(await M.click("A", "move-E", 10000))
//
// Rules of this file:
//   - It uses only the calls that 00-capability-probe.sh verified by a real action: openTab,
//     closeTab, page.evaluate, page.locator(sel).click/fill/selectOption, page.keyboard.press,
//     page.reload, page.goto(url, { waitUntil: 'load' }), page.screenshot, sleep.
//   - It never touches a tab it did not open: no listBrowserTabs, no attachBrowserTab, no
//     attachActiveBrowserTab, and none of the account-connected globals of the REPL.
//   - Inside a page it reads the DOM and touches only localStorage keys that start with "maze:",
//     and (setValue) the value of one of the app's own form fields, such as the hidden client
//     seed, which Playwright's fill refuses because it is not visible.
//   - Every result leaves through M.out as one line "@@R <json>", which lib.sh parses.
//   - ASCII only: the file travels to the REPL as base64.

globalThis.M = (() => {
  /** Tabs this session opened, by the name the scenario gave them. */
  const pages = {};

  const sel = (id) => '[data-testid="' + id + '"]';

  const out = (value) => {
    console.log('@@R ' + JSON.stringify(value === undefined ? null : value));
  };

  const page = (name) => {
    const p = pages[name];
    if (!p) throw new Error('no tab named "' + name + '" in this session');
    return p;
  };

  // ----- functions evaluated inside the page (they must be self-contained) -----

  /** The same reading the app's TestBeacon takes: text (or form value) and attributes. */
  const readInPage = (ids) => {
    const result = {};
    for (const id of ids) {
      const el = document.querySelector('[data-testid="' + id + '"]');
      if (!el) {
        result[id] = null;
        continue;
      }
      const attrs = {};
      for (const attr of Array.from(el.attributes)) {
        if (attr.name === 'data-testid' || attr.name === 'class' || attr.name === 'style') continue;
        attrs[attr.name] = attr.value;
      }
      const form = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
      result[id] = {
        text: form ? el.value : (el.textContent || '').replace(/\s+/g, ' ').trim(),
        attrs,
        disabled: el.disabled === true,
        // Laid out at all (a display: none chip or a hidden input has no boxes).
        visible: el.getClientRects().length > 0,
      };
    }
    return result;
  };

  /** Every element whose data-testid starts with the prefix, in document order. */
  const listInPage = (prefix) => {
    const items = [];
    for (const el of Array.from(document.querySelectorAll('[data-testid^="' + prefix + '"]'))) {
      const attrs = {};
      for (const attr of Array.from(el.attributes)) {
        if (attr.name === 'data-testid' || attr.name === 'class' || attr.name === 'style') continue;
        attrs[attr.name] = attr.value;
      }
      items.push({
        id: el.getAttribute('data-testid'),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        attrs,
      });
    }
    return items;
  };

  const storageInPage = (request) => {
    const own = (key) => typeof key === 'string' && key.indexOf('maze:') === 0;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (own(key)) keys.push(key);
    }
    if (request.op === 'keys') return keys;
    if (request.op === 'get') return own(request.key) ? localStorage.getItem(request.key) : null;
    if (request.op === 'clear') {
      for (const key of keys) localStorage.removeItem(key);
      return keys.length;
    }
    throw new Error('unknown storage operation');
  };

  /**
   * Sets a form field of the app the way a script would, then fires `input` and `change` so the
   * page's own native listeners see it (the app's fields listen natively, not through React).
   */
  const setValueInPage = (request) => {
    const el = document.querySelector('[data-testid="' + request.id + '"]');
    if (!el) return { ok: false, reason: 'not in the DOM' };
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return { ok: false, reason: 'not a text field' };
    el.value = request.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: el.value === request.value, value: el.value };
  };

  /** Records the game API calls this page makes from now on (scenario 08 reads the refusal). */
  const hookFetchInPage = () => {
    if (window.__mazeE2E) return window.__mazeE2E.calls.length;
    const calls = [];
    const original = window.fetch.bind(window);
    window.__mazeE2E = { calls };
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const response = await original(input, init);
      if (String(url).indexOf('/api/games/') !== -1 && init && init.method === 'POST') {
        let body = null;
        try {
          body = await response.clone().json();
        } catch (error) {
          body = null;
        }
        calls.push({
          url: String(url),
          status: response.status,
          request: typeof init.body === 'string' ? init.body : null,
          body,
        });
      }
      return response;
    };
    return 0;
  };

  // ----- session-side helpers -----

  async function open(name, url) {
    if (pages[name]) throw new Error('a tab named "' + name + '" is already open');
    const p = await openTab(url);
    pages[name] = p;
    return { name, targetId: p.targetId, url: await p.url() };
  }

  async function close(name) {
    const p = page(name);
    delete pages[name];
    await closeTab(p);
    return { open: Object.keys(pages).length, tracked: tabs.length };
  }

  /** Closes every tab this session opened. Never throws: teardown must get to the end. */
  async function closeAll() {
    const errors = [];
    for (const name of Object.keys(pages)) {
      try {
        await closeTab(pages[name]);
      } catch (error) {
        errors.push(name + ': ' + String((error && error.message) || error));
      }
      delete pages[name];
    }
    return { tracked: tabs.length, errors };
  }

  async function read(name, ids) {
    return page(name).evaluate(readInPage, ids);
  }

  async function list(name, prefix) {
    return page(name).evaluate(listInPage, prefix);
  }

  const matches = (item, cond) => {
    if (cond.present === false) return item === null;
    if (item === null) return false;
    if (cond.enabled === true && item.disabled) return false;
    if (cond.attr !== undefined) {
      const value = item.attrs[cond.attr];
      if (cond.equals !== undefined && value !== cond.equals) return false;
      if (cond.notEquals !== undefined && (value === undefined || value === cond.notEquals)) return false;
    }
    if (cond.text !== undefined && item.text !== cond.text) return false;
    return true;
  };

  /**
   * Polls the DOM until `cond` holds: { id, present?, enabled?, attr?, equals?, notEquals?, text? }.
   * Answers { ok, waitedMs, item } instead of throwing, so the caller can report what was there.
   */
  async function waitFor(name, cond, timeoutMs) {
    const p = page(name);
    const started = Date.now();
    let item = null;
    let lastError = null;
    for (;;) {
      try {
        item = (await p.evaluate(readInPage, [cond.id]))[cond.id];
        lastError = null;
        if (matches(item, cond)) return { ok: true, waitedMs: Date.now() - started, item };
      } catch (error) {
        // A page that is navigating has no document to read for a moment.
        lastError = String((error && error.message) || error);
      }
      if (Date.now() - started >= timeoutMs) {
        return { ok: false, waitedMs: Date.now() - started, item, error: lastError };
      }
      await sleep(100);
    }
  }

  async function click(name, id, timeoutMs) {
    const ready = await waitFor(name, { id, enabled: true }, timeoutMs === undefined ? 10000 : timeoutMs);
    if (!ready.ok) {
      return { ok: false, reason: ready.item === null ? 'not in the DOM' : 'disabled', item: ready.item };
    }
    await page(name).locator(sel(id)).click();
    return { ok: true, waitedMs: ready.waitedMs };
  }

  async function fill(name, id, value) {
    const ready = await waitFor(name, { id, enabled: true }, 10000);
    if (!ready.ok) return { ok: false, reason: ready.item === null ? 'not in the DOM' : 'disabled' };
    await page(name).locator(sel(id)).fill(value);
    const after = (await read(name, [id]))[id];
    return { ok: after !== null && after.text === value, value: after === null ? null : after.text };
  }

  async function setValue(name, id, value) {
    return page(name).evaluate(setValueInPage, { id, value });
  }

  async function select(name, id, value) {
    await page(name).locator(sel(id)).selectOption(value);
    const after = (await read(name, [id]))[id];
    return { ok: after !== null && after.text === value, value: after === null ? null : after.text };
  }

  /** A key press that reaches the page's window listener (focus is taken off any form field). */
  async function press(name, key) {
    const p = page(name);
    await p.evaluate(() => {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) el.blur();
    });
    await p.keyboard.press(key);
    return { ok: true };
  }

  /** Clicks in two tabs at once and answers when both clicks were delivered. */
  async function race(nameA, idA, nameB, idB) {
    const results = await Promise.all([click(nameA, idA, 5000), click(nameB, idB, 5000)]);
    return { a: results[0], b: results[1] };
  }

  async function storage(name, op, key) {
    return page(name).evaluate(storageInPage, { op, key: key === undefined ? null : key });
  }

  async function hookFetch(name) {
    return page(name).evaluate(hookFetchInPage);
  }

  async function calls(name) {
    return page(name).evaluate(() => (window.__mazeE2E ? window.__mazeE2E.calls : []));
  }

  async function reload(name) {
    await page(name).reload();
    return { url: await page(name).url() };
  }

  async function go(name, url) {
    // The default wait of goto can time out on a page without interactive elements.
    await page(name).goto(url, { waitUntil: 'load', timeout: 20000 });
    return { url: await page(name).url() };
  }

  async function url(name) {
    return page(name).url();
  }

  /** Saves a screenshot in the session directory (the only place the REPL may write). */
  async function shot(name, file) {
    await page(name).screenshot({ path: file });
    const stat = await fs.stat(file);
    return { path: pwd + '/' + file, size: stat.size };
  }

  return {
    out,
    open,
    close,
    closeAll,
    read,
    list,
    waitFor,
    click,
    fill,
    setValue,
    select,
    press,
    race,
    storage,
    hookFetch,
    calls,
    reload,
    go,
    url,
    shot,
    names: () => Object.keys(pages),
  };
})();
