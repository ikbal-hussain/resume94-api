import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { validateBody, HttpError } from "../middleware/errors.js";
import { resumeBodySchema } from "../schemas.js";

export function resumesRouter({ resumes, requireAuth, rateLimits, testing }) {
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
      store: rateLimits.store("resumes:"),
      // Fail open. A counter outage here must not stop someone saving their own
      // resume: the worst an unmetered minute costs is database writes we already
      // pay for, which is not the trade the AI routes make.
      passOnStoreError: true,
      // Per account, not per IP. The IP is only a fallback — requireAuth runs first,
      // so it is reached only if that ever changes. It goes through ipKeyGenerator
      // because an IPv6 client gets a fresh address at will, and counting the raw
      // address hands out a fresh bucket with it; the helper counts the /56 subnet.
      keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip),
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
