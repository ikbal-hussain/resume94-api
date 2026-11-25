// Vercel serverless entry. The Express app and Mongo connection are created once
// per warm instance and reused across invocations (avoids reconnecting each request).
// The caching, the retry after a failed start and its reporting live in src/serverless.js.
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { connectDb } from "../src/db.js";
import { createErrorTracker } from "../src/services/errorTracking.js";
import { createHandler } from "../src/serverless.js";

export default createHandler(async (track) => {
  const config = loadConfig();
  // Before the database, so a failed connection is reported too. If the config itself
  // fails to load there is nothing to configure Sentry from, and only the log has it.
  const errors = createErrorTracker(config);
  track(errors);
  if (!config.MONGODB_URI) throw new Error("MONGODB_URI is required");
  const { db, client } = await connectDb(config.MONGODB_URI, config.MONGODB_DB);
  return createApp(config, { db, client, errors });
});
