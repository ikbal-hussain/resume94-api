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
  // Password-reset delivery. "console" prints the link to the server log, which is all
  // local development needs; "resend" sends for real. See services/mail/providers.
  MAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default("Resume94 <onboarding@resend.dev>"),
  RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  // Basic-auth credentials for /api/docs in production. Unset means the docs are
  // not served there at all.
  DOCS_USER: z.string().optional(),
  DOCS_PASSWORD: z.string().optional(),
  // Injected by Vercel. Reported on /api/health so the post-deploy smoke test can
  // tell the new deployment apart from the one it is replacing, instead of passing
  // against the old build and declaring a broken release healthy.
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
});

export function loadConfig(env = process.env) {
  const cfg = schema.parse(env);
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
