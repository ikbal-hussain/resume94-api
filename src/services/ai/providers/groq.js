import { HttpError, upstreamFailure } from "../../../middleware/errors.js";

// Groq — OpenAI-compatible chat completions, https://console.groq.com/docs/api-reference#chat-create
// Model ids change as Groq retires them; `npm run models:groq` lists what a key can access.
export const groq = {
  name: "groq",
  envKey: "GROQ_API_KEY",
  defaultModel: "openai/gpt-oss-120b",

  async call(prompt, { apiKey, model, json = false, temperature = 0.7, timeoutMs = 15_000 }, fetchImpl) {
    let res;
    try {
      res = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature,
          // Constrained decoding, so the reply is a JSON object rather than one wrapped
          // in prose or a ``` fence. The caller still parses defensively.
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new HttpError(504, "AI provider timed out", "AI_TIMEOUT");
    }
    if (!res.ok) throw await upstreamFailure("groq", model, res);
    // A 200 carrying something other than JSON -- a proxy's HTML error page, a truncated
    // body -- would otherwise throw past the error handling and surface as a generic 500,
    // which says nothing about where the failure actually was.
    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new HttpError(502, "The groq response could not be read", "AI_UPSTREAM");
    }
    return payload?.choices?.[0]?.message?.content?.trim();
  },
};
