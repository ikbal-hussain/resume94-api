import { describe, expect, it, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import rateLimit from "express-rate-limit";
import { createRateLimitService } from "../src/services/rateLimit/index.js";
import { UpstashStore } from "../src/services/rateLimit/upstash.js";
import { FallbackStore, createBreaker } from "../src/services/rateLimit/fallback.js";
import { failClosed } from "../src/middleware/rateLimit.js";
import { errorHandler } from "../src/middleware/errors.js";
import { makeApp, signedInAgent, startMongo, stopMongo } from "./helpers.js";
import { CREDENTIALS, quiet, fakeUpstash } from "./fakeUpstash.js";

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

describe("credentials that are present but wrong", () => {
  // Rated critical by review and it is cheap to close: the token is a bearer credential
  // on every request, and over http:// it crosses the network in the clear.
  it("refuses an http:// endpoint rather than sending the token in the clear", () => {
    const logged = [];
    const service = createRateLimitService(
      { NODE_ENV: "production", UPSTASH_REDIS_REST_URL: "http://fake.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" },
      null,
      { error: (m) => logged.push(String(m)) }
    );
    expect(service.provider).toBe("memory");
    expect(logged.join(" ")).toMatch(/not https/);
  });

  it("does not leak the token into the log it writes about the url", () => {
    const logged = [];
    createRateLimitService(
      { NODE_ENV: "production", UPSTASH_REDIS_REST_URL: "http://fake.upstash.io", UPSTASH_REDIS_REST_TOKEN: "super-secret" },
      null,
      { error: (m) => logged.push(String(m)) }
    );
    expect(logged.join(" ")).not.toContain("super-secret");
  });

  it("reports unreachable when the credentials do not work", async () => {
    const upstash = fakeUpstash();
    upstash.breakWith({ ok: false, status: 401, text: async () => "unauthorized" });
    const service = createRateLimitService({ ...CREDENTIALS }, upstash.fetchImpl, quiet);
    // Configured says yes — that was the whole bug: a mistyped token read as healthy
    // while every AI request 503'd and every other limit passed through uncounted.
    expect(service.configured).toBe(true);
    expect(await service.ping()).toBe(false);
  });

  it("reports reachable when they do", async () => {
    const service = createRateLimitService({ ...CREDENTIALS }, fakeUpstash().fetchImpl, quiet);
    expect(await service.ping()).toBe(true);
  });

  it("caches the probe, because /api/health is public and commands are metered", async () => {
    const upstash = fakeUpstash();
    const service = createRateLimitService({ ...CREDENTIALS }, upstash.fetchImpl, quiet);
    await service.ping();
    await service.ping();
    await service.ping();
    // Otherwise anyone can burn the daily command quota by hammering health — and an
    // exhausted quota breaks the limiters outright.
    expect(upstash.calls.filter((c) => c.args[0] === "EVAL" && c.args[3] === "health:last-check")).toHaveLength(1);
  });

  it("probes with a write it reads back, not a bare PING", async () => {
    const upstash = fakeUpstash();
    const service = createRateLimitService({ ...CREDENTIALS }, upstash.fetchImpl, quiet);
    expect(await service.ping()).toBe(true);
    // A write is what Upstash's idle timer certainly counts, and what proves a counter
    // would actually be stored. The key expires on its own.
    const probe = upstash.keys.get("health:last-check");
    expect(probe.value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(probe.expiresAt).toBeGreaterThan(Date.now());
    expect(upstash.calls.some((c) => c.args[0] === "PING")).toBe(false);
  });

  it("reports unreachable when the write does not read back", async () => {
    // A proxy or a misrouted endpoint can answer 200 with something else entirely.
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ result: "not-what-was-written" }) });
    const service = createRateLimitService({ ...CREDENTIALS }, fetchImpl, quiet);
    expect(await service.ping()).toBe(false);
  });

  it("has nothing to probe on the in-process store", async () => {
    expect(await createRateLimitService({}, null, quiet).ping()).toBeNull();
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

  // A key with no expiry is immortal, and its counter only ever climbs: that client
  // would be limited forever while the headers advertise a window that never ends.
  it("reapplies a missing expiry instead of leaving the key immortal", async () => {
    const upstash = fakeUpstash();
    const service = createRateLimitService({ ...CREDENTIALS }, upstash.fetchImpl, quiet);
    const app = limiterOn(service, "test:", 5);

    await request(app).get("/");
    upstash.stripExpiry("ada"); // as a half-applied write or a bare DECR would leave it
    const res = await request(app).get("/");

    expect([...upstash.keys.values()][0].expiresAt).not.toBeNull();
    expect(Number(res.headers["ratelimit-reset"] ?? 1)).toBeGreaterThan(0);
  });

  // DECR on a missing key creates it at -1 with no expiry. A limiter using
  // skipFailedRequests whose window lapsed mid-request would mint a permanently
  // negative counter, and that client could never reach the limit again.
  it("never creates a key by decrementing one that is gone", async () => {
    const upstash = fakeUpstash();
    const service = createRateLimitService({ ...CREDENTIALS }, upstash.fetchImpl, quiet);
    const store = service.store("test:");
    store.init({ windowMs: 60_000 });

    await store.decrement("vanished");
    expect(upstash.keys.size).toBe(0);
  });

  it("still decrements a counter that is live", async () => {
    const upstash = fakeUpstash();
    const service = createRateLimitService({ ...CREDENTIALS }, upstash.fetchImpl, quiet);
    const store = service.store("test:");
    store.init({ windowMs: 60_000 });

    await store.increment("ada");
    await store.increment("ada");
    await store.decrement("ada");
    expect(hitsFor(upstash.keys, "ada")).toBe(1);
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

  // These tests are about what a limiter does with a store error, so they ask for the
  // bare Upstash store (`degrade: false`) — the default store degrades and never errors.
  const limiter = (service, opts) =>
    rateLimit({
      windowMs: 60_000,
      limit: 5,
      store: service.store("test:", { degrade: false }),
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

  it("says upstash when it is configured, and proves it answered", async () => {
    const app = await makeApp(CREDENTIALS, { rateLimits: createRateLimitService(CREDENTIALS, fakeUpstash().fetchImpl, quiet) });
    const res = await request(app).get("/api/health");
    expect([res.body.rateLimitStore, res.body.rateLimitStoreReachable]).toEqual(["upstash", true]);
  });

  // The smoke test gates a release on this pair, so the unhappy one has to be real.
  it("admits the store is unreachable rather than reporting it configured", async () => {
    const upstash = fakeUpstash();
    upstash.breakWith({ ok: false, status: 401, text: async () => "unauthorized" });
    const app = await makeApp(CREDENTIALS, { rateLimits: createRateLimitService(CREDENTIALS, upstash.fetchImpl, quiet) });
    const res = await request(app).get("/api/health");
    expect([res.body.rateLimitStore, res.body.rateLimitStoreReachable]).toEqual(["upstash", false]);
    // And says so in the status code, which is all an uptime monitor reads.
    expect([res.status, res.body.status]).toEqual([503, "degraded"]);
  });

  // The probe is cached and runs on its own; a counter call that just failed is what
  // puts the limiters on memory, and only the breaker knows about it.
  it("reports when the limiters have fallen back to counting in this process", async () => {
    const service = createRateLimitService(CREDENTIALS, fakeUpstash().fetchImpl, quiet);
    const app = await makeApp(CREDENTIALS, { rateLimits: service });
    expect((await request(app).get("/api/health")).body.rateLimitFallbackActive).toBe(false);

    const failing = { prefix: "x:", init() {}, increment: async () => Promise.reject(new Error("timeout")) };
    const store = service.store("x:");
    store.primary = failing;
    store.init({ windowMs: 60_000 });
    await store.increment("ada");
    const res = await request(app).get("/api/health");
    expect([res.status, res.body.rateLimitFallbackActive]).toEqual([200, true]);
  });

  it("reports no fallback on the in-process store, where there is nothing to fall back from", async () => {
    expect((await request(await makeApp()).get("/api/health")).body.rateLimitFallbackActive).toBe(false);
  });
});

describe("degrading instead of failing when the shared store is down", () => {
  const appWith = (service, limit, storeOptions) => {
    const app = express();
    app.get(
      "/",
      rateLimit({
        windowMs: 60_000,
        limit,
        store: service.store("test:", storeOptions),
        keyGenerator: () => "ada",
        passOnStoreError: false,
        message: { error: { code: "RATE_LIMITED", message: "slow down" } },
      }),
      (_req, res) => res.json({ ok: true })
    );
    app.use(errorHandler(quiet));
    return app;
  };
  const broken = () => {
    const upstash = fakeUpstash();
    upstash.breakWith({ ok: false, status: 500, text: async () => "boom" });
    return upstash;
  };

  // The outage this exists for: Upstash deleted the idle free database and every AI
  // route answered 503 until someone noticed. The limit now keeps working, in-process.
  it("keeps enforcing the limit, counting in this process", async () => {
    const service = createRateLimitService({ ...CREDENTIALS }, broken().fetchImpl, quiet);
    const app = appWith(service, 2);

    expect((await request(app).get("/")).status).toBe(200);
    expect((await request(app).get("/")).status).toBe(200);
    // Not unlimited: failing open would let this through too.
    const third = await request(app).get("/");
    expect([third.status, third.body.error.code]).toEqual([429, "RATE_LIMITED"]);
  });

  // `degrade: false` must hand the error to the limiter, or AI_FAIL_CLOSED would be a
  // setting that changes nothing. What the limiter then does with it (503 through
  // failClosed) is covered in "when the counter cannot be reached" above.
  it("passes the error on when asked not to degrade", async () => {
    const service = createRateLimitService({ ...CREDENTIALS }, broken().fetchImpl, quiet);
    const store = service.store("test:", { degrade: false });
    store.init({ windowMs: 60_000 });
    await expect(store.increment("ada")).rejects.toThrow(/upstash responded 500/);
  });

  // Each Upstash call can take its full 2 s deadline when Upstash hangs. Without the
  // breaker every limited request would pay that for the length of the outage.
  it("stops calling the shared store for a while after it fails", async () => {
    const upstash = broken();
    const service = createRateLimitService({ ...CREDENTIALS }, upstash.fetchImpl, quiet);
    const app = appWith(service, 10);

    for (let i = 0; i < 4; i++) await request(app).get("/");
    expect(upstash.calls).toHaveLength(1);
  });

  it("tries the shared store again once the cool-down has passed", async () => {
    let now = 0;
    const breaker = createBreaker({ coolDownMs: 30_000, now: () => now });
    let calls = 0;
    const primary = {
      prefix: "test:",
      init() {},
      async increment() {
        calls++;
        throw new Error("down");
      },
    };
    const store = new FallbackStore(primary, breaker, quiet);
    store.init({ windowMs: 60_000 });

    await store.increment("ada");
    await store.increment("ada");
    expect(calls).toBe(1);
    now = 30_001;
    await store.increment("ada");
    expect(calls).toBe(2);
  });

  // Letting everyone through at the end of the cool-down would send a burst of 2 s calls,
  // and a burst of log lines, at an Upstash that is still down, every 30 s.
  it("lets exactly one probe through after the cool-down, and closes when it succeeds", async () => {
    let now = 0;
    const breaker = createBreaker({ coolDownMs: 30_000, now: () => now });
    let calls = 0;
    let healthy = false;
    let release;
    const primary = {
      prefix: "test:",
      init() {},
      async increment() {
        calls++;
        if (!healthy) throw new Error("down");
        if (calls === 2) await new Promise((r) => (release = r)); // hold the probe open
        return { totalHits: 1, resetTime: undefined };
      },
    };
    const store = new FallbackStore(primary, breaker, quiet);
    store.init({ windowMs: 60_000 });

    await store.increment("ada");
    expect(calls).toBe(1);
    now = 30_001;
    healthy = true;
    const probe = store.increment("ada"); // the probe, held open
    await Promise.all([store.increment("ada"), store.increment("ada")]); // others stay on memory
    expect(calls).toBe(2);
    expect(breaker.isOpen()).toBe(true);

    release();
    await probe;
    expect(breaker.isOpen()).toBe(false);
    await store.increment("ada");
    expect(calls).toBe(3);
  });

  it("re-opens for another cool-down when the probe fails", async () => {
    let now = 0;
    const breaker = createBreaker({ coolDownMs: 30_000, now: () => now });
    let calls = 0;
    const primary = { prefix: "t:", init() {}, increment: async () => (calls++, Promise.reject(new Error("down"))) };
    const store = new FallbackStore(primary, breaker, quiet);
    store.init({ windowMs: 60_000 });
    await store.increment("ada");
    now = 30_001;
    await store.increment("ada"); // probe fails
    now = 40_000;
    await store.increment("ada");
    expect(calls).toBe(2);
  });

  // After an outage the client may have hits in either store; clearing one would leave
  // the other still limiting them.
  it("resets a key in both stores", async () => {
    const breaker = createBreaker();
    const reset = [];
    const primary = { prefix: "t:", init() {}, increment: async () => ({ totalHits: 1 }), resetKey: async (k) => reset.push(k) };
    const store = new FallbackStore(primary, breaker, quiet);
    store.init({ windowMs: 60_000 });
    await store.memory.increment("ada");
    await store.resetKey("ada");
    expect(reset).toEqual(["ada"]);
    expect((await store.memory.get("ada"))?.totalHits ?? 0).toBe(0);
  });

  it("still clears the in-process count when the shared store fails the reset", async () => {
    const breaker = createBreaker();
    const primary = { prefix: "t:", init() {}, resetKey: async () => Promise.reject(new Error("down")) };
    const store = new FallbackStore(primary, breaker, quiet);
    store.init({ windowMs: 60_000 });
    await store.memory.increment("ada");
    await expect(store.resetKey("ada")).resolves.toBeUndefined();
    expect((await store.memory.get("ada"))?.totalHits ?? 0).toBe(0);
    expect(breaker.isOpen()).toBe(true);
  });

  it("logs the failure once per trip, even when requests fail concurrently", async () => {
    const logged = [];
    const breaker = createBreaker();
    const primary = { prefix: "t:", init() {}, increment: async () => Promise.reject(new Error("down")) };
    const store = new FallbackStore(primary, breaker, { error: (m) => logged.push(m) });
    store.init({ windowMs: 60_000 });
    await Promise.all([store.increment("a"), store.increment("b"), store.increment("c")]);
    expect(logged).toHaveLength(1);
  });

  it("logs the failure once per trip, not once per request", async () => {
    const logged = [];
    const service = createRateLimitService({ ...CREDENTIALS }, broken().fetchImpl, { error: (m) => logged.push(m) });
    const app = appWith(service, 10);
    for (let i = 0; i < 5; i++) await request(app).get("/");
    expect(logged.filter((m) => String(m).includes("[rate-limit] shared store failed"))).toHaveLength(1);
  });

  it("counts in Upstash, not in memory, while Upstash answers", async () => {
    const upstash = fakeUpstash();
    const service = createRateLimitService({ ...CREDENTIALS }, upstash.fetchImpl, quiet);
    await request(appWith(service, 5)).get("/");
    expect(hitsFor(upstash.keys, "ada")).toBe(1);
  });
});

describe("the AI routes when the shared store is down", () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  // The limiters are skipped under NODE_ENV=test, so these run the real app as
  // development to exercise them end to end.
  const aiAppWith = async (overrides = {}) => {
    const upstash = fakeUpstash();
    upstash.breakWith({ ok: false, status: 500, text: async () => "boom" });
    const config = { NODE_ENV: "development", ...CREDENTIALS, ...overrides };
    return makeApp(config, { rateLimits: createRateLimitService(config, upstash.fetchImpl, quiet) });
  };
  const summary = { role: "Engineer", experience: "3 years", keySkills: "Go" };

  it("keeps answering by default", async () => {
    const agent = await signedInAgent(await aiAppWith());
    const res = await agent.post("/api/ai/summary").send(summary);
    expect([res.status, res.body.text]).toEqual([200, "A great summary."]);
  });

  it("answers 503 when AI_FAIL_CLOSED is set, as it should with a paid key", async () => {
    const agent = await signedInAgent(await aiAppWith({ AI_FAIL_CLOSED: "true" }));
    const res = await agent.post("/api/ai/summary").send(summary);
    expect([res.status, res.body.error.code]).toEqual([503, "RATE_LIMIT_UNAVAILABLE"]);
  });
});
