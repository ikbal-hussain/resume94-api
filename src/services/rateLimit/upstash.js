/**
 * Upstash Redis over its REST API.
 *
 * Upstash is reachable with a plain POST, so this needs no SDK dependency — the same
 * reasoning as the Resend transport in services/mail. It is a REST call rather than a
 * Redis connection on purpose: a serverless function is a new process per cold start,
 * and a TCP client would open a socket it never gets to reuse.
 */

/**
 * Counting is a single round trip, and an atomic one.
 *
 * INCR and PEXPIRE as two calls would leave a window where the key exists with no TTL:
 * if the process dies between them the counter never expires and that client is limited
 * forever, while the headers keep advertising a window that never ends.
 *
 * The TTL is reapplied whenever it is missing, not only on the first hit. A key with no
 * expiry is otherwise immortal and its counter only ever climbs — and `PTTL` returning
 * -1 is exactly the state a bare `DECR` on a missing key would create, so the two
 * scripts here have to agree about it. A later hit inside a live window does not extend
 * it: `ttl < 0` is "no expiry at all", never "a little time left".
 */
const INCREMENT = `
local hits = redis.call("INCR", KEYS[1])
local ttl = redis.call("PTTL", KEYS[1])
if hits == 1 or ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`;

/**
 * Decrementing has to refuse to create the key.
 *
 * Redis treats `DECR` on a missing key as 0, so a bare one leaves the key at -1 with no
 * expiry — and nothing ever removes it. express-rate-limit calls `decrement` when a
 * limiter sets `skipFailedRequests` or `skipSuccessfulRequests`, so a window expiring
 * between the INCR and the DECR would mint a permanently negative counter that can
 * never reach the limit again: that client would be silently unmetered, forever. No
 * limiter sets those options today, but this is the store's published API and AGENTS.md
 * now invites new limiters onto it.
 */
const DECREMENT = `
if redis.call("EXISTS", KEYS[1]) == 1 then return redis.call("DECR", KEYS[1]) end
return 0
`;

/**
 * A rate limit must never be the slowest thing in a request.
 *
 * Without a deadline an unreachable store would hold the connection until Vercel's own
 * 60s limit, turning a counter outage into an outage of every route that counts. The
 * limiters pair this with `passOnStoreError`, which decides what a timeout means for
 * that particular route.
 */
const TIMEOUT_MS = 2_000;

/** Returns `(args) => result`, where args is a Redis command: ["INCR", "key"]. */
export function upstashCommand({ url, token }, fetchImpl = fetch) {
  const endpoint = url.replace(/\/$/, "");
  return async (args) => {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`upstash responded ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    // Upstash reports a Redis-level error in a 200 body, so status alone is not enough.
    if (json?.error) throw new Error(`upstash: ${json.error}`);
    return json?.result;
  };
}

/**
 * An express-rate-limit store backed by one Redis key per client per limiter.
 *
 * `prefix` keeps each limiter's counters apart. Without it every limiter in the app
 * would share one counter per client, so a login attempt would spend an AI import's
 * budget — and express-rate-limit's own double-count check reads this property to tell
 * two limiters apart from one limiter applied twice by mistake.
 */
export class UpstashStore {
  constructor(command, prefix) {
    this.command = command;
    this.prefix = prefix;
    // The whole point: these counters are shared, so the configured limit is the real
    // limit no matter how many instances are warm.
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const [hits, ttl] = await this.command([
      "EVAL",
      INCREMENT,
      "1",
      this.prefix + key,
      String(this.windowMs),
    ]);
    // The script reapplies a missing TTL, so a negative value here means the key expired
    // between its two reads. Reporting the window as starting now keeps resetTime in the
    // future; a time in the past would make Retry-After meaningless.
    const remaining = Number(ttl) > 0 ? Number(ttl) : this.windowMs;
    return { totalHits: Number(hits), resetTime: new Date(Date.now() + remaining) };
  }

  async decrement(key) {
    await this.command(["EVAL", DECREMENT, "1", this.prefix + key]);
  }

  async resetKey(key) {
    await this.command(["DEL", this.prefix + key]);
  }
}
