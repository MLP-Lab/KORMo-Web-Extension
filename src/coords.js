/**
 * coords.js — THE single source of truth for coordinate conversion.
 *
 * Everything downstream of this file (cdp.js, the overlay, the step log)
 * speaks exactly one language: CSS pixels relative to the top-left of the
 * visual viewport. Nothing else. If a coordinate is wrong, the bug is here.
 *
 * WHY THIS EXISTS: the model's coordinate convention is not decided yet.
 * Qwen2-VL / UI-TARS style checkpoints emit 0..1000; some emit 0..1; some emit
 * raw pixels in the resized input image the processor fed them. Rather than
 * guess, we make it a runtime switch and keep the arithmetic in one place.
 *
 * WHY THE TARGET SPACE IS "CSS px relative to the viewport":
 *   1. CDP Input.dispatchMouseEvent takes exactly that. Not page coords, not
 *      device pixels. (x,y) = (0,0) is the top-left of what the user sees,
 *      NOT the top of the document. Scrolling changes what is at (0,0).
 *   2. We capture screenshots with Page.captureScreenshot + clip {scale: 1},
 *      which makes 1 screenshot pixel == 1 CSS pixel and puts the clip origin
 *      at the viewport origin. So there is NO devicePixelRatio step anywhere,
 *      even on a Retina Mac where DPR = 2.
 *   3. position:fixed overlay elements are also laid out in viewport CSS px,
 *      so the debug ring can use the same numbers with no conversion.
 */

export const COORD_MODES = Object.freeze(['norm1000', 'norm01', 'pixel']);

export const MODE_HELP = Object.freeze({
  norm1000: '0~1000 정규화 좌표(Qwen2-VL / UI-TARS 방식)',
  norm01: '화면 크기를 기준으로 한 0~1 비율 좌표',
  pixel: '모델 입력 이미지의 픽셀 좌표(아래에서 너비와 높이 설정)',
});

export const DEFAULT_COORD_CONFIG = Object.freeze({
  mode: 'norm1000',
  // Only consulted in 'pixel' mode: the width/height of the image the model
  // actually saw after the processor resized it. If the server sends back
  // coordinates in that image's pixel space we must rescale to the viewport.
  modelInputWidth: 1000,
  modelInputHeight: 1000,
});

let config = { ...DEFAULT_COORD_CONFIG };

export function getCoordConfig() {
  return { ...config };
}

/**
 * Apply a partial update. Throws on invalid input rather than silently
 * falling back, because a silently wrong coordinate mode is the single most
 * expensive failure mode in this project.
 */
export function setCoordConfig(patch) {
  const next = { ...config, ...patch };
  if (!COORD_MODES.includes(next.mode)) {
    throw new Error(`Unknown coordinate mode "${next.mode}". Expected one of: ${COORD_MODES.join(', ')}`);
  }
  next.modelInputWidth = Number(next.modelInputWidth);
  next.modelInputHeight = Number(next.modelInputHeight);
  if (next.mode === 'pixel') {
    if (!Number.isFinite(next.modelInputWidth) || next.modelInputWidth <= 0 ||
        !Number.isFinite(next.modelInputHeight) || next.modelInputHeight <= 0) {
      throw new Error('"pixel" mode requires a positive model input width and height.');
    }
  }
  config = next;
  return getCoordConfig();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function assertViewport(viewport) {
  const w = Number(viewport && viewport.width);
  const h = Number(viewport && viewport.height);
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
    throw new Error('toViewportPx needs a viewport like { width, height } in CSS px.');
  }
  return { width: w, height: h };
}

/**
 * Model coordinate -> CSS viewport pixel.
 *
 * @param {number} x        raw x as emitted by the model
 * @param {number} y        raw y as emitted by the model
 * @param {{width:number,height:number}} viewport  CSS px size of the visual viewport
 * @param {object} [cfg]    coordinate config; defaults to the module config
 * @returns {{x:number, y:number, fx:number, fy:number, mode:string}}
 *          x/y are integer CSS viewport px; fx/fy are the intermediate 0..1
 *          fractions, which the overlay and the log print for debugging.
 */
export function toViewportPx(x, y, viewport, cfg = config) {
  const vp = assertViewport(viewport);
  const rx = Number(x);
  const ry = Number(y);
  if (!Number.isFinite(rx) || !Number.isFinite(ry)) {
    throw new Error(`Non-numeric coordinate from model: x=${x}, y=${y}`);
  }

  // Step 1: bring whatever the model said into a 0..1 fraction of the frame
  // it was looking at. Because the screenshot clip is the viewport at scale 1,
  // "the frame the model saw" and "the viewport" are the same rectangle.
  let fx;
  let fy;
  switch (cfg.mode) {
    case 'norm1000':
      fx = rx / 1000;
      fy = ry / 1000;
      break;
    case 'norm01':
      fx = rx;
      fy = ry;
      break;
    case 'pixel':
      fx = rx / cfg.modelInputWidth;
      fy = ry / cfg.modelInputHeight;
      break;
    default:
      throw new Error(`Unknown coordinate mode "${cfg.mode}"`);
  }

  // Step 2: fraction -> CSS viewport px. No devicePixelRatio term: the clip
  // screenshot is already in CSS px (see the header comment).
  // Step 3: clamp inside the viewport. A model that overshoots by a few px
  // should still land on the page instead of throwing away the whole step.
  return {
    x: Math.round(clamp(fx * vp.width, 0, vp.width - 1)),
    y: Math.round(clamp(fy * vp.height, 0, vp.height - 1)),
    fx,
    fy,
    mode: cfg.mode,
  };
}

/**
 * Inverse of step 1: a 0..1 fraction -> whatever the current mode expects.
 * Used by the mock model so the scripted actions round-trip correctly
 * whichever coordinate mode is selected in the UI, which is exactly how you
 * test that this adapter works before the real model exists.
 */
export function fromFraction(fx, fy, cfg = config) {
  switch (cfg.mode) {
    case 'norm1000':
      return { x: Math.round(fx * 1000), y: Math.round(fy * 1000) };
    case 'norm01':
      return { x: Number(fx.toFixed(4)), y: Number(fy.toFixed(4)) };
    case 'pixel':
      return {
        x: Math.round(fx * cfg.modelInputWidth),
        y: Math.round(fy * cfg.modelInputHeight),
      };
    default:
      throw new Error(`Unknown coordinate mode "${cfg.mode}"`);
  }
}
