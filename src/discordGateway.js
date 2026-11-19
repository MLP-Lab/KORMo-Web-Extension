/**
 * discordGateway.js — the bot's live connection, so no channel id is needed.
 *
 * WHY THIS REPLACED POLLING. The REST reader had to be told WHICH channel to
 * read, and a channel id is not something a person has: it exists only after
 * you turn on 개발자 모드, right-click the channel and pick 아이디 복사. That
 * was two of the eleven setup steps, and the step most often got wrong — a
 * server id reads as a valid snowflake and answers 404, a channel NAME answers
 * 400, and neither says which of the two you typed.
 *
 * The gateway is pushed, not asked. Discord sends MESSAGE_CREATE for every
 * channel the bot can see, each one carrying its own `channel_id`, so the
 * answer goes back where the question was asked and nobody types an id at all.
 *
 * THE EARLIER COMMENT IN src/discord.js ARGUED AGAINST THIS, and on its own
 * terms it was right: a few hundred lines to shave two seconds off a command
 * that then takes a minute to carry out is a bad trade. That weighed latency.
 * This buys the two worst steps of the setup, and the instant reply is change
 * left over.
 *
 * NO DEPENDENCY. `WebSocket` is global from Node 22. The repo still has no
 * package.json, and `WebSocketImpl` is injected so the tests drive a stub.
 */

/** v10, JSON. Compression would need a zlib stream for one small saving. */
export const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

/**
 * GUILDS, GUILD_MESSAGES and MESSAGE_CONTENT.
 *
 * MESSAGE_CONTENT (1 << 15) is PRIVILEGED. Without it Discord still delivers
 * every message — with `content` as an empty string, so every command looks
 * like a mention of nothing and is silently dropped. That is the failure this
 * repo already hit once from the REST side, and the relay now checks the flag
 * at startup rather than letting it present as "connected, ignores me".
 */
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

const OP = {
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6,
  RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11,
};

/** Close codes Discord uses for "this will never work, stop retrying". */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export const FATAL_CLOSE_REASON = {
  4004: '토큰이 올바르지 않습니다.',
  4010: '샤드 설정이 잘못되었습니다.',
  4011: '봇이 너무 많은 서버에 있어 샤딩이 필요합니다.',
  4012: '게이트웨이 버전이 올바르지 않습니다.',
  4013: 'intent 값이 올바르지 않습니다.',
  4014: 'MESSAGE CONTENT INTENT가 꺼져 있습니다 — 개발자 포털에서 켜세요.',
};

/**
 * One live connection, with heartbeats, resume and reconnect.
 *
 * @param {object} o
 * @param {string} o.token          the bot token
 * @param {(m: object) => void} o.onMessage    every MESSAGE_CREATE, unfiltered
 * @param {(g: object) => void} [o.onGuild]    every GUILD_CREATE
 * @param {(s: string, d?: object) => void} [o.onStatus]  'ready' | 'closed' | …
 * @param {Function} [o.WebSocketImpl]
 * @param {(attempt: number) => number} [o.backoffMs]
 */
export function createGateway({
  token, onMessage, onGuild = () => {}, onStatus = () => {},
  WebSocketImpl = globalThis.WebSocket,
  backoffMs = (attempt) => Math.min(30000, 1000 * 2 ** attempt),
  setTimer = setTimeout, clearTimer = clearTimeout,
  // Injected so the heartbeat test drives a clock instead of a dice roll.
  random = Math.random,
}) {
  let ws = null;
  let seq = null;
  let sessionId = null;
  let resumeUrl = null;
  let beat = null;
  let waiting = null;
  let acked = true;
  let attempt = 0;
  let stopped = false;
  let fatal = null;

  const send = (op, d) => {
    try { ws.send(JSON.stringify({ op, d })); } catch (_) { /* the close handler retries */ }
  };

  const stopBeating = () => { clearTimer(beat); beat = null; };

  function startBeating(interval) {
    stopBeating();
    acked = true;
    const tick = () => {
      // A heartbeat that was never acknowledged means the socket is a zombie:
      // it is open, and nothing is coming through it. Discord's own guidance
      // is to close it and resume rather than keep beating into the dark.
      if (!acked) { close(4000); return; }
      acked = false;
      send(OP.HEARTBEAT, seq);
      beat = setTimer(tick, interval);
    };
    // The first beat is jittered, as the docs ask, so a fleet of bots
    // reconnecting after an outage does not land on the same millisecond.
    beat = setTimer(tick, Math.floor(interval * random()));
  }

  const close = (code = 1000) => {
    try { ws.close(code); } catch (_) { /* already gone */ }
  };

  function identify() {
    send(OP.IDENTIFY, {
      token,
      intents: INTENTS,
      properties: { os: process.platform, browser: 'gui-agent-relay', device: 'gui-agent-relay' },
    });
  }

  function handle(frame) {
    if (frame.s !== null && frame.s !== undefined) seq = frame.s;
    switch (frame.op) {
      case OP.HELLO:
        startBeating(frame.d.heartbeat_interval);
        // RESUME replays what was missed while the socket was down; IDENTIFY
        // starts over and re-sends every GUILD_CREATE.
        if (sessionId && seq !== null) send(OP.RESUME, { token, session_id: sessionId, seq });
        else identify();
        return;
      case OP.HEARTBEAT:
        // Discord may ask for one out of band.
        acked = false;
        send(OP.HEARTBEAT, seq);
        return;
      case OP.HEARTBEAT_ACK:
        acked = true;
        return;
      case OP.RECONNECT:
        close(4000);
        return;
      case OP.INVALID_SESSION:
        // `d` is whether the session may be resumed. False means start clean.
        if (!frame.d) { sessionId = null; seq = null; }
        close(4000);
        return;
      case OP.DISPATCH:
        if (frame.t === 'READY') {
          sessionId = frame.d.session_id;
          resumeUrl = frame.d.resume_gateway_url || null;
          attempt = 0;
          onStatus('ready', frame.d.user || {});
        } else if (frame.t === 'RESUMED') {
          attempt = 0;
          onStatus('resumed');
        } else if (frame.t === 'GUILD_CREATE') {
          onGuild(frame.d);
        } else if (frame.t === 'MESSAGE_CREATE') {
          onMessage(frame.d);
        }
        return;
      default:
    }
  }

  function open() {
    if (stopped) return;
    // resume_gateway_url is where Discord wants a resume to land; a fresh
    // IDENTIFY goes to the front door.
    const url = sessionId && resumeUrl ? `${resumeUrl}/?v=10&encoding=json` : GATEWAY_URL;
    ws = new WebSocketImpl(url);

    ws.onmessage = (event) => {
      let frame;
      try { frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); }
      catch (_) { return; }
      handle(frame);
    };
    ws.onerror = () => { /* onclose always follows, and carries the code */ };
    ws.onclose = (event) => {
      stopBeating();
      const code = event && event.code;
      if (FATAL_CLOSE.has(code)) {
        fatal = FATAL_CLOSE_REASON[code] || `게이트웨이가 ${code} 코드로 연결을 거부했습니다.`;
        stopped = true;
        onStatus('fatal', { code, reason: fatal });
        return;
      }
      if (stopped) { onStatus('closed', { code }); return; }
      // 1000 and 1001 are clean closes that cannot be resumed.
      if (code === 1000 || code === 1001) { sessionId = null; seq = null; }
      const wait = backoffMs(attempt);
      attempt += 1;
      onStatus('reconnecting', { code, wait });
      waiting = setTimer(open, wait);
    };
  }

  return {
    start() { stopped = false; open(); },
    stop() {
      stopped = true;
      stopBeating();
      clearTimer(waiting);
      close(1000);
    },
    get sessionId() { return sessionId; },
    get fatal() { return fatal; },
  };
}
