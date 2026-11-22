import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { makeApp, signedInAgent, startMongo, stopMongo, fakeAi } from "./helpers.js";
import { errorHandler, HttpError } from "../src/middleware/errors.js";
import { createErrorTracker, scrubEvent, FLUSH_TIMEOUT_MS } from "../src/services/errorTracking.js";

beforeAll(startMongo, 120_000);
afterAll(stopMongo);

const quiet = { error() {}, info() {}, warn() {} };
// A made-up DSN in Sentry's format. Nothing is sent: the SDK below is a fake.
const DSN = "https://publickey@o0.ingest.sentry.io/0";

/** Records what the error handler reports, and when it finished reporting. */
function fakeTracker({ delayMs = 0 } = {}) {
  const captured = [];
  return {
    captured,
    configured: true,
    async capture(err, where) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      captured.push({ err, where });
    },
    async flush() {},
  };
}

/** A stand-in for @sentry/node: enough surface for createErrorTracker, and a record. */
function fakeSentry() {
  const sdk = {
    inits: [],
    captured: [],
    flushes: [],
    client: undefined,
    getClient: () => sdk.client,
    init(options) {
      sdk.inits.push(options);
      sdk.client = {};
    },
    captureException(err, hint) {
      sdk.captured.push({ err, hint });
    },
    async flush(timeout) {
      sdk.flushes.push(timeout);
      return true;
    },
  };
  for (const name of [
    "eventFiltersIntegration", "functionToStringIntegration", "linkedErrorsIntegration", "dedupeIntegration",
    "onUncaughtExceptionIntegration", "onUnhandledRejectionIntegration", "contextLinesIntegration", "nodeContextIntegration",
  ]) sdk[name] = () => ({ name });
  return sdk;
}

function appThatThrows(errors) {
  const app = express();
  app.get("/boom", () => {
    throw new Error("database exploded");
  });
  app.get("/upstream", () => {
    throw new HttpError(502, "The groq request failed", "AI_UPSTREAM");
  });
  app.get("/budget", () => {
    throw new HttpError(503, "AI is resting", "AI_BUDGET_EXHAUSTED");
  });
  app.get("/missing", () => {
    throw new HttpError(404, "Resume not found", "NOT_FOUND");
  });
  app.get("/aborted", () => {
    // What body-parser raises when the client hangs up mid-upload: not an HttpError.
    throw Object.assign(new Error("request aborted"), { status: 400, type: "request.aborted" });
  });
  app.post("/invalid", express.json(), () => {
    throw new HttpError(400, "Invalid request", "VALIDATION_ERROR");
  });
  app.use(errorHandler(quiet, errors));
  return app;
}

describe("error tracking: what reaches it", () => {
  it("reports an unexpected 500 with its route, and still answers the error envelope", async () => {
    const errors = fakeTracker();
    const res = await request(appThatThrows(errors)).get("/boom?token=secret");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL");
    expect(errors.captured).toHaveLength(1);
    expect(errors.captured[0].err.message).toBe("database exploded");
    // The pattern, never the URL: no query string, no ids.
    expect(errors.captured[0].where).toEqual({ method: "GET", route: "/boom" });
  });

  it("reports a 5xx HttpError such as a failing AI provider", async () => {
    const errors = fakeTracker();
    await request(appThatThrows(errors)).get("/upstream").expect(502);
    expect(errors.captured.map((c) => c.err.code)).toEqual(["AI_UPSTREAM"]);
  });

  it("does not report a 4xx: those are the client's mistake", async () => {
    const errors = fakeTracker();
    const app = appThatThrows(errors);
    await request(app).get("/missing").expect(404);
    await request(app).post("/invalid").send({ name: "Ada" }).expect(400);
    await request(app).post("/invalid").set("Content-Type", "application/json").send("{not json").expect(400);
    await request(app).get("/aborted"); // answered 500 as before, but not reported
    expect(errors.captured).toEqual([]);
  });

  it("does not report a 503 the API answers by design", async () => {
    // The daily AI budget running out would otherwise be one event per AI request.
    const errors = fakeTracker();
    await request(appThatThrows(errors)).get("/budget").expect(503);
    expect(errors.captured).toEqual([]);
  });

  it("finishes reporting before the response is sent", async () => {
    // On Vercel the function freezes once the response is out; an event still queued
    // then is lost. A handler that responded first would arrive with nothing captured.
    const errors = fakeTracker({ delayMs: 50 });
    await request(appThatThrows(errors)).get("/boom").expect(500);
    expect(errors.captured).toHaveLength(1);
  });

  it("is wired into the real app", async () => {
    const errors = fakeTracker();
    const ai = { ...fakeAi, summary: async () => { throw new Error("provider SDK bug"); } };
    const app = await makeApp({}, { ai, errors });
    const agent = await signedInAgent(app);
    await agent.post("/api/ai/summary").send({ role: "Dev", experience: "2 years", keySkills: "React" }).expect(500);
    await agent.get("/api/resumes/000000000000000000000000").expect(404);
    expect(errors.captured.map((c) => c.where)).toEqual([{ method: "POST", route: "/api/ai/summary" }]);
  });

  it("groups by path pattern, without ids", async () => {
    const errors = fakeTracker();
    const app = express();
    app.use("/api/resumes", express.Router().get("/:id/copy", () => { throw new Error("x"); }));
    app.use(errorHandler(quiet, errors));
    await request(app).get("/api/resumes/65a1b2c3d4e5f60718293a4b/copy?x=1").expect(500);
    expect(errors.captured[0].where).toEqual({ method: "GET", route: "/api/resumes/:id/copy" });
  });

  it("reports on /api/health whether it is configured", async () => {
    const off = await request(await makeApp()).get("/api/health");
    expect(off.body.errorTrackingConfigured).toBe(false);
    const on = await request(await makeApp({}, { errors: fakeTracker() })).get("/api/health");
    expect(on.body.errorTrackingConfigured).toBe(true);
  });
});

describe("error tracking: the Sentry client", () => {
  it("loads nothing without SENTRY_DSN", async () => {
    let loaded = false;
    const load = async () => { loaded = true; return fakeSentry(); };
    for (const SENTRY_DSN of [undefined, "", "   "]) {
      const tracker = createErrorTracker({ SENTRY_DSN }, { load });
      expect(tracker.configured).toBe(false);
      await tracker.capture(new Error("x"));
    }
    expect(loaded).toBe(false);
  });

  it("initialises once, privately, with no tracing", async () => {
    const sdk = fakeSentry();
    const config = { SENTRY_DSN: DSN, NODE_ENV: "production", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "abc123" };
    const tracker = createErrorTracker(config, { load: async () => sdk });
    createErrorTracker(config, { load: async () => sdk }); // a retried start
    await tracker.flush();

    expect(sdk.inits).toHaveLength(1);
    const options = sdk.inits[0];
    expect(options).toMatchObject({ dsn: DSN, environment: "preview", release: "abc123", tracesSampleRate: 0, defaultIntegrations: false });
    // None of the integrations that read requests, console output, outgoing calls or locals.
    const names = options.integrations.map((i) => i.name);
    expect(names).toHaveLength(8);
    for (const unwanted of ["requestDataIntegration", "consoleIntegration", "httpIntegration", "nativeNodeFetchIntegration", "localVariablesIntegration"]) {
      expect(names).not.toContain(unwanted);
    }
    expect(options.dataCollection).toMatchObject({
      userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, stackFrameVariables: false,
    });
    expect(options.beforeSend).toBe(scrubEvent);
  });

  it("falls back to NODE_ENV off Vercel", async () => {
    const sdk = fakeSentry();
    await createErrorTracker({ SENTRY_DSN: DSN, NODE_ENV: "development" }, { load: async () => sdk }).flush();
    expect(sdk.inits[0]).toMatchObject({ environment: "development", release: undefined });
  });

  it("flushes right after capturing, with a short deadline", async () => {
    const sdk = fakeSentry();
    const tracker = createErrorTracker({ SENTRY_DSN: DSN }, { load: async () => sdk });
    const err = new Error("boom");
    await tracker.capture(err, { method: "GET", route: "/api/resumes/:id" });
    expect(sdk.captured).toEqual([{ err, hint: { tags: { method: "GET", route: "/api/resumes/:id" } } }]);
    expect(sdk.flushes).toEqual([FLUSH_TIMEOUT_MS]);
    expect(FLUSH_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });

  it("never throws, even when the SDK cannot load or send", async () => {
    const broken = createErrorTracker({ SENTRY_DSN: DSN }, { log: quiet, load: async () => { throw new Error("no module"); } });
    await expect(broken.capture(new Error("x"))).resolves.toBeUndefined();

    const sdk = fakeSentry();
    sdk.flush = async () => { throw new Error("network down"); };
    const flaky = createErrorTracker({ SENTRY_DSN: DSN }, { log: quiet, load: async () => sdk });
    await expect(flaky.capture(new Error("x"))).resolves.toBeUndefined();
  });
});

describe("error tracking: scrubbing", () => {
  const event = () => ({
    message: "failed for ada@example.com",
    request: {
      method: "PUT",
      url: "https://api.example.com/api/resumes/abc?token=reset-secret",
      data: { title: "My Resume", data: { name: "Ada Lovelace", email: "ada@example.com" } },
      cookies: { token: "jwt.session.cookie" },
      query_string: "token=reset-secret",
      headers: {
        Cookie: "token=jwt.session.cookie",
        Authorization: "Bearer secret",
        "X-Forwarded-For": "203.0.113.7",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
    },
    user: { id: "u1", email: "ada@example.com", ip_address: "203.0.113.7", username: "ada" },
    extra: { body: "a resume" },
    exception: {
      values: [{
        type: "MongoServerError",
        value: 'E11000 duplicate key error collection: users index: email_1 dup key: { email: "ada@example.com" }',
        stacktrace: { frames: [{ function: "update", vars: { resume: { name: "Ada Lovelace" } } }] },
      }],
    },
    breadcrumbs: [{ category: "http", message: "POST to grace@example.org", data: { body: "resume text" } }],
  });

  it("removes request bodies, cookies and query strings", () => {
    const out = scrubEvent(event());
    expect(out.request).not.toHaveProperty("data");
    expect(out.request).not.toHaveProperty("cookies");
    expect(out.request).not.toHaveProperty("query_string");
    expect(out.request.url).toBe("https://api.example.com/api/resumes/abc");
    expect(out.request.method).toBe("PUT");
  });

  it("keeps only harmless headers", () => {
    expect(scrubEvent(event()).request.headers).toEqual({ "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" });
  });

  it("keeps only the user id, and redacts email addresses anywhere in the text", () => {
    const out = scrubEvent(event());
    expect(out.user).toEqual({ id: "u1" });
    expect(JSON.stringify(out)).not.toMatch(/@example\.(com|org)/);
    expect(out.exception.values[0].value).toContain('{ email: "[email]" }');
  });

  it("drops frame variables, breadcrumb data and extra", () => {
    const out = scrubEvent(event());
    expect(out.exception.values[0].stacktrace.frames[0]).not.toHaveProperty("vars");
    expect(out.breadcrumbs[0]).toEqual({ category: "http", message: "POST to [email]" });
    expect(out).not.toHaveProperty("extra");
    expect(JSON.stringify(out)).not.toContain("Ada Lovelace");
  });

  it("copes with an event that carries none of those fields", () => {
    expect(scrubEvent({ message: "plain" })).toEqual({ message: "plain" });
  });
});
