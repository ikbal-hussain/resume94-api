// Resend's REST API is a single POST, so this needs no SDK dependency.
// Without a verified domain, `from` must stay onboarding@resend.dev and Resend will
// only deliver to the address that owns the account — enough to test the flow.
export const resendProvider = {
  name: "resend",
  envKey: "RESEND_API_KEY",
  async send({ from, to, subject, html, text }, { apiKey }, fetchImpl = fetch) {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`resend responded ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
  },
};
