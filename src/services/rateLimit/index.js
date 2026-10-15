import { UpstashStore, upstashCommand } from "./upstash.js";

/**
 * Where rate-limit counters live.
 *
 * The default `MemoryStore` counts per process, and this API is one Vercel function
 * with however many instances are warm. The effective limit was therefore the
 * configured one multiplied by the instance count, and it reset on every cold start —
 * which mattered most on the one route that spends money per call.
 *
 * A store is handed to each limiter rather than imported by it, so the routers stay
 * injectable and a test can count hits without a network.
 *
 * Unset credentials are not an error: `store()` returns undefined, express-rate-limit
 * falls back to its MemoryStore, and local work and the test suite need no Redis. That
 * is also why /api/health reports which store is live — "memory" in production is
 * invisible from every other endpoint until someone goes looking for the bill.
 */
export function createRateLimitService(config, fetchImpl = fetch, log = console) {
  const url = config.UPSTASH_REDIS_REST_URL;
  const token = config.UPSTASH_REDIS_REST_TOKEN;

  const memory = (why) => {
    if (config.NODE_ENV === "production") log.error?.(`[rate-limit] ${why}`);
    return { provider: "memory", configured: false, store: () => undefined, ping: async () => null };
  };

  if (!url || !token) {
    return memory(
      "UPSTASH_REDIS_REST_URL/TOKEN are unset, so limits are counted per serverless " +
        "instance and reset on every cold start. The configured limits are not the effective ones."
    );
  }

  // The token is a bearer credential on every request. Over http:// it crosses the
  // network in the clear, and a stolen one lets someone reset or inflate any counter —
  // including the ones metering AI spend. Upstash only ever issues https endpoints, so
  // an http:// value is a typo or a proxy, and neither is worth sending a credential to.
  if (!/^https:\/\//i.test(url)) {
    return memory(
      `UPSTASH_REDIS_REST_URL is not https (${url.slice(0, 12)}…), so the access token would ` +
        "be sent unencrypted. Refusing to use it; limits are counted per instance until this is fixed."
    );
  }

  const command = upstashCommand({ url, token }, fetchImpl);

  // A reachability probe is cached because /api/health is public and unauthenticated.
  // Upstash's free tier bills by command and has a daily ceiling, so an uncached probe
  // would let anyone exhaust the quota by hammering health — and an exhausted quota
  // breaks the limiters outright, which is the opposite of what this field is for.
  let last = { at: 0, ok: null };
  const PROBE_TTL_MS = 30_000;

  return {
    provider: "upstash",
    configured: true,
    store: (prefix) => new UpstashStore(command, prefix),

    /**
     * Whether the credentials actually work, not merely whether they are present.
     *
     * Presence is what the health field reported at first, which meant a mistyped token
     * read as healthy while every AI request 503'd and every other limit passed through
     * uncounted. /api/health pings Mongo rather than asserting a connection string; this
     * holds the counters to the same standard.
     */
    async ping() {
      if (Date.now() - last.at < PROBE_TTL_MS) return last.ok;
      try {
        const pong = await command(["PING"]);
        last = { at: Date.now(), ok: String(pong).toUpperCase() === "PONG" };
      } catch (err) {
        log.error?.(err);
        last = { at: Date.now(), ok: false };
      }
      return last.ok;
    },
  };
}
