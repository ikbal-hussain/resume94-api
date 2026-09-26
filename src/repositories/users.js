import { ObjectId } from "mongodb";

const toUser = (d) => d && { id: d._id.toString(), name: d.name, email: d.email, createdAt: d.createdAt.toISOString() };
const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

export function usersRepo(db) {
  const col = db.collection("users");
  return {
    // Emails are lowercased by the schema; the unique index enforces one account per email.
    async create({ name, email, passwordHash }) {
      const doc = { name, email, passwordHash, createdAt: new Date() };
      try {
        const { insertedId } = await col.insertOne(doc);
        return toUser({ ...doc, _id: insertedId });
      } catch (e) {
        if (e.code === 11000) return null; // duplicate email (race-safe)
        throw e;
      }
    },
    async findById(id) {
      const _id = oid(id);
      return _id ? toUser(await col.findOne({ _id })) : null;
    },
    // Raw doc (with passwordHash) — only for credential checks.
    findCredentialsByEmail: (email) => col.findOne({ email }),
    // Takes an already-hashed value; hashing stays in the auth route with the rest of it.
    async updatePasswordHash(id, passwordHash) {
      const _id = id instanceof ObjectId ? id : oid(id);
      const { matchedCount } = await col.updateOne({ _id }, { $set: { passwordHash } });
      return matchedCount > 0;
    },
    async updateName(id, name) {
      const d = await col.findOneAndUpdate({ _id: oid(id) }, { $set: { name } }, { returnDocument: "after" });
      return toUser(d);
    },
    async delete(id) {
      const _id = oid(id);
      const { deletedCount } = await col.deleteOne({ _id });
      if (deletedCount) {
        // Manual cascade. Reset tokens go too: a live one would otherwise outlive the
        // account and hit a user lookup that no longer resolves.
        await db.collection("resumes").deleteMany({ userId: _id });
        await db.collection("passwordResets").deleteMany({ userId: _id });
      }
      return deletedCount > 0;
    },
  };
}
