/**
 * relayClient.js — the panel's half of the Discord bridge.
 *
 * Same four calls as src/discord.js, pointed at the local relay instead of at
 * Discord. The panel cannot reach Discord itself: the edge answers a request
 * carrying browser headers with `403 internal network error`, which is
 * deliberate — a bot token in a web page is a token anyone can take. So the
 * token stays in relay/discord-relay.mjs and never enters the browser, and
 * the panel holds nothing but a loopback address.
 *
 * Keeping the shape identical is what lets the panel not care which side of
 * the bridge it is talking to.
 */

export function createRelayClient({ baseUrl, fetchImpl = fetch }) {
  const root = String(baseUrl || '').trim().replace(/\/+$/, '');

  const call = async (path, init) => {
    let res;
    try {
      res = await fetchImpl(root + path, init);
    } catch (_) {
      // A refused connection is the ordinary case — the relay is simply not
      // running — and "Failed to fetch" does not say that to anyone.
      throw new Error(`릴레이에 연결하지 못했습니다 (${root}). node relay/discord-relay.mjs 를 실행하세요.`);
    }
    const body = await res.json().catch(() => null);
    // The relay forwards Discord's own words in `error`; passing them through
    // is what keeps a permission problem distinguishable from a dead relay.
    if (!res.ok) throw new Error(body?.error || `릴레이 ${path} → HTTP ${res.status}`);
    return body;
  };

  return {
    async connect() {
      const health = await call('/health');
      return { id: health.id, username: health.bot };
    },
    async newestId() {
      return (await call('/newest')).newest;
    },
    async commandsAfter(afterId) {
      return call(`/commands${afterId ? `?after=${encodeURIComponent(afterId)}` : ''}`);
    },
    /**
     * The one line that keeps being rewritten while a run is going.
     *
     * Whoever sent the command from a phone otherwise sees "▶ 시작합니다" and
     * then nothing for a minute or more, with no way to tell a run in
     * progress from one that died. The relay owns the message id, so this can
     * be called on a timer without the panel keeping any state.
     */
    async progress(text, replyTo = null, onError = null) {
      try {
        await call('/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, replyTo }),
        });
        return true;
      } catch (err) {
        if (onError) onError(err);
        return false;
      }
    },

    /**
     * @param {string} text
     * @param {string|null} replyTo    the command being answered
     * @param {(err: Error) => void} [onError]  why it could not be sent
     */
    async say(text, replyTo = null, onError = null) {
      try {
        await call('/say', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, replyTo }),
        });
        return true;
      } catch (err) {
        // Failing to answer must not take the run or the poll loop with it —
        // but it must not be invisible either. `call` already turns a refused
        // connection and a relay error into a sentence worth printing, and
        // that sentence was being thrown away with the exception. The caller
        // decides what to do with it; returning false keeps the old contract.
        if (onError) onError(err);
        return false;
      }
    },
  };
}
