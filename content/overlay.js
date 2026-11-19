/**
 * overlay.js — visual feedback drawn on the page before every click.
 *
 * This is not decoration. It is the coordinate debugger: the ring is drawn
 * with the exact same CSS viewport pixel values that are handed to CDP's
 * Input.dispatchMouseEvent. If the ring lands somewhere other than the thing
 * the agent meant to click, the coordinate mapping in src/coords.js is wrong,
 * and you can see it instantly instead of inferring it from a failed step.
 * It also makes a live demo legible to an audience.
 *
 * It runs in two different worlds, and both paths are real:
 *   1. As a declared content script (see manifest.json). This is the normal
 *      path. It runs in the isolated world, so it can use chrome.runtime and
 *      the side panel drives it with chrome.tabs.sendMessage. The matching
 *      CSS is injected declaratively by the manifest.
 *   2. Evaluated into the page's MAIN world over CDP (Runtime.evaluate) by the
 *      side panel. This is needed for tabs that were already open when the
 *      extension was loaded, because a newly declared content script is not
 *      retroactively injected into them. In that world chrome.runtime does not
 *      exist, so there is no message listener; the side panel calls
 *      `__guiAgentOverlay.flash(...)` directly via Runtime.evaluate, and calls
 *      installStyles() once with the text of overlay.css.
 *
 * The whole file is one IIFE assigning to a single global, which makes
 * re-evaluation harmless (no "identifier already declared" from a second
 * Runtime.evaluate, no duplicate listeners).
 */

(function () {
  'use strict';

  const ROOT_ID = 'gui-agent-overlay-root';
  const STYLE_ID = 'gui-agent-overlay-style';
  const RING_LIFETIME_MS = 650; // slightly longer than the 600ms CSS animation
  const NOTE_LIFETIME_MS = 1850;

  // Re-evaluating the file must not re-register the message listener.
  const existing = window.__guiAgentOverlay;
  const listenerAlreadyBound = Boolean(existing && existing.__listenerBound);

  /**
   * The root is position:fixed/inset:0, so a child positioned with
   * `left: Npx; top: Mpx` sits at CSS viewport pixel (N, M) — the same space
   * Input.dispatchMouseEvent uses. No conversion, by construction.
   * Attached to documentElement rather than body so it survives pages that
   * replace document.body.
   */
  function getRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root && root.isConnected) return root;
    root = document.createElement('div');
    root.id = ROOT_ID;
    // Inline fallbacks so the overlay still works if neither the manifest CSS
    // nor installStyles() ran. The stylesheet repeats these with !important.
    root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483647;margin:0;padding:0;border:0;';
    (document.documentElement || document.body).appendChild(root);
    return root;
  }

  function removeLater(node, ms) {
    setTimeout(() => {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }, ms);
  }

  /** Inject overlay.css as a <style> tag. Only needed on the CDP main-world path. */
  function installStyles(cssText) {
    if (document.getElementById(STYLE_ID)) return true;
    if (typeof cssText !== 'string' || !cssText) return false;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = cssText;
    (document.head || document.documentElement).appendChild(style);
    return true;
  }

  /**
   * Draw the click marker at a CSS viewport pixel.
   * @param {number} x CSS px from the left edge of the visual viewport
   * @param {number} y CSS px from the top edge of the visual viewport
   * @param {string} [label] optional caption, e.g. the raw model coordinate
   */
  function flash(x, y, label) {
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return false;

    const root = getRoot();

    const hair = document.createElement('div');
    hair.className = 'gui-agent-ov-crosshair gui-agent-ov-crosshair--h';
    hair.style.top = py + 'px';

    const vair = document.createElement('div');
    vair.className = 'gui-agent-ov-crosshair gui-agent-ov-crosshair--v';
    vair.style.left = px + 'px';

    const ring = document.createElement('div');
    ring.className = 'gui-agent-ov-ring';
    ring.style.left = px + 'px';
    ring.style.top = py + 'px';

    root.appendChild(hair);
    root.appendChild(vair);
    root.appendChild(ring);
    removeLater(hair, RING_LIFETIME_MS);
    removeLater(vair, RING_LIFETIME_MS);
    removeLater(ring, RING_LIFETIME_MS);

    if (label) {
      const tag = document.createElement('div');
      tag.className = 'gui-agent-ov-label';
      tag.textContent = label;
      tag.style.left = px + 'px';
      tag.style.top = py + 'px';
      root.appendChild(tag);
      removeLater(tag, RING_LIFETIME_MS);
    }
    return true;
  }

  /** Transient caption in the top-right corner: the current action/output. */
  function note(text) {
    if (!text) return false;
    const root = getRoot();
    const existingNote = root.querySelector('.gui-agent-ov-note');
    if (existingNote) existingNote.remove();
    const el = document.createElement('div');
    el.className = 'gui-agent-ov-note';
    el.textContent = String(text);
    root.appendChild(el);
    removeLater(el, NOTE_LIFETIME_MS);
    return true;
  }

  /**
   * The file chooser, drawn IN the page.
   *
   * WHY IT IS DRAWN AT ALL. An intercepted file chooser changes nothing on
   * screen: the OS window is never created, and the page looks exactly as it
   * did before the button was pressed. MEASURED over four real runs on an
   * upload page, the agent read "A file chooser opened.", wrote in its own
   * reasoning that the chooser had opened, and then pressed the same button
   * again — nine times in one run — because the screenshot disagreed with the
   * sentence and the screenshot is what it is trained to trust. Its own system
   * prompt tells it not to assume a change it has not observed.
   *
   * So the change is made observable. This is the same answer this extension
   * already gives for the find bar and the address bar: browser UI that cannot
   * be photographed gets drawn inside the page, which is what the training
   * harness did too.
   *
   * It is NOT clickable (the root is pointer-events:none). It names the files
   * that `upload` can actually reach, so the one action that works is the one
   * written on screen.
   */
  function chooser(files, multiple) {
    const root = getRoot();
    const old = root.querySelector('.gui-agent-ov-chooser');
    if (old) old.remove();

    const box = document.createElement('div');
    box.className = 'gui-agent-ov-chooser';

    const head = document.createElement('div');
    head.className = 'gui-agent-ov-chooser__head';
    head.textContent = '파일 선택 창이 열려 있습니다 · File chooser is open';
    box.appendChild(head);

    const names = Array.isArray(files) ? files.filter(Boolean) : [];
    if (names.length) {
      const list = document.createElement('ul');
      list.className = 'gui-agent-ov-chooser__list';
      for (const name of names.slice(0, 8)) {
        const row = document.createElement('li');
        row.textContent = String(name);
        list.appendChild(row);
      }
      box.appendChild(list);
    }

    const hint = document.createElement('div');
    hint.className = 'gui-agent-ov-chooser__hint';
    hint.textContent = names.length
      ? (multiple
        ? 'This window cannot be clicked. Call upload("<name>") to attach one, '
          + 'or upload("Downloads") to attach all of them.'
        : 'This window cannot be clicked. Call upload("<name>") to attach one of these.')
      : 'This window cannot be clicked, and no file is available yet. '
        + 'Download a file first, then call upload("Downloads").';
    box.appendChild(hint);

    root.appendChild(box);
    return true;
  }

  /** Take it down: the files went in, or the run ended. */
  function chooserClose() {
    const root = document.getElementById(ROOT_ID);
    const box = root && root.querySelector('.gui-agent-ov-chooser');
    if (box) box.remove();
    return true;
  }

  /** Remove every trace of the overlay from the page. */
  function clear() {
    const root = document.getElementById(ROOT_ID);
    if (root && root.parentNode) root.parentNode.removeChild(root);
    return true;
  }

  window.__guiAgentOverlay = {
    version: 1,
    flash,
    note,
    chooser,
    chooserClose,
    clear,
    installStyles,
    __listenerBound: listenerAlreadyBound,
  };

  // Isolated-world (content script) path only. In the main world injected over
  // CDP, `chrome` is either undefined or has no runtime.onMessage, so this is
  // skipped and the side panel drives the API through Runtime.evaluate instead.
  const hasMessaging =
    typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage;

  if (hasMessaging && !listenerAlreadyBound) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.channel !== 'gui-agent-overlay') return undefined;
      switch (msg.type) {
        case 'ping':
          sendResponse({ ok: true, version: 1 });
          break;
        case 'flash':
          sendResponse({ ok: flash(msg.x, msg.y, msg.label) });
          break;
        case 'note':
          sendResponse({ ok: note(msg.text) });
          break;
        case 'chooser':
          sendResponse({ ok: chooser(msg.files, msg.multiple) });
          break;
        case 'chooserClose':
          sendResponse({ ok: chooserClose() });
          break;
        case 'clear':
          sendResponse({ ok: clear() });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown overlay message "${msg.type}"` });
      }
      // Synchronous response; no need to keep the channel open.
      return undefined;
    });
    window.__guiAgentOverlay.__listenerBound = true;
  }
})();
