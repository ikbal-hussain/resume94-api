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
}
