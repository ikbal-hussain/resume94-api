import { z } from "zod";
import {
  registerSchema,
  loginSchema,
  updateProfileSchema,
  resumeBodySchema,
  resumeDataSchema,
  summaryRequestSchema,
  improveRequestSchema,
  importResumeSchema,
  parsedResumeSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "./schemas.js";

// Request schemas are derived from the same Zod validators the routes enforce, so the
// documentation cannot drift from the actual behaviour.
const toSchema = (schema) => {
  // OpenAPI 3.0 rejects the top-level $schema keyword that Zod emits.
  const { $schema, ...rest } = z.toJSONSchema(schema, { io: "input" });
  return rest;
};

/**
 * For a schema that only ever describes a response.
 *
 * `io: "output"` rather than "input": these are the values after defaults and coercion
 * have been applied, which is what the client actually receives.
 */
const toResponseSchema = (schema) => {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io: "output" });
  return rest;
};

const json = (schema) => ({ content: { "application/json": { schema } } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

const error = (description) => ({
  description,
  ...json({
    type: "object",
    properties: {
      error: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          details: { type: "array", items: { type: "object" } },
        },
      },
    },
  }),
});

const userResponse = {
  type: "object",
  properties: {
    user: {
      type: "object",
      properties: {
        id: { type: "string", example: "6ab419b31fc671e5a992e72f" },
        name: { type: "string", example: "Ada Lovelace" },
        email: { type: "string", format: "email" },
        createdAt: { type: "string", format: "date-time" },
      },
    },
  },
};

const resumeSummary = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    name: { type: "string", description: "Convenience copy of data.name" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const resumeFull = {
  allOf: [resumeSummary, { type: "object", properties: { data: ref("ResumeData") } }],
};

const idParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Resume id. Ids belonging to another account return 404, never 403.",
};

const auth = [{ cookieAuth: [] }];
const unauthorized = error("Not signed in, or the session cookie has expired");
const notFound = error("No such resume for this account");
const validation = error("Request body failed validation");

export function buildOpenApiDocument() {
  return {
    openapi: "3.0.3",
    info: {
      title: "Resume94 API",
      version: "1.0.0",
      description:
        "REST API for the Resume94 resume builder.\n\n" +
        "**Authentication** uses a JWT in an `httpOnly`, `SameSite=Lax` cookie set by " +
        "`/auth/register` and `/auth/login`. Because the cookie is `httpOnly` it is not " +
        "readable from JavaScript; send requests with credentials included.\n\n" +
        "**Authorisation**: every resume query is scoped to the signed-in user, so another " +
        "account's id is indistinguishable from one that does not exist (404).",
    },
    servers: [
      { url: "https://resume94-api.vercel.app/api", description: "Production" },
      { url: "http://localhost:4100/api", description: "Local" },
    ],
    tags: [
      { name: "Service", description: "Liveness" },
      { name: "Auth", description: "Registration, sessions and account management" },
      { name: "Resumes", description: "CRUD for a user's resumes" },
      { name: "AI", description: "Provider-backed text generation (rate limited per user)" },
    ],
    components: {
      securitySchemes: {
        cookieAuth: { type: "apiKey", in: "cookie", name: "token" },
      },
      schemas: {
        ResumeData: toSchema(resumeDataSchema),
        ResumeBody: toSchema(resumeBodySchema),
        RegisterBody: toSchema(registerSchema),
        LoginBody: toSchema(loginSchema),
        UpdateProfileBody: toSchema(updateProfileSchema),
        SummaryRequest: toSchema(summaryRequestSchema),
        ImproveRequest: toSchema(improveRequestSchema),
        ImportRequest: toSchema(importResumeSchema),
        // Content fields only. Deliberately NOT ResumeData: the import never returns
        // templateId, accentColor, sectionOrder or profileImage, because those are
        // presentation and are not something a model should be guessing at.
        ImportedResumeData: toResponseSchema(parsedResumeSchema),
        ForgotPasswordBody: toSchema(forgotPasswordSchema),
        ResetPasswordBody: toSchema(resetPasswordSchema),
      },
    },
    paths: {
      "/health": {
        get: {
          tags: ["Service"],
          summary: "Liveness and configuration check",
          description:
            "Pings MongoDB and reports which build is answering and whether the AI and " +
            "mail transports are configured. Used by the post-deploy smoke test.",
          responses: {
            200: {
              description: "Service is healthy",
              ...json({
                type: "object",
                properties: {
                  status: { type: "string", example: "ok" },
                  commit: {
                    type: "string",
                    nullable: true,
                    description: "Git SHA of the running deployment, or null outside Vercel",
                  },
                  aiConfigured: { type: "boolean" },
                  aiProvider: { type: "string", enum: ["gemini", "groq"] },
                  mailConfigured: { type: "boolean" },
                  mailProvider: { type: "string", enum: ["console", "resend"] },
                },
              }),
            },
          },
        },
      },

      "/auth/register": {
        post: {
          tags: ["Auth"],
          summary: "Create an account and start a session",
          requestBody: { required: true, ...json(ref("RegisterBody")) },
          responses: {
            201: { description: "Account created; session cookie set", ...json(userResponse) },
            400: validation,
            409: error("That email is already registered"),
            429: error("Too many attempts (20 per 15 minutes per IP)"),
          },
        },
      },
      "/auth/login": {
        post: {
          tags: ["Auth"],
          summary: "Sign in",
          description:
            "Returns the same error for an unknown email and a wrong password, so accounts cannot be enumerated.",
          requestBody: { required: true, ...json(ref("LoginBody")) },
          responses: {
            200: { description: "Signed in; session cookie set", ...json(userResponse) },
            401: error("Invalid email or password"),
            429: error("Too many attempts (20 per 15 minutes per IP)"),
          },
        },
      },
      "/auth/forgot-password": {
        post: {
          tags: ["Auth"],
          summary: "Request a password-reset link",
          description:
            "Always returns 204, whether or not the address has an account, so this cannot be " +
            "used to discover who is registered. When the account exists a single-use link is " +
            "emailed; it expires after RESET_TOKEN_TTL_MINUTES (60 by default).",
          requestBody: { required: true, ...json(ref("ForgotPasswordBody")) },
          responses: {
            204: { description: "Request accepted (sent only if the account exists)" },
            400: error("The email field is missing or malformed"),
            429: error("Too many reset requests (5 per hour per IP)"),
          },
        },
      },
      "/auth/reset-password/{token}": {
        get: {
          tags: ["Auth"],
          summary: "Check whether a reset link is still usable",
          description: "Lets the reset page report an expired link before the user types a new password.",
          parameters: [
            { name: "token", in: "path", required: true, schema: { type: "string" }, description: "Token from the emailed link" },
          ],
          responses: {
            200: {
              description: "Validity of the token",
              ...json({ type: "object", properties: { valid: { type: "boolean" } } }),
            },
          },
        },
      },
      "/auth/reset-password": {
        post: {
          tags: ["Auth"],
          summary: "Set a new password using a reset link",
          description:
            "Consumes the token and every other outstanding token for that account, then signs " +
            "the user in. Sessions issued before the reset stay valid until they expire.",
          requestBody: { required: true, ...json(ref("ResetPasswordBody")) },
          responses: {
            200: { description: "Password changed; session cookie set", ...json(userResponse) },
            400: error("The link is invalid, already used, or expired"),
            429: error("Too many reset attempts (5 per hour per IP)"),
          },
        },
      },
      "/auth/logout": {
        post: { tags: ["Auth"], summary: "Clear the session cookie", responses: { 204: { description: "Signed out" } } },
      },
      "/auth/me": {
        get: {
          tags: ["Auth"],
          summary: "Current user",
          security: auth,
          responses: { 200: { description: "The signed-in user", ...json(userResponse) }, 401: unauthorized },
        },
        patch: {
          tags: ["Auth"],
          summary: "Rename the current user",
          security: auth,
          requestBody: { required: true, ...json(ref("UpdateProfileBody")) },
          responses: { 200: { description: "Updated user", ...json(userResponse) }, 400: validation, 401: unauthorized },
        },
        delete: {
          tags: ["Auth"],
          summary: "Delete the account and all of its resumes",
          security: auth,
          responses: { 204: { description: "Account and resumes deleted" }, 401: unauthorized },
        },
      },

      "/resumes": {
        get: {
          tags: ["Resumes"],
          summary: "List the user's resumes",
          description: "Returns summaries without the full `data` payload, so the list stays small.",
          security: auth,
          responses: {
            200: {
              description: "Resumes, most recently updated first",
              ...json({ type: "object", properties: { resumes: { type: "array", items: resumeSummary } } }),
            },
            401: unauthorized,
          },
        },
        post: {
          tags: ["Resumes"],
          summary: "Create a resume",
          security: auth,
          requestBody: { required: true, ...json(ref("ResumeBody")) },
          responses: {
            201: { description: "Created", ...json({ type: "object", properties: { resume: resumeFull } }) },
            400: validation,
            401: unauthorized,
          },
        },
      },
      "/resumes/{id}": {
        get: {
          tags: ["Resumes"],
          summary: "Fetch one resume",
          description: "Resumes saved before structured sections existed are migrated on read.",
          security: auth,
          parameters: [idParam],
          responses: {
            200: { description: "The resume", ...json({ type: "object", properties: { resume: resumeFull } }) },
            401: unauthorized,
            404: notFound,
          },
        },
        put: {
          tags: ["Resumes"],
          summary: "Replace a resume",
          security: auth,
          parameters: [idParam],
          requestBody: { required: true, ...json(ref("ResumeBody")) },
          responses: {
            200: { description: "Updated", ...json({ type: "object", properties: { resume: resumeFull } }) },
            400: validation,
            401: unauthorized,
            404: notFound,
          },
        },
        delete: {
          tags: ["Resumes"],
          summary: "Delete a resume",
          security: auth,
          parameters: [idParam],
          responses: { 204: { description: "Deleted" }, 401: unauthorized, 404: notFound },
        },
      },
      "/resumes/{id}/duplicate": {
        post: {
          tags: ["Resumes"],
          summary: "Copy a resume",
          description: 'The copy is titled "<original> (copy)".',
          security: auth,
          parameters: [idParam],
          responses: {
            201: { description: "The new copy", ...json({ type: "object", properties: { resume: resumeFull } }) },
            401: unauthorized,
            404: notFound,
          },
        },
      },

      "/ai/summary": {
        post: {
          tags: ["AI"],
          summary: "Generate a professional summary",
          description: "Limited to 10 requests per minute per user, because provider calls cost money.",
          security: auth,
          requestBody: { required: true, ...json(ref("SummaryRequest")) },
          responses: {
            200: { description: "Generated text", ...json({ type: "object", properties: { text: { type: "string" } } }) },
            400: validation,
            401: unauthorized,
            429: error("Per-user AI rate limit reached"),
            502: error("The provider rejected the request (bad key, unknown model, or upstream failure)"),
            503: error("No AI provider key is configured"),
          },
        },
      },
      "/ai/improve": {
        post: {
          tags: ["AI"],
          summary: "Rewrite one resume entry",
          description:
            "The submitted text is fenced in the prompt and the model is told to treat it as content, " +
            "never as instructions, to blunt prompt injection.",
          security: auth,
          requestBody: { required: true, ...json(ref("ImproveRequest")) },
          responses: {
            200: { description: "Rewritten text", ...json({ type: "object", properties: { text: { type: "string" } } }) },
            400: validation,
            401: unauthorized,
            429: error("Per-user AI rate limit reached"),
            502: error("The provider rejected the request"),
            503: error("No AI provider key is configured"),
          },
        },
      },
      "/ai/import": {
        post: {
          tags: ["AI"],
          summary: "Parse an existing resume into structured fields",
          description:
            "Takes the plain text of a resume the user already has and returns it in the shape " +
            "of `ResumeData`, so it can be reviewed and saved as a new resume.\n\n" +
            "The text is extracted in the browser — this endpoint never receives a file. " +
            "Only content fields are returned (`ImportedResumeData`); template, accent colour, " +
            "section order and profile photo are presentation and are not guessed.\n\n" +
            "The model is told to copy and never invent, and runs at temperature 0. Its answer " +
            "is parsed permissively: a field it returns in the wrong shape is coerced or " +
            "dropped rather than failing the whole import.\n\n" +
            "Limited to **5 requests per 10 minutes per user** — a much larger prompt than the " +
            "other AI endpoints, and an action people take rarely.",
          security: auth,
          requestBody: { required: true, ...json(ref("ImportRequest")) },
          responses: {
            200: {
              description: "The extracted resume content",
              ...json({ type: "object", properties: { data: ref("ImportedResumeData") } }),
            },
            400: error("The text is shorter than 200 characters or longer than 20,000"),
            401: unauthorized,
            429: error("Import rate limit reached (5 per 10 minutes)"),
            502: error("The provider failed, or did not return usable JSON"),
            503: error("No AI provider key is configured"),
          },
        },
      },
    },
  };
}
