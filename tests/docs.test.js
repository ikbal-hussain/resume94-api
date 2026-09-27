import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { makeApp, startMongo, stopMongo } from "./helpers.js";
import { buildOpenApiDocument } from "../src/openapi.js";

beforeAll(startMongo, 120_000);
afterAll(stopMongo);

describe("API documentation", () => {
  it("serves the OpenAPI document", async () => {
    const res = await request(await makeApp()).get("/api/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.3");
    expect(res.body.info.title).toBe("Resume94 API");
  });

  it("serves the Swagger UI", async () => {
    const res = await request(await makeApp()).get("/api/docs/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("swagger-ui");
  });

  it("documents every route the app exposes", () => {
    const documented = new Set(Object.keys(buildOpenApiDocument().paths));
    // Kept in step with app.js by hand; this test fails if a route is added
    // without a corresponding entry in the spec.
    for (const path of [
      "/health",
      "/auth/register",
      "/auth/login",
      "/auth/logout",
      "/auth/me",
      "/resumes",
      "/resumes/{id}",
      "/resumes/{id}/duplicate",
      "/ai/summary",
      "/ai/improve",
    ]) {
      expect(documented, `missing ${path}`).toContain(path);
    }
  });

  it("derives request schemas from the Zod validators", () => {
    const { schemas } = buildOpenApiDocument().components;
    // Proves the docs track validation: these limits exist only in schemas.js.
    expect(schemas.RegisterBody.properties.password.minLength).toBe(8);
    expect(schemas.ResumeBody.properties.title.maxLength).toBe(100);
    expect(schemas.ResumeData.properties.templateId.enum).toContain("classic");
  });

  it("marks protected routes as requiring the session cookie", () => {
    const { paths, components } = buildOpenApiDocument();
    expect(components.securitySchemes.cookieAuth).toMatchObject({ in: "cookie", name: "token" });
    expect(paths["/resumes"].get.security).toEqual([{ cookieAuth: [] }]);
    expect(paths["/auth/login"].post.security).toBeUndefined();
  });
});

describe("documentation access in production", () => {
  const prod = { NODE_ENV: "production", JWT_SECRET: "x".repeat(32), MAIL_PROVIDER: "resend" };
  const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

  it("reports the docs missing when no credentials are configured", async () => {
    const app = await makeApp(prod);

    // 404 rather than 401: an auth prompt would confirm the route exists.
    for (const path of ["/api/docs/", "/api/openapi.json"]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers["www-authenticate"]).toBeUndefined();
    }
  });

  it("challenges for credentials when they are configured", async () => {
    const app = await makeApp({ ...prod, DOCS_USER: "reviewer", DOCS_PASSWORD: "a-long-shared-secret" });

    const res = await request(app).get("/api/openapi.json");
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/^Basic realm=/);
  });

  it("rejects a wrong password and accepts the right one", async () => {
    const app = await makeApp({ ...prod, DOCS_USER: "reviewer", DOCS_PASSWORD: "a-long-shared-secret" });

    expect((await request(app).get("/api/openapi.json").set("Authorization", basic("reviewer", "wrong"))).status).toBe(401);
    expect((await request(app).get("/api/openapi.json").set("Authorization", basic("nobody", "a-long-shared-secret"))).status).toBe(401);

    const ok = await request(app).get("/api/openapi.json").set("Authorization", basic("reviewer", "a-long-shared-secret"));
    expect(ok.status).toBe(200);
    expect(ok.body.info.title).toBe("Resume94 API");
  });

  it("accepts a password containing a colon", async () => {
    // RFC 7617 allows a colon in the password; splitting on every colon truncated it
    // and made any such password impossible to authenticate with.
    const password = "correct:horse:battery";
    const app = await makeApp({ ...prod, DOCS_USER: "reviewer", DOCS_PASSWORD: password });

    const ok = await request(app).get("/api/openapi.json").set("Authorization", basic("reviewer", password));
    expect(ok.status).toBe(200);

    const truncated = await request(app).get("/api/openapi.json").set("Authorization", basic("reviewer", "correct"));
    expect(truncated.status).toBe(401);
  });

  it("guards the docs when NODE_ENV is not set at all", async () => {
    // An unset NODE_ENV must not be read as development, or a deployment that forgets
    // it serves the docs openly — along with non-Secure cookies and no JWT_SECRET check.
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig({ JWT_SECRET: "x".repeat(32) }).NODE_ENV).toBe("production");

    const res = await request(await makeApp({ NODE_ENV: undefined, JWT_SECRET: "x".repeat(32), MAIL_PROVIDER: "resend" })).get(
      "/api/openapi.json"
    );
    expect(res.status).toBe(404);
  });

  it("keeps the spec reachable in development without credentials", async () => {
    const res = await request(await makeApp({ NODE_ENV: "development" })).get("/api/openapi.json");
    expect(res.status).toBe(200);
  });

  it("does not advertise the internal docs endpoints from the service root", async () => {
    const res = await request(await makeApp(prod)).get("/");
    expect(res.status).toBe(200);

    // The public repository link is fine; pointing at the guarded routes is not.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("/api/docs");
    expect(body).not.toContain("/api/openapi");
  });
});
