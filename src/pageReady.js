/** Readiness is checked before AND after capture, so a redirect during capture
 * cannot send a screenshot of the previous document to the model. */
export const PAGE_READY_TIMEOUT_MS = 3000;
export const PAGE_SETTLE_MS = 800;

function abortIfRequested(shouldAbort) {
  if (!shouldAbort()) return;
  const error = new Error('페이지 로딩 대기를 중지했습니다.');
  error.name = 'AbortError';
  throw error;
}

export function isPageReady(tab, page) {
  return tab.status === 'complete' && page && page.readyState === 'complete' &&
    page.fontsReady && page.imagesReady && page.networkReady !== false;
}

export function sameDocument(before, after) {
  return before && after && before.url === after.url && before.timeOrigin === after.timeOrigin;
}

/** Polling also handles a load that finished before we began listening.
 * Return null at the deadline so the caller can capture the current page. */
export async function waitForPageReady(tabId, readPage, {
  shouldAbort = () => false,
  onWait = () => {},
  timeoutMs = PAGE_READY_TIMEOUT_MS,
  settleMs = PAGE_SETTLE_MS,
  pollMs = 100,
  deadline = Date.now() + timeoutMs,
} = {}) {
  let stableSince = null;
  let previous = null;
  let notified = false;
  while (true) {
    abortIfRequested(shouldAbort);
    if (Date.now() >= deadline) {
      return null;
    }
    const tab = await chrome.tabs.get(tabId);
    abortIfRequested(shouldAbort);
    let page = null;
    if (tab.status === 'complete') {
      try {
        page = await readPage(tabId);
      } catch (err) {
        // Navigation can destroy the execution context between tabs.get and
        // Runtime.evaluate. Other failures (closed tab, detach) must surface.
        if (!/execution context.*destroy|cannot find context|cannot find default execution context|inspected target navigated/i.test(err.message)) throw err;
      }
    }
    abortIfRequested(shouldAbort);
    if (isPageReady(tab, page)) {
      if (!sameDocument(previous, page) || stableSince === null) stableSince = Date.now();
      previous = page;
      if (Date.now() - stableSince >= settleMs && page.quietForMs >= settleMs) return page;
    } else {
      stableSince = null;
      previous = null;
    }
    if (!notified) {
      notified = true;
      onWait();
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}

/** Runs in the target page, not in the extension. Ignore our own click rings
 * and captions so they do not keep postponing screenshots. */
export function pageReadinessProbe() {
  // ALL FOUR ROOTS, not two. The find bar, the address bar, their stylesheet
  // and the zoom write (content/browserUi.js) are our writes too, and while
  // they were missing from this list every find-bar interaction made the next
  // capture sit out PAGE_SETTLE_MS of quiet that we had disturbed ourselves.
  const IGNORED = '#gui-agent-overlay-root, #gui-agent-overlay-style, ' +
    '#gui-agent-browser-ui-root, #gui-agent-browser-ui-style';
  const key = '__guiAgentReadiness';
  let monitor = window[key];
  if (!monitor || monitor.document !== document) {
    monitor = { document, lastChange: performance.now() };
    const isOverlay = node => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      return el && el.closest(IGNORED);
    };
    monitor.observer = new MutationObserver(records => {
      if (records.some(record => !isOverlay(record.target) &&
        (record.type !== 'childList' || [...record.addedNodes, ...record.removedNodes].some(node => !isOverlay(node))))) {
        monitor.lastChange = performance.now();
      }
    });
    monitor.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    window[key] = monitor;
  }
  // The observer cleans itself up if the panel is stopped or closed.
  clearTimeout(monitor.cleanup);
  monitor.cleanup = setTimeout(() => {
    monitor.observer.disconnect();
    if (window[key] === monitor) delete window[key];
  }, 35000);
  const imagesReady = [...document.images].every(image => {
    const rect = image.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < innerHeight && rect.left < innerWidth;
    return !visible || image.complete;
  });
  return {
    readyState: document.readyState,
    fontsReady: !document.fonts || document.fonts.status === 'loaded',
    imagesReady,
    quietForMs: performance.now() - monitor.lastChange,
    url: location.href,
    timeOrigin: performance.timeOrigin,
  };
}
