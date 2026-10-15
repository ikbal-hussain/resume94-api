import { Router } from "express";
import rateLimit from "express-rate-limit";
import { validateBody } from "../middleware/errors.js";
import { failClosed } from "../middleware/rateLimit.js";
import { summaryRequestSchema, improveRequestSchema, importResumeSchema } from "../schemas.js";

// Every route in this router pays a provider per call, so both limiters here fail
// closed: if the shared counter cannot be reached, AI features answer 503 rather than
// run unmetered. The routers that only serve a user their own documents make the
// opposite trade, because there a counter outage costs availability, not money.
const COUNTER_UNREACHABLE = "AI is briefly unavailable — the usage limiter cannot be reached";

export function aiRouter({ ai, requireAuth, rateLimits, testing, log = console }) {
  const r = Router();
  r.use(requireAuth);
  // Per-user (not per-IP) limit: AI calls cost money.
  r.use(
    failClosed(
      rateLimit({
        windowMs: 60 * 1000,
        limit: 10,
        keyGenerator: (req) => `user:${req.user.id}`,
        store: rateLimits.store("ai:calls:"),
        passOnStoreError: false,
        standardHeaders: true,
        legacyHeaders: false,
        skip: () => testing,
        message: { error: { code: "RATE_LIMITED", message: "AI rate limit reached, wait a minute" } },
      }),
      COUNTER_UNREACHABLE,
      log
    )
  );

  r.post("/summary", validateBody(summaryRequestSchema), async (req, res) => {
    res.json({ text: await ai.summary(req.body) });
  });
  r.post("/improve", validateBody(improveRequestSchema), async (req, res) => {
    res.json({ text: await ai.improve(req.body) });
  });

  // An import sends a whole resume and asks for a whole resume back, so one call costs
  // roughly what twenty summaries cost. It is also something a person does once and
  // then not again for weeks, so a window this tight is invisible in normal use and
  // caps what a single account can spend in an afternoon — which only became true with
  // a shared counter. On the in-process store the real ceiling was five imports times
  // however many instances happened to be warm, and it reset on every cold start.
  const importLimiter = failClosed(
    rateLimit({
      windowMs: 10 * 60 * 1000,
      limit: 5,
      keyGenerator: (req) => `import:${req.user.id}`,
      store: rateLimits.store("ai:import:"),
      passOnStoreError: false,
      standardHeaders: true,
      legacyHeaders: false,
      skip: () => testing,
      message: {
        error: { code: "RATE_LIMITED", message: "Too many imports — wait a few minutes and try again" },
      },
    }),
    COUNTER_UNREACHABLE,
    log
  );

  // Validation runs BEFORE the limiter. The limiter exists to cap provider spend, and a
  // request that fails validation never reaches a provider — charging it against a
  // five-per-ten-minutes budget would let a client bug lock someone out of importing
  // for ten minutes without a single call having been made. Malformed requests are
  // still bounded by the router-wide limit above.
  r.post("/import", validateBody(importResumeSchema), importLimiter, async (req, res) => {
    res.json({ data: await ai.parseResume(req.body) });
  });
  return r;
}
