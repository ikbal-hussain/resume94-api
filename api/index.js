// Vercel serverless entry. The Express app and Mongo connection are created once
// per warm instance and reused across invocations (avoids reconnecting each request).
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { connectDb } from "../src/db.js";
import { createErrorTracker } from "../src/services/errorTracking.js";

let appPromise;
// Created before the database so a startup failure (Atlas unreachable, a bad URI) is
// reported too; those never reach the app's error handler. Undefined only if the
// config itself failed to load, which leaves nothing to configure Sentry from.
let errors;

async function init() {
  const config = loadConfig();
  errors ??= createErrorTracker(config);
  if (!config.MONGODB_URI) throw new Error("MONGODB_URI is required");
  const { db, client } = await connectDb(config.MONGODB_URI, config.MONGODB_DB);
  return createApp(config, { db, client, errors });
}

export default async function handler(req, res) {
  try {
    appPromise ??= init();
    const app = await appPromise;
    return app(req, res);
  } catch (err) {
    appPromise = undefined; // retry init on the next request
    console.error("init failed", err);
    await errors?.capture(err, { method: req.method, route: "(init)" });
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { code: "INIT_FAILED", message: "Service unavailable" } }));
  }
}
