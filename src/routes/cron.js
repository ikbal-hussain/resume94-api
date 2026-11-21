import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "../middleware/errors.js";

/** Constant-time comparison, so the response time says nothing about how much matched. */
function bearerMatches(header, secret) {
  const presented = Buffer.from(String(header ?? ""));
  const expected = Buffer.from(`Bearer ${secret}`);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * Scheduled jobs. Vercel Cron calls these on the schedule in vercel.json and sends
 * `Authorization: Bearer $CRON_SECRET` when that variable is set.
 *
 * Off by default. With CRON_SECRET unset the route answers the same 404 as a path that
 * does not exist, so a deployment on another host — or one where nobody has set the
 * secret — exposes nothing and does nothing.
 */
export function cronRouter({ config, rateLimits, log = console }) {
  const r = Router();

  /**
   * Keeps the Upstash database from being deleted as idle.
   *
   * The fallback, not the primary: an uptime monitor on /api/health writes to Redis every
   * few minutes. This weekly write covers the case where that monitoring is paused or
   * moved and nothing else touches the database for the 14 days Upstash allows a free one
   * to sit idle. Weekly leaves a week of margin if one run is missed.
   *
   * It writes one key of its own and no rate-limit key, so it cannot change anyone's
   * limit, and a failure here is reported, not thrown past the handler.
   */
  r.get("/keepalive", async (req, res) => {
    if (!config.CRON_SECRET) throw new HttpError(404, "Route not found", "NOT_FOUND");
    if (!bearerMatches(req.get("authorization"), config.CRON_SECRET)) {
      throw new HttpError(401, "Authentication required", "UNAUTHENTICATED");
    }
    if (!rateLimits.configured) return res.json({ kept: false, reason: "no shared store is configured" });

    try {
      res.json({ kept: true, at: await rateLimits.keepAlive() });
    } catch (err) {
      log.error?.(err);
      throw new HttpError(503, "The keep-alive write did not reach the shared store", "KEEPALIVE_FAILED");
    }
  });

  return r;
}
