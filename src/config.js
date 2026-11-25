import { z } from "zod";

const schema = z.object({
  // Defaults to production so an unset NODE_ENV fails closed. Four security
  // behaviours key off this — the docs guard, the cookie Secure flag, the refusal
  // of the console mail transport, and whether JWT_SECRET is mandatory — and a
  // development default silently relaxed all of them on any host that leaves it
  // unset. Local work sets it in .env; the test helpers set it explicitly.
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: z.coerce.number().default(4100),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  MONGODB_URI: z.string().optional(),
  MONGODB_DB: z.string().default("resume94"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters").optional(),
  JWT_EXPIRES_IN: z.string().default("7d"),
  AI_PROVIDER: z.enum(["gemini", "groq"]).default("gemini"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().optional(),
  // Google sign-in. Unset simply disables it: the route 503s and the frontend hides
  // the button, so the feature can ship before a client ID exists. The secret is not
  // listed because this integration never exchanges an authorization code.
  GOOGLE_CLIENT_ID: z.string().optional(),
  // Password-reset delivery. "console" prints the link to the server log, which is all
  // local development needs; "resend" sends for real. See services/mail/providers.
  MAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default("Resume94 <onboarding@resend.dev>"),
  RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  // Verification links get longer than reset links: they unlock less (AI only, never the
  // account), and people often open the email hours after signing up.
  VERIFY_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(48),
  VERIFY_MAILS_PER_HOUR_PER_IP: z.coerce.number().int().positive().default(20),
  // Shared store for rate-limit counters. Both unset means the limiters fall back to
  // an in-process store, which on serverless counts per instance — correct for local
  // work and the tests, wrong in production. /api/health reports which one is live.
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  // What the AI limiters do when Upstash cannot answer. Unset (false), they keep counting
  // in-process, like every other limiter: on a free provider tier there is no bill to
  // protect, and refusing turned a deleted Redis database into an AI outage. Set it to
  // "true" with a paid key, where an unmetered minute costs money and refusing is cheaper.
  // Read leniently in loadConfig (see readBoolean): a typo here must not take down auth.
  AI_FAIL_CLOSED: z.boolean().default(false),
  // Daily AI allowance. Credits per account (a summary or a bullet costs 1, an import 5),
  // and tokens for the whole app, counted from what the provider reports. The token
  // default sits under Groq's free tier of 200,000 a day; raise both with a paid key.
  // Read leniently too (see readPositiveInt).
  AI_DAILY_CREDITS_PER_USER: z.number().int().positive().default(30),
  AI_DAILY_TOKENS_GLOBAL: z.number().int().positive().default(180_000),
  // Bearer secret Vercel Cron sends with the weekly keep-alive. Unset means the route
  // answers 404, so the job is off by default and inert on any other host. Empty or
  // shorter than 16 characters counts as unset, with a warning (see loadConfig).
  CRON_SECRET: z.string().optional(),
  // Basic-auth credentials for /api/docs in production. Unset means the docs are
  // not served there at all.
  DOCS_USER: z.string().optional(),
  DOCS_PASSWORD: z.string().optional(),
  // Injected by Vercel. Reported on /api/health so the post-deploy smoke test can
  // tell the new deployment apart from the one it is replacing, instead of passing
  // against the old build and declaring a broken release healthy.
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  // Also injected by Vercel: production, preview or development. Used as Sentry's
  // environment, so a preview deployment's errors do not land among production's.
  VERCEL_ENV: z.string().optional(),
  // Error tracking. Unset or empty means off: the SDK is never loaded and nothing is sent.
  SENTRY_DSN: z.string().optional(),
});

const TRUE = new Set(["true", "1", "yes", "on"]);
const FALSE = new Set(["false", "0", "no", "off"]);

/**
 * The usual spellings of a boolean, case-insensitive. Anything else falls back to the
 * default with a warning instead of throwing: these settings each govern one feature,
 * and a strict parse turned "AI_FAIL_CLOSED=1" into every route answering 500.
 */
function readBoolean(env, name, fallback, warn) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (TRUE.has(value)) return true;
  if (FALSE.has(value)) return false;
  warn(`[config] ${name}="${raw}" is not true/false; using the default (${fallback}).`);
  return fallback;
}

/** A positive whole number, or the default with a warning: same reasoning as readBoolean. */
function readPositiveInt(env, name, fallback, warn) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(String(raw).trim().replace(/_/g, ""));
  if (Number.isInteger(value) && value > 0) return value;
  warn(`[config] ${name}="${raw}" is not a positive whole number; using the default (${fallback}).`);
  return fallback;
}

/** A secret that is empty counts as unset; one too short to be safe is ignored, loudly. */
function readSecret(env, name, minLength, warn) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  if (raw.length < minLength) {
    warn(`[config] ${name} is shorter than ${minLength} characters, so it is ignored (the feature it guards stays off).`);
    return undefined;
  }
  return raw;
}

export function loadConfig(env = process.env, { warn = console.warn } = {}) {
  const cfg = schema.parse({
    ...env,
    AI_FAIL_CLOSED: readBoolean(env, "AI_FAIL_CLOSED", false, warn),
    CRON_SECRET: readSecret(env, "CRON_SECRET", 16, warn),
    AI_DAILY_CREDITS_PER_USER: readPositiveInt(env, "AI_DAILY_CREDITS_PER_USER", 30, warn),
    AI_DAILY_TOKENS_GLOBAL: readPositiveInt(env, "AI_DAILY_TOKENS_GLOBAL", 180_000, warn),
  });
  if (!cfg.JWT_SECRET) {
    if (cfg.NODE_ENV === "production") {
      throw new Error(
        "JWT_SECRET is required in production. If this is a local run, set NODE_ENV=development " +
          "in .env (copy .env.example) — NODE_ENV defaults to production so an unset value fails closed."
      );
    }
    // Dev/test convenience only: sessions won't survive a restart.
    cfg.JWT_SECRET = "dev-only-insecure-secret-" + Math.random().toString(36).slice(2);
  }
  // The console transport is still refused in production, but in createMailService
  // rather than here: throwing at startup over a mail setting took the entire API
  // down — auth, resumes and AI — when only password reset was affected.
  return cfg;
}
