import crypto from "node:crypto";

/**
 * Only a SHA-256 digest of each token is stored, so a leaked database does not hand
 * over working reset links. SHA-256 rather than bcrypt is deliberate: the token is 32
 * bytes of CSPRNG output, so there is no dictionary to defend against — bcrypt's work
 * factor would buy nothing and cost a slow hash on every verification.
 */
export const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

export function passwordResetsRepo(db) {
  const col = db.collection("passwordResets");
  return {
    /** Issues a token, returning the raw value — the only time it exists outside the email. */
    async create(userId, ttlMinutes) {
      const token = crypto.randomBytes(32).toString("base64url");
      await col.insertOne({
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
        usedAt: null,
        createdAt: new Date(),
      });
      return token;
    },

    // Expiry is enforced in the query, not by the TTL index: Mongo's background purge
    // runs about once a minute, so an expired row can briefly still exist.
    findValid(token) {
      return col.findOne({ tokenHash: hashToken(token), usedAt: null, expiresAt: { $gt: new Date() } });
    },

    /** Burns the used token and every other outstanding one for that account. */
    async consume(userId) {
      const { modifiedCount } = await col.updateMany(
        { userId, usedAt: null },
        { $set: { usedAt: new Date() } }
      );
      return modifiedCount;
    },
  };
}
