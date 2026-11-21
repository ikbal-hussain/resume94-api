import { MemoryStore } from "express-rate-limit";

/**
 * Remembers that the shared store just failed, so the next requests skip it.
 *
 * Every Upstash call carries a 2 s deadline. Without a breaker, an Upstash that hangs
 * rather than refusing would add those two seconds to every limited request for as long
 * as the outage lasts — the limiter would become the slowest thing in the API, which is
 * the one thing a limiter must never be.
 *
 * Three states. **Closed**: every call goes to Upstash. **Open**: one failure trips it and
 * every call counts in memory for the cool-down. **Half-open**: after the cool-down exactly
 * one call is let through as a probe while everyone else stays on memory; the probe
 * succeeding closes the breaker, failing re-opens it. Letting every request through at the
 * end of the cool-down instead would send a burst of 2 s calls — and a burst of log
 * lines — at an Upstash that is still down, every 30 s for the length of the outage.
 *
 * One breaker per rate-limit service, shared by every store it hands out: if Upstash is
 * down for the login limiter it is down for the AI limiter too.
 */
export function createBreaker({ coolDownMs = 30_000, now = Date.now } = {}) {
  let openUntil = 0; // 0 = closed
  let probing = false;
  return {
    /** True while calls should skip the shared store: open, or half-open with the probe out. */
    isOpen: () => openUntil !== 0,
    /**
     * Claims permission to call the shared store. Always granted while closed; after the
     * cool-down, granted to exactly one caller (the probe) until it reports back.
     */
    tryAcquire() {
      if (openUntil === 0) return true;
      if (probing || now() < openUntil) return false;
      probing = true;
      return true;
    },
    /** A call succeeded: close. */
    succeed() {
      openUntil = 0;
      probing = false;
    },
    /**
     * A call failed: open for the cool-down. Returns true only on a transition — from
     * closed, or from a failed probe — so a caller can log once per trip rather than once
     * for every request that was in flight when Upstash went away.
     */
    trip() {
      const transition = openUntil === 0 || probing;
      openUntil = now() + coolDownMs;
      probing = false;
      return transition;
    },
  };
}

/**
 * A store that counts in Upstash and, when Upstash cannot answer, in this process.
 *
 * The alternative choices were both worse. Failing closed turned a deleted free-tier
 * database into an outage of every AI feature (November 2026: Upstash removed the idle
 * database and AI answered 503 for every user until someone noticed). Failing open — what
 * `passOnStoreError: true` does — left login and every other limited route with no limit
 * at all for the same period.
 *
 * Falling back to a MemoryStore keeps a limit in force. It is a weaker one: counted per
 * warm instance and reset on a cold start, so the effective ceiling is the configured
 * limit times the instance count. That is the same trade the app made before Upstash
 * existed, and bounded is the property that matters during an outage.
 *
 * The failure is logged once per breaker trip rather than once per request, so an outage
 * does not bury every other line in the log.
 */
export class FallbackStore {
  constructor(primary, breaker, log = console) {
    this.primary = primary;
    this.breaker = breaker;
    this.log = log;
    this.memory = new MemoryStore();
    // Read by express-rate-limit's double-count check to tell limiters apart.
    this.prefix = primary.prefix;
    // The primary is shared across instances; that is what this store reports.
    this.localKeys = false;
  }

  init(options) {
    this.primary.init?.(options);
    this.memory.init(options);
  }

  async #run(method, key) {
    if (this.breaker.tryAcquire()) {
      try {
        const result = await this.primary[method](key);
        this.breaker.succeed();
        return result;
      } catch (err) {
        if (this.breaker.trip()) {
          this.log.error?.(
            `[rate-limit] shared store failed on ${method}; counting in this process until it answers again`,
            err
          );
        }
      }
    }
    return this.memory[method](key);
  }

  increment(key) {
    return this.#run("increment", key);
  }

  /**
   * Known limitation: `decrement` goes wherever the breaker points now, not necessarily
   * to the store that took the matching `increment`, so a breaker flip mid-request can
   * lower the other store's counter. express-rate-limit only calls it for limiters with
   * `skipFailedRequests` / `skipSuccessfulRequests`, and none sets those today. A limiter
   * that adds them needs per-request routing here first.
   */
  decrement(key) {
    return this.#run("decrement", key);
  }

  /**
   * Clears the key in both stores: after an outage the client may have hits in either,
   * and a reset that cleared only one would leave the other still limiting them. The
   * shared store is best-effort and skipped while the breaker is open (it would only
   * spend the 2 s deadline failing).
   */
  async resetKey(key) {
    await this.memory.resetKey(key);
    if (!this.breaker.tryAcquire()) return;
    try {
      await this.primary.resetKey(key);
      this.breaker.succeed();
    } catch (err) {
      if (this.breaker.trip()) this.log.error?.("[rate-limit] shared store failed on resetKey", err);
    }
  }
}
