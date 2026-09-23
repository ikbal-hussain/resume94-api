import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { makeApp, startMongo, stopMongo, signedInAgent } from "./helpers.js";

beforeAll(startMongo, 120_000);
afterAll(stopMongo);

describe("service routes", () => {
  it("answers the bare root with service info instead of an error", async () => {
    const res = await request(await makeApp()).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ service: "resume94-api", status: "ok" });
  });

  it("404s unknown paths as JSON", async () => {
    const res = await request(await makeApp()).get("/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("auth", () => {
  it("registers, sets an httpOnly cookie, and never returns the password hash", async () => {
    const res = await request(await makeApp())
      .post("/api/auth/register")
      .send({ name: "Ada", email: "Ada@Example.com", password: "password123" });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: "Ada", email: "ada@example.com" });
    expect(JSON.stringify(res.body)).not.toMatch(/hash|password/i);
    expect(res.headers["set-cookie"][0]).toMatch(/token=.*HttpOnly/i);
  });

  it("rejects duplicate emails case-insensitively", async () => {
    const app = await makeApp();
    await signedInAgent(app, "a@example.com");
    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "X", email: "A@EXAMPLE.COM", password: "password123" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("validates input", async () => {
    const res = await request(await makeApp())
      .post("/api/auth/register")
      .send({ name: "", email: "nope", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.length).toBeGreaterThanOrEqual(3);
  });

  it("logs in with correct credentials and rejects wrong ones with the same error", async () => {
    const app = await makeApp();
    await signedInAgent(app);
    const ok = await request(app).post("/api/auth/login").send({ email: "a@example.com", password: "password123" });
    expect(ok.status).toBe(200);
    const badPw = await request(app).post("/api/auth/login").send({ email: "a@example.com", password: "wrong-password" });
    const noUser = await request(app).post("/api/auth/login").send({ email: "zz@example.com", password: "password123" });
    expect(badPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(badPw.body).toEqual(noUser.body); // no user enumeration
  });

  it("protects /me and supports logout", async () => {
    const app = await makeApp();
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    const agent = await signedInAgent(app);
    expect((await agent.get("/api/auth/me")).body.user.email).toBe("a@example.com");
    await agent.post("/api/auth/logout").expect(204);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("rejects a tampered token", async () => {
    const res = await request(await makeApp()).get("/api/auth/me").set("Cookie", "token=abc.def.ghi");
    expect(res.status).toBe(401);
  });

  it("deleting the account cascades to resumes", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app);
    await agent.post("/api/resumes").send({ title: "t", data: {} }).expect(201);
    await agent.delete("/api/auth/me").expect(204);
    expect(await app.locals.db.collection("resumes").countDocuments()).toBe(0);
  });
});
