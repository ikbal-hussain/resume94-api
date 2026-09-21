import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { ensureIndexes } from "../src/db.js";

export const fakeAi = {
  summary: async () => "A great summary.",
  improve: async ({ content }) => `- improved: ${content}`,
};

// One in-memory MongoDB per test file; each makeApp() gets a fresh database.
let mongod, client, n = 0;
export async function startMongo() {
  mongod = await MongoMemoryServer.create();
  client = await new MongoClient(mongod.getUri()).connect();
}
export async function stopMongo() {
  await client?.close();
  await mongod?.stop();
}

export async function makeApp(overrides = {}) {
  const config = loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-1234567890", ...overrides });
  const db = client.db(`test_${++n}`);
  await ensureIndexes(db);
  const app = createApp(config, { db, ai: fakeAi, log: { error() {} } });
  app.locals.db = db; // exposed for assertions only
  return app;
}

// Returns a supertest agent that keeps the session cookie.
export async function signedInAgent(app, email = "a@example.com") {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({ name: "Ada", email, password: "password123" });
  if (res.status !== 201) throw new Error("register failed: " + JSON.stringify(res.body));
  return agent;
}

export const sampleResume = (over = {}) => ({
  title: "My Resume",
  data: { name: "Ada Lovelace", email: "ada@example.com", skills: "JS, SQL", projects: ["Engine"], ...over },
});
