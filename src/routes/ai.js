import { Router } from "express";
import rateLimit from "express-rate-limit";
import { validateBody, HttpError } from "../middleware/errors.js";
import { failClosed } from "../middleware/rateLimit.js";
import { summaryRequestSchema, improveRequestSchema, importResumeSchema } from "../schemas.js";
import { AI_COSTS, TOKEN_ESTIMATES } from "../services/aiQuota.js";

// What happens when the shared counter cannot be reached is a setting, because the right
// answer depends on whether the provider key costs money.
//
// By default these limiters degrade like every other one: the store falls back to
// counting in this process (see services/rateLimit/fallback.js), so AI keeps working on a
// weaker, per-instance limit. On a free provider tier that is the right trade — there is
// no bill to protect, and failing closed turned a deleted free Redis database into an
// outage of every AI feature for every user.
//
// AI_FAIL_CLOSED=true restores the strict behaviour for a paid key: the stores stop
// degrading, their errors reach the limiter, and `failClosed` answers 503 rather than let
// a call through on a limit that is not the real one. The wrapper and
// `passOnStoreError: false` stay in place either way; with a degrading store they simply
// never see an error.
const COUNTER_UNREACHABLE = "AI is briefly unavailable — the usage limiter cannot be reached";

export function aiRouter({ config, ai, aiQuota, requireAuth, rateLimits, testing, log = console }) {
  const r = Router();
  const degrade = !config.AI_FAIL_CLOSED;
  r.use(requireAuth);

  // Today's credits, for the meter in the AI dialogs. Registered before the AI limiter on
  // purpose: reading the meter must never use up the allowance for making calls. It has
  // a limiter of its own, because each read is an Upstash command and Upstash's free tier
  // has a daily command ceiling — the same reason the health probe is cached. That one
  // counts in this process (no store option), so guarding Upstash costs no Upstash
  // commands; per instance is plenty to stop a script looping on it.
  const usageLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    keyGenerator: (req) => `usage:${req.user.id}`,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many requests, wait a minute" } },
  });
  r.get("/usage", usageLimiter, async (req, res) => {
    res.json(await aiQuota.usage(req.user.id));
  });

  /**
   * Runs one AI call against the daily allowance.
   *
   * Credits and an estimate of the call's tokens are reserved before the provider is
   * called, so simultaneous requests can neither both spend the last credit nor together
   * overrun the app's budget. Afterwards the estimate is settled against what the
   * provider reported, before the response is sent: on serverless, work after the
   * response may never run, and the budget would undercount every successful call.
   *
   * Credits come back only when no reply was produced — not configured, the provider's
   * HTTP error, a timeout (errors marked `refundable`). A reply that arrived but was
   * unusable (malformed JSON, a resume that fails validation) keeps the charge: user
   * input can cause that, and refunding it would let anyone get unlimited calls by
   * making them fail on purpose.
   */
  const charged = (kind, call) => async (req, res) => {
    const { receipt } = await aiQuota.reserve(req.user.id, AI_COSTS[kind], TOKEN_ESTIMATES[kind]);
    let tokens = 0;
    let result;
    try {
      result = await call(req.body, { onTokens: (n) => (tokens += n) });
    } catch (err) {
      if (err?.refundable) await aiQuota.refund(receipt);
      await aiQuota.settle(receipt, tokens);
      if (err?.dailyLimit) await aiQuota.exhaust();
      throw err;
    }
    const usage = await aiQuota.settle(receipt, tokens);
    res.json({ ...result, usage });
  };
  // Every route below spends the shared provider budget, so it needs an account that
  // has proved it owns its address (RESUME-3): otherwise each throwaway sign-up is a fresh
  // daily allowance. Checked before the limiters so a refused call spends nothing. The
  // meter above stays open, since the app shows it either way.
  r.use((req, _res, next) => {
    if (req.user.emailVerified) return next();
    next(new HttpError(403, "Confirm your email address to use AI features", "EMAIL_UNVERIFIED"));
  });

  // Per-user (not per-IP) limit: AI calls cost money.
  r.use(
    failClosed(
      rateLimit({
        windowMs: 60 * 1000,
        limit: 10,
        keyGenerator: (req) => `user:${req.user.id}`,
        store: rateLimits.store("ai:calls:", { degrade }),
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

  r.post(
    "/summary",
    validateBody(summaryRequestSchema),
    charged("summary", async (body, opts) => ({ text: await ai.summary(body, opts) }))
  );
  r.post(
    "/improve",
    validateBody(improveRequestSchema),
    charged("improve", async (body, opts) => ({ text: await ai.improve(body, opts) }))
  );

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
      store: rateLimits.store("ai:import:", { degrade }),
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
  r.post(
    "/import",
    validateBody(importResumeSchema),
    importLimiter,
    charged("import", async (body, opts) => ({ data: await ai.parseResume(body, opts) }))
  );
  return r;
}
