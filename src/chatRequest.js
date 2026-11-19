/**
 * chatRequest.js — what a rejected reply is answered with.
 *
 * The request body itself is built by src/modelProfile.js (the gui22
 * transcript). This module keeps the correction turn, which the run loop and
 * the tests share.
 *
 * `tool_choice` IS A SETTING, AND IT HAS TO BE, because the two servers this
 * runs against disagree about what it means.
 *
 *   vLLM, started without `--enable-auto-tool-choice`
 *     "auto" -> HTTP 400. "none" -> 200, and the schema is STILL rendered into
 *     the prompt, which is the whole point of sending `tools`. vLLM then never
 *     populates `message.tool_calls`, so the call arrives as text in
 *     `message.content` — which is what src/modelProfile.js reads.
 *
 *   vllm-mlx (Apple Silicon)
 *     The opposite. "none" makes it DROP the schema silently: measured, the
 *     same request with two tools came to 9 prompt tokens under "none" and 243
 *     under "auto" — 9 being exactly what sending no tools at all costs. Its
 *     server.py gates the template on `tool_choice != "none"`. So MLX needs
 *     "auto", and then the call arrives in `message.tool_calls` instead; see
 *     the reconstruction in sidepanel.js's callOpenAiModel.
 *
 * The panel's default is "auto" (vllm-mlx on a Mac); pick "none" for vLLM.
 * See toolChoiceOf in
 * src/modelProfile.js.
 */

/**
 * What a rejected reply is answered with, in the XML syntax the parser reads.
 *
 * Both failures seen in real runs happen at the same moment: the model has the
 * answer and wants to hand it over, so it writes prose — or reaches for
 * send_msg_to_user — instead of calling a tool. So the correction names
 * finished(answer) explicitly rather than only repeating "emit a tool call".
 */
export const CORRECTION_XML =
  'Your last reply contained no readable <tool_call> block, so no action could be taken. ' +
  'Reply with exactly one tool call and nothing else, in the form ' +
  '<tool_call><function=NAME><parameter=ARG>VALUE</parameter></function></tool_call>. ' +
  'Pointer arguments x and y are separate numbers. ' +
  'If the task is already complete, call finished with your answer as the "answer" argument. ' +
  'If it cannot be completed, call fail.';

/** The correction turn. There is one reply syntax, so there is one correction. */
export const correctionFor = () => CORRECTION_XML;
