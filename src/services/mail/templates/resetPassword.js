// Names come from user input and land inside markup, so they are escaped here.
const escapeHtml = (s = "") =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Builds the reset message. A plain-text alternative is always included: text-only
 * clients need it, and mail sent without one is markedly more likely to be filtered.
 * Styles are inline because email clients strip <style> blocks.
 */
export function resetPasswordEmail({ to, name, link, ttlMinutes }) {
  const greeting = name ? `Hi ${name},` : "Hi,";
  const expiry = ttlMinutes === 60 ? "1 hour" : `${ttlMinutes} minutes`;

  const text = [
    greeting,
    "",
    "Someone asked to reset the password for your Resume94 account.",
    "Open this link to choose a new one:",
    "",
    link,
    "",
    `The link works once and expires in ${expiry}.`,
    "If this wasn't you, ignore this email — your password stays as it is.",
    "",
    "— Resume94",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
    <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
      <tr><td>
        <h1 style="margin:0 0 16px;font-size:20px;font-weight:600">Reset your password</h1>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.55">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#3f3f46">
          Someone asked to reset the password for your Resume94 account. Choose a new one here:
        </p>
        <p style="margin:0 0 24px">
          <a href="${link}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;font-weight:500">Choose a new password</a>
        </p>
        <p style="margin:0 0 20px;font-size:13px;line-height:1.55;color:#52525b">
          The link works once and expires in ${escapeHtml(expiry)}. If the button doesn't work, paste this into your browser:<br>
          <span style="color:#2563eb;word-break:break-all">${link}</span>
        </p>
        <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0">
        <p style="margin:0;font-size:13px;line-height:1.55;color:#71717a">
          If this wasn't you, ignore this email — your password stays as it is.
        </p>
      </td></tr>
    </table>
  </body>
</html>`;

  return { to, subject: "Reset your Resume94 password", text, html };
}
