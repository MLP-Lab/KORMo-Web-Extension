/**
 * actions.js — the canonical action schema plus a tolerant parser for model
 * output.
 *
 * Canonical action (what the rest of the extension consumes):
 *   { action: 'click',        x, y,                        output? }
 *   { action: 'double_click', x, y,                        output? }
 *   { action: 'right_click',  x, y,                        output? }
 *   { action: 'hover',        x, y,                        output? }
 *   { action: 'focus',        x, y,                        output? }
 *   { action: 'clear',        x?, y?,                      output? }
 *   { action: 'drag',         x, y, x2, y2,                output? }
 *   { action: 'type',         text: string,                output? }
 *   { action: 'key',          key: 'Enter'|'Escape'|…,     output? }
 *   { action: 'hotkey',       keys: string[],              output? }
 *   { action: 'scroll',       x?, y?, deltaY, deltaX?,     output? }
 *   { action: 'wait',         seconds: number,             output? }
 *   { action: 'goto',         url: string,                 output? }
 *   { action: 'go_back' } | { action: 'go_forward' }
 *   { action: 'new_tab' } | { action: 'switch_tab', index } | { action: 'close_tab' }
 *   { action: 'upload',       path: string,                output? }
 *   { action: 'done' } | { action: 'finished', answer? }
 *   { action: 'fail', reason? } | { action: 'unknown', reason? } | { action: 'exit' }
 *
 * x/y/x2/y2 here are still in MODEL space. They become CSS viewport pixels
 * only after passing through coords.js. Keeping the two spaces separate is
 * what keeps the coordinate convention in exactly one file.
 *
 * `output` is the user-facing sentence shown in the chat log. Every action may
 * carry one; `done`/`finished` usually carry the final answer.
 *
 * `think` is the optional second free-text field: the model's own <think>
 * block, kept separate from `output` because a thought is not a result.
 *
 * `tool` is the wire name the model called, which the canonical name does not
 * always repeat (`EXIT` is executed as `exit`). Only src/modelSyntax.js sets
 * it, and only the transcript reads it, to answer each step with
 * "Succeed: `{tool}` executed." It is metadata about the reply, like `think`
 * and `repairs`, not part of the action the executor runs.
 *
 * TWO PARSERS FEED THIS SCHEMA. The real model speaks `<tool_call>` blocks
 * holding `{"name", "arguments"}` JSON and is parsed by src/modelSyntax.js.
 * The parser below reads the different, flatter JSON shape used by the mock
 * model, the Scenario box and the manual action box.
 */

export const ACTION_TYPES = Object.freeze([
  'click', 'double_click', 'right_click', 'hover', 'focus', 'clear', 'drag',
  'type', 'key', 'hotkey', 'scroll', 'wait', 'goto', 'go_back', 'go_forward',
  // The tab tools. They arrive as tools and as Ctrl+T/Ctrl+Tab/Ctrl+W chords,
  // and both reach the same routes in src/browserRoutes.js — one path, not two.
  'new_tab', 'switch_tab', 'close_tab',
  // Attach a file to the page's file picker; see src/fileTransfer.js.
  'upload',
  'done', 'finished', 'fail', 'unknown', 'exit',
]);

/**
 * Actions that end a run. They are NOT interchangeable: the run loop logs a
 * different reason for each, because "the model succeeded" and "the model gave
 * up" must not look the same in the log.
 */
export const TERMINAL_ACTIONS = Object.freeze(new Set(['done', 'finished', 'fail', 'unknown', 'exit']));

/**
 * The subset parseModelOutput builds from JSON. Everything else reaches the
 * executor through the model's call syntax, which is the only place it is
 * actually spoken, so there is no second hand-written mapping to drift.
 */
// `hotkey` is here for the Scenario box, so a browser chord can be fired with no
// model in the loop. The find bar exists to be legible in a screenshot, and the
// only way to judge that is to put one on screen and look at the capture.
const JSON_ACTIONS = Object.freeze([
  'click', 'double_click', 'right_click', 'hover', 'focus', 'clear', 'drag',
  'type', 'key', 'hotkey', 'scroll', 'wait',
  'goto', 'go_back', 'go_forward', 'new_tab', 'switch_tab', 'close_tab',
  'done',
]);

/** Point actions in this dialect: x/y are required and nothing else is. */
const JSON_POINT_ACTIONS = Object.freeze(['click', 'double_click', 'right_click', 'hover', 'focus']);

/**
 * Scroll default for a JSON `{"action":"scroll"}` with no magnitude — the mock
 * and the Scenario box only. The real model's schema makes `scroll_dy`
 * required, so a scroll from the model always carries its own number.
 */
export const DEFAULT_SCROLL_DELTA = 400;

/**
 * Pull a JSON object out of raw model output.
 * Accepts: a real object, a JSON string, or prose with a ```json fence or a
 * bare {...} block embedded in it. Small VLMs routinely do the last one, so
 * being tolerant here saves a whole class of demo failures.
 */
export function extractJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') {
    throw new Error(`Cannot parse model output of type ${typeof raw}`);
  }

  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    // fall through to extraction
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_) {
      // fall through
    }
  }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch (_) {
      // fall through
    }
  }

  throw new Error(`Model output is not JSON: ${text.slice(0, 200)}`);
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function requireNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Action field "${label}" must be a number, got: ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * Normalize raw model output into exactly one canonical action.
 * Throws with a readable message on anything it cannot map — the side panel
 * shows that message in the log instead of silently skipping a step.
 */
export function parseModelOutput(raw) {
  const obj = extractJson(raw);

  const name = String(firstDefined(obj.action, obj.action_type, obj.type, '')).trim().toLowerCase();
  if (!name) {
    throw new Error('Model output has no "action" field.');
  }
  if (!JSON_ACTIONS.includes(name)) {
    if (TERMINAL_ACTIONS.has(name)) {
      throw new Error(`"${name}" ends a run, and this dialect spells that "done". Write {"action": "done"}.`);
    }
    if (ACTION_TYPES.includes(name)) {
      throw new Error(
        `"${name}" is a real action but has no form in this JSON dialect. Write it as the model would ` +
        `— <tool_call>{"name": "${name}", "arguments": {…}}</tool_call> — and see src/modelSyntax.js.`
      );
    }
    throw new Error(`Unsupported action "${name}". Expected one of: ${JSON_ACTIONS.join(', ')}`);
  }

  const output = firstDefined(obj.output, obj.message, obj.thought);
  const action = { action: name };
  if (output !== undefined) action.output = String(output);

  // Some checkpoints emit a point array instead of x/y.
  const readPoint = () => (Array.isArray(obj.point) ? obj.point
    : Array.isArray(obj.coordinate) ? obj.coordinate : null);

  if (JSON_POINT_ACTIONS.includes(name)) {
    const point = readPoint();
    action.x = requireNumber(point ? point[0] : firstDefined(obj.x, obj.left), 'x');
    action.y = requireNumber(point ? point[1] : firstDefined(obj.y, obj.top), 'y');
    return action;
  }

  if (name === 'clear') {
    // Two shapes, matching the two schemas: the 18-tool clear names a point,
    // the 21-tool clear names none and empties whatever has focus. A scenario
    // that omits the point is exercising the 21-tool path on purpose, so the
    // point must stay absent rather than default to anything.
    const point = readPoint();
    const x = point ? point[0] : firstDefined(obj.x, obj.left);
    const y = point ? point[1] : firstDefined(obj.y, obj.top);
    if (x !== undefined && y !== undefined) {
      action.x = requireNumber(x, 'x');
      action.y = requireNumber(y, 'y');
    }
    return action;
  }

  if (name === 'drag') {
    action.x = requireNumber(firstDefined(obj.x, obj.left), 'x');
    action.y = requireNumber(firstDefined(obj.y, obj.top), 'y');
    action.x2 = requireNumber(firstDefined(obj.x2, obj.to_x), 'x2');
    action.y2 = requireNumber(firstDefined(obj.y2, obj.to_y), 'y2');
    return action;
  }

  if (name === 'wait') {
    const seconds = firstDefined(obj.seconds, obj.time, obj.duration);
    action.seconds = seconds === undefined ? 1 : requireNumber(seconds, 'seconds');
    return action;
  }

  if (name === 'goto') {
    const url = firstDefined(obj.url, obj.href, obj.address);
    if (typeof url !== 'string' || url.trim() === '') {
      throw new Error('"goto" action requires a non-empty "url".');
    }
    action.url = url.trim();
    return action;
  }

  if (name === 'switch_tab') {
    const index = firstDefined(obj.index, obj.tab, obj.tab_index);
    const value = requireNumber(index, 'index');
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`"switch_tab" needs a whole index of 0 or more, got ${JSON.stringify(index)}.`);
    }
    action.index = value;
    return action;
  }

  if (name === 'type') {
    const text = firstDefined(obj.text, obj.value, obj.content);
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('"type" action requires a non-empty "text" string.');
    }
    action.text = text;
    return action;
  }

  if (name === 'scroll') {
    const delta = firstDefined(obj.delta_y, obj.deltaY, obj.dy, obj.amount);
    action.deltaY = delta === undefined ? DEFAULT_SCROLL_DELTA : requireNumber(delta, 'delta_y');
    // Optional anchor point: where on the page the wheel event is aimed.
    // Omitted means "the middle of the viewport" (resolved downstream).
    const x = firstDefined(obj.x, obj.left);
    const y = firstDefined(obj.y, obj.top);
    if (x !== undefined) action.x = requireNumber(x, 'x');
    if (y !== undefined) action.y = requireNumber(y, 'y');
    return action;
  }

  if (name === 'hotkey') {
    // ["ctrl","f"] or "ctrl+f" — the Scenario box takes whichever is easier to
    // type, and both mean one chord.
    const raw = firstDefined(obj.keys, obj.key, obj.combo);
    const keys = Array.isArray(raw) ? raw
      : typeof raw === 'string' ? raw.split('+')
      : null;
    if (!keys || !keys.length || keys.some((k) => typeof k !== 'string' || !k.trim())) {
      throw new Error('"hotkey" action requires "keys", e.g. ["ctrl", "f"] or "ctrl+f".');
    }
    action.keys = keys.map((k) => k.trim());
    return action;
  }

  if (name === 'key') {
    const keyName = firstDefined(obj.key, obj.text, obj.value);
    if (typeof keyName !== 'string' || keyName.length === 0) {
      throw new Error('"key" action requires a "key" name such as "Enter".');
    }
    action.key = keyName;
    return action;
  }

  // go_back, go_forward, new_tab, close_tab and done carry nothing else.
  return action;
}

/** One-line human summary for the step log. */
export function describeAction(action) {
  switch (action.action) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'hover':
    case 'focus':
      return `${action.action} (${action.x}, ${action.y})`;
    case 'clear':
      // No point is not a missing argument: the gui22 schema's clear empties
      // whatever has focus, so there is no coordinate to print.
      return action.x === undefined ? 'clear (포커스된 입력란)' : `clear (${action.x}, ${action.y})`;
    case 'drag':
      return `drag (${action.x}, ${action.y}) -> (${action.x2}, ${action.y2})`;
    case 'type':
      return `type ${JSON.stringify(action.text)}`;
    case 'scroll':
      return `scroll deltaY=${action.deltaY}${action.deltaX ? ` deltaX=${action.deltaX}` : ''}`;
    case 'key':
      return `key ${action.key}`;
    case 'hotkey':
      return `hotkey ${action.keys.join('+')}`;
    case 'wait':
      return `wait ${action.seconds}s`;
    case 'goto':
      return `goto ${action.url}`;
    case 'go_back':
    case 'go_forward':
    case 'new_tab':
    case 'close_tab':
    case 'done':
    case 'exit':
      return action.action;
    case 'switch_tab':
      return `switch_tab ${action.index}`;
    case 'upload':
      return `upload ${JSON.stringify(action.path)}`;
    case 'finished':
      return action.answer ? `finished ${JSON.stringify(action.answer)}` : 'finished';
    case 'fail':
    case 'unknown':
      return action.reason ? `${action.action} ${JSON.stringify(action.reason)}` : action.action;
    default:
      return JSON.stringify(action);
  }
}
