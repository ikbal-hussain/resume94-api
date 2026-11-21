import { HttpError } from "../middleware/errors.js";

/**
 * What each AI route costs, in credits. Roughly proportional to tokens: an import sends
 * a whole resume and asks for a whole resume back, which is about five summaries' worth.
 */
export const AI_COSTS = { summary: 1, improve: 1, import: 5 };

/**
 * What each AI route is expected to cost in tokens, reserved from the app's daily budget
 * before the call and settled against what the provider reports afterwards. Reserving up
 * front is what keeps simultaneous calls from all passing a "budget not yet spent" check
 * and overshooting it together. Generous on purpose: an over-estimate only holds tokens
 * for the seconds a call takes; an under-estimate lets the budget be overrun.
 */
export const TOKEN_ESTIMATES = { summary: 1500, improve: 1000, import: 5000 };
const SMALLEST_ESTIMATE = Math.min(...Object.values(TOKEN_ESTIMATES));

const DAY_SECONDS = 24 * 60 * 60;
// Two days, so a key outlives its own day even if the clock and Redis disagree slightly.
const TTL_SECONDS = 2 * DAY_SECONDS;

/**
 * Check both limits, spend the credits and reserve the estimated tokens, in one step.
 * Returns [status, used, tokens]: 1 = charged, -1 = the account is out of credits,
 * -2 = the app's budget cannot cover this call. Atomic, so two simultaneous requests
 * cannot both squeeze through on the last credit or the last tokens.
 */
const RESERVE = `
local used = tonumber(redis.call("GET", KEYS[1]) or "0")
local tokens = tonumber(redis.call("GET", KEYS[2]) or "0")
if tokens >= tonumber(ARGV[3]) or tokens + tonumber(ARGV[5]) > tonumber(ARGV[3]) then return { -2, used, tokens } end
if used + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return { -1, used, tokens } end
used = redis.call("INCRBY", KEYS[1], ARGV[1])
redis.call("EXPIRE", KEYS[1], ARGV[4])
tokens = redis.call("INCRBY", KEYS[2], ARGV[5])
redis.call("EXPIRE", KEYS[2], ARGV[4])
return { 1, used, tokens }
`;

/** Never creates the key: a refund racing the day rollover must not mint negative credit. */
const REFUND = `
if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end
local left = redis.call("DECRBY", KEYS[1], ARGV[1])
if left < 0 then redis.call("SET", KEYS[1], 0, "KEEPTTL") left = 0 end
return left
`;

/** Adds a signed amount to the day's tokens, never below zero. Returns the new total. */
const ADD_TOKENS = `
local total = redis.call("INCRBY", KEYS[1], ARGV[1])
if total < 0 then redis.call("SET", KEYS[1], 0) total = 0 end
redis.call("EXPIRE", KEYS[1], ARGV[2])
return total
`;

/** Marks the day's budget spent (the provider said its own daily limit is reached). */
const EXHAUST = `
local total = tonumber(redis.call("GET", KEYS[1]) or "0")
if total < tonumber(ARGV[1]) then redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2]) total = tonumber(ARGV[1]) end
return total
`;

function redisCounters(command) {
  return {
    reserve: (userKey, tokenKey, cost, limit, budget, estimate) =>
      command(["EVAL", RESERVE, "2", userKey, tokenKey, String(cost), String(limit), String(budget), String(TTL_SECONDS), String(estimate)]),
    refund: (userKey, cost) => command(["EVAL", REFUND, "1", userKey, String(cost)]),
    addTokens: (tokenKey, n) => command(["EVAL", ADD_TOKENS, "1", tokenKey, String(n), String(TTL_SECONDS)]),
    exhaust: (tokenKey, budget) => command(["EVAL", EXHAUST, "1", tokenKey, String(budget), String(TTL_SECONDS)]),
    read: async (userKey, tokenKey) => (await command(["MGET", userKey, tokenKey])).map((v) => Number(v ?? 0)),
  };
}

const SWEEP_EVERY_MS = 10 * 60 * 1000;

/**
 * The same operations in this process: for local work and tests, and as the fallback
 * when Upstash cannot answer. Keys carry the day in their name, so yesterday's are never
 * read again; a sweep every ten minutes drops expired entries, or a long-lived process
 * would keep one per active user per day forever.
 */
function memoryCounters(now) {
  const values = new Map();
  let nextSweep = 0;
  const sweep = (at) => {
    if (at < nextSweep) return;
    nextSweep = at + SWEEP_EVERY_MS;
    for (const [key, entry] of values) if (entry.expiresAt <= at) values.delete(key);
  };
  const get = (key) => {
    const entry = values.get(key);
    if (!entry) return 0;
    if (entry.expiresAt <= now().getTime()) {
      values.delete(key);
      return 0;
    }
    return entry.value;
  };
  const set = (key, value) => {
    const at = now().getTime();
    sweep(at);
    values.set(key, { value, expiresAt: at + TTL_SECONDS * 1000 });
  };
  return {
    size: () => values.size,
    async reserve(userKey, tokenKey, cost, limit, budget, estimate) {
      const used = get(userKey);
      const tokens = get(tokenKey);
      if (tokens >= budget || tokens + estimate > budget) return [-2, used, tokens];
      if (used + cost > limit) return [-1, used, tokens];
      set(userKey, used + cost);
      set(tokenKey, tokens + estimate);
      return [1, used + cost, tokens + estimate];
    },
    async refund(userKey, cost) {
      if (values.has(userKey)) set(userKey, Math.max(0, get(userKey) - cost));
    },
    async addTokens(tokenKey, n) {
      const total = Math.max(0, get(tokenKey) + n);
      set(tokenKey, total);
      return total;
    },
    async exhaust(tokenKey, budget) {
      const total = Math.max(get(tokenKey), budget);
      set(tokenKey, total);
      return total;
    },
    async read(userKey, tokenKey) {
      return [get(userKey), get(tokenKey)];
    },
  };
}

/**
 * A daily allowance of AI credits per account, and a daily token budget for the app.
 *
 * The per-minute limiter bounds burst; it does not bound a day. Ten calls a minute is
 * 14,400 a day from one account, while Groq's free tier allows roughly 1,000 requests and
 * 200,000 tokens a day for the whole app. Without this, one busy account could spend the
 * day's capacity for everybody by mid-morning, and everyone else would get unexplained
 * provider errors.
 *
 * - **Per account:** `AI_DAILY_CREDITS_PER_USER` credits a day (default 30). A summary or a
 *   bullet costs 1, an import 5. Over it: 429 `AI_QUOTA_EXCEEDED`.
 * - **Per app:** `AI_DAILY_TOKENS_GLOBAL` tokens a day (default 180,000, under Groq's
 *   200,000 free ceiling), counted from what the provider reports each call actually used.
 *   Over it: 503 `AI_BUDGET_EXHAUSTED` for everyone — the worst case is "AI is off until
 *   tomorrow", never a bill or a provider ban.
 *
 * Days are UTC (they reset at 05:30 IST). Credits and an estimate of the tokens are
 * reserved before the call and settled after it (see routes/ai.js `charged` for which
 * failures are refunded).
 *
 * When Upstash cannot answer, the counters fall back to this process, like the limiters
 * do — unless AI_FAIL_CLOSED is set, in which case the request is refused instead.
 */
export function createAiQuota(config, { command = null, breaker = null, log = console, now = () => new Date() } = {}) {
  const limit = config.AI_DAILY_CREDITS_PER_USER;
  const budget = config.AI_DAILY_TOKENS_GLOBAL;
  const memory = memoryCounters(now);
  const redis = command ? redisCounters(command) : null;

  const day = () => now().toISOString().slice(0, 10);
  const resetsAt = () => {
    const next = new Date(now());
    next.setUTCHours(24, 0, 0, 0);
    return next;
  };
  const keys = (userId, d = day()) => [`ai:quota:user:${userId}:${d}`, `ai:quota:tokens:${d}`];
  const retryAfter = () => String(Math.max(1, Math.ceil((resetsAt() - now()) / 1000)));

  const unreachable = () => {
    const err = new HttpError(503, "AI is briefly unavailable — the usage counter cannot be reached", "RATE_LIMIT_UNAVAILABLE");
    err.headers = { "Retry-After": "5" };
    return err;
  };

  const failed = (err) => {
    // trip() returns true only on a transition, so an outage logs once, not per request.
    if (breaker?.trip?.() ?? true) {
      log.error?.("[ai-quota] shared store failed; counting in this process until it answers again", err);
    }
  };

  /**
   * Runs an operation on Redis, or in this process, and says which one took it.
   *
   * By default it follows the shared breaker, like the limiters: skip Redis while it is
   * known to be down. Under AI_FAIL_CLOSED it always tries Redis and refuses on failure —
   * the breaker may have been tripped by a login limiter's single timeout, and a paid key
   * should neither run on a per-instance count nor be refused because of somebody else's
   * failure while Redis is in fact answering.
   */
  async function run(op, ...args) {
    if (!redis) return { backend: "memory", value: await memory[op](...args) };
    if (config.AI_FAIL_CLOSED || !breaker || breaker.tryAcquire()) {
      try {
        const value = await redis[op](...args);
        breaker?.succeed?.();
        return { backend: "redis", value };
      } catch (err) {
        failed(err);
        if (config.AI_FAIL_CLOSED) throw unreachable();
      }
    }
    return { backend: "memory", value: await memory[op](...args) };
  }

  /**
   * Runs an operation on the backend a receipt was charged on, never the other one. A
   * refund or settlement sent to the other store would change a counter the call never
   * touched: free credits on one side, a paid-for failure on the other.
   */
  async function onBackend(backend, op, ...args) {
    if (backend === "memory" || !redis) return memory[op](...args);
    try {
      return await redis[op](...args);
    } catch (err) {
      failed(err);
      throw err;
    }
  }

  const summary = (used, tokens) => ({
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetsAt: resetsAt().toISOString(),
    // Whether the app as a whole can still take even the cheapest AI call today, so the
    // client can explain an unavailable button rather than letting it fail.
    available: tokens + SMALLEST_ESTIMATE <= budget,
  });

  const exhausted = () => {
    const err = new HttpError(503, "AI has reached today’s capacity and is resting until tomorrow — everything else still works", "AI_BUDGET_EXHAUSTED");
    err.headers = { "Retry-After": retryAfter() };
    return err;
  };

  return {
    limit,

    /**
     * Spends `cost` credits for the user and reserves `estimate` tokens from the app's
     * budget, or throws 429 / 503. Returns the usage after the charge, plus the receipt
     * that `settle` and `refund` need: which keys, which day and which backend took it.
     */
    async reserve(userId, cost, estimate = 0) {
      const d = day();
      const [userKey, tokenKey] = keys(userId, d);
      const { backend, value } = await run("reserve", userKey, tokenKey, cost, limit, budget, estimate);
      const [status, used, tokens] = value.map(Number);
      if (status === -2) throw exhausted();
      if (status === -1) {
        const err = new HttpError(429, `You’ve used today’s ${limit} AI credits — they reset at midnight UTC`, "AI_QUOTA_EXCEEDED");
        err.headers = { "Retry-After": retryAfter() };
        throw err;
      }
      return { ...summary(used, tokens), receipt: { userKey, tokenKey, day: d, backend, cost, estimate, used, tokens } };
    },

    /** Gives a receipt's credits back after a call that failed. Never throws. */
    async refund(receipt) {
      try {
        await onBackend(receipt.backend, "refund", receipt.userKey, receipt.cost);
        receipt.used = Math.max(0, receipt.used - receipt.cost);
      } catch (err) {
        log.error?.(err);
      }
    },

    /**
     * Replaces the receipt's token estimate with what the call really used (zero for a
     * call that never reached the provider), on the same day and backend it was reserved
     * on. Returns the usage after, which is what the response reports. Never throws.
     */
    async settle(receipt, actualTokens) {
      const delta = Math.round(actualTokens > 0 ? actualTokens : 0) - receipt.estimate;
      let tokens = receipt.tokens;
      if (delta !== 0) {
        try {
          tokens = Number(await onBackend(receipt.backend, "addTokens", receipt.tokenKey, delta));
        } catch (err) {
          log.error?.(err);
          tokens = Math.max(0, receipt.tokens + delta);
        }
      }
      return summary(receipt.used, tokens);
    },

    /** Adds tokens spent outside a receipt to today's budget. Never throws. */
    async recordTokens(n) {
      if (!(n > 0)) return;
      try {
        await run("addTokens", keys("-")[1], Math.round(n));
      } catch (err) {
        log.error?.(err);
      }
    },

    /**
     * The provider says its own daily limit is reached: close the app's budget for the
     * rest of the UTC day, so everyone gets the clear "back tomorrow" answer up front
     * instead of each call failing at the provider. Never throws.
     */
    async exhaust() {
      try {
        await run("exhaust", keys("-")[1], budget);
      } catch (err) {
        log.error?.(err);
      }
    },

    async usage(userId) {
      const [userKey, tokenKey] = keys(userId);
      const { value } = await run("read", userKey, tokenKey);
      const [used, tokens] = value;
      return summary(used, tokens);
    },

    /** For tests: how many entries the in-process fallback holds. */
    memorySize: () => memory.size(),
  };
}
