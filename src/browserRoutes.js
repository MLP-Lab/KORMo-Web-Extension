/**
 * browserRoutes.js — what each routed hotkey actually does, and the English
 * sentence the model is told about it.
 *
 * WHY THE RESULT STRING IS THE POINT. The transcript answers every action with
 * "Succeed: `click` executed." — one fixed sentence that carries no
 * information. For a click that is fine, because the next screenshot shows the
 * consequence. For these it is not: "page zoom 100% → 90%" and
 * "Find results: 1/73" are facts the model's NEXT step depends on and that a
 * screenshot states only indirectly. So every route here returns the sentence
 * it wants said, and the run loop hands it to the transcript in place of the
 * fixed one. An action with nothing richer to say returns nothing and the
 * transcript falls back, byte for byte, to what it sends today.
 *
 * AND WHY SOME OF THEM SAY "Failed:". Ctrl+P, Ctrl+S and Ctrl+D open OS or
 * browser dialogs. A dialog cannot appear in Page.captureScreenshot, so a
 * model that believed one opened would be blind for the rest of the run. The
 * training data only ever says Succeed, but a Succeed here would teach the
 * model that a closed path is open; a Failed is how it learns to stop trying.
 *
 * DEPENDENCIES ARE INJECTED rather than imported, because every one of them is
 * a browser global — chrome.tabs, the debugger, the page — and injecting them
 * is what lets the whole routing table be tested against stubs.
 */

import { resolveHotkey, BLOCKED_ROUTES, stepZoom, DEFAULT_ZOOM } from './browserKeys.js';
import { readableUrl } from './modelProfile.js';

/** Chrome pages that are useful to OPEN even though we cannot drive them. */
const CHROME_PAGES = Object.freeze({
  downloads: { url: 'chrome://downloads/', what: 'downloads' },
  history: { url: 'chrome://history/', what: 'history' },
  clear_data: { url: 'chrome://settings/clearBrowserData', what: 'clear browsing data' },
});

/** Schemes a tab must have before the debugger will attach to it. */
const DRIVABLE = /^(https?|file):/i;

const originOf = (url) => {
  try { return new URL(String(url)).origin; } catch (_) { return null; }
};

/**
 * What the address bar should navigate to.
 *
 * Chrome's omnibox rule, as far as it concerns us: something that parses as an
 * absolute URL is one, something shaped like a host becomes https://, and
 * anything else is a search. The scheme check is the SAME one cdp.navigate
 * makes and is repeated here on purpose — a model-supplied `javascript:` has
 * to be refused with a sentence the model can read, before navigate throws an
 * exception that would end the run.
 *
 * @returns {{url: string}|{search: string}|{refuse: string}}
 */
export function resolveAddress(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { refuse: '' };

  // "localhost:3000" and "example.com:8080" parse as a SCHEME to new URL —
  // the port digits look like an opaque path — so host:port is recognized
  // before the scheme branch, or a dev server is refused as protocol
  // "localhost:". Chrome's omnibox navigates both.
  const hostPort = /^(?!\d+$)[\w-]+(\.[\w-]+)*:\d+([/?#]|$)/.test(raw);

  if (!hostPort && /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    let parsed;
    try { parsed = new URL(raw); } catch (_) { return { search: raw }; }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return { url: parsed.href };
    return { refuse: parsed.protocol };
  }
  // host.tld, host.tld:port, host.tld/path — but NOT "find my keys" or "1.5".
  //
  // The TLD must be alphabetic, which is what excludes a decimal number. It
  // reads like a host to the old pattern and new URL() then widens it into an
  // address: "1.5" became https://1.0.0.5/, an IP the model never asked for.
  // A literal IPv4 is spelled out separately rather than swept in by it.
  const host = /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?([/?#]|$)/i;
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/;
  if (!/\s/.test(raw) && (hostPort || host.test(raw) || ipv4.test(raw))) {
    // https for everything except loopback, which is what Chrome does too: a
    // dev server almost never has a certificate, so guessing https there turns
    // a working address into a connection error.
    const scheme = /^(localhost|127\.0\.0\.1|\[::1\])([:/?#]|$)/i.test(raw) ? 'http://' : 'https://';
    try { return { url: new URL(scheme + raw).href }; } catch (_) { /* fall through */ }
  }
  return { search: raw };
}

/** Exported so `goto` falls back the same way the address bar does. */
export const googleSearch = (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q);

/**
 * @param {object} deps
 * @param {object} deps.cdp              src/cdp.js, or a stub of it
 * @param {object} deps.chrome           the extension API
 * @param {(tabId:number, method:string, ...args:any[]) => Promise<any>} deps.ui
 *        calls one method on the page's __guiAgentBrowserUi
 * @param {(message:string) => void} deps.log  operator-facing, Korean
 * @param {(tabId:number, url:string, title:string) => Promise<boolean>} deps.switchTab
 *        moves the debugger; the run loop owns it because the handover is
 *        already written there
 */
export function createBrowserRoutes({ cdp, chrome, ui, log, switchTab }) {
  /**
   * origin -> zoom percent.
   *
   * THE ONE PIECE OF WIDGET STATE THAT IS NOT IN THE PAGE. `style.zoom` dies
   * with the document, and the capability list requires a zoom to survive a
   * navigation within the same site, so the ladder position has to outlive the
   * page that shows it. Keyed on origin rather than per tab because that is
   * what Chrome's own zoom does: zoom out on one 쿠팡 page and every 쿠팡 page
   * is zoomed.
   */
  const zoomByOrigin = new Map();

  /**
   * Tabs of this window the run can actually drive, in Chrome's own order.
   *
   * UNDRIVABLE TABS ARE NOT LISTED. chrome://, view-source: and the Web Store
   * refuse the debugger, so a model that picks one gets a refusal and has
   * spent a step — and worse, their presence shifts every other number. The
   * operator's own chrome://extensions tab made the panel send
   * `Current tab: 1` for a single task tab, a shape the model had never
   * read.
   *
   * Filtering HERE and not at the point of display is what keeps the one
   * numbering honest: the observation numbers this array, switch_tab indexes
   * this array, and Ctrl+Tab walks it.
   */
  async function listTabs(drivenTabId) {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs
      .slice()
      .filter((tab) => DRIVABLE.test(tab.url || tab.pendingUrl || '') || tab.id === drivenTabId)
      .sort((a, b) => a.index - b.index)
      .map((tab) => ({
        id: tab.id,
        index: tab.index,
        url: tab.url || tab.pendingUrl || '',
        title: tab.title || '',
        // The DRIVEN tab, not Chrome's own active flag: if the user clicks
        // another tab mid-run the debugger stays where it is, and the
        // observation has to describe the tab the model's actions land on.
        active: tab.id === drivenTabId,
      }));
  }

  /**
   * Re-apply this origin's zoom, which is how a zoom survives a navigation:
   * `style.zoom` lives on the document and the document is gone.
   *
   * @returns {Promise<number|null>} the zoom it just SET, or null when nothing
   *   had to change. The caller needs that distinction because a zoom applied
   *   after a screenshot was taken is a zoom the model cannot see, so a change
   *   means the picture has to be taken again.
   */
  async function applyStoredZoom(tabId, url) {
    const origin = originOf(url);
    if (!origin || !zoomByOrigin.has(origin)) return null;
    const want = zoomByOrigin.get(origin);
    try {
      if (Number(await ui(tabId, 'getZoom')) === want) return null;
      await ui(tabId, 'setZoom', want);
      return want;
    } catch (_) {
      // A page we cannot reach is not a reason to stop the run; the next step
      // tries again.
      return null;
    }
  }

  async function snapshot(tabId) {
    try { return await ui(tabId, 'snapshot'); } catch (_) { return null; }
  }

  const ok = (result) => ({ ok: true, result });
  const no = (result) => ({ ok: false, result });

  /* ---------------------------------------------------------------- */
  /* Tab movement                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Step to the neighbouring tab, wrapping, skipping any Chrome will not let
   * the debugger attach to. Skipping is logged rather than silent: "Ctrl+Tab
   * did nothing" with no reason is the failure this whole change exists to
   * stop.
   */
  async function stepTab(tabId, direction, tabs) {
    const list = tabs || await listTabs(tabId);
    if (list.length < 2) return ok('Succeed: only one tab is open, so there is nothing to switch to.');
    const at = list.findIndex((t) => t.id === tabId);
    const from = at === -1 ? 0 : at;

    for (let hop = 1; hop < list.length; hop += 1) {
      // POSITION IN THIS ARRAY, not tab.index. The observation numbers these
      // lines by position and switchToIndex reads the same array, so a report
      // phrased in Chrome's own numbering would be a second numbering that
      // agrees right up until it does not.
      const pos = (((from + direction * hop) % list.length) + list.length) % list.length;
      const next = list[pos];
      if (!DRIVABLE.test(next.url)) {
        log(`탭 ${pos}("${next.url || '주소 없음'}")에는 디버거를 연결할 수 없어 건너뜁니다.`);
        continue;
      }
      if (await switchTab(next.id, next.url, next.title)) {
        return { ...ok(`Succeed: switched to tab ${pos}: ${readableUrl(next.url)}.`), tabId: next.id, pos };
      }
      log(`탭 ${pos}("${next.url}")에 디버거를 연결하지 못해 건너뜁니다.`);
    }
    return ok('Succeed: no other tab could be switched to; the run stays on this one.');
  }

  async function openBackgroundTab(url, what) {
    const tab = await chrome.tabs.create({ url, active: false });
    const list = await listTabs(tab.id).catch(() => null);
    const pos = list ? list.findIndex((t) => t.id === tab.id) : -1;
    return ok(`Succeed: opened ${what} in a new tab (tab ${pos === -1 ? tab.index : pos}: ${readableUrl(url)}).`);
  }

  /* ---------------------------------------------------------------- */
  /* The three tab actions, which arrive by two roads                  */
  /* ---------------------------------------------------------------- */

  /*
   * Ctrl+T and `new_tab` are the same action. One is a chord the model learned
   * from a keyboard, the other a tool the 21-tool schema declares, and if each
   * had its own implementation the two would disagree the first time one was
   * fixed — about which url a new tab gets, about whether the run follows it,
   * about what the model is told afterwards. So the hotkey table calls these
   * and so does the executor.
   */

  /** Open a blank tab and move the run to it. */
  async function newTab() {
    // about:blank, not the new-tab page: chrome://newtab refuses the
    // debugger, so a run that opened one would have nowhere to go. Blank
    // is attachable, and Ctrl+L on it is a working next step.
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    const moved = await switchTab(tab.id, 'about:blank', '');
    return ok(moved
      ? `Succeed: opened a new tab (tab ${tab.index}: about:blank) and switched to it.`
      : `Succeed: opened a new tab (tab ${tab.index}: about:blank); the run stays on the current tab.`);
  }

  /** Close the driven tab, after the run has somewhere else to stand. */
  async function closeTab(tabId) {
    const tabs = await listTabs(tabId);
    if (tabs.length < 2) {
      return no('Failed: this is the last tab; closing it would leave the run ' +
        'with no page to drive, so it was not closed.');
    }
    const closingPos = Math.max(0, tabs.findIndex((t) => t.id === tabId));
    const closing = tabs[closingPos];
    // Move FIRST, close second. The run loop treats the driven tab closing
    // as a reason to abort, and by the time Chrome fires that event the
    // debugger is already somewhere else, so a deliberate close reads as
    // what it is rather than as the tab being yanked away.
    const moved = await stepTab(tabId, 1, tabs);
    if (!moved.result.startsWith('Succeed: switched')) {
      return no(`Failed: no other tab could be driven, so tab ${closing.index} ` +
        'was left open rather than leaving the run with no page.');
    }
    await chrome.tabs.remove(closing.id).catch(() => {});

    // RE-NUMBER AFTER THE CLOSE. stepTab ran while the closing tab was still
    // open, so every tab to its right was one higher than it is now. Reporting
    // that stale number told the model it had landed on "tab 3" of a window
    // whose last tab was 2 — observed on 다방, where it then spent four steps
    // reasoning about a tab that did not exist.
    const after = await listTabs(moved.tabId).catch(() => null);
    const landedAt = after ? after.findIndex((t) => t.id === moved.tabId) : -1;
    const landed = landedAt === -1
      ? moved.result.slice('Succeed: '.length)
      : `switched to tab ${landedAt}: ${readableUrl(after[landedAt].url)}.`;
    return ok(`Succeed: closed tab ${closingPos}; ${landed}`);
  }

  /**
   * Switch to the tab the model named by number.
   *
   * THE NUMBER IS THE OBSERVATION'S. `- Tab 2: …` in the tab block is this
   * list's POSITION, because src/modelProfile.js numbers the lines it is handed
   * and this function is what hands them over. Indexing the same array is what
   * makes "tab 2" mean one thing; reading `tab.index` instead would be a second
   * numbering that agrees until the day it does not.
   */
  async function switchToIndex(tabId, index) {
    const list = await listTabs(tabId);
    const target = list[index];
    if (!target) {
      return no(`Failed: there is no tab ${index}; the open tabs are 0-${list.length - 1}.`);
    }
    if (target.id === tabId) return ok(`Succeed: already on tab ${index}: ${readableUrl(target.url)}.`);
    if (!DRIVABLE.test(target.url)) {
      log(`탭 ${index}("${target.url || '주소 없음'}")에는 디버거를 연결할 수 없습니다.`);
      return no(`Failed: tab ${index} ("${readableUrl(target.url) || 'no address'}") cannot be driven, ` +
        'so the run stays on the current tab.');
    }
    if (!await switchTab(target.id, target.url, target.title)) {
      return no(`Failed: the debugger would not attach to tab ${index} (${readableUrl(target.url)}), ` +
        'so the run stays on the current tab.');
    }
    return ok(`Succeed: switched to tab ${index}: ${readableUrl(target.url)}.`);
  }

  /* ---------------------------------------------------------------- */
  /* The widget routes                                                 */
  /* ---------------------------------------------------------------- */

  const findLine = (state) => `${state.index}/${state.total}`;

  async function runFindEnter(tabId, backwards) {
    const state = await ui(tabId, 'findStep', backwards ? -1 : 1);
    if (!state || !state.total) return ok('Succeed: the find bar has no matches to step through.');
    return ok(`Succeed: find ${backwards ? 'previous' : 'next'} match (${findLine(state)}).`);
  }

  async function runAddressEnter(tabId, value) {
    const target = resolveAddress(value);
    if (target.refuse !== undefined) {
      return no(target.refuse
        ? `Failed: the address bar refuses "${target.refuse}" URLs; only http and https can be navigated to.`
        : 'Failed: the address bar is empty, so there is nothing to navigate to.');
    }
    const url = target.url || googleSearch(target.search);
    const href = await cdp.navigate(tabId, url);
    await ui(tabId, 'closeAddress').catch(() => {});
    return { ...ok(`Succeed: goto_url navigated to ${readableUrl(href)}.`), navigated: true };
  }

  async function runZoom(tabId, url, direction) {
    const origin = originOf(url);
    const current = (origin && zoomByOrigin.has(origin))
      ? zoomByOrigin.get(origin)
      : Number(await ui(tabId, 'getZoom')) || DEFAULT_ZOOM;
    const next = stepZoom(current, direction);
    await ui(tabId, 'setZoom', next);
    if (origin) zoomByOrigin.set(origin, next);

    if (next !== current) return ok(`Succeed: page zoom ${current}% → ${next}%.`);
    if (direction === 0) return ok(`Succeed: page zoom is already ${DEFAULT_ZOOM}%.`);
    return ok(`Succeed: page zoom ${current}% → ${next}% (already at the ${direction < 0 ? 'minimum' : 'maximum'}).`);
  }

  /* ---------------------------------------------------------------- */
  /* The table                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Run the hotkey if it is one of ours.
   *
   * @param {number} tabId
   * @param {string[]} keys as the model spelled them
   * @param {{url: string, title: string}} view the tab as this step observed it
   * @returns {Promise<{ok: boolean, result: string, combo: string}|null>} null
   *   means NOT OURS — the caller sends the chord to cdp.hotkey unchanged, so
   *   ctrl+a, Enter and Tab keep behaving exactly as they do today.
   */
  async function route(tabId, keys, view = {}) {
    const hit = resolveHotkey(keys);
    if (!hit) return null;
    const url = view.url || '';

    // Enter / Shift+Enter / Escape are only ours while a widget is on screen.
    if (hit.widgetOnly) {
      const state = await snapshot(tabId);
      // Two different questions, deliberately. Enter and F3 act on the widget
      // that holds the KEYBOARD — stealing a bare Enter from a page the model
      // has clicked into would break form submission. Escape acts on the
      // widget that is merely ON SCREEN, because a bar the model can see and
      // cannot dismiss is worse than an Escape the page does not receive.
      const open = state && (state.find.open ? 'find' : state.address.open ? 'address' : null);
      const target = hit.route === 'widget_close' ? open : (state && state.focused);
      if (!target) return null;
      if (hit.route === 'widget_close') {
        await ui(tabId, target === 'find' ? 'closeFind' : 'closeAddress');
        return { combo: hit.combo, ...ok(`Succeed: ${target} bar closed.`) };
      }
      if (target === 'address') {
        return { combo: hit.combo, ...await runAddressEnter(tabId, state.address.value) };
      }
      return { combo: hit.combo, ...await runFindEnter(tabId, hit.route === 'widget_prev') };
    }

    if (Object.prototype.hasOwnProperty.call(BLOCKED_ROUTES, hit.route)) {
      return {
        combo: hit.combo,
        ...no(`Failed: hotkey ${hit.combo} ${BLOCKED_ROUTES[hit.route]}, so it was not pressed.`),
      };
    }

    switch (hit.route) {
      case 'find': {
        widgetTabs.add(tabId);
        const state = await ui(tabId, 'openFind');
        return { combo: hit.combo, ...ok(state && state.total
          ? `Succeed: find bar opened (${findLine(state)}). Type to search the page.`
          : 'Succeed: find bar opened. Type to search the page.') };
      }

      case 'zoom_out': return { combo: hit.combo, ...await runZoom(tabId, url, -1) };
      case 'zoom_in': return { combo: hit.combo, ...await runZoom(tabId, url, 1) };
      case 'zoom_reset': return { combo: hit.combo, ...await runZoom(tabId, url, 0) };

      case 'address': {
        widgetTabs.add(tabId);
        await ui(tabId, 'openAddress', url);
        return { combo: hit.combo, ...ok(`Succeed: address bar opened showing ${readableUrl(url)}, selected. ` +
          'Type to replace it, then press Enter.') };
      }

      case 'reload': {
        // chrome.tabs.reload rather than Page.reload: the bypass-cache variants
        // (Ctrl+Shift+R, Ctrl+F5) are one flag here and the debugger session
        // survives it either way.
        const hard = /shift|f5$/.test(hit.combo) && hit.combo !== 'f5';
        await chrome.tabs.reload(tabId, { bypassCache: hard });
        return { combo: hit.combo, ...ok(`Succeed: page reloaded (${readableUrl(url)}).`) };
      }

      // Ctrl+T and Ctrl+W are the chord spelling of the new_tab and close_tab
      // tools; both roads end in the same function.
      case 'new_tab': return { combo: hit.combo, ...await newTab() };
      case 'close_tab': return { combo: hit.combo, ...await closeTab(tabId) };

      case 'next_tab': return { combo: hit.combo, ...await stepTab(tabId, 1) };
      case 'prev_tab': return { combo: hit.combo, ...await stepTab(tabId, -1) };

      case 'back':
      case 'forward': {
        const direction = hit.route === 'back' ? 'back' : 'forward';
        const moved = await cdp.navigateHistory(tabId, direction);
        return { combo: hit.combo, ...ok(moved === null
          ? `Succeed: no page to go ${direction} to.`
          : `Succeed: went ${direction} to ${moved}.`) };
      }

      case 'downloads':
      case 'history':
      case 'clear_data': {
        const page = CHROME_PAGES[hit.route];
        return { combo: hit.combo, ...await openBackgroundTab(page.url, page.what) };
      }

      case 'view_source': {
        if (!/^https?:/i.test(url)) {
          return { combo: hit.combo, ...no(`Failed: "${readableUrl(url) || 'this tab'}" has no source to view; ` +
            'view-source only works on an http or https page.') };
        }
        const tab = await chrome.tabs.create({ url: 'view-source:' + url, active: false });
        return { combo: hit.combo, ...ok(`Succeed: opened page source in a new tab ` +
          `(tab ${tab.index}: view-source:${url}).`) };
      }

      default:
        // A route named in the table with no arm here would silently do
        // nothing, which is the bug this file was written to remove.
        throw new Error(`browserRoutes: "${hit.route}" 경로가 구현되어 있지 않습니다.`);
    }
  }

  /**
   * Where a `type` should go. While the find bar or the address bar is open
   * the model is typing INTO it — that is the whole point of having opened it
   * — so the text must not reach the page.
   *
   * @returns {Promise<{ok: boolean, result: string}|null>} null means the page
   *   should receive the text, exactly as it does today.
   */
  async function typeInto(tabId, text) {
    const state = await snapshot(tabId);
    if (!state || !state.focused) return null;
    if (state.focused === 'address') {
      await ui(tabId, 'addressType', text);
      return ok(`Succeed: the address bar now reads "${text}". Press Enter to go there.`);
    }
    const found = await ui(tabId, 'findType', text);
    return ok(`Find results: ${findLine(found)}.`);
  }

  /**
   * Tabs this run has ever drawn a widget into. Only these pay for the extra
   * Runtime.evaluate in releaseFocus() — a run that never opens a find bar
   * should not evaluate anything on every click.
   */
  const widgetTabs = new Set();

  /**
   * Tell the page the keyboard has gone back to it, after the panel dispatched
   * a pointer action.
   *
   * The page has its own mousedown listener for this, but it only sees clicks
   * in the TOP document. browserUi.js is evaluated into the top frame's main
   * world and nowhere else, so a click into an iframe — a login box, a search
   * form, most embedded checkouts — never reaches it, and the find bar would
   * keep claiming the keyboard while the model typed at an iframe field. This
   * is the half that is frame-independent, because the panel knows it clicked
   * without having to be told by the document the click landed in.
   */
  async function releaseFocus(tabId) {
    if (!widgetTabs.has(tabId)) return false;
    try {
      await ui(tabId, 'dropFocus');
      return true;
    } catch (_) {
      // A navigation destroyed the widgets along with the document, which is
      // the same outcome this call was asking for.
      return false;
    }
  }

  return { route, typeInto, applyStoredZoom, listTabs, snapshot, newTab, closeTab, switchToIndex, releaseFocus };
}
