import { HttpError } from "../../../middleware/errors.js";

// Groq — OpenAI-compatible chat completions, https://console.groq.com/docs/api-reference#chat-create
export const groq = {
  name: "groq",
  envKey: "GROQ_API_KEY",
  defaultModel: "llama-3.3-70b-versatile",

  async call(prompt, { apiKey, model }, fetchImpl) {
    let res;
    try {
      res = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.7 }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HttpError(504, "AI provider timed out", "AI_TIMEOUT");
    }
    if (!res.ok) throw new HttpError(502, "AI provider error", "AI_UPSTREAM");
    const json = await res.json();
    return json?.choices?.[0]?.message?.content?.trim();
  },
};
