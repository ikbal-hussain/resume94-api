import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { usersRepo } from "./repositories/users.js";
import { resumesRepo } from "./repositories/resumes.js";
import { passwordResetsRepo } from "./repositories/passwordResets.js";
import { createAiService } from "./services/ai/index.js";
import { createMailService } from "./services/mail/index.js";
import { requireAuth as makeRequireAuth } from "./middleware/auth.js";
import { notFound, errorHandler } from "./middleware/errors.js";
import { makeWithTransaction } from "./db.js";
import { authRouter } from "./routes/auth.js";
import { resumesRouter } from "./routes/resumes.js";
import { aiRouter } from "./routes/ai.js";
import swaggerUi from "swagger-ui-express";
import { buildOpenApiDocument } from "./openapi.js";

// Dependencies (db, ai) are injectable so tests can run against an
// in-memory database and a fake AI provider.
// `log` is destructured before `mail` because `mail`'s default reads it.
export function createApp(config, { db, client, log = console, ai = createAiService(config), mail = createMailService(config, fetch, log) }) {
  const testing = config.NODE_ENV === "test";
  const users = usersRepo(db);
  const resumes = resumesRepo(db);
  const passwordResets = passwordResetsRepo(db);
  // Without a client (or on a standalone server) this still runs, just not atomically.
  const withTransaction = makeWithTransaction(client, log);
  const requireAuth = makeRequireAuth(config, users);

  const app = express();
  app.set("trust proxy", 1); // correct client IP for rate limiting behind a proxy
  app.use(helmet());
  app.use(cors({ origin: config.CLIENT_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "2mb" })); // resumes embed a base64 profile photo
  app.use(cookieParser());
  if (!testing) app.use(morgan("tiny"));

  // Opening the bare API domain in a browser should explain what this is,
  // rather than 404ing as if the deployment were broken.
  app.get("/", (_req, res) => {
    res.json({
      service: "resume94-api",
      status: "ok",
      docs: "https://github.com/ikbal-hussain/resume94-api",
      docsUi: "/api/docs",
      openapi: "/api/openapi.json",
      health: "/api/health",
    });
  });

  // Interactive docs. Helmet's default CSP blocks swagger-ui's inline styles,
  // so it is disabled for this subtree only.
  const openApiDocument = buildOpenApiDocument();
  app.get("/api/openapi.json", (_req, res) => res.json(openApiDocument));
  app.use(
    "/api/docs",
    (req, res, next) => {
      res.removeHeader("Content-Security-Policy");
      next();
    },
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: "Resume94 API docs",
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    })
  );

  app.get("/api/health", async (_req, res) => {
    await db.command({ ping: 1 });
    res.json({ status: "ok", aiConfigured: Boolean(config[config.AI_PROVIDER === "groq" ? "GROQ_API_KEY" : "GEMINI_API_KEY"]), aiProvider: config.AI_PROVIDER });
  });
  app.use("/api/auth", authRouter({ config, users, passwordResets, mail, withTransaction, requireAuth, testing, log }));
  app.use("/api/resumes", resumesRouter({ resumes, requireAuth }));
  app.use("/api/ai", aiRouter({ ai, requireAuth, testing }));

  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}
