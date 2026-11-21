import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { makeApp, startMongo, stopMongo, signedInAgent, fakeAi } from "./helpers.js";
import { CREDENTIALS, quiet, fakeUpstash } from "./fakeUpstash.js";
import { createAiQuota, AI_COSTS } from "../src/services/aiQuota.js";
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

  it("gives credits back on refund, never below zero", async () => {
    const quota = createAiQuota(config(), { log: quiet });
    await quota.reserve("ada", 1);
    await quota.refund("ada", 5);
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
    await quota.reserve("ada", 5);
    await quota.refund("ada", 5);
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

  // Validation already passed, so a failure past it is ours or the provider's.
  it("refunds the credit when the call fails, but still counts the tokens it spent", async () => {
    const ai = {
      ...fakeAi,
      summary: async (_body, opts) => {
        opts.onTokens(900);
        throw new HttpError(502, "The groq request failed", "AI_UPSTREAM");
      },
    };
    const app = await makeApp({ AI_DAILY_TOKENS_GLOBAL: "900" }, { ai });
    const agent = await signedInAgent(app);
    await agent.post("/api/ai/summary").send(summary).expect(502);
    const usage = (await agent.get("/api/ai/usage")).body;
    expect(usage).toMatchObject({ used: 0, available: false });
  });

  it("closes AI for everyone once the day's tokens are spent", async () => {
    const { ai } = counting({ summary: async (_b, opts) => (opts.onTokens(1200), "A great summary.") });
    const app = await makeApp({ AI_DAILY_TOKENS_GLOBAL: "1000" }, { ai });
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
