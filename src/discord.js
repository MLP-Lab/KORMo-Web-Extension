/**
 * discord.js — what counts as a command, and the few REST calls still needed.
 *
 * THE LIVE CONNECTION IS src/discordGateway.js. This file holds the two things
 * that are not the socket: the predicate that decides whether a message is
 * addressed to us, and the handful of REST calls the gateway does not cover —
 * who the bot is, which roles it holds, and posting a reply.
 *
 * WHY A RELAY PROCESS AT ALL, when the panel is a real document that could
 * hold the connection itself: Discord's edge refuses a request that looks like
 * it came from a browser. The same read that answers 200 from Node answers
 * `403 internal network error` once a browser User-Agent and the Sec-Fetch-*
 * headers are attached — measured, both ways. That is deliberate, because a
 * bot token in a web page is a bot token anyone can take. So the token stays
 * in the relay and the panel holds nothing but a loopback address.
 *
 * WHAT COUNTS AS A COMMAND. A message that MENTIONS THE BOT. Not a prefix: a
 * prefix is typed by accident, collides with every other bot in the channel,
 * and gives no signal in the client that the message was addressed to
 * anything. A mention is deliberate, unambiguous and visible.
 *
 * `fetchImpl` is injected so the whole thing can be tested against a stub
 * rather than against Discord.
 */

const API = 'https://discord.com/api/v10';

/**
 * Every spelling that addresses the bot, as one pattern.
 *
 * `<@123>` and `<@!123>` are a user mention. `<@&456>` is a ROLE mention, and
 * it is what typing @botname usually produces: Discord gives a bot an
 * automatic managed role with the bot's own name, and the autocomplete offers
 * that role first. MEASURED — the first command typed into the channel came
 * through as `<@&1570077391219466389> 쿠팡에서 …` and was ignored, because
 * a role mention lands in `mention_roles` and never in `mentions`.
 */
export const addressOf = (botId) => new RegExp(`<@!?${botId}>|<@&\\d+>`, 'g');

/**
 * A command is not every message the bot can see.
 *
 * `author.bot` excludes the bot's own replies, which would otherwise be read
 * back and — since a reply names the task it was answering — run the same task
 * forever.
 *
 * @param {object} message        a MESSAGE_CREATE payload
 * @param {string} botId
 * @param {string[]} roleIds      the bot's own roles IN THIS MESSAGE'S guild
 * @param {string} [allowUserId]  when set, only this user may command
 */
export function isCommand(message, botId, roleIds, allowUserId) {
  if (!message || message.type !== 0) return false;
  if (message.author?.bot) return false;
  if (allowUserId && message.author?.id !== allowUserId) return false;
  if ((message.mentions || []).some((m) => m.id === botId)) return true;
  // Only the bot's OWN roles count. @everyone and a general @team would
  // otherwise turn every announcement in the channel into a task.
  return (message.mention_roles || []).some((r) => (roleIds || []).includes(r));
}

/**
 * The task a command carries, with the addressing removed.
 *
 * The mention is how the message reached us, not part of what was asked, and
 * it must not reach the model as text. `channelId` rides along because the
 * answer goes back where the question was asked — which is what removed the
 * channel id from the setup.
 */
export function commandFrom(message, botId) {
  return {
    id: message.id,
    author: message.author?.username || '',
    channelId: message.channel_id,
    task: String(message.content || '')
      .replace(addressOf(botId), ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

/** What the invite link asks for: View Channels, Send Messages, Read History. */
export const INVITE_PERMISSIONS = (1 << 10) | (1 << 11) | (1 << 16);

/**
 * The link that puts this bot in a server.
 *
 * Printed by the relay rather than assembled by hand in the developer portal:
 * the token already identifies the application, so there is nothing for a
 * person to look up, and the permission number cannot be got wrong.
 */
export const inviteUrl = (applicationId) =>
  `https://discord.com/oauth2/authorize?client_id=${applicationId}` +
  `&scope=bot&permissions=${INVITE_PERMISSIONS}`;

/** The privileged-intent bits on an application's `flags`. */
export const INTENT_FLAGS = {
  MESSAGE_CONTENT: 1 << 19,
  MESSAGE_CONTENT_LIMITED: 1 << 18,
};

/**
 * True when the application may read message content.
 *
 * Discord reports this two ways: `…_LIMITED` for a bot under 100 servers with
 * the toggle on, and the plain bit once it has been approved at scale. Either
 * means the switch is on. NEITHER means every message still arrives — with
 * `content` as an empty string, so every command reads as a mention of nothing
 * and is dropped, while the relay cheerfully reports itself connected. That is
 * the one setup mistake that presents as "it just ignores me", so it is
 * checked at startup instead of being left to be discovered.
 */
export const hasMessageContent = (flags) =>
  Boolean((Number(flags) || 0)
    & (INTENT_FLAGS.MESSAGE_CONTENT | INTENT_FLAGS.MESSAGE_CONTENT_LIMITED));

export function createDiscordRest({ token, fetchImpl = fetch }) {
  const auth = { Authorization: `Bot ${String(token || '').trim()}` };

  const get = async (path) => {
    const res = await fetchImpl(API + path, { headers: auth });
    if (!res.ok) {
      // Discord says WHY in the body, and a bare status number sends the
      // reader guessing between a missing permission, a blocked origin and a
      // revoked token — three different fixes behind one 403.
      const why = await res.json().then((b) => b?.message || '').catch(() => '');
      throw new Error(`Discord ${path.split('?')[0]} → HTTP ${res.status}${why ? ` — ${why}` : ''}`);
    }
    return res.json();
  };

  return {
    get,

    /** Who the token belongs to. The id is what a mention is matched against. */
    me: () => get('/users/@me'),

    /** The application, for its privileged-intent flags. */
    application: () => get('/applications/@me'),

    /**
     * The bot's roles in one guild.
     *
     * `/guilds/{g}/members/{botId}`, NOT `.../members/@me`: a bot gets
     * `400 Invalid Form Body` from the @me spelling and `403 Bots cannot use
     * this endpoint` from /users/@me/guilds/{g}/member. Only the explicit id
     * works, and an earlier version used @me — which failed into a catch, left
     * the role list empty, and silently dropped every command typed as
     * @botname while reporting the listener as connected.
     */
    async rolesIn(guildId, botId) {
      const member = await get(`/guilds/${guildId}/members/${botId}`);
      return (member.roles || []).map(String);
    },

    /** Post one line back. Failing to answer must not stop the listener. */
    async sayTo(channelId, text, replyTo = null) {
      const body = { content: String(text).slice(0, 1900) };
      if (replyTo) body.message_reference = { message_id: replyTo, fail_if_not_exists: false };
      const res = await fetchImpl(`${API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      // The id is what makes a progress line possible: the same message can
      // then be rewritten as the run moves, instead of a new one per step.
      if (!res.ok) return { ok: false, id: null };
      // The id is read defensively: posting SUCCEEDED, and a body that cannot
      // be parsed only costs the ability to rewrite this message later. That
      // is not a reason to report the send as failed.
      const sent = typeof res.json === 'function'
        ? await res.json().catch(() => null)
        : null;
      return { ok: true, id: sent && sent.id ? sent.id : null };
    },

    /**
     * Rewrite a message this bot sent.
     *
     * WHY A RUN NEEDS THIS. A task takes a minute or more, and whoever sent
     * the command from a phone sees "▶ 시작합니다" and then nothing until it
     * ends — with no way to tell a run in progress from one that died. Posting
     * each step instead would be fifty messages in the channel for one task.
     * One message, rewritten, is the only shape that is both informative and
     * bearable to read.
     */
    async editIn(channelId, messageId, text) {
      const res = await fetchImpl(`${API}/channels/${channelId}/messages/${messageId}`, {
        method: 'PATCH',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: String(text).slice(0, 1900) }),
      });
      return res.ok;
    },
  };
}
