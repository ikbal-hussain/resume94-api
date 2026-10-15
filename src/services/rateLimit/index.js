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

  if (!url || !token) {
    if (config.NODE_ENV === "production") {
      log.error?.(
        "[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN are unset, so limits are counted per " +
          "serverless instance and reset on every cold start. The configured limits are not " +
          "the effective ones."
      );
    }
    return { provider: "memory", configured: false, store: () => undefined };
  }

  const command = upstashCommand({ url, token }, fetchImpl);
  return {
    provider: "upstash",
    configured: true,
    store: (prefix) => new UpstashStore(command, prefix),
  };
}
