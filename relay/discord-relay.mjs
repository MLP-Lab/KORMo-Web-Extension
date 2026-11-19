/**
 * discord-relay.mjs — the panel cannot call Discord, so this does it.
 *
 *     node relay/discord-relay.mjs
 *
 * FIRST RUN ASKS FOR THE TOKEN AND NOTHING ELSE. It then checks the account,
 * checks the one privileged switch that silently breaks everything, prints the
 * invite link, and writes .discord.local.json itself. There is no channel id
 * and no user id to look up, because the gateway delivers every channel the
 * bot can see and the answer goes back where the question was asked.
 *
 * WHAT IT REPLACED. The setup used to be eleven steps, five of them spent in
 * 개발자 모드 copying a channel id and a user id into a JSON file by hand —
 * the step most often got wrong, because a server id reads as a valid
 * snowflake and answers 404 while a channel NAME answers 400, and neither says
 * which of the two you typed.
 *
 * MEASURED, and the reason this process exists at all. Discord's edge refuses
 * a request that looks like it came from a browser: the same read that answers
 * 200 from Node answers `403 internal network error` once a browser
 * User-Agent and the Sec-Fetch-* headers are attached. That is a deliberate
 * protection — a bot token in a web page is a bot token anyone can take — so
 * it is worked WITH, not around. The token never reaches the browser.
 *
 * HTTP TOWARD THE PANEL, a WebSocket toward Discord. The panel asks this
 * process for whatever has arrived; over loopback that poll costs nothing, and
 * it keeps the panel's half dependency-free. The socket is on this side
 * because that is where the token is.
 *
 * 127.0.0.1 ONLY. Anything that can reach this port can drive the browser; it
 * must not be reachable from the network.
 */
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  createDiscordRest, isCommand, commandFrom, inviteUrl, hasMessageContent,
} from '../src/discord.js';
import { createGateway } from '../src/discordGateway.js';

// `WebSocket` is global from Node 22, and the gateway is the whole point of
// this process. Without the guard it fails as "WebSocketImpl is not a
// constructor" deep inside a reconnect, which names nothing a person can act
// on — and an old Node is the likeliest thing wrong on a machine that has
// never run this.
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 22) {
  console.error(`Node 22 이상이 필요합니다. 지금은 ${process.versions.node} 입니다.`);
  console.error('  디스코드 게이트웨이가 Node 22부터 기본 제공되는 WebSocket 을 씁니다.');
  console.error('  https://nodejs.org 에서 LTS 를 설치하거나, nvm 을 쓴다면: nvm install --lts');
  process.exit(1);
}

const PORT = Number(process.env.RELAY_PORT || 8765);
const FILE = new URL('../.discord.local.json', import.meta.url);

/** How many commands are kept for a panel that was opened late. */
const BUFFER = 50;

const say = (line = '') => console.log(line);

// ── 1. the token ────────────────────────────────────────────────────────────

function readConfig() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return {}; }
}

function writeConfig(conf) {
  // 0600: the file holds a bot token, and this is the one moment we control
  // its permissions. It is already gitignored.
  fs.writeFileSync(FILE, `${JSON.stringify(conf, null, 2)}\n`, { mode: 0o600 });
}

async function askForToken(first) {
  if (first) {
    say('봇 토큰이 없습니다. 처음이라면 이렇게 하세요:');
    say('');
    say('  1. https://discord.com/developers/applications → 신규 어플리케이션');
    say('  2. 왼쪽 봇 탭 → 토큰 초기화 → 복사');
    say('  3. 같은 화면에서 메시지 콘텐츠 인텐트(MESSAGE CONTENT INTENT)를 켜고 저장');
    say('');
    // The same page shows a permission calculator, and leaving it alone is the
    // right answer: the invite link printed after the token already carries
    // View Channels, Send Messages and Read Message History. Saying so here is
    // cheaper than the run where a bot joins with nothing ticked and goes
    // quiet, which looks exactly like a wrong token.
    say('  아래 "봇 권한"은 체크하지 않아도 됩니다. 토큰을 넣으면 필요한 권한이');
    say('  담긴 초대 링크를 이 창에 출력합니다.');
    say('');
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question('봇 토큰을 붙여넣으세요: ');
  rl.close();
  say('');
  return String(answer || '').trim();
}

/**
 * A token that WORKS, and only then a file.
 *
 * THE ORDER IS THE POINT. The first version asked, saved, and then checked —
 * so one dropped character while pasting left a bad token on disk and the
 * advice "edit .discord.local.json and delete the token line", which is the
 * hand-editing of a dotfile this whole flow exists to remove. Nothing is
 * written until Discord has answered to it.
 *
 * A STORED token that stopped working is not kept either: a reset token is
 * the ordinary reason, and the fix is to paste the new one, not to go find
 * the file.
 */
async function resolveToken(conf) {
  const ATTEMPTS = 3;
  let token = String(conf.token || '').trim();
  let typed = false;

  for (let tries = 0; tries < ATTEMPTS; tries += 1) {
    if (!token) {
      if (!stdin.isTTY) {
        console.error('봇 토큰이 없습니다. 터미널에서 직접 실행하면 토큰을 물어봅니다.');
        process.exit(1);
      }
      token = await askForToken(tries === 0 && !typed);
      typed = true;
      if (!token) {
        console.error('토큰이 비어 있습니다.');
        process.exit(1);
      }
    }

    const rest = createDiscordRest({ token });
    try {
      const me = await rest.me();
      // Verified. NOW it is worth keeping.
      if (conf.token !== token) {
        writeConfig({ ...conf, token });
        say('토큰을 .discord.local.json 에 저장했습니다 (커밋되지 않습니다).');
        say('');
      }
      // The caller reads conf.token to open the gateway. Writing the file is
      // not enough: on a first run conf came back empty, so without this the
      // gateway was handed undefined, Discord closed with 4004, and 4004 is
      // fatal rather than retried — the relay had to be restarted to work.
      conf.token = token;
      return { rest, me };
    } catch (err) {
      say(`토큰을 확인하지 못했습니다 — ${err.message}`);
      say(/401/.test(err.message)
        ? '  토큰이 틀렸거나 재발급되었습니다. 개발자 포털 → Bot → Reset Token 으로 새로 받으세요.'
        : '  네트워크나 디스코드 쪽 문제일 수 있습니다.');
      say('');
      token = '';
      if (!stdin.isTTY) process.exit(1);
    }
  }
  console.error(`${ATTEMPTS}번 모두 실패했습니다.`);
  return process.exit(1);
}

const conf = readConfig();

// ── 2. the checks that would otherwise present as "it ignores me" ───────────

const { rest, me } = await resolveToken(conf);

let intentOn = true;
try {
  intentOn = hasMessageContent((await rest.application()).flags);
} catch (_) {
  // Not fatal: an older token scope may not reach /applications/@me, and the
  // gateway refuses with close code 4014 if the intent really is off.
}

say(`봇: ${me.username} (${me.id})`);
if (!intentOn) {
  say('');
  say('  ⚠ MESSAGE CONTENT INTENT 가 꺼져 있습니다.');
  say('    이대로면 메시지는 도착하지만 내용이 빈 문자열이라 명령이 전부 무시됩니다.');
  say('    개발자 포털 → Bot → Privileged Gateway Intents → MESSAGE CONTENT INTENT 를 켜세요.');
}
say('');
say('봇을 아직 서버에 초대하지 않았다면 이 링크를 여세요:');
say(`  ${inviteUrl(me.id)}`);
say('');

// ── 3. the live connection ──────────────────────────────────────────────────

/** Commands that have arrived, oldest first. Drained by id, like the REST cursor. */
const inbox = [];
/** guildId → the bot's own roles there, so a role mention can be recognised. */
const roles = new Map();
/** command id → the progress message being rewritten for it. */
const progressOf = new Map();
/** messageId → channelId, so a reply goes back where the question was asked. */
const origin = new Map();
let lastChannel = null;
let status = 'connecting';

/**
 * Nothing at all when the bot is in a server, which is the ordinary case.
 *
 * ONLY THE FAILURE IS WORTH A LINE. An earlier version printed the servers,
 * then a count of them — both of which are noise when everything is fine, and
 * neither of which is anything a reader of a guide can match against their own
 * screen. What a person cannot otherwise discover is the opposite: the bot
 * joined NOTHING, the invite link was never opened or was cancelled, and every
 * mention will land somewhere this process cannot see. That produces no event
 * of its own, so it has to be noticed by its absence.
 */
let guildTimer = null;
function countGuilds() {
  clearTimeout(guildTimer);
  guildTimer = null;
}

// READY arrives before the GUILD_CREATE burst, so the check waits for the
// burst to have had its chance rather than firing between the two.
const NO_GUILD_GRACE_MS = 5000;
function warnIfHomeless() {
  setTimeout(() => {
    if (!roles.size) {
      say('  ⚠ 봇이 아직 어떤 서버에도 들어가 있지 않습니다.');
      say('    위의 초대 링크를 열어 서버를 고르세요. 그 전에는 멘션이 도착하지 않습니다.');
    }
  }, NO_GUILD_GRACE_MS);
}

/** Addressed to us at all — used only to decide whether a drop is worth a word. */
const mentionsUs = (m) => m && !m.author?.bot
  && (((m.mentions || []).some((x) => x.id === me.id))
    || ((m.mention_roles || []).length > 0));

const gateway = createGateway({
  token: conf.token,

  onStatus(what, detail = {}) {
    status = what;
    if (what === 'ready') { say('듣고 있습니다. 채널에서 봇을 멘션하세요.'); warnIfHomeless(); }
    else if (what === 'resumed') say('연결을 복구했습니다.');
    else if (what === 'reconnecting') say(`연결이 끊겨 ${Math.round(detail.wait / 1000)}초 뒤 다시 붙습니다.`);
    else if (what === 'fatal') console.error(`연결이 거부되었습니다 — ${detail.reason}`);
  },

  // GUILD_CREATE arrives for every server right after READY, which is how the
  // role list is built without anyone naming a server.
  //
  // IT IS ALSO THE ONLY CONFIRMATION THE INVITE WORKED. Clicking the link
  // opens Discord, picks a server and says nothing back here, so a relay that
  // joined nothing looks exactly like a relay that joined everything — and the
  // first mention then vanishes with no log line to explain it.
  //
  // A COUNT, NOT NAMES. Whoever runs this named their own server, and that
  // name is neither predictable in a guide nor something to put on screen in
  // a recording. "0개" and "1개" is the whole signal anyone needs.
  async onGuild(guild) {
    try {
      roles.set(guild.id, await rest.rolesIn(guild.id, me.id));
      countGuilds();
    } catch (err) {
      say(`  ⚠ ${guild.name} 에서 봇의 역할을 읽지 못했습니다 — ${err.message}`);
      say('    @봇이름 이 역할 멘션으로 입력되면 그 서버에서는 무시됩니다. 직접 멘션은 됩니다.');
      roles.set(guild.id, []);
      countGuilds();
    }
  },

  onMessage(message) {
    // An optional narrowing, for a server where the bot can see more than it
    // should act on. Absent by default, which is the whole point.
    //
    // SAID OUT LOUD WHEN IT DROPS SOMETHING. A leftover channelId from an
    // earlier setup silently swallowed every mention typed in a new channel,
    // and a filter that discards without a word is indistinguishable from a
    // bot that is not connected at all.
    if (conf.channelId && message.channel_id !== conf.channelId) {
      if (mentionsUs(message)) {
        say(`  ⚠ 다른 채널(${message.channel_id})의 멘션을 무시했습니다 — `
          + `.discord.local.json 의 "channelId" 가 ${conf.channelId} 로 고정돼 있습니다.`);
        say('    모든 채널에서 받으려면 그 줄을 지우고 릴레이를 다시 띄우세요.');
      }
      return;
    }
    if (conf.userId && message.author?.id !== conf.userId && mentionsUs(message)) {
      say(`  ⚠ ${message.author?.username} 의 멘션을 무시했습니다 — `
        + `.discord.local.json 의 "userId" 가 ${conf.userId} 로 고정돼 있습니다.`);
      say('    누구나 명령하게 하려면 그 줄을 지우고 릴레이를 다시 띄우세요.');
      return;
    }
    if (!isCommand(message, me.id, roles.get(message.guild_id) || [], conf.userId)) return;
    const command = commandFrom(message, me.id);
    if (!command.task) return;
    inbox.push(command);
    while (inbox.length > BUFFER) origin.delete(inbox.shift().id);
    origin.set(command.id, command.channelId);
    lastChannel = command.channelId;
    say(`← ${command.author}: ${command.task}`);
  },
});

gateway.start();

// ── 4. what the panel asks for ──────────────────────────────────────────────

/**
 * Whose requests are answered.
 *
 * Loopback is not a wall. Every page the browser is showing can reach
 * 127.0.0.1, so `Access-Control-Allow-Origin: *` let any site the user
 * happened to visit read /commands, which carries what was typed in the
 * channel and who typed it, and POST /say, which makes the bot speak. An
 * extension page's Origin is `chrome-extension://<id>` and a web page cannot
 * forge one, so that prefix is the whole check.
 *
 * A request with no Origin at all is left alone: that is curl at the terminal,
 * which cannot be a page acting on the user's behalf.
 */
const panelOrigin = (origin) => (
  typeof origin === 'string' && origin.startsWith('chrome-extension://') ? origin : null
);

const json = (res, code, body, origin) => {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  const allowed = panelOrigin(origin);
  if (allowed) {
    headers['Access-Control-Allow-Origin'] = allowed;
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers.Vary = 'Origin';
  }
  res.writeHead(code, headers);
  res.end(JSON.stringify(body));
};

/**
 * The cursor a panel starts from. "0" when nothing has arrived yet.
 *
 * NOT null. The panel asks /newest the moment it is enabled and hands that
 * value straight back to /commands, so a null cursor meant the FIRST command
 * ever typed was counted as already seen and silently dropped — the one path
 * every new setup takes. A snowflake is never 0, so "0" reads as "nothing yet"
 * and lets the next message through, while a real id still skips whatever was
 * typed before the panel was listening.
 */
const newestId = () => (inbox.length ? inbox[inbox.length - 1].id : '0');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // NOT `origin`: that is the module-level Map of messageId → channelId, and
  // a request-scoped `const origin` shadowed it for the whole handler. Every
  // reply the panel sent carried a replyTo, so `origin.get(replyTo)` ran
  // against a header string and threw "origin.get is not a function" — on
  // every single answer, while a curl without replyTo short-circuited past
  // the call and looked fine.
  const requestOrigin = req.headers.origin;
  const send = (code, body) => json(res, code, body, requestOrigin);

  // A browser attaches Origin to every cross-site request, including the
  // simple POST that CORS would otherwise let through unpreflighted. Refusing
  // here, rather than only withholding the header, is what stops a page from
  // making the bot speak without ever reading the reply.
  if (requestOrigin && !panelOrigin(requestOrigin)) return send(403, { error: 'forbidden origin' });
  if (req.method === 'OPTIONS') return send(204, {});

  try {
    if (url.pathname === '/health') {
      return send(200, { ok: true, bot: me.username, id: me.id, status, intent: intentOn });
    }
    // The cursor a freshly enabled panel starts from, so commands typed hours
    // ago do not all run at once when the checkbox is ticked.
    if (url.pathname === '/newest') {
      return send(200, { newest: newestId() });
    }
    if (url.pathname === '/commands') {
      const after = url.searchParams.get('after');
      // Snowflakes are monotonic, and BigInt compares them without the
      // precision a Number would lose on a 19-digit id.
      const since = after ? BigInt(after) : null;
      const commands = since === null
        ? []
        : inbox.filter((c) => BigInt(c.id) > since);
      return send(200, { commands, newest: newestId() });
    }
    if (url.pathname === '/say' && req.method === 'POST') {
      const raw = await new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => resolve(body));
      });
      const { text, replyTo } = JSON.parse(raw || '{}');
      // Where the question was asked, falling back to wherever the last one
      // came from — the panel only ever answers a command it just ran.
      const channel = (replyTo && origin.get(replyTo)) || lastChannel;
      if (!channel) return send(409, { error: '아직 받은 명령이 없어 답할 채널을 모릅니다.' });
      const sent = await rest.sayTo(channel, String(text || ''), replyTo || null);
      // PRINTED, because the question "did the panel ever ask?" had no answer
      // anywhere. A missing reply looks identical whether the panel never
      // called, called and Discord refused, or called a relay that did not
      // know the channel — and those are three different fixes.
      say(sent.ok
        ? `→ 보냈습니다: ${String(text || '').split('\n')[0]}`
        : `→ ⚠ 보내지 못했습니다(디스코드가 거절): ${String(text || '').split('\n')[0]}`);
      return send(200, { ok: sent.ok });
    }
    if (url.pathname === '/progress' && req.method === 'POST') {
      // ONE MESSAGE PER COMMAND, REWRITTEN. The panel calls this on a timer
      // while a run is going, and a task of fifty steps would otherwise be
      // fifty messages in the channel. The relay remembers which message
      // belongs to which command, so the panel can call it as often as it
      // likes without keeping any state of its own.
      const raw = await new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => resolve(body));
      });
      const { text, replyTo } = JSON.parse(raw || '{}');
      const channel = (replyTo && origin.get(replyTo)) || lastChannel;
      if (!channel) return send(409, { error: '아직 받은 명령이 없어 답할 채널을 모릅니다.' });
      const key = replyTo || channel;
      const known = progressOf.get(key);
      if (known) {
        const edited = await rest.editIn(channel, known, String(text || ''));
        // A message the bot can no longer edit — deleted, or too old — is not
        // a reason to go silent for the rest of the run. Forgetting it means
        // the next call posts a fresh one.
        if (edited) return send(200, { ok: true, edited: true });
        progressOf.delete(key);
      }
      const posted = await rest.sayTo(channel, String(text || ''), replyTo || null);
      if (posted.id) progressOf.set(key, posted.id);
      if (!posted.ok) say(`→ ⚠ 진행 상황을 보내지 못했습니다: ${String(text || '').split('\n')[0]}`);
      return send(200, { ok: posted.ok, edited: false });
    }
    return send(404, { error: 'not found' });
  } catch (err) {
    // The panel shows this verbatim, so it says what Discord said.
    return send(502, { error: err.message });
  }
});

// A port already in use is an ordinary mistake — the relay is usually already
// running in another terminal — and it arrived as a twenty-line Node stack
// trace with the useful word buried in the middle of it.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`포트 ${PORT} 를 이미 다른 프로그램이 쓰고 있습니다.`);
    console.error('  릴레이가 다른 터미널에서 이미 돌고 있지 않은지 확인하세요.');
    console.error(`  다른 포트로 띄우려면: RELAY_PORT=${PORT + 1} node relay/discord-relay.mjs`);
  } else {
    console.error(`릴레이를 띄우지 못했습니다 — ${err.message}`);
  }
  gateway.stop();
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  say(`릴레이: http://127.0.0.1:${PORT}`);
  say(`  명령할 수 있는 사람: ${conf.userId ? conf.userId : '채널의 누구나'}`);
  say(`  듣는 채널: ${conf.channelId ? conf.channelId : '봇이 볼 수 있는 모든 채널'}`);
  say('  패널의 개발자 설정 → 디스코드 원격 명령 에서 위 주소를 넣고 켜세요.');
  say('');
});

const shutdown = () => { gateway.stop(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
