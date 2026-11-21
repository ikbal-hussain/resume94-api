import { HttpError } from "../middleware/errors.js";

/**
 * What each AI route costs, in credits. Roughly proportional to tokens: an import sends
 * a whole resume and asks for a whole resume back, which is about five summaries' worth.
 */
export const AI_COSTS = { summary: 1, improve: 1, import: 5 };

const DAY_SECONDS = 24 * 60 * 60;
// Two days, so a key outlives its own day even if the clock and Redis disagree slightly.
const TTL_SECONDS = 2 * DAY_SECONDS;

/**
 * Check both limits and spend the credits, in one step. Returns [status, used, tokens]:
 * status 1 = charged, -1 = the account is out of credits, -2 = the app is out of tokens.
 * Atomic, so two simultaneous requests cannot both squeeze through on the last credit.
 */
const RESERVE = `
local used = tonumber(redis.call("GET", KEYS[1]) or "0")
local tokens = tonumber(redis.call("GET", KEYS[2]) or "0")
if tokens >= tonumber(ARGV[3]) then return { -2, used, tokens } end
if used + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return { -1, used, tokens } end
used = redis.call("INCRBY", KEYS[1], ARGV[1])
redis.call("EXPIRE", KEYS[1], ARGV[4])
return { 1, used, tokens }
`;

/** Never creates the key: a refund racing the day rollover must not mint negative credit. */
const REFUND = `
if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end
local left = redis.call("DECRBY", KEYS[1], ARGV[1])
if left < 0 then redis.call("SET", KEYS[1], 0, "KEEPTTL") left = 0 end
return left
`;

const ADD_TOKENS = `
local total = redis.call("INCRBY", KEYS[1], ARGV[1])
redis.call("EXPIRE", KEYS[1], ARGV[2])
return total
`;

function redisCounters(command) {
  return {
    reserve: (userKey, tokenKey, cost, limit, budget) =>
      command(["EVAL", RESERVE, "2", userKey, tokenKey, String(cost), String(limit), String(budget), String(TTL_SECONDS)]),
    refund: (userKey, cost) => command(["EVAL", REFUND, "1", userKey, String(cost)]),
    addTokens: (tokenKey, n) => command(["EVAL", ADD_TOKENS, "1", tokenKey, String(n), String(TTL_SECONDS)]),
    read: async (userKey, tokenKey) => (await command(["MGET", userKey, tokenKey])).map((v) => Number(v ?? 0)),
  };
}

/**
 * The same four operations in this process: for local work and tests, and as the fallback
 * when Upstash cannot answer. Keys carry the day in their name, so a stale one is simply
 * never read again; entries are dropped as they expire.
 */
function memoryCounters(now) {
  const values = new Map();
  const get = (key) => {
    const entry = values.get(key);
    if (!entry) return 0;
    if (entry.expiresAt <= now().getTime()) {
      values.delete(key);
      return 0;
    }
    return entry.value;
  };
  const set = (key, value) => values.set(key, { value, expiresAt: now().getTime() + TTL_SECONDS * 1000 });
  return {
    async reserve(userKey, tokenKey, cost, limit, budget) {
      const used = get(userKey);
      const tokens = get(tokenKey);
      if (tokens >= budget) return [-2, used, tokens];
      if (used + cost > limit) return [-1, used, tokens];
      set(userKey, used + cost);
      return [1, used + cost, tokens];
    },
    async refund(userKey, cost) {
      if (values.has(userKey)) set(userKey, Math.max(0, get(userKey) - cost));
    },
    async addTokens(tokenKey, n) {
      set(tokenKey, get(tokenKey) + n);
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
 * Days are UTC (they reset at 05:30 IST). Credits are reserved before the call and refunded
 * if the call fails, so nobody pays for an outage that was not theirs.
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
  const keys = (userId) => [`ai:quota:user:${userId}:${day()}`, `ai:quota:tokens:${day()}`];
  const retryAfter = () => String(Math.max(1, Math.ceil((resetsAt() - now()) / 1000)));

  const unreachable = () => {
    const err = new HttpError(503, "AI is briefly unavailable — the usage counter cannot be reached", "RATE_LIMIT_UNAVAILABLE");
    err.headers = { "Retry-After": "5" };
    return err;
  };

  // Runs an operation on Redis, or in this process when there is no Redis, or it just
  // failed, or the shared breaker says it is still down. With AI_FAIL_CLOSED the last two
  // refuse instead: a paid key should not run on a per-instance count.
  async function run(op, ...args) {
    if (!redis) return memory[op](...args);
    if (!breaker?.isOpen()) {
      try {
        return await redis[op](...args);
      } catch (err) {
        breaker?.trip();
        log.error?.("[ai-quota] shared store failed; counting in this process until it answers again", err);
      }
    }
    if (config.AI_FAIL_CLOSED) throw unreachable();
    return memory[op](...args);
  }

  const summary = (used, tokens) => ({
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetsAt: resetsAt().toISOString(),
    // Whether the app as a whole still has AI capacity today, so the client can explain an
    // unavailable button rather than letting it fail.
    available: tokens < budget,
  });

  return {
    limit,

    /** Spends `cost` credits for the user, or throws 429 / 503. Returns the usage after. */
    async reserve(userId, cost) {
      const [userKey, tokenKey] = keys(userId);
      const [status, used, tokens] = (await run("reserve", userKey, tokenKey, cost, limit, budget)).map(Number);
      if (status === -2) {
        const err = new HttpError(503, "AI has reached today’s capacity and is resting until tomorrow — everything else still works", "AI_BUDGET_EXHAUSTED");
        err.headers = { "Retry-After": retryAfter() };
        throw err;
      }
      if (status === -1) {
        const err = new HttpError(429, `You’ve used today’s ${limit} AI credits — they reset at midnight UTC`, "AI_QUOTA_EXCEEDED");
        err.headers = { "Retry-After": retryAfter() };
        throw err;
      }
      return summary(used, tokens);
    },

    /** Gives credits back after a call that failed. Never throws: a refund is best effort. */
    async refund(userId, cost) {
      try {
        await run("refund", keys(userId)[0], cost);
      } catch (err) {
        log.error?.(err);
      }
    },

    /** Adds what a call really cost to the app's daily budget. Never throws. */
    async recordTokens(n) {
      if (!(n > 0)) return;
      try {
        await run("addTokens", keys("-")[1], Math.round(n));
      } catch (err) {
        log.error?.(err);
      }
    },

    async usage(userId) {
      const [userKey, tokenKey] = keys(userId);
      const [used, tokens] = await run("read", userKey, tokenKey);
      return summary(used, tokens);
    },
  };
}
