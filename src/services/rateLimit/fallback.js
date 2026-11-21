import { MemoryStore } from "express-rate-limit";

/**
 * Remembers that the shared store just failed, so the next requests skip it.
 *
 * Every Upstash call carries a 2 s deadline. Without a breaker, an Upstash that hangs
 * rather than refusing would add those two seconds to every limited request for as long
 * as the outage lasts — the limiter would become the slowest thing in the API, which is
 * the one thing a limiter must never be. One failure opens the breaker for the cool-down;
 * the first request after it tries Upstash again.
 *
 * One breaker per rate-limit service, shared by every store it hands out: if Upstash is
 * down for the login limiter it is down for the AI limiter too.
 */
export function createBreaker({ coolDownMs = 30_000, now = Date.now } = {}) {
  let openUntil = 0;
  return {
    isOpen: () => now() < openUntil,
    trip: () => {
      openUntil = now() + coolDownMs;
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
    if (!this.breaker.isOpen()) {
      try {
        return await this.primary[method](key);
      } catch (err) {
        this.breaker.trip();
        this.log.error?.(
          `[rate-limit] shared store failed on ${method}; counting in this process until it answers again`,
          err
        );
      }
    }
    return this.memory[method](key);
  }

  increment(key) {
    return this.#run("increment", key);
  }

  decrement(key) {
    return this.#run("decrement", key);
  }

  resetKey(key) {
    return this.#run("resetKey", key);
  }
}
