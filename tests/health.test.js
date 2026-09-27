import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { makeApp, startMongo, stopMongo } from "./helpers.js";
import { createMailService } from "../src/services/mail/index.js";
import { loadConfig } from "../src/config.js";

beforeAll(startMongo, 120_000);
afterAll(stopMongo);

describe("health", () => {
  it("reports ok once the database answers", async () => {
    const res = await request(await makeApp()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("names the build that is answering", async () => {
    // The smoke test waits on this field to be sure it is judging the new deployment
    // and not the one it replaces, so an absent value has to be an explicit null.
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const res = await request(await makeApp({ VERCEL_GIT_COMMIT_SHA: sha })).get("/api/health");
    expect(res.body.commit).toBe(sha);

    const local = await request(await makeApp()).get("/api/health");
    expect(local.body).toHaveProperty("commit", null);
  });

  it("reports which transports are configured", async () => {
    const res = await request(await makeApp({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test" })).get("/api/health");
    expect(res.body).toMatchObject({ mailProvider: "resend", mailConfigured: true, aiProvider: "gemini" });
  });

  it("reports mail as unconfigured when the provider has no key", async () => {
    const res = await request(await makeApp({ MAIL_PROVIDER: "resend" })).get("/api/health");
    expect(res.body).toMatchObject({ mailProvider: "resend", mailConfigured: false });
  });

  it("shows a production console transport as unconfigured", () => {
    // This is the state the smoke test exists to catch: the API answers every route
    // normally while password reset is silently dead.
    const config = loadConfig({ NODE_ENV: "production", JWT_SECRET: "x".repeat(32), MAIL_PROVIDER: "console" });
    const mail = createMailService(config, fetch, { error() {} });

    expect(mail.provider).toBe("console");
    expect(mail.configured).toBe(false);
  });
});
