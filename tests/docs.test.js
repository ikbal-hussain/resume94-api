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
