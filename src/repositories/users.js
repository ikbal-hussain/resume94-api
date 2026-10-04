import { ObjectId } from "mongodb";

const toUser = (d) =>
  d && {
    id: d._id.toString(),
    name: d.name,
    email: d.email,
    createdAt: d.createdAt.toISOString(),
    // Null rather than absent so the client can tell "no avatar" from "field not sent".
    avatarUrl: d.avatarUrl ?? null,
    // What the account can actually sign in with. The frontend needs this to explain
    // itself, and it is derived rather than stored so the two can never disagree.
    hasPassword: Boolean(d.passwordHash),
    hasGoogle: Boolean(d.googleId),
  };
const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

export function usersRepo(db) {
  const col = db.collection("users");
  return {
    // Emails are lowercased by the schema; the unique index enforces one account per email.
    // `passwordHash` is optional: an account created through Google has no password, and
    // storing `undefined` would leave a key whose value bcrypt would later compare against.
    async create({ name, email, passwordHash = null, googleId = null, avatarUrl = null }) {
      const doc = { name, email, passwordHash, googleId, avatarUrl, createdAt: new Date() };
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
    // Mapped rather than raw: the route only needs the public shape, and re-reading the
    // document to get it opened a window where the account could be deleted in between.
    async findByGoogleId(googleId) {
      return toUser(await col.findOne({ googleId }));
    },

    /**
     * Attaches a Google identity to an existing account.
     *
     * Filtered on the account not already carrying a different `googleId`, so two Google
     * accounts cannot come to point at one Resume94 account through a race.
     *
     * An update pipeline rather than a plain $set: the avatar should only fill a gap, and
     * $ifNull decides that inside the write instead of in a read-then-write that another
     * request could interleave with.
     */
    async linkGoogle(id, { googleId, avatarUrl = null }) {
      const _id = id instanceof ObjectId ? id : oid(id);
      const d = await col.findOneAndUpdate(
        { _id, $or: [{ googleId: null }, { googleId }, { googleId: { $exists: false } }] },
        [{ $set: { googleId, avatarUrl: { $ifNull: ["$avatarUrl", avatarUrl] } } }],
        { returnDocument: "after" }
      );
      return d ? toUser(d) : null;
    },

    // Takes an already-hashed value; hashing stays in the auth route with the rest of it.
    async updatePasswordHash(id, passwordHash, session) {
      const _id = id instanceof ObjectId ? id : oid(id);
      const { matchedCount } = await col.updateOne({ _id }, { $set: { passwordHash } }, { session });
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
