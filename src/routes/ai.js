import { Router } from "express";
import rateLimit from "express-rate-limit";
import { validateBody } from "../middleware/errors.js";
import { summaryRequestSchema, improveRequestSchema } from "../schemas.js";

export function aiRouter({ ai, requireAuth, testing }) {
  const r = Router();
  r.use(requireAuth);
  // Per-user (not per-IP) limit: AI calls cost money.
  r.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 10,
      keyGenerator: (req) => `user:${req.user.id}`,
      standardHeaders: true,
      legacyHeaders: false,
      skip: () => testing,
      message: { error: { code: "RATE_LIMITED", message: "AI rate limit reached, wait a minute" } },
    })
  );

  r.post("/summary", validateBody(summaryRequestSchema), async (req, res) => {
    res.json({ text: await ai.summary(req.body) });
  });
  r.post("/improve", validateBody(improveRequestSchema), async (req, res) => {
    res.json({ text: await ai.improve(req.body) });
  });
  return r;
}
