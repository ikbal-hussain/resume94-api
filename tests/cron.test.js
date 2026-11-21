import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { makeApp, startMongo, stopMongo } from "./helpers.js";
import { CREDENTIALS, quiet, fakeUpstash } from "./fakeUpstash.js";
import { createRateLimitService } from "../src/services/rateLimit/index.js";
import { loadConfig } from "../src/config.js";

beforeAll(startMongo, 120_000);
afterAll(stopMongo);

const SECRET = "cron-secret-0123456789abcdef";
const PATH = "/api/cron/keepalive";

async function appWith(overrides = {}, upstash = fakeUpstash()) {
  const config = { ...CREDENTIALS, CRON_SECRET: SECRET, ...overrides };
  const app = await makeApp(config, { rateLimits: createRateLimitService(config, upstash.fetchImpl, quiet) });
  return { app, upstash };
}

describe("weekly keep-alive", () => {
  // Off unless configured, and indistinguishable from a path that does not exist.
  it("does not exist while CRON_SECRET is unset", async () => {
    const app = await makeApp();
    const res = await request(app).get(PATH).set("Authorization", `Bearer ${SECRET}`);
    expect([res.status, res.body.error.code]).toEqual([404, "NOT_FOUND"]);
  });

  it("refuses a request without the bearer secret", async () => {
    const { app, upstash } = await appWith();
    const res = await request(app).get(PATH);
    expect([res.status, res.body.error.code]).toEqual([401, "UNAUTHENTICATED"]);
    expect(upstash.calls).toHaveLength(0);
  });

  it("refuses a wrong secret, including one of the same length", async () => {
    const { app, upstash } = await appWith();
    const sameLength = SECRET.replace(/.$/, "X");
    for (const token of ["nope", sameLength]) {
      const res = await request(app).get(PATH).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
    }
    expect(upstash.calls).toHaveLength(0);
  });

  it("writes exactly one key of its own with the right secret", async () => {
    const { app, upstash } = await appWith();
    const res = await request(app).get(PATH).set("Authorization", `Bearer ${SECRET}`);

    expect(res.status).toBe(200);
    expect(res.body.kept).toBe(true);
    expect(upstash.calls).toHaveLength(1);
    // Its own key, never a rate-limit counter, so it cannot change anyone's limit.
    expect([...upstash.keys.keys()]).toEqual(["keepalive:last-run"]);
    expect(upstash.keys.get("keepalive:last-run").value).toBe(res.body.at);
  });

  it("says there is nothing to keep alive on the in-process store", async () => {
    const app = await makeApp({ CRON_SECRET: SECRET });
    const res = await request(app).get(PATH).set("Authorization", `Bearer ${SECRET}`);
    expect([res.status, res.body.kept]).toEqual([200, false]);
  });

  it("reports a failed write as 503 rather than throwing past the handler", async () => {
    const upstash = fakeUpstash();
    upstash.breakWith({ ok: false, status: 500, text: async () => "boom" });
    const { app } = await appWith({}, upstash);
    const res = await request(app).get(PATH).set("Authorization", `Bearer ${SECRET}`);
    expect([res.status, res.body.error.code]).toEqual([503, "KEEPALIVE_FAILED"]);
  });

  it("rejects a secret too short to be one", () => {
    expect(() => loadConfig({ NODE_ENV: "test", JWT_SECRET: "x".repeat(32), CRON_SECRET: "short" })).toThrow(
      /CRON_SECRET/
    );
  });
});
