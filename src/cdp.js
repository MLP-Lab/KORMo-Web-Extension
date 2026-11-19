/**
 * cdp.js — a thin wrapper over chrome.debugger / the Chrome DevTools Protocol.
 *
 * WHY CDP AT ALL, INSTEAD OF A CONTENT SCRIPT:
 * A content script can only create synthetic events (new MouseEvent(...),
 * el.click()). Those arrive at the page with `isTrusted === false`. A large
 * fraction of real sites ignore untrusted events — React synthetic handlers
 * usually work, but native controls, <select> popups, file pickers, drag
 * handlers, many anti-bot layers and anything gated on user activation do not.
 * CDP's Input.dispatchMouseEvent injects at the browser's input layer, so the
 * page sees a genuine trusted event, indistinguishable from a real mouse.
 * That is why `debugger` is in the manifest and why we accept the yellow
 * "... is debugging this browser" infobar.
 *
 * COORDINATE CONTRACT (repeated because it is the thing that goes wrong):
 * Input.dispatchMouseEvent x/y are CSS pixels relative to the top-left of the
 * VISUAL VIEWPORT. They are not page/document coordinates and they are not
 * device pixels. Scrolling down does not change where (0,0) is; it changes
 * what is drawn there. Every function in this file expects coordinates that
 * have already been through coords.js.
 */

import { waitForPageReady, pageReadinessProbe, isPageReady, sameDocument, PAGE_READY_TIMEOUT_MS, PAGE_SETTLE_MS } from './pageReady.js';

const attached = new Set();
const pageNetworks = new Map();
const LOAD_RESOURCE_TYPES = new Set(['Document', 'Stylesheet', 'Image', 'Font', 'Script', 'XHR', 'Fetch']);

function watchPageNetwork(tabId) {
  clearPageNetwork(tabId);
  const network = { pending: new Map(), lastChange: Date.now() };
  const listener = (source, method, params) => {
    if (source.tabId !== tabId || source.sessionId) return;
    if (method === 'Network.requestWillBeSent' && LOAD_RESOURCE_TYPES.has(params.type)) {
      network.pending.set(params.requestId, params.loaderId);
      network.lastChange = Date.now();
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      if (network.pending.delete(params.requestId)) network.lastChange = Date.now();
    } else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
      // Requests belonging to the previous document must not block a new one.
      for (const [id, loader] of network.pending) {
        if (loader !== params.frame.loaderId) network.pending.delete(id);
      }
      network.lastChange = Date.now();
    }
  };
  chrome.debugger.onEvent.addListener(listener);
  network.unsubscribe = () => chrome.debugger.onEvent.removeListener(listener);
  pageNetworks.set(tabId, network);
}

/**
 * Native alert/confirm/prompt dialogs, answered so the run can continue.
 *
 * WHY THE RUN STOPPED DEAD WITHOUT THIS. A javascript dialog is browser UI
 * drawn outside the page, so it is not in Page.captureScreenshot and a CDP
 * click cannot reach it — the same wall as the <select> popup. Worse, it
 * BLOCKS THE RENDERER: while it is up, Runtime.evaluate and captureScreenshot
 * do not answer at all, so the loop had nothing to photograph, nothing to read
 * and nothing to report. It simply hung.
 *
 * Page.handleJavaScriptDialog is the only way to answer one, and it has to be
 * answered promptly or every later command queues behind it.
 *
 * WHAT IS ANSWERED HERE, AND WHAT IS ASKED. An alert has one button, so
 * accepting it is not a decision. beforeunload is accepted because the
 * navigation it is asking about is one the agent just requested. A confirm or
 * a prompt IS a decision — "정말 삭제하시겠습니까" — and this panel drives a
 * browser logged into the operator's own accounts. Answering those no by
 * default was safe and useless: 쿠팡's 선택삭제 asks exactly that, so the one
 * task the operator typed could never finish, and the model, seeing nothing
 * change, pressed the button again. So the decision is handed to the person
 * watching, through setDialogAsker.
 *
 * The model is told which dialog appeared and what was answered either way,
 * so a yes is never silently taken on its behalf.
 */
const pageDialogs = new Map();

/**
 * Who decides a confirm or a prompt. Null means nobody is watching, and the
 * safe answer stands.
 *
 * THE PANEL CAN ANSWER THIS WHILE THE RENDERER IS BLOCKED. The dialog freezes
 * the page's renderer, not the extension: sidepanel.js is its own document in
 * its own process, so its buttons keep working and its timers keep firing.
 * That is the whole reason a human can be asked at all.
 *
 * The asker owns its own deadline. Nothing here waits forever on it, because
 * a promise that never settles leaves the tab with a dialog nobody can close.
 */
let askDialog = null;

/** @param {null | (d: {type: string, message: string, tabId: number}) => boolean | Promise<boolean>} fn */
export function setDialogAsker(fn) {
  askDialog = typeof fn === 'function' ? fn : null;
}

function watchPageDialogs(tabId) {
  // Cleared first: a re-attach would otherwise leave the previous listener
  // registered with nothing holding its unsubscribe, and every dialog would
  // be answered twice.
  clearPageDialogs(tabId);
  const seen = [];
  const listener = (source, method, params) => {
    if (source.tabId !== tabId || source.sessionId) return;
    if (method !== 'Page.javascriptDialogOpening') return;
    const type = String(params.type || '');
    const message = String(params.message || '');

    const answer = (accept, asked) => {
      seen.push({ type, message, accepted: accept, asked });
      // Not awaited: the renderer is blocked until this lands, and anything
      // this listener waits for would be waiting behind the very dialog it
      // answers.
      chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept }, () => {
        void chrome.runtime.lastError;
      });
    };

    if (type === 'alert' || type === 'beforeunload') { answer(true, false); return; }
    if (!askDialog) { answer(false, false); return; }
    // Whatever the asker throws, and whatever it answers with, the dialog is
    // closed. A rejected promise here would otherwise strand the tab.
    Promise.resolve()
      .then(() => askDialog({ type, message, tabId }))
      .then((accept) => answer(Boolean(accept), true), () => answer(false, true));
  };
  chrome.debugger.onEvent.addListener(listener);
  pageDialogs.set(tabId, {
    seen,
    unsubscribe: () => chrome.debugger.onEvent.removeListener(listener),
  });
}

function clearPageDialogs(tabId) {
  pageDialogs.get(tabId)?.unsubscribe();
  pageDialogs.delete(tabId);
}

/** Dialogs answered since the last call, and clears them. */
export function takeDialogs(tabId) {
  const record = pageDialogs.get(tabId);
  if (!record || !record.seen.length) return [];
  return record.seen.splice(0, record.seen.length);
}

/**
 * The OS file dialog, intercepted so the run does not stop at it.
 *
 * SAME WALL AS THE ALERT, one step worse. "파일 업로드" opens a dialog drawn by
 * the operating system: not in Page.captureScreenshot, unreachable by CDP
 * input, and on macOS it is modal to the whole window. Unlike a javascript
 * dialog it does not block the renderer, so the run does not hang — it just
 * sits there forever with a picker open that the model cannot see.
 *
 * Page.setInterceptFileChooserDialog stops the dialog from ever being drawn.
 * Chrome raises Page.fileChooserOpened instead and waits for us to put files
 * into the element with DOM.setFileInputFiles.
 *
 * POLICY IS NOT HERE. This records the event and hands it over; which file to
 * choose belongs to src/fileTransfer.js, where it can be tested without a
 * browser.
 */
const pageChoosers = new Map();

function watchFileChooser(tabId) {
  clearFileChooser(tabId);
  const seen = [];
  const waiting = new Set();
  const listener = (source, method, params) => {
    if (source.tabId !== tabId || source.sessionId) return;
    if (method !== 'Page.fileChooserOpened') return;
    seen.push({
      mode: params.mode === 'selectMultiple' ? 'selectMultiple' : 'selectSingle',
      backendNodeId: params.backendNodeId,
      frameId: params.frameId,
    });
    // Let go of anything parked in waitForFileChooser at once.
    for (const settle of [...waiting]) settle(true);
  };
  chrome.debugger.onEvent.addListener(listener);
  pageChoosers.set(tabId, {
    seen,
    waiting,
    unsubscribe: () => chrome.debugger.onEvent.removeListener(listener),
  });
}

/**
 * Wait, briefly, for a chooser the action just taken may be opening.
 *
 * WHY THE STEP CANNOT SIMPLY READ THE LIST. Page.fileChooserOpened arrives a
 * beat AFTER the click command resolves, so draining the list the moment the
 * action returns finds it empty and the sentence lands on the following step
 * instead. MEASURED in a real run on an upload page: the click in step 2
 * opened the chooser, step 2 was told nothing, and step 3 — whose own click
 * went to the same button — was the one that reported it. The model was being
 * told that the wrong action had opened the chooser, every time.
 *
 * Returns as soon as one arrives, so the cost is paid only by steps that open
 * no chooser at all, and the caller limits it to the actions that can.
 */
export function waitForFileChooser(tabId, ms = 250) {
  const record = pageChoosers.get(tabId);
  if (!record) return Promise.resolve(false);
  if (record.seen.length) return Promise.resolve(true);
  return new Promise((resolve) => {
    const settle = (hit) => {
      record.waiting.delete(settle);
      clearTimeout(timer);
      resolve(hit);
    };
    const timer = setTimeout(() => settle(false), ms);
    record.waiting.add(settle);
  });
}

function clearFileChooser(tabId) {
  pageChoosers.get(tabId)?.unsubscribe();
  pageChoosers.delete(tabId);
}

/** File choosers opened since the last call, and clears them. */
export function takeFileChoosers(tabId) {
  const record = pageChoosers.get(tabId);
  if (!record || !record.seen.length) return [];
  return record.seen.splice(0, record.seen.length);
}

/**
 * Put files into the element whose chooser was intercepted.
 *
 * `files` are ABSOLUTE PATHS on this machine. A page cannot produce one and
 * neither can an extension API that returns a handle — the path comes from
 * chrome.downloads, which reports where Chrome actually wrote the file.
 *
 * The panel keeps an intercepted chooser PENDING until the model calls
 * `upload` (see src/fileTransfer.js); the element is filled then.
 */
export async function setFileInputFiles(tabId, backendNodeId, files) {
  await send(tabId, 'DOM.setFileInputFiles', { files, backendNodeId });
}

/**
 * Is this tab showing a PDF in the browser's own viewer?
 *
 * NOT BY FILE EXTENSION. MEASURED: arxiv serves its papers at
 * `arxiv.org/pdf/2601.18734`, with no `.pdf` on the end at all, and that is
 * the address a model reaches by clicking "View PDF". A suffix test answers
 * no there and the run walks into the viewer believing it is on a web page.
 *
 * `document.contentType` is what the browser decided the bytes were, and the
 * `<embed>` is what Chrome's viewer puts in the document it builds around
 * them. Either one is conclusive; neither can be spoofed by a URL.
 */
export async function isPdfDocument(tabId) {
  try {
    const res = await send(tabId, 'Runtime.evaluate', {
      expression: "(function(){ try { return document.contentType === 'application/pdf'"
        + " || !!document.querySelector('embed[type=\"application/pdf\"]'); }"
        + ' catch (e) { return false; } })()',
      returnByValue: true,
    });
    return Boolean(res && res.result && res.result.value);
  } catch (_) {
    // A tab that cannot be evaluated is not a tab we can call a PDF.
    return false;
  }
}

/**
 * The page's `<input type=file>` for an `upload` with no chooser pending: the
 * focused one, else the first in the document. Null when there is none.
 *
 * @returns {Promise<{backendNodeId: number, multiple: boolean} | null>}
 */
export async function findFileInput(tabId) {
  requireAttached(tabId);
  const res = await send(tabId, 'Runtime.evaluate', {
    expression: '(() => { const a = document.activeElement;'
      + " if (a && a.matches && a.matches('input[type=file]')) return a;"
      + " return document.querySelector('input[type=file]'); })()",
    returnByValue: false,
  });
  const objectId = res && res.result && res.result.objectId;
  if (!objectId) return null;
  const { node } = await send(tabId, 'DOM.describeNode', { objectId });
  const multiple = await send(tabId, 'Runtime.callFunctionOn', {
    objectId, functionDeclaration: 'function () { return Boolean(this.multiple); }', returnByValue: true,
  });
  return { backendNodeId: node.backendNodeId, multiple: Boolean(multiple && multiple.result && multiple.result.value) };
}

function clearPageNetwork(tabId) {
  pageNetworks.get(tabId)?.unsubscribe();
  pageNetworks.delete(tabId);
}

/** Promise wrapper that turns chrome.runtime.lastError into a real rejection. */
function send(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(`CDP ${method} failed: ${err.message}`));
        return;
      }
      resolve(result);
    });
  });
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

export function attachedTabs() {
  return [...attached];
}

/**
 * Attach the debugger to a tab and enable the domains we use.
 * Safe to call twice: the second call is a no-op.
 */
export async function attach(tabId) {
  if (attached.has(tabId)) return;

  await new Promise((resolve, reject) => {
    // "1.3" is the protocol version string chrome.debugger expects.
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) {
        // Most common real-world causes, surfaced in plain language.
        if (/already attached/i.test(err.message)) {
          reject(new Error('이 탭에 다른 디버거가 이미 연결되어 있습니다. 해당 탭의 개발자 도구를 닫고 다시 시도하세요.'));
        } else if (/Cannot access/i.test(err.message)) {
          reject(new Error('이 탭에 연결할 수 없습니다. chrome://, 웹 스토어 등 제한된 페이지에서는 사용할 수 없습니다. 일반 웹페이지를 여세요.'));
        } else {
          reject(new Error(`debugger.attach failed: ${err.message}`));
        }
        return;
      }
      resolve();
    });
  });

  attached.add(tabId);
  watchPageNetwork(tabId);
  watchPageDialogs(tabId);
  watchFileChooser(tabId);

  // Page is needed for getLayoutMetrics / captureScreenshot. Runtime is needed
  // for the overlay fallback injection. Input needs no enable call.
  try {
    await send(tabId, 'Page.enable');
    await send(tabId, 'Runtime.enable');
    await send(tabId, 'Network.enable');
    // DOM is needed only by setFileInputFiles, but enabling it here keeps that
    // call from being the one that discovers the domain was never on.
    await send(tabId, 'DOM.enable');
  } catch (err) {
    await detach(tabId).catch(() => {});
    throw err;
  }

  // AFTER the enables and deliberately not inside the try: a Chrome build that
  // does not take this command must not cost us the whole attach. Without the
  // interception the OS dialog opens and the run stalls at it — which is
  // exactly today's behaviour, so failing here is a missing improvement
  // rather than a new breakage.
  try {
    await send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });
  } catch (_) {
    clearFileChooser(tabId);
  }

  await settleViewport(tabId);
}

/**
 * Wait for the viewport to stop changing, which after an attach means waiting
 * for Chrome's "디버깅 중" infobar to finish appearing.
 *
 * MEASURED: the first screenshot of a scripted run came back 1229×955 and the
 * geometry re-read a moment later said 1229×899 — the infobar is 56px tall and
 * it slides in just after chrome.debugger.attach resolves. The staleness guard
 * then correctly threw the step away, but throwing away the FIRST step of
 * every run is a tax, and for a scripted run it also lost the action.
 *
 * Two equal reads in a row is the condition, because a single read can land
 * mid-animation. Cheap on a still page: the first two reads agree and it
 * returns after one poll interval.
 */
export async function settleViewport(tabId, { budgetMs = 1200, pollMs = 60 } = {}) {
  const deadline = Date.now() + budgetMs;
  let previous = null;
  while (Date.now() < deadline) {
    let current;
    try {
      current = await getViewport(tabId);
    } catch (_) {
      return null; // detached or navigating; the caller's own guards cover it
    }
    if (previous && previous.width === current.width && previous.height === current.height) {
      return current;
    }
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return previous;
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  clearPageNetwork(tabId);
  clearPageDialogs(tabId);
  clearFileChooser(tabId);
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      // Swallow lastError here only: if the tab already closed, detach failing
      // is expected and not actionable.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

/**
 * Register for Chrome-initiated detaches (tab closed, user hit "Cancel" on the
 * infobar, target crashed). Keeps our bookkeeping honest and lets the UI react.
 * Returns an unsubscribe function.
 */
export function onDetached(handler) {
  const listener = (source, reason) => {
    if (source && source.tabId !== undefined) {
      attached.delete(source.tabId);
      clearPageNetwork(source.tabId);
    }
    handler(source, reason);
  };
  chrome.debugger.onDetach.addListener(listener);
  return () => chrome.debugger.onDetach.removeListener(listener);
}

function requireAttached(tabId) {
  if (!attached.has(tabId)) {
    throw new Error(`Debugger is not attached to tab ${tabId}.`);
  }
}

/* ------------------------------------------------------------------ */
/* Viewport                                                            */
/* ------------------------------------------------------------------ */

/**
 * Current visual viewport, in CSS pixels.
 * cssVisualViewport is the rectangle the user is actually looking at, already
 * expressed in CSS px (the non-`css` fields in getLayoutMetrics are in device
 * px and would reintroduce the DPR problem, so we never read them).
 * pageX/pageY are the scroll offset; we need them for the screenshot clip
 * because captureScreenshot's clip is in page coordinates.
 */
export async function getViewport(tabId) {
  requireAttached(tabId);
  const metrics = await send(tabId, 'Page.getLayoutMetrics');
  const v = metrics.cssVisualViewport || metrics.visualViewport;
  if (!v) {
    throw new Error('Page.getLayoutMetrics returned no visual viewport.');
  }
  return {
    width: Math.round(v.clientWidth),
    height: Math.round(v.clientHeight),
    pageX: v.pageX || 0,
    pageY: v.pageY || 0,
    scale: v.scale === undefined ? 1 : v.scale,
  };
}

/* ------------------------------------------------------------------ */
/* Screenshot                                                          */
/* ------------------------------------------------------------------ */

/**
 * Capture exactly the visible viewport at 1 screenshot pixel == 1 CSS pixel.
 *
 * WHY NOT chrome.tabs.captureVisibleTab: it is throttled to about 2 calls per
 * second (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND) which stalls an agent
 * loop, and it returns an image scaled by devicePixelRatio, so on this Retina
 * Mac you would get a 2x image and have to divide every model coordinate by
 * DPR. Every such conversion is a chance to be wrong.
 *
 * WHY clip + scale: 1 : the clip rectangle is given in CSS page coordinates
 * and `scale: 1` means "render one output pixel per CSS pixel". Setting the
 * clip origin to the current scroll offset (pageX/pageY) and the size to the
 * visual viewport size yields an image whose pixel (0,0) is the viewport
 * origin and whose pixel (px, py) is CSS viewport pixel (px, py). The
 * devicePixelRatio conversion step disappears completely.
 */
export async function screenshot(tabId, format = 'png') {
  requireAttached(tabId);
  const vp = await getViewport(tabId);
  const result = await send(tabId, 'Page.captureScreenshot', {
    format,
    clip: {
      x: vp.pageX,
      y: vp.pageY,
      width: vp.width,
      height: vp.height,
      scale: 1,
    },
    captureBeyondViewport: false,
    fromSurface: true,
  });
  return {
    base64: result.data,
    format,
    // pageX/pageY ride along so the caller can detect that the view moved
    // between this screenshot and the action decided from it.
    viewport: { width: vp.width, height: vp.height, pageX: vp.pageX, pageY: vp.pageY },
  };
}

/** Wait on every agent step, including after click/Enter/history navigation.
 * Recheck after capture to discard screenshots interrupted by a new load.
 * Once the wait deadline expires, use the current screen without more waiting. */
export async function screenshotWhenReady(tabId, options = {}) {
  requireAttached(tabId);
  const timeoutMs = options.timeoutMs ?? PAGE_READY_TIMEOUT_MS;
  const settleMs = options.settleMs ?? PAGE_SETTLE_MS;
  const deadline = Date.now() + timeoutMs;
  const readPage = async id => {
    const page = await evaluate(id, `(${pageReadinessProbe.toString()})()`);
    const network = pageNetworks.get(id);
    return {
      ...page,
      networkReady: !network || network.pending.size === 0,
      quietForMs: Math.min(page.quietForMs, network ? Date.now() - network.lastChange : Infinity),
    };
  };
  while (true) {
    const before = await waitForPageReady(tabId, readPage, { ...options, timeoutMs, settleMs, deadline });
    if (!before) options.onTimeout?.();
    let shot;
    try {
      shot = await screenshot(tabId);
    } catch (err) {
      if (before && /execution context.*destroy|cannot find context|cannot find default execution context|inspected target navigated/i.test(err.message)) continue;
      throw err;
    }
    if (options.shouldAbort?.()) return null;
    if (!before) return shot;
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'complete') continue;
    let after;
    try {
      after = await readPage(tabId);
    } catch (err) {
      if (/execution context.*destroy|cannot find context|cannot find default execution context|inspected target navigated/i.test(err.message)) continue;
      throw err;
    }
    if (options.shouldAbort?.()) return null;
    if (isPageReady(tab, after) && sameDocument(before, after) && after.quietForMs >= settleMs) return shot;
  }
}

/* ------------------------------------------------------------------ */
/* Input primitives — all coordinates are CSS viewport pixels          */
/* ------------------------------------------------------------------ */

/**
 * `buttons` is a BITMASK of what is held down, and it is a different number
 * from `button`. Left is 1 and right is 2; sending 1 for a right press makes
 * context-menu handlers that read event.buttons disagree with event.button.
 */
const BUTTON_MASK = Object.freeze({ left: 1, middle: 4, right: 2, back: 8, forward: 16 });

/**
 * Trusted click at a CSS viewport coordinate.
 * The leading mouseMoved is not cosmetic: menus, tooltips and many React
 * components only reveal their click target on hover, and a press with no
 * preceding move can land on an element that was never shown.
 */
export async function click(tabId, x, y, { clickCount = 1, button = 'left' } = {}) {
  requireAttached(tabId);
  const mask = BUTTON_MASK[button];
  if (mask === undefined) {
    throw new Error(`Unsupported mouse button "${button}". Supported: ${Object.keys(BUTTON_MASK).join(', ')}`);
  }
  const base = { x, y, button, clickCount, buttons: 0, pointerType: 'mouse' };
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', clickCount: 0 });
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: mask });
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
}

/**
 * Double click. Two press/release pairs, the second carrying clickCount: 2 —
 * that second mouseup is what Blink turns into a `dblclick` event. Sending a
 * lone clickCount: 2 pair would skip the single click the page expects first,
 * which breaks widgets that select on click and edit on double click.
 */
export async function doubleClick(tabId, x, y) {
  await click(tabId, x, y, { clickCount: 1 });
  await click(tabId, x, y, { clickCount: 2 });
}

/** Move the cursor with nothing held down. This is the whole of `hover`. */
export async function moveMouse(tabId, x, y) {
  requireAttached(tabId);
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0, pointerType: 'mouse',
  });
}

/**
 * Press at (x, y), move to (x2, y2) in steps, release.
 *
 * WHY THE INTERMEDIATE MOVES: almost every drag implementation — sliders,
 * sortable lists, canvas handles, map panning — updates on mousemove and
 * ignores a press/release pair with nothing between them. A single jump to the
 * end point also fails drag thresholds that require a few pixels of travel
 * before the drag is considered started.
 *
 * LIMIT: this is a mouse drag. Native HTML5 drag-and-drop (draggable="true",
 * which goes through Input.dispatchDragEvent) is a different protocol and is
 * not covered here.
 */
/**
 * Is there a <select> at this point, and what does it hold?
 *
 * MEASURED ON kleague.com. The model clicked the 대회 selector seventeen times
 * and burned the whole twenty-step budget. Its own thinking said why, every
 * single step: "my repeated clicks have not opened a menu". It never saw one.
 *
 * A native <select> popup is drawn by the OPERATING SYSTEM, not by the page.
 * Page.captureScreenshot renders the page, so the open list is absent from
 * every screenshot — the picture before the click and the picture after it are
 * identical. Worse, CDP input is delivered to the renderer while the popup is
 * an OS window on top of it, so a click aimed at an option lands on whatever
 * page content sits behind the popup. The option list has no coordinates at
 * all; it is not in the layout.
 *
 * Same wall as Chrome's find bar and the print dialog, and the same answer
 * this project already uses for those: do not pretend, hand the model the
 * contents in words it can act on.
 *
 * This focuses the select rather than clicking it, because focusing does not
 * open the popup — and a focused select is one the model can drive with the
 * arrow keys it already has.
 */
function selectAtProbe(x, y) {
  const at = document.elementFromPoint(x, y);
  const el = at && at.closest ? at.closest('select') : null;
  if (!el) return { isSelect: false };
  el.focus({ preventScroll: true });
  const options = [];
  for (let i = 0; i < el.options.length; i += 1) {
    const option = el.options[i];
    options.push({
      index: i,
      label: (option.label || option.textContent || '').trim(),
      value: option.value,
      disabled: Boolean(option.disabled),
      selected: i === el.selectedIndex,
    });
  }
  return {
    isSelect: true,
    multiple: Boolean(el.multiple),
    disabled: Boolean(el.disabled),
    selectedIndex: el.selectedIndex,
    options,
  };
}

/**
 * Choose an option on the focused <select> by its visible text.
 *
 * WHY A DOM WRITE HERE, when `clear` refuses one on principle. `clear` refuses
 * it because keystrokes make the page clear itself and a write skips the input
 * events frameworks listen to. This writes AND fires both `input` and `change`
 * bubbling, which is exactly what a user picking an option produces — and for
 * a <select> there is no keystroke path that is reliable across platforms:
 * on macOS an arrow key opens the native popup instead of moving the
 * selection, and type-ahead needs real keydowns that Input.insertText does not
 * send. A measured failure beats a principle applied where it does not fit.
 */
function chooseOptionProbe(text) {
  const el = document.activeElement;
  if (!el || el.tagName !== 'SELECT') return { ok: false, reason: 'not-a-select' };
  const want = String(text == null ? '' : text).trim().toLowerCase();
  if (!want) return { ok: false, reason: 'empty' };

  const labelOf = (option) => (option.label || option.textContent || '').trim();
  const usable = [];
  for (let i = 0; i < el.options.length; i += 1) {
    if (!el.options[i].disabled) usable.push(el.options[i]);
  }
  const exact = usable.find((o) => labelOf(o).toLowerCase() === want);
  const starts = usable.find((o) => labelOf(o).toLowerCase().startsWith(want));
  const holds = usable.find((o) => labelOf(o).toLowerCase().includes(want));
  const byValue = usable.find((o) => String(o.value).toLowerCase() === want);
  const pick = exact || byValue || starts || holds;
  if (!pick) {
    return { ok: false, reason: 'no-match', options: usable.map(labelOf) };
  }
  const before = labelOf(el.options[el.selectedIndex] || {});
  el.value = pick.value;
  // Both, bubbling: a page may listen for either, and a framework-controlled
  // select needs `change` while a plain one often reacts to `input`.
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, before, after: labelOf(pick), index: pick.index };
}

/**
 * Describe the element a pointer action lands on, for the result turn:
 * `<div> role=textbox "ChatGPT에게 물어보세요"`.
 *
 * Read-only. Walks into open shadow roots, then climbs to the nearest
 * interactive ancestor (a click on the <span> inside a button is a click on
 * the button). Role is the explicit `role` or the implicit one for common
 * tags; name is aria-label / labelledby / placeholder / alt / title / text.
 */
function targetAtProbe(x, y) {
  let at = document.elementFromPoint(x, y);
  while (at && at.shadowRoot) {
    const inner = at.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === at) break;
    at = inner;
  }
  if (!at) return null;
  const INTERACTIVE = 'a[href],button,input,textarea,select,summary,label,[role],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]';
  const el = (at.closest && at.closest(INTERACTIVE)) || at;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const implicit = () => {
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'img') return 'img';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      if (type === 'hidden') return '';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return '';
  };
  const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0] || implicit();
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const labelled = () => clean((el.getAttribute('aria-labelledby') || '').split(/\s+/)
    .map((id) => { const n = id && document.getElementById(id); return n ? n.textContent : ''; })
    .join(' '));
  const fieldLabel = () => (el.labels && el.labels.length ? clean(el.labels[0].textContent) : '');
  const placeholderChild = () => {
    const p = el.querySelector && el.querySelector('[data-placeholder]');
    return p ? clean(p.getAttribute('data-placeholder')) : '';
  };
  const name = clean(el.getAttribute('aria-label')) || labelled() || fieldLabel()
    || clean(el.getAttribute('placeholder')) || clean(el.getAttribute('aria-placeholder'))
    || clean(el.getAttribute('data-placeholder')) || placeholderChild()
    || clean(el.getAttribute('alt')) || clean(el.getAttribute('title'))
    || (tag === 'input' && ['button', 'submit', 'reset'].includes(type) ? clean(el.value) : '')
    || clean(el.innerText || el.textContent);
  return { tag, role, name };
}

const TARGET_NAME_MAX = 60;

/**
 * `<div> role=textbox "ChatGPT에게 물어보세요"` — or null when nothing is there.
 * A name over TARGET_NAME_MAX characters is cut and ends in "…".
 */
export function formatTarget(t) {
  if (!t || !t.tag) return null;
  let out = `<${t.tag}>`;
  if (t.role) out += ` role=${t.role}`;
  if (t.name) {
    const chars = Array.from(t.name);
    const name = chars.length > TARGET_NAME_MAX ? chars.slice(0, TARGET_NAME_MAX).join('') + '…' : t.name;
    out += ` "${name.replace(/"/g, '\'')}"`;
  }
  return out;
}

/** @returns {Promise<string|null>} the formatted target, or null if unreadable */
export async function readTargetAt(tabId, x, y) {
  try {
    return formatTarget(await evaluate(tabId, `(${targetAtProbe.toString()})(${x}, ${y})`));
  } catch (_) {
    return null;
  }
}

/**
 * The element under a point, described the way the TRAINING DATA describes it.
 *
 * The model's result lines were written by the recording executor, not by us,
 * and readTargetAt above is this panel's own reading — it climbs to the
 * nearest button or link and invents an implicit role (`<a> role=link`). The
 * trained wording does neither. Every element reads
 *
 *     <tag> [type=…] [role=…] [checked|unchecked] "text"
 *
 *   - the element elementFromPoint returns, as is: `<path>`, `<svg>`, `<div>`
 *     all appear;
 *   - type= and role= only when that HTML attribute is present;
 *   - checked/unchecked on EVERY <input> and on nothing else (1,681 unchecked
 *     + 9 checked of 1,690 inputs, 0 elsewhere) — the `checked` property as
 *     is, so a text box says `unchecked`;
 *   - the text: aria-label in full when there is one (up to 318 characters,
 *     all on <a> citation links), otherwise innerText cut at 30 characters
 *     with `...`; no quotes when there is no text.
 *   - whitespace collapsed AFTER the cut: the executor cut the raw text and
 *     the training preprocessing merged the spaces later. That is why 666 of
 *     834 cut texts are exactly 33 characters and the rest shorter — e.g.
 *     "2026년 1월 1일 중앙하이츠 구성 플랫포시티2..." is 27 + 3.
 *
 * The executor's own code is not available; the text rule is inferred from
 * the data and is the one part that is not confirmed.
 */
function feedbackTargetProbe(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const parts = [`<${tag}>`];
  const type = el.getAttribute('type');
  if (type) parts.push(`type=${type}`);
  const role = el.getAttribute('role');
  if (role) parts.push(`role=${role}`);
  if (tag === 'input') parts.push(el.checked ? 'checked' : 'unchecked');
  const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  let text = collapse(el.getAttribute('aria-label'));
  if (!text) {
    const chars = Array.from(String(el.innerText || '').trim());
    text = collapse(chars.length > 30 ? chars.slice(0, 30).join('') + '...' : chars.join(''));
  }
  if (text) parts.push(`"${text}"`);
  return parts.join(' ');
}

/** @returns {Promise<string|null>} the element in training-data form, or null if unreadable */
export async function readFeedbackTargetAt(tabId, x, y) {
  try {
    const seen = await evaluate(tabId, `(${feedbackTargetProbe.toString()})(${x}, ${y})`);
    return typeof seen === 'string' ? seen : null;
  } catch (_) {
    return null;
  }
}

/**
 * The page's visible text, as lines, for telling what a click made appear.
 *
 * MEASURED ON 쿠팡. Clicking 장바구니 담기 raises "상품이 장바구니에
 * 담겼습니다 / 장바구니 바로가기" and takes it away again on its own. The loop
 * waits for the page to fall quiet for 800ms before it photographs, so the
 * notice is gone by the time the model is shown anything — it saw the same
 * screen before and after, concluded nothing had happened, and clicked
 * 장바구니 담기 again. And again.
 *
 * Reading the text immediately after the click catches what the camera cannot,
 * and the difference between before and after is what the model never gets to
 * see. Lines rather than a blob: a diff of lines names the new sentence, where
 * a diff of characters names nothing.
 */
function pageLinesProbe() {
  const text = document.body ? document.body.innerText || '' : '';
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // One character is punctuation or a bullet; past 120 it is an article, not
    // a notice. The cap keeps a long page from being carried back whole.
    if (line.length > 1 && line.length <= 120) lines.push(line);
    if (lines.length >= 3000) break;
  }
  return lines;
}

/** @returns {Promise<string[]|null>} null when the page could not be read. */
export async function readPageLines(tabId) {
  try {
    const lines = await evaluate(tabId, `(${pageLinesProbe.toString()})()`);
    return Array.isArray(lines) ? lines : null;
  } catch (_) {
    return null;
  }
}

/** @returns {Promise<{isSelect:boolean, options?:Array, selectedIndex?:number}>} */
export async function readSelectAt(tabId, x, y) {
  try {
    return await evaluate(tabId, `(${selectAtProbe.toString()})(${x}, ${y})`);
  } catch (_) {
    return { isSelect: false };
  }
}

/** @returns {Promise<{ok:boolean, reason?:string, before?:string, after?:string}>} */
export async function chooseOption(tabId, text) {
  try {
    return await evaluate(tabId, `(${chooseOptionProbe.toString()})(${JSON.stringify(String(text))})`);
  } catch (err) {
    return { ok: false, reason: 'evaluate-failed' };
  }
}

/**
 * Remember the control under a point, so the drag that follows can be checked.
 *
 * Runs in the page and parks the element on a global, because the ANSWER has to
 * come from the same object afterwards: a slider handle moves out from under
 * the start point, so re-reading elementFromPoint at the same coordinate would
 * be asking a different element whether it changed.
 *
 * `closest` climbs to the control, since the thing under the cursor is usually
 * the handle or a child of it, not the element carrying the value.
 */
function dragTargetProbe(x, y) {
  const at = document.elementFromPoint(x, y);
  const control = at && at.closest
    ? (at.closest('input[type="range"], [role="slider"], [aria-valuenow]') || at)
    : at;
  window.__guiAgentDragTarget = control || null;
  if (!control) return { found: false, value: null };
  const raw = control.getAttribute && control.getAttribute('aria-valuenow');
  const value = typeof control.value === 'string' || typeof control.value === 'number'
    ? String(control.value)
    : (raw === null || raw === undefined ? null : String(raw));
  return { found: true, value, tag: (control.tagName || '').toLowerCase() };
}

/** Read the SAME control back. null value means "not a thing with a value". */
function dragResultProbe() {
  const control = window.__guiAgentDragTarget;
  window.__guiAgentDragTarget = null;
  if (!control) return { found: false, value: null };
  const raw = control.getAttribute && control.getAttribute('aria-valuenow');
  const value = typeof control.value === 'string' || typeof control.value === 'number'
    ? String(control.value)
    : (raw === null || raw === undefined ? null : String(raw));
  return { found: true, value, connected: Boolean(control.isConnected) };
}

/**
 * What the control under (x, y) reads, before and after a drag.
 *
 * Deliberately conservative: a null value means this element does not carry one
 * and the caller must say nothing rather than guess. Only a value that is
 * present BEFORE and identical AFTER is evidence the drag did nothing.
 */
export async function readDragTarget(tabId, x, y) {
  try {
    return await evaluate(tabId, `(${dragTargetProbe.toString()})(${x}, ${y})`);
  } catch (_) {
    return { found: false, value: null };
  }
}

export async function readDragResult(tabId) {
  try {
    return await evaluate(tabId, `(${dragResultProbe.toString()})()`);
  } catch (_) {
    return { found: false, value: null };
  }
}

export async function drag(tabId, x, y, x2, y2, { steps = 10, stepMs = 16 } = {}) {
  requireAttached(tabId);
  const held = { button: 'left', buttons: BUTTON_MASK.left, pointerType: 'mouse' };
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0, pointerType: 'mouse',
  });
  await send(tabId, 'Input.dispatchMouseEvent', { ...held, type: 'mousePressed', x, y, clickCount: 1 });
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await send(tabId, 'Input.dispatchMouseEvent', {
      ...held,
      type: 'mouseMoved',
      x: Math.round(x + (x2 - x) * t),
      y: Math.round(y + (y2 - y) * t),
      clickCount: 0,
    });
    // ONE FRAME APART. Sent back to back, all ten moves land inside a single
    // animation frame, and a slider that reads the pointer in a
    // requestAnimationFrame callback — which is how most of them avoid jank —
    // sees one position instead of a travelled path. Some never start the drag
    // at all, because their threshold is measured across frames.
    if (stepMs > 0 && i < steps) await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse',
  });
}

/**
 * Insert text into whatever currently has focus.
 * Input.insertText is used rather than per-character key events because it
 * handles IME, emoji and non-ASCII correctly in one call and is far faster.
 * It does NOT fire keydown/keyup, so if a page listens for individual key
 * presses (an autocomplete that only reacts to keydown), follow this with a
 * key() call — pressing Enter or a trailing key usually wakes such widgets.
 *
 * LINE BREAKS IN A RICH EDITOR ARE KEYSTROKES, NOT TEXT. Given "a\n\nb",
 * Input.insertText makes Blink insert "a" and then split the paragraph
 * ITSELF, building a new <div> for "b" behind the page's back. A plain
 * <textarea> takes that fine. An editor that owns its document model —
 * Notion, and most block editors — only accepts structure through its own
 * keydown handler, re-renders from its model, and throws the browser-built
 * nodes away. MEASURED IN NOTION: a 6-line `type` kept the first line and
 * nothing after the first "\n\n".
 *
 * So with `lineBreaks: 'shift-enter'` each line is inserted on its own and
 * every break is a real Shift+Enter. Shift+Enter rather than Enter because it
 * means "new line" almost everywhere — a soft break in Notion, <br> in Gmail —
 * while a bare Enter SENDS the message in Slack, Discord and most chat boxes.
 * The caller chooses, because only it knows the focus is a contenteditable;
 * a <textarea> or an <input> keeps the single insertText it always had.
 */
const LINE_BREAK = /\r\n|\r|\n/;
// A beat after each break for an editor that re-renders before it moves the
// caret. Not a frame wait: requestAnimationFrame never fires in a hidden tab.
const LINE_BREAK_SETTLE_MS = 40;

export async function type(tabId, text, { lineBreaks = 'insert' } = {}) {
  requireAttached(tabId);
  const value = String(text);
  if (lineBreaks !== 'shift-enter' || !LINE_BREAK.test(value)) {
    await send(tabId, 'Input.insertText', { text: value });
    return;
  }
  const lines = value.split(LINE_BREAK);
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) {
      await hotkey(tabId, ['shift', 'Enter']);
      await new Promise((resolve) => setTimeout(resolve, LINE_BREAK_SETTLE_MS));
    }
    // An empty line is just the break above it; insertText('') is a no-op
    // at best and a stray input event at worst.
    if (lines[i]) await send(tabId, 'Input.insertText', { text: lines[i] });
  }
}

/**
 * Key table. windowsVirtualKeyCode is what Blink turns back into
 * KeyboardEvent.keyCode, and getting it wrong is why "Enter does nothing" —
 * many forms submit on keyCode 13 specifically.
 * `text` must be set for keys that produce a character, and must be absent for
 * keys that do not (Escape, Tab in most contexts), or the page sees a stray
 * character insertion.
 */
const KEYS = Object.freeze({
  Enter:      { key: 'Enter',      code: 'Enter',      windowsVirtualKeyCode: 13, text: '\r' },
  Escape:     { key: 'Escape',     code: 'Escape',     windowsVirtualKeyCode: 27 },
  Tab:        { key: 'Tab',        code: 'Tab',        windowsVirtualKeyCode: 9,  text: '\t' },
  Backspace:  { key: 'Backspace',  code: 'Backspace',  windowsVirtualKeyCode: 8 },
  Delete:     { key: 'Delete',     code: 'Delete',     windowsVirtualKeyCode: 46 },
  ArrowUp:    { key: 'ArrowUp',    code: 'ArrowUp',    windowsVirtualKeyCode: 38 },
  ArrowDown:  { key: 'ArrowDown',  code: 'ArrowDown',  windowsVirtualKeyCode: 40 },
  ArrowLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  // Added for hotkey(): the keys that are actually combined with a modifier.
  Home:       { key: 'Home',       code: 'Home',       windowsVirtualKeyCode: 36 },
  End:        { key: 'End',        code: 'End',        windowsVirtualKeyCode: 35 },
  PageUp:     { key: 'PageUp',     code: 'PageUp',     windowsVirtualKeyCode: 33 },
  PageDown:   { key: 'PageDown',   code: 'PageDown',   windowsVirtualKeyCode: 34 },
  Insert:     { key: 'Insert',     code: 'Insert',     windowsVirtualKeyCode: 45 },
  Space:      { key: ' ',          code: 'Space',      windowsVirtualKeyCode: 32, text: ' ' },
  // F1-F12. The 21-tool `hotkey` description hands these to the model by
  // name (F3 next-match, F5 reload, F11 full screen, F12 devtools), and the
  // probe fixture has already seen it answer a task with hotkey(Alt+F4).
  // Without them resolveKey throws and, one level up, ends the whole run.
  F1:         { key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 },
  F2:         { key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 },
  F3:         { key: 'F3', code: 'F3', windowsVirtualKeyCode: 114 },
  F4:         { key: 'F4', code: 'F4', windowsVirtualKeyCode: 115 },
  F5:         { key: 'F5', code: 'F5', windowsVirtualKeyCode: 116 },
  F6:         { key: 'F6', code: 'F6', windowsVirtualKeyCode: 117 },
  F7:         { key: 'F7', code: 'F7', windowsVirtualKeyCode: 118 },
  F8:         { key: 'F8', code: 'F8', windowsVirtualKeyCode: 119 },
  F9:         { key: 'F9', code: 'F9', windowsVirtualKeyCode: 120 },
  F10:        { key: 'F10', code: 'F10', windowsVirtualKeyCode: 121 },
  F11:        { key: 'F11', code: 'F11', windowsVirtualKeyCode: 122 },
  F12:        { key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 },
});

export const SUPPORTED_KEYS = Object.freeze(Object.keys(KEYS));

/**
 * The four modifier keys. `bit` is the Input.dispatchKeyEvent `modifiers`
 * bitmask CDP defines: Alt 1, Ctrl 2, Meta/Command 4, Shift 8.
 */
const MODIFIERS = Object.freeze({
  alt:     { name: 'alt',   bit: 1, key: 'Alt',     code: 'AltLeft',     windowsVirtualKeyCode: 18 },
  option:  { name: 'alt',   bit: 1, key: 'Alt',     code: 'AltLeft',     windowsVirtualKeyCode: 18 },
  ctrl:    { name: 'ctrl',  bit: 2, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  control: { name: 'ctrl',  bit: 2, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  meta:    { name: 'meta',  bit: 4, key: 'Meta',    code: 'MetaLeft',    windowsVirtualKeyCode: 91 },
  cmd:     { name: 'meta',  bit: 4, key: 'Meta',    code: 'MetaLeft',    windowsVirtualKeyCode: 91 },
  command: { name: 'meta',  bit: 4, key: 'Meta',    code: 'MetaLeft',    windowsVirtualKeyCode: 91 },
  super:   { name: 'meta',  bit: 4, key: 'Meta',    code: 'MetaLeft',    windowsVirtualKeyCode: 91 },
  win:     { name: 'meta',  bit: 4, key: 'Meta',    code: 'MetaLeft',    windowsVirtualKeyCode: 91 },
  shift:   { name: 'shift', bit: 8, key: 'Shift',   code: 'ShiftLeft',   windowsVirtualKeyCode: 16 },
});

export const SUPPORTED_MODIFIERS = Object.freeze(['alt', 'ctrl', 'meta', 'shift']);

/**
 * Chords Blink runs through its EDITING layer rather than deriving from the
 * key event, and the `Editor::Command` name each one maps to.
 *
 * WHY THIS EXISTS, measured on the live model against CJ온스타일: `clear`
 * clicked a price field, sent ⌘A, sent Delete, logged "(클릭, 전체 선택, 삭제)"
 * — and the field kept its value, so the next `type` appended to it. The cause
 * is that Input.dispatchKeyEvent delivers a keydown the page's JavaScript can
 * observe, but the browser's native key-binding table is what turns ⌘A into
 * `selectAll`, and that table is upstream of the renderer. The event arrives,
 * ctrlKey/metaKey read true, and nothing is selected.
 *
 * `commands` is the protocol's answer: it names the editing command to execute
 * alongside the key event. The modifier and keycode fields are still sent, so
 * a page listening for the keystroke itself sees an ordinary ⌘A/Ctrl+A — this
 * adds the browser half that was missing, it does not replace the page half.
 *
 * Shift is only meaningful for z (⇧⌘Z is redo). Any other shifted chord, and
 * anything holding alt, is a DIFFERENT shortcut — ctrl+shift+a is Chrome's tab
 * search, not select-all — so no command is attached and the chord falls
 * through as a plain keystroke.
 */
const EDITING_COMMANDS = Object.freeze({
  a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo',
});

function editingCommandsFor(mods, main) {
  const name = typeof main.key === 'string' && main.key.length === 1 ? main.key.toLowerCase() : '';
  const base = Object.prototype.hasOwnProperty.call(EDITING_COMMANDS, name) ? EDITING_COMMANDS[name] : null;
  if (!base) return [];
  const held = new Set(mods.map((m) => m.name));
  if (held.has('alt')) return [];
  if (!held.has('ctrl') && !held.has('meta')) return [];
  if (held.has('shift')) return base === 'undo' ? ['redo'] : [];
  return [base];
}

function lookupModifier(name) {
  const key = String(name).toLowerCase();
  return Object.prototype.hasOwnProperty.call(MODIFIERS, key) ? MODIFIERS[key] : null;
}

/**
 * A single printable character is a key in its own right, which is what makes
 * hotkey("ctrl", "a") work without listing the whole alphabet above.
 * windowsVirtualKeyCode for a letter or digit IS its uppercase char code; for
 * punctuation that identity does not hold, so those keys are best effort.
 */
function charKey(ch) {
  const upper = ch.toUpperCase();
  let code;
  if (/[A-Z]/.test(upper)) code = `Key${upper}`;
  else if (/[0-9]/.test(ch)) code = `Digit${ch}`;
  return { key: ch, code, windowsVirtualKeyCode: upper.charCodeAt(0), text: ch };
}

/**
 * Spellings that are not the canonical name but mean one of the keys above.
 *
 * WHY THIS EXISTS. src/browserKeys.js accepts all of these in KEY_ALIASES so
 * that a chord like "ctrl+pgdn" routes, and anything it does NOT route falls
 * through to this file unchanged. That made the two vocabularies disagree: a
 * bare `esc` or `pgdn` was a spelling one module advertised and the other threw
 * on, and a throw here ends the run. The agreement is now pinned by a test.
 */
const KEY_ALIASES = Object.freeze({
  esc: 'Escape',
  return: 'Enter',
  del: 'Delete',
  left: 'ArrowLeft', arrowleft: 'ArrowLeft', leftarrow: 'ArrowLeft',
  right: 'ArrowRight', arrowright: 'ArrowRight', rightarrow: 'ArrowRight',
  up: 'ArrowUp', arrowup: 'ArrowUp', uparrow: 'ArrowUp',
  down: 'ArrowDown', arrowdown: 'ArrowDown', downarrow: 'ArrowDown',
  pgdn: 'PageDown', pgdown: 'PageDown', page_down: 'PageDown', pagedown: 'PageDown',
  pgup: 'PageUp', page_up: 'PageUp', pageup: 'PageUp',
  spacebar: 'Space', ' ': 'Space',
  numpadenter: 'Enter',
  // Spelled-out punctuation and digits. These resolve to a CHARACTER, not to a
  // named key, so the value is the character and charKey() finishes the job —
  // src/browserKeys.js folds all of them onto "=", "-" and "0" when it builds
  // a chord, and a model that writes the word instead of the glyph means this.
  plus: '=', add: '=', equal: '=', equals: '=', equalsign: '=',
  minus: '-', dash: '-', subtract: '-', hyphen: '-', underscore: '-',
  zero: '0', numpad0: '0', digit0: '0',
});

/**
 * Every spelling resolveKey accepts as a NAMED key — canonical names plus the
 * aliases above. Exported so that every key src/browserKeys.js normalizes to
 * can be asserted to be one this module can actually dispatch.
 */
export const KEY_SPELLINGS = Object.freeze([...SUPPORTED_KEYS, ...Object.keys(KEY_ALIASES)]);

/** Resolve a key name case-insensitively ("enter" -> "Enter"). */
function resolveKey(name) {
  const raw = String(name);
  if (Object.prototype.hasOwnProperty.call(KEYS, raw)) return KEYS[raw];
  const match = SUPPORTED_KEYS.find((k) => k.toLowerCase() === raw.toLowerCase());
  if (match) return KEYS[match];
  const alias = KEY_ALIASES[raw.toLowerCase()];
  if (alias) return Object.prototype.hasOwnProperty.call(KEYS, alias) ? KEYS[alias] : charKey(alias);
  if ([...raw].length === 1) return charKey(raw);
  throw new Error(
    `Unsupported key "${name}". Supported: ${SUPPORTED_KEYS.join(', ')}, ` +
    'any single character, or a modifier (' + SUPPORTED_MODIFIERS.join(', ') + ').'
  );
}

export async function key(tabId, keyName) {
  requireAttached(tabId);
  const spec = resolveKey(keyName);
  const shared = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
  };
  // rawKeyDown vs keyDown: keyDown with `text` is what produces character
  // input; without text, rawKeyDown is the correct type for a non-printing key.
  if (spec.text) {
    await send(tabId, 'Input.dispatchKeyEvent', { ...shared, type: 'keyDown', text: spec.text, unmodifiedText: spec.text });
  } else {
    await send(tabId, 'Input.dispatchKeyEvent', { ...shared, type: 'rawKeyDown' });
  }
  await send(tabId, 'Input.dispatchKeyEvent', { ...shared, type: 'keyUp' });
}

/**
 * A modifier combination: hotkey(tabId, ['ctrl', 'a']).
 *
 * The modifier keys are pressed as real key events first, not just folded into
 * the `modifiers` bitmask, because pages that listen for `keydown` on Control
 * or Shift (editors, canvas tools, shortcut overlays) never see the mask.
 * The bitmask is still required: it is what Blink turns into
 * KeyboardEvent.ctrlKey/metaKey, which is what a shortcut handler tests.
 *
 * The main key is sent as rawKeyDown with no `text` whenever a non-shift
 * modifier is held — this is the existing rawKeyDown/text distinction, and it
 * is what stops ctrl+a from inserting a literal "a" into the focused field.
 */
export async function hotkey(tabId, keys) {
  requireAttached(tabId);
  const list = (Array.isArray(keys) ? keys : [keys]).map(String).filter((k) => k.length);
  if (!list.length) throw new Error('hotkey needs at least one key.');

  const mods = [];
  let main = null;
  for (const name of list) {
    const mod = lookupModifier(name);
    if (mod) {
      if (!mods.some((m) => m.bit === mod.bit)) mods.push(mod);
      continue;
    }
    if (main) {
      throw new Error(`hotkey takes one non-modifier key, got "${main.key}" and "${name}" in [${list.join(', ')}].`);
    }
    main = resolveKey(name);
  }
  if (!main) {
    throw new Error(`hotkey [${list.join(', ')}] is modifiers only; name the key they modify, e.g. hotkey("ctrl", "a").`);
  }

  const mask = mods.reduce((acc, m) => acc | m.bit, 0);
  // Anything but a bare shift means "this is a shortcut, not typing".
  const printable = main.text && (mask === 0 || mask === MODIFIERS.shift.bit);

  let held = 0;
  for (const mod of mods) {
    held |= mod.bit;
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers: held,
      key: mod.key,
      code: mod.code,
      windowsVirtualKeyCode: mod.windowsVirtualKeyCode,
      nativeVirtualKeyCode: mod.windowsVirtualKeyCode,
    });
  }

  const shared = {
    modifiers: mask,
    key: main.key,
    code: main.code,
    windowsVirtualKeyCode: main.windowsVirtualKeyCode,
    nativeVirtualKeyCode: main.windowsVirtualKeyCode,
  };
  // Only the keyDown carries `commands`; repeating it on keyUp would execute
  // the edit twice.
  const commands = editingCommandsFor(mods, main);
  if (printable) {
    await send(tabId, 'Input.dispatchKeyEvent', { ...shared, type: 'keyDown', text: main.text, unmodifiedText: main.text, commands });
  } else {
    await send(tabId, 'Input.dispatchKeyEvent', { ...shared, type: 'rawKeyDown', commands });
  }
  await send(tabId, 'Input.dispatchKeyEvent', { ...shared, type: 'keyUp' });

  for (const mod of [...mods].reverse()) {
    held &= ~mod.bit;
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: held,
      key: mod.key,
      code: mod.code,
      windowsVirtualKeyCode: mod.windowsVirtualKeyCode,
      nativeVirtualKeyCode: mod.windowsVirtualKeyCode,
    });
  }
}

/**
 * Select-all is Cmd+A on macOS and Ctrl+A everywhere else, and a page's own
 * shortcut handlers test the matching property, so the wrong one is a no-op.
 */
function selectAllModifier() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  return /Mac|iPhone|iPad/i.test(ua) ? 'meta' : 'ctrl';
}

/**
 * What the focused editable holds. READ ONLY — this never assigns to the page.
 *
 * `kind` is what makes the answer honest. A field and a contenteditable can be
 * read back; a canvas, a cross-origin iframe or nothing-focused cannot, and
 * saying so is the difference between "it did not clear" and "I cannot tell".
 *
 * THROUGH SAME-ORIGIN FRAMES. Focus inside an <iframe> leaves the top
 * document's activeElement on the <iframe> itself, so a blog or cafe editor
 * that lives in one (네이버 블로그 mainFrame, 카페 cafe_main) read as "other".
 * A frame we may read is followed in; one we may not is `frame` — focused,
 * but not ours to read, which is "I cannot tell", not "nothing there".
 *
 * NOT EVERY .value IS A TEXT FIELD. A <button> and an <input type=checkbox>
 * have a string .value too, and used to answer `field` — so `clear` reported a
 * focused button "already empty". They are `other` now. A <select> stays
 * `field`: chooseOption, not this, is what decides it is not typed into.
 *
 * `block` is, for a contenteditable, the text of the block the caret is in.
 * `value` is the whole editing root, which in a block editor is the whole page
 * — the right thing to diff a `type` against, and the wrong thing to call "the
 * field" when deciding whether there is anything to clear.
 */
function focusedValueProbe() {
  let doc = document;
  let el = doc.activeElement;
  for (let depth = 0; el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME') && depth < 5; depth += 1) {
    let inner = null;
    try { inner = el.contentDocument; } catch (_) { inner = null; }
    if (!inner) return { kind: 'frame', value: '', tag: el.tagName.toLowerCase() };
    doc = inner;
    el = doc.activeElement;
  }
  if (!el || el === doc.body && !el.isContentEditable || el === doc.documentElement) return { kind: 'none', value: '' };
  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return { kind: 'other', value: '', tag };
  if (tag === 'input') {
    const type = String(el.type || 'text').toLowerCase();
    if (/^(button|submit|reset|image|checkbox|radio|file|color|range|hidden)$/.test(type)) {
      return { kind: 'other', value: '', tag, type };
    }
    return { kind: 'field', value: el.value, tag, type };
  }
  if (typeof el.value === 'string') return { kind: 'field', value: el.value, tag };
  if (el.isContentEditable) {
    const view = doc.defaultView || window;
    const sel = doc.getSelection ? doc.getSelection() : null;
    const anchor = sel && sel.anchorNode && el.contains(sel.anchorNode) ? sel.anchorNode : null;
    let block = anchor ? (anchor.nodeType === 1 ? anchor : anchor.parentElement) : el;
    while (block && block !== el && /^(inline|contents)$/.test(view.getComputedStyle(block).display)) {
      block = block.parentElement;
    }
    return { kind: 'editable', value: el.textContent || '', block: (block || el).textContent || '', tag };
  }
  return { kind: 'other', value: '', tag };
}

/**
 * What currently has focus, and what it holds.
 *
 * Exported because `clear` is not the only action that needs it: `type` writes
 * into the focused element and `focus` exists to produce one, and both used to
 * report success without ever asking whether there was anything to write into.
 *
 * @returns {Promise<{kind:'none'|'field'|'editable'|'other'|'unknown', value:string}>}
 */
export async function readFocused(tabId) {
  return readFocusedValue(tabId);
}

async function readFocusedValue(tabId) {
  try {
    const seen = await evaluate(tabId, `(${focusedValueProbe.toString()})()`);
    return seen && typeof seen.kind === 'string' ? seen : { kind: 'unknown', value: '' };
  } catch (_) {
    // A cross-origin focus or a context torn down mid-step. Unknown, not empty.
    return { kind: 'unknown', value: '' };
  }
}

/**
 * Empty an input: click it when given a point, select all, delete.
 *
 * WHY THE POINT IS OPTIONAL. The 21-tool schema's `clear` declares no
 * parameters: it means "empty whatever already has focus", and its system
 * prompt tells the model to focus the field first. There is no coordinate to
 * click, and clicking anyway — at (undefined, undefined), or at some remembered
 * point — would move focus off the very element the call is about. So without a
 * point the focused element IS the target, which is also what makes the
 * read-back below still the right check: it reads the focused element either
 * way, and only the question of who focused it changes.
 *
 * WHY NOT el.value = '': that is a DOM write. It cannot reach a cross-origin
 * iframe or a contenteditable the same way, and most importantly it does not
 * fire the input/change events that React, Vue and every autocomplete widget
 * listen to — the field looks empty and the app still holds the old value.
 * Keystrokes make the page clear itself. Reading the value back, below, is a
 * read; it does not reintroduce the write this paragraph refuses.
 *
 * WHY IT IS VERIFIED. This used to report "(클릭, 전체 선택, 삭제)" whether or
 * not anything was deleted — a description of the intent with nothing checking
 * it. Against a real field whose ⌘A never reached the editing layer, that line
 * told the operator and the model the field was empty when it still held a
 * price, and the next `type` appended to it. An action that silently does
 * nothing is worse than one that fails, so the caller is handed what actually
 * happened.
 *
 * LOOK BEFORE PRESSING. Select-all and Delete used to go out first and the
 * focus was asked about afterwards. With a button, a link or nothing focused,
 * select-all selects the PAGE — and in a canvas app or a file list, Delete
 * then deletes whatever that selected. The keys are sent only to a text field
 * or a contenteditable, or to a cross-origin frame (`frame`/`unknown`) where
 * they were always sent blind and the result is still reported as unknown.
 *
 * AN EMPTY BLOCK IS LEFT ALONE. In a block editor, select-all in an EMPTY
 * block does not select the block — Notion selects every block on the page,
 * and Delete then deletes them all. A block with nothing in it has nothing to
 * clear, so nothing is pressed.
 *
 * @returns {Promise<{kind: string, tag?: string, before: string, after: string,
 *   cleared: boolean|null, skipped: boolean}>}
 *   `cleared: null` means the focused element could not be read back, so
 *   nothing is claimed either way. `skipped` means no key was pressed.
 */
const visibleText = (text) => String(text || '').replace(/[\s​-‍﻿]+/g, '');

export async function clear(tabId, x, y) {
  if (x !== undefined && y !== undefined) await click(tabId, x, y);
  const before = await readFocusedValue(tabId);
  const editable = before.kind === 'editable';
  const readable = before.kind === 'field' || editable;
  const shown = (seen) => (seen.kind === 'editable' ? seen.block || '' : seen.value || '');
  const base = { kind: before.kind, tag: before.tag, type: before.type };

  if (before.kind === 'none' || before.kind === 'other') {
    return { ...base, before: '', after: '', cleared: null, skipped: true };
  }
  if (editable && !visibleText(before.block)) {
    return { ...base, before: '', after: '', cleared: true, skipped: true };
  }

  await hotkey(tabId, [selectAllModifier(), 'a']);
  // Delete rather than Backspace: with a selection both work, but Delete is
  // also correct when the field turned out to be empty and nothing selected.
  await key(tabId, 'Delete');
  const after = await readFocusedValue(tabId);

  return {
    ...base,
    before: shown(before),
    after: shown(after),
    cleared: readable ? (editable ? !visibleText(shown(after)) : shown(after) === '') : null,
    skipped: false,
  };
}

/**
 * Wheel scroll anchored at a CSS viewport coordinate. The anchor matters:
 * the element under (x, y) is what scrolls, so a modal or an inner pane
 * scrolls only if you aim at it. Positive deltaY scrolls down.
 */
export async function scroll(tabId, x, y, deltaY, deltaX = 0) {
  requireAttached(tabId);
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX,
    deltaY,
    button: 'none',
    buttons: 0,
    pointerType: 'mouse',
  });
}

/**
 * Where the thing under (x, y) is scrolled to, and how far it can still go.
 *
 * WHY NOT Page.getLayoutMetrics. The visual viewport's pageY is the DOCUMENT's
 * scroll offset. A wheel event scrolls the nearest scrollable ancestor of the
 * element under the cursor, which on a great many sites — CJ온스타일's product
 * page among them — is an inner pane, not the document. Measured against the
 * document, every one of those scrolls reads as zero movement while the
 * screenshot plainly changes. The panel then told the model the page could not
 * move, eight times running, and the model spent the rest of its step budget
 * reversing direction against a wall that was not there.
 *
 * So this reads THE SAME ELEMENT THE WHEEL WILL REACH, by walking up from
 * elementFromPoint exactly as the browser does.
 *
 * maxTop/maxLeft are what make an edge claim honest: "it did not move" and
 * "it is at the bottom" are different facts, and only one of them was ever
 * measured before.
 *
 * THE WHOLE CHAIN, NOT ONE ELEMENT. A wheel that reaches the end of an inner
 * pane carries on into the pane around it, and finally the page. Reading only
 * the innermost scroller reported "did not move, at the bottom" while the page
 * behind it scrolled. `chain` is every scroller the wheel can reach, innermost
 * first, and the caller reports whichever of them moved.
 *
 * INTO SAME-ORIGIN FRAMES. elementFromPoint stops at an <iframe>, so on 네이버
 * 블로그 (mainFrame) and 카페 (cafe_main) the old probe measured the top
 * document — which does not scroll there — and told the model "nothing under
 * that point scrolls, use PageDown" after a wheel that had worked. A frame we
 * may read is followed in, with the point moved into its coordinates. A
 * cross-origin frame cannot be read at all, and that is null: "cannot tell",
 * so the caller claims nothing.
 */
function scrollStateProbe(x, y) {
  const levels = [];
  let doc = document;
  let px = x;
  let py = y;
  let node = doc.elementFromPoint(px, py);
  while (node && (node.tagName === 'IFRAME' || node.tagName === 'FRAME') && levels.length < 5) {
    let inner = null;
    try { inner = node.contentDocument; } catch (_) { inner = null; }
    if (!inner || !inner.documentElement) return null;
    levels.push({ doc, node });
    const box = node.getBoundingClientRect();
    px -= box.left + node.clientLeft;
    py -= box.top + node.clientTop;
    doc = inner;
    node = doc.elementFromPoint(px, py);
  }
  levels.push({ doc, node });

  const measure = (el) => ({
    top: Math.round(el.scrollTop),
    left: Math.round(el.scrollLeft),
    maxTop: Math.max(0, Math.round(el.scrollHeight - el.clientHeight)),
    maxLeft: Math.max(0, Math.round(el.scrollWidth - el.clientWidth)),
  });
  const chain = [];
  for (let i = levels.length - 1; i >= 0; i -= 1) {
    const { doc: d, node: start } = levels[i];
    const view = d.defaultView || window;
    const scrolls = (el) => {
      const s = view.getComputedStyle(el);
      return (/auto|scroll|overlay/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1)
        || (/auto|scroll|overlay/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1);
    };
    for (let el = start; el && el !== d.body && el !== d.documentElement; el = el.parentElement) {
      if (scrolls(el)) chain.push(measure(el));
    }
    chain.push(measure(d.scrollingElement || d.documentElement));
  }
  // The flat fields describe the innermost scroller, as they always have.
  return { inner: chain.length > 1, frame: levels.length > 1, ...chain[0], chain };
}

export async function readScrollAt(tabId, x, y) {
  try {
    const seen = await evaluate(tabId, `(${scrollStateProbe.toString()})(${Number(x)}, ${Number(y)})`);
    return seen && typeof seen.top === 'number' ? seen : null;
  } catch (_) {
    // Cross-origin document, or the context went away mid-step. Null means
    // "cannot tell", and the caller claims nothing rather than guessing.
    return null;
  }
}

/**
 * The offset after the scroll has finished moving.
 *
 * A wheel scroll is ANIMATED — Chrome smooth-scrolls wheel input, and pages
 * add `scroll-behavior: smooth` on top of that. Reading the offset in the same
 * tick as the dispatch reads the position before the animation has run, which
 * is the second way a scroll that worked reported zero.
 */
export async function settleScrollAt(tabId, x, y, { budgetMs = 900, pollMs = 60 } = {}) {
  const deadline = Date.now() + budgetMs;
  let previous = null;
  // Still means every scroller in the chain has stopped, not just the first.
  const where = (s) => (s.chain || [s]).map((c) => `${c.top},${c.left}`).join('|');
  while (Date.now() < deadline) {
    const current = await readScrollAt(tabId, x, y);
    if (!current) return null;
    if (previous && where(current) === where(previous)) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return previous;
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Schemes the agent is allowed to navigate to.
 *
 * WHY THIS LIST IS SHORT: the URL comes from a model, and Page.navigate will
 * happily run `javascript:` in the page's own origin, read `file:` off the
 * disk, or hand `data:`/`blob:` a document that inherits trust. A prompt
 * injection on any visited page could then exfiltrate whatever the browser is
 * logged into. The check lives HERE rather than in the parser so that every
 * caller — model, manual box, future code — goes through it.
 */
const NAVIGABLE_SCHEMES = Object.freeze(['http:', 'https:']);

export async function navigate(tabId, url) {
  requireAttached(tabId);
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch (_) {
    throw new Error(`goto: "${url}" is not an absolute URL. Write the scheme, e.g. https://naver.com`);
  }
  if (!NAVIGABLE_SCHEMES.includes(parsed.protocol)) {
    throw new Error(
      `goto refuses "${parsed.protocol}" URLs; only ${NAVIGABLE_SCHEMES.join(' and ')} are navigable. ` +
      'A model-supplied javascript:, file: or data: URL would run with the page\'s privileges.'
    );
  }
  const res = await send(tabId, 'Page.navigate', { url: parsed.href });
  if (res && res.errorText) {
    throw new Error(`Navigation to ${parsed.href} failed: ${res.errorText}`);
  }
  return parsed.href;
}

/**
 * Step through the tab's session history.
 *
 * Returns the URL moved to, or null when there is nothing in that direction.
 * Null rather than a throw: "already at the first page" is a normal state of
 * the world, not a broken step, and aborting a run over it would be wrong.
 *
 * @param {'back'|'forward'} direction
 */
export async function navigateHistory(tabId, direction) {
  requireAttached(tabId);
  if (direction !== 'back' && direction !== 'forward') {
    throw new Error(`navigateHistory direction must be "back" or "forward", got "${direction}".`);
  }
  const history = await send(tabId, 'Page.getNavigationHistory');
  const entries = (history && history.entries) || [];
  const target = (history ? history.currentIndex : 0) + (direction === 'back' ? -1 : 1);
  if (target < 0 || target >= entries.length) return null;
  await send(tabId, 'Page.navigateToHistoryEntry', { entryId: entries[target].id });
  return entries[target].url || '';
}

/**
 * Evaluate an expression in the page's main world.
 * Used only to install the debug overlay on tabs that were already open when
 * the extension loaded (a declared content script does not retroactively
 * inject into those). Returns the remote result value when there is one.
 */
export async function evaluate(tabId, expression, { awaitPromise = false } = {}) {
  requireAttached(tabId);
  const res = await send(tabId, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const text = res.exceptionDetails.exception
      ? res.exceptionDetails.exception.description || res.exceptionDetails.exception.value
      : res.exceptionDetails.text;
    throw new Error(`Page evaluation failed: ${text}`);
  }
  return res.result ? res.result.value : undefined;
}
