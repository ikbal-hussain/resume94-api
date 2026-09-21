import { ObjectId } from "mongodb";

const oid = (id) => (typeof id === "string" && /^[a-f\d]{24}$/i.test(id) ? new ObjectId(id) : null);
const toSummary = (d) => ({
  id: d._id.toString(),
  title: d.title,
  name: d.data?.name || "",
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
});
const toResume = (d) => d && { ...toSummary(d), data: d.data };

// Every query includes userId, so another user's resume behaves like "not found".
export function resumesRepo(db) {
  const col = db.collection("resumes");
  const scope = (userId, id) => {
    const _id = oid(id);
    return _id && { _id, userId: new ObjectId(userId) };
  };

  return {
    async list(userId) {
      const docs = await col
        .find({ userId: new ObjectId(userId) }, { projection: { title: 1, "data.name": 1, createdAt: 1, updatedAt: 1 } })
        .sort({ updatedAt: -1, _id: -1 })
        .toArray();
      return docs.map(toSummary);
    },
    async find(userId, id) {
      const q = scope(userId, id);
      return q ? toResume(await col.findOne(q)) : null;
    },
    async create(userId, { title, data }) {
      const now = new Date();
      const doc = { userId: new ObjectId(userId), title, data, createdAt: now, updatedAt: now };
      const { insertedId } = await col.insertOne(doc);
      return toResume({ ...doc, _id: insertedId });
    },
    async update(userId, id, { title, data }) {
      const q = scope(userId, id);
      if (!q) return null;
      const d = await col.findOneAndUpdate(q, { $set: { title, data, updatedAt: new Date() } }, { returnDocument: "after" });
      return toResume(d);
    },
    async delete(userId, id) {
      const q = scope(userId, id);
      return q ? (await col.deleteOne(q)).deletedCount > 0 : false;
    },
    async duplicate(userId, id) {
      const src = await this.find(userId, id);
      return src ? this.create(userId, { title: `${src.title} (copy)`.slice(0, 100), data: src.data }) : null;
    },
  };
}
