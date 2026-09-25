import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { makeApp, startMongo, stopMongo, fakeMailer } from "./helpers.js";
import { hashToken } from "../src/repositories/passwordResets.js";
import { resetPasswordEmail } from "../src/services/mail/templates/resetPassword.js";
import { createMailService } from "../src/services/mail/index.js";

beforeAll(startMongo, 120_000);
afterAll(stopMongo);

const EMAIL = "ada@example.com";
const tokenFrom = (mail) => new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");

/** Registers a user and returns { app, mailer, requestReset }. */
async function setup(configOverrides = {}) {
  const mailer = fakeMailer();
  const app = await makeApp(configOverrides, { mail: mailer });
  await request(app).post("/api/auth/register").send({ name: "Ada", email: EMAIL, password: "password123" });
  const requestReset = async (email = EMAIL) => {
    const res = await request(app).post("/api/auth/forgot-password").send({ email });
    return { res, token: mailer.sent.length ? tokenFrom(mailer.sent.at(-1)) : null };
  };
  return { app, mailer, requestReset };
}

const login = (app, password, email = EMAIL) =>
  request(app).post("/api/auth/login").send({ email, password });

describe("forgot-password", () => {
  it("emails a reset link to a registered address", async () => {
    const { mailer, requestReset } = await setup();
    const { res, token } = await requestReset();

    expect(res.status).toBe(204);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe(EMAIL);
    expect(token).toBeTruthy();
  });

  it("answers identically for an unknown address and sends nothing", async () => {
    const { mailer, requestReset } = await setup();
    const { res } = await requestReset("nobody@example.com");

    // Any difference here — status, body, or an error — would reveal who has an account.
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(mailer.sent).toHaveLength(0);
  });

  it("stores only a hash of the token, never the token itself", async () => {
    const { app, requestReset } = await setup();
    const { token } = await requestReset();

    const row = await app.locals.db.collection("passwordResets").findOne({});
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("still returns 204 when the mail provider fails", async () => {
    const app = await makeApp({}, { mail: { async send() { throw new Error("smtp down"); } } });
    await request(app).post("/api/auth/register").send({ name: "Ada", email: EMAIL, password: "password123" });

    const res = await request(app).post("/api/auth/forgot-password").send({ email: EMAIL });
    expect(res.status).toBe(204);
  });
});

describe("reset-password", () => {
  it("sets the new password, rejects the old one, and signs the user in", async () => {
    const { app, requestReset } = await setup();
    const { token } = await requestReset();

    const res = await request(app).post("/api/auth/reset-password").send({ token, password: "brand-new-pass" });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(EMAIL);
    expect(res.headers["set-cookie"][0]).toMatch(/token=.*HttpOnly/i);

    expect((await login(app, "brand-new-pass")).status).toBe(200);
    expect((await login(app, "password123")).status).toBe(401);
  });

  it("refuses to reuse a token", async () => {
    const { app, requestReset } = await setup();
    const { token } = await requestReset();
    await request(app).post("/api/auth/reset-password").send({ token, password: "first-password" });

    const res = await request(app).post("/api/auth/reset-password").send({ token, password: "second-password" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("RESET_TOKEN_INVALID");
    expect((await login(app, "first-password")).status).toBe(200);
  });

  it("invalidates older links when a newer one is used", async () => {
    const { app, requestReset } = await setup();
    const { token: older } = await requestReset();
    const { token: newer } = await requestReset();

    await request(app).post("/api/auth/reset-password").send({ token: newer, password: "chosen-password" });

    const res = await request(app).post("/api/auth/reset-password").send({ token: older, password: "attacker-pass" });
    expect(res.status).toBe(400);
    expect((await login(app, "chosen-password")).status).toBe(200);
  });

  it("rejects a tampered token", async () => {
    const { app, requestReset } = await setup();
    const { token } = await requestReset();
    const tampered = token.slice(0, -4) + (token.endsWith("aaaa") ? "bbbb" : "aaaa");

    const res = await request(app).post("/api/auth/reset-password").send({ token: tampered, password: "no-entry-here" });
    expect(res.status).toBe(400);
    expect((await login(app, "password123")).status).toBe(200);
  });

  it("rejects an expired token", async () => {
    // TTL of zero minutes: the row is already past expiresAt when it is written.
    const { app, requestReset } = await setup({ RESET_TOKEN_TTL_MINUTES: "1" });
    const { token } = await requestReset();
    await app.locals.db
      .collection("passwordResets")
      .updateOne({ tokenHash: hashToken(token) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).post("/api/auth/reset-password").send({ token, password: "too-late-now" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("RESET_TOKEN_INVALID");
  });

  it("requires the new password to meet the same minimum as registration", async () => {
    const { app, requestReset } = await setup();
    const { token } = await requestReset();

    const res = await request(app).post("/api/auth/reset-password").send({ token, password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("reset link validity probe", () => {
  it("reports a usable link as valid and a spent one as invalid", async () => {
    const { app, requestReset } = await setup();
    const { token } = await requestReset();

    expect((await request(app).get(`/api/auth/reset-password/${token}`)).body).toEqual({ valid: true });
    await request(app).post("/api/auth/reset-password").send({ token, password: "now-consumed" });
    expect((await request(app).get(`/api/auth/reset-password/${token}`)).body).toEqual({ valid: false });
  });
});

describe("reset email", () => {
  it("includes the link in both a plain-text and an HTML part", () => {
    const link = "https://example.com/reset-password?token=abc";
    const mail = resetPasswordEmail({ to: EMAIL, name: "Ada", link, ttlMinutes: 60 });

    expect(mail.text).toContain(link);
    expect(mail.html).toContain(link);
    expect(mail.text).not.toMatch(/<[a-z]/i); // the text part must not be markup
    expect(mail.subject).toMatch(/password/i);
  });

  it("escapes the name so it cannot inject markup", () => {
    const mail = resetPasswordEmail({ to: EMAIL, name: '<img src=x onerror="alert(1)">', link: "https://e.com", ttlMinutes: 60 });
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;img");
  });
});

describe("mail provider registry", () => {
  it("routes through the configured provider", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return { ok: true, json: async () => ({ id: "sent" }) };
    };
    const mail = createMailService(
      { MAIL_PROVIDER: "resend", RESEND_API_KEY: "key_123", MAIL_FROM: "Resume94 <no-reply@example.com>" },
      fetchImpl
    );

    await mail.send({ to: EMAIL, subject: "Hi", html: "<p>Hi</p>", text: "Hi" });
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].auth).toBe("Bearer key_123");
    expect(calls[0].body).toMatchObject({ from: "Resume94 <no-reply@example.com>", to: [EMAIL] });
  });

  it("surfaces an upstream rejection rather than reporting success", async () => {
    const fetchImpl = async () => ({ ok: false, status: 422, text: async () => "domain not verified" });
    const mail = createMailService({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "k" }, fetchImpl);

    await expect(mail.send({ to: EMAIL, subject: "s", text: "t" })).rejects.toThrow(/422.*domain not verified/);
  });

  it("refuses to start with an unknown provider", () => {
    expect(() => createMailService({ MAIL_PROVIDER: "carrier-pigeon" })).toThrow(/Unknown MAIL_PROVIDER/);
  });

  it("reports itself unconfigured when the key is missing", async () => {
    const mail = createMailService({ MAIL_PROVIDER: "resend" });
    expect(mail.configured).toBe(false);
    await expect(mail.send({ to: EMAIL, subject: "s", text: "t" })).rejects.toThrow(/RESEND_API_KEY/);
  });
});
