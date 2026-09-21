// Long-running server for local dev / Docker. (Vercel uses api/index.js.)
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { connectDb } from "./db.js";

const config = loadConfig();
if (!config.MONGODB_URI) throw new Error("MONGODB_URI is required");
const { client, db } = await connectDb(config.MONGODB_URI, config.MONGODB_DB);
const server = createApp(config, { db }).listen(config.PORT, () => {
  console.log(`Resume94 API listening on :${config.PORT} (${config.NODE_ENV})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => client.close().then(() => process.exit(0))));
}
