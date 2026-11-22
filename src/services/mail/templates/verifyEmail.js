// Names come from user input and land inside markup, so they are escaped here.
const escapeHtml = (s = "") =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Builds the address-verification message. Same structure as the reset email: a
 * plain-text alternative always, inline styles because clients strip <style> blocks.
 */
export function verifyEmailEmail({ to, name, link, ttlHours }) {
  const greeting = name ? `Hi ${name},` : "Hi,";
  const expiry = ttlHours % 24 === 0 ? `${ttlHours / 24} day${ttlHours === 24 ? "" : "s"}` : `${ttlHours} hours`;

  const text = [
    greeting,
    "",
    "Confirm this is your email address to turn on Resume94's AI features",
    "(summaries, bullet rewrites and resume import):",
    "",
    link,
    "",
    `The link works once and expires in ${expiry}.`,
    "Everything else in Resume94 already works without it.",
    "If you didn't create a Resume94 account, ignore this email.",
    "",
    "— Resume94",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
    <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
      <tr><td>
        <h1 style="margin:0 0 16px;font-size:20px;font-weight:600">Confirm your email</h1>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.55">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#3f3f46">
          Confirm this is your email address to turn on Resume94's AI features: summaries, bullet rewrites and resume import.
        </p>
        <p style="margin:0 0 24px">
          <a href="${link}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;font-weight:500">Confirm my email</a>
        </p>
        <p style="margin:0 0 20px;font-size:13px;line-height:1.55;color:#52525b">
          The link works once and expires in ${escapeHtml(expiry)}. If the button doesn't work, paste this into your browser:<br>
          <span style="color:#2563eb;word-break:break-all">${link}</span>
        </p>
        <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0">
        <p style="margin:0;font-size:13px;line-height:1.55;color:#71717a">
          If you didn't create a Resume94 account, ignore this email.
        </p>
      </td></tr>
    </table>
  </body>
</html>`;

  return { to, subject: "Confirm your email for Resume94", text, html };
}
