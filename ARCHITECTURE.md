# Architecture — resume94-api

How the service is put together and why. For conventions when changing it, see
[AGENTS.md](./AGENTS.md).

## Shape of the system

```
Browser (React SPA, resume94.ikbalhussain.com)
   │
   │  /api/*  — same-origin, rewritten by Netlify with status 200
   ▼
resume94-api  (Express 5, one Vercel serverless function)
   ├──► MongoDB Atlas          users, resumes, passwordResets
   ├──► Groq  or  Gemini       AI text generation, server-side only
   └──► Resend                 password-reset email
```

The browser never calls this API cross-origin. The frontend host rewrites `/api/*`
here with a **200 rewrite, not a 301 redirect**, which keeps the request first-party to
the site's own domain. That is what makes a `SameSite=Lax` session cookie work at all —
a cross-site XHR would have the cookie withheld, and Safari blocks third-party cookies
outright. CORS is still configured (`CLIENT_ORIGIN`) as a fallback for direct callers.

## Request path

```
api/index.js          Vercel entry. Caches the initialised app across warm invocations
  └─ src/app.js       createApp(config, deps) — builds the Express app
       ├─ helmet, cors, json({limit:"2mb"}), cookie-parser, morgan
       ├─ GET /                     service identity
       ├─ GET /api/health           liveness + DB ping + wiring report
       ├─ /api/docs, /api/openapi.json   behind docsGuard
       ├─ /api/auth      → routes/auth.js
       ├─ /api/resumes   → routes/resumes.js      (requireAuth)
       ├─ /api/ai        → routes/ai.js           (requireAuth)
       ├─ notFound
       └─ errorHandler
```

`src/server.js` is the same app with `listen()` for local development. `api/index.js`
is the serverless entry. Both call `createApp`, so there is one code path, not two.

### Serverless connection reuse

```js
let appPromise;
export default async function handler(req, res) {
  try {
    appPromise ??= init();
    const app = await appPromise;
    return app(req, res);
  } catch (err) {
    appPromise = undefined;   // retry init on the next request
    ...
```

A serverless function is frozen between invocations rather than destroyed, so the Mongo
client and the built app survive on a warm instance and the TLS handshake is paid once
per instance, not once per request. The `catch` clearing `appPromise` matters: without
it a single failed startup — a DNS blip, a slow Atlas — would be cached and every
subsequent request to that instance would fail forever.

## Layers

| Directory | Responsibility |
|---|---|
| `routes/` | HTTP only: validate the body, call down, shape the response |
| `repositories/` | The only place a Mongo collection is touched |
| `services/` | Third-party integrations, each behind a small interface |
| `middleware/` | auth, error translation, docs guard |
| `schemas.js` | Zod validators — also the source of the OpenAPI document |

`createApp` receives `{ db, client, ai, mail, log }` as arguments rather than importing
them. That single decision is what makes the test suite possible: it runs the real
Express app against a real in-memory MongoDB with a fake AI provider, without mocking a
single module.

## Authentication

**Registration and login.** Password hashed with bcrypt. On success the server signs a
JWT whose only claim is `{ sub: <user id> }` and sets it as a cookie:

```js
httpOnly: true     // JavaScript cannot read it, so XSS cannot exfiltrate the session
sameSite: "lax"    // not sent on cross-site requests — CSRF mitigation
secure: <production>
```

The token is never handed to the browser as a value and never stored in
`localStorage`. The frontend does not know it exists; it sends `withCredentials: true`
and the browser attaches the cookie.

**Every protected request** goes through `requireAuth`, which verifies the signature,
reads `sub`, and then **loads the user from the database**. That second step is a
deliberate trade: it costs one round trip per request, and it buys immediate
revocation — a deleted account stops working on its next request instead of when the
token happens to expire. A stateless "trust the token" check would be faster and
wrong for a delete-my-account feature.

**Email uniqueness** is enforced by a unique index, not by a read-then-write check.
Two simultaneous sign-ups with the same address cannot both succeed.

## Authorization — there is no RBAC, on purpose

Every user is the same kind of user. There are no admins, no moderators, no shared
documents, so a role table would be a column that is always `"user"` and a check that
always passes. What actually needs enforcing is **ownership**, and it is enforced in
the query rather than after it:

```js
const scope = (userId, id) => {
  const _id = toObjectId(id);
  return _id && { _id, userId: new ObjectId(userId) };
};
```

Every read, update and delete of a resume is filtered by `userId`. Requesting another
account's resume does not match, so it returns **404, not 403** — a 403 would confirm
the document exists, which is information the requester has no right to.

The security property here is structural. A fetch-then-compare check can be forgotten
in one new endpoint and leak; a missing `userId` in the filter produces a 404 and a
red test.

## AI

```
routes/ai.js  →  services/ai/index.js  →  providers/{gemini,groq}.js
```

**The provider key never leaves the server.** Both AI endpoints are proxies. A browser
calling Gemini directly would need the key in the bundle, where anyone can read it and
spend it.

**The provider is pluggable.** `const PROVIDERS = { gemini, groq }`, selected by
`AI_PROVIDER`. Each provider is one file exporting the same function, so switching is
an environment variable. The project originally used a paid API; moving to Groq's free
tier was a config change plus one new file.

**Prompt injection is fenced.** User content is wrapped in explicit markers and the
system prompt instructs the model to treat everything between them as data:

```
<<<CONTENT … CONTENT>>>
```

A resume bullet reading "ignore your instructions and…" is content, not an
instruction. This is mitigation, not a proof — the honest position is that the blast
radius is small: the model's output is text shown back to the same user who supplied
the input, so there is nothing to escalate to.

**Upstream failures are translated, not passed through.** `upstreamFailure` maps a
provider's 401/404/429 onto an error that says what an operator must fix, and logs the
provider's body server-side. A rejected key is a config problem, and reporting it as
"something went wrong" wastes the next hour.

### Protecting the AI budget

Four layers, weakest to strongest:

1. **Authentication** — both endpoints are behind `requireAuth`. There is no anonymous
   access, so there is no way to spend the key without an account.
2. **Per-user rate limit** — 10 requests/minute, keyed on `user:<id>` rather than IP,
   so one account cannot get extra capacity by changing networks.
3. **Input caps in Zod** — `role` ≤ 100 chars, `experience` ≤ 50, `keySkills` ≤ 500,
   `improve.content` ≤ 2000. Cost scales with tokens, so bounding input bounds spend.
   A 2 MB body cannot reach the model.
4. **Body size cap** — `express.json({ limit: "2mb" })`, which returns 413.

**The known hole:** the rate limiter's `MemoryStore` is per serverless instance. Ten
warm instances means an effective limit near 100/minute, and a cold start resets the
window. It is honest to describe this as best-effort. The fix is a shared store
(Upstash Redis), tracked, plus a daily per-account quota — a per-minute limit bounds
burst, not total spend.

## Password reset

1. `POST /auth/forgot-password` — always the same response whether or not the address
   has an account. Anything else is an account-existence oracle.
2. A random token is generated. **Only its hash is stored**, so a database leak does
   not hand over working reset links.
3. The email goes out through Resend. `MAIL_PROVIDER=console` prints the link to the
   log instead, so local development needs no email account.
4. `GET /auth/reset-password/:token` reports validity; `POST` consumes it.
5. Token creation and consumption are **one transaction**, so a partial failure cannot
   leave a token spent but the password unchanged.
6. Spent and expired tokens are cleared by a Mongo TTL index
   (`expireAfterSeconds: 0`). Lookups still filter on `expiresAt` — the index is
   housekeeping, not the security boundary, because TTL deletion runs on a delay.

## Defence in depth — the whole list

| Concern | Measure |
|---|---|
| Password storage | bcrypt |
| Session theft via XSS | `httpOnly` cookie; the token is never in JS reach |
| CSRF | `SameSite=Lax` |
| Third-party cookie blocking | Same-origin proxy, 200 rewrite not 301 |
| Response headers | helmet |
| Malformed or hostile input | Zod on every body, with length caps |
| Oversized payloads | 2 MB JSON cap → 413 |
| Brute force | Rate limits on auth routes |
| AI key abuse | Auth + per-user limit + input caps (see above) |
| Horizontal privilege escalation | `userId` in every query; 404 not 403 |
| Account enumeration | Identical response from forgot-password |
| Reset-token leak | Only the hash is stored; single use; TTL |
| Timing attack on docs auth | `timingSafeEqual` |
| Reconnaissance | API docs 404 in production unless credentials are set |
| Misconfiguration | `NODE_ENV` defaults to `production` — fails closed |
| Silent deploy failure | `/api/health` + post-deploy smoke test |

## Data model

```
users           { _id, name, email (unique index), passwordHash, createdAt }
resumes         { _id, userId, title, templateId, accent, sections…, updatedAt }
passwordResets  { _id, userId, tokenHash, expiresAt, usedAt }
```

Indexes (`ensureIndexes`, idempotent, run on every cold start):

- `users.email` unique — correctness, not just speed
- `resumes { userId: 1, updatedAt: -1 }` — matches the dashboard's exact query
- `passwordResets.tokenHash` — the lookup path
- `passwordResets.expiresAt` TTL — housekeeping

**Legacy migration on read** (`migrateResume.js`). The original version stored each
section as free text; the current one stores structured roles, dates and bullets.
Rather than a one-shot migration script, documents are converted when they are read,
and anything that cannot be confidently split is preserved as-is rather than dropped.
Old accounts keep working and nobody loses data to a parser's guess.

## Documentation

`src/openapi.js` builds the OpenAPI document by running `z.toJSONSchema` over the same
validators the routes enforce. The docs cannot describe a field the API does not
accept, because there is one definition.

In production both `/api/docs` and `/api/openapi.json` **report 404** unless
`DOCS_USER`/`DOCS_PASSWORD` are set, in which case they sit behind basic auth. A full
endpoint list with every field and every limit is free reconnaissance; a 404 does not
advertise that the route exists at all.

## Known limitations

These are real and stated deliberately — each has a tracked fix.

1. **Rate limits are per instance.** Best-effort on serverless. Needs a shared Redis
   store.
2. **No total AI spend cap.** A per-minute limit bounds burst, not the monthly bill.
   Needs a daily per-account quota.
3. **JWTs cannot be revoked before expiry** in the general case. Mitigated by reloading
   the user on every request, which covers deletion; the full answer is short-lived
   access tokens plus rotating refresh tokens.
4. **The function runs in `iad1` (Washington DC) while Atlas is in `ap-south-1`
   (Mumbai)**, costing roughly 200 ms per database round trip. Measured, not guessed.
   The fix is `"regions": ["bom1"]` in `vercel.json`.
5. **Profile photos are base64 inside the resume document.** Object storage would be
   correct; this is why the JSON limit is 2 MB rather than something sane.
6. **No error tracking.** A 500 in production is visible only in Vercel's logs.
