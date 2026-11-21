import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { makeApp, startMongo, stopMongo, signedInAgent, fakeAi } from "./helpers.js";
import { CREDENTIALS, quiet, fakeUpstash } from "./fakeUpstash.js";
import { createAiQuota, AI_COSTS, TOKEN_ESTIMATES } from "../src/services/aiQuota.js";
import { createBreaker } from "../src/services/rateLimit/fallback.js";
import { createRateLimitService } from "../src/services/rateLimit/index.js";
import { HttpError } from "../src/middleware/errors.js";

beforeAll(startMongo, 120_000);
afterAll(stopMongo);

const config = (over = {}) => ({ AI_DAILY_CREDITS_PER_USER: 30, AI_DAILY_TOKENS_GLOBAL: 180_000, AI_FAIL_CLOSED: false, ...over });
const at = (iso) => () => new Date(iso);
const summary = { role: "Engineer", experience: "3 years", keySkills: "Go" };

describe("the daily AI allowance", () => {
  it("costs a summary and a bullet one credit, and an import five", () => {
    expect(AI_COSTS).toEqual({ summary: 1, improve: 1, import: 5 });
  });

  it("spends credits and reports what is left", async () => {
    const quota = createAiQuota(config(), { log: quiet });
    const usage = await quota.reserve("ada", 5);
    expect(usage).toMatchObject({ used: 5, limit: 30, remaining: 25, available: true });
  });

  it("refuses the credit past the limit with 429, saying when it resets", async () => {
    const quota = createAiQuota(config({ AI_DAILY_CREDITS_PER_USER: 3 }), { log: quiet, now: at("2026-11-21T20:00:00Z") });
    await quota.reserve("ada", 3);
    const err = await quota.reserve("ada", 1).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect([err.status, err.code]).toEqual([429, "AI_QUOTA_EXCEEDED"]);
    // Four hours to midnight UTC, which is 05:30 IST.
    expect(err.headers["Retry-After"]).toBe(String(4 * 60 * 60));
  });

  it("does not let one account's use touch another's", async () => {
    const quota = createAiQuota(config({ AI_DAILY_CREDITS_PER_USER: 1 }), { log: quiet });
    await quota.reserve("ada", 1);
    await expect(quota.reserve("grace", 1)).resolves.toMatchObject({ used: 1 });
  });

  it("starts every UTC day from zero", async () => {
    let now = new Date("2026-11-21T23:59:00Z");
    const quota = createAiQuota(config({ AI_DAILY_CREDITS_PER_USER: 1 }), { log: quiet, now: () => now });
    await quota.reserve("ada", 1);
    await expect(quota.reserve("ada", 1)).rejects.toMatchObject({ code: "AI_QUOTA_EXCEEDED" });
    now = new Date("2026-11-22T00:00:01Z");
    await expect(quota.reserve("ada", 1)).resolves.toMatchObject({ used: 1, resetsAt: "2026-11-23T00:00:00.000Z" });
  });

  it("gives a receipt's credits back on refund, never below zero", async () => {
    const quota = createAiQuota(config(), { log: quiet });
    const { receipt } = await quota.reserve("ada", 1);
    await quota.refund(receipt);
    await quota.refund(receipt);
    expect(await quota.usage("ada")).toMatchObject({ used: 0, remaining: 30 });
  });

  it("turns everybody away once the app's token budget is spent", async () => {
    const quota = createAiQuota(config({ AI_DAILY_TOKENS_GLOBAL: 1000 }), { log: quiet });
    await quota.recordTokens(1000);
    const err = await quota.reserve("grace", 1).catch((e) => e);
    expect([err.status, err.code]).toEqual([503, "AI_BUDGET_EXHAUSTED"]);
    expect(await quota.usage("grace")).toMatchObject({ available: false });
  });
});

describe("in Upstash", () => {
  const quotaOn = (upstash, over = {}, extra = {}) =>
    createAiQuota(config(over), { command: createRateLimitService(CREDENTIALS, upstash.fetchImpl, quiet).command, log: quiet, ...extra });

  // Two warm serverless instances must share one count, or the limit is multiplied.
  it("counts against one shared allowance across instances", async () => {
    const upstash = fakeUpstash();
    const first = quotaOn(upstash, { AI_DAILY_CREDITS_PER_USER: 2 });
    const second = quotaOn(upstash, { AI_DAILY_CREDITS_PER_USER: 2 });
    await first.reserve("ada", 1);
    await second.reserve("ada", 1);
    await expect(first.reserve("ada", 1)).rejects.toMatchObject({ code: "AI_QUOTA_EXCEEDED" });
  });

  it("keys every counter by day and gives it an expiry", async () => {
    const upstash = fakeUpstash();
    const quota = quotaOn(upstash, {}, { now: at("2026-11-21T10:00:00Z") });
    await quota.reserve("ada", 1);
    await quota.recordTokens(500);
    expect([...upstash.keys.keys()].sort()).toEqual(["ai:quota:tokens:2026-11-21", "ai:quota:user:ada:2026-11-21"]);
    for (const entry of upstash.keys.values()) expect(entry.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refunds and reads usage there too", async () => {
    const upstash = fakeUpstash();
    const quota = quotaOn(upstash);
    const { receipt } = await quota.reserve("ada", 5);
    await quota.refund(receipt);
    expect(await quota.usage("ada")).toMatchObject({ used: 0 });
  });

  it("keeps enforcing the allowance in-process when Upstash is down", async () => {
    const upstash = fakeUpstash();
    upstash.breakWith({ ok: false, status: 500, text: async () => "boom" });
    const quota = quotaOn(upstash, { AI_DAILY_CREDITS_PER_USER: 1 }, { breaker: createBreaker() });
    await quota.reserve("ada", 1);
    await expect(quota.reserve("ada", 1)).rejects.toMatchObject({ code: "AI_QUOTA_EXCEEDED" });
  });

  it("refuses instead when AI_FAIL_CLOSED is set", async () => {
    const upstash = fakeUpstash();
    upstash.breakWith({ ok: false, status: 500, text: async () => "boom" });
    const quota = quotaOn(upstash, { AI_FAIL_CLOSED: true }, { breaker: createBreaker() });
    await expect(quota.reserve("ada", 1)).rejects.toMatchObject({ status: 503, code: "RATE_LIMIT_UNAVAILABLE" });
  });
});

describe("the AI routes with the allowance", () => {
  const counting = (over = {}) => {
    const calls = [];
    const ai = {
      ...fakeAi,
      summary: async (body, opts) => (calls.push(body), opts?.onTokens?.(400), "A great summary."),
      ...over,
    };
    return { ai, calls };
  };

  it("returns the usage after the charge with each answer", async () => {
    const agent = await signedInAgent(await makeApp());
    const res = await agent.post("/api/ai/summary").send(summary).expect(200);
    expect(res.body).toMatchObject({ text: "A great summary.", usage: { used: 1, limit: 30, remaining: 29 } });
  });

  it("charges an import five credits", async () => {
    const agent = await signedInAgent(await makeApp());
    const res = await agent.post("/api/ai/import").send({ text: "x".repeat(300) }).expect(200);
    expect(res.body.usage).toMatchObject({ used: 5 });
  });

  it("answers 429 past the allowance without calling the provider", async () => {
    const { ai, calls } = counting();
    const agent = await signedInAgent(await makeApp({ AI_DAILY_CREDITS_PER_USER: "2" }, { ai }));
    await agent.post("/api/ai/summary").send(summary).expect(200);
    await agent.post("/api/ai/summary").send(summary).expect(200);
    const res = await agent.post("/api/ai/summary").send(summary);
    expect([res.status, res.body.error.code]).toEqual([429, "AI_QUOTA_EXCEEDED"]);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(calls).toHaveLength(2);
  });

  it("does not charge for a request that fails validation", async () => {
    const agent = await signedInAgent(await makeApp());
    await agent.post("/api/ai/summary").send({}).expect(400);
    expect((await agent.get("/api/ai/usage").expect(200)).body).toMatchObject({ used: 0 });
  });

  // No reply was produced, so the user got nothing for it.
  it("refunds the credit when no reply came back, but still counts the tokens it spent", async () => {
    const ai = {
      ...fakeAi,
      summary: async (_body, opts) => {
        opts.onTokens(900);
        throw Object.assign(new HttpError(504, "AI provider timed out", "AI_TIMEOUT"), { refundable: true });
      },
    };
    // 900 spent plus the cheapest estimate (1,000) no longer fits in 1,800.
    const app = await makeApp({ AI_DAILY_TOKENS_GLOBAL: "1800" }, { ai });
    const agent = await signedInAgent(app);
    await agent.post("/api/ai/summary").send(summary).expect(504);
    const usage = (await agent.get("/api/ai/usage")).body;
    expect(usage).toMatchObject({ used: 0, available: false });
  });

  it("closes AI for everyone once the day's tokens are spent", async () => {
    const { ai } = counting({ summary: async (_b, opts) => (opts.onTokens(1200), "A great summary.") });
    // 1,200 spent; the next summary's 1,500 estimate no longer fits in 2,000.
    const app = await makeApp({ AI_DAILY_TOKENS_GLOBAL: "2000" }, { ai });
    await (await signedInAgent(app, "ada@example.com")).post("/api/ai/summary").send(summary).expect(200);
    const res = await (await signedInAgent(app, "grace@example.com")).post("/api/ai/summary").send(summary);
    expect([res.status, res.body.error.code]).toEqual([503, "AI_BUDGET_EXHAUSTED"]);
  });

  it("reports today's usage, and only to the account it belongs to", async () => {
    const app = await makeApp();
    await request(app).get("/api/ai/usage").expect(401);
    const agent = await signedInAgent(app);
    const usage = (await agent.get("/api/ai/usage").expect(200)).body;
    expect(usage).toMatchObject({ used: 0, limit: 30, remaining: 30, available: true });
    expect(new Date(usage.resetsAt).getUTCHours()).toBe(0);
  });
});

describe("receipts: a refund or settlement goes where the charge went", () => {
  const quotaOn = (upstash, extra = {}, over = {}) =>
    createAiQuota(config(over), { command: createRateLimitService(CREDENTIALS, upstash.fetchImpl, quiet).command, log: quiet, ...extra });

  it("refunds in memory a charge taken in memory, even if Upstash is back by then", async () => {
    let now = 0;
    const breaker = createBreaker({ now: () => now });
    const upstash = fakeUpstash();
    const quota = quotaOn(upstash, { breaker });
    breaker.trip(); // Upstash just failed elsewhere: this charge lands in memory
    const { receipt } = await quota.reserve("ada", 5);
    expect(receipt.backend).toBe("memory");

    now = 60_000; // breaker cooled down; Upstash answers again
    await quota.refund(receipt);
    expect(upstash.keys.size).toBe(0); // Redis was never decremented for a charge it never took
  });

  it("does not refund a Redis charge into memory when Redis fails at refund time", async () => {
    const upstash = fakeUpstash();
    const quota = quotaOn(upstash, { breaker: createBreaker() });
    const { receipt } = await quota.reserve("ada", 5);
    expect(receipt.backend).toBe("redis");
    upstash.breakWith({ ok: false, status: 500, text: async () => "boom" });
    await quota.refund(receipt); // best effort: logged, nothing thrown, memory untouched
    expect(quota.memorySize()).toBe(0);
  });

  it("refunds against the day it was charged, across midnight UTC", async () => {
    let now = new Date("2026-11-21T23:59:59Z");
    const quota = createAiQuota(config({ AI_DAILY_CREDITS_PER_USER: 5 }), { log: quiet, now: () => now });
    const { receipt } = await quota.reserve("ada", 5);
    now = new Date("2026-11-22T00:00:05Z");
    await quota.reserve("ada", 5); // the new day's allowance, all of it
    await quota.refund(receipt); // yesterday's failed call
    expect(await quota.usage("ada")).toMatchObject({ used: 5 }); // today's charge stands
  });
});

describe("the app-wide token budget", () => {
  it("reserves an estimate up front, so simultaneous calls cannot overrun it together", async () => {
    const quota = createAiQuota(config({ AI_DAILY_TOKENS_GLOBAL: 180_000 }), { log: quiet });
    await quota.recordTokens(176_000);
    const results = await Promise.allSettled(["ada", "grace", "alan"].map((u) => quota.reserve(u, 1, TOKEN_ESTIMATES.summary)));
    // 176,000 + 1,500 + 1,500 fits; a third 1,500 would not.
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect(results[2].reason.code).toBe("AI_BUDGET_EXHAUSTED");
  });

  it("settles the estimate against what the call used, and reports availability after it", async () => {
    const quota = createAiQuota(config({ AI_DAILY_TOKENS_GLOBAL: 3000 }), { log: quiet });
    const { receipt, available } = await quota.reserve("ada", 1, 1500);
    expect(available).toBe(true);
    const after = await quota.settle(receipt, 2500); // the call used more than estimated
    expect(after.available).toBe(false); // 2,500 + the cheapest estimate no longer fits
  });

  it("gives the whole estimate back when the call never reached the provider", async () => {
    const quota = createAiQuota(config({ AI_DAILY_TOKENS_GLOBAL: 3000 }), { log: quiet });
    const { receipt } = await quota.reserve("ada", 1, 1500);
    expect((await quota.settle(receipt, 0)).available).toBe(true);
    await expect(quota.reserve("grace", 1, 1500)).resolves.toBeTruthy();
    await expect(quota.reserve("alan", 1, 1500)).resolves.toBeTruthy();
  });

  it("closes for the rest of the day when the provider reports its daily limit", async () => {
    const quota = createAiQuota(config(), { log: quiet });
    await quota.exhaust();
    await expect(quota.reserve("ada", 1, 1000)).rejects.toMatchObject({ code: "AI_BUDGET_EXHAUSTED" });
  });
});

describe("the in-process fallback", () => {
  // Keys carry the day, so yesterday's are never read again; without a sweep a long-lived
  // process would keep one per active user per day forever.
  it("drops expired days' entries", async () => {
    let now = new Date("2026-11-21T10:00:00Z");
    const quota = createAiQuota(config(), { log: quiet, now: () => now });
    for (const u of ["a", "b", "c"]) await quota.reserve(u, 1, 100);
    expect(quota.memorySize()).toBe(4); // three users + the day's tokens
    now = new Date("2026-11-24T10:00:00Z"); // past the two-day expiry
    await quota.reserve("d", 1, 100);
    expect(quota.memorySize()).toBe(2);
  });
});

describe("AI_FAIL_CLOSED and the shared breaker", () => {
  // A login limiter's single timeout trips the shared breaker; under fail-closed the
  // quota must still try Redis rather than refuse every AI call for 30 s.
  it("tries Redis even while the breaker is open, and succeeds if it answers", async () => {
    const upstash = fakeUpstash();
    const breaker = createBreaker();
    breaker.trip();
    const quota = createAiQuota(config({ AI_FAIL_CLOSED: true }), {
      command: createRateLimitService(CREDENTIALS, upstash.fetchImpl, quiet).command,
      breaker,
      log: quiet,
    });
    const { receipt } = await quota.reserve("ada", 1, 100);
    expect(receipt.backend).toBe("redis");
  });
});

describe("the AI routes: refunds, settlement and provider limits", () => {
  const summaryBody = { role: "Engineer", experience: "3 years", keySkills: "Go" };

  // A reply arrived; user input can make it unusable, so refunding it would let anyone
  // get unlimited calls by making them fail on purpose.
  it("keeps the charge when a reply came back but was unusable", async () => {
    const ai = {
      ...fakeAi,
      parseResume: async (_b, opts) => {
        opts.onTokens(3000);
        throw new HttpError(502, "The AI provider returned malformed JSON", "AI_BAD_JSON");
      },
    };
    const agent = await signedInAgent(await makeApp({}, { ai }));
    await agent.post("/api/ai/import").send({ text: "x".repeat(300) }).expect(502);
    expect((await agent.get("/api/ai/usage")).body).toMatchObject({ used: 5 });
  });

  it("refunds a provider HTTP error and counts no tokens for it", async () => {
    const ai = {
      ...fakeAi,
      summary: async () => {
        throw Object.assign(new HttpError(502, "The groq request failed", "AI_UPSTREAM"), { refundable: true });
      },
    };
    // Exactly one summary's estimate: if the failed call kept any tokens, the next would not fit.
    const app = await makeApp({ AI_DAILY_TOKENS_GLOBAL: "1500" }, { ai });
    const agent = await signedInAgent(app);
    await agent.post("/api/ai/summary").send(summaryBody).expect(502);
    expect((await agent.get("/api/ai/usage")).body).toMatchObject({ used: 0, available: true });
  });

  // On serverless, work after the response may never run.
  it("settles the tokens before the response is sent", async () => {
    const events = [];
    const real = createAiQuota(config(), { log: quiet });
    const aiQuota = {
      ...real,
      settle: async (...args) => {
        await new Promise((r) => setTimeout(r, 20));
        events.push("settled");
        return real.settle(...args);
      },
    };
    const agent = await signedInAgent(await makeApp({}, { aiQuota }));
    await agent.post("/api/ai/summary").send(summaryBody).expect(200);
    expect(events).toEqual(["settled"]);
  });

  it("closes AI for the day when the provider says its daily limit is reached", async () => {
    let calls = 0;
    const ai = {
      ...fakeAi,
      summary: async () => {
        calls++;
        throw Object.assign(new HttpError(503, "AI has reached today’s capacity", "AI_BUDGET_EXHAUSTED"), { refundable: true, dailyLimit: true });
      },
    };
    const app = await makeApp({}, { ai });
    const agent = await signedInAgent(app);
    await agent.post("/api/ai/summary").send(summaryBody).expect(503);
    const second = await agent.post("/api/ai/summary").send(summaryBody);
    expect([second.status, second.body.error.code, calls]).toEqual([503, "AI_BUDGET_EXHAUSTED", 1]);
    expect((await agent.get("/api/ai/usage")).body).toMatchObject({ used: 0, available: false });
  });

  // Each read is an Upstash command, and Upstash's free tier has a daily ceiling.
  it("limits how often the usage meter can be read", async () => {
    const agent = await signedInAgent(await makeApp());
    for (let i = 0; i < 30; i++) await agent.get("/api/ai/usage").expect(200);
    const res = await agent.get("/api/ai/usage");
    expect([res.status, res.body.error.code]).toEqual([429, "RATE_LIMITED"]);
  });
});
