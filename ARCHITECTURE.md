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
instruction.

**The markers are stripped from the user's text before it is fenced.** A fence only
works while the model can tell where it ends, so content containing `CONTENT>>>` would
close it early and have everything after it read as prompt — which is exactly the
injection the fence exists to stop. Resumes are user-supplied and can say anything.

This is mitigation, not a proof. The honest position is that the blast radius is
small: the model's output is text shown back to the same user who supplied the input,
so there is nothing to escalate to.

**Upstream failures are translated, not passed through.** `upstreamFailure` maps a
provider's 401/404/429 onto an error that says what an operator must fix, and logs the
provider's body server-side. A rejected key is a config problem, and reporting it as
"something went wrong" wastes the next hour.

### Importing an existing resume

`POST /api/ai/import` takes the **plain text** of a resume the user already has and
returns it in the app's structured shape.

It never receives a file. The browser already ships pdf.js for the live preview, so it
extracts the text there and sends a few kilobytes of string. That keeps multipart
parsing, temporary files and a 5 MB upload entirely out of a serverless function, and
it means a PDF that yields almost no text — a rasterised resume, exactly the thing this
product exists to replace — is detected in the browser before a provider call is paid
for.

Two properties make this safe to act on:

- **The model is told to copy, never to invent**, and runs at **temperature 0**.
  Creativity here produces an employer the document never mentioned, which is worse
  than a blank field because the user has no reason to doubt it.
- **Its answer is parsed permissively.** `parsedResumeSchema` coerces and truncates
  where `resumeDataSchema` would reject: a number where a string belongs, a newline
  block where a bullet list belongs, thirteen bullets where twelve are allowed. An
  entry that cannot be understood at all is dropped on its own. A single malformed
  field must not cost the user the whole import — they waited forty seconds for it, and
  the provider call is already spent. The result is then saved through the ordinary
  create path, where `resumeDataSchema` does apply, so nothing skips validation on the
  way into the database.

The reply is also recovered from a ``` fence or a `{"resume": …}` wrapper before
parsing, for the same reason: the expensive work is done, and throwing it away over
punctuation is a poor trade.

Imports are limited to **5 per 10 minutes per user**, separately from the other AI
routes. One import costs roughly what twenty summaries cost, and it is something people
do once and then not again for weeks.

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

The limit is only as good as where it is counted. `MemoryStore` counts per process, so
on serverless ten warm instances meant an effective limit near 100/minute and a cold
start reset the window — the comment claiming this capped what an account could spend in
an afternoon was false in production. Counters now live in Upstash Redis
(`UPSTASH_REDIS_REST_URL` / `_TOKEN`), one key per client per limiter, incremented by a
Lua script so the INCR and its TTL cannot come apart. `/api/health` reports which store
is live and the smoke test fails if production is on `"memory"`, because that is a
misconfiguration no route would otherwise reveal.

**When the counter is unreachable, every limiter degrades** to counting in-process
(`FallbackStore`): a weaker limit — per warm instance, reset on cold start — but never
none. A breaker shared by all limiters skips Upstash for 30 s after a failure, so an
outage does not cost every request Upstash's 2 s deadline. After the cool-down exactly one
request probes Upstash while the rest stay on memory; the probe closes the breaker or
re-opens it. `/api/health` reports `rateLimitFallbackActive` while it is open.

The AI limiters used to **fail closed** instead, answering 503 rather than run on a weak
limit. That turned a deleted free Upstash database into an outage of every AI feature
(November 2026), on a free provider tier where there was no bill to protect.
`AI_FAIL_CLOSED=true` restores it, and is the right setting for a paid key.

**Keeping the free database alive.** Upstash deletes a free database after 14 days
without a command. `/api/health`'s probe writes a key and reads it back (in one Lua
call, cached 30 s per instance), so the uptime monitor that checks health every five
minutes keeps the database alive as a side effect — whatever monitoring tool or host is
used. A weekly Vercel Cron (`GET /api/cron/keepalive`, Mondays 08:30 IST, bearer
`CRON_SECRET`) is the fallback for when monitoring is paused; it writes a key of its own
and never touches a counter.

**The daily allowance** (`services/aiQuota.js`) bounds the day, which a per-minute limit
cannot: ten calls a minute is 14,400 a day from one account, against roughly 1,000
requests and 200,000 tokens a day for the whole app on Groq's free tier.

- **Per account:** `AI_DAILY_CREDITS_PER_USER` credits a day (default 30). A summary or a
  bullet costs 1, an import 5 (`AI_COSTS`). Over it: 429 `AI_QUOTA_EXCEEDED` with
  `Retry-After`.
- **Per app:** `AI_DAILY_TOKENS_GLOBAL` tokens a day (default 180,000), counted from the
  `usage` each provider reports — reasoning tokens included — or estimated at four
  characters a token when it reports none. Over it: 503 `AI_BUDGET_EXHAUSTED` for
  everyone. This is also the backstop for accounts multiplied to get more credits, since
  registration has no email verification yet.
- **Reserve, settle, and refund only what produced nothing.** One Lua script checks both
  limits, spends the credits and reserves an estimate of the call's tokens
  (`TOKEN_ESTIMATES`) atomically, so simultaneous requests can neither both take the last
  credit nor together overrun the budget. The estimate is settled against the provider's
  reported usage before the response is sent (work after the response may never run on
  serverless). `reserve` returns a receipt — keys, day, and which store took it — and the
  settlement and any refund go there, never to the other store or day.
- Credits come back only for errors marked `refundable`: no key, a provider HTTP error, a
  timeout. A reply that arrived but was unusable keeps its charge, because user input can
  cause that and refunding it made "fail on purpose" an unlimited-calls exploit.
- **Provider limits in users' words.** A provider 429 becomes `AI_RATE_LIMITED` ("AI is busy
  right now. Please try again in a minute.", provider `Retry-After` passed on). One that
  names a daily limit becomes `AI_BUDGET_EXHAUSTED` and closes the app's budget for the
  rest of the UTC day, so later calls get the clear answer up front.
- Days are UTC; the allowance resets at 05:30 IST. Counters live in the limiters' Upstash
  database, share their breaker, and fall back to in-process counts the same way (swept
  every ten minutes). Under `AI_FAIL_CLOSED` they always try Upstash and refuse on failure,
  ignoring a breaker another limiter may have tripped.
- `GET /api/ai/usage` reports the allowance for the meter in the AI dialogs, and every AI
  answer carries the usage after its charge. The usage route sits before the per-minute
  AI limiter, so reading it never costs a call; its own in-process limit (30 a minute)
  stops it being used to spend Upstash's command quota.

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

1. **The daily AI allowance can be multiplied with more accounts**, because registration
   has no email verification. The app-wide token budget caps the damage — the worst case
   is AI resting until tomorrow — but it is shared, so one person with many accounts can
   still spend everyone's day.
2. **JWTs cannot be revoked before expiry** in the general case. Mitigated by reloading
   the user on every request, which covers deletion; the full answer is short-lived
   access tokens plus rotating refresh tokens.
3. **The function runs in `iad1` (Washington DC) while Atlas is in `ap-south-1`
   (Mumbai)**, costing roughly 200 ms per database round trip. Measured, not guessed.
   `"regions": ["bom1"]` in `vercel.json` is the obvious fix and **this account cannot
   use it**: a deployment carrying it fails before the build starts, with a 0ms build
   and no log, while the identical tree without it deploys. Region selection is a paid
   feature. Everything the function talks to should therefore be co-located with
   `iad1`, not with Mumbai — which is why the Upstash database is in `us-east-1` even
   though the users and the database are in India.
4. **Profile photos are base64 inside the resume document.** Object storage would be
   correct; this is why the JSON limit is 2 MB rather than something sane.
5. **No error tracking.** A 500 in production is visible only in Vercel's logs.
