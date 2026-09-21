import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4100),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  MONGODB_URI: z.string().optional(),
  MONGODB_DB: z.string().default("resume94"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters").optional(),
  JWT_EXPIRES_IN: z.string().default("7d"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
});

export function loadConfig(env = process.env) {
  const cfg = schema.parse(env);
  if (!cfg.JWT_SECRET) {
    if (cfg.NODE_ENV === "production") {
      throw new Error("JWT_SECRET is required in production");
    }
    // Dev/test convenience only: sessions won't survive a restart.
    cfg.JWT_SECRET = "dev-only-insecure-secret-" + Math.random().toString(36).slice(2);
  }
  return cfg;
}
