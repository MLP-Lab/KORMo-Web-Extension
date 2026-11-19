/**
 * browserUi.js — the find bar, the address bar and the zoom, drawn INSIDE the
 * page because that is where the model learned to look for them.
 *
 * WHY IN THE PAGE AT ALL. Chrome's real find bar and real omnibox are browser
 * UI. CDP cannot open them, cannot type into them and cannot photograph them —
 * Page.captureScreenshot renders the page, not the window. The harness the
 * model was trained on solved this by drawing its own widgets into the
 * document, so the model's `hotkey(["ctrl","f"])` means "show me that widget",
 * and it then navigates it by looking at the screenshot. A find bar that is
 * not visible in the screenshot is of no use to it whatsoever, which is the
 * one hard requirement on everything below.
 *
 * IT IS INJECTED THE WAY overlay.js IS, BUT ONLY DOWN ONE OF ITS TWO PATHS:
 * evaluated into the page's main world over CDP. One IIFE assigning to one
 * global, so a second evaluation is harmless.
 *
 * overlay.js also has a declared-content-script path, and this file
 * deliberately does not. A content script lives in the ISOLATED world, so the
 * two paths have two different `window` objects — and therefore two different
 * copies of the find bar's state. The overlay can afford that because it holds
 * none. Here it would mean a bar drawn from one state and a match count
 * answered from another. The debugger is always attached to the tab we drive,
 * so the CDP path is always available, and having exactly one world is worth
 * more than a fallback that can disagree with itself.
 *
 * WHERE THE STATE LIVES, AND WHY HERE. The find bar's text, its match count
 * and which match is current live on this object, in the page — not in the
 * side panel. The widget and its state are then the same object: the counter
 * the model reads off the screenshot is rendered from the number the next step
 * is answered with, so the two cannot drift apart. A panel-side copy could
 * say 3/73 while the page drew 1/73 and nothing would notice. It also means a
 * navigation destroys both at once, which is right — a match count describes a
 * document, and that document is gone. Zoom is the deliberate exception: it has
 * to survive navigation within an origin, so the ladder position is kept by the
 * panel and re-applied here before each capture.
 *
 * NOTHING THIS FILE DRAWS IS FINDABLE. Every piece of our own chrome is either
 * an input's `value` (not a text node) or CSS generated content via
 * `content: attr(...)` (not in the DOM text). window.find therefore cannot
 * match the find bar's own counter and report itself as a hit on the page.
 * The root is attached to documentElement rather than body for the same
 * reason: document.body.innerText, which is what the match count is computed
 * from, then excludes it by construction.
 */

(function () {
  'use strict';

  const ROOT_ID = 'gui-agent-browser-ui-root';
  const STYLE_ID = 'gui-agent-browser-ui-style';

  /**
   * ALL the markup, in one place, because the exact appearance is a guess.
   * We have never seen the harness's widgets — only the model team's
   * description of them — so the thing most likely to need changing is how
   * these look. Keeping them as two template strings means a restyle is this
   * constant plus browserUi.css and nothing else.
   *
   * No value is interpolated into either template. The URL and the search text
   * are assigned to `input.value` afterwards, so a page's URL can never become
   * markup.
   */
  const MARKUP = {
    find:
      '<div class="gui-agent-bui gui-agent-bui-find" data-label="Find">' +
        '<input class="gui-agent-bui-input" type="text" readonly placeholder="Find in page">' +
        '<span class="gui-agent-bui-count" data-count="0/0"></span>' +
        '<span class="gui-agent-bui-hint" data-hint="Enter ▾  Shift+Enter ▴  Esc ✕"></span>' +
      '</div>',
    address:
      '<div class="gui-agent-bui gui-agent-bui-address" data-label="Address">' +
        '<input class="gui-agent-bui-input gui-agent-bui-url is-selected" type="text" readonly ' +
          'placeholder="Search Google or type a URL">' +
        '<span class="gui-agent-bui-hint" data-hint="Enter ↵  Esc ✕"></span>' +
      '</div>',
  };

  const previous = window.__guiAgentBrowserUi;

  /** Live state. Re-evaluation keeps whatever the previous load held. */
  const find = (previous && previous.__find) || { open: false, text: '', total: 0, index: 0 };
  const address = (previous && previous.__address) || { open: false, value: '' };

  /**
   * WHICH WIDGET HAS THE KEYBOARD — not which widget is on screen.
   *
   * These are two different questions and the panel was answering the wrong
   * one. `snapshot().focused` decides where the next `type` goes and whether a
   * bare Enter means "next match" or "submit the form", and it used to be
   * computed from `open`. So Ctrl+F, then a click on the page's own search
   * box, then type: the text went into the find bar, the model was told
   * `0/0`, and the box it had just clicked stayed empty. For as long as a find
   * bar was open the model also could not submit anything with Enter.
   *
   * Chrome's rule is simply that clicking the page takes focus out of the bar
   * while leaving it open, so that is what this tracks. The listener is on
   * mousedown in the capture phase because CDP's Input.dispatchMouseEvent
   * raises real events — the model's clicks arrive here exactly as a person's
   * do — and capture runs before a page can stop propagation.
   */
  const focus = { widget: null };

  function takeFocus(which) { focus.widget = which; }

  /**
   * The keyboard goes back to the page.
   *
   * Called from TWO places, and it needs both. The listener below catches a
   * click in this document. The panel calls `dropFocus` over CDP after every
   * pointer action it dispatches, which is the only thing that works when the
   * click landed in an IFRAME — the module is evaluated into the top frame's
   * main world only, so an iframe's mousedown never reaches this listener, and
   * a login or search form inside one is exactly where the original bug bit.
   *
   * NOTE ON WHAT THIS DELIBERATELY DOES NOT DO: it never takes focus back.
   * Everything we draw is `pointer-events: none` so that the bars cannot
   * swallow a click aimed at the page behind them, which means no click can
   * ever hit-test onto our own widget and clicking the drawn find bar cannot
   * refocus it. Ctrl+F and Ctrl+L are how focus returns. Making the bars
   * hit-testable would fix that one gesture and break every click that lands
   * under them, which is the worse trade on a real page.
   */
  function dropFocus() {
    focus.widget = null;
    return true;
  }

  /** Handing focus to a bar that is still open beats dropping it to nothing:
   *  an address bar left visible with Enter doing nothing is a dead end. */
  function closeOne(which) {
    if (focus.widget !== which) return;
    focus.widget = which === 'find' && address.open ? 'address'
      : which === 'address' && find.open ? 'find'
      : null;
  }

  document.addEventListener('mousedown', dropFocus, true);

  /* ---------------------------------------------------------------- */
  /* Mounting                                                          */
  /* ---------------------------------------------------------------- */

  function getRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root && root.isConnected) return root;
    root = document.createElement('div');
    root.id = ROOT_ID;
    // Inline fallbacks, so the widgets are still legible if neither the
    // manifest CSS nor installStyles() ran. The stylesheet repeats them.
    root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483646;margin:0;padding:0;border:0;';
    (document.documentElement || document.body).appendChild(root);
    return root;
  }

  function installStyles(cssText) {
    if (document.getElementById(STYLE_ID)) return true;
    if (typeof cssText !== 'string' || !cssText) return false;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = cssText;
    (document.head || document.documentElement).appendChild(style);
    return true;
  }

  /** The widget element, mounted on demand from the one template above. */
  function mount(which) {
    const root = getRoot();
    let el = root.querySelector('.gui-agent-bui-' + which);
    if (el) return el;
    root.insertAdjacentHTML('beforeend', MARKUP[which]);
    return root.querySelector('.gui-agent-bui-' + which);
  }

  function unmount(which) {
    const root = document.getElementById(ROOT_ID);
    const el = root && root.querySelector('.gui-agent-bui-' + which);
    if (el) el.remove();
    if (root && !root.children.length) root.remove();
  }

  /* ---------------------------------------------------------------- */
  /* Find                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * How many times the search text appears in the page's rendered text.
   *
   * window.find walks the document one match at a time and gives no total, and
   * calling it in a loop to count moves the selection and the scroll position
   * before the user ever sees the first hit. document.body.innerText is the
   * rendered text — it already excludes display:none and our own root, which
   * is mounted outside body — so counting in it answers the same question
   * without touching the page.
   *
   * LIMIT, stated because the counter is a number the model will act on: text
   * split across elements ("<b>ab</b>cd" searched for "abcd") counts in
   * innerText and is also found by window.find, but a match inside an iframe
   * is counted by neither. Same-document counting is what both halves agree on.
   *
   * MEASURED LIMIT — SHADOW DOM. innerText does NOT cross an open shadow
   * boundary; window.find does. A page with 2 matches in the light DOM and 3
   * behind open shadow roots reports 2/2, not 2/5, so this is settled rather
   * than argued. Two consequences, in order of how much they cost: a page
   * whose matches are ALL in shadow roots counts 0, and a
   * total of 0 means seek() below is never called — the model is told the text
   * is absent from a page Chrome's own Ctrl+F searches happily. A page with
   * matches on both sides still finds them; only the total is short, which
   * also makes the wrap land early.
   *
   * LEFT AS IS DELIBERATELY. Fixing it means walking shadow roots recursively
   * while keeping innerText's visibility rules and not double-counting, and
   * the exposure is narrow: it needs the model to reach for Ctrl+F at all
   * (it did not once across the 다방 runs), on a site built from web
   * components. Worth doing if an evaluation task targets one — YouTube is the
   * obvious example — and not before.
   */
  function countMatches(text) {
    if (!text) return 0;
    const hay = ((document.body && document.body.innerText) || '').toLowerCase();
    const needle = text.toLowerCase();
    if (!hay || !needle) return 0;
    let n = 0;
    let at = hay.indexOf(needle);
    while (at !== -1) {
      n += 1;
      at = hay.indexOf(needle, at + needle.length);
    }
    return n;
  }

  /** Put the caret at the very top so the next search starts from match 1. */
  function collapseToStart() {
    const sel = window.getSelection && window.getSelection();
    if (!sel || !document.body) return;
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(document.body);
    range.collapse(true);
    sel.addRange(range);
  }

  /**
   * window.find does the search, the selection and the scroll in one call,
   * which is exactly the three things the model needs to see happen. It is
   * non-standard but it is what Chrome implements, and the alternative —
   * walking text nodes and building our own highlight — would draw a selection
   * that does not look like the browser's.
   */
  function seek(backwards) {
    if (!find.text || typeof window.find !== 'function') return false;
    try {
      // (text, caseSensitive, backwards, wrapAround, wholeWord, searchInFrames, showDialog)
      return Boolean(window.find(find.text, false, Boolean(backwards), true, false, false, false));
    } catch (_) {
      return false;
    }
  }

  function paintFind() {
    const el = mount('find');
    el.querySelector('.gui-agent-bui-input').value = find.text;
    el.querySelector('.gui-agent-bui-count').setAttribute('data-count', find.index + '/' + find.total);
    return { total: find.total, index: find.index };
  }

  function openFind() {
    find.open = true;
    takeFocus('find');
    return paintFind();
  }

  function findType(text) {
    find.open = true;
    takeFocus('find');
    find.text = String(text == null ? '' : text);
    find.total = countMatches(find.text);
    collapseToStart();
    find.index = find.total && seek(false) ? 1 : 0;
    return paintFind();
  }

  /**
   * Next or previous match. The index wraps the same way window.find's
   * wrapAround does, so the counter and the highlight agree at both ends.
   */
  /**
   * Is the browser's selection still sitting on one of our matches?
   *
   * window.find RESUMES FROM THE SELECTION, and plenty of things move it
   * between two find steps: a `clear` runs selectAll, a click collapses it,
   * the page's own script can set it. When that happens the next step jumps
   * somewhere unrelated while the counter keeps counting up, so the number the
   * model reads and the highlight it looks at stop describing each other.
   */
  function onAMatch() {
    if (!find.text) return false;
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) return false;
    return String(sel).toLowerCase() === find.text.toLowerCase();
  }

  function findStep(direction) {
    if (!find.open) return { total: find.total, index: find.index };
    takeFocus('find');
    // RECOUNT. The total used to be measured once, when the text was typed,
    // and then quoted for the life of the page — on anything that re-renders
    // its results (every SPA shop) "/73" went stale within a step or two.
    find.total = countMatches(find.text);
    if (!find.total) { find.index = 0; return paintFind(); }
    if (!onAMatch()) {
      // The selection wandered off. Re-anchor rather than counting from a
      // position nobody can see: start again at the first match.
      collapseToStart();
      find.index = seek(false) ? 1 : 0;
      return paintFind();
    }
    if (seek(direction < 0)) {
      find.index = direction < 0
        ? (find.index <= 1 ? find.total : find.index - 1)
        : (find.index >= find.total ? 1 : find.index + 1);
    }
    if (find.index > find.total) find.index = find.total;
    return paintFind();
  }

  function closeFind() {
    closeOne('find');
    find.open = false;
    find.text = '';
    find.total = 0;
    find.index = 0;
    unmount('find');
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Address                                                           */
  /* ---------------------------------------------------------------- */

  function paintAddress() {
    const el = mount('address');
    el.querySelector('.gui-agent-bui-url').value = address.value;
    return { value: address.value };
  }

  /** Opens showing the current URL, drawn as fully selected — so the model
   *  reads it the way Chrome's omnibox reads after Ctrl+L: typing replaces it. */
  function openAddress(url) {
    address.open = true;
    takeFocus('address');
    address.value = String(url == null ? '' : url);
    const painted = paintAddress();
    mount('address').querySelector('.gui-agent-bui-url').classList.add('is-selected');
    return painted;
  }

  /** The first type REPLACES the selected URL; there is no append path,
   *  because that is what a selected omnibox does. */
  function addressType(text) {
    address.open = true;
    takeFocus('address');
    address.value = String(text == null ? '' : text);
    const painted = paintAddress();
    mount('address').querySelector('.gui-agent-bui-url').classList.remove('is-selected');
    return painted;
  }

  function closeAddress() {
    closeOne('address');
    address.open = false;
    address.value = '';
    unmount('address');
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Zoom                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * CSS zoom on documentElement, which is what the capability list names.
   * It scales our own widgets along with the page, which is faithful: Chrome's
   * zoom scales everything the page draws too.
   */
  function setZoom(percent) {
    const pct = Number(percent);
    if (!Number.isFinite(pct) || pct <= 0) return getZoom();
    document.documentElement.style.zoom = pct === 100 ? '' : pct + '%';
    return pct;
  }

  function getZoom() {
    const raw = document.documentElement.style.zoom;
    if (!raw) return 100;
    const pct = raw.endsWith('%') ? parseFloat(raw) : parseFloat(raw) * 100;
    return Number.isFinite(pct) && pct > 0 ? pct : 100;
  }

  /* ---------------------------------------------------------------- */
  /* One round trip                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Everything the side panel needs to decide where the next `type` or Enter
   * goes, in a single Runtime.evaluate. Asking three separate questions would
   * let the page change between them.
   */
  function snapshot() {
    return {
      // `open` is not focus: a widget can be on screen while the page holds
      // the keyboard, which is the normal state after any click.
      focused: focus.widget === 'find' && find.open ? 'find'
        : focus.widget === 'address' && address.open ? 'address'
        : null,
      find: { open: find.open, text: find.text, total: find.total, index: find.index },
      address: { open: address.open, value: address.value },
      zoom: getZoom(),
    };
  }

  function clearAll() {
    closeFind();
    closeAddress();
    return true;
  }

  window.__guiAgentBrowserUi = {
    version: 1,
    installStyles,
    openFind, findType, findStep, closeFind, dropFocus,
    openAddress, addressType, closeAddress,
    setZoom, getZoom,
    snapshot, clearAll,
    __find: find,
    __address: address,
    __focus: focus,
  };
})();
