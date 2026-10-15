import { describe, expect, it, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import rateLimit from "express-rate-limit";
import { createRateLimitService } from "../src/services/rateLimit/index.js";
import { UpstashStore } from "../src/services/rateLimit/upstash.js";
import { failClosed } from "../src/middleware/rateLimit.js";
import { errorHandler } from "../src/middleware/errors.js";
import { makeApp, startMongo, stopMongo } from "./helpers.js";

const CREDENTIALS = {
  UPSTASH_REDIS_REST_URL: "https://fake.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "fake-token",
};
const quiet = { error() {}, warn() {}, info() {} };

/**
 * Stands in for Upstash's REST endpoint.
 *
 * It holds the keys in one object and runs the handful of commands this store sends,
 * including the Lua increment — which is the only way to test the property that
 * matters: that two stores built from the same credentials, standing in for two warm
 * serverless instances, count against one counter rather than one each.
 */
function fakeUpstash() {
  const keys = new Map();
  const calls = [];
  let fail = null;

  const run = ([command, ...args]) => {
    if (command === "EVAL") {
      const [, , key, windowMs] = args;
      const entry = keys.get(key) ?? { hits: 0, expiresAt: Date.now() + Number(windowMs) };
      entry.hits += 1;
      if (entry.hits === 1) entry.expiresAt = Date.now() + Number(windowMs);
      keys.set(key, entry);
      return [entry.hits, entry.expiresAt - Date.now()];
    }
    if (command === "DECR") {
      const entry = keys.get(args[0]);
      if (entry) entry.hits -= 1;
      return entry?.hits ?? 0;
    }
    if (command === "DEL") return keys.delete(args[0]) ? 1 : 0;
    throw new Error(`fake upstash got an unexpected command: ${command}`);
  };

  const fetchImpl = async (url, init) => {
    const args = JSON.parse(init.body);
    calls.push({ url, authorization: init.headers.Authorization, args });
    if (fail) return fail;
    return { ok: true, status: 200, json: async () => ({ result: run(args) }) };
  };

  return {
    fetchImpl,
    calls,
    keys,
    /** Makes every later call answer like an unreachable or angry Upstash. */
    breakWith(response) {
      fail = response;
    },
  };
}

const hitsFor = (keys, suffix) => [...keys.entries()].find(([k]) => k.endsWith(suffix))?.[1].hits;

describe("rate-limit store selection", () => {
  it("falls back to the in-process store when Upstash is not configured", () => {
    const service = createRateLimitService({ NODE_ENV: "test" }, null, quiet);
    expect(service.provider).toBe("memory");
    expect(service.configured).toBe(false);
    // undefined, not a store: express-rate-limit drops undefined options, so each
    // limiter builds its own MemoryStore exactly as it did before this existed.
    expect(service.store("x:")).toBeUndefined();
  });

  it("says so loudly when production is left on the in-process store", () => {
    const logged = [];
    createRateLimitService({ NODE_ENV: "production" }, null, { error: (m) => logged.push(m) });
    expect(logged.join(" ")).toMatch(/UPSTASH_REDIS_REST_URL/);
  });

  it("uses Upstash when both credentials are set", () => {
    const service = createRateLimitService({ NODE_ENV: "test", ...CREDENTIALS }, fakeUpstash().fetchImpl, quiet);
    expect([service.provider, service.configured]).toEqual(["upstash", true]);
  });

  it("needs both halves of the credential, not either", () => {
    const url = createRateLimitService({ UPSTASH_REDIS_REST_URL: "https://fake.upstash.io" }, null, quiet);
    const token = createRateLimitService({ UPSTASH_REDIS_REST_TOKEN: "t" }, null, quiet);
    expect([url.provider, token.provider]).toEqual(["memory", "memory"]);
  });
});

describe("the Upstash store", () => {
  const limiterOn = (service, prefix, limit, extra = {}) => {
    const app = express();
    app.set("trust proxy", 1);
    app.get(
      "/",
      rateLimit({
        windowMs: 60_000,
        limit,
        store: service.store(prefix),
        keyGenerator: () => "ada",
        message: { error: { code: "RATE_LIMITED", message: "slow down" } },
        ...extra,
      }),
      (_req, res) => res.json({ ok: true })
    );
    app.use(errorHandler(quiet));
    return app;
  };

  it("counts hits in Redis and sends the credential as a bearer token", async () => {
    const upstash = fakeUpstash();
    const service = createRateLimitService({ ...CREDENTIALS }, upstash.fetchImpl, quiet);
    await request(limiterOn(service, "test:", 5)).get("/");

    expect(hitsFor(upstash.keys, "ada")).toBe(1);
    expect(upstash.calls[0].authorization).toBe("Bearer fake-token");
    expect(upstash.calls[0].url).toBe("https://fake.upstash.io");
  });

  // The whole point of the change. Two instances, one counter.
  it("shares one counter across separate instances of the app", async () => {
    const upstash = fakeUpstash();
    const config = { ...CREDENTIALS };
    // Two services, two stores, two limiters — as two warm Vercel instances would be.
    const first = limiterOn(createRateLimitService(config, upstash.fetchImpl, quiet), "test:", 2);
    const second = limiterOn(createRateLimitService(config, upstash.fetchImpl, quiet), "test:", 2);

    expect((await request(first).get("/")).status).toBe(200);
    expect((await request(second).get("/")).status).toBe(200);
    // On the in-process store this would be the first hit on the second instance and
    // pass. Against a shared counter it is the third hit overall, and it does not.
    const third = await request(second).get("/");
    expect([third.status, third.body.error.code]).toEqual([429, "RATE_LIMITED"]);
  });

  it("keeps each limiter's counter separate", async () => {
    const upstash = fakeUpstash();
    const service = createRateLimitService({ ...CREDENTIALS }, upstash.fetchImpl, quiet);
    await request(limiterOn(service, "auth:attempts:", 5)).get("/");
    await request(limiterOn(service, "ai:import:", 5)).get("/");

    expect([...upstash.keys.keys()].sort()).toEqual(["ai:import:ada", "auth:attempts:ada"]);
  });

  it("starts the window now when the key has no TTL left to report", async () => {
    // PTTL answers -1 for a key with no expiry and -2 for one that expired between the
    // INCR and the read. Passing either through would put resetTime in the past and
    // make Retry-After meaningless.
    const store = new UpstashStore(async () => [3, -2], "test:");
    store.init({ windowMs: 60_000 });
    const { totalHits, resetTime } = await store.increment("ada");
    expect(totalHits).toBe(3);
    expect(resetTime.getTime()).toBeGreaterThan(Date.now());
  });

  it("reports a window that ends in the future, so Retry-After is usable", async () => {
    const upstash = fakeUpstash();
    const service = createRateLimitService({ ...CREDENTIALS }, upstash.fetchImpl, quiet);
    const res = await request(limiterOn(service, "test:", 1, { standardHeaders: true })).get("/");
    expect(Number(res.headers["ratelimit-reset"])).toBeGreaterThan(0);
  });
});

describe("when the counter cannot be reached", () => {
  const brokenService = (response) => {
    const upstash = fakeUpstash();
    upstash.breakWith(response);
    return createRateLimitService({ ...CREDENTIALS }, upstash.fetchImpl, quiet);
  };

  const appWith = (middleware) => {
    const app = express();
    app.get("/", middleware, (_req, res) => res.json({ ok: true }));
    app.use(errorHandler(quiet));
    return app;
  };

  const limiter = (service, opts) =>
    rateLimit({
      windowMs: 60_000,
      limit: 5,
      store: service.store("test:"),
      keyGenerator: () => "ada",
      ...opts,
    });

  it("lets the request through where availability is what is at stake", async () => {
    const service = brokenService({ ok: false, status: 500, text: async () => "boom" });
    const res = await request(appWith(limiter(service, { passOnStoreError: true, logger: quiet }))).get("/");
    expect([res.status, res.body]).toEqual([200, { ok: true }]);
  });

  it("answers 503, not 500, where money is at stake", async () => {
    const service = brokenService({ ok: false, status: 500, text: async () => "boom" });
    const middleware = failClosed(limiter(service, { passOnStoreError: false, logger: quiet }), "nope", quiet);
    const res = await request(appWith(middleware)).get("/");
    // A 500 would tell the client its request was broken; it was refused on purpose,
    // and a frontend may retry a 503.
    expect([res.status, res.body.error.code]).toEqual([503, "RATE_LIMIT_UNAVAILABLE"]);
  });

  // The regression that matters most: a wrapper that ignores next's argument turns a
  // fail-closed limiter back into a fail-open one while every option still reads
  // "passOnStoreError: false", and the AI routes go unmetered.
  it("never lets a fail-closed route through on a store error", async () => {
    const service = brokenService({ ok: false, status: 500, text: async () => "boom" });
    const middleware = failClosed(limiter(service, { passOnStoreError: false, logger: quiet }), "nope", quiet);
    const res = await request(appWith(middleware)).get("/");
    expect(res.status).not.toBe(200);
  });

  it("treats a Redis error in a 200 body as a failure", async () => {
    // Upstash reports NOSCRIPT and friends with an HTTP 200 and an error field, so a
    // store that only checked res.ok would read the error as a hit count.
    const service = brokenService({ ok: true, status: 200, json: async () => ({ error: "ERR unknown command" }) });
    const middleware = failClosed(limiter(service, { passOnStoreError: false, logger: quiet }), "nope", quiet);
    expect((await request(appWith(middleware)).get("/")).status).toBe(503);
  });
});

describe("the app reports which store is live", () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  it("says memory when Upstash is unset", async () => {
    const res = await request(await makeApp()).get("/api/health");
    expect(res.body.rateLimitStore).toBe("memory");
  });

  it("says upstash when it is configured", async () => {
    const app = await makeApp(CREDENTIALS, { rateLimits: createRateLimitService(CREDENTIALS, fakeUpstash().fetchImpl, quiet) });
    const res = await request(app).get("/api/health");
    expect(res.body.rateLimitStore).toBe("upstash");
  });
});
