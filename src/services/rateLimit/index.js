import { UpstashStore, upstashCommand } from "./upstash.js";
import { FallbackStore, createBreaker } from "./fallback.js";

/**
 * The health probe writes, and reads the write back, in one round trip.
 *
 * A PING proved the credentials worked and nothing more. A write proves the database
 * will actually store a counter, and it is unambiguously activity: Upstash deletes a
 * free database after 14 days without any (it did, in November 2026, and every AI route
 * answered 503 until someone noticed). An uptime monitor on /api/health therefore keeps
 * the database alive as a side effect of watching it, whichever monitoring tool or host
 * is in use.
 */
const PROBE = `
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
return redis.call("GET", KEYS[1])
`;
const PROBE_KEY = "health:last-check";
const KEEPALIVE_KEY = "keepalive:last-run";
const DAY_SECONDS = 24 * 60 * 60;

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
    return {
      provider: "memory",
      configured: false,
      store: () => undefined,
      fallbackActive: () => false,
      ping: async () => null,
      keepAlive: async () => null,
    };
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
  const breaker = createBreaker();

  // A reachability probe is cached because /api/health is public and unauthenticated.
  // Upstash's free tier bills by command and has a daily ceiling, so an uncached probe
  // would let anyone exhaust the quota by hammering health — and an exhausted quota
  // breaks the limiters outright, which is the opposite of what this field is for.
  let last = { at: 0, ok: null };
  const PROBE_TTL_MS = 30_000;

  return {
    provider: "upstash",
    configured: true,
    /**
     * A store for one limiter's counters.
     *
     * By default it degrades: if Upstash cannot answer, the limiter keeps counting in
     * this process instead of failing (see FallbackStore). `degrade: false` returns the
     * bare Upstash store, whose errors reach the limiter — for a route that would rather
     * refuse than run on a weaker limit. The AI routes ask for that only when
     * AI_FAIL_CLOSED is set, which is the setting for a paid provider key.
     */
    /** Whether a recent failure has the stores counting in memory (breaker not closed). */
    fallbackActive: () => breaker.isOpen(),

    store: (prefix, { degrade = true } = {}) => {
      const upstash = new UpstashStore(command, prefix);
      return degrade ? new FallbackStore(upstash, breaker, log) : upstash;
    },

    /**
     * Whether the credentials actually work, not merely whether they are present.
     *
     * Presence is what the health field reported at first, which meant a mistyped token
     * read as healthy while every AI request 503'd and every other limit passed through
     * uncounted. /api/health pings Mongo rather than asserting a connection string; this
     * holds the counters to the same standard — and goes one further, by writing and
     * reading back (see PROBE), which also counts as activity for Upstash's idle timer.
     */
    async ping() {
      if (Date.now() - last.at < PROBE_TTL_MS) return last.ok;
      try {
        const stamp = new Date().toISOString();
        const echoed = await command(["EVAL", PROBE, "1", PROBE_KEY, stamp, String(14 * DAY_SECONDS)]);
        last = { at: Date.now(), ok: echoed === stamp };
      } catch (err) {
        log.error?.(err);
        last = { at: Date.now(), ok: false };
      }
      return last.ok;
    },

    /**
     * One write to a key of its own, for the scheduled keep-alive.
     *
     * The weekly cron is the fallback to the uptime monitor, not the primary: it exists
     * for the case where monitoring is paused or moved and nothing else touches the
     * database for two weeks. It touches no rate-limit key, so it cannot change anybody's
     * limit, and it is not cached, because a cache would turn it into a no-op.
     */
    async keepAlive() {
      const stamp = new Date().toISOString();
      await command(["SET", KEEPALIVE_KEY, stamp, "EX", String(30 * DAY_SECONDS)]);
      return stamp;
    },
  };
}
