import { MongoClient } from "mongodb";

export async function connectDb(uri, dbName) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(dbName);
  await ensureIndexes(db);
  return { client, db };
}

/**
 * Returns a `withTransaction(fn)` that runs `fn(session)` as one atomic unit.
 *
 * Transactions need a replica set or a sharded cluster; Atlas is one, a standalone
 * mongod is not. Support is probed once per process and cached — without it the
 * callback still runs, just without the guarantee, so a local standalone server
 * keeps working instead of failing every write.
 */
export function makeWithTransaction(client, log = console) {
  if (!client) return (fn) => fn();
  let supported = null;

  return async function withTransaction(fn) {
    if (supported === null) {
      const info = await client.db().admin().command({ hello: 1 }).catch(() => ({}));
      supported = Boolean(info.setName || info.msg === "isdbgrid");
      if (!supported) log.warn?.("[db] standalone server: grouped writes will not be atomic");
    }
    if (!supported) return fn();

    const session = client.startSession();
    try {
      let result;
      await session.withTransaction(async (s) => {
        result = await fn(s);
      });
      return result;
    } finally {
      await session.endSession();
    }
  };
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
