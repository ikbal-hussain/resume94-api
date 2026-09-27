import { Router } from "express";
import rateLimit from "express-rate-limit";
import { validateBody, HttpError } from "../middleware/errors.js";
import { resumeBodySchema } from "../schemas.js";

export function resumesRouter({ resumes, requireAuth, testing }) {
  const r = Router();
  r.use(requireAuth);

  // Authenticated, but every write still carries a document up to 2MB. Generous
  // enough that editing never trips it, low enough to bound what one account costs.
  r.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
      skip: () => testing,
      keyGenerator: (req) => req.user?.id ?? req.ip, // per account, not per IP
      message: { error: { code: "RATE_LIMITED", message: "Too many requests, slow down a moment" } },
    })
  );

  const idOf = (req) => req.params.id; // repo treats malformed ids as "not found"
  const found = (resume) => {
    if (!resume) throw new HttpError(404, "Resume not found", "NOT_FOUND");
    return resume;
  };

  r.get("/", async (req, res) => res.json({ resumes: await resumes.list(req.user.id) }));

  r.post("/", validateBody(resumeBodySchema), async (req, res) => {
    res.status(201).json({ resume: await resumes.create(req.user.id, req.body) });
  });

  r.get("/:id", async (req, res) => {
    res.json({ resume: found(await resumes.find(req.user.id, idOf(req))) });
  });

  r.put("/:id", validateBody(resumeBodySchema), async (req, res) => {
    res.json({ resume: found(await resumes.update(req.user.id, idOf(req), req.body)) });
  });

  r.delete("/:id", async (req, res) => {
    if (!(await resumes.delete(req.user.id, idOf(req)))) found(null);
    res.status(204).end();
  });

  r.post("/:id/duplicate", async (req, res) => {
    res.status(201).json({ resume: found(await resumes.duplicate(req.user.id, idOf(req))) });
  });

  return r;
}
