import { MongoClient } from "mongodb";

export async function connectDb(uri, dbName) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(dbName);
  await ensureIndexes(db);
  return { client, db };
}

// Idempotent; safe to run on every cold start.
export async function ensureIndexes(db) {
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
  await db.collection("resumes").createIndex({ userId: 1, updatedAt: -1 });
  await db.collection("passwordResets").createIndex({ tokenHash: 1 });
  // expireAfterSeconds: 0 means "delete once expiresAt passes" — Mongo clears spent
  // reset tokens itself. Lookups still filter on expiresAt; this is only housekeeping.
  await db.collection("passwordResets").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}
