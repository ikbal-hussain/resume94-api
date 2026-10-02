import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { makeApp, startMongo, stopMongo, fakeGoogle, fakeMailer } from "./helpers.js";

beforeAll(startMongo, 120_000);
afterAll(stopMongo);

const signIn = (app, credential = "good-token") =>
  request(app).post("/api/auth/google").send({ credential });

describe("google sign-in", () => {
  it("creates an account and starts a session", async () => {
    const app = await makeApp({}, { google: fakeGoogle() });
    const res = await signIn(app).expect(201);

    expect(res.body.user).toMatchObject({
      email: "ada@example.com",
      name: "Ada Lovelace",
      hasGoogle: true,
      hasPassword: false,
      avatarUrl: "https://lh3.googleusercontent.com/a/ada",
    });
    expect(res.headers["set-cookie"][0]).toMatch(/token=.*HttpOnly/i);
  });

  it("returns the same account on a second sign-in, not a duplicate", async () => {
    const app = await makeApp({}, { google: fakeGoogle() });
    const first = await signIn(app).expect(201);
    const second = await signIn(app).expect(200); // 200, not 201 — nothing was created

    expect(second.body.user.id).toBe(first.body.user.id);
    expect(await app.locals.db.collection("users").countDocuments()).toBe(1);
  });

  it("links to an existing password account when Google has verified the address", async () => {
    const app = await makeApp({}, { google: fakeGoogle() });
    const agent = request.agent(app);
    const registered = await agent
      .post("/api/auth/register")
      .send({ name: "Ada", email: "ada@example.com", password: "password123" })
      .expect(201);

    const res = await signIn(app).expect(200);

    expect(res.body.user.id).toBe(registered.body.user.id);
    expect(res.body.user).toMatchObject({ hasPassword: true, hasGoogle: true });
    // The account keeps the name it already had; Google's is not written over it.
    expect(res.body.user.name).toBe("Ada");
    expect(await app.locals.db.collection("users").countDocuments()).toBe(1);
  });

  it("refuses to link an address Google has not verified", async () => {
    // The whole defence. Without it, a token for any address takes over the account
    // holding that address.
    const app = await makeApp({}, { google: fakeGoogle({ emailVerified: false }) });
    await request(app)
      .post("/api/auth/register")
      .send({ name: "Ada", email: "ada@example.com", password: "password123" })
      .expect(201);

    const res = await signIn(app).expect(403);

    expect(res.body.error.code).toBe("GOOGLE_EMAIL_UNVERIFIED");
    // Refused outright rather than given a second account for the same address.
    expect(await app.locals.db.collection("users").countDocuments()).toBe(1);
  });

  it("will not register an unverified address either", async () => {
    const app = await makeApp({}, { google: fakeGoogle({ emailVerified: false }) });
    await signIn(app).expect(403);
    expect(await app.locals.db.collection("users").countDocuments()).toBe(0);
  });

  it("treats the string \"true\" as verified, since Google has sent it that way", async () => {
    const app = await makeApp({}, { google: fakeGoogle({ emailVerified: "true" }) });
    // fakeGoogle hands the route whatever the service would, so this asserts the route
    // trusts the service's boolean; the string-coercion itself lives in the real service.
    await signIn(app).expect(201);
  });

  it("rejects a token the verifier will not accept", async () => {
    const app = await makeApp({}, { google: fakeGoogle() });
    const res = await signIn(app, "bad-token").expect(401);

    expect(res.body.error.code).toBe("GOOGLE_TOKEN_INVALID");
    // The reason stays server-side: "expired" and "wrong audience" are both just an
    // unusable token from outside, and naming which helps only someone probing.
    expect(JSON.stringify(res.body)).not.toMatch(/signature/i);
  });

  it("503s when no client ID is configured, rather than pretending", async () => {
    const app = await makeApp({}, { google: { configured: false, verify: async () => ({}) } });
    const res = await signIn(app).expect(503);
    expect(res.body.error.code).toBe("GOOGLE_NOT_CONFIGURED");
  });

  it("validates the body", async () => {
    const app = await makeApp({}, { google: fakeGoogle() });
    await request(app).post("/api/auth/google").send({}).expect(400);
    await request(app).post("/api/auth/google").send({ credential: "x".repeat(5000) }).expect(400);
  });
});

describe("accounts with no password", () => {
  it("cannot be signed into with a password", async () => {
    // bcrypt.compare against a missing hash rejects today, but the route must not be
    // relying on that — a library change would turn it into a way in.
    const app = await makeApp({}, { google: fakeGoogle() });
    await signIn(app).expect(201);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "ada@example.com", password: "password123" })
      .expect(401);
    expect(res.body.error.code).toBe("BAD_CREDENTIALS");
  });

  it("are told by email that they sign in with Google, and not by the response", async () => {
    const mail = fakeMailer();
    const app = await makeApp({}, { google: fakeGoogle(), mail });
    await signIn(app).expect(201);

    // Still 204, exactly as for an unknown address: anything else would turn this
    // endpoint into a way to discover who has an account here.
    await request(app).post("/api/auth/forgot-password").send({ email: "ada@example.com" }).expect(204);

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toBe("Signing in to Resume94");
    expect(mail.sent[0].text).toContain("signs in with Google");
    // No reset token was minted for an account that has no password to reset.
    expect(await app.locals.db.collection("passwordResets").countDocuments()).toBe(0);
  });

  it("still get the ordinary reset mail once a password exists", async () => {
    const mail = fakeMailer();
    const app = await makeApp({}, { google: fakeGoogle(), mail });
    await request(app)
      .post("/api/auth/register")
      .send({ name: "Ada", email: "ada@example.com", password: "password123" })
      .expect(201);

    await request(app).post("/api/auth/forgot-password").send({ email: "ada@example.com" }).expect(204);

    expect(mail.sent[0].subject).toBe("Reset your Resume94 password");
    expect(await app.locals.db.collection("passwordResets").countDocuments()).toBe(1);
  });
});
