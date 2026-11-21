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
import { createGoogleService } from "./services/google.js";
import { createRateLimitService } from "./services/rateLimit/index.js";
import { requireAuth as makeRequireAuth } from "./middleware/auth.js";
import { notFound, errorHandler } from "./middleware/errors.js";
import { makeWithTransaction, pingDatabase } from "./db.js";
import { docsGuard } from "./middleware/docsAuth.js";
import { authRouter } from "./routes/auth.js";
import { resumesRouter } from "./routes/resumes.js";
import { aiRouter } from "./routes/ai.js";
import { cronRouter } from "./routes/cron.js";
import swaggerUi from "swagger-ui-express";
import { buildOpenApiDocument } from "./openapi.js";

// Dependencies (db, ai) are injectable so tests can run against an
// in-memory database and a fake AI provider.
// `log` is destructured before `mail` because `mail`'s default reads it.
export function createApp(config, {
  db,
  client,
  log = console,
  ai = createAiService(config),
  mail = createMailService(config, fetch, log),
  google = createGoogleService(config),
  // Counters for the rate limiters. Injected like the others so a test can assert on
  // hits without a network, and so an unconfigured store degrades instead of throwing.
  rateLimits = createRateLimitService(config, fetch, log),
  // Injectable so a test can force the losing side of a race that is otherwise a
  // microsecond wide between two queries.
  users = usersRepo(db),
}) {
  const testing = config.NODE_ENV === "test";
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
      health: "/api/health",
    });
  });

  // Interactive docs. Helmet's default CSP blocks swagger-ui's inline styles,
  // so it is disabled for this subtree only.
  const openApiDocument = buildOpenApiDocument();
  const docs = docsGuard(config);
  app.get("/api/openapi.json", docs, (_req, res) => res.json(openApiDocument));
  app.use(
    "/api/docs",
    docs,
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

  // Everything the post-deploy smoke test needs to judge a release: which build is
  // answering, and whether each dependency it cannot reach from outside is wired up.
  // mail is included deliberately -- a MAIL_PROVIDER left at "console" in production
  // is invisible from any other endpoint until someone requests a password reset.
  //
  // The status code is the verdict, so any uptime monitor can read it without parsing:
  // 503 when a dependency that should answer did not — MongoDB, or a configured Redis.
  // It answered 200 with `rateLimitStoreReachable: false` for weeks while every AI route
  // was down, and the monitor watching it saw nothing wrong. The body still says which
  // dependency failed. An unconfigured store (null) is not a failure here: that is the
  // normal local setup, and production being on it is the smoke test's job to catch.
  app.get("/api/health", async (_req, res) => {
    const [databaseReachable, rateLimitStoreReachable] = await Promise.all([
      pingDatabase(db, { log }),
      rateLimits.ping(),
    ]);
    const healthy = databaseReachable && rateLimitStoreReachable !== false;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      commit: config.VERCEL_GIT_COMMIT_SHA ?? null,
      databaseReachable,
      aiConfigured: Boolean(config[config.AI_PROVIDER === "groq" ? "GROQ_API_KEY" : "GEMINI_API_KEY"]),
      aiProvider: config.AI_PROVIDER,
      mailConfigured: mail.configured,
      mailProvider: mail.provider,
      googleConfigured: google.configured,
      // "memory" in production means every limit is multiplied by the number of warm
      // instances. Nothing else in the API shows that, and the route it matters most on
      // is the one that pays a provider per call.
      rateLimitStore: rateLimits.provider,
      // Reachable, not merely configured: the probe writes a key and reads it back. A
      // mistyped token reads as "upstash" from the line above while every limit runs on
      // its in-process fallback, so this is probed rather than inferred from the
      // environment. null when there is nothing to reach.
      rateLimitStoreReachable,
      // True while a recent Upstash failure has the limiters counting in this process
      // (the breaker is open). The probe above is cached for 30 s and runs on its own, so
      // without this an Upstash that keeps timing out on counter calls but answers the
      // probe would read as healthy while limits were per instance. Reported, not part of
      // the 503 verdict: degraded limits are a warning, and the probe owns "down".
      rateLimitFallbackActive: rateLimits.fallbackActive(),
    });
  });
  app.use("/api/auth", authRouter({ config, users, passwordResets, mail, google, withTransaction, requireAuth, rateLimits, testing, log }));
  app.use("/api/resumes", resumesRouter({ resumes, requireAuth, rateLimits, testing }));
  app.use("/api/ai", aiRouter({ config, ai, requireAuth, rateLimits, testing, log }));
  app.use("/api/cron", cronRouter({ config, rateLimits, log }));

  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}
