import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { makeApp, startMongo, stopMongo, fakeMailer, fakeGoogle, signedInAgent } from "./helpers.js";
import { hashToken } from "../src/repositories/oneTimeTokens.js";

beforeAll(startMongo, 120_000);
afterAll(stopMongo);

const EMAIL = "ada@example.com";
const tokenFrom = (mail) => new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
const summary = (agent) => agent.post("/api/ai/summary").send({ role: "Dev", experience: "2 years", keySkills: "React" });

async function registered(deps = {}, config = {}) {
  const mailer = fakeMailer();
  const app = await makeApp(config, { mail: mailer, ...deps });
  const agent = await signedInAgent(app, EMAIL, { verified: false });
  return { app, mailer, agent };
}

describe("sign-up", () => {
  it("sends a verification link and starts unverified", async () => {
    const { mailer, agent } = await registered();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: EMAIL, subject: "Confirm your email for Resume94" });
    expect(mailer.sent[0].text).toContain("/verify-email?token=");
    const me = await agent.get("/api/auth/me").expect(200);
    expect(me.body.user.emailVerified).toBe(false);
  });

  it("still succeeds when the email cannot be sent", async () => {
    const failing = { provider: "fake", configured: true, async send() { throw new Error("provider down"); } };
    const app = await makeApp({}, { mail: failing });
    const res = await request(app).post("/api/auth/register").send({ name: "Ada", email: EMAIL, password: "password123" });
    expect(res.status).toBe(201);
    expect(res.body.user.emailVerified).toBe(false);
  });

  it("stores only a hash of the token", async () => {
    const { app, mailer } = await registered();
    const token = tokenFrom(mailer.sent[0]);
    const row = await app.locals.db.collection("emailVerifications").findOne({});
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });
});

describe("AI gate", () => {
  it("refuses AI calls until the address is verified, without spending credits", async () => {
    const { agent } = await registered();
    const res = await summary(agent).expect(403);
    expect(res.body.error.code).toBe("EMAIL_UNVERIFIED");
    const usage = await agent.get("/api/ai/usage").expect(200); // the meter stays readable
    expect(usage.body.used ?? 0).toBe(0);
  });

  it("allows AI once the link is opened", async () => {
    const { app, mailer, agent } = await registered();
    await request(app).post("/api/auth/verify-email").send({ token: tokenFrom(mailer.sent[0]) }).expect(204);
    const me = await agent.get("/api/auth/me").expect(200);
    expect(me.body.user.emailVerified).toBe(true);
    await summary(agent).expect(200);
  });
});

describe("verify-email", () => {
  it("works once", async () => {
    const { app, mailer } = await registered();
    const token = tokenFrom(mailer.sent[0]);
    await request(app).post("/api/auth/verify-email").send({ token }).expect(204);
    const again = await request(app).post("/api/auth/verify-email").send({ token }).expect(400);
    expect(again.body.error.code).toBe("VERIFY_TOKEN_INVALID");
  });

  it("starts no session", async () => {
    const { app, mailer } = await registered();
    const res = await request(app).post("/api/auth/verify-email").send({ token: tokenFrom(mailer.sent[0]) }).expect(204);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects an expired or unknown token", async () => {
    const { app, mailer } = await registered();
    await request(app).post("/api/auth/verify-email").send({ token: "x".repeat(43) }).expect(400);
    await app.locals.db.collection("emailVerifications").updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await request(app).post("/api/auth/verify-email").send({ token: tokenFrom(mailer.sent[0]) }).expect(400);
  });

  it("cannot be used with a password-reset token", async () => {
    const { app, mailer } = await registered();
    await request(app).post("/api/auth/forgot-password").send({ email: EMAIL }).expect(204);
    const resetToken = tokenFrom(mailer.sent.at(-1));
    await request(app).post("/api/auth/verify-email").send({ token: resetToken }).expect(400);
  });

  it("validates the body", async () => {
    const { app } = await registered();
    await request(app).post("/api/auth/verify-email").send({}).expect(400);
  });
});

describe("resend", () => {
  it("needs a session", async () => {
    const app = await makeApp({}, { mail: fakeMailer() });
    await request(app).post("/api/auth/verify-email/resend").expect(401);
  });

  it("sends a fresh link; either link verifies", async () => {
    const { app, mailer, agent } = await registered();
    await agent.post("/api/auth/verify-email/resend").expect(204);
    expect(mailer.sent).toHaveLength(2);
    await request(app).post("/api/auth/verify-email").send({ token: tokenFrom(mailer.sent[0]) }).expect(204);
    // Verifying burns every outstanding link for the account.
    await request(app).post("/api/auth/verify-email").send({ token: tokenFrom(mailer.sent[1]) }).expect(400);
  });

  it("sends nothing once verified", async () => {
    const mailer = fakeMailer();
    const app = await makeApp({}, { mail: mailer });
    const agent = await signedInAgent(app, EMAIL); // verified
    mailer.sent.length = 0;
    await agent.post("/api/auth/verify-email/resend").expect(204);
    expect(mailer.sent).toHaveLength(0);
  });

  it("reports a failed send", async () => {
    let fail = false;
    const mail = { provider: "fake", configured: true, async send() { if (fail) throw new Error("down"); } };
    const app = await makeApp({}, { mail });
    const agent = await signedInAgent(app, EMAIL, { verified: false });
    fail = true;
    const res = await agent.post("/api/auth/verify-email/resend").expect(503);
    expect(res.body.error.code).toBe("MAIL_FAILED");
  });
});

describe("other proof of ownership", () => {
  it("a completed password reset verifies the address", async () => {
    const { app, mailer, agent } = await registered();
    await request(app).post("/api/auth/forgot-password").send({ email: EMAIL }).expect(204);
    await request(app).post("/api/auth/reset-password").send({ token: tokenFrom(mailer.sent.at(-1)), password: "newpassword1" }).expect(200);
    expect((await agent.get("/api/auth/me")).body.user.emailVerified).toBe(true);
  });

  it("a new Google account is verified", async () => {
    const app = await makeApp({}, { google: fakeGoogle(), mail: fakeMailer() });
    const res = await request(app).post("/api/auth/google").send({ credential: "good-token" }).expect(201);
    expect(res.body.user.emailVerified).toBe(true);
  });

  it("linking Google to an unverified password account verifies it", async () => {
    const { app } = await registered({ google: fakeGoogle() });
    const res = await request(app).post("/api/auth/google").send({ credential: "good-token" }).expect(200);
    expect(res.body.user).toMatchObject({ hasGoogle: true, emailVerified: true });
  });

  it("deleting the account removes its verification links", async () => {
    const { app, agent } = await registered();
    await agent.delete("/api/auth/me").expect(204);
    expect(await app.locals.db.collection("emailVerifications").countDocuments()).toBe(0);
  });
});

describe("review fixes", () => {
  it("an existing Google account without a verification date is verified at its next sign-in", async () => {
    const app = await makeApp({}, { google: fakeGoogle(), mail: fakeMailer() });
    await request(app).post("/api/auth/google").send({ credential: "good-token" }).expect(201);
    await app.locals.db.collection("users").updateMany({}, { $unset: { emailVerifiedAt: "" } }); // pre-verification account
    const res = await request(app).post("/api/auth/google").send({ credential: "good-token" }).expect(200);
    expect(res.body.user.emailVerified).toBe(true);
  });

  it("backfills accounts that already had a Google identity, and only those", async () => {
    const { backfillEmailVerified } = await import("../src/db.js");
    const app = await makeApp({}, { mail: fakeMailer() });
    const users = app.locals.db.collection("users");
    await users.insertMany([
      { name: "G", email: "g@example.com", googleId: "g-1", createdAt: new Date() },
      { name: "P", email: "p@example.com", passwordHash: "x", googleId: null, createdAt: new Date() },
    ]);
    await backfillEmailVerified(app.locals.db);
    expect((await users.findOne({ email: "g@example.com" })).emailVerifiedAt).toBeInstanceOf(Date);
    expect((await users.findOne({ email: "p@example.com" })).emailVerifiedAt).toBeUndefined();
  });

  it("caps verification mail per address, without refusing the sign-up", async () => {
    // Limiters are skipped under NODE_ENV=test, so this runs the app as development.
    const mailer = fakeMailer();
    const app = await makeApp({ NODE_ENV: "development", VERIFY_MAILS_PER_HOUR_PER_IP: "2" }, { mail: mailer });
    for (const n of [1, 2, 3]) {
      await request(app).post("/api/auth/register").send({ name: "A", email: `a${n}@example.com`, password: "password123" }).expect(201);
    }
    expect(mailer.sent).toHaveLength(2); // the third sign-up worked, but sent nothing

    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "a3@example.com", password: "password123" }).expect(200);
    const res = await agent.post("/api/auth/verify-email/resend").expect(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });

  it("words the expiry for any setting", async () => {
    const { verifyEmailEmail } = await import("../src/services/mail/templates/verifyEmail.js");
    const text = (ttlHours) => verifyEmailEmail({ to: "a@b.c", name: "A", link: "https://x/y", ttlHours }).text;
    expect(text(1)).toContain("expires in 1 hour.");
    expect(text(12)).toContain("expires in 12 hours.");
    expect(text(24)).toContain("expires in 1 day.");
    expect(text(48)).toContain("expires in 2 days.");
  });
});
