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
 * forever. The TTL is set only on the first hit of a window, so a later hit cannot
 * extend it — otherwise a client making steady requests would never see the window end.
 */
const INCREMENT = `
local hits = redis.call("INCR", KEYS[1])
if hits == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
return { hits, redis.call("PTTL", KEYS[1]) }
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
    // PTTL answers -1 for a key with no expiry and -2 for one that expired between the
    // INCR and the read. Either way the window starts now rather than reporting a reset
    // time in the past, which would make the Retry-After header meaningless.
    const remaining = Number(ttl) > 0 ? Number(ttl) : this.windowMs;
    return { totalHits: Number(hits), resetTime: new Date(Date.now() + remaining) };
  }

  async decrement(key) {
    await this.command(["DECR", this.prefix + key]);
  }

  async resetKey(key) {
    await this.command(["DEL", this.prefix + key]);
  }
}
