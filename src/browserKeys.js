/**
 * browserKeys.js — which hotkey means which browser action, and nothing else.
 *
 * WHY THIS FILE EXISTS AT ALL. The model was trained against a harness that
 * drew a find bar, an address bar and a zoom control INSIDE the page, because
 * CDP cannot reach Chrome's own browser UI. So when it emits
 * hotkey(["ctrl","f"]) it is not asking Chrome for anything — it is asking for
 * the widget it was shown. Today that combination is handed to
 * Input.dispatchKeyEvent, the page ignores it, no error is raised, and the
 * model spends its next step typing into a find bar that was never opened.
 * Routing has to happen before the keystroke reaches the page.
 *
 * WHY THE ALIAS TABLE IS ONE TABLE. The same chord arrives spelled half a
 * dozen ways — "ctrl"/"Control", "="/"+"/"plus", "left"/"ArrowLeft",
 * "esc"/"Escape", "pagedown"/"PgDn" — and a routing table keyed on raw strings
 * would recognise ctrl+= and miss ctrl++ for no reason a reader could see.
 * Every spelling is folded to one canonical name here, once, and the route
 * table below is then allowed to be literal.
 *
 * WHAT IS DELIBERATELY ABSENT. A combination with no entry resolves to null
 * and the caller falls through to cdp.hotkey. ctrl+a, Enter, Tab and every
 * other page-level chord must keep working exactly as they do now; this file
 * narrows what it claims rather than guessing.
 *
 * This file is pure: no chrome.*, no DOM, no CDP. That is what lets the alias
 * table be tested spelling by spelling.
 */

/** Modifier spellings → the four canonical modifier names. */
const MODIFIER_ALIASES = Object.freeze({
  ctrl: 'ctrl', control: 'ctrl', ctl: 'ctrl', controlleft: 'ctrl', controlright: 'ctrl',
  alt: 'alt', option: 'alt', opt: 'alt', altleft: 'alt', altright: 'alt',
  shift: 'shift', shiftleft: 'shift', shiftright: 'shift',
  meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta', win: 'meta', windows: 'meta',
});

/**
 * Main-key spellings → one canonical name.
 *
 * `+` folds onto `=` because they are the same physical key: Chrome's zoom-in
 * shortcut is documented as Ctrl++ and typed as Ctrl+= or Ctrl+Shift+=, and a
 * model that writes any of the three means the same thing.
 */
const KEY_ALIASES = Object.freeze({
  '=': '=', '+': '=', plus: '=', add: '=', equal: '=', equals: '=', equalsign: '=',
  '-': '-', minus: '-', dash: '-', subtract: '-', hyphen: '-', underscore: '-',
  '0': '0', zero: '0', numpad0: '0', digit0: '0',
  left: 'left', arrowleft: 'left', leftarrow: 'left',
  right: 'right', arrowright: 'right', rightarrow: 'right',
  esc: 'escape', escape: 'escape',
  enter: 'enter', return: 'enter', numpadenter: 'enter',
  tab: 'tab',
  f1: 'f1',
  f2: 'f2',
  f3: 'f3',
  f4: 'f4',
  f5: 'f5',
  f6: 'f6',
  f7: 'f7',
  f8: 'f8',
  f9: 'f9',
  f10: 'f10',
  f11: 'f11',
  f12: 'f12',
  pagedown: 'pagedown', pgdn: 'pagedown', page_down: 'pagedown', pgdown: 'pagedown',
  pageup: 'pageup', pgup: 'pageup', page_up: 'pageup',
  delete: 'delete', del: 'delete',
  // Chrome's own media-key names for the three the model was handed directly.
  browserrefresh: 'browserrefresh', browser_refresh: 'browserrefresh', refresh: 'browserrefresh',
  reload: 'browserrefresh',
  browserback: 'back', back: 'back',
  browserforward: 'forward', forward: 'forward',
});

/**
 * The spellings KEY_ALIASES accepts. Exported so that every one of them can be
 * asserted to be a key src/cdp.js can actually dispatch — the two modules
 * split the key vocabulary between them and nothing used to compare.
 */
export const KEY_ALIAS_NAMES = Object.freeze(Object.keys(KEY_ALIASES));

/** The media-key spellings that are ROUTES in their own right (Chrome's own
 *  names for reload/back/forward), so they never fall through to cdp. */
export const MEDIA_KEY_NAMES = Object.freeze(
  Object.keys(KEY_ALIASES).filter((k) => ['browserrefresh', 'back', 'forward'].includes(KEY_ALIASES[k])));

/** Fixed order, so one chord has exactly one spelling after normalization. */
const MODIFIER_ORDER = Object.freeze(['ctrl', 'alt', 'shift', 'meta']);

/**
 * Fold one key list to a canonical chord string, e.g. ["Control","F"] → "ctrl+f".
 *
 * @returns {string|null} null when the list is empty, holds two non-modifier
 *   keys, or is modifiers only — none of which this file can route, and all of
 *   which cdp.hotkey already reports on in its own words.
 */
export function normalizeCombo(keys) {
  const list = (Array.isArray(keys) ? keys : [keys])
    .map((k) => String(k == null ? '' : k).trim())
    .filter((k) => k.length);
  if (!list.length) return null;

  const mods = new Set();
  let main = null;
  for (const raw of list) {
    const lower = raw.toLowerCase();
    const mod = MODIFIER_ALIASES[lower];
    if (mod) { mods.add(mod); continue; }
    if (main !== null) return null; // two main keys is not a chord we route
    main = Object.prototype.hasOwnProperty.call(KEY_ALIASES, lower) ? KEY_ALIASES[lower] : lower;
  }
  if (main === null) return null; // modifiers only

  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), main].join('+');
}

/**
 * Chord → route name.
 *
 * Every entry here is a capability the model team listed as something the
 * training harness provided. `ctrl+shift+=` is listed beside `ctrl+=` because
 * that is how `+` is physically typed on a US layout, and the model writes
 * both.
 */
const HOTKEY_ROUTES = Object.freeze({
  'ctrl+f': 'find',

  'ctrl+-': 'zoom_out',
  'ctrl+=': 'zoom_in',
  'ctrl+shift+=': 'zoom_in',
  'ctrl+0': 'zoom_reset',

  'ctrl+l': 'address',
  'alt+d': 'address',
  f6: 'address',

  'ctrl+r': 'reload',
  f5: 'reload',
  'shift+f5': 'reload',
  'ctrl+f5': 'reload',
  'ctrl+shift+r': 'reload',
  browserrefresh: 'reload',

  'ctrl+t': 'new_tab',
  'ctrl+w': 'close_tab',
  'ctrl+f4': 'close_tab',

  'ctrl+tab': 'next_tab',
  'ctrl+pagedown': 'next_tab',
  'ctrl+shift+tab': 'prev_tab',
  'ctrl+pageup': 'prev_tab',

  'alt+left': 'back',
  back: 'back',
  'alt+right': 'forward',
  forward: 'forward',

  'ctrl+j': 'downloads',
  'ctrl+h': 'history',
  'ctrl+u': 'view_source',
  'ctrl+shift+delete': 'clear_data',

  'ctrl+p': 'blocked_print',
  'ctrl+s': 'blocked_save',
  'ctrl+d': 'blocked_bookmark',
  // THE SAME THREE ON A MAC. Only the ctrl spellings were here, and the model
  // writes whichever one the machine it is looking at uses: the tool's own
  // description lists Meta among the modifiers. A missing entry is not a
  // refusal, it is a key dispatched to the page and reported as a clean
  // success, which is the one outcome the blocked list exists to prevent.
  'meta+p': 'blocked_print',
  'meta+s': 'blocked_save',
  'meta+d': 'blocked_bookmark',

  // Browser-window chrome, not page content. Pressing the key does nothing an
  // extension can see or photograph, so say so instead of dispatching silence.
  f11: 'blocked_fullscreen',
  f12: 'blocked_devtools',
  f1: 'blocked_help',
  f10: 'blocked_menu',
  // MEASURED: a live run has this checkpoint answering a task with
  // hotkey(["Alt","F4"]). It means "close the window", which would take the
  // page the run is driving with it. Refused in words, because dispatching it
  // to the page does nothing and would be reported as a clean success.
  'alt+f4': 'blocked_window',
  'ctrl+shift+i': 'blocked_devtools',
  'ctrl+shift+j': 'blocked_devtools',
  'ctrl+shift+c': 'blocked_devtools',
});

/**
 * Chords that mean something ONLY while one of our widgets is open.
 *
 * Kept separate from the table above because this is the one place where
 * routing a chord would be actively harmful: a bare Enter is how a model
 * submits a form, and Escape is how it dismisses a page's own modal. Stealing
 * either when no widget is on screen would break steps that work today, so the
 * caller must ask the page first and fall through when nothing is open.
 */
const WIDGET_ROUTES = Object.freeze({
  enter: 'widget_next',
  'shift+enter': 'widget_prev',
  escape: 'widget_close',
  // F3 is what the 21-tool hotkey description calls "find the next match".
  // Widget-only for the same reason Enter is: with no find bar open there is
  // no next match, and the key should reach the page rather than be eaten.
  f3: 'widget_next',
  'shift+f3': 'widget_prev',
});

/**
 * Resolve a key list to a route.
 *
 * @param {string[]|string} keys as the model spelled them
 * @returns {{combo: string, route: string, widgetOnly: boolean}|null} null
 *   means "not ours" — the caller hands the chord to cdp.hotkey unchanged.
 */
export function resolveHotkey(keys) {
  const combo = normalizeCombo(keys);
  if (!combo) return null;
  if (Object.prototype.hasOwnProperty.call(HOTKEY_ROUTES, combo)) {
    return { combo, route: HOTKEY_ROUTES[combo], widgetOnly: false };
  }
  if (Object.prototype.hasOwnProperty.call(WIDGET_ROUTES, combo)) {
    return { combo, route: WIDGET_ROUTES[combo], widgetOnly: true };
  }
  return null;
}

/** The three chords that open an OS or browser dialog, and what each is. */
/**
 * Why each refused chord is refused, as a clause the model reads mid-sentence.
 *
 * Full clauses rather than nouns because the verb differs: Ctrl+P *opens* a
 * dialog, F11 *toggles* a view and Alt+F4 *closes* the window. A single
 * "opens X" template told the model that Alt+F4 opens something.
 */
export const BLOCKED_ROUTES = Object.freeze({
  blocked_print: 'opens the print dialog, which cannot appear in a screenshot',
  blocked_save: 'opens the save-page dialog, which cannot appear in a screenshot',
  blocked_bookmark: 'opens the bookmark dialog, which cannot appear in a screenshot',
  blocked_fullscreen: 'toggles full-screen view, which is browser UI a screenshot cannot show',
  blocked_devtools: 'opens the developer tools, which is browser UI a screenshot cannot show',
  blocked_help: 'opens the browser help page, which cannot be screenshotted',
  blocked_menu: 'opens the browser menu bar, which is browser UI a screenshot cannot show',
  blocked_window: 'closes the browser window, which would take the page this run is driving with it',
});

/* ------------------------------------------------------------------ */
/* Zoom                                                                */
/* ------------------------------------------------------------------ */

/**
 * Chrome's own zoom ladder, in percent.
 *
 * WHY A LADDER AND NOT A MULTIPLIER: Ctrl+- from 100% lands on 90%, not on
 * 83% or 80%, and the model was trained watching those numbers. Stepping
 * through the same list is what makes "page zoom 100% → 90%" true rather than
 * approximately true.
 */
export const ZOOM_LADDER = Object.freeze([25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300]);

export const DEFAULT_ZOOM = 100;

/**
 * One rung up or down the ladder, clamped at both ends.
 *
 * A zoom that is not on the ladder (a page that set `zoom` itself) snaps to
 * the nearest rung first, so one keypress still produces one visible step
 * rather than a jump to an unrelated number.
 *
 * @param {number} current percent
 * @param {-1|0|1} direction out, reset, in
 */
export function stepZoom(current, direction) {
  if (direction === 0) return DEFAULT_ZOOM;
  const from = Number.isFinite(current) ? current : DEFAULT_ZOOM;
  let nearest = 0;
  for (let i = 1; i < ZOOM_LADDER.length; i += 1) {
    if (Math.abs(ZOOM_LADDER[i] - from) < Math.abs(ZOOM_LADDER[nearest] - from)) nearest = i;
  }
  const next = nearest + (direction > 0 ? 1 : -1);
  if (next < 0) return ZOOM_LADDER[0];
  if (next >= ZOOM_LADDER.length) return ZOOM_LADDER[ZOOM_LADDER.length - 1];
  return ZOOM_LADDER[next];
}
