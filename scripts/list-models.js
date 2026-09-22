// Lists the chat models a GROQ_API_KEY can actually access.
// Groq retires model ids periodically, so a 404 from the AI routes usually means
// the configured GROQ_MODEL is gone — run this to pick a current one.
const key = process.env.GROQ_API_KEY;
if (!key) throw new Error("GROQ_API_KEY is not set (run with --env-file=.env)");

const res = await fetch("https://api.groq.com/openai/v1/models", {
  headers: { Authorization: `Bearer ${key}` },
});
if (!res.ok) throw new Error(`Groq responded ${res.status}: ${await res.text()}`);

const { data = [] } = await res.json();
for (const m of data.map((m) => m.id).sort()) console.log(m);
