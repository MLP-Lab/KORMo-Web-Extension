/**
 * sidepanel.js — the UI and the agent run loop.
 *
 * WHY THE LOOP LIVES HERE AND NOT IN THE SERVICE WORKER:
 * An MV3 background service worker is terminated by Chrome after roughly 30
 * seconds of inactivity, and "waiting on a fetch to a slow VLM" does not
 * reliably count as activity. A 20-step run would be killed halfway through,
 * leaving the debugger attached and the page half-driven. The side panel is an
 * ordinary extension document: it lives as long as the panel is open, keeps
 * its JS heap, and can hold the loop state and the abort flag. Closing the
 * panel ends the run, which is the behaviour you want anyway.
 *
 * ABORT: `state.abort` is checked between every awaited stage of every step
 * (before the screenshot, after it, after the model call, before the action,
 * and during the inter-step delay). Stop therefore takes effect within one
 * in-flight CDP command rather than at the end of the run.
 */

import * as cdp from './src/cdp.js';
import {
  COORD_MODES,
  MODE_HELP,
  DEFAULT_COORD_CONFIG,
  getCoordConfig,
  setCoordConfig,
  toViewportPx,
} from './src/coords.js';
import { waitForPageReady } from './src/pageReady.js';
import { parseModelOutput, describeAction, TERMINAL_ACTIONS } from './src/actions.js';
import { buildProfileRequest, parseProfileReply, formatSettings, readableUrl } from './src/modelProfile.js';
import { createMockModel, parseScenario } from './src/mockModel.js';
import { createBrowserRoutes, resolveAddress, googleSearch } from './src/browserRoutes.js';
import { createRelayClient } from './src/relayClient.js';
import { pngDimensions, renderTrajectoryHtml, trajectoryFilename } from './src/trajectoryReport.js';
import { createDownloadWatcher } from './src/downloads.js';
import { parseUploadFiles, baseName, downloadedLine, resolveUpload, uploadResultLine,
  uploadFailedLine, CHOOSER_OPENED, CHOOSER_HELP, CHOOSER_WAITING,
  PDF_DOWNLOADED, pdfNotClickableLine } from './src/fileTransfer.js';

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  task: $('task'),
  startUrl: $('startUrl'),
  run: $('run'),
  stop: $('stop'),
  saveTrajectory: $('saveTrajectory'),
  chooseTrajectoryFolder: $('chooseTrajectoryFolder'),
  trajectoryFolder: $('trajectoryFolder'),
  target: $('target'),
  captureInfo: $('captureInfo'),
  useMock: $('useMock'),
  sendTools: $('sendTools'),
  toolChoice: $('toolChoice'),
  scenario: $('scenario'),
  baseUrl: $('baseUrl'),
  apiKey: $('apiKey'),
  modelName: $('modelName'),
  temperature: $('temperature'),
  topP: $('topP'),
  topK: $('topK'),
  maxTokens: $('maxTokens'),
  maxSteps: $('maxSteps'),
  stepDelay: $('stepDelay'),
  loadWaitSeconds: $('loadWaitSeconds'),
  modelTimeoutSeconds: $('modelTimeoutSeconds'),
  coordMode: $('coordMode'),
  coordHelp: $('coordHelp'),
  pixelFields: $('pixelFields'),
  modelInputWidth: $('modelInputWidth'),
  modelInputHeight: $('modelInputHeight'),
  log: $('log'),
  clearLog: $('clearLog'),
  devSettings: $('devSettings'),
  showRawReply: $('showRawReply'),
  autoSaveTrajectory: $('autoSaveTrajectory'),
  discordEnabled: $('discordEnabled'),
  discordRelay: $('discordRelay'),
  discordStatus: $('discordStatus'),
  richResults: $('richResults'),
  trainingResults: $('trainingResults'),
  uploadFiles: $('uploadFiles'),
  showRawRequest: $('showRawRequest'),
  dialogPolicy: $('dialogPolicy'),
  dialogAsk: $('dialogAsk'),
  dialogAskText: $('dialogAskText'),
  dialogAskHint: $('dialogAskHint'),
  dialogAccept: $('dialogAccept'),
  dialogDismiss: $('dialogDismiss'),
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const SETTINGS_KEY = 'guiAgentSettings';

const state = {
  running: false,
  abort: false,
  // The in-flight model request, so Stop can cut a call that is still waiting
  // instead of leaving the panel silent until the timeout.
  pending: null,
  // Set when something other than the Stop button ended the run, so the final
  // line does not blame a button nobody pressed.
  abortReason: null,
  tabId: null,
  // The previous pointer action and the element that was under it, for the
  // ghost check in repeatedGhost.
  lastPointer: null,
  // Where the mouse IS: the last point a pointer action aimed at, and on which
  // tab. Unlike lastPointer this survives a `type` or a `wait` in between,
  // because the mouse does — and a coordinate-free scroll wheels here. See
  // pointerFor.
  pointer: null,
  // Popup tab id -> the tab it was opened from, for every popup the run
  // followed. When a popup closes itself the run goes back there instead of
  // ending. See drivenTabGone.
  openers: new Map(),
  // A sentence for the next result turn about a tab change the model did not
  // make itself — a popup that closed on its own.
  tabNote: null,
  // The dialog the previous pointer action raised, and how many times that
  // same action at that same place has raised that same text. See
  // repeatedDialog.
  lastDialog: null,
  // False until the run has executed its first action. A tab opened before
  // that cannot be the result of anything the model did — see startTabWatch.
  acted: false,
  history: [],
  trajectory: null,
};

const mockModel = createMockModel();

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

function log(kind, text) {
  const row = document.createElement('div');
  row.className = `log__row log__row--${kind}`;

  const time = document.createElement('span');
  time.className = 'log__time';
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  if (state.trajectory && !state.trajectory.endedAt) {
    state.trajectory.logs.push({ kind, text, time: time.textContent });
  }

  const body = document.createElement('span');
  body.className = 'log__text';
  body.textContent = text;

  row.append(time, body);
  els.log.appendChild(row);
  els.log.scrollTop = els.log.scrollHeight;
}

/** Errors are never swallowed: they land in the log and flip the status pill. */
function logError(err) {
  const message = err && err.message ? err.message : String(err);
  log('error', message);
  setStatus('error', 'error');
}

function setStatus(kind, text) {
  els.status.className = `pill pill--${kind}`;
  els.status.textContent = ({ idle: '대기 중', attached: '연결됨', running: '실행 중', error: '오류' })[text] || text;
}

/* ------------------------------------------------------------------ */
/* The question a page asks                                            */
/* ------------------------------------------------------------------ */

/**
 * How long a confirm waits for a person before the safe answer is taken.
 *
 * A dialog left open holds that tab's renderer frozen, so there has to be an
 * end to the waiting. A minute is long enough to read the sentence and decide,
 * and short enough that a run nobody is watching — one that came in over
 * Discord, say — does not sit there until the panel is closed.
 */
const DIALOG_ANSWER_MS = 60000;

/**
 * The question on screen right now, or null. Held so 중지 can end it: while a
 * dialog is open the loop is parked inside one CDP command and never reaches
 * the abort flag, so the button has to answer the dialog itself.
 */
let pendingDialog = null;

/**
 * Ask the operator whether to accept a confirm or a prompt.
 *
 * WHY A PERSON AND NOT A RULE. Answering every confirm no was safe and
 * useless: 쿠팡's 선택삭제 asks "선택한 상품을 삭제하시겠습니까?", so the task
 * the operator typed could never finish, and the model — seeing the item still
 * there — pressed the button again. Answering every confirm yes is worse: this
 * panel drives a browser logged into the operator's own accounts, and a
 * mis-aimed click would then confirm a deletion or a payment on their behalf.
 * Neither rule can tell those two apart. A person reading the sentence can.
 *
 * THIS WORKS WHILE THE PAGE IS FROZEN because the panel is a separate
 * document in a separate process. The dialog blocks that tab's renderer; the
 * buttons below and the timer counting down are not in it.
 *
 * @returns {boolean | Promise<boolean>} true accepts the dialog.
 */
function askAboutDialog({ type, message }) {
  const policy = els.dialogPolicy.value;
  if (policy === 'accept') return true;
  if (policy === 'dismiss') return false;

  const quoted = message.trim() || '(내용이 없는 대화상자입니다)';
  log('warn', `페이지가 물었습니다 — ${type} "${message}". 패널 맨 위에서 확인 또는 취소를 누르세요.`);

  return new Promise((resolve) => {
    const deadline = Date.now() + DIALOG_ANSWER_MS;
    els.dialogAskText.textContent = quoted;
    els.dialogAsk.hidden = false;

    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      els.dialogAskHint.textContent =
        `${left}초 안에 답하지 않으면 취소로 처리합니다.`
        + (type === 'prompt' ? ' 확인을 누르면 빈 값으로 답합니다.' : '');
      if (left === 0) finish(false, '시간이 지나');
    };

    let done = false;
    const finish = (accept, why) => {
      // Guarded per question, not by the shared handle: the button, the
      // countdown and 중지 can all reach for the same dialog, and only the
      // first of them answers it.
      if (done) return;
      done = true;
      if (pendingDialog && pendingDialog.finish === finish) pendingDialog = null;
      clearInterval(timer);
      els.dialogAsk.hidden = true;
      els.dialogAccept.onclick = null;
      els.dialogDismiss.onclick = null;
      log('info', `${why} ${accept ? '확인' : '취소'}으로 답했습니다.`);
      resolve(accept);
    };

    els.dialogAccept.onclick = () => finish(true, '직접');
    els.dialogDismiss.onclick = () => finish(false, '직접');
    // Named before the first tick, because a zero-length deadline would
    // otherwise finish before there is anything to clear.
    pendingDialog = { finish };
    const timer = setInterval(tick, 250);
    tick();
  });
}

cdp.setDialogAsker(askAboutDialog);

/* ------------------------------------------------------------------ */
/* The step block                                                      */
/* ------------------------------------------------------------------ */

/**
 * A step prints two lines a person actually reads: what the model was thinking
 * and what it called. Both are labelled with the MODEL'S OWN tokens — it emits
 * `think` and `<tool_call>{"name":"click", …}`, so the log says `think` and
 * `tool_call  click`. Translating those labels to Korean would put a layer
 * between the reply and the log and make a mismatch between the two harder to
 * see. The sentence AFTER the label is ours, and stays Korean.
 *
 * The two labels are padded to one width because the log is monospace: the
 * detail columns then line up under the 단계 header. The indent that groups
 * them into a block is CSS (.log__row--think / --action), not spaces, so the
 * text still copies out clean.
 */
const LABEL_WIDTH = 'tool_call'.length;
const label = (name) => name.padEnd(LABEL_WIDTH);

/** The model's reasoning — context, so the quieter of the two rows. */
function logThink(text) {
  log('think', `${label('think')}  ${text}`);
}

/** What the model called, and what that turned into — the prominent row. */
function logCall(action, detail) {
  log('action', `${label('tool_call')}  ${action.action}${detail ? `  ${detail}` : ''}`);
}

/**
 * What a terminal call carries: the answer it finished with, or the reason it
 * gave up. `done` and `exit` carry neither.
 */
const terminalDetail = (action) => action.answer || action.reason || '';

function reportPoint(action, viewport, xKey = 'x', yKey = 'y') {
  if (!POINT_ACTIONS.has(action.action) || action[xKey] === undefined || action[yKey] === undefined) return null;
  const point = toViewportPx(action[xKey], action[yKey], viewport);
  return { modelX: action[xKey], modelY: action[yKey], x: point.x, y: point.y };
}

function recordTrajectoryStep({ stepNo, shot, action, reply, detail, result, pageUrl, pageTitle, tabId, point, endPoint }) {
  if (!state.trajectory) return;
  state.trajectory.steps.push({
    step: stepNo,
    tabId,
    pageUrl,
    pageTitle,
    viewport: { ...shot.viewport },
    imageBase64: shot.base64,
    imageFormat: shot.format || 'png',
    imagePixels: pngDimensions(shot.base64),
    action,
    think: action.think || '',
    reply: reply || '',
    detail,
    result,
    point,
    endPoint,
  });
}

// A browser extension cannot infer or write to its unpacked source directory.
// The user grants access to the local checkout through the directory picker.
let trajectoryDirectory = null;

async function chooseTrajectoryDirectory() {
  try {
    const root = await window.showDirectoryPicker({ id: 'trajectory-project', mode: 'readwrite' });
    const directory = await root.getDirectoryHandle('save', { create: true });
    trajectoryDirectory = directory;
    els.trajectoryFolder.textContent = `자동 저장: ${root.name}/save/`;
    log('info', `로컬 저장 폴더 선택 완료 — ${root.name}/save/`);
  } catch (err) {
    if (err.name !== 'AbortError') logError(err);
  }
}

async function saveCurrentTrajectory() {
  if (!state.trajectory) return;
  const report = renderTrajectoryHtml(state.trajectory, state.trajectory.logs);
  const filename = trajectoryFilename(state.trajectory.task, state.trajectory.startedAt);
  if (trajectoryDirectory) {
    try {
      // Preserve manual snapshots and runs started within the same second.
      const uniqueFilename = filename.replace(/\.html$/, `_${crypto.randomUUID()}.html`);
      const file = await trajectoryDirectory.getFileHandle(uniqueFilename, { create: true });
      const writer = await file.createWritable();
      try {
        await writer.write(report);
        await writer.close();
      } catch (err) {
        await writer.abort().catch(() => {});
        throw err;
      }
      log('info', `기록 HTML 저장 완료 — save/${uniqueFilename}`);
      return;
    } catch (err) {
      log('warn', `로컬 save 폴더 저장 실패: ${err.message}. 브라우저 다운로드로 저장합니다.`);
    }
  } else {
    log('warn', '로컬 프로젝트 폴더를 선택하지 않아 브라우저 다운로드로 저장합니다. 자동 저장 위치는 프로젝트 폴더 선택 버튼으로 지정하세요.');
  }
  const objectUrl = URL.createObjectURL(new Blob([report], { type: 'text/html;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  log('info', `기록 HTML 저장을 요청했습니다 — ${link.download}`);
}

function updateCaptureInfo() {
  const run = state.trajectory;
  if (!run) return;
  const size = run.lastViewport
    ? ` · 최근 화면 ${run.lastViewport.width}×${run.lastViewport.height} CSS px` : '';
  els.captureInfo.textContent = `캡처 ${run.captures}장 · 모델 입력 이미지 ${run.imagesSent}장${size}`;
}

function recordCapture(shot) {
  if (!state.trajectory || !shot) return;
  state.trajectory.captures += 1;
  state.trajectory.lastViewport = { ...shot.viewport };
  updateCaptureInfo();
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function readLoadWaitSeconds() {
  const raw = String(els.loadWaitSeconds.value).trim();
  const seconds = raw === '' ? 0 : Number(raw);
  return Number.isFinite(seconds) ? Math.min(60, Math.max(0, seconds)) : 0;
}

/**
 * How long to wait for one model reply, in seconds, as the operator set it.
 *
 * A setting rather than a constant because the right number is a property of
 * the server, not of this panel: a GPU server answers in seconds, a model on a
 * Mac runs at about 5 tok/s once a screenshot is in the turn and wants far
 * longer. Bounded at 600 only to keep a typo from hanging a run for
 * an hour; the ceiling that actually bites is the browser's, and it is named
 * in the hint next to the field and in the error below.
 */
function readModelTimeoutSeconds() {
  const raw = String(els.modelTimeoutSeconds.value).trim();
  const seconds = raw === '' ? MODEL_TIMEOUT_MS / 1000 : Number(raw);
  return Number.isFinite(seconds) ? Math.min(600, Math.max(5, seconds)) : MODEL_TIMEOUT_MS / 1000;
}

function readSettings() {
  return {
    baseUrl: els.baseUrl.value.trim(),
    apiKey: els.apiKey.value.trim(),
    modelName: els.modelName.value.trim(),
    // One format: the gui22 transcript, read as XML. Written out so a saved
    // bag and the trajectory report still say which one ran.
    ...formatSettings(),
    rolloutPresetVersion: 1,
    maxTokens: Math.max(1, Number(els.maxTokens.value) || 16384),
    // Left as typed, empty included: samplingFor() reads an empty field as
    // "use the format's own number", which is the one obvious way back.
    sampling: {
      temperature: els.temperature.value.trim(),
      top_p: els.topP.value.trim(),
      top_k: els.topK.value.trim(),
    },
    useMock: els.useMock.checked,
    sendTools: els.sendTools.checked,
    toolChoice: els.toolChoice.value,
    scenario: els.scenario.value,
    maxSteps: Math.max(1, Number(els.maxSteps.value) || 50),
    stepDelay: Math.max(0, Number(els.stepDelay.value) || 0),
    coordMode: els.coordMode.value,
    modelInputWidth: Number(els.modelInputWidth.value) || DEFAULT_COORD_CONFIG.modelInputWidth,
    modelInputHeight: Number(els.modelInputHeight.value) || DEFAULT_COORD_CONFIG.modelInputHeight,
    loadWaitSeconds: readLoadWaitSeconds(),
    modelTimeoutSeconds: readModelTimeoutSeconds(),
    task: els.task.value,
    startUrl: els.startUrl.value.trim(),
    // The developer section is collapsed for a demo and remembered for a
    // developer, who would otherwise reopen it on every panel load.
    devOpen: Boolean(els.devSettings.open),
    showRawReply: els.showRawReply.checked,
    autoSaveTrajectory: els.autoSaveTrajectory.checked,
    discordEnabled: els.discordEnabled.checked,
    discordRelay: els.discordRelay.value.trim(),
    richResults: els.richResults.checked,
    trainingResults: els.trainingResults.checked,
    uploadFiles: els.uploadFiles.value,
    showRawRequest: els.showRawRequest.checked,
    dialogPolicy: els.dialogPolicy.value,
  };
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: readSettings() });
  } catch (err) {
    logError(new Error(`설정을 저장하지 못했습니다: ${err.message}`));
  }
}

async function loadSettings() {
  let saved = {};
  try {
    const bag = await chrome.storage.local.get(SETTINGS_KEY);
    saved = bag[SETTINGS_KEY] || {};
  } catch (err) {
    logError(new Error(`저장된 설정을 읽지 못했습니다: ${err.message}`));
  }

  // `saved.endpoint` is the Phase-1 "Endpoint URL" field. It held a POST /act
  // URL, which no longer exists as a protocol, so carrying it over would only
  // prefill a base URL that cannot work. It is dropped, not migrated.
  if (saved.endpoint && !saved.baseUrl) {
    log('system', `이전 엔드포인트 설정 "${saved.endpoint}"은 사용하지 않습니다. 현재 확장 프로그램은 OpenAI /v1/chat/completions 형식을 사용합니다.`);
  }
  if (saved.baseUrl) els.baseUrl.value = saved.baseUrl;
  if (saved.apiKey) els.apiKey.value = saved.apiKey;
  if (saved.modelName) els.modelName.value = saved.modelName;
  // Whatever request/parse format an older panel saved is not read back:
  // there is one format now, gui22 + xml.
  // Old panels saved the former defaults (512 tokens, 20 steps). Move those
  // values to the recommended preset once, while retaining values the
  // operator explicitly changed.
  const migrateRollout = saved.rolloutPresetVersion !== 1 && Object.keys(saved).length > 0;
  if (saved.maxTokens) {
    els.maxTokens.value = migrateRollout && Number(saved.maxTokens) === 512
      ? '16384' : saved.maxTokens;
  }
  if (saved.sampling) {
    // !== undefined, not truthiness: '' and '0' are both meaningful here.
    if (saved.sampling.temperature !== undefined) els.temperature.value = saved.sampling.temperature;
    if (saved.sampling.top_p !== undefined) els.topP.value = saved.sampling.top_p;
    if (saved.sampling.top_k !== undefined) els.topK.value = saved.sampling.top_k;
  }
  if (saved.useMock !== undefined) els.useMock.checked = Boolean(saved.useMock);
  if (saved.sendTools !== undefined) els.sendTools.checked = Boolean(saved.sendTools);
  if (saved.toolChoice === 'auto' || saved.toolChoice === 'none') els.toolChoice.value = saved.toolChoice;
  if (['ask', 'dismiss', 'accept'].includes(saved.dialogPolicy)) els.dialogPolicy.value = saved.dialogPolicy;
  // A saved `systemPrompt` from an older panel is ignored: the trained prompt
  // is always sent verbatim.
  if (saved.scenario !== undefined) els.scenario.value = saved.scenario;
  if (saved.maxSteps) {
    // A <select> silently refuses a value that is not one of its options, and
    // the box would then read empty and fall back to 20 without saying so. A
    // panel saved before this was a list could hold 200, or 7; snap it to the
    // nearest step offered rather than losing the setting quietly.
    els.maxSteps.value = migrateRollout && Number(saved.maxSteps) === 20
      ? '50' : String(saved.maxSteps);
    if (!els.maxSteps.value) {
      const asked = Number(saved.maxSteps) || 50;
      els.maxSteps.value = String(Math.min(100, Math.max(20, Math.round(asked / 10) * 10)));
    }
  }
  if (saved.stepDelay !== undefined) els.stepDelay.value = saved.stepDelay;
  if (saved.modelInputWidth) els.modelInputWidth.value = saved.modelInputWidth;
  if (saved.modelInputHeight) els.modelInputHeight.value = saved.modelInputHeight;
  if (saved.loadWaitSeconds !== undefined) els.loadWaitSeconds.value = saved.loadWaitSeconds;
  if (saved.modelTimeoutSeconds !== undefined) els.modelTimeoutSeconds.value = saved.modelTimeoutSeconds;
  if (saved.task) els.task.value = saved.task;
  if (saved.startUrl !== undefined) els.startUrl.value = saved.startUrl;
  // Absent on a fresh profile, which is what keeps the section closed there.
  if (saved.devOpen !== undefined) els.devSettings.open = Boolean(saved.devOpen);
  // Default off: the raw dump repeats the think and tool_call lines. A panel
  // that was left with it on keeps it on — that is the debugging session.
  if (saved.showRawReply !== undefined) els.showRawReply.checked = Boolean(saved.showRawReply);
  // A stored value is the operator's own choice.
  if (saved.richResults !== undefined) els.richResults.checked = Boolean(saved.richResults);
  if (saved.trainingResults !== undefined) els.trainingResults.checked = Boolean(saved.trainingResults);
  if (saved.uploadFiles !== undefined) els.uploadFiles.value = saved.uploadFiles;
  if (saved.autoSaveTrajectory !== undefined) {
    els.autoSaveTrajectory.checked = Boolean(saved.autoSaveTrajectory);
  }
  if (saved.discordRelay) els.discordRelay.value = saved.discordRelay;
  // REMEMBERED, NOT DEFAULTED ON. The box used to be cleared on every open, so
  // that a panel could never start taking orders from a channel merely by
  // being open — a fair worry, and the wrong lever for it. A fresh profile
  // still opens with it off; what is restored is a choice this operator made
  // by hand, on this machine. Re-opening the panel between runs, or reloading
  // the extension, otherwise meant finding this checkbox again every time.
  //
  // The listener is reconnected in connectSavedDiscord, after the panel has
  // finished loading, because it has to talk to the relay to start.
  if (saved.discordEnabled !== undefined) els.discordEnabled.checked = Boolean(saved.discordEnabled);
  // The ENABLED flag is deliberately not restored. A saved panel that came
  // back listening would be a browser accepting remote commands because of a
  // box ticked days ago; this is switched on per session, on purpose.
  if (saved.showRawRequest !== undefined) els.showRawRequest.checked = Boolean(saved.showRawRequest);
  if (saved.coordMode && COORD_MODES.includes(saved.coordMode)) {
    els.coordMode.value = saved.coordMode;
  }

  applyCoordConfig();
  if (migrateRollout) await saveSettings();
}

/** Push the UI's coordinate settings into coords.js, the single source of truth. */
function applyCoordConfig() {
  const mode = els.coordMode.value;
  els.pixelFields.hidden = mode !== 'pixel';
  els.coordHelp.textContent = MODE_HELP[mode] || '';
  try {
    const cfg = setCoordConfig({
      mode,
      modelInputWidth: Number(els.modelInputWidth.value),
      modelInputHeight: Number(els.modelInputHeight.value),
    });
    return cfg;
  } catch (err) {
    logError(err);
    return getCoordConfig();
  }
}

/* ------------------------------------------------------------------ */
/* Tab targeting                                                       */
/* ------------------------------------------------------------------ */

/**
 * The side panel is scoped to one browser window, so "the active tab of this
 * window" is the tab the user is looking at next to the panel.
 */
async function resolveTargetTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) {
    throw new Error('이 창에 활성 탭이 없습니다.');
  }
  const url = tab.url || '';
  if (!/^(https?|file):/i.test(url)) {
    throw new Error(
      `"${url || '현재 탭'}"에서는 작업을 실행할 수 없습니다. 크롬은 다음 페이지에 디버거 연결을 허용하지 않습니다: ` +
      'chrome://, chrome-extension://, 웹 스토어, 새 탭 페이지. ' +
      '먼저 일반 http(s) 웹페이지를 연 다음 다시 실행하세요.'
    );
  }
  els.target.textContent = `대상 탭: ${tab.title || url}`;
  return tab;
}

async function ensureAttached() {
  const tab = await resolveTargetTab();
  if (state.tabId !== null && state.tabId !== tab.id) {
    await cdp.detach(state.tabId).catch(() => {});
  }
  state.tabId = tab.id;
  if (!cdp.isAttached(tab.id)) {
    await cdp.attach(tab.id);
    log('system', `탭 ${tab.id}에 디버거를 연결했습니다. 클릭은 신뢰된 CDP 입력 이벤트로 실행합니다.`);
  }
  setStatus('attached', 'attached');
  return tab.id;
}

/* ------------------------------------------------------------------ */
/* Following a click into a new tab                                    */
/* ------------------------------------------------------------------ */

/**
 * On a Korean portal a search result routinely opens in a NEW tab. Without
 * this the loop keeps driving the tab it started on, the screen it watches
 * never changes, and the run burns its whole step budget on a page the click
 * already left. `openerTabId` is the signal: a tab opened BY the tab we are
 * driving is the result of our own click. A new tab appearing anywhere else is
 * the user's, not ours.
 *
 * Except before the first action. Q-net's front page window.opens a notice
 * popup on load, and its opener IS the tab we drive, so it passed the opener
 * test and the run moved into the notice before the model had seen a single
 * screen. Nothing the model did can have opened a tab before it did anything,
 * so until then a new tab is the page's own and the run stays where it is.
 */

/** Listener pair for the active run, or null. One run, one registration. */
let tabWatch = null;
/** The handover in flight, or null. Only one at a time. */
let handover = null;

/** A new tab that is still at about:blank has not navigated yet. */
const NEW_TAB_SETTLE_MS = 300;
/** Past this, the tab is not going anywhere we can drive; keep the old one. */
const NEW_TAB_TIMEOUT_MS = 5000;

/**
 * The readiness probe for a tab the debugger is NOT attached to yet — Chrome's
 * own tab record is all we can read, and all we need: the question here is only
 * which URL the tab settles on, and the loop's real readiness wait runs again
 * on the next screenshot. Shaped like pageReadinessProbe's result so
 * waitForPageReady (the wait the loop already uses, abort semantics included)
 * does the waiting instead of a second hand-rolled poll.
 */
async function readNewTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || tab.pendingUrl || '';
  return {
    // about:blank is the placeholder a new tab holds until it navigates, so it
    // is "still loading" however complete Chrome calls it.
    readyState: url && url !== 'about:blank' ? 'complete' : 'loading',
    fontsReady: true,
    imagesReady: true,
    quietForMs: Infinity,
    url,
    title: tab.title || '',
    // Constant, so sameDocument() compares the URL alone: two polls agreeing on
    // it is what "the tab settled" means here.
    timeOrigin: 0,
  };
}

/**
 * Move the run to a tab our own click opened. The step that opened it has
 * already executed, so nothing is replayed: the next screenshot is simply of
 * the new tab.
 */
async function followNewTab(tab) {
  const newTabId = tab.id;
  const previousTabId = state.tabId;
  log('info', `새 탭이 열렸습니다(탭 ${newTabId}). 주소가 정해지면 이 탭으로 전환합니다.`);

  let settled;
  try {
    settled = await waitForPageReady(newTabId, readNewTab, {
      shouldAbort: () => state.abort,
      timeoutMs: NEW_TAB_TIMEOUT_MS,
      settleMs: NEW_TAB_SETTLE_MS,
    });
  } catch (err) {
    if (err.name === 'AbortError') return; // Stop was pressed mid-handover.
    log('warn', `새 탭 ${newTabId}의 상태를 확인하지 못했습니다(${err.message}). 기존 탭 ${previousTabId}에서 계속 실행합니다.`);
    return;
  }
  if (state.abort || !state.running || state.tabId !== previousTabId) return;

  const url = settled ? settled.url : '';
  if (!/^(https?|file):/i.test(url)) {
    log('warn', `새 탭 "${url || '(주소 없음)'}"에는 디버거를 연결할 수 없어 전환하지 않습니다. 기존 탭 ${previousTabId}에서 계속 실행합니다.`);
    return;
  }

  if (await switchTabTo(newTabId, url, settled.title)) state.openers.set(newTabId, previousTabId);
}

/** Tabs whose closing is already being handled, so the two events Chrome
 *  sends for one close (tabs.onRemoved, debugger onDetach) act once. */
const closingTabs = new Set();

/**
 * The tab the run was driving is gone.
 *
 * MEASURED BY THE REVIEW, AND EVERY KOREAN CHECKOUT DOES IT: Daum 우편번호,
 * 카카오·네이버 로그인, 본인인증 and card payment all open a popup that closes
 * ITSELF once it has done its job. The run followed the popup in, the popup
 * closed, and the run ended with "탭이 닫혀 실행을 중단합니다" — while the page
 * that opened it sat there ready, often with the address already filled in.
 *
 * So a popup the run followed hands the run back to the tab that opened it,
 * through the same handover a new tab uses (the loop waits on `handover`
 * before it looks at a screen). The model is told in the next result turn,
 * because the screenshot alone shows a different page with no reason why.
 * A tab with no recorded opener — the one the run started on, or one the
 * model switched to itself — still ends the run, as before.
 */
function drivenTabGone(tabId, message) {
  if (tabId !== state.tabId || closingTabs.has(tabId)) return;
  closingTabs.add(tabId);
  const stop = () => {
    log('error', message);
    // Nulled so the debugger's own detach event does not repeat the message.
    state.tabId = null;
    state.abortReason = message;
    state.abort = true;
  };
  handover = (async () => {
    // IS THE TAB ACTUALLY GONE? `target_closed` says the DEBUGGING TARGET
    // went away, which is not the same thing. Opening a PDF does exactly
    // that: Chrome's built-in viewer replaces the page's renderer with its
    // own, the debugger session dies, and the tab sits there showing the
    // paper. MEASURED — a run that searched for a paper, found it and
    // clicked "Full paper (PDF)" ended on "실행 중이던 탭이 닫혀" with the
    // PDF open on screen. Downloading a paper is the demo, so this is the
    // one place the check has to be made rather than assumed.
    if (await chrome.tabs.get(tabId).then(() => true, () => false)) {
      try {
        await cdp.attach(tabId);
        closingTabs.delete(tabId);
        log('system', `탭 ${tabId}의 디버거가 끊어져 다시 연결했습니다. PDF 뷰어처럼 페이지를 다른 것이 대신 그리면 일어납니다.`);
        return;
      } catch (err) {
        log('warn', `탭 ${tabId}에 다시 연결하지 못했습니다 — ${err.message}`);
      }
    }

    const opener = state.running ? state.openers.get(tabId) : undefined;
    if (opener === undefined) {
      stop();
      return;
    }
    const tab = await chrome.tabs.get(opener).catch(() => null);
    const url = tab ? tab.url || tab.pendingUrl || '' : '';
    if (!tab || !/^(https?|file):/i.test(url) || !(await switchTabTo(opener, url, tab.title))) {
      stop();
      return;
    }
    state.openers.delete(tabId);
    state.tabNote = `The tab you were on (a popup) closed itself; you are back on the tab that opened it: ${url}`;
    log('info', `팝업 탭 ${tabId}이(가) 스스로 닫혀, 이 팝업을 연 탭 ${opener}로 돌아왔습니다 — ${url}`);
  })()
    .catch((err) => { logError(err); stop(); })
    .finally(() => { handover = null; });
}

/**
 * Move the debugger, and the run with it, to another tab.
 *
 * This is the second half of followNewTab, pulled out because Ctrl+Tab,
 * Ctrl+T and Ctrl+W now need exactly the same handover and a second
 * implementation of it would be a second place for the attach/detach ordering
 * to go wrong. The FIRST half — waiting for a brand-new tab's URL to settle —
 * stays in followNewTab, because only a tab Chrome has just created needs it.
 *
 * @returns {Promise<boolean>} false when the tab refused the debugger; the run
 *   keeps the tab it had, which is why nothing is detached until the new tab
 *   has accepted.
 */
async function switchTabTo(newTabId, url, title) {
  const previousTabId = state.tabId;
  if (newTabId === previousTabId) return true;

  // Attach BEFORE detaching: the Web Store passes a scheme check and still
  // refuses the debugger, and a run that had already let go of its own tab
  // would have nothing left to drive.
  try {
    await cdp.attach(newTabId);
  } catch (err) {
    log('warn', `새 탭 "${url}"에 디버거를 연결하지 못했습니다(${err.message}). 기존 탭 ${previousTabId}에서 계속 실행합니다.`);
    return false;
  }

  if (previousTabId !== null && previousTabId !== undefined) {
    await cdp.detach(previousTabId).catch(() => {});
    overlayPath.delete(previousTabId);
    browserUiPath.delete(previousTabId);
  }
  state.tabId = newTabId;
  // The audience watches the browser, not the panel: the tab we drive has to be
  // the tab on screen, or the overlay and the screenshots describe a hidden one.
  await chrome.tabs.update(newTabId, { active: true }).catch(() => {});
  els.target.textContent = `대상 탭: ${title || url}`;
  log('info', `탭 ${newTabId}로 전환했습니다 — ${url}`);
  return true;
}

/**
 * Register the run's tab listeners. They exist only while a run does: one
 * surviving into the next run would hijack it with a stale state.tabId.
 */
function startTabWatch() {
  if (tabWatch) return;

  const onCreated = (tab) => {
    if (!state.running || !tab || tab.openerTabId !== state.tabId) return;
    if (!state.acted) {
      log('info', `페이지가 첫 화면에서 연 팝업(탭 ${tab.id})은 무시하고 기존 탭 ${state.tabId}에서 계속 실행합니다.`);
      keepDrivenTabInFront();
      return;
    }
    if (handover) {
      log('warn', `새 탭 ${tab.id}은(는) 무시합니다. 이미 다른 새 탭으로 전환하는 중입니다.`);
      return;
    }
    handover = followNewTab(tab)
      .catch(logError)
      .finally(() => { handover = null; });
  };

  const onRemoved = (tabId) => {
    // Say it here rather than letting the next CDP command fail with
    // "No tab with given id" — or, for a popup the run followed, go back to
    // the tab that opened it. See drivenTabGone.
    drivenTabGone(tabId, `실행 중이던 탭 ${tabId}이(가) 닫혀 실행을 중단합니다.`);
  };

  chrome.tabs.onCreated.addListener(onCreated);
  chrome.tabs.onRemoved.addListener(onRemoved);
  tabWatch = { onCreated, onRemoved };
}

/**
 * Put the driven tab back on screen after a popup we ignored took focus. A
 * popup opened as a tab hides ours; one opened as a window covers it. Either
 * way the audience would be watching the notice while we drive the page
 * underneath, and a backgrounded tab is one Chrome may stop painting.
 */
async function keepDrivenTabInFront() {
  const tabId = state.tabId;
  if (tabId === null || tabId === undefined) return;
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab && chrome.windows) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) {
    // The tab is ours to drive, not to own: if Chrome refuses, the next
    // screenshot still reads it through the debugger.
  }
}

function stopTabWatch() {
  if (!tabWatch) return;
  chrome.tabs.onCreated.removeListener(tabWatch.onCreated);
  chrome.tabs.onRemoved.removeListener(tabWatch.onRemoved);
  tabWatch = null;
}

/* ------------------------------------------------------------------ */
/* Overlay driving                                                     */
/* ------------------------------------------------------------------ */

let overlaySource = null;
let overlayCss = null;
/** tabId -> 'message' | 'cdp'; remembers which injection path worked. */
const overlayPath = new Map();

async function fetchExtensionText(path) {
  const res = await fetch(chrome.runtime.getURL(path));
  if (!res.ok) throw new Error(`${path} 파일을 읽지 못했습니다(${res.status}).`);
  return res.text();
}

async function loadOverlaySource() {
  if (overlaySource === null || overlayCss === null) {
    [overlaySource, overlayCss] = await Promise.all([
      fetchExtensionText('content/overlay.js'),
      fetchExtensionText('content/overlay.css'),
    ]);
  }
}

function overlayCallExpression(msg) {
  switch (msg.type) {
    case 'ping':
      return 'true';
    case 'flash':
      return `window.__guiAgentOverlay.flash(${Number(msg.x)}, ${Number(msg.y)}, ${JSON.stringify(msg.label || '')})`;
    case 'note':
      return `window.__guiAgentOverlay.note(${JSON.stringify(String(msg.text || ''))})`;
    case 'chooser':
      return `window.__guiAgentOverlay.chooser(${JSON.stringify(msg.files || [])}, ${Boolean(msg.multiple)})`;
    case 'chooserClose':
      return 'window.__guiAgentOverlay.chooserClose()';
    case 'clear':
      return 'window.__guiAgentOverlay.clear()';
    default:
      throw new Error(`알 수 없는 화면 표시 메시지 "${msg.type}"`);
  }
}

/**
 * Run an overlay command on the page.
 *
 * Preferred path: chrome.tabs.sendMessage to the declared content script,
 * which lives in the isolated world and therefore cannot collide with page
 * globals. Fallback path: evaluate overlay.js into the page's main world over
 * CDP. The fallback is required for tabs that were already open when the
 * extension was loaded — Chrome does not retroactively inject a newly declared
 * content script into them — and it also survives navigation, because the
 * expression re-installs the overlay whenever the global is missing.
 *
 * Overlay failures are reported but never abort a run: losing the debug ring
 * is not a reason to stop driving the page.
 */
async function overlayExec(tabId, msg) {
  if (overlayPath.get(tabId) !== 'cdp') {
    try {
      const reply = await chrome.tabs.sendMessage(tabId, { channel: 'gui-agent-overlay', ...msg });
      if (reply && reply.ok) {
        overlayPath.set(tabId, 'message');
        return true;
      }
    } catch (_) {
      // No content script in this tab (pre-existing tab, or a navigation that
      // has not finished). Fall through to the CDP path.
    }
  }

  await loadOverlaySource();
  const expression =
    '(function(){' +
    'if (!window.__guiAgentOverlay) {' +
    overlaySource + ';' +
    `window.__guiAgentOverlay.installStyles(${JSON.stringify(overlayCss)});` +
    '}' +
    `return ${overlayCallExpression(msg)};` +
    '})()';

  const ok = await cdp.evaluate(tabId, expression);
  overlayPath.set(tabId, 'cdp');
  return Boolean(ok);
}

async function overlaySafe(tabId, msg) {
  try {
    await overlayExec(tabId, msg);
  } catch (err) {
    log('system', `화면 표시를 사용할 수 없습니다(${err.message}). 시각적 표시 없이 계속 실행합니다.`);
  }
}

/* ------------------------------------------------------------------ */
/* The in-page browser widgets                                         */
/* ------------------------------------------------------------------ */

let browserUiSource = null;
let browserUiCss = null;
/** tabId -> true once the widget module is known to be installed there. */
const browserUiPath = new Map();

/**
 * Call one method on the page's find bar / address bar / zoom module.
 *
 * ONE PATH ONLY, unlike overlayExec: see the header of content/browserUi.js.
 * A declared content script would live in the isolated world and hold a SECOND
 * copy of the find bar's state, so the counter drawn on screen and the counter
 * reported to the model could disagree. The debugger is attached to the tab we
 * drive by definition, so Runtime.evaluate is always available.
 *
 * The expression re-installs the module whenever the global is missing, which
 * is what makes this survive a navigation without the caller tracking one.
 */
async function browserUiExec(tabId, method, args = []) {
  if (browserUiSource === null || browserUiCss === null) {
    [browserUiSource, browserUiCss] = await Promise.all([
      fetchExtensionText('content/browserUi.js'),
      fetchExtensionText('content/browserUi.css'),
    ]);
  }
  const expression =
    '(function(){' +
    'if (!window.__guiAgentBrowserUi) {' +
    browserUiSource + ';' +
    `window.__guiAgentBrowserUi.installStyles(${JSON.stringify(browserUiCss)});` +
    '}' +
    `return window.__guiAgentBrowserUi[${JSON.stringify(method)}].apply(null, ${JSON.stringify(args)});` +
    '})()';
  const value = await cdp.evaluate(tabId, expression);
  browserUiPath.set(tabId, true);
  return value;
}

/**
 * The hotkey routing table, wired to this panel's browser.
 *
 * `switchTab` is the panel's own handover rather than a second copy inside the
 * routes module, because moving the debugger is the run loop's business and it
 * was already written here.
 */
const browser = createBrowserRoutes({
  cdp,
  chrome,
  ui: (tabId, method, ...args) => browserUiExec(tabId, method, args),
  log: (message) => log('system', message),
  switchTab: switchTabTo,
});

/* ------------------------------------------------------------------ */
/* Action execution                                                    */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A delay that notices the Stop button instead of blocking on it. */
async function abortableSleep(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (state.abort) return;
    await sleep(Math.min(50, deadline - Date.now()));
  }
}

/** Time the ring is on screen before the click lands, so you can see it. */
const RING_LEAD_MS = 120;

/**
 * Actions whose correctness depends on what is on screen RIGHT NOW. A click or
 * an anchored scroll names a point in the viewport, so if the view moved since
 * the screenshot, that point now addresses different content. type and key are
 * absent on purpose: they go to the focused element, which scrolling does not
 * change.
 */
const POINT_ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'hover', 'focus', 'clear', 'drag', 'scroll',
]);

/**
 * Whether this step's correctness still depends on the screenshot it was
 * judged from.
 *
 * A `clear` with no point is the exception the set alone cannot express: it
 * addresses the focused element, and scrolling the page does not change which
 * element that is. Throwing the step away over a scroll would cost a step and
 * fix nothing.
 */
const dependsOnScreen = (action) =>
  POINT_ACTIONS.has(action.action) && !(action.action === 'clear' && action.x === undefined);

/**
 * Actions that put the keyboard somewhere in the page.
 *
 * After any of these, our find or address bar no longer holds the keyboard
 * even though it is still drawn — and the panel has to say so itself, because
 * the page-side mousedown listener only sees the TOP document and these clicks
 * routinely land in an iframe (a login box, a search form, most embedded
 * checkouts). `hover` is absent: moving the pointer focuses nothing.
 */
const POINTER_ACTIONS = new Set(['click', 'double_click', 'right_click', 'focus', 'drag']);

/** Actions whose result line names the element at their point. */
const TARGET_ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'hover', 'focus', 'clear', 'drag',
]);

/** The training executor's line for Ctrl+F, word for word. */
const FIND_BAR_OPENED_LINE =
  'Succeed: find bar opened (type text to search the page, Enter for next match, Escape to close).';

/** Actions whose training-format line names the element at their point. */
const FEEDBACK_TARGET_ACTIONS = new Set(['click', 'double_click', 'right_click', 'hover', 'focus']);

/**
 * The facts a step's training-format result line is built from.
 *
 * WHY THE LINE ITSELF IS NOT BUILT HERE. "Page navigated to …" and "New tab
 * opened (tab N)." are about what the click led to, which is only known once
 * the next observation exists — so this records what the step knows (the
 * element, the model's own coordinates and text, whether the scroll moved),
 * and modelProfile.trainingResult writes the line when the transcript is
 * built, next to the observation it describes.
 *
 * `failed` — thrown, or refused before dispatch — is the short
 * "Succeed: `tool` executed." the training data uses for every failure. The
 * panel's own Failed sentences stay in the Korean step log and in the other
 * two modes; in 학습 데이터 형식 mode the model reads only what it was
 * trained on.
 */
function feedbackFor(action, { el, facts, failed }) {
  if (failed) return { failed: true };
  if (facts.raw) return { raw: facts.raw };
  switch (action.action) {
    case 'click':
    case 'double_click':
    case 'right_click':
      return { kind: 'pointer', el, x: action.x, y: action.y };
    case 'hover':
    case 'focus':
      return { kind: 'at', el, x: action.x, y: action.y };
    case 'type':
      return { kind: 'type', text: action.text };
    case 'scroll':
      return { kind: 'scroll', dx: action.deltaX || 0, dy: action.deltaY || 0,
        moved: typeof facts.scrollMoved === 'boolean' ? facts.scrollMoved : null };
    case 'hotkey':
      return { kind: 'hotkey', keys: action.keys };
    case 'key':
      return { kind: 'hotkey', keys: [action.key] };
    case 'goto':
      return { kind: 'goto', ok: facts.ok === true, url: facts.url };
    case 'switch_tab':
      return { kind: 'switch_tab', ok: facts.ok === true, index: action.index };
    case 'new_tab':
      return { kind: 'new_tab', ok: facts.ok === true };
    case 'wait':
      return { kind: 'wait', seconds: action.seconds };
    default:
      // clear, drag, go_back, go_forward, close_tab: the executor only ever
      // wrote the short line for these.
      return { kind: 'plain' };
  }
}

/** Actions that can raise a notice the camera will miss. */
const NOTICE_ACTIONS = new Set(['click', 'double_click', 'hotkey', 'key']);

/**
 * The actions that can open a file chooser, and how long the step waits for
 * one before giving up.
 *
 * Page.fileChooserOpened lands a beat after the action's own command
 * resolves, so a step that reads the list immediately finds it empty and the
 * sentence goes to the NEXT step. The wait ends the moment the event arrives,
 * so only a step that opens nothing pays the full 250ms — and `scroll`,
 * `wait`, `goto` and the rest are not asked to pay it at all.
 */
const CHOOSER_ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'hotkey', 'key', 'type', 'drag',
]);
const CHOOSER_WAIT_MS = 250;

/**
 * What a click put on the page that will not survive to the screenshot.
 *
 * MEASURED ON 쿠팡. 장바구니 담기 raises "상품이 장바구니에 담겼습니다 /
 * 장바구니 바로가기" and withdraws it on its own. The loop waits for the page
 * to be quiet for 800ms before photographing, so the model is shown the same
 * screen before and after, concludes the click did nothing, and presses
 * 장바구니 담기 again — the loop this exists to end.
 *
 * TELLING IT BEATS PHOTOGRAPHING IT. Capturing sooner would race the toast and
 * lose on whichever site hides it fastest; a sentence does not care how long
 * the notice lived. It also leaves the model free to reach the cart its own
 * way rather than chasing a button that is already gone.
 *
 * Two lines at most. The diff of a shopping page is never empty — prices tick,
 * carousels rotate — and the point is to name the notice, not to narrate the
 * page.
 *
 * AND NOTHING AT ALL WHEN THE PAGE TURNED OVER. Measured on 네이버: clicking
 * 검색 replaced the page with results, and the first two lines of a wholly new
 * document were reported as something that had briefly appeared —
 *
 *   잠깐 나타난 안내: "축구", "self-distilled reasoner: on-policy self-…"
 *
 * — which is false twice. Those lines did not flash; they are the page now,
 * and the next screenshot shows them. A toast is a couple of lines added to a
 * page that is otherwise the same one. A navigation, a search, a tab of
 * results: everything is new, and there is no notice to name.
 */
const NOTICE_MAX_NEW_LINES = 8;

function noticeFrom(before, after) {
  if (!before || !after) return '';
  const was = new Set(before);
  const fresh = after.filter((line) => !was.has(line));
  if (!fresh.length || fresh.length > NOTICE_MAX_NEW_LINES) return '';
  return fresh.slice(0, 2).map((line) => JSON.stringify(line)).join(', ');
}

/** How far two aims at one control drift apart. Measured: 1-3px. */
const SAME_PLACE_PX = 10;

/**
 * The same click, at the same place, on something that is no longer there.
 *
 * MEASURED ON 쿠팡. Adding an item raises a "장바구니 바로가기" toast that
 * disappears on its own after a moment. The model sees it in the screenshot,
 * aims at it, and by the time the click lands the toast is gone — so the click
 * reaches the product behind it, nothing the model expected happens, and it
 * aims at the same spot again. And again.
 *
 * WHY THIS TEST AND NOT A REPEAT COUNT. Clicking the same point three times is
 * ordinary: a quantity stepper, a carousel arrow, a "더보기" that appends rows.
 * Refusing on repetition alone would break all of those. What separates them is
 * that their element STAYS — the stepper reports the same `<button>` every
 * time, while a ghost reports something else the instant it vanishes. The
 * element under the point is already read before every pointer action, so the
 * comparison costs nothing.
 *
 * Records as well as decides, so the caller cannot forget to.
 *
 * @returns {{result: string, detail: string}|null} null means "go ahead".
 */
function repeatedGhost(action, point, target) {
  if (!point || !TARGET_ACTIONS.has(action.action)) {
    // An action in between breaks the chain: this is about an IMMEDIATE
    // repeat, not about ever having clicked there.
    state.lastPointer = null;
    return null;
  }
  const last = state.lastPointer;
  state.lastPointer = { action: action.action, x: point.x, y: point.y, target };

  // NOT EXACT EQUALITY. A model aiming at one button twice does not emit the
  // same number twice: a measured run on CJ온스타일 clicked the same field at
  // (267,564), (266,563), (269,564) and (268,564). Requiring equality meant
  // "the same place" was never true and this check never fired once.
  //
  // The window is smaller than any real control, so two neighbouring buttons
  // cannot be confused for one; what it absorbs is the jitter above.
  const samePlace = last && last.action === action.action
    && Math.abs(last.x - point.x) <= SAME_PLACE_PX
    && Math.abs(last.y - point.y) <= SAME_PLACE_PX;
  // No reading to compare against — a cross-origin frame, a torn-down context
  // — so nothing is claimed either way.
  if (!samePlace || !last.target || target === last.target) return null;

  return {
    result: `Failed: ${action.action} was not performed. (${point.x}, ${point.y}) held `
      + `${last.target} when you aimed there a moment ago, and now holds `
      + `${target || 'nothing'} — what you were aiming at is gone. `
      + 'Look at the current screenshot and pick a target on it.',
    detail: `(${point.x}, ${point.y}) — 가리킨 요소가 사라져 실행하지 않았습니다`,
  };
}

/** How many times one click may raise the same dialog before it is refused. */
const SAME_DIALOG_LIMIT = 2;

/**
 * The same click, at the same place, answered by the same dialog again.
 *
 * MEASURED ON 에펨코리아. 등록 on a board post raises alert "탭을 선택하시길
 * 바랍니다." — the site refusing to submit until a 말머리 is chosen. The alert
 * is answered for the model and reported in words, and the model read that
 * sentence nine times and pressed 등록 nine times, because the screen it is
 * shown is identical every time and the sentence alone did not outweigh it.
 *
 * WHY THIS MAY COUNT REPEATS WHEN THE GHOST CHECK MAY NOT. repeatedGhost
 * refuses to count, and is right to: a quantity stepper, a carousel arrow and
 * a "더보기" are all the same click at the same place on the same element, and
 * all of them are meant. None of them answers with an identical dialog. A page
 * that raises the same alert for the same click is not working — it is saying
 * no, in the same words, and it will say it again.
 *
 * SO THE CLICK IS NOT DISPATCHED. Dispatching it buys nothing: the dialog is
 * answered, the page does not move, and a step is gone. Refusing it hands the
 * model back the one sentence that can break the loop — the page's own text,
 * named as a demand rather than as an event.
 *
 * Read BEFORE the action, from what the last one recorded.
 *
 * @returns {{result: string, detail: string}|null} null means "go ahead".
 */
function repeatedDialog(action, point) {
  if (!point || !TARGET_ACTIONS.has(action.action)) {
    state.lastDialog = null;
    return null;
  }
  const last = state.lastDialog;
  const samePlace = last && last.action === action.action
    && Math.abs(last.x - point.x) <= SAME_PLACE_PX
    && Math.abs(last.y - point.y) <= SAME_PLACE_PX;
  if (!samePlace) {
    // An action elsewhere breaks the chain, exactly as it does for the ghost
    // check: this is about an immediate repeat, not about history.
    state.lastDialog = null;
    return null;
  }
  if (last.count < SAME_DIALOG_LIMIT) return null;

  return {
    result: `Failed: ${action.action} was not performed. The last ${last.count} times you `
      + `${action.action}ed (${point.x}, ${point.y}) the page answered with the same dialog, `
      + `every time: ${JSON.stringify(last.message)}. That is the page refusing, not a `
      + 'failure to reach the control, and doing it again raises the same dialog again. '
      + 'The dialog text says what the page wants first — do that, then come back here.',
    detail: `(${point.x}, ${point.y}) — 같은 대화상자가 ${last.count}번 반복돼 실행하지 않았습니다`,
  };
}

/**
 * What the action that just ran raised, for the next step's repeatedDialog.
 *
 * Only called when the action was actually dispatched. A refused repeat must
 * leave the count where it is, or the panel alternates between refusing and
 * allowing the very click it has already decided is pointless.
 */
function rememberDialog(action, point, dialogs) {
  if (!point || !TARGET_ACTIONS.has(action.action) || !dialogs.length) {
    state.lastDialog = null;
    return;
  }
  const message = dialogs.map((d) => d.message).join(' | ');
  const last = state.lastDialog;
  const again = last && last.action === action.action && last.message === message
    && Math.abs(last.x - point.x) <= SAME_PLACE_PX
    && Math.abs(last.y - point.y) <= SAME_PLACE_PX;
  state.lastDialog = {
    action: action.action, x: point.x, y: point.y, message,
    count: again ? last.count + 1 : 1,
  };
}

/**
 * One line listing a dropdown's options, for the result turn.
 *
 * Deliberately verbose about the ONE thing the model cannot discover for
 * itself: the list exists and is not in the picture. Without that sentence it
 * reads an unchanged screenshot and clicks again — seventeen times, on
 * kleague.com, until the step budget ran out.
 */
function describeSelect(info) {
  const options = (info.options || []).filter((o) => !o.disabled);
  const current = (info.options || []).find((o) => o.selected);
  const names = options.map((o) => JSON.stringify(o.label)).join(', ');
  return `Succeed: this is a dropdown, currently ${JSON.stringify(current ? current.label : '')}. ` +
    `Its ${options.length} options are: ${names}. ` +
    'The open list is drawn by the operating system and cannot appear in a screenshot, ' +
    'so clicking it again will not show one. It now has focus: use `type` with the ' +
    'option text to choose one.';
}

/**
 * The DEFAULT wait for one model reply; the operator overrides it in 모델 응답
 * 대기 시간(초). It still has to stay under the browser's own give-up, which
 * took about 50 seconds and then said only "Failed to fetch" — ours names the
 * cause, so by default it has to fire first. A pinned test holds that line.
 *
 * 30s was this number until the 9B model on a Mac made it wrong: measured
 * against it, a text-only turn runs at 18.7 tok/s but an image turn at 5.1,
 * so 30s bought about 150 tokens and a turn that reasons before it calls a
 * tool wants more. 45s is the most that fits under the browser's ceiling.
 *
 * Above that ceiling the honest fix is `stream: true`, not a bigger number:
 * bytes moving on the wire are what stop an idle connection being reaped. The
 * setting still permits it, and the catch below names what will happen.
 */
const MODEL_TIMEOUT_MS = 45000;
const TIMEOUT_REASON = 'gui-agent-model-timeout';

/**
 * ONE BAD ANSWER FROM THE SERVER IS NOT THE RUN FAILING. A single 502 from the
 * proxy, a 503 while vLLM restarts, a request that timed out
 * once: each used to end the run on the spot, with every step before it
 * thrown away. The same request is sent again after a pause; only errors that
 * say the request itself is wrong (400, 401, 404, an unreadable body) are
 * final at once. Stop still wins during the pause.
 */
const MODEL_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MODEL_RETRY_DELAYS_MS = [2000, 5000];

/** An error worth sending the same request again for. */
function retryable(message) {
  const err = new Error(message);
  err.retryable = true;
  return err;
}

/**
 * Stop pressed while the model was thinking. An AbortError, so the run ends as
 * "stopped" — it used to be a plain Error, recorded (and reported to Discord)
 * as "오류로 중단되었습니다".
 */
function stoppedWaitingForModel() {
  const err = new Error('중지 버튼으로 모델 요청을 취소했습니다.');
  err.name = 'AbortError';
  err.duringModelCall = true;
  return err;
}

async function callModelWithRetry(settings, body) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callOpenAiModel(settings, body);
    } catch (err) {
      if (state.abort) throw err.name === 'AbortError' ? err : stoppedWaitingForModel();
      if (!err.retryable || attempt >= MODEL_RETRY_DELAYS_MS.length) throw err;
      const wait = MODEL_RETRY_DELAYS_MS[attempt];
      log('warn', `모델 요청이 실패해 ${wait / 1000}초 뒤 다시 보냅니다 ` +
        `(${attempt + 1}/${MODEL_RETRY_DELAYS_MS.length}) — ${err.message}`);
      await abortableSleep(wait);
      if (state.abort) throw stoppedWaitingForModel();
    }
  }
}

/**
 * The start URL hiding in the task text.
 *
 * Benchmark tasks arrive as one pasted line with the site on the end:
 *
 *   굿웨어몰에서 '남성 반팔 티셔츠'를 검색해주세요 … https://www.goodwearmall.com/main
 *
 * Left to itself the model has to infer the site from the prose and spends its
 * first step on a goto it often gets wrong — it typed naver.com for a 다방 task.
 * Driving there ourselves is deterministic and costs no step.
 *
 * The LAST url wins: in this format the site is appended after the instructions,
 * so one mentioned mid-sentence is context, not the destination. Trailing
 * punctuation is trimmed, and only http(s) counts since that is all
 * cdp.navigate accepts.
 *
 * The instruction is NOT rewritten. <user_request> is what the model was trained
 * to read, and removing the url from it would hide a detail the task may refer
 * to later.
 */
function startUrlIn(instruction) {
  const text = String(instruction);
  const found = text.match(/https?:\/\/[^\s<>"'。、，]+/g);
  if (found) {
    try {
      const parsed = new URL(trimKoreanTail(found[found.length - 1]).replace(/[.,;:)\]}]+$/, ''));
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return { url: parsed.href, extra: found.length - 1 };
      }
    } catch (_) { /* fall through to the bare pass */ }
    return null;
  }

  // NO SCHEME WRITTEN OUT. "쿠팡에서 … coupang.com" is how a person types it,
  // and the run would sit on whatever page was open while the model guessed
  // the site from the prose — the thing this function exists to stop.
  //
  // resolveAddress is the rule the address bar already answers this question
  // with, so it is reused rather than restated: it is what knows that
  // "1.5" is not a host, that localhost keeps http, and that a bare word is a
  // search. A token with no dot and no port cannot be a host, which is what
  // keeps ordinary Korean prose out of it.
  //
  // It is a guess, so it is a NARROW one. Any dotted word used to qualify:
  // "Node.js 최신 버전" went to https://node.js/ and "README.md 요약" to
  // https://readme.md/ before step 1, throwing away the page the user had
  // prepared. So a bare token counts only when it starts with www., names a
  // port or localhost, or ends in a top-level domain people actually type for
  // websites — never one that is also a file extension (.js, .md, .py, .sh,
  // .html). A url written out in full always wins above.
  const WEB_TLDS = new Set(['com', 'net', 'org', 'kr', 'io', 'ai', 'co', 'me', 'app', 'dev', 'so', 'gg',
    'tv', 'ly', 'to', 'fm', 'xyz', 'site', 'shop', 'store', 'online', 'tech', 'page', 'info', 'biz',
    'edu', 'gov', 'mil', 'int', 'jp', 'cn', 'uk', 'de', 'fr', 'us', 'ca', 'au', 'in', 'tw', 'hk', 'sg',
    'vn', 'eu', 'it', 'es', 'nl', 'ru', 'br', 'ch', 'se', 'no', 'fi', 'dk', 'kakao', 'naver', 'samsung']);
  const looksLikeSite = (token) => {
    if (/^www\./i.test(token) || /:\d/.test(token) || /^localhost([:/?#]|$)/i.test(token)) return true;
    const host = token.split(/[/?#]/)[0];
    const tld = host.slice(host.lastIndexOf('.') + 1).toLowerCase();
    return WEB_TLDS.has(tld);
  };
  const bare = text.split(/\s+/)
    .map((token) => trimKoreanTail(token).replace(/^[([{'"]+/, '').replace(/[.,;:)\]}'"]+$/, ''))
    .filter((token) => (token.includes('.') || /:\d/.test(token)) && looksLikeSite(token))
    .map((token) => resolveAddress(token))
    .filter((answer) => answer.url);
  if (!bare.length) return null;
  return { url: bare[bare.length - 1].url, extra: bare.length - 1, guessed: true };
}

/**
 * Korean glues its particles straight onto the word before them, so a url in a
 * sentence reads "https://www.q-net.or.kr에서" with no space to stop at. Kept,
 * "에서" became part of the HOST — new URL() punycoded it into
 * www.q-net.or.xn--kr-q04jk9m, a domain that does not exist — or of the last
 * query value ("gSite=Q에서").
 *
 * The cut is at Hangul that runs straight on from ASCII. A Hangul path segment
 * or query value starts after "/", "=" or "&" (/wiki/정보처리기사, query=정보)
 * and is kept whole.
 */
function trimKoreanTail(url) {
  return url.replace(/(?<=[A-Za-z0-9.)\]}])[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF].*$/, '');
}

function explicitStartUrl(value) {
  const raw = String(value).trim();
  if (!raw) return null;
  // Same rule as the address bar: coupang.com is an address, "쿠팡" is not.
  const resolved = resolveAddress(raw);
  if (resolved.url) return resolved.url;
  throw new Error('시작 URL이 주소로 읽히지 않습니다. coupang.com 처럼 적거나 https:// 를 붙여 주세요.');
}

/**
 * The request body as a readable string: every field, with each screenshot
 * replaced by its size.
 *
 * A base64 PNG is hundreds of thousands of characters, which is why DevTools'
 * payload view is close to useless here and why this exists at all. Everything
 * else is printed in full, because the whole point is to be able to paste it
 * to the model team when a checkpoint changes shape.
 */
function describeRequest(body) {
  return JSON.stringify(body, (key, value) => {
    if (key === 'url' && typeof value === 'string' && value.startsWith('data:image/')) {
      const bytes = Math.round((value.length - value.indexOf(',') - 1) * 0.75);
      return `[이미지 ${Math.round(bytes / 1024)} KB]`;
    }
    return value;
  }, 2);
}

/** Unreadable replies in a row before the run gives up on the format. */
const MAX_PARSE_FAILURES = 3;

/** How often one step may be discarded for a moving view before we act anyway. */
const MAX_STALE_RETRIES = 3;

/**
 * Actions that threw, in a row, before the run gives up.
 *
 * Bounded for the same reason the parse retry is: a model that answers with
 * the same impossible action every time would otherwise burn the whole step
 * budget failing identically. One recoverable failure is ordinary; three in a
 * row means the model is not reading the result turns.
 */
const MAX_ACTION_FAILURES = 3;

/**
 * Compare the geometry a screenshot was taken with against the live geometry.
 * @returns {string|null} a readable description of the shift, or null if unchanged
 */
function describeViewportShift(before, after) {
  const parts = [];
  const dx = Math.round((after.pageX || 0) - (before.pageX || 0));
  const dy = Math.round((after.pageY || 0) - (before.pageY || 0));
  if (dx) parts.push(`가로로 ${dx > 0 ? '+' : ''}${dx}px 스크롤`);
  if (dy) parts.push(`세로로 ${dy > 0 ? '+' : ''}${dy}px 스크롤`);
  if (after.width !== before.width || after.height !== before.height) {
    parts.push(`화면 크기 변경: ${after.width}x${after.height}`);
  }
  return parts.length ? parts.join(', ') : null;
}

/**
 * Map a model-space point to CSS viewport pixels, or pass it through untouched.
 * `mapCoords: false` is the manual-action path: you typed real CSS pixels and
 * want exactly those, which is what makes the manual box a reliable ruler.
 *
 * `note` leads with where the click actually landed, because that is the
 * question being asked, and carries the model's own number after it as
 * provenance. An arrow between the two read as "clicked here, then there" — one
 * point in two coordinate systems is not two actions. A middot does not.
 * Reading them side by side is still how you catch a wrong coordinate mode.
 */
function resolvePoint(action, viewport, mapCoords) {
  if (mapCoords) {
    const p = toViewportPx(action.x, action.y, viewport);
    return { x: p.x, y: p.y, note: `(${p.x}, ${p.y})  ·  point_2d [${action.x}, ${action.y}]` };
  }
  const x = Math.round(Number(action.x));
  const y = Math.round(Number(action.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`좌표가 숫자가 아닙니다: x=${action.x}, y=${action.y}`);
  }
  return { x, y, note: `(${x}, ${y})` };
}

/** Record where the mouse now is. Called by every action that moves it. */
function notePointer(tabId, p) {
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) state.pointer = { tabId, x: p.x, y: p.y };
}

/**
 * Where a scroll with no coordinates should wheel: where the mouse is.
 *
 * WHY NOT THE MIDDLE OF THE SCREEN. A wheel scrolls whatever is under the
 * pointer, and the gui22 `scroll` names no point — it means "turn the wheel
 * of the mouse that is already somewhere", which is also what Playwright's
 * mouse.wheel does. Aiming every scroll at the centre meant that clicking into
 * a sidebar, a modal or a dropdown list and then scrolling moved the page
 * behind it instead, or reported "nothing under that point scrolls".
 *
 * The centre is still the answer when nothing has pointed yet in this run, when
 * the pointer was on another tab, or when the viewport shrank past it.
 */
function pointerFor(tabId, viewport) {
  const p = state.pointer;
  if (p && p.tabId === tabId && p.x >= 0 && p.y >= 0 && p.x < viewport.width && p.y < viewport.height) {
    return { x: p.x, y: p.y, note: `마우스 위치 (${p.x}, ${p.y})` };
  }
  return { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2), note: '화면 중앙' };
}

/**
 * How far a wheel moved the screen, from two readings of the scroller chain.
 *
 * Each reading lists every scroller the wheel can reach, innermost first (see
 * cdp.scrollStateProbe). Summing them is what makes a chained scroll — the
 * inner pane runs out, the page takes the rest — read as the one movement it
 * was. If the page re-rendered and the chain changed shape, only the innermost
 * scroller is compared, which is what this measured before chains existed.
 * `inner` says whether anything but the outermost (the page) moved.
 */
function scrollMovement(was, now) {
  const before = was.chain || [was];
  const after = now.chain || [now];
  const paired = before.length === after.length;
  const pairs = paired ? after.map((a, i) => [before[i], a]) : [[before[0], after[0]]];
  let y = 0;
  let x = 0;
  let inner = false;
  pairs.forEach(([b, a], i) => {
    const dy = a.top - b.top;
    const dx = a.left - b.left;
    y += dy;
    x += dx;
    if ((dy || dx) && (paired ? i < pairs.length - 1 : Boolean(now.inner))) inner = true;
  });
  return { y, x, inner };
}

/**
 * What a `type` into a rich editor actually added.
 *
 * WHY NOT COMPARE WITH THE TYPED TEXT, the way a field is checked. A field's
 * value is the field. A contenteditable's textContent is the whole editing
 * root — in Notion that is the entire page, header buttons ("아이콘 추가커버
 * 추가…") and every block included — so it never equals the typed text, and the
 * old check called every Notion `type` "the text that was already there was
 * not replaced" and told the model to Ctrl+A, which in Notion selects the page.
 *
 * So this diffs before against after and returns only what changed. Whitespace
 * is dropped first: textContent has no separator between blocks and an editor
 * may turn a typed "\n" into a <br> that reads as nothing.
 */
function squashSpace(text) {
  return String(text || '').replace(/\s+/g, '');
}

function editorDiff(before, after) {
  const was = squashSpace(before);
  const now = squashSpace(after);
  const limit = Math.min(was.length, now.length);
  let head = 0;
  while (head < limit && was[head] === now[head]) head += 1;
  let tail = 0;
  while (tail < limit - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail += 1;
  return { inserted: now.slice(head, now.length - tail), removed: was.slice(head, was.length - tail) };
}

/** Index in `text` just past its first `count` non-whitespace characters. */
function cutAfterVisible(text, count) {
  let seen = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (seen === count) return i;
    if (!/\s/.test(text[i])) seen += 1;
  }
  return text.length;
}

const clipText = (text, n = 40) => (text.length > n ? `${text.slice(0, n)}…` : text);

// How long a rich editor gets to re-render before a `type` is read back.
const EDITOR_SETTLE_MS = 120;

/**
 * Execute one canonical action against the tab.
 * All coordinates passed to cdp.* here are already CSS viewport pixels.
 *
 * `onResult` is how an action says something richer than the transcript's
 * fixed "Succeed: `click` executed." Almost nothing calls it: a click needs no
 * result because the next screenshot shows what it did. A zoom, a find, a tab
 * switch and a clear that did not clear do, because the next step reasons from
 * a fact the picture states only indirectly — or, for the clear, states
 * wrongly. An action that never calls it sends exactly what it sends today.
 *
 * `view` is the tab as this step observed it (url, title), which the routed
 * hotkeys need and the coordinate actions do not.
 *
 * @returns {Promise<string>} the DETAIL half of the tool_call line — logCall
 *   puts `tool_call` and the action's own name in front of it.
 */
async function executeAction(tabId, action, viewport, { mapCoords = true, onResult = () => {}, onFacts = () => {}, view = {} } = {}) {
  switch (action.action) {
    case 'click': {
      const p = resolvePoint(action, viewport, mapCoords);
      notePointer(tabId, p);
      // Draw first, then click: if the click navigates, you have still seen
      // where it was aimed.
      await overlaySafe(tabId, { type: 'flash', x: p.x, y: p.y, label: `${p.x}, ${p.y}` });
      await sleep(RING_LEAD_MS);
      // A <select> is answered, not clicked: clicking opens an OS popup that
      // no screenshot contains, and the model has no way to learn that.
      const dropdown = await cdp.readSelectAt(tabId, p.x, p.y);
      if (dropdown.isSelect && !dropdown.disabled) {
        onResult(describeSelect(dropdown));
        // The option list is drawn by the OS and never reaches a screenshot;
        // without it the model cannot work a <select> at all, so it stays as
        // an extra line in the training-format result too.
        onFacts({ extra: describeSelect(dropdown) });
        const current = (dropdown.options || []).find((o) => o.selected);
        // THE DEMO HAS TO READ TOO. The native list never appears on screen,
        // so a bare click ring leaves a person watching with nothing to
        // connect to the value that changes two steps later.
        await overlaySafe(tabId, {
          type: 'note',
          text: `드롭다운 — 현재 ${current ? current.label : ''}, 선택지 ` +
            (dropdown.options || []).filter((o) => !o.disabled).map((o) => o.label).join(' / '),
        });
        return `${p.note} — 드롭다운 (현재 ${JSON.stringify(current ? current.label : '')}, ` +
          `선택지 ${(dropdown.options || []).filter((o) => !o.disabled).length}개)`;
      }
      await cdp.click(tabId, p.x, p.y);
      return p.note;
    }

    case 'double_click': {
      const p = resolvePoint(action, viewport, mapCoords);
      notePointer(tabId, p);
      await overlaySafe(tabId, { type: 'flash', x: p.x, y: p.y, label: `x2 ${p.x}, ${p.y}` });
      await sleep(RING_LEAD_MS);
      await cdp.doubleClick(tabId, p.x, p.y);
      return p.note;
    }

    case 'right_click': {
      const p = resolvePoint(action, viewport, mapCoords);
      notePointer(tabId, p);
      await overlaySafe(tabId, { type: 'flash', x: p.x, y: p.y, label: `오른쪽 클릭 ${p.x}, ${p.y}` });
      await sleep(RING_LEAD_MS);
      await cdp.click(tabId, p.x, p.y, { button: 'right' });
      return p.note;
    }

    case 'hover': {
      const p = resolvePoint(action, viewport, mapCoords);
      notePointer(tabId, p);
      await overlaySafe(tabId, { type: 'flash', x: p.x, y: p.y, label: `마우스 올리기 ${p.x}, ${p.y}` });
      await cdp.moveMouse(tabId, p.x, p.y);
      return p.note;
    }

    case 'focus': {
      // There is no trusted "focus this point" input event: focus is something
      // the page does in response to input. A click is the honest
      // implementation — it is literally how a user focuses a field. The
      // difference from `click` is intent, not mechanism, and it is a real
      // difference: a click on a button also activates it.
      const p = resolvePoint(action, viewport, mapCoords);
      notePointer(tabId, p);
      await overlaySafe(tabId, { type: 'flash', x: p.x, y: p.y, label: `입력란 선택 ${p.x}, ${p.y}` });
      await sleep(RING_LEAD_MS);
      const beforeClick = await cdp.readSelectAt(tabId, p.x, p.y);
      if (!beforeClick.isSelect) await cdp.click(tabId, p.x, p.y);
      // The whole point of `focus` is that something ends up focused. Saying
      // "(클릭으로 입력란을 선택합니다)" described the attempt and checked
      // nothing, so a click on a margin read exactly like a click on a field.
      if (beforeClick.isSelect && !beforeClick.disabled) {
        const asDropdown = beforeClick;
        onResult(describeSelect(asDropdown));
        onFacts({ extra: describeSelect(asDropdown) });
        return `${p.note} — 드롭다운 포커스`;
      }
      const got = await cdp.readFocused(tabId);
      if (got.kind === 'none') {
        onResult('Failed: nothing took focus at that point; there is no input there.');
        return `${p.note} — 아무것도 포커스되지 않았습니다`;
      }
      if (got.kind === 'field' || got.kind === 'editable') {
        return `${p.note} — 입력란 포커스${got.value ? ` (${JSON.stringify(got.value)})` : ''}`;
      }
      return `${p.note} — 포커스됨(입력란 아님)`;
    }

    case 'clear': {
      // The gui22 schema's clear names no point and means "empty whatever has
      // focus". A clear that does carry a point is drawn and clicked first; the
      // point is used only when the model sent one — see src/cdp.js for why clicking anyway would
      // be wrong rather than merely pointless.
      const aimed = action.x !== undefined && action.y !== undefined;
      const p = aimed ? resolvePoint(action, viewport, mapCoords) : { note: '포커스된 입력란' };
      const how = aimed ? '클릭, 전체 선택, 삭제' : '전체 선택, 삭제';
      if (aimed) {
        notePointer(tabId, p);
        await overlaySafe(tabId, { type: 'flash', x: p.x, y: p.y, label: `내용 지우기 ${p.x}, ${p.y}` });
        await sleep(RING_LEAD_MS);
      }
      // The report, not a fixed sentence. This line used to say "(클릭, 전체
      // 선택, 삭제)" whether or not anything was deleted, and against a real
      // field whose select-all never reached the editing layer it told the
      // operator the field was empty while it still held a price.
      const cleared = await cdp.clear(tabId, p.x, p.y);
      // Focus on a button, a link, a checkbox: cdp.clear pressed nothing,
      // because select-all there selects the page and Delete can delete it.
      if (cleared.skipped && cleared.kind === 'other') {
        const what = cleared.tag ? `<${cleared.tag}>${cleared.type ? ` type=${cleared.type}` : ''}` : 'the focused element';
        log('error', `clear를 실행하지 않았습니다 — 포커스가 입력란이 아닌 ${what}에 있습니다.`);
        onResult(`Failed: the focused element is ${what}, not a text field, so nothing was cleared. ` +
          'Click or focus the input first.');
        return `${p.note} (입력란이 아닌 ${what}에 포커스 — 지우지 않음)`;
      }
      const was = cleared.before.length > 40 ? `${cleared.before.slice(0, 40)}…` : cleared.before;
      if (cleared.cleared === false) {
        log('error', `clear가 입력란을 비우지 못했습니다. 값이 "${was}" 그대로입니다. ` +
          '브라우저가 전체 선택을 실행하지 않았을 수 있습니다.');
        onResult(`Failed: clear did not empty the field; it still reads "${cleared.before}".`);
        return `${p.note} (비우지 못했습니다 — "${was}" 그대로)`;
      }
      // Nothing had focus. With no point there was nothing to focus it either,
      // so this is not "unverifiable" — it is the whole action failing, and the
      // model's own prompt tells it to focus the field first. Saying Succeed
      // here is how a run types into the field it meant to empty.
      if (cleared.kind === 'none') {
        log('error', 'clear를 실행할 때 포커스된 입력란이 없었습니다. 먼저 입력란을 클릭하거나 focus하세요.');
        onResult('Failed: clear found no focused input. Click or focus the target input first.');
        return `${p.note} (포커스된 입력란이 없습니다)`;
      }
      if (cleared.cleared === null) return `${p.note} (${how} — 입력란을 읽을 수 없어 확인하지 못함)`;
      return cleared.before
        ? `${p.note} (${how} — "${was}" 삭제 확인)`
        : `${p.note} (${how} — 이미 비어 있었습니다)`;
    }

    case 'drag': {
      const from = resolvePoint(action, viewport, mapCoords);
      // Both ends go through the same adapter; a drag with one end in model
      // space and the other in CSS px would be silently skewed.
      const to = resolvePoint({ x: action.x2, y: action.y2 }, viewport, mapCoords);
      // The mouse is released at the far end, so that is where it now rests.
      notePointer(tabId, to);
      await overlaySafe(tabId, { type: 'flash', x: from.x, y: from.y, label: `드래그 시작 ${from.x}, ${from.y}` });
      await sleep(RING_LEAD_MS);
      // Remember the control being grabbed BEFORE the drag, and read the same
      // object back after. Re-reading elementFromPoint at the start point would
      // ask a different element, because the handle moves out from under it.
      const grabbed = await cdp.readDragTarget(tabId, from.x, from.y);
      await cdp.drag(tabId, from.x, from.y, to.x, to.y);
      const landed = await cdp.readDragResult(tabId);
      await overlaySafe(tabId, { type: 'flash', x: to.x, y: to.y, label: `드래그 끝 ${to.x}, ${to.y}` });

      const path = `${from.note} → ${to.note}`;
      // ONLY SPEAK WHEN THERE IS EVIDENCE. A value that was present before and
      // is identical after is the one case we can honestly call a failure; an
      // element with no value at all (a card, a map, a canvas) tells us nothing
      // and must not be dressed up as either outcome.
      if (grabbed.found && grabbed.value !== null && landed.found) {
        if (landed.value === grabbed.value) {
          onResult(`Failed: the control did not move; it still reads ${JSON.stringify(grabbed.value)}. ` +
            'Check that the drag started exactly on its handle.');
          return `${path} — 값이 ${JSON.stringify(grabbed.value)}에서 변하지 않았습니다`;
        }
        onResult(`Succeed: the control moved from ${JSON.stringify(grabbed.value)} ` +
          `to ${JSON.stringify(landed.value)}.`);
        return `${path} — ${JSON.stringify(grabbed.value)} → ${JSON.stringify(landed.value)}`;
      }
      return path;
    }

    case 'type': {
      await overlaySafe(tabId, { type: 'note', text: `입력: ${action.text}` });
      // While the find bar or the address bar is open, typing is what the
      // model opened it to do. Letting the text reach the page instead would
      // send a search term into whatever happened to have focus.
      const widget = await browser.typeInto(tabId, action.text);
      if (widget) {
        onResult(widget.result);
        // In the find bar the training data writes `Succeed: type typed "주소".
        // Find results: 1/1.` — no backticks, the count after the text.
        if (/^Find results: /.test(widget.result)) {
          onFacts({ raw: `Succeed: type typed "${action.text}". ${widget.result}` });
        }
        return `${JSON.stringify(action.text)} → ${widget.result}`;
      }
      // ASK WHETHER THERE IS ANYWHERE TO TYPE, before typing. Input.insertText
      // goes to whatever has focus, and with nothing focused it goes nowhere
      // at all — while the step still reported Succeed and the model carried
      // on reasoning about a field it believed it had filled. The gui22
      // prompt tells it to focus the target first; the panel is the only thing
      // that can tell it whether that actually held.
      // A FOCUSED <select> IS NOT A TEXT FIELD, even though it answers
      // readFocused with kind 'field' — it has a .value. Input.insertText into
      // one does nothing at all, so the text is matched against the option
      // labels instead. This is the half that lets the model actually change a
      // dropdown using only the tools it already has: click it, then type the
      // option's text.
      const chosen = await cdp.chooseOption(tabId, action.text);
      if (chosen.ok) {
        // Not "입력": nothing was typed. A person watching sees the value flip
        // with no list ever opening, and this is the only caption that says why.
        await overlaySafe(tabId, {
          type: 'note',
          text: `드롭다운 선택: ${chosen.before} → ${chosen.after}`,
        });
        onResult(`Succeed: the dropdown changed from ${JSON.stringify(chosen.before)} ` +
          `to ${JSON.stringify(chosen.after)}.`);
        return `${JSON.stringify(action.text)} → 드롭다운 ${JSON.stringify(chosen.after)}`;
      }
      if (chosen.reason === 'no-match') {
        const names = (chosen.options || []).map((o) => JSON.stringify(o)).join(', ');
        onResult(`Failed: the dropdown has no option matching ${JSON.stringify(action.text)}. ` +
          `Its options are: ${names}.`);
        return `${JSON.stringify(action.text)} — 일치하는 선택지가 없습니다`;
      }

      const before = await cdp.readFocused(tabId);
      if (before.kind === 'none') {
        onResult('Failed: nothing has focus, so there was nowhere to type. ' +
          'Click or focus the target input first.');
        return `${JSON.stringify(action.text)} — 포커스된 입력란이 없어 입력하지 않았습니다`;
      }
      // A rich editor takes its line breaks as keystrokes — see cdp.type. A
      // <textarea> or <input> keeps the single insertText it always had.
      const editable = before.kind === 'editable';
      await cdp.type(tabId, action.text, { lineBreaks: editable ? 'shift-enter' : 'insert' });
      if (before.kind !== 'field' && !editable) {
        // Focus exists but is not editable — a button, a link, the body of a
        // canvas app. The keystrokes were delivered, so this is not a refusal;
        // the model simply must not assume a field now holds the text.
        return `${JSON.stringify(action.text)} — 입력란이 아닌 요소에 포커스가 있었습니다`;
      }
      if (editable) {
        // Read after the editor has had a moment to re-render: one that
        // rejects browser-made DOM puts its own back asynchronously, and a read
        // in the same tick would see text that is about to vanish.
        await sleep(EDITOR_SETTLE_MS);
        const now = await cdp.readFocused(tabId);
        const typed = action.text;
        if (now.kind !== 'editable') {
          onResult('Succeed: the text was sent to the editor, but focus left it afterwards, so what it ' +
            'now holds could not be read back. Check the screenshot.');
          return `${JSON.stringify(typed)} — 입력 후 포커스가 편집기를 벗어나 확인하지 못했습니다`;
        }
        const want = squashSpace(typed);
        const { inserted, removed } = editorDiff(before.value, now.value);
        if (!inserted && !removed) {
          onResult('Failed: the editor\'s text did not change; the text was not entered.');
          return `${JSON.stringify(typed)} — 편집기 내용이 변하지 않았습니다`;
        }
        if (inserted === want) {
          onResult(removed
            ? 'Succeed: the text was entered, replacing the text that was selected.'
            : 'Succeed: the text was entered into the editor.');
          return `${JSON.stringify(typed)} → 편집기에 입력됨`;
        }
        if (!removed && inserted && want.startsWith(inserted)) {
          // The Notion failure, said as what it is: the start landed and the
          // rest did not. Naming where it stopped is what lets the model type
          // only the missing part instead of everything again.
          const cut = cutAfterVisible(typed, inserted.length);
          const missing = typed.slice(cut).trim();
          onResult(`Failed: only part of the text was entered — it stops after ` +
            `${JSON.stringify(clipText(typed.slice(0, cut).trim().split(/\r?\n/).pop() || '', 60))}, ` +
            `and ${missing.length} characters starting with ${JSON.stringify(clipText(missing, 40))} are missing.`);
          return `${JSON.stringify(typed)} — 일부만 입력됨 (${typed.length}자 중 ${cut}자)`;
        }
        // Changed, but not into the typed text: the editor reformatted it
        // (a "- " that became a bullet, a URL that became a link card). Not a
        // reason to clear anything — the picture shows what it became.
        onResult(`Succeed: the editor changed, but what it added reads ${JSON.stringify(clipText(inserted, 80))} ` +
          'rather than the typed text — the editor may have reformatted it. Check the screenshot.');
        return `${JSON.stringify(typed)} → 편집기에 ${JSON.stringify(clipText(inserted, 80))} 추가됨`;
      }
      // COMPARE THE INTENDED TEXT WITH THE ACTUAL VALUE, which is what the
      // model team's environment does for `write` — not merely "did anything
      // change". MEASURED ON CJ온스타일: a price field held "1,720,000,065,000"
      // after a type of "200000", because the old text had not been replaced.
      // That IS a change, so it counted as a plain success and the model was
      // sent the fixed sentence; it then had to read the number off the
      // screenshot to notice, and said so in its thinking every time. Sixteen
      // steps went into one field.
      const after = await cdp.readFocused(tabId);
      const typed = action.text;
      const value = after.value;

      if (after.kind === before.kind && value === before.value) {
        onResult(`Failed: the focused input still reads ${JSON.stringify(value)}; ` +
          'the text was not entered.');
        return `${JSON.stringify(typed)} — 값이 변하지 않았습니다`;
      }
      if (value === typed) {
        onResult(`Succeed: the input now reads ${JSON.stringify(value)}.`);
        return `${JSON.stringify(typed)} → ${JSON.stringify(value)}`;
      }
      if (before.value) {
        // There was text before and the field is not just the typed text, so
        // whatever is there now is the old content with the new text somewhere
        // in it. Naming the remedy is the half that saves a step: the model
        // was already diagnosing this correctly and still had to guess what to
        // do about it.
        onResult(`Succeed: the input now reads ${JSON.stringify(value)}, not ${JSON.stringify(typed)} — ` +
          'the text that was already there was not replaced. Use `clear`, or press Control+a, ' +
          'immediately before typing.');
        return `${JSON.stringify(typed)} → ${JSON.stringify(value)} (기존 값이 지워지지 않음)`;
      }
      // Empty before, different after: the page reformatted or filtered the
      // input. Not a failure, and not something to explain away — the model
      // needs the string it can act on.
      onResult(`Succeed: the input now reads ${JSON.stringify(value)}.`);
      return `${JSON.stringify(typed)} → ${JSON.stringify(value)}`;
    }

    case 'key': {
      await overlaySafe(tabId, { type: 'note', text: `키 누르기: ${action.key}` });
      await cdp.key(tabId, action.key);
      return action.key;
    }

    case 'hotkey': {
      const combo = action.keys.join('+');
      await overlaySafe(tabId, { type: 'note', text: `단축키: ${combo}` });
      // Routed FIRST. Ctrl+F, Ctrl+L, Ctrl+T and the rest are requests for
      // browser behaviour, and dispatching them to the page does nothing at
      // all — no error, no find bar, and a model that carries on believing one
      // opened. Anything the table does not claim returns null and falls
      // through below, so ctrl+a, Enter and Tab are untouched.
      const routed = await browser.route(tabId, action.keys, view);
      if (routed) {
        onResult(routed.result, { keep: Boolean(routed.navigated) });
        // The find bar is the one browser widget the training executor also
        // had, and it wrote its own lines with no tool name. "find next
        // match (2/14)." and "find bar closed." already match; the opening
        // line is the executor's, word for word. Every other routed chord is,
        // in the data's terms, just a hotkey.
        if (/^Succeed: find bar opened\b/.test(routed.result)) onFacts({ raw: FIND_BAR_OPENED_LINE });
        else if (/^Succeed: (the )?find\b/.test(routed.result)) onFacts({ raw: routed.result });
        if (!routed.ok) log('warn', `단축키 ${routed.combo}는 실행하지 않았습니다 — ${routed.result}`);
        return `${combo} → ${routed.result}`;
      }
      await cdp.hotkey(tabId, action.keys);
      return combo;
    }

    case 'scroll': {
      // An unanchored scroll wheels where the mouse is — the last point a
      // pointer action aimed at — because the element under the cursor is the
      // one that scrolls. pointerFor falls back to the middle of the viewport.
      const hasPoint = action.x !== undefined && action.y !== undefined;
      const p = hasPoint ? resolvePoint(action, viewport, mapCoords) : pointerFor(tabId, viewport);
      if (hasPoint) notePointer(tabId, p);
      const deltaX = action.deltaX || 0;
      await overlaySafe(tabId, { type: 'note', text: `${action.deltaY > 0 ? '아래로' : '위로'} ${Math.abs(action.deltaY)}px 스크롤` });
      // READ THE POSITION BACK, the way `clear` reads the field back — but
      // read the SCROLLER THE WHEEL ACTUALLY REACHES, and read it after it has
      // stopped moving. Measuring the document's offset instead, in the same
      // tick as the dispatch, got both halves wrong at once: CJ온스타일's
      // product page scrolls an inner pane, and the wheel animates, so eight
      // consecutive scrolls that visibly changed the screenshot were reported
      // as "the page did not move". See cdp.readScrollAt.
      const was = await cdp.readScrollAt(tabId, p.x, p.y);
      await cdp.scroll(tabId, p.x, p.y, action.deltaY, deltaX);
      const now = await cdp.settleScrollAt(tabId, p.x, p.y);
      const asked = `scroll_dy ${action.deltaY}px${deltaX ? `, scroll_dx ${deltaX}px` : ''}`;
      if (!was || !now) return `${asked} / ${p.note}`;

      // Summed over every scroller the wheel can reach: a wheel that runs off
      // the end of an inner pane carries on into the page, and only the two
      // together are what the screen did. See cdp.scrollStateProbe.
      const { y: movedY, x: movedX, inner: movedInner } = scrollMovement(was, now);
      onFacts({ scrollMoved: movedY !== 0 || movedX !== 0 });
      if (movedY === 0 && movedX === 0) {
        // THREE DIFFERENT FACTS, and the old code reported the first one's
        // wording for all three. "It did not move" is what was measured;
        // "it is at the bottom" is a separate claim that needs maxTop, and
        // asserting it when the pane still had room sent the model bouncing
        // between `scroll 500` and `scroll -600` until the run ran out.
        const chain = now.chain || [now];
        const room = chain.some((c) => c.maxTop > 0 || c.maxLeft > 0);
        if (!room) {
          onResult('Failed: nothing under that point scrolls — the content there fits on screen. ' +
            'Aim the scroll at the part of the page you want to move, or use PageDown.');
          return `${asked} / ${p.note} — 스크롤 가능한 영역 아님`;
        }
        // An edge only when EVERY scroller that can move vertically is at it.
        const tall = chain.filter((c) => c.maxTop > 0);
        const atBottom = action.deltaY > 0 && tall.length > 0 && tall.every((c) => c.top >= c.maxTop - 1);
        const atTop = action.deltaY < 0 && tall.length > 0 && tall.every((c) => c.top <= 0);
        if (atBottom || atTop) {
          onResult(`Failed: it did not move; it is already at the ${atBottom ? 'bottom' : 'top'}. ` +
            `Scrolling ${atBottom ? 'down' : 'up'} further will not reveal anything new.`);
          return `${asked} / ${p.note} — 움직이지 않음(이미 ${atBottom ? '맨 아래' : '맨 위'})`;
        }
        // Room left, and still nothing moved: an overlay, a modal that locks
        // the body, or a pane that only takes keyboard scrolling. Say what was
        // measured and name a different lever, rather than inventing an edge.
        const open = tall.find((c) => (action.deltaY < 0 ? c.top > 0 : c.top < c.maxTop - 1)) || tall[0] || chain[0];
        onResult(`Failed: it did not move, and it is not at the end — ${open.top} of ${open.maxTop}px. ` +
          'Something under the pointer is absorbing the scroll. Aim at a different part of the page, ' +
          'or click the area first and press PageDown.');
        return `${asked} / ${p.note} — 움직이지 않음(여유 ${open.maxTop - open.top}px 남음)`;
      }
      const moved = `${movedY ? `세로 ${movedY}px` : ''}${movedY && movedX ? ', ' : ''}${movedX ? `가로 ${movedX}px` : ''}`;
      // A short scroll is the other half of the same signal: asked for 600,
      // got 120, so the next one will get nothing.
      if (action.deltaY && Math.abs(movedY) < Math.abs(action.deltaY) / 2) {
        onResult(`Succeed: it moved ${movedY}px of the ${action.deltaY}px requested; ` +
          `it is near the ${action.deltaY > 0 ? 'bottom' : 'top'} of what can be scrolled.`);
      }
      return `${asked} / ${p.note} — ${moved} 이동${movedInner ? ' (안쪽 영역)' : ''}`;
    }

    case 'wait': {
      // abortableSleep, not sleep: a wait(30) that ignored Stop would make the
      // Stop button a lie for half a minute.
      await overlaySafe(tabId, { type: 'note', text: `대기 ${action.seconds}초` });
      await abortableSleep(Math.round(action.seconds * 1000));
      return state.abort
        ? `${action.seconds}초, 중지 버튼으로 중단`
        : `${action.seconds}초`;
    }

    case 'goto': {
      // THE SAME RULE THE ADDRESS BAR USES. cdp.navigate wants an absolute
      // URL and throws on anything else, and this model types bare hosts —
      // startUrlIn exists because it answered a 다방 task with "naver.com".
      // Ctrl+L + type + Enter accepted exactly that string and this tool used
      // to end the run over it. One intent, one behaviour.
      const target = resolveAddress(action.url);
      if (target.refuse !== undefined) {
        const why = target.refuse
          ? `Failed: ${target.refuse} is not a page address; only http and https can be opened.`
          : 'Failed: goto was given an empty address.';
        onResult(why);
        onFacts({ ok: false });
        log('warn', `이동하지 않았습니다 — ${why}`);
        return why;
      }
      const href = target.url || googleSearch(target.search);
      await overlaySafe(tabId, { type: 'note', text: `페이지 이동 ${href}` });
      const landed = await cdp.navigate(tabId, href);
      // The training line names the address the model asked for; a search
      // the panel made of a non-address names where that search landed.
      onFacts({ ok: true, url: target.search ? landed : action.url });
      // `keep`: a navigation that succeeded says where it landed even with
      // the fixed-line toggle off, like a click names its element.
      if (target.search) {
        onResult(`Succeed: "${target.search}" is not a URL, so it was searched instead: ${readableUrl(landed)}`, { keep: true });
        log('info', `"${target.search}"는 주소가 아니어서 검색으로 이동했습니다.`);
      } else {
        onResult(`Succeed: ${action.tool || 'goto'} navigated to ${readableUrl(landed)}.`, { keep: true });
      }
      return landed;
    }

    case 'go_back':
    case 'go_forward': {
      const direction = action.action === 'go_back' ? 'back' : 'forward';
      const url = await cdp.navigateHistory(tabId, direction);
      // Not an error: being at the end of the history is a normal state, and
      // ending the run over it would be worse than noting it and moving on.
      // But the MODEL has to be told, or it reads the fixed "Succeed: go_back
      // executed" beside an unchanged screenshot and concludes the page simply
      // looks the same. The same action reached through a hotkey already says
      // this; two roads to one action should not have two honesty levels.
      if (url === null) {
        onResult(`Succeed: no page to go ${direction} to; still on the current page.`, { keep: true });
        return '이동할 방문 기록이 없어 현재 페이지에 머뭅니다';
      }
      // The model reads this address, so it is decoded the same way the
      // observation's is — see readableUrl.
      onResult(`Succeed: went ${direction} to ${readableUrl(url)}.`, { keep: true });
      return url;
    }

    // The tab tools. They do not get their own implementation:
    // Ctrl+T, Ctrl+Tab and Ctrl+W already route to these functions, and a tool
    // that opened tabs differently from the chord would be a second answer to
    // the same question. Each returns its own sentence because a tab change is
    // exactly the kind of fact the next screenshot states only indirectly.
    case 'new_tab':
    case 'close_tab':
    case 'switch_tab': {
      await overlaySafe(tabId, { type: 'note', text: `탭: ${describeAction(action)}` });
      const done = action.action === 'new_tab' ? await browser.newTab()
        : action.action === 'close_tab' ? await browser.closeTab(tabId)
        : await browser.switchToIndex(tabId, action.index);
      onResult(done.result);
      onFacts({ ok: Boolean(done.ok) });
      if (!done.ok) log('warn', `${action.action}을(를) 실행하지 못했습니다 — ${done.result}`);
      return done.result;
    }

    // Attach a file. `path` is what the model wrote — "puppy.jpg", or
    // "Downloads" for the file this run downloaded (src/fileTransfer.js). It
    // fills the chooser an earlier action opened and left pending; with none
    // pending, the page's own <input type=file>. The line the model reads is
    // the training data's (uploadResultLine); a failure is one short line.
    case 'upload': {
      const pending = transfers.pending.get(tabId) || null;
      const target = pending || await cdp.findFileInput(tabId);
      const fail = (why) => {
        const line = uploadFailedLine(why);
        onResult(line, { keep: true });
        onFacts({ raw: line });
        log('warn', `upload 실패 — ${why}`);
        return `실패 — ${why}`;
      };
      if (!target) return fail('no file chooser is open and the page has no file input.');
      const multiple = pending ? pending.mode === 'selectMultiple' : Boolean(target.multiple);
      const picked = resolveUpload({
        path: action.path,
        mode: multiple ? 'selectMultiple' : 'selectSingle',
        uploadFiles: parseUploadFiles(els.uploadFiles.value),
        downloaded: transfers.watcher.all(),
      });
      if (picked.error) return fail(picked.error);
      try {
        await cdp.setFileInputFiles(tabId, target.backendNodeId, picked.files);
      } catch (err) {
        return fail(`could not attach "${action.path}".`);
      }
      if (pending) transfers.pending.delete(tabId);
      const names = picked.files.map(baseName);
      const line = uploadResultLine(action.path, names, Boolean(pending));
      onResult(line, { keep: true });
      onFacts({ raw: line });
      // The drawn chooser goes away with the real one it stands for.
      await overlaySafe(tabId, { type: 'chooserClose' });
      await overlaySafe(tabId, { type: 'note', text: `파일 첨부: ${names.join(', ')}` });
      log('info', `파일을 넣었습니다 — ${names.join(', ')}${pending ? '' : ' (페이지의 파일 입력란)'}`);
      return names.join(', ');
    }

    // The run loop ends on a terminal call before it gets here; these exist so
    // that a direct call still renders the same detail the loop would.
    case 'done':
    case 'finished':
    case 'fail':
    case 'unknown':
    case 'exit':
      return terminalDetail(action);

    default:
      throw new Error(`실행할 수 없는 동작 "${action.action}".`);
  }
}

/**
 * How a terminal action ends the run. Each has its OWN reason and its own log
 * severity: `finished` is success, `fail` and `unknown` are the model telling
 * you it did not do the job, and `EXIT` is it stopping without saying either.
 * Collapsing them into one "done" line would hide every failed run.
 *
 * The answer and the reason are NOT repeated here: the tool_call line directly
 * above already carries them, in the prominent style. This line is the verdict
 * on the run, not a second copy of what the model said.
 */
function terminalVerdict(action) {
  switch (action.action) {
    case 'done':
      return { kind: 'info', text: '실행 종료: 모델이 작업 완료를 보고했습니다.' };
    case 'finished':
      return {
        kind: 'info',
        text: action.answer
          ? '실행 완료: 모델이 작업을 끝내고 위 줄의 답변을 보고했습니다.'
          : '실행 완료: 모델이 성공을 보고했지만 답변 내용은 없습니다.',
      };
    case 'fail':
      return { kind: 'error', text: '실행 실패: 모델이 이 작업을 완료할 수 없다고 보고했습니다.' };
    case 'unknown':
      return { kind: 'error', text: '실행 종료: 모델이 현재 화면에 맞는 동작을 선택하지 못했습니다.' };
    case 'exit':
      return { kind: 'warn', text: '실행 종료: 모델이 성공 또는 실패 여부를 보고하지 않고 종료했습니다.' };
    default:
      return { kind: 'info', text: `실행 종료: ${action.action}.` };
  }
}

/* ------------------------------------------------------------------ */
/* Model clients                                                       */
/* ------------------------------------------------------------------ */

/**
 * Turn a non-2xx response into a sentence that says what to fix.
 * The bare `TypeError: Failed to fetch` / `HTTP 404` that fetch gives you costs
 * ten minutes of guessing every time, and this server is not reachable yet, so
 * these messages are the only diagnosis available.
 */
function explainHttpFailure(res, url, body, settings) {
  const tail = body ? ` 서버 응답: ${body.slice(0, 300)}` : '';
  switch (res.status) {
    case 401:
    case 403:
      return `모델 서버가 API 키를 거부했습니다(${res.status}). API 키 입력란을 확인하세요.${tail}`;
    case 404:
      return (
        `${url}에서 404 오류가 발생했습니다. 기본 URL이 /v1로 끝나는 OpenAI API 주소인지, ` +
        `서버에 "${settings.modelName}" 모델이 있는지 확인하세요. ${settings.baseUrl.replace(/\/+$/, '')}/models ` +
        `주소를 열어 vLLM에 로드된 모델을 확인할 수 있습니다.${tail}`
      );
    case 400:
    case 422:
      return (
        `서버가 요청 내용을 거부했습니다(${res.status}). 가능한 원인: ` +
        `--enable-auto-tool-choice 없이 실행한 vLLM은 tool_choice "auto"를 거부합니다. ` +
        `지금 보내는 값은 "${settings.toolChoice}"이니, 도구 선택 오류라면 tool_choice를 "none"으로 바꿔 보세요. ` +
        `이미지 인식을 지원하지 않는 모델은 image_url을 거부하며, max_tokens가 서버 한도를 초과해도 오류가 발생합니다. ` +
        `"도구 스키마 전송"을 해제하면 "tools" 항목이 원인인지 확인할 수 있습니다. ` +
        `단, 스키마를 보내지 않으면 모델 응답 형식의 정확도가 떨어질 수 있습니다.${tail}`
      );
    default:
      if (res.status >= 500) return `모델 서버 내부 오류 (${res.status} ${res.statusText}).${tail}`;
      return `모델 서버 응답: ${res.status} ${res.statusText}.${tail}`;
  }
}

/**
 * The reply text, however the server chose to hand it over.
 *
 * TWO SERVERS, TWO PLACES. vLLM under `tool_choice: "none"` never fills
 * `message.tool_calls`, so the call arrives as text in `message.content` and
 * src/modelSyntax.js reads it. vllm-mlx parses the call out for us — measured,
 * even without --enable-auto-tool-choice — and hands back
 * `tool_calls` with `content: null`.
 *
 * SO THE STRUCTURED SHAPE IS TURNED BACK INTO TEXT rather than teaching the
 * parser a second input. The parser is the one place that knows every repair
 * this checkpoint needs — the lost bracket, the aliased tool name, the
 * stringified arguments — and a second entry point would have to learn all of
 * them again. Rebuilding the `<tool_call>` block it already reads costs
 * nothing and keeps that knowledge in one file.
 *
 * `reasoning_content` is carried too, as a `<think>` block: it is the line a
 * demo audience reads, and dropping it would make the MLX path look like the
 * model stopped thinking.
 *
 * IT IS REBUILT IN THE XML THE PANEL PARSES. The original text is gone — the
 * server consumed it — so there is no "what the model really said" to be
 * faithful to, and the block has two readers that must both accept it: the
 * parser on this step, and the model itself on the next one, because the
 * transcript replays assistant turns verbatim.
 *
 * @param {object} message        choices[0].message
 * @returns {string} the reply text, or '' when there is nothing to read
 */
function replyTextFrom(message) {
  const content = message && typeof message.content === 'string' ? message.content : '';
  const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];

  // MEASURED AGAINST THE LIVE MLX SERVER, and it is not the empty `content`
  // the first version of this function expected: vllm-mlx returns the
  // reasoning as text AND the call in `tool_calls`, together —
  //
  //   content    "<think>I see a blue rectangle near the centre …</think>"
  //   tool_calls [{function: {name: "click", arguments: "{\"x\":500,\"y\":434}"}}]
  //
  // Returning early on non-empty content handed the parser a reply with no
  // call in it, on every single step. So `tool_calls` decides, not `content`:
  // whatever text came back is kept as the thinking, and the rebuilt blocks
  // are appended to it.
  // Blank content with no call is nothing at all, and callOpenAiModel's throw
  // is what must fire — not a reply made of whitespace.
  if (!calls.length) return content.trim() ? content : '';
  // Unless the call is already in the text, in which case rebuilding it would
  // send the same call twice.
  if (content.includes('<tool_call>')) return content;

  const blocks = calls.map((call) => {
    const fn = (call && call.function) || {};
    let args = fn.arguments;
    // `arguments` is a JSON STRING in the OpenAI shape and an object in some
    // servers'. Parsing it here produces the one shape the transcript replays;
    // a string that will not parse is passed through, because the parser
    // already accepts a stringified `arguments` and repairs it loudly.
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { /* leave it; the parser repairs it */ }
    }
    // The xml shape, one <parameter> per argument. A non-scalar value is
    // written as JSON inside the tag, which is what the xml reader already
    // does for a list argument such as hotkey's `keys`.
    const params = Object.entries(args && typeof args === 'object' ? args : {})
      .map(([name, value]) => {
        const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
        return `<parameter=${name}>\n${text}\n</parameter>`;
      });
    return `<tool_call>\n<function=${fn.name}>\n${params.join('\n')}${params.length ? '\n' : ''}</function>\n</tool_call>`;
  });

  // The thinking is wherever this server put it: in `content` (measured on
  // vllm-mlx) or in `reasoning_content` (the OpenAI reasoning shape). Keeping
  // it matters beyond the panel's log — the transcript replays assistant
  // turns verbatim, so dropping it would show the model a shape of its own
  // past reply that it never writes.
  const reasoning = message && typeof message.reasoning_content === 'string'
    ? message.reasoning_content.trim() : '';
  const head = content.trim() || (reasoning ? `<think>\n${reasoning}\n</think>` : '');
  return (head ? `${head}\n` : '') + blocks.join('\n');
}

/**
 * Call the OpenAI-compatible /v1/chat/completions endpoint and return the raw
 * reply text. See replyTextFrom for where in the response it may be hiding.
 */
async function callOpenAiModel(settings, body) {
  if (!settings.baseUrl) throw new Error('모델 서버의 기본 URL을 입력하세요.');
  if (!settings.modelName) throw new Error('모델 이름을 입력하세요.');
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  // A refused connection fails instantly; a wedged server accepts the socket and
  // never answers, and fetch has no timeout of its own. Without this the panel
  // goes quiet after the screenshot line and looks frozen — which is exactly
  // what happens while a model server is restarting.
  // settings.modelTimeoutSeconds is what the operator typed; the constant is
  // only the fallback for a caller that built settings without the field.
  const timeoutMs = Math.round((settings.modelTimeoutSeconds || MODEL_TIMEOUT_MS / 1000) * 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(TIMEOUT_REASON), timeoutMs);
  const started = Date.now();
  state.pending = controller;

  // Fifty seconds of nothing after the screenshot line looked like a freeze.
  // One line costs nothing and says the panel is alive and what it is waiting on.
  log('system', `모델 응답을 기다립니다 (최대 ${timeoutMs / 1000}초) — ${settings.modelName} @ ${settings.baseUrl}`);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.reason === TIMEOUT_REASON) {
      throw retryable(
        `${url}이(가) ${timeoutMs / 1000}초 동안 응답하지 않았습니다. ` +
        '연결은 되었으므로 주소와 포트는 맞습니다. 서버가 재시작 중이거나 모델을 적재하는 중일 수 있습니다. ' +
        '모델이 느려서 시간 안에 끝내지 못하는 것이라면 개발자 설정 → 모델 응답 대기 시간(초)을 늘리세요. ' +
        `서버에서 확인하세요: curl -m 5 ${settings.baseUrl.replace(/\/+$/, '')}/models`
      );
    }
    if (state.abort) throw stoppedWaitingForModel();
    // The browser gives up on a request it has had no bytes for at around 50
    // seconds, and reports the same opaque TypeError as a refused connection.
    // Telling the two apart matters: nothing is wrong with the server here, the
    // wait was simply set past a ceiling this panel does not own.
    const waited = Math.round((Date.now() - started) / 1000);
    if (waited >= 45) {
      throw new Error(
        `${url}이(가) ${waited}초 만에 브라우저 쪽에서 끊겼습니다 — ${err.message}. ` +
        '대기 시간을 50초 이상으로 두어도 브라우저가 먼저 연결을 포기하기 때문에, 이 구간은 설정으로 늘릴 수 없습니다. ' +
        '모델의 한 턴이 50초를 넘긴다면 최대 응답 토큰 수를 줄이거나 더 빠른 모델을 쓰고, ' +
        '그래도 부족하면 스트리밍 응답(stream: true) 도입이 필요합니다.'
      );
    }
    // fetch collapses connection-refused, DNS failure, TLS failure and a
    // blocked CORS preflight into one opaque TypeError, so name them all.
    // Retryable: a server mid-restart refuses for a few seconds, then answers.
    throw retryable(
      `${url}에 연결할 수 없습니다 — ${err.message}. 서버가 꺼져 있거나(연결 거부), ` +
      '현재 네트워크에서 서버에 접근할 수 없거나, 서버의 CORS 응답에 이 확장 프로그램을 허용하는 ' +
      'Access-Control-Allow-Origin이 없을 수 있습니다. ' +
      'manifest.json의 host_permissions에 서버 주소가 포함되어 있는지도 확인하세요.'
    );
  } finally {
    clearTimeout(timer);
    state.pending = null;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const failure = new Error(explainHttpFailure(res, url, text, settings));
    // Busy, overloaded or behind a proxy that hiccuped: worth asking again.
    // A 400/401/404 says the request itself is wrong, and will say it again.
    failure.retryable = MODEL_RETRY_STATUSES.has(res.status);
    throw failure;
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`${url}의 응답 상태는 ${res.status}이지만 응답 내용이 JSON이 아닙니다(${err.message}).`);
  }

  const choice = json && Array.isArray(json.choices) ? json.choices[0] : undefined;
  const content = replyTextFrom(choice && choice.message);
  if (!content.trim()) {
    throw new Error(
      '응답에 읽을 수 있는 choices[0].message.content도 tool_calls도 없습니다. 응답: ' +
      `${JSON.stringify(json).slice(0, 300)}`
    );
  }
  if (choice.finish_reason === 'length') {
    log('warn', `응답이 최대 토큰 수(${body.max_tokens})에 도달해 동작 내용이 잘렸을 수 있습니다.`);
  }
  return content;
}

/* ------------------------------------------------------------------ */
/* The run loop                                                        */
/* ------------------------------------------------------------------ */

function setRunning(running) {
  state.running = running;
  els.run.disabled = running;
  els.stop.disabled = !running;
  setStatus(running ? 'running' : 'attached', running ? 'running' : 'attached');
}

async function runLoop() {
  const settings = readSettings();
  // What the run ended as. The Discord listener answers the message that
  // started it, and has no other way to know. Pessimistic to begin with, so a
  // run that never gets off the ground is never reported as a success.
  state.lastRun = { ok: false, steps: 0, reason: '시작하지 못했습니다.', answer: '' };
  applyCoordConfig();

  const instruction = settings.task.trim();
  if (!instruction) {
    logError(new Error('먼저 작업 내용을 입력하세요.'));
    return;
  }
  let start;
  try {
    const entered = explicitStartUrl(settings.startUrl);
    start = entered ? { url: entered, extra: 0, explicit: true } : startUrlIn(instruction);
  } catch (err) {
    logError(err);
    return;
  }

  // Measured against this checkpoint: without the tool schema in the request it
  // never emits a <tool_call>. It answers in prose, or falls back to its native
  // <action>click('101')</action> — where the number is an element id from
  // another action space and means nothing to us. So a real-model run with the
  // schema off cannot produce a single executable step. The checkbox lives
  // inside the collapsed 개발자 설정, which makes it a silent kill switch; refuse
  // here, naming it, rather than spend three steps and a model's time finding out.
  if (!settings.useMock && !settings.sendTools) {
    logError(new Error(
      '"도구 스키마 전송"이 꺼져 있습니다. 이 설정 없이는 모델이 동작을 호출하지 못하고 ' +
      '설명문만 돌려줍니다. 개발자 설정 → 모델에서 켜고 다시 실행하세요.'
    ));
    return;
  }

  state.abort = false;
  state.abortReason = null;
  state.history = [];
  state.acted = false;
  state.pointer = null;
  state.openers = new Map();
  state.tabNote = null;
  closingTabs.clear();

  // Scoped to the run, so a file downloaded yesterday is never offered to a
  // file chooser today. Started here rather than at attach: the watcher is
  // about this task's files, not this tab's.
  transfers.watcher.reset();
  transfers.pending.clear();
  // Scoped to the run, like the downloads themselves: a PDF fetched for the
  // last task must not keep this one from fetching it again.
  transfers.pdfs.clear();
  transfers.watcher.start();

  // Load the scenario before anything else happens: a typo should stop the run
  // here, naming the step, not three actions into a demo.
  if (settings.useMock) {
    try {
      mockModel.setScript(parseScenario(settings.scenario));
    } catch (err) {
      logError(err);
      return;
    }
  }
  mockModel.reset();

  let tabId;
  try {
    tabId = await ensureAttached();
  } catch (err) {
    logError(err);
    return;
  }

  state.trajectory = {
    task: instruction,
    startUrl: start?.url || '',
    model: settings.useMock ? '테스트 모델' : settings.modelName,
    coordMode: getCoordConfig().mode,
    startedAt: new Date().toISOString(),
    endedAt: null,
    captures: 0,
    imagesSent: 0,
    lastViewport: null,
    steps: [],
    logs: [],
  };
  els.saveTrajectory.disabled = false;
  updateCaptureInfo();

  setRunning(true);
  startTabWatch();
  const source = settings.useMock
    ? `테스트 모델, ${mockModel.isCustom() ? `사용자 시나리오 ${mockModel.stepCount()}단계` : '기본 좌표 테스트'}`
    : `${settings.modelName} / ${settings.baseUrl}, 도구 스키마 ${settings.sendTools ? '전송' : '전송 안 함'}` +
      `, 도구 22개 · 학습 시스템 프롬프트`;
  // Named on the run-start line so a pasted log says which reading of the
  // result turn produced it. Comparing two runs is the whole point of the
  // switch, and a log that does not say which mode it was is not a comparison.
  const results = settings.trainingResults ? '결과 문장: 학습 데이터 형식'
    : settings.richResults ? '결과 문장: 실제 결과' : '결과 문장: 고정 문구';
  log('info', `실행 시작 — "${instruction}" (${source}, ${results}, 최대 ${settings.maxSteps}단계).`);
  if (readLoadWaitSeconds() === 0) {
    log('system', '로딩 대기가 0초입니다 — 각 단계는 기다리지 않고 현재 화면을 바로 촬영합니다.');
  }

  // Before step 1, not as step 1: the step counter belongs to the model's own
  // actions, and this one is ours. No wait is needed here — step 1 opens with
  // screenshotWhenReady, which is the same wait the navigation would have used.
  // A start address GUESSED from a bare word ("coupang.com") is not worth the
  // page the user already opened on that site — a product page, a half-filled
  // form. Only a url written out, or typed into the start field, moves a tab
  // that is already there.
  if (start && start.guessed) {
    const here = await chrome.tabs.get(tabId).catch(() => null);
    const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };
    const current = hostOf(here?.url || '');
    if (current && current === hostOf(start.url)) {
      log('system', `이미 ${current}에 있어 시작 주소(${start.url})로 이동하지 않고 현재 페이지에서 시작합니다.`);
      start = null;
    }
  }
  if (start) {
    if (start.extra) {
      log('system', `작업에 주소가 ${start.extra + 1}개 있어 마지막 것을 시작 주소로 씁니다.`);
    }
    log('info', `${start.explicit ? '입력한 시작 주소' : '시작 주소'}로 이동합니다 — ${start.url}`);
    try {
      await cdp.navigate(tabId, start.url);
    } catch (err) {
      log('warn', `시작 주소로 이동하지 못했습니다(${err.message}). 현재 페이지에서 그대로 실행합니다.`);
    }
  }

  let runFailed = false;
  let ended = false;
  try {
    // `step` counts steps that actually ran. A step thrown away by the
    // staleness guard below does not advance it, so a moving page cannot eat
    // the step budget.
    let step = 0;
    let staleRetries = 0;
    let failures = 0;
    /**
     * The step just produced is not going to run. Hand it back to whoever made
     * it, which matters only for the mock: the real model is stateless and
     * re-answers the next screenshot, but a SCENARIO IS A SCRIPT and `act()`
     * has already moved on. Without this the discarded step is simply lost,
     * and every scripted run lost its first one to the debugger infobar.
     */
    const discardStep = () => {
      if (settings.useMock && typeof mockModel.rewind === 'function') mockModel.rewind();
    };
    let parseFailures = 0;
  // The last reply we could not read, replayed to the model on the next try.
  let rejected = null;
    /**
     * Did a handover move the run off `fromTabId` while a command on it was in
     * flight? switchTabTo detaches the old tab, so a screenshot or click still
     * waiting on it fails with "Debugger is not attached" — which is not the
     * run breaking, only the step having been overtaken. Waits for a handover
     * still finishing, since the detach lands before state.tabId changes.
     */
    const tabChangedFrom = async (fromTabId) => {
      if (handover) await handover;
      return !state.abort && state.tabId !== fromTabId;
    };
    /** A capture overtaken by a handover: look again, on the new tab. */
    const TAB_CHANGED = Symbol('tab changed');
    const captureOn = async (fromTabId, capture) => {
      try {
        return await cdp.screenshotWhenReady(fromTabId, capture);
      } catch (err) {
        if (await tabChangedFrom(fromTabId)) {
          log('warn', '화면을 확인하는 동안 대상 탭이 바뀌었습니다. 새 탭에서 다시 확인합니다.');
          return TAB_CHANGED;
        }
        throw err;
      }
    };

    while (step < settings.maxSteps) {
      if (state.abort) break;
      // A click that opened a new tab hands the loop over to it. Wait for that
      // to finish before looking at a screen: the screenshot below has to be of
      // the tab the click led to, not the one it left. Re-read from state
      // rather than the local, because the handover is what changed it.
      if (handover) await handover;
      if (state.abort) break;
      tabId = state.tabId;
      const stepNo = step + 1;
      log('step', `단계 ${stepNo}/${settings.maxSteps}`);

      const loadWaitSeconds = readLoadWaitSeconds();
      const capture = {
        timeoutMs: Math.round(loadWaitSeconds * 1000),
        shouldAbort: () => state.abort,
        onWait: () => {
          setStatus('running', '로딩 대기 중');
          log('system', `페이지 로딩과 화면 안정화를 최대 ${loadWaitSeconds}초 동안 기다립니다.`);
        },
        // A budget of 0 is not a timeout, it is the operator having turned the
        // wait off — waitForPageReady checks the deadline before it ever polls,
        // so it returns at once and every single step logged a warning that
        // read like a stuck page. Said once at the start of the run instead.
        onTimeout: loadWaitSeconds > 0
          ? () => log('warn', '로딩 대기 시간이 지나 현재 화면으로 계속 실행합니다.')
          : () => {},
      };
      let shot = await captureOn(tabId, capture);
      if (shot === TAB_CHANGED) continue;
      if (state.abort || !shot) break;
      recordCapture(shot);
      // The address bar as the model is shown it. The transcript puts it
      // in every observation, and it is read HERE, next to the screenshot, so
      // the two always describe the same moment — the url this step saw is also
      // the url the previous step's action led to.
      const live = await chrome.tabs.get(tabId).catch(() => null);
      const pageUrl = live?.url || '';
      const pageTitle = live?.title || '';

      // A PDF IS A DEAD END FOR INPUT. The browser draws its own viewer into
      // the tab, so the toolbar photographs and the model aims at it, and CDP
      // input goes to the page's renderer and never arrives. The press is
      // performed here instead, before the model is asked what to do, so the
      // step that follows already has the file.
      // By content type, not by file extension: arxiv serves its papers at
      // `arxiv.org/pdf/2601.18734`, with no suffix at all, and that is the
      // address "View PDF" leads to.
      const showingPdf = looksLikePdf(pageUrl) || await cdp.isPdfDocument(tabId);
      const pdfTaken = showingPdf && await downloadShownPdf(pageUrl);
      if (pdfTaken) {
        log('info', 'PDF 뷰어의 도구 모음은 클릭할 수 없어, 보고 있는 PDF를 대신 내려받았습니다.');
        await overlaySafe(tabId, { type: 'note', text: 'PDF를 내려받았습니다' });
      }

      // A zoom has to outlive the page it was set on, and CSS zoom does not —
      // style.zoom dies with the document. The url is only known now, so the
      // restore necessarily lands after the capture, and a screenshot taken at
      // the wrong zoom is a screenshot the model would measure coordinates
      // against. Re-capture, but only when something actually changed.
      const restored = await browser.applyStoredZoom(tabId, pageUrl);
      if (restored !== null) {
        log('system', `이 사이트에 저장된 확대 비율 ${restored}%를 다시 적용하고 화면을 다시 캡처합니다.`);
        shot = await captureOn(tabId, capture);
        if (shot === TAB_CHANGED) continue;
        if (state.abort || !shot) break;
        recordCapture(shot);
      }

      // The real tab list, not a hard-coded "Tab 0 (active)". A model that can
      // open and switch tabs has to be shown the ones it opened, or Ctrl+Tab
      // is a step it can never follow up on.
      //
      // The active entry is restated from the record THIS step already read,
      // so the tab list and the rest of the same observation cannot disagree
      // about the page being driven. And a list that does not contain the tab
      // we drive — a tab mid-move between windows — is dropped rather than
      // shown, because describing the tab we actually drive is the answer that
      // cannot be wrong; tabBlock then falls back to the single-tab shape.
      let tabs = await browser.listTabs(tabId).catch(() => null);
      if (tabs && !tabs.some((tab) => tab.active)) tabs = null;
      if (tabs) {
        tabs = tabs.map((tab) => (tab.active
          ? { ...tab, url: pageUrl || tab.url, title: pageTitle || tab.title }
          : tab));
      }
      setStatus('running', 'running');
      const pixels = pngDimensions(shot.base64);
      log('system', `뷰포트 ${shot.viewport.width}×${shot.viewport.height} CSS px` +
        (pixels ? `, 스크린샷 ${pixels.width}×${pixels.height} px.` : '.'));
      if (stepNo === 1 && pixels && (pixels.width !== shot.viewport.width || pixels.height !== shot.viewport.height)) {
        log('warn', `실제 스크린샷은 ${pixels.width}×${pixels.height}px로 CSS 뷰포트 ${shot.viewport.width}×${shot.viewport.height}과 다릅니다. 저장한 HTML에서 좌표 위치를 확인하세요.`);
      }
      if (stepNo === 1 && !((shot.viewport.width === 1280 && shot.viewport.height === 720) ||
          (shot.viewport.width === 1280 && shot.viewport.height === 1000))) {
        log('warn', '현재 화면 크기가 학습 화면(1280×720, 1280×1000)과 다릅니다. 좌표는 화면 비율로 변환됩니다.');
      }

      // The mock keeps the Phase-1 JSON shape (and the Scenario box with it);
      // the real model speaks <tool_call> blocks holding {"name", "arguments"}.
      // Two wire formats, two parsers, one canonical action object out of both.
      let action;
      let reply = null;
      if (settings.useMock) {
        state.trajectory.imagesSent += 1;
        updateCaptureInfo();
        const raw = await mockModel.act({
          screenshot_b64: shot.base64,
          instruction,
          viewport: { width: shot.viewport.width, height: shot.viewport.height },
          history: state.history,
          coordConfig: getCoordConfig(),
        });
        if (state.abort) break;
        action = parseModelOutput(raw);
      } else {
        const body = buildProfileRequest({
          screen: shot.viewport,
          url: pageUrl,
          title: pageTitle,
          tabs,
          model: settings.modelName,
          maxTokens: settings.maxTokens,
          sendTools: settings.sendTools,
          toolChoice: settings.toolChoice,
          sampling: settings.sampling,
          rejected,
          instruction,
          screenshotB64: shot.base64,
          history: state.history,
        });
        // The request as it goes out, with the picture reduced to its size.
        // Printed BEFORE the call, so a request that times out or is refused
        // still leaves behind the thing you need to show the model team.
        if (settings.showRawRequest) log('model', `요청: ${describeRequest(body)}`);
        state.trajectory.imagesSent += 1;
        updateCaptureInfo();
        reply = await callModelWithRetry(settings, body);
        if (state.abort) break;
        // Off by default. `think` and the tool_call below are both extracted
        // from this string, so printing it as well says the same thing three
        // times and buries the two lines that matter. It is still the thing
        // you want when a parse fails, which is what the checkbox is for.
        if (settings.showRawReply) log('model', `응답: ${reply.trim()}`);

        // One reply this parser cannot read must not end the run. This
        // checkpoint invents argument names (`message` for text) and tool names
        // (`press_keys`), and a demo that threw away nine good steps over the
        // tenth would be useless. Log it, ask again with a fresh screenshot, and
        // only give up once it keeps happening — a persistent failure is a
        // format change worth stopping for, a single one is noise.
        try {
          action = parseProfileReply(reply);
          parseFailures = 0;
          rejected = null;
        } catch (err) {
          parseFailures += 1;
          // Hand the reply back to its author on the next request. Without this
          // the retry re-asks an unchanged question and gets the same answer.
          rejected = { reply, reason: err.message };
          // With 모델 응답 원문 표시 off, this error is the only place the reply
          // appears — so it has to carry it. The json parser quotes the reply
          // inside err.message; the xml path raises a bare sentence. Testing for
          // the reply's own opening rather than for a marker word covers both
          // without either file having to know about the other, and stops the
          // same string landing in the log twice.
          const head = reply.trim().slice(0, 40);
          const quoted = settings.showRawReply || err.message.includes(head);
          log('error', `모델 응답을 읽지 못했습니다 (${parseFailures}/${MAX_PARSE_FAILURES}) — ${err.message}`
            + (quoted ? '' : `\n원문: ${reply.trim().slice(0, 300)}`));
          if (parseFailures >= MAX_PARSE_FAILURES) {
            log('error', `${MAX_PARSE_FAILURES}회 연속으로 응답을 읽지 못해 중지합니다. 모델의 출력 형식이 변경되었을 수 있습니다.`);
            break;
          }
          discardStep();
          await abortableSleep(settings.stepDelay);
          continue;
        }
      }

      // A repair means the reply did not match the schema we sent and the
      // parser patched it. That is the early warning that the checkpoint or its
      // flags changed under us, so it goes in the log the operator is watching,
      // not only in the devtools console.
      if (action.repairs) {
        for (const note of action.repairs) log('warn', `응답 형식 보정 — ${note}`);
      }

      // The <think> block is the model's own reasoning and the line an audience
      // reads during a demo, so it is logged on its own rather than folded into
      // the action description.
      if (action.think) {
        logThink(action.think);
      }

      if (action.output) {
        // A terminal call's `output` IS its answer, which the tool_call line
        // below already carries. Logging it here as well is the duplication
        // this block exists to avoid; the on-page caption still gets it.
        if (!TERMINAL_ACTIONS.has(action.action)) log('model', action.output);
        await overlaySafe(tabId, { type: 'note', text: action.output });
      }

      if (TERMINAL_ACTIONS.has(action.action)) {
        logCall(action, terminalDetail(action));
        const verdict = terminalVerdict(action);
        log(verdict.kind, verdict.text);
        // `finished` is the model saying it is done; `fail` and `unknown` are
        // it saying it could not be.
        ended = true;
        state.lastRun = {
          ok: action.action === 'finished',
          steps: stepNo,
          reason: verdict.text,
          answer: terminalDetail(action),
        };
        state.history.push({
          step: stepNo,
          action: describeAction(action),
          output: action.output || null,
          // Kept for the next request: the transcript replays the model's own
          // words, and each past turn restates the screen it saw. `tool` and
          // `url` are what the result turn is built from — the name that
          // ran, and the address the NEXT step observes after it.
          reply,
          tool: action.tool || null,
          result: null,
          url: pageUrl,
          title: pageTitle,
          tabs,
          screen: { width: shot.viewport.width, height: shot.viewport.height },
        });
        recordTrajectoryStep({ stepNo, shot, action, reply, detail: terminalDetail(action),
          result: verdict.text, pageUrl, pageTitle, tabId, point: null, endPoint: null });
        break;
      }

      if (state.abort) break;
      // A handover that landed while the model was thinking makes this step's
      // screenshot a picture of a tab we no longer drive — and its point a
      // point on a page that is not on screen. Same answer as the staleness
      // guard below: throw the step away and look again, which costs no step
      // budget because `step` has not advanced yet.
      if (state.tabId !== tabId) {
        log('warn', '이 단계를 판단하는 동안 대상 탭이 바뀌었습니다. 이 단계는 실행하지 않고 새 탭을 다시 확인합니다.');
        discardStep();
        continue;
      }
      // STALENESS GUARD. The model judged a screenshot taken seconds ago. If
      // the page scrolled or the window resized in the meantime, the point it
      // chose now sits over different content and the click would land on the
      // wrong thing. Re-read the geometry; if it moved, throw this step away and
      // look again rather than act on what is no longer true.
      if (dependsOnScreen(action)) {
        let fresh;
        try {
          fresh = await cdp.getViewport(tabId);
        } catch (err) {
          if (!(await tabChangedFrom(tabId))) throw err;
          log('warn', '이 단계를 판단하는 동안 대상 탭이 바뀌었습니다. 이 단계는 실행하지 않고 새 탭을 다시 확인합니다.');
          discardStep();
          continue;
        }
        if (state.abort) break;
        const shift = describeViewportShift(shot.viewport, fresh);
        if (shift) {
          if (staleRetries < MAX_STALE_RETRIES) {
            staleRetries += 1;
            log('warn', `화면이 변경되었습니다(${shift}). 이 단계는 실행하지 않고 화면을 다시 확인합니다(${staleRetries}/${MAX_STALE_RETRIES}).`);
            discardStep();
            await abortableSleep(settings.stepDelay);
            continue;
          }
          // Still moving after N tries: a demo that stalls is worse than one
          // that acts on a slightly stale point, so proceed and say so.
          log('warn', `${MAX_STALE_RETRIES}회 재시도 후에도 화면이 변경되고 있습니다(${shift}). 현재 좌표로 동작을 실행합니다.`);
        }
      }
      staleRetries = 0;

      const point = reportPoint(action, shot.viewport);
      const endPoint = action.action === 'drag' ? reportPoint(action, shot.viewport, 'x2', 'y2') : null;

      // `result` is filled in only by an action with something to say that the
      // next screenshot will not show — a zoom, a find count, a tab switch, a
      // clear that did not clear. Everything else leaves it null and the
      // transcript sends the fixed sentence it has always sent.
      let result = null;
      let keepResult = false;
      let detail;
      let target = null;
      // For the 학습 데이터 형식 (training-format) line — see feedbackFor and
      // modelProfile's trainingResult. `extras` are the facts no screenshot
      // shows, each its own line after the first.
      let feedTarget = null;
      const facts = { extras: [] };
      const extras = [];
      // Sentences the training data appends to the action's OWN line,
      // space-separated: "… executed. Note: … A file chooser opened."
      const inline = [];
      let stepFailed = false;
      state.acted = true;
      try {
        // Read BEFORE acting: a click may navigate, and then the element is
        // gone. Becomes `Succeed: click on <div> role=textbox "…" executed.`
        //
        // INSIDE the try, not before it. Out there, anything this threw ended
        // the whole run — which is the failure MAX_ACTION_FAILURES exists to
        // prevent, reintroduced by a line that only reads. Naming the element
        // is a nicety; losing the run over it is not a trade worth making.
        target = point && TARGET_ACTIONS.has(action.action)
          ? await cdp.readTargetAt(tabId, point.x, point.y)
          : null;
        // The same point, described the way the training data describes it.
        feedTarget = settings.trainingResults && point && FEEDBACK_TARGET_ACTIONS.has(action.action)
          ? await cdp.readFeedbackTargetAt(tabId, point.x, point.y)
          : null;
        const notices = NOTICE_ACTIONS.has(action.action)
          ? await cdp.readPageLines(tabId)
          : null;

        // The click is NOT dispatched when it is aimed at a ghost. Dispatching
        // it is what puts the run in the loop, and a click delivered to
        // whatever drifted underneath is not the click the model asked for —
        // it is a click on something it has never seen.
        const ghost = repeatedGhost(action, point, target);
        // Both are read before dispatching, and repeatedGhost records as it
        // reads, so it is called whether or not it decides.
        const stuck = repeatedDialog(action, point);
        // A CLICK ON THE VIEWER IS WORSE THAN A WASTED STEP. Its download
        // icon does take a CDP click, and what it opens is the macOS save
        // panel: operating-system UI, outside the screenshot, impossible to
        // dismiss from here, and blocking the window until a person clicks
        // it. One stray click ends the run and needs a human to recover it.
        const onPdf = showingPdf && POINTER_ACTIONS.has(action.action)
          ? {
            result: pdfNotClickableLine(action.tool || action.action),
            detail: '거부 — PDF 뷰어는 페이지가 아니라 클릭할 수 없습니다',
          }
          : null;
        const refusal = ghost || stuck || onPdf;
        if (refusal) {
          result = refusal.result;
          keepResult = true;
          detail = refusal.detail;
          // Not dispatched: in the data's terms the step did nothing, which
          // it writes as the short line.
          stepFailed = true;
        } else {
          detail = await executeAction(tabId, action, shot.viewport, {
            mapCoords: true,
            view: { url: pageUrl, title: pageTitle },
            onResult: (text, { keep = false } = {}) => { result = text; keepResult = keep; },
            onFacts: ({ extra, ...rest }) => {
              if (extra) facts.extras.push(extra);
              Object.assign(facts, rest);
            },
          });
        }
        // A dialog blocks the renderer, so it is answered by the listener in
        // cdp.js the moment it opens — which means by the time we are here it
        // is already gone and no screenshot will ever show it. Saying so is
        // the only way the model learns the page asked it something.
        const dialogs = refusal ? [] : cdp.takeDialogs(tabId);
        if (!refusal) rememberDialog(action, point, dialogs);
        if (dialogs.length) {
          const said = dialogs.map((d) => `${d.type} ${JSON.stringify(d.message)} `
            + `(${d.accepted ? '확인' : '취소'})`).join('; ');
          const line = `The page opened a dialog: ${said}. `
            + 'A dialog is browser UI, so it is not in the screenshot and cannot be clicked; '
            + 'it was answered for you. Carry on from the page as it is now.';
          result = `${result || `Succeed: \`${action.tool || action.action}\` executed.`}\n${line}`;
          extras.push(line);
          keepResult = true;
          // Which of the two it was matters when a run is read back later:
          // an answer a person chose is not the same evidence as one a rule
          // took, and the trajectory report keeps this line.
          log('warn', dialogs.some((d) => d.asked)
            ? `페이지가 띄운 대화상자에 사용자가 답했습니다 — ${said}`
            : `페이지가 대화상자를 띄워 자동으로 응답했습니다 — ${said}`);
        }

        // A DOWNLOAD LANDS OUTSIDE THE PAGE. Chrome's download shelf is
        // browser UI and the page itself may show nothing at all, so without
        // this sentence the model presses 다운로드, sees an unchanged screen,
        // and presses it again. The wording is the model team's.
        const arrived = refusal ? [] : transfers.watcher.take();
        if (arrived.length) {
          const names = arrived.map(baseName);
          // Same line, as the training data writes it:
          // "… executed. Note: … The file NAME was downloaded."
          result = `${result || `Succeed: \`${action.tool || action.action}\` executed.`} `
            + downloadedLine(names);
          inline.push(downloadedLine(names));
          keepResult = true;
          log('info', `내려받았습니다 — ${names.join(', ')}`);
        }

        // A FILE CHOOSER IS OPERATING-SYSTEM UI. cdp intercepted it so it was
        // never drawn. It is NOT filled here: it stays pending, the action is
        // answered with the training data's " A file chooser opened.", and the
        // model's `upload(path)` call fills it (executeAction, case 'upload').
        if (!refusal && CHOOSER_ACTIONS.has(action.action)) {
          await cdp.waitForFileChooser(tabId, CHOOSER_WAIT_MS);
        }
        if (pdfTaken) {
          result = `${result || `Succeed: \`${action.tool || action.action}\` executed.`}`
            + `\n${PDF_DOWNLOADED}`;
          extras.push(PDF_DOWNLOADED);
          keepResult = true;
        }
        const choosers = refusal ? [] : cdp.takeFileChoosers(tabId);
        if (choosers.length) {
          transfers.pending.set(tabId, choosers.at(-1));
          // The training sentence on the same line, and what the data does
          // not say on its own: MEASURED, the line alone moved this model to
          // `upload` 0 times in 5, and with CHOOSER_HELP beside it 6 in 8.
          result = `${result || `Succeed: \`${action.tool || action.action}\` executed.`} ${CHOOSER_OPENED}`
            + `\n${CHOOSER_HELP}`;
          inline.push(CHOOSER_OPENED);
          extras.push(CHOOSER_HELP);
          keepResult = true;
          // AND DRAW IT. A sentence the screenshot contradicts loses: measured
          // over four real runs, the agent read "A file chooser opened.", said
          // in its own reasoning that it had opened, and pressed the same
          // button again because nothing on screen had changed. The window the
          // operating system never drew is drawn here instead, naming the
          // files `upload` can actually reach.
          await overlaySafe(tabId, {
            type: 'chooser',
            files: uploadCandidates(),
            multiple: choosers.at(-1).mode === 'selectMultiple',
          });
          log('info', '파일 선택 창이 열렸습니다 — 모델의 upload 호출을 기다립니다.');
        } else if (!refusal && transfers.pending.has(tabId)) {
          // STILL in front of one. A chooser stays open until `upload` fills
          // it, and the step that opened it is the only step that would ever
          // have mentioned it — which is how a run spends nine steps clicking
          // a button whose chooser is already waiting.
          result = `${result || `Succeed: \`${action.tool || action.action}\` executed.`}`
            + `\n${CHOOSER_WAITING}`;
          extras.push(CHOOSER_WAITING);
          keepResult = true;
        }

        if (notices && !refusal) {
          // Immediately, before the settle wait that loses it.
          const appeared = noticeFrom(notices, await cdp.readPageLines(tabId));
          if (appeared) {
            // `keep`: this outlives the fixed-sentence toggle for the same
            // reason a navigation does — it is a fact of the page that no
            // screenshot taken afterwards can state.
            result = `${result || `Succeed: \`${action.tool || action.action}\` executed.`}\n`
              + `The page then showed, briefly: ${appeared}`;
            extras.push(`The page then showed, briefly: ${appeared}`);
            keepResult = true;
            log('info', `잠깐 나타난 안내: ${appeared}`);
          }
        }
        // Reset here, not below: this budget counts consecutive THROWS. The
        // non-throwing actions that legitimately answer `Failed:` — a blocked
        // hotkey, a refused switch_tab, a clear with nothing focused — are the
        // model being told no, not the executor breaking, and they must not be
        // able to hold a stale count open across dozens of healthy steps.
        failures = 0;
      } catch (err) {
        // ONE STEP FAILING IS NOT THE RUN FAILING. Before this existed the
        // only guarded thing in the loop was the parse — an unreadable reply
        // got three retries and one unsupported keystroke got none, because
        // anything the executor threw went straight to the run-level catch.
        // A key the KEYS table does not know, a `goto` to a bare host, an
        // evaluate racing a navigation: each ended the demo. The transcript
        // already carries failures as result turns and the system prompt tells
        // the model to recover from them, so hand it the error and let it.
        if (state.abort) throw err;
        if (await tabChangedFrom(tabId)) {
          // The action ran far enough to open the tab we are now on; what
          // failed was its tail, still talking to the tab it left. That is
          // the action succeeding, and the next screenshot shows where it led.
          detail = '실행 — 새 탭으로 전환됨';
          failures = 0;
        } else {
          const why = String(err && err.message ? err.message : err);
          log('warn', `${action.action} 실행 실패 — ${why}`);
          result = `Failed: ${why}`;
          detail = `실패 — ${why}`;
          stepFailed = true;
          failures += 1;
          if (failures >= MAX_ACTION_FAILURES) {
            log('error', `동작 실행이 ${MAX_ACTION_FAILURES}회 연속 실패해 중지합니다.`);
            runFailed = true;
            break;
          }
        }
      }
      // THE TOGGLE IS ABOUT WHAT THE MODEL READS, nothing else. `detail` is
      // the Korean step log and is built either way, so the operator always
      // sees what actually happened; dropping `result` here is what sends the
      // transcript back to the fixed `Succeed: `{tool}` executed.`
      //
      // WHY BOTH READINGS EXIST. The model team gave us two documents that
      // disagree about this line. Their training-format spec says it is the
      // fixed sentence for every step — "학습 데이터의 결과
      // 문구는 전부 Succeed: ...executed. 다. 실행이 실패해도 같은 문구를
      // 넣어야 학습과 같다" — and their rendered trajectories bear that out,
      // 56 of 56. The paper's section A.2 says the training environment
      // compares the browser state before and after each call and emits text
      // describing the difference, which is what the rich branch does.
      //
      // We cannot settle that from here: the document has already been wrong
      // twice (the `url:` line, the title on the tab line), the paper is the
      // newer word, and the rich sentences measurably saved steps. So the
      // switch is a measurement, not an opinion. OFF is the document's
      // reading, ON is the paper's.
      // A popup that closed itself put the run back on its opener. The next
      // screenshot shows a different page with no reason why, so say it — and
      // keep it in either result mode, like a navigation.
      if (state.tabNote) {
        result = `${result || `Succeed: \`${action.tool || action.action}\` executed.`}\n${state.tabNote}`;
        extras.push(state.tabNote);
        keepResult = true;
        state.tabNote = null;
      }
      // A successful navigation (`keep`) still says where it landed.
      if (!settings.richResults && !keepResult) result = null;
      if (POINTER_ACTIONS.has(action.action)) await browser.releaseFocus(tabId).catch(() => {});
      logCall(action, detail);
      state.history.push({
        step: stepNo,
        action: describeAction(action),
        output: action.output || null,
        // Kept for the next request: the transcript replays the model's own
        // words, and each past turn restates the screen it saw. `tool`, `url`
        // and `tabs` are what the result turn is built from — the name
        // that ran, and the page and tab list the NEXT step observes after it.
        reply,
        tool: action.tool || null,
        result,
        target,
        // 학습 데이터 형식 only: the facts the training-format line is built
        // from once the next observation exists (modelProfile.trainingResult),
        // and the lines that follow it.
        feedback: settings.trainingResults
          ? feedbackFor(action, { el: feedTarget, facts, failed: stepFailed })
          : undefined,
        extras: settings.trainingResults ? [...facts.extras, ...extras] : undefined,
        inline: settings.trainingResults ? inline : undefined,
        url: pageUrl,
        title: pageTitle,
        tabs,
        screen: { width: shot.viewport.width, height: shot.viewport.height },
      });
      recordTrajectoryStep({ stepNo, shot, action, reply, detail, result, pageUrl, pageTitle, tabId, point, endPoint });
      step += 1;

      if (step === settings.maxSteps) {
        log('info', `최대 실행 단계(${settings.maxSteps})에 도달해 중지합니다.`);
      }
      await abortableSleep(settings.stepDelay);
    }

    if (state.abort && !state.abortReason) {
      // With a reason set, the line naming it is already in the log.
      log('info', '중지 버튼으로 실행을 중단했습니다.');
    }
  } catch (err) {
    if (state.abort && err.name === 'AbortError') {
      log('info', err.duringModelCall ? err.message : '페이지 로딩 대기를 중지했습니다.');
    } else {
      runFailed = true;
      logError(err);
    }
  } finally {
    // Abort and error land here too, which is the point: a listener outliving
    // its run would follow the next run's clicks with the wrong tab id.
    stopTabWatch();
    transfers.watcher.stop();
    if (!ended) {
      // No terminal call, so the run stopped for one of the three reasons the
      // loop itself can end on.
      state.lastRun = {
        ok: false,
        steps: state.history.length,
        reason: runFailed ? '오류로 중단되었습니다'
          : state.abort ? (state.abortReason || '중지했습니다')
            : '최대 실행 단계에 도달했습니다',
        answer: '',
      };
    }
    const finalStatus = runFailed ? 'error' : cdp.isAttached(state.tabId) ? 'attached' : 'idle';
    setStatus(finalStatus, finalStatus);
    log('info', '실행이 끝났습니다.');
    if (state.trajectory) state.trajectory.endedAt = new Date().toISOString();
    try {
      // Only when asked. The button beside the run controls saves on demand,
      // and a report written after every run — to the downloads folder, when
      // no directory has been granted — is a file nobody asked for, once a
      // run.
      if (settings.autoSaveTrajectory) await saveCurrentTrajectory();
    } catch (err) {
      logError(err);
    } finally {
      setRunning(false);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Discord remote commands                                             */
/* ------------------------------------------------------------------ */

/**
 * Poll the channel while the box is ticked, run what it finds, answer it.
 *
 * ONE AT A TIME, and the guard is the first thing the handler does. A second
 * mention arriving mid-run cannot be queued behind the first: by the time it
 * would start, the page is somewhere the person who typed it has not seen, and
 * a task written for the old screen is a task for a different screen. Saying
 * so is the only honest answer.
 *
 * THE MARKER MOVES WHETHER OR NOT ANYTHING RAN. Chatter in the channel still
 * advances `lastSeen`, or every poll re-reads the same page and the run that
 * was already refused is refused again, once every three seconds.
 */
const DISCORD_POLL_MS = 1000;
/**
 * What this run downloaded, so a later `upload` can attach it, and the file
 * chooser each tab has open and not yet filled (tabId → Page.fileChooserOpened
 * params).
 *
 * Module scope, like `discord`: it outlives one step and is reset per run, not
 * per action.
 */
const transfers = { watcher: createDownloadWatcher(), pending: new Map(), pdfs: new Set() };

/** Is this address a PDF the browser is showing in its own viewer? */
const looksLikePdf = (url) => /^https?:/i.test(String(url || ''))
  && /\.pdf(?:[?#]|$)/i.test(String(url).split('#')[0]);

/**
 * Fetch the PDF the tab is showing, once, through chrome.downloads.
 *
 * WHY THE PANEL DOES IT AND NOT THE MODEL. The viewer's download icon is
 * browser UI: it is in the screenshot, so the model aims at it, and CDP input
 * goes to the page's renderer and never arrives. MEASURED — six presses
 * across two sites, plus an invented "Control+Shift+9", and no file. There is
 * no key and no coordinate that works, so the press is performed here.
 *
 * chrome.downloads.download also sidesteps the save panel the viewer's own
 * button raises on macOS, and it is what reports the final path, which is
 * what a later `upload` needs.
 *
 * @returns {Promise<boolean>} true the first time this run sees this address.
 */
async function downloadShownPdf(url) {
  // The caller decided it is a PDF, by content type; this only decides
  // whether this run has already fetched this address.
  if (!/^https?:/i.test(String(url || '')) || transfers.pdfs.has(url)) return false;
  transfers.pdfs.add(url);
  try {
    await chrome.downloads.download({ url });
    return true;
  } catch (err) {
    log('warn', `PDF를 내려받지 못했습니다 — ${err.message}`);
    return false;
  }
}

/**
 * The file names the drawn chooser offers, in the order `upload` resolves
 * them: this run's downloads newest first, then the configured paths.
 *
 * Names, not paths. The model passes a name to `upload` and src/fileTransfer
 * turns it back into a path, so a full path on screen would invite it to type
 * something that then has to be matched against a base name anyway. The
 * operator's own machine layout is also nobody else's business in a demo.
 */
function uploadCandidates() {
  const downloaded = [...transfers.watcher.all()].reverse();
  const configured = parseUploadFiles(els.uploadFiles.value);
  const names = [...downloaded, ...configured].map(baseName).filter(Boolean);
  return [...new Set(names)];
}

const discord = { client: null, timer: null, lastSeen: null, busy: false };

function discordStatus(text) {
  els.discordStatus.textContent = text;
}

async function discordStop(reason = '꺼져 있습니다.') {
  clearTimeout(discord.timer);
  discord.timer = null;
  discord.client = null;
  discord.lastSeen = null;
  discordStatus(reason);
}

async function discordStart() {
  const settings = readSettings();
  if (!settings.discordRelay) {
    els.discordEnabled.checked = false;
    discordStatus('릴레이 주소를 먼저 입력하세요.');
    return;
  }

  discord.client = createRelayClient({ baseUrl: settings.discordRelay });
  try {
    const me = await discord.client.connect();
    // Start from now. Commands typed before the box was ticked were addressed
    // to a browser that was not listening, and running them on enable would
    // replay an afternoon of chat at whatever page happens to be open.
    discord.lastSeen = await discord.client.newestId();
    discordStatus(`${me.username}(으)로 듣고 있습니다. 채널에서 봇을 멘션하세요.`);
    log('info', `디스코드 원격 명령을 받습니다 — ${me.username}`);
  } catch (err) {
    els.discordEnabled.checked = false;
    await discordStop(`연결하지 못했습니다 — ${err.message}`);
    return;
  }
  discordPoll();
}

async function discordPoll() {
  if (!discord.client) return;
  try {
    const { commands, newest } = await discord.client.commandsAfter(discord.lastSeen);
    if (newest) discord.lastSeen = newest;
    for (const command of commands) await discordRun(command);
  } catch (err) {
    // A poll that fails is a network blip or a revoked token; neither is worth
    // tearing the listener down for, and the next tick says whether it lasted.
    discordStatus(`조회 실패 — ${err.message}`);
  }
  if (discord.client) discord.timer = setTimeout(discordPoll, DISCORD_POLL_MS);
}

async function discordRun(command) {
  /**
   * Answer the channel, and SAY SO WHEN IT CANNOT BE ANSWERED.
   *
   * This swallowed failure three times over: `discord.client?.` passed
   * silently when the listener had dropped, relayClient.say turned every
   * error into `false`, and the `false` was never read. The symptom was a run
   * that finished with no result in the channel and no line anywhere saying
   * why — which is the one thing a person cannot work out for themselves.
   *
   * Still never fatal. A reply that does not arrive is not a reason to lose
   * the run that produced it.
   */
  const say = async (text) => {
    const head = String(text).split('\n')[0];
    if (!discord.client) {
      log('warn', `디스코드로 보내지 못했습니다(연결이 끊겼습니다) — ${head}`);
      return false;
    }
    return discord.client.say(text, command.id, (err) => {
      log('warn', `디스코드로 보내지 못했습니다 — ${err.message}`);
    });
  };
  if (discord.busy || state.running) {
    await say('⏳ 이미 실행 중입니다. 끝나면 다시 보내 주세요.');
    return;
  }
  discord.busy = true;
  // THE SAME LINE, REWRITTEN. Whoever sent this from a phone has no panel to
  // look at: without it they see "시작합니다" and then nothing for a minute or
  // more, unable to tell a run in progress from one that died. Posting each
  // step instead would be fifty messages in the channel for one task.
  const progress = (text) => discord.client?.progress(text, command.id, (err) => {
    log('warn', `디스코드 진행 상황을 갱신하지 못했습니다 — ${err.message}`);
  });
  const sinceStart = (at) => `${Math.round((Date.now() - at) / 1000)}초`;
  const startedAt = Date.now();
  const showStep = () => {
    const done = state.history.length;
    const last = done ? state.history[done - 1] : null;
    progress(`⏳ ${command.task}\n`
      + (last ? `${done}단계 — ${last.action}` : '시작하는 중')
      + ` · ${sinceStart(startedAt)} 경과`);
  };
  let ticker = null;
  try {
    els.task.value = command.task;
    saveSettings();
    log('info', `디스코드 명령 — ${command.author}: ${command.task}`);
    await progress(`▶ 시작합니다 — ${command.task}`);
    // Four seconds: often enough to look alive, far under the rate limit
    // Discord puts on editing one message.
    ticker = setInterval(showStep, 4000);
    await runLoop();
    const run = state.lastRun || { ok: false, steps: 0, reason: '실행 정보를 읽지 못했습니다' };
    const ending = run.ok
      ? `✅ 완료 — ${run.steps}단계${run.answer ? `\n${run.answer}` : ''}`
      : `❌ ${run.reason} (${run.steps}단계)`;
    clearInterval(ticker);
    ticker = null;
    // The progress line keeps the task it was running, so the channel reads
    // as a record rather than a stale "⏳" nobody updated.
    await progress(`${run.ok ? '☑' : '☒'} ${command.task} — ${run.steps}단계, ${sinceStart(startedAt)}`);
    // A NEW message for the ending, not an edit: an edit raises no
    // notification, and the one moment the person wants their phone to buzz
    // is when the task they sent is done.
    await say(ending);
  } catch (err) {
    await say(`❌ 오류 — ${err.message}`);
    logError(err);
  } finally {
    clearInterval(ticker);
    discord.busy = false;
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function populateCoordModes() {
  for (const mode of COORD_MODES) {
    const option = document.createElement('option');
    option.value = mode;
    option.textContent = ({ norm1000: '0~1000 정규화 좌표', norm01: '0~1 비율 좌표', pixel: '이미지 픽셀 좌표' })[mode];
    els.coordMode.appendChild(option);
  }
  els.coordMode.value = DEFAULT_COORD_CONFIG.mode;
}

function wire() {
  els.run.addEventListener('click', () => {
    runLoop().catch(logError);
  });

  els.stop.addEventListener('click', () => {
    // The loop polls this flag between every awaited stage.
    state.abort = true;
    els.stop.disabled = true;
    // A model call can be mid-flight for a minute; polling a flag cannot reach
    // it, so abort the request itself.
    state.pending?.abort();
    // A dialog parks the loop inside one CDP command, where the abort flag is
    // never read. Left alone, 중지 would do nothing at all until someone
    // answered the question — so the button answers it, the safe way.
    pendingDialog?.finish(false, '중지를 눌러');
    log('info', '중지 요청을 받았습니다. 진행 중인 명령을 마친 후 멈춥니다.');
  });

  els.discordEnabled.addEventListener('change', () => {
    // Saved from here rather than from the list below, because discordStart
    // CLEARS the box when the relay cannot be reached — and saving before
    // that has had its say would store a tick that is about to be undone, so
    // the next open would try, fail and clear it all over again.
    if (els.discordEnabled.checked) {
      discordStart().then(saveSettings, (err) => { logError(err); saveSettings(); });
    } else {
      discordStop().catch(logError);
      saveSettings();
    }
  });

  els.chooseTrajectoryFolder.addEventListener('click', chooseTrajectoryDirectory);

  els.saveTrajectory.addEventListener('click', () => {
    saveCurrentTrajectory().catch(logError);
  });

  els.clearLog.addEventListener('click', () => {
    els.log.replaceChildren();
  });

  // <details> fires `toggle`, not `change`, so it cannot ride the list below.
  els.devSettings.addEventListener('toggle', saveSettings);

  els.coordMode.addEventListener('change', () => {
    applyCoordConfig();
    log('system', `좌표 방식 변경: "${els.coordMode.value}".`);
    saveSettings();
  });

  for (const el of [els.modelInputWidth, els.modelInputHeight]) {
    el.addEventListener('change', () => {
      applyCoordConfig();
      saveSettings();
    });
  }

  for (const el of [
    els.baseUrl, els.apiKey, els.modelName, els.maxTokens,
    els.useMock, els.sendTools, els.toolChoice, els.scenario, els.maxSteps, els.stepDelay,
    els.loadWaitSeconds, els.modelTimeoutSeconds, els.task, els.startUrl, els.showRawReply, els.showRawRequest, els.richResults, els.trainingResults, els.uploadFiles,
    els.discordRelay, els.autoSaveTrajectory, els.dialogPolicy,
    els.temperature, els.topP, els.topK]) {
    el.addEventListener('change', saveSettings);
  }

  // Chrome can detach us at any time: the tab closed, the user clicked
  // "Cancel" on the "is debugging this browser" infobar, or the target
  // crashed. Surface it and stop the run rather than failing every subsequent
  // CDP command with an opaque error.
  cdp.onDetached((source, reason) => {
    if (!source || source.tabId !== state.tabId) return;
    // Chrome may report a closed tab here BEFORE tabs.onRemoved. Either one
    // must give a followed popup back to its opener rather than end the run.
    if (state.running && reason === 'target_closed') {
      overlayPath.delete(source.tabId);
      drivenTabGone(source.tabId, `실행 중이던 탭 ${source.tabId}이(가) 닫혀 실행을 중단합니다.`);
      return;
    }
    log('system', `탭 ${source.tabId}의 디버거 연결이 해제되었습니다(${reason}).`);
    overlayPath.delete(source.tabId);
    state.tabId = null;
    if (state.running) {
      state.abortReason = '디버거 연결이 해제되어 실행을 중단했습니다.';
      state.abort = true;
      log('error', state.abortReason);
    }
    setStatus('idle', 'idle');
  });

  // Closing the side panel ends the run; make sure we do not leave the
  // infobar and the debugger session hanging on the page.
  window.addEventListener('pagehide', () => {
    state.abort = true;
    for (const tabId of cdp.attachedTabs()) {
      cdp.detach(tabId);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

populateCoordModes();
wire();
/**
 * Reconnect the Discord listener the operator left switched on.
 *
 * Not awaited by the caller and never fatal: the relay not running is the
 * ordinary case — it is a terminal someone has to start — and discordStart
 * already clears the box and prints why. A panel that refused to finish
 * loading over it would be worse than one that simply is not listening.
 */
function connectSavedDiscord() {
  if (!els.discordEnabled.checked) return;
  log('info', '원격 명령 받기가 켜진 채로 저장되어 있어 릴레이에 다시 연결합니다.');
  discordStart().catch(logError);
}

loadSettings().then(() => {
  log('system', '준비되었습니다. 일반 웹페이지를 연 뒤 작업 내용을 입력하고 실행 버튼을 누르세요.');
  setStatus('idle', 'idle');
  connectSavedDiscord();
});
