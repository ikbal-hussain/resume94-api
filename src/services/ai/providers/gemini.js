import { HttpError, upstreamFailure } from "../../../middleware/errors.js";

// Google Gemini — https://ai.google.dev/api/generate-content
export const gemini = {
  name: "gemini",
  envKey: "GEMINI_API_KEY",
  defaultModel: "gemini-2.5-flash",

  async call(prompt, { apiKey, model, json = false, temperature, timeoutMs = 15_000 }, fetchImpl) {
    let res;
    try {
      res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        // Key in a header (not the URL) so it never lands in access logs.
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            ...(json ? { responseMimeType: "application/json" } : {}),
            ...(temperature === undefined ? {} : { temperature }),
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new HttpError(504, "AI provider timed out", "AI_TIMEOUT");
    }
    if (!res.ok) throw await upstreamFailure("gemini", model, res);
    const payload = await res.json();
    return payload?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  },
};
