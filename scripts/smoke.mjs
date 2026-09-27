#!/usr/bin/env node
/**
 * Post-deploy smoke test: asserts a handful of invariants against the real
 * deployment, from outside, over the public internet.
 *
 * It exists because of a specific incident. A startup throw added for a mail
 * setting took down every route — auth, resumes and AI — and nothing noticed:
 * the unit suite was green, the deploy reported success, and the failure was
 * found by a person opening the site. Each check below is something that was
 * either broken that day or would have been the next one.
 *
 * Waits for EXPECT_COMMIT to be the build answering before asserting anything,
 * so it cannot pass against the deployment it is replacing.
 *
 *   BASE_URL=https://resume94-api.vercel.app node scripts/smoke.mjs
 */

const BASE_URL = (process.env.BASE_URL ?? "https://resume94-api.vercel.app").replace(/\/$/, "");
const EXPECT_COMMIT = process.env.SMOKE_EXPECT_COMMIT || null;
const DEPLOY_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 300_000);
const POLL_INTERVAL_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = async (path, init) => {
  const res = await fetch(`${BASE_URL}${path}`, { redirect: "manual", ...init });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
};

/**
 * Blocks until /api/health reports the commit we just pushed.
 *
 * Without this the whole run is a lie: Vercel answers from the previous build
 * until the new one is promoted, so every check would pass against the code
 * that was already known to work.
 */
async function waitForDeploy() {
  if (!EXPECT_COMMIT) {
    console.log("• no SMOKE_EXPECT_COMMIT set — testing whatever is live\n");
    return;
  }
  const want = EXPECT_COMMIT.slice(0, 7);
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const { status, body } = await get("/api/health").catch(() => ({ status: 0, body: null }));
    const live = body?.commit ?? null;
    if (status === 200 && live === EXPECT_COMMIT) {
      console.log(`• ${want} is live\n`);
      return;
    }
    const seen = live ? live.slice(0, 7) : `HTTP ${status}`;
    console.log(`  waiting for ${want} — currently ${seen}`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `${want} was still not live after ${DEPLOY_TIMEOUT_MS / 1000}s. ` +
      "Either the deploy failed, or it is crashing before it can answer /api/health."
  );
}

const results = [];
async function check(name, fn) {
  try {
    const note = await fn();
    results.push({ ok: true, name, note });
  } catch (err) {
    results.push({ ok: false, name, note: err.message });
  }
}

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function run() {
  await waitForDeploy();

  await check("health: 200, database reachable", async () => {
    const { status, body } = await get("/api/health");
    // The DB ping runs inside the handler, so a 200 here also proves Mongo answered.
    expect(status === 200, `expected 200, got ${status}`);
    expect(body?.status === "ok", `status was ${body?.status}`);
    return `commit ${body.commit ? body.commit.slice(0, 7) : "unknown"}`;
  });

  await check("health: AI provider configured", async () => {
    const { body } = await get("/api/health");
    expect(body?.aiConfigured === true, `aiConfigured was ${body?.aiConfigured} (${body?.aiProvider})`);
    return body.aiProvider;
  });

  await check("health: real mail transport", async () => {
    const { body } = await get("/api/health");
    // "console" in production means password reset is dead and nothing else shows it.
    expect(body?.mailProvider !== "console", 'MAIL_PROVIDER is "console" — password reset is disabled');
    expect(body?.mailConfigured === true, `mailConfigured was ${body?.mailConfigured}`);
    return body.mailProvider;
  });

  await check("auth: rejects bad credentials with 401, not 500", async () => {
    const { status } = await get("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "smoke-test@example.invalid", password: "not-a-real-password" }),
    });
    // The outage showed up as 500 on every route. A 401 proves the app booted,
    // parsed the body, reached the database and ran bcrypt.
    expect(status === 401, `expected 401, got ${status}`);
    return "401";
  });

  await check("auth: protected routes require a session", async () => {
    const { status } = await get("/api/resumes");
    expect(status === 401, `expected 401, got ${status}`);
    return "401";
  });

  await check("reset: token probe answers", async () => {
    const { status, body } = await get("/api/auth/reset-password/validate?token=smoke-test-not-a-token");
    expect(status === 200, `expected 200, got ${status}`);
    expect(body?.valid === false, `valid was ${body?.valid}`);
    return "valid:false";
  });

  await check("docs: not public", async () => {
    // 404 when no credentials are configured, 401 when they are. Never 200.
    const { status } = await get("/api/openapi.json");
    expect(status === 404 || status === 401, `expected 404 or 401, got ${status}`);
    return String(status);
  });

  await check("root: does not advertise the docs", async () => {
    const { status, text } = await get("/");
    expect(status === 200, `expected 200, got ${status}`);
    expect(!text.includes("/api/docs"), "the service root links to the guarded docs");
    return "clean";
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${BASE_URL}`);
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? ` — ${r.note}` : ""}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);

  if (failed.length) process.exit(1);
}

run().catch((err) => {
  console.error(`\nsmoke test could not run: ${err.message}`);
  process.exit(1);
});
