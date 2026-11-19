/**
 * modelSpec.js — the parser's internal tool table.
 *
 * NOTHING HERE IS SENT TO THE MODEL. The schema the model is given is
 * GUI22_TOOLS in src/modelProfile.js (pinned to the training tool list), which
 * writes a point as separate `x`/`y`. parseProfileReply reads that XML
 * strictly against GUI22_TOOLS, folds `x`/`y` into one `point_2d` array, and
 * hands the call to src/modelSyntax.js, whose canonical-action builders are
 * keyed on the names and parameter names below. So this table is the shape
 * modelSyntax.js reads — a point is ONE array — not a schema any checkpoint
 * was trained on.
 *
 * The array shape is history: an early model answered JSON with `point_2d`,
 * and modelSyntax.js was written against it. It stays because the conversion
 * is tolerant.
 *
 * No browser APIs here, so `node` can import it.
 */

/** A normalized point, the only shape this checkpoint will emit for one. */
const point = (description) => ({
  type: 'array',
  items: { type: 'number', minimum: 0, maximum: 1000 },
  minItems: 2,
  maxItems: 2,
  description: `${description} as [x, y], normalized 0-1000 against the screenshot, (0,0) top-left.`,
});

/** A tool that takes exactly one point. */
const pointTool = (name, description) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { point_2d: point('Target point') },
      required: ['point_2d'],
    },
  },
});

/** A tool that takes nothing. */
const nullaryTool = (name, description) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties: {}, required: [] },
  },
});

/**
 * The 18 original tools, in the array-point shape.
 *
 * `additionalProperties: false` is deliberately NOT set. The model emits
 * arguments we never declared — `{"name": "press_keys", "arguments": {"keys":
 * ["Enter"], "is_hotkey": false}}` is a measured reply — and refusing the
 * whole step over an extra flag we would have ignored anyway is a worse
 * outcome than dropping it with a warning. src/modelSyntax.js does the
 * dropping, and says so in the log.
 */
export const TOOL_SCHEMA = [
  pointTool('click', 'Left-click the element at the point.'),
  pointTool('double_click', 'Double-click the element at the point.'),
  pointTool('right_click', 'Right-click the element at the point.'),
  pointTool('hover', 'Move the pointer over the point without clicking.'),
  pointTool('focus', 'Put keyboard focus on the element at the point.'),
  pointTool('clear', 'Clear the text field at the point.'),
  {
    type: 'function',
    function: {
      name: 'drag',
      description: 'Press at one point, move, and release at another.',
      parameters: {
        type: 'object',
        properties: {
          start_point_2d: point('Where the drag starts'),
          end_point_2d: point('Where the drag ends'),
        },
        required: ['start_point_2d', 'end_point_2d'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type',
      description: 'Type literal text into the focused input.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The text to type.' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hotkey',
      description: 'Press the listed keys together, e.g. ["Enter"] or ["ctrl", "a"].',
      parameters: {
        type: 'object',
        properties: {
          keys: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Key names pressed together.' },
        },
        required: ['keys'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll the page by signed PIXEL deltas. These are not normalized coordinates.',
      parameters: {
        type: 'object',
        properties: {
          scroll_dy: { type: 'number', description: 'Signed pixels; positive scrolls down.' },
          scroll_dx: { type: 'number', description: 'Signed pixels; positive scrolls right.' },
        },
        required: ['scroll_dy'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Wait for the interface to settle.',
      parameters: {
        type: 'object',
        properties: { seconds: { type: 'number', minimum: 0, description: 'How long to wait.' } },
        required: ['seconds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'goto',
      description: 'Navigate to a URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'An http or https URL.' } },
        required: ['url'],
      },
    },
  },
  nullaryTool('go_back', 'Go back in browser history.'),
  nullaryTool('go_forward', 'Go forward in browser history.'),
  {
    type: 'function',
    function: {
      name: 'finished',
      description: 'The task is complete. Give the answer to the user request.',
      parameters: {
        type: 'object',
        properties: { answer: { type: 'string', description: 'The answer to the user request.' } },
        // Not required: a measured `finished` sometimes carries no answer, and
        // throwing away a successful run over a missing sentence is absurd.
        required: [],
      },
    },
  },
  nullaryTool('fail', 'The task cannot be completed.'),
  nullaryTool('unknown', 'No reliable action can be determined from this screen.'),
  nullaryTool('EXIT', 'End the episode. The name is uppercase.'),
];

/** Every function name the schema declares, in schema order. */
export const TOOL_NAMES = Object.freeze(TOOL_SCHEMA.map((t) => t.function.name));

/**
 * The tab tools. `switch_tab`'s index is the position in the observation's
 * `Available tabs:` list, which is why it is an integer with no upper bound
 * here — the bound is how many tabs are open, and only the executor knows that.
 */
export const TAB_TOOL_SCHEMA = [
  nullaryTool('new_tab', 'Open a new blank browser tab.'),
  {
    type: 'function',
    function: {
      name: 'switch_tab',
      description: 'Switch to the browser tab at the given 0-based index.',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer', minimum: 0, description: '0-based index in the observation tab list.' },
        },
        required: ['index'],
      },
    },
  },
  nullaryTool('close_tab', 'Close the current browser tab.'),
];

/**
 * `upload` — attach a local file to the file picker the page opened. The model
 * gives a name such as "puppy.jpg"; src/fileTransfer.js resolves it.
 */
export const UPLOAD_TOOL_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'upload',
      description: 'Attach a local file to the file picker the page has opened.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File name or path as the user gave it.' } },
        required: ['path'],
      },
    },
  },
];

/** Every tool name the parser accepts. */
export const PARSEABLE_TOOLS = Object.freeze([...TOOL_SCHEMA, ...TAB_TOOL_SCHEMA, ...UPLOAD_TOOL_SCHEMA]);

/** Every name PARSEABLE_TOOLS declares, in schema order. */
export const PARSEABLE_NAMES = Object.freeze(PARSEABLE_TOOLS.map((t) => t.function.name));

/**
 * Tool names the model emits that are NOT in the schema, and what they mean.
 *
 * Measured: with `click` removed from the tool list the model emitted `click`
 * anyway, and asked to press Enter it produced
 * `{"name": "press_keys", "arguments": {"keys": ["Enter"], "is_hotkey": false}}`.
 * `press_keys` was never in any schema sent to it. That is the checkpoint's own
 * native vocabulary leaking through (measured on an early model). The
 * gui22 XML reader refuses names outside GUI22_TOOLS before they get here, so
 * these only matter to modelSyntax.js's own callers.
 *
 * An alias is accepted and logged at `warn`, never silently: the point is that
 * drift stays visible. A name that is neither a tool nor an alias throws.
 */
export const TOOL_ALIASES = Object.freeze({
  press_keys: 'hotkey',
  // Measured on a live run: with the task complete the model reached for
  // send_msg_to_user, which this schema does not offer. Having no tool for
  // "tell the user" it left tool-calling altogether and fell back to its native
  // <action> syntax — in Vietnamese. In the BrowserGym action space this
  // checkpoint clearly also knows, send_msg_to_user IS the terminal answer, so
  // it maps to finished and its message becomes the answer.
  send_msg_to_user: 'finished',
  send_message_to_user: 'finished',
  answer: 'finished',
});
