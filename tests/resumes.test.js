import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { makeApp, startMongo, stopMongo, signedInAgent, sampleResume } from "./helpers.js";

beforeAll(startMongo, 120_000);
afterAll(stopMongo);

describe("resumes", () => {
  it("requires authentication", async () => {
    expect((await request(await makeApp()).get("/api/resumes")).status).toBe(401);
  });

  it("supports full CRUD", async () => {
    const agent = await signedInAgent(await makeApp());
    const created = await agent.post("/api/resumes").send(sampleResume()).expect(201);
    const id = created.body.resume.id;
    expect(created.body.resume.data.projects).toEqual(["Engine"]);

    const list = await agent.get("/api/resumes").expect(200);
    expect(list.body.resumes).toHaveLength(1);
    expect(list.body.resumes[0]).toMatchObject({ id, title: "My Resume", name: "Ada Lovelace" });
    expect(list.body.resumes[0].data).toBeUndefined(); // list stays lightweight

    const upd = await agent.put(`/api/resumes/${id}`).send(sampleResume({ name: "Ada L." })).expect(200);
    expect(upd.body.resume.data.name).toBe("Ada L.");

    const dup = await agent.post(`/api/resumes/${id}/duplicate`).expect(201);
    expect(dup.body.resume.title).toBe("My Resume (copy)");
    expect(dup.body.resume.id).not.toBe(id);

    await agent.delete(`/api/resumes/${id}`).expect(204);
    await agent.get(`/api/resumes/${id}`).expect(404);
  });

  it("fills defaults and strips unknown fields", async () => {
    const agent = await signedInAgent(await makeApp());
    const res = await agent.post("/api/resumes").send({ title: "t", data: { hacker: "x" } }).expect(201);
    expect(res.body.resume.data).toMatchObject({ name: "", projects: [], profileImage: null });
    expect(res.body.resume.data.hacker).toBeUndefined();
  });

  it("enforces ownership: other users get 404 for read, update, delete, duplicate", async () => {
    const app = await makeApp();
    const alice = await signedInAgent(app, "alice@example.com");
    const bob = await signedInAgent(app, "bob@example.com");
    const { id } = (await alice.post("/api/resumes").send(sampleResume()).expect(201)).body.resume;

    await bob.get(`/api/resumes/${id}`).expect(404);
    await bob.put(`/api/resumes/${id}`).send(sampleResume({ name: "pwned" })).expect(404);
    await bob.delete(`/api/resumes/${id}`).expect(404);
    await bob.post(`/api/resumes/${id}/duplicate`).expect(404);
    expect((await bob.get("/api/resumes")).body.resumes).toHaveLength(0);
    expect((await alice.get(`/api/resumes/${id}`)).body.resume.data.name).toBe("Ada Lovelace");
  });

  it("rejects invalid payloads and non-image profile photos", async () => {
    const agent = await signedInAgent(await makeApp());
    await agent.post("/api/resumes").send({ title: "", data: {} }).expect(400);
    const res = await agent
      .post("/api/resumes")
      .send({ title: "t", data: { profileImage: "data:text/html;base64,PHNjcmlwdD4=" } });
    expect(res.status).toBe(400);
    await agent.get("/api/resumes/abc").expect(404);
  });

  it("does not leak SQL errors for malicious ids", async () => {
    const agent = await signedInAgent(await makeApp());
    await agent.get("/api/resumes/1%20OR%201=1").expect(404);
  });
});
