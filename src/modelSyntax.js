/**
 * modelSyntax.js — a `<tool_call>{"name", "arguments"}` call to the canonical
 * action.
 *
 * The model replies in the gui22 XML (`<function=click><parameter=x>`);
 * src/modelProfile.js reads that strictly against GUI22_TOOLS and hands it
 * here as the equivalent JSON call, with a point folded into `point_2d`. This
 * file owns the mapping onto the canonical action object in src/actions.js.
 *
 * A reply's reasoning sits BEFORE the first `</think>` (the template opens
 * `<think>` itself), so the split is "everything up to the first `</think>` is
 * the thought".
 *
 * TOLERANT ON INPUT, STRICT ON OUTPUT. The checkpoint can be restarted with
 * different flags and the schema can change under us, so this reads a point
 * written as `point_2d`, `x_2d`, a bare `[x, y]`, or separate `x`/`y` —
 * and repairs the one malformed shape we have actually measured:
 *
 *     {"x": 856, 38}      <- a lost array bracket. Not valid JSON at all.
 *
 * Every repair is recorded on `action.repairs` AND pushed to `console.warn`,
 * so a format drift shows up in the step log on the first step instead of
 * being absorbed silently for a week. What it cannot confidently repair still
 * throws, with the offending call printed in full: a silently wrong action
 * clicks the wrong thing on a real page.
 *
 * Parameter names come out of PARSEABLE_TOOLS in src/modelSpec.js.
 *
 * `clear` takes NOTHING in the gui22 schema and means "empty whatever already
 * has focus". A clear that does carry a point keeps it — src/cdp.js is what
 * decides that no point means no click.
 *
 * This module imports nothing browser-specific, so it runs and is unit-testable
 * under plain `node`.
 */

import { PARSEABLE_TOOLS, PARSEABLE_NAMES, TOOL_ALIASES } from './modelSpec.js';

/* ------------------------------------------------------------------ */
/* The schema, indexed                                                 */
/* ------------------------------------------------------------------ */

const SCHEMA = new Map(
  PARSEABLE_TOOLS.map((t) => [
    t.function.name,
    {
      properties: Object.keys(t.function.parameters.properties || {}),
      required: t.function.parameters.required || [],
    },
  ])
);

/** Every function name the parser accepts, across every schema we send. */
export const ACTION_NAMES = PARSEABLE_NAMES;

const TOOL_OPEN = '<tool_call>';
const TOOL_CLOSE = '</tool_call>';
const THINK_CLOSE = '</think>';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function preview(s, n = 200) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

const q = (s) => JSON.stringify(String(s));

/** JSON for an error message, never throwing on a cyclic or odd value. */
function show(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

/**
 * Where repairs are collected.
 *
 * Two outlets on purpose: `console.warn` is the one a developer with devtools
 * open sees immediately, and the returned list becomes `action.repairs`, which
 * sidepanel.js prints into the step log where the person running the demo will
 * actually read it.
 */
function repairLog() {
  const list = [];
  return {
    list,
    note(message) {
      list.push(message);
      console.warn(`[modelSyntax] REPAIRED: ${message}`);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Argument reading                                                    */
/* ------------------------------------------------------------------ */

/**
 * The arguments object, read by name, remembering which names were looked at.
 *
 * The bookkeeping is what lets an undeclared argument be *reported* rather than
 * either ignored silently or treated as fatal. `is_hotkey` in the measured
 * `press_keys` call is the live example: harmless, but we want to know.
 */
class Args {
  constructor(callName, raw, log) {
    this.callName = callName;
    this.raw = raw;
    this.log = log;
    this.seen = new Set();
  }

  /** The first of `names` that carries a value, plus the name it came under. */
  pick(...names) {
    let hit = null;
    for (const name of names) {
      this.seen.add(name);
      const value = this.raw[name];
      if (hit === null && value !== undefined && value !== null && value !== '') {
        hit = { key: name, value };
      }
    }
    return hit;
  }

  note(message) {
    this.log.note(`${this.callName}: ${message}`);
  }

  bad(message) {
    throw new Error(`${this.callName}: ${message}. The call was ${show({ name: this.callName, arguments: this.raw })}`);
  }

  /** Keys nothing asked for. */
  leftovers() {
    return Object.keys(this.raw).filter((k) => !this.seen.has(k));
  }
}

/** A number, from a number or from a numeric string. */
function num(a, key, value, what = key) {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) {
    a.bad(`${q(what)} must be a number, got ${show(value)}`);
  }
  if (typeof value !== 'number') {
    a.note(`${q(key)} arrived as the string ${show(value)}; read as the number ${n}`);
  }
  return n;
}

/**
 * Turn whatever is under `key` into {x, y}.
 * Accepts `[x, y]`, `"[x, y]"` and `"x, y"` — the three shapes a point has
 * actually arrived in — and nothing else.
 */
function asPair(a, key, value, what) {
  let array = value;

  if (typeof array === 'string') {
    const text = array.trim();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      const parts = text.replace(/^[[(]|[\])]$/g, '').split(',');
      if (parts.length === 2) parsed = parts;
    }
    if (!Array.isArray(parsed)) {
      a.bad(`${what} ${q(key)} must be [x, y], got the string ${show(value)}`);
    }
    a.note(`${what} arrived as the string ${show(value)} instead of an array`);
    array = parsed;
  }

  if (!Array.isArray(array)) {
    a.bad(`${what} ${q(key)} must be an [x, y] array, got ${show(value)}`);
  }
  if (array.length !== 2) {
    a.bad(`${what} ${q(key)} must hold exactly 2 numbers, got ${array.length}: ${show(value)}`);
  }
  return { x: num(a, key, array[0], `${what} x`), y: num(a, key, array[1], `${what} y`) };
}

/**
 * One point, however the model spelled it.
 *
 * @param {Args} a
 * @param {string[]} arrayKeys keys that may hold [x, y]; arrayKeys[0] is the declared one
 * @param {string[]} xKeys     keys that may hold a bare x
 * @param {string[]} yKeys     keys that may hold a bare y
 * @param {string} what        'point' / 'drag start' / 'drag end', for messages
 */
function readPoint(a, arrayKeys, xKeys, yKeys, what) {
  const declared = arrayKeys[0];

  const array = a.pick(...arrayKeys);
  if (array) {
    if (array.key !== declared) {
      a.note(`${what} arrived as ${q(array.key)}; the schema declares ${q(declared)}`);
    }
    return asPair(a, array.key, array.value, what);
  }

  const x = a.pick(...xKeys);
  const y = a.pick(...yKeys);

  // The measured collision: our key, the model's value shape. After the lost
  // bracket is repaired, `{"x": 856, 38}` lands here as `{"x": [856, 38]}`.
  if (x && !y) {
    const pair = asPair(a, x.key, x.value, what);
    a.note(`${q(x.key)} held the whole ${what} ${show(x.value)} with no ${q(yKeys[0])} beside it; read as ${q(declared)}`);
    return pair;
  }

  if (x && y) {
    a.note(`${what} arrived as separate ${q(x.key)}/${q(y.key)}; the schema declares ${q(declared)}: [x, y]`);
    return { x: num(a, x.key, x.value, `${what} x`), y: num(a, y.key, y.value, `${what} y`) };
  }

  a.bad(
    `no ${what}. Expected ${q(declared)}: [x, y]; found none of ` +
    `${[...arrayKeys, ...xKeys, ...yKeys].map(q).join(', ')}`
  );
}

/** A list of key names, from an array, a JSON array string, or a bare string. */
function readKeys(a) {
  const hit = a.pick('keys', 'key', 'key_list', 'keys_list', 'hotkey');
  if (!hit) a.bad('needs "keys", a list of key names such as ["Enter"]');
  if (hit.key !== 'keys') a.note(`keys arrived as ${q(hit.key)}; the schema declares "keys"`);

  let list = hit.value;
  if (typeof list === 'string') {
    const text = list.trim();
    if (text.startsWith('[')) {
      try {
        list = JSON.parse(text);
      } catch (err) {
        a.bad(`"keys" looked like a JSON array but did not parse (${err.message}): ${show(hit.value)}`);
      }
      a.note(`"keys" arrived as the JSON string ${show(hit.value)} instead of an array`);
    } else {
      list = [text];
      a.note(`"keys" arrived as the bare string ${show(hit.value)}; read as ${show(list)}`);
    }
  }

  if (!Array.isArray(list)) a.bad(`"keys" must be an array of strings like ["Enter"], got ${show(hit.value)}`);
  if (!list.length) a.bad('"keys" must name at least one key, e.g. ["Enter"]');
  const wrong = list.findIndex((k) => typeof k !== 'string' || !k);
  if (wrong !== -1) {
    a.bad(`"keys" item ${wrong + 1} must be a non-empty string, got ${show(list[wrong])}`);
  }
  return list;
}

/**
 * A non-empty string parameter.
 *
 * The alias list cannot keep up with this checkpoint: it has already produced
 * `message` for type, `x_2d` for a point and `press_keys` for a tool name, so
 * the next unseen spelling is a matter of time. When none of the known names
 * match but the model sent exactly ONE string argument, that string is the
 * parameter whatever it called it — a tool like type or goto has only one, so
 * there is nothing else it could be. Losing a whole run to a synonym is the
 * worse failure. The guess is announced, so drift stays visible.
 */
function readText(a, names, what) {
  let hit = a.pick(...names);

  if (!hit) {
    const strings = Object.entries(a.raw).filter(
      ([, v]) => typeof v === 'string' && v !== ''
    );
    if (strings.length === 1) {
      hit = { key: strings[0][0], value: strings[0][1] };
      a.seen.add(hit.key);
    }
  }

  if (!hit) a.bad(`needs ${q(names[0])}`);
  if (hit.key !== names[0]) a.note(`${what} arrived as ${q(hit.key)}; the schema declares ${q(names[0])}`);
  const text = typeof hit.value === 'string' ? hit.value : String(hit.value);
  if (!text) a.bad(`needs a non-empty ${q(names[0])}`);
  return text;
}

/* ------------------------------------------------------------------ */
/* call -> canonical action                                            */
/* ------------------------------------------------------------------ */

// The aliases are measured or one keystroke away from one. `x_2d` and a bare
// `point` are shapes this checkpoint family emits; `x_1000`/`y_1000` are the
// separate-scalar spelling another checkpoint uses.
const POINT_KEYS = ['point_2d', 'x_2d', 'point', 'coordinate', 'coord', 'position'];
const X_KEYS = ['x', 'x_1000'];
const Y_KEYS = ['y', 'y_1000'];

const pointAction = (name) => (a) => ({ action: name, ...readPoint(a, POINT_KEYS, X_KEYS, Y_KEYS, 'point') });
const nullary = (name) => () => ({ action: name });

/** True when the call carries something that could be a point at all. */
const hasPoint = (a) => [...POINT_KEYS, ...X_KEYS, ...Y_KEYS].some((key) => {
  const value = a.raw[key];
  return value !== undefined && value !== null && value !== '';
});

const BUILDERS = Object.freeze({
  click: pointAction('click'),
  double_click: pointAction('double_click'),
  right_click: pointAction('right_click'),
  hover: pointAction('hover'),
  focus: pointAction('focus'),

  // The one tool whose SHAPE changed rather than its spelling. Under the
  // 21-tool schema `clear` declares no parameters and empties the focused
  // input; under the 18-tool one it carries a point and clicks it first. A
  // point is therefore read when it is there and not demanded when it is not —
  // refusing a coordinate-less clear would refuse the shape the served
  // checkpoint is trained to emit.
  clear: (a) => (hasPoint(a) ? pointAction('clear')(a) : { action: 'clear' }),

  drag: (a) => {
    const start = readPoint(
      a, ['start_point_2d', 'start_point', 'point_2d', 'from', 'start'],
      ['x', 'start_x', 'x1'], ['y', 'start_y', 'y1'], 'drag start'
    );
    const end = readPoint(
      a, ['end_point_2d', 'end_point', 'point2_2d', 'to', 'end'],
      ['x2', 'end_x'], ['y2', 'end_y'], 'drag end'
    );
    return { action: 'drag', x: start.x, y: start.y, x2: end.x, y2: end.y };
  },

  type: (a) => ({ action: 'type', text: readText(a, ['text', 'message', 'content', 'value', 'input_text'], 'text') }),

  hotkey: (a) => ({ action: 'hotkey', keys: readKeys(a) }),

  // deltaY/deltaX are SCREENSHOT PIXELS, not 0..1000 pointer coordinates.
  // They are named deltaY/deltaX here — not x/y — precisely so nothing
  // downstream can mistake them for a point and put them through the
  // coordinate adapter: coords.js is only ever reached via action.x/action.y,
  // and a parsed scroll has neither. That makes "a delta is never scaled" a
  // structural property rather than a rule someone has to remember.
  scroll: (a) => {
    const dy = a.pick('scroll_dy', 'dy', 'delta_y', 'deltaY', 'scroll_y');
    const dx = a.pick('scroll_dx', 'dx', 'delta_x', 'deltaX', 'scroll_x');
    if (!dy && !dx) a.bad('needs "scroll_dy", a signed pixel delta');
    if (dy && dy.key !== 'scroll_dy') a.note(`vertical delta arrived as ${q(dy.key)}; the schema declares "scroll_dy"`);
    if (dx && dx.key !== 'scroll_dx') a.note(`horizontal delta arrived as ${q(dx.key)}; the schema declares "scroll_dx"`);
    if (!dy) a.note('no "scroll_dy"; scrolling horizontally only');
    return {
      action: 'scroll',
      deltaY: dy ? num(a, dy.key, dy.value, 'scroll_dy') : 0,
      deltaX: dx ? num(a, dx.key, dx.value, 'scroll_dx') : 0,
    };
  },

  wait: (a) => {
    const hit = a.pick('seconds', 'time', 'duration', 'sec');
    if (!hit) a.bad('needs "seconds"');
    if (hit.key !== 'seconds') a.note(`duration arrived as ${q(hit.key)}; the schema declares "seconds"`);
    const seconds = num(a, hit.key, hit.value, 'seconds');
    if (seconds < 0) a.bad(`"seconds" must not be negative, got ${seconds}`);
    return { action: 'wait', seconds };
  },

  // The http/https restriction is NOT applied here. It lives in cdp.navigate so
  // that every path to a navigation — model, manual box, future caller — passes
  // through the same check instead of trusting the parser to have run.
  goto: (a) => ({ action: 'goto', url: readText(a, ['url', 'href', 'link', 'address'], 'url') }),

  go_back: nullary('go_back'),
  go_forward: nullary('go_forward'),

  finished: (a) => {
    const action = { action: 'finished' };
    // `message` is what send_msg_to_user carries; the rest are spellings seen
    // or one keystroke away from one.
    const hit = a.pick('answer', 'message', 'msg', 'result', 'content', 'text', 'output');
    if (hit) {
      if (hit.key !== 'answer') a.note(`answer arrived as ${q(hit.key)}; the schema declares "answer"`);
      action.answer = typeof hit.value === 'string' ? hit.value : show(hit.value);
      // The answer IS the user-facing output; the run loop already renders
      // `output` into the log and the on-page caption.
      action.output = action.answer;
    }
    return action;
  },

  fail: nullary('fail'),
  unknown: nullary('unknown'),

  new_tab: nullary('new_tab'),
  close_tab: nullary('close_tab'),

  // The index is the one in the observation's `Available tabs:` list, so it is
  // read as a plain integer and bounded by the executor, which is the only
  // place that knows how many tabs are open.
  switch_tab: (a) => {
    const hit = a.pick('index', 'tab_index', 'tab', 'i');
    if (!hit) a.bad('needs "index", the 0-based position in the observation tab list');
    if (hit.key !== 'index') a.note(`tab index arrived as ${q(hit.key)}; the schema declares "index"`);
    const index = num(a, hit.key, hit.value, 'index');
    if (!Number.isInteger(index) || index < 0) a.bad(`"index" must be a whole number 0 or greater, got ${show(hit.value)}`);
    return { action: 'switch_tab', index };
  },

  // `EXIT` is the wire name; `exit` is the canonical action name in actions.js.
  EXIT: nullary('exit'),

  // A file name ("puppy.jpg") or path as the model gives it. Resolving it to a
  // real file is src/fileTransfer.js's job, at execution time.
  upload: (a) => ({ action: 'upload', path: readText(a, ['path', 'file', 'filename', 'file_path', 'name'], 'path') }),
});

/* ------------------------------------------------------------------ */
/* Reading the reply                                                   */
/* ------------------------------------------------------------------ */

/**
 * Split the reasoning off the front.
 *
 * The template emits `<think>` as part of the prompt, so the model's first
 * token continues inside it and the reply carries the CLOSING tag only. A
 * model that writes its own `<think>` too is handled by stripping it.
 */
function splitReasoning(text) {
  let think = null;
  let body = text;

  const close = text.indexOf(THINK_CLOSE);
  if (close !== -1) {
    think = text.slice(0, close);
    body = text.slice(close + THINK_CLOSE.length);
  } else {
    // No closing tag. If the model opened one and then wrote the call anyway,
    // the text between is still the thought; otherwise there is no thought.
    const open = text.indexOf('<think>');
    const call = text.indexOf(TOOL_OPEN);
    if (open !== -1 && call > open) {
      think = text.slice(open, call);
      body = text.slice(call);
    }
  }

  if (think !== null) {
    think = think.replace(/^\s*<think>/, '').trim() || null;
  }
  return { think, body };
}

/** The known malformed shape: `"x": 856, 38` — an array that lost its brackets. */
const LOST_BRACKET = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*(?=[,}])/g;

function parseCallJson(raw, log, hint = '') {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch (err) {
    // Only ever attempted on text that is ALREADY not JSON, so it cannot
    // reinterpret a well-formed object: `{"a": 1, "b": 2}` has a key between
    // the two numbers and never matches anyway.
    const repaired = text.replace(LOST_BRACKET, '"$1": [$2, $3]');
    if (repaired !== text) {
      try {
        const value = JSON.parse(repaired);
        log.note(
          `the reply was not valid JSON — an array had lost its brackets. ` +
          `Rewrote ${show(preview(text, 120))} as ${show(preview(repaired, 120))}`
        );
        return value;
      } catch (_) {
        // fall through to the original error, which describes the real problem
      }
    }
    throw new Error(
      `The <tool_call> block is not valid JSON (${err.message}). ` +
      `Expected {"name": "click", "arguments": {"point_2d": [500, 433]}}.${hint} Got: ${preview(text, 300)}`
    );
  }
}

/**
 * A balanced `{…}` starting at or after `from`.
 *
 * WHY A SCANNER AND NOT indexOf('</tool_call>'): a `finished` answer is
 * free-form prose that may contain `</tool_call>`, a `{`, or the whole
 * example call quoted back at us. The scanner tracks JSON string state, so
 * markup inside a value is never mistaken for structure — and the search for
 * the *next* call resumes past the object, not past a bracket inside it.
 */
function findObject(body, from = 0) {
  const start = body.indexOf('{', from);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const c = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { text: body.slice(start, i + 1), start, end: i + 1 };
    }
  }
  return null;
}

/** Every `<tool_call>` block in the body, as the JSON text inside it. */
function findBlocks(body, log) {
  const blocks = [];
  let i = 0;
  for (;;) {
    const start = body.indexOf(TOOL_OPEN, i);
    if (start === -1) break;
    const from = start + TOOL_OPEN.length;

    const obj = findObject(body, from);
    if (obj && body.slice(from, obj.start).trim()) {
      // A `[` from a tool_calls array, a stray word, a second opening tag.
      // Reading past it is a repair, so it is announced like any other.
      log.note(
        `${show(preview(body.slice(from, obj.start), 60))} sat between <tool_call> and the JSON object; ` +
        'read the object and ignored it'
      );
    }
    if (!obj) {
      // Nothing object-shaped inside: hand the raw text to the JSON parser,
      // whose error message names what was actually found.
      const close = body.indexOf(TOOL_CLOSE, from);
      blocks.push(body.slice(from, close === -1 ? undefined : close));
      i = close === -1 ? body.length : close + TOOL_CLOSE.length;
      continue;
    }

    blocks.push(obj.text);
    const close = body.indexOf(TOOL_CLOSE, obj.end);
    if (close === -1) {
      // Truncated by max_tokens, most likely. Keeping the object that is
      // there is only a repair if it parses, and parseCallJson decides that.
      log.note('the reply had no closing </tool_call> — read the JSON object that was there (max_tokens?)');
      i = body.length;
    } else {
      i = close + TOOL_CLOSE.length;
    }
  }
  return blocks;
}

/** What a reply in the OTHER checkpoint's format looks like, for the error. */
function diagnoseWrongFormat(text) {
  if (text.includes('<function=')) {
    return ' That looks like the `<function=click><parameter=x>` XML of the ' +
      'an older model, not this one\'s format. Check which model the server is serving.';
  }
  if (/begin_of_box|<action>|\bclick\('/.test(text)) {
    return ' That looks like the checkpoint\'s native `<action>click(\'21\')</action>` output, which it falls ' +
      'back to when it is not given tools — check that "Send the tool schema" is ticked and that the system ' +
      'prompt box is empty.';
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Parse one model reply into a canonical action object (see src/actions.js).
 *
 * The reasoning block, when present, is returned as `action.think` — the
 * sentence a demo audience reads — kept separate from `output`, because
 * `finished.answer` is the result and the thought is not. Anything that had to
 * be repaired on the way is returned as `action.repairs`, a list of sentences
 * the run loop logs at `warn`.
 *
 * @param {string} text the raw `choices[0].message.content`
 * @returns {object} a canonical action, plus `tool` (the wire name that was
 *                   called) and optional `think` and `repairs`
 * @throws {Error} on no tool call, more than one tool call, JSON it cannot
 *                 repair, an unknown tool name, or a parameter it cannot read.
 *                 It never guesses and never returns a fallback action.
 */
export function parseModelSyntax(text) {
  if (typeof text !== 'string') {
    throw new Error(`Model output must be a string, got ${typeof text}.`);
  }

  const log = repairLog();
  const { think, body } = splitReasoning(text);

  let blocks = findBlocks(body, log);
  if (blocks.length > 1) {
    throw new Error(
      `The model emitted ${blocks.length} <tool_call> blocks in one reply. Executing one of them would be a ` +
      'guess about which screen the others were aimed at, so the step is refused. ' +
      `Got: ${preview(text, 300)}`
    );
  }
  if (!blocks.length) {
    // No wrapper. A bare {"name": …, "arguments": …} is still unambiguous.
    const bare = findObject(body);
    if (bare && /"name"\s*:/.test(bare.text)) {
      log.note('the reply had no <tool_call> wrapper — read the bare JSON object instead');
      blocks = [bare.text];
    } else {
      throw new Error(
        'No <tool_call> block in the model\'s reply. Expected ' +
        '"<tool_call>\\n{\\"name\\": \\"click\\", \\"arguments\\": {\\"point_2d\\": [500, 433]}}\\n</tool_call>".' +
        `${diagnoseWrongFormat(text)} Got: ${preview(text, 300)}`
      );
    }
  }

  const call = parseCallJson(blocks[0], log, diagnoseWrongFormat(text));
  if (!call || typeof call !== 'object' || Array.isArray(call)) {
    throw new Error(`The <tool_call> block must be a JSON object, got ${show(call)}.`);
  }

  // vLLM with auto tool choice enabled would nest the call under `function`.
  // Accepting it costs one line and saves a confusing failure the day the
  // server is restarted with --enable-auto-tool-choice.
  let envelope = call;
  if (envelope.name === undefined && envelope.function && typeof envelope.function === 'object') {
    log.note('the call was nested under "function" — unwrapped it');
    envelope = envelope.function;
  }

  let name = envelope.name;
  if (typeof name !== 'string' || !name) {
    throw new Error(`The <tool_call> block has no "name". Got: ${show(call)}`);
  }

  if (!SCHEMA.has(name)) {
    // hasOwnProperty, not `TOOL_ALIASES[name]`: a model that emits
    // "constructor" or "toString" must get the unknown-tool error, not
    // Object.prototype.
    const alias = Object.prototype.hasOwnProperty.call(TOOL_ALIASES, name) ? TOOL_ALIASES[name] : undefined;
    if (!alias) {
      throw new Error(
        `Unknown tool name ${q(name)}. The schema declares ${ACTION_NAMES.length}: ${ACTION_NAMES.join(', ')}` +
        `${Object.keys(TOOL_ALIASES).length ? `, plus the known aliases ${Object.keys(TOOL_ALIASES).join(', ')}` : ''}. ` +
        `This checkpoint has a native tool vocabulary of its own and sometimes reaches for it, so the whole call ` +
        `is printed here rather than guessed at — add it to TOOL_ALIASES in src/modelSpec.js if it is real: ${show(call)}`
      );
    }
    log.note(`tool name ${q(name)} is not in the schema; it is a known alias of ${q(alias)}, so it was accepted`);
    name = alias;
  }

  let rawArgs = envelope.arguments !== undefined ? envelope.arguments : envelope.parameters;
  if (rawArgs === undefined) rawArgs = envelope.args;
  if (typeof rawArgs === 'string') {
    // The OpenAI tool_calls envelope serializes arguments as a JSON string.
    const inner = parseCallJson(rawArgs, log);
    log.note('"arguments" arrived as a JSON string rather than an object');
    rawArgs = inner;
  }
  if (rawArgs === undefined || rawArgs === null) rawArgs = {};
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throw new Error(`${name}: "arguments" must be a JSON object, got ${show(rawArgs)}.`);
  }

  const a = new Args(name, rawArgs, log);
  const action = BUILDERS[name](a);

  // Undeclared arguments are DROPPED, not fatal. The measured `press_keys`
  // call carries `is_hotkey`, which our executor has no use for either way;
  // refusing the step over it would turn a cosmetic drift into a broken run.
  const extra = a.leftovers();
  if (extra.length) {
    log.note(
      `${name}: ignored argument${extra.length > 1 ? 's' : ''} ${extra.map(q).join(', ')} — ` +
      `the schema declares ${SCHEMA.get(name).properties.join(', ') || 'none'}`
    );
  }

  // The WIRE name, after alias resolution, kept beside the canonical one: the
  // result turn answers each step with "Succeed: `{tool}` executed.", and
  // the canonical name is not always the tool's (EXIT is executed as `exit`).
  action.tool = name;
  if (think) action.think = think;
  if (log.list.length) action.repairs = log.list;
  return action;
}
