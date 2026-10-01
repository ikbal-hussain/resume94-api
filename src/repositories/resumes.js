import { ObjectId } from "mongodb";
import { migrateResumeData } from "../migrateResume.js";

const oid = (id) => (typeof id === "string" && /^[a-f\d]{24}$/i.test(id) ? new ObjectId(id) : null);
const toSummary = (d) => ({
  id: d._id.toString(),
  title: d.title,
  name: d.data?.name || "",
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
});
// The list view draws a miniature of each resume, so it needs the two presentation
// fields as well. Deliberately not folded into toSummary: the full resume already
// carries them inside `data`, and repeating them at the top level there would give
// the same fact two homes that can disagree.
const toListItem = (d) => ({
  ...toSummary(d),
  headline: d.data?.headline || "",
  templateId: d.data?.templateId || "classic",
  accentColor: d.data?.accentColor || "#2563eb",
});
// Documents stored before the structured-sections change are upgraded on read.
const toResume = (d) => d && { ...toSummary(d), data: migrateResumeData(d.data) };

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
        .find(
          { userId: new ObjectId(userId) },
          {
            // Named fields, never the whole document: a resume carries a base64 profile
            // photo of up to 1 MB, and a list of twenty would be twenty megabytes.
            projection: {
              title: 1,
              createdAt: 1,
              updatedAt: 1,
              "data.name": 1,
              "data.headline": 1,
              "data.templateId": 1,
              "data.accentColor": 1,
            },
          }
        )
        .sort({ updatedAt: -1, _id: -1 })
        .toArray();
      return docs.map(toListItem);
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
