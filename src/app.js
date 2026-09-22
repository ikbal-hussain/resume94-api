import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { usersRepo } from "./repositories/users.js";
import { resumesRepo } from "./repositories/resumes.js";
import { createAiService } from "./services/ai/index.js";
import { requireAuth as makeRequireAuth } from "./middleware/auth.js";
import { notFound, errorHandler } from "./middleware/errors.js";
import { authRouter } from "./routes/auth.js";
import { resumesRouter } from "./routes/resumes.js";
import { aiRouter } from "./routes/ai.js";

// Dependencies (db, ai) are injectable so tests can run against an
// in-memory database and a fake AI provider.
export function createApp(config, { db, ai = createAiService(config), log = console }) {
  const testing = config.NODE_ENV === "test";
  const users = usersRepo(db);
  const resumes = resumesRepo(db);
  const requireAuth = makeRequireAuth(config, users);

  const app = express();
  app.set("trust proxy", 1); // correct client IP for rate limiting behind a proxy
  app.use(helmet());
  app.use(cors({ origin: config.CLIENT_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "2mb" })); // resumes embed a base64 profile photo
  app.use(cookieParser());
  if (!testing) app.use(morgan("tiny"));

  app.get("/api/health", async (_req, res) => {
    await db.command({ ping: 1 });
    res.json({ status: "ok", aiConfigured: Boolean(config[config.AI_PROVIDER === "groq" ? "GROQ_API_KEY" : "GEMINI_API_KEY"]), aiProvider: config.AI_PROVIDER });
  });
  app.use("/api/auth", authRouter({ config, users, requireAuth, testing }));
  app.use("/api/resumes", resumesRouter({ resumes, requireAuth }));
  app.use("/api/ai", aiRouter({ ai, requireAuth, testing }));

  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}
