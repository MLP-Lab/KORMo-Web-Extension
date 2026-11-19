/**
 * mockModel.js — a scripted stand-in for the real VLM server.
 *
 * It exists so the whole pipeline (screenshot -> action -> CDP -> overlay ->
 * log) is testable today, with no Python, no GPU and no HuggingFace download.
 * It returns the SAME raw JSON shape the server contract specifies, so the
 * output still goes through actions.parseModelOutput and exercises the parser.
 *
 * The script is written in 0..1 viewport fractions and converted into the
 * currently selected coordinate mode via coords.fromFraction. That is
 * deliberate: switching the mode dropdown and re-running the mock is the test
 * that the coordinate adapter is correct in every mode. The ring must land on
 * the same target each time.
 */

import { fromFraction } from './coords.js';

const SCRIPT = [
  {
    action: 'click',
    fx: 0.10,
    fy: 0.10,
    output: '1단계: 왼쪽 위 테스트 지점(10%, 10%)을 클릭합니다.',
  },
  {
    action: 'click',
    fx: 0.50,
    fy: 0.50,
    output: '2단계: 중앙 테스트 지점(50%, 50%)을 클릭합니다.',
  },
  {
    action: 'click',
    fx: 0.50,
    fy: 0.25,
    output: '3단계: (50%, 25%)의 입력란을 선택합니다.',
  },
  {
    action: 'type',
    text: 'hello from the mock gui agent',
    output: '4단계: 선택한 입력란에 텍스트를 입력합니다.',
  },
  {
    action: 'key',
    key: 'Enter',
    output: '5단계: Enter 키를 누릅니다.',
  },
  {
    action: 'scroll',
    fx: 0.5,
    fy: 0.5,
    delta_y: 400,
    output: '6단계: 아래로 400px 스크롤합니다.',
  },
  {
    action: 'click',
    fx: 0.90,
    fy: 0.90,
    output: '7단계: 오른쪽 아래 테스트 지점(90%, 90%)을 클릭합니다.',
  },
  {
    action: 'done',
    output: '테스트 실행 완료. 클릭, 입력, 키 누르기, 스크롤, 완료 동작을 모두 확인했습니다.',
  },
];

/** Actions a hand-written scenario may use. */
// `hotkey` is here so a browser chord can be fired without a model in the loop.
// Ctrl+F draws a find bar whose whole job is to be legible in the screenshot,
// and the only way to judge that is to put one on screen and look.
export const SCENARIO_ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'hover', 'focus', 'clear', 'drag',
  'type', 'key', 'hotkey', 'scroll', 'wait',
  'goto', 'go_back', 'go_forward', 'new_tab', 'switch_tab', 'close_tab',
  'done',
]);

/** Actions that must name a point. `clear` and `scroll` may, and need not. */
const SCENARIO_POINT_REQUIRED = new Set(['click', 'double_click', 'right_click', 'hover', 'focus']);

/** Read the first present key as a finite number, or undefined if none are set. */
function pickNumber(step, names, where) {
  for (const name of names) {
    if (step[name] === undefined || step[name] === null) continue;
    const value = Number(step[name]);
    if (!Number.isFinite(value)) {
      throw new Error(`${where}: "${name}" must be a number, got ${JSON.stringify(step[name])}.`);
    }
    return value;
  }
  return undefined;
}

/**
 * Validate one hand-written step and reduce it to the internal shape.
 * Rejecting a bad scenario here, naming the step number, beats discovering it
 * halfway through a demo run.
 */
function normalizeStep(step, i) {
  const where = `Scenario step ${i + 1}`;
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    throw new Error(`${where} is not an object.`);
  }

  const action = step.action || step.action_type || step.type;
  if (!SCENARIO_ACTIONS.has(action)) {
    throw new Error(`${where}: unknown action ${JSON.stringify(action)}. Use one of: ${[...SCENARIO_ACTIONS].join(', ')}.`);
  }

  const out = { action };
  if (step.output !== undefined) out.output = String(step.output);

  // Two ways to name a point. x/y are CSS viewport pixels, which is what you
  // read off the screen while writing the scenario. fx/fy are 0..1 fractions,
  // which keep pointing at the same thing after the window is resized.
  const fx = pickNumber(step, ['fx'], where);
  const fy = pickNumber(step, ['fy'], where);
  const cssX = pickNumber(step, ['x'], where);
  const cssY = pickNumber(step, ['y'], where);
  const hasFraction = fx !== undefined && fy !== undefined;
  const hasPixels = cssX !== undefined && cssY !== undefined;
  if (hasFraction) {
    out.fx = fx;
    out.fy = fy;
  } else if (hasPixels) {
    out.cssX = cssX;
    out.cssY = cssY;
  }

  // The second point, for drag. Same two spellings as the first.
  const fx2 = pickNumber(step, ['fx2'], where);
  const fy2 = pickNumber(step, ['fy2'], where);
  const cssX2 = pickNumber(step, ['x2'], where);
  const cssY2 = pickNumber(step, ['y2'], where);
  const hasFraction2 = fx2 !== undefined && fy2 !== undefined;
  const hasPixels2 = cssX2 !== undefined && cssY2 !== undefined;
  if (hasFraction2) {
    out.fx2 = fx2;
    out.fy2 = fy2;
  } else if (hasPixels2) {
    out.cssX2 = cssX2;
    out.cssY2 = cssY2;
  }

  if (SCENARIO_POINT_REQUIRED.has(action) && !hasFraction && !hasPixels) {
    throw new Error(`${where}: ${action} needs "x" and "y" (CSS pixels) or "fx" and "fy" (0..1).`);
  }

  switch (action) {
    case 'drag':
      if (!hasFraction2 && !hasPixels2) {
        throw new Error(`${where}: drag needs an end point — "x2" and "y2", or "fx2" and "fy2".`);
      }
      break;
    case 'wait': {
      const seconds = pickNumber(step, ['seconds', 'time', 'duration'], where);
      out.seconds = seconds === undefined ? 1 : seconds;
      break;
    }
    case 'goto':
      if (typeof step.url !== 'string' || !step.url.trim()) {
        throw new Error(`${where}: goto needs a "url", for example "naver.com".`);
      }
      out.url = step.url.trim();
      break;
    case 'switch_tab': {
      const index = pickNumber(step, ['index', 'tab', 'tab_index'], where);
      if (index === undefined || !Number.isInteger(index) || index < 0) {
        throw new Error(`${where}: switch_tab needs a whole "index" of 0 or more (see Available tabs).`);
      }
      out.index = index;
      break;
    }
    case 'type':
      if (typeof step.text !== 'string' || step.text === '') {
        throw new Error(`${where}: type needs a non-empty "text".`);
      }
      out.text = step.text;
      break;
    case 'hotkey': {
      const keys = Array.isArray(step.keys) ? step.keys
        : typeof step.keys === 'string' ? step.keys.split('+')
        : null;
      if (!keys || !keys.length || keys.some((k) => typeof k !== 'string' || !k.trim())) {
        throw new Error(`${where}: hotkey needs "keys", e.g. ["ctrl", "f"] or "ctrl+f".`);
      }
      out.keys = keys.map((k) => k.trim());
      break;
    }
    case 'key':
      if (typeof step.key !== 'string' || step.key === '') {
        throw new Error(`${where}: key needs a "key" name, for example "Enter".`);
      }
      out.key = step.key;
      break;
    case 'scroll': {
      const dy = pickNumber(step, ['delta_y', 'deltaY', 'dy'], where);
      if (dy === undefined) {
        throw new Error(`${where}: scroll needs "delta_y" (positive scrolls down).`);
      }
      out.delta_y = dy;
      break;
    }
    default:
      break; // done carries nothing but its output
  }

  return out;
}

/**
 * Turn the Scenario box's text into steps the mock can play.
 * @param {string} text a JSON array of actions; empty keeps the built-in script
 * @returns {Array|null} normalized steps, or null for the built-in script
 */
export function parseScenario(text) {
  const trimmed = String(text == null ? '' : text).trim();
  if (!trimmed) return null;

  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Scenario is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error('Scenario must be a JSON array, e.g. [{"action":"click","x":400,"y":115}].');
  }
  if (raw.length === 0) {
    throw new Error('Scenario is an empty array.');
  }
  return raw.map(normalizeStep);
}

/** Simulated server latency, so the UI is exercised the way it will really behave. */
const FAKE_LATENCY_MS = 150;

export function createMockModel() {
  let index = 0;
  let script = SCRIPT;

  return {
    name: 'mock',

    /**
     * Play a hand-written scenario instead of the built-in calibration script.
     * Pass null to go back to the built-in one.
     */
    setScript(steps) {
      script = steps && steps.length ? steps : SCRIPT;
      index = 0;
    },

    /** True when a hand-written scenario is loaded. */
    isCustom() {
      return script !== SCRIPT;
    },

    stepCount() {
      return script.length;
    },

    reset() {
      index = 0;
    },

    /**
     * Put the last step back, because the run threw it away without running it.
     *
     * MEASURED: the run loop discards a step when the viewport moved under it
     * or the driven tab changed while the model was thinking. For the real
     * model that costs nothing — it is stateless and simply answers the next
     * screenshot. A SCRIPT is not stateless: `act()` had already advanced, so
     * the discarded click was gone and the scenario silently played from its
     * second step. Opening the side panel shifts the viewport by the height of
     * Chrome's debugger infobar, so this hit the very first step of every
     * scripted run — the click vanished and every following step acted on
     * nothing focused.
     */
    rewind() {
      if (index > 0) index -= 1;
      return index;
    },

    /**
     * Same call signature as the real model client.
     * @param {{instruction:string, screenshot_b64:string, viewport:{width:number,height:number}, history:Array, coordConfig:object}} request
     * @returns {Promise<object>} raw model output, pre-parse
     */
    async act(request) {
      await new Promise((resolve) => setTimeout(resolve, FAKE_LATENCY_MS));

      if (index >= script.length) {
        return { action: 'done', output: '테스트 시나리오의 모든 동작을 실행했습니다.' };
      }

      const step = script[index];
      index += 1;

      // Strip the authoring fields; what goes out is the shape a real server
      // would send, in whichever coordinate space the UI claims the model
      // speaks. That round trip is what makes this a test of the adapter.
      const { fx, fy, cssX, cssY, fx2, fy2, cssX2, cssY2, ...rest } = step;

      // Both ends go through the SAME adapter. A drag with one end in model
      // space and the other in CSS pixels would be silently skewed, and the
      // skew would look like a model error rather than a scenario error.
      const toFraction = (frac, css, axis) => {
        if (frac !== undefined) return frac;
        if (css === undefined) return undefined;
        const vp = request.viewport;
        if (!vp || !vp.width || !vp.height) {
          throw new Error('Mock model needs the viewport size to place pixel coordinates.');
        }
        return css / (axis === 'x' ? vp.width : vp.height);
      };

      const fracX = toFraction(fx, cssX, 'x');
      const fracY = toFraction(fy, cssY, 'y');
      if (fracX === undefined) return rest;

      const point = fromFraction(fracX, fracY, request.coordConfig);
      const out = { ...rest, x: point.x, y: point.y };

      const fracX2 = toFraction(fx2, cssX2, 'x');
      const fracY2 = toFraction(fy2, cssY2, 'y');
      if (fracX2 !== undefined) {
        const end = fromFraction(fracX2, fracY2, request.coordConfig);
        out.x2 = end.x;
        out.y2 = end.y;
      }
      return out;
    },
  };
}
