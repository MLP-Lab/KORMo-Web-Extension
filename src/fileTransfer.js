/**
 * fileTransfer.js — which file the `upload` tool means, and what the model is
 * told about files.
 *
 * THE SAME WALL AS THE <select> POPUP AND THE ALERT. Clicking "파일 업로드" or
 * "컴퓨터에서 선택" opens an OS file dialog. It is drawn by the operating
 * system, so it is not in Page.captureScreenshot and no CDP input event can
 * reach it. cdp.js intercepts it so it is never drawn, the panel keeps it
 * PENDING, and the action that opened it is answered with the training data's
 * own " A file chooser opened." The model then calls `upload(path)` and the
 * file goes in.
 *
 * THE WORDING IS THE TRAINED ONE:
 *
 *   the click that opened it   … executed. Note: … A file chooser opened.
 *   upload into that chooser   Succeed: `upload` uploaded "puppy.jpg". The
 *                              file(s) puppy.jpg were selected and uploaded
 *                              (in that order). The image now shown on the
 *                              page is puppy.jpg.
 *   upload with no chooser     Succeed: `upload` uploaded "puppy.jpg".
 *   a download                 … executed. Note: … The file NAME was downloaded.
 *
 * `path` is what the model wrote: a file name ("puppy.jpg"), or the literal
 * "Downloads", which in the data means the file this run downloaded.
 *
 * This module is pure: no chrome, no CDP, so the policy can be tested.
 */

/** The name at the end of an absolute path, for the sentence the model reads. */
export function baseName(path) {
  const cleaned = String(path || '').replace(/[/\\]+$/, '');
  const cut = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return cut === -1 ? cleaned : cleaned.slice(cut + 1);
}

/**
 * Absolute paths, one per line, from the panel's box.
 *
 * Blank lines and surrounding whitespace go: a path pasted from a file manager
 * routinely arrives with a trailing space, and a stray space breaks the
 * upload.
 */
export function parseUploadFiles(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** An absolute path on this machine: `/…`, `~/…` is NOT one, `C:\…` is. */
const isAbsolute = (path) => /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path);

/** "Downloads", "downloads", "~/Downloads", "/Users/me/Downloads/" — the downloads folder. */
const isDownloads = (path) => /^(?:.*[/\\])?downloads[/\\]?$/i.test(String(path).trim());

/**
 * The file(s) an `upload(path)` call means.
 *
 *   absolute path       itself
 *   "Downloads"         what this run downloaded, most recent first
 *   a name ("a.jpg")    the entry of the panel's list with that base name,
 *                       else the most recent download with that base name
 *
 * A one-file target gets one file; a `selectMultiple` chooser gets every
 * candidate.
 *
 * @param {object} o
 * @param {string} o.path                 what the model wrote
 * @param {'selectSingle'|'selectMultiple'} [o.mode]
 * @param {string[]} [o.uploadFiles]      the panel's list, in order
 * @param {string[]} [o.downloaded]       what this run downloaded, OLDEST first
 * @returns {{files: string[]} | {error: string}}
 */
export function resolveUpload({ path, mode = 'selectSingle', uploadFiles = [], downloaded = [] }) {
  const asked = String(path == null ? '' : path).trim();
  if (!asked) return { error: 'needs a file name.' };
  const newestFirst = [...downloaded].reverse();
  let candidates;
  if (isAbsolute(asked) && !isDownloads(asked)) {
    candidates = [asked];
  } else if (isDownloads(asked)) {
    candidates = newestFirst;
    if (!candidates.length) return { error: 'no file has been downloaded in this run.' };
  } else {
    const name = baseName(asked);
    candidates = [...uploadFiles, ...newestFirst].filter((p) => baseName(p) === name).slice(0, 1);
    if (!candidates.length) return { error: `file "${asked}" not found.` };
  }
  return { files: mode === 'selectMultiple' ? candidates : candidates.slice(0, 1) };
}

/** Appended, same line, to the action that opened a file chooser. */
export const CHOOSER_OPENED = 'A file chooser opened.';

/**
 * Our own sentence, on its own line, saying what the training sentence does
 * not: that the chooser is unreachable and `upload` is the only way through.
 *
 * WHY IT HAD TO BE ADDED. MEASURED against the live 4B checkpoint, replaying
 * the exact transcript of a real run on an upload page: given the training
 * line alone the model called `upload` 0 times out of 5. It clicked the same
 * 파일 선택 control again, invented a `Control+Shift+Open` shortcut, opened
 * the find bar — because the screenshot never changes when a chooser is
 * intercepted, and nothing it had been told contradicted what it saw. With
 * this line added: 6 of 8.
 *
 * It is SEPARATE from CHOOSER_OPENED, on its own line, for the same reason a
 * dialog's explanation is: the training wording stays exactly as the data has
 * it, and what this harness knows and the data does not goes beside it rather
 * than inside it.
 */
export const CHOOSER_HELP = 'The file chooser is operating-system UI: it is not in the '
  + 'screenshot and no click or key can reach it. The only way to attach a file is `upload(path)`.';

/**
 * What the model is told when the tab is showing a PDF.
 *
 * MEASURED. A run found a paper, opened "Full paper (PDF)", and then pressed
 * the viewer's download icon six times across two sites and two routes,
 * inventing a "Control+Shift+9" shortcut along the way. Nothing happened and
 * nothing could: Chrome's PDF viewer is not the page. It is drawn by the
 * browser into the tab, so it photographs — which is why the model could see
 * the icon — but CDP input goes to the page's renderer and never reaches it.
 * The find bar, the address bar and the file chooser are the same wall, and
 * this repo answers that wall the same way every time: do the thing the UI
 * would have done, and say so in words the model can act on.
 */
export const PDF_DOWNLOADED = 'This tab is showing a PDF in the browser\'s own viewer. '
  + 'The viewer\'s toolbar is browser UI: it is not part of the page and cannot be clicked. '
  + 'The file has been downloaded for you, so there is nothing left to press here.';

/**
 * What a pointer action gets while the tab is showing a PDF.
 *
 * MEASURED, the hard way. The viewer's download icon DOES take a CDP click —
 * and what it opens is the macOS save panel, which is drawn by the operating
 * system, is not in the screenshot, cannot be dismissed by CDP, and blocks
 * the window until a person clicks it. One stray click on a toolbar the model
 * can see and should not touch ends the run and needs a human to recover it.
 *
 * So the click is refused before it is dispatched. There is nothing in a PDF
 * for a pointer to do that this harness can carry out anyway, and the file is
 * already downloaded by the time this is read.
 */
export const pdfNotClickableLine = (tool) => 'Failed: `' + tool + '` the browser\'s PDF '
  + 'viewer is browser UI, not page content, and clicking it opens an operating-system '
  + 'window that cannot be seen or closed from here. The file has already been downloaded, '
  + 'so go on with the rest of the task somewhere else.';

/**
 * The same fact, for a step that did not open the chooser but is still in
 * front of one. A chooser stays open until `upload` fills it, and a model
 * that wandered off needs telling more than once.
 */
export const CHOOSER_WAITING = 'A file chooser is still open and waiting. It is not in the '
  + 'screenshot and cannot be clicked. Attach the file with `upload(path)`.';

/** Appended, same line, to the action that caused a download. */
export const downloadedLine = (names) =>
  names.map((name) => `The file ${name} was downloaded.`).join(' ');

/**
 * The `upload` result line.
 *
 * @param {string} path         what the model wrote, quoted back as written
 * @param {string[]} names      base names of the files put in
 * @param {boolean} chooser     true when a pending chooser was filled
 */
export function uploadResultLine(path, names, chooser) {
  const head = `Succeed: \`upload\` uploaded "${path}".`;
  if (!chooser) return head;
  const list = names.join(', ');
  return `${head} The file(s) ${list} were selected and uploaded (in that order). ` +
    `The image now shown on the page is ${list}.`;
}

/** The short failure line. No advice: the training data has none to imitate. */
export const uploadFailedLine = (why) => `Failed: \`upload\` ${why}`;
