/**
 * downloads.js — what this run downloaded, and where Chrome put it.
 *
 * WHY chrome.downloads AND NOT CDP. Browser.setDownloadBehavior can point
 * downloads at a directory, but it cannot tell us the name Chrome settled on
 * — a duplicate becomes `report (1).pptx`, a server can rename via
 * Content-Disposition, and a blocked download never arrives at all. The
 * extension API reports the final absolute path, which is also exactly what
 * DOM.setFileInputFiles needs to upload the file again. One source of truth
 * for both halves of "download it, then upload it".
 *
 * ONLY WHAT THIS RUN FETCHED. The watcher is started with the run and stopped
 * with it, so a file downloaded yesterday is never offered to a file chooser.
 *
 * `api` is injected so the tests drive a stub instead of Chrome.
 */

/**
 * @param {object} [api] chrome.downloads, or a stub with the same three parts
 */
export function createDownloadWatcher(api = (globalThis.chrome && globalThis.chrome.downloads)) {
  /** Completed downloads, OLDEST first — the order fileTransfer reverses. */
  const done = [];
  /** Not yet reported to the model. */
  const fresh = [];
  let listener = null;

  /** Chrome reports completion on the CHANGE, which carries only the id. */
  const onChanged = (delta) => {
    if (!delta || delta.state?.current !== 'complete') return;
    api.search({ id: delta.id }, (items) => {
      void (globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.lastError);
      const item = (items || [])[0];
      // `filename` is the absolute path Chrome wrote to. An interrupted or
      // cancelled download has no usable path and must not be offered for
      // upload — `exists` is false the moment the file is moved or deleted.
      if (!item || !item.filename || item.exists === false) return;
      if (done.includes(item.filename)) return;
      done.push(item.filename);
      fresh.push(item.filename);
    });
  };

  return {
    start() {
      if (listener || !api) return;
      listener = onChanged;
      api.onChanged.addListener(listener);
    },
    stop() {
      if (!listener || !api) return;
      api.onChanged.removeListener(listener);
      listener = null;
    },
    /** Paths completed since the last call, and clears them. */
    take() {
      return fresh.splice(0, fresh.length);
    },
    /** Everything this run has downloaded, oldest first. */
    all() {
      return [...done];
    },
    /** Forgets the run. Called when a run starts, not when it ends. */
    reset() {
      done.length = 0;
      fresh.length = 0;
    },
  };
}
