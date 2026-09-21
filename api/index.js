// Vercel serverless entry. The Express app and Mongo connection are created once
// per warm instance and reused across invocations (avoids reconnecting each request).
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { connectDb } from "../src/db.js";

let appPromise;

async function init() {
  const config = loadConfig();
  if (!config.MONGODB_URI) throw new Error("MONGODB_URI is required");
  const { db } = await connectDb(config.MONGODB_URI, config.MONGODB_DB);
  return createApp(config, { db });
}

export default async function handler(req, res) {
  try {
    appPromise ??= init();
    const app = await appPromise;
    return app(req, res);
  } catch (err) {
    appPromise = undefined; // retry init on the next request
    console.error("init failed", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { code: "INIT_FAILED", message: "Service unavailable" } }));
  }
}
