// Names come from user input and land inside markup, so they are escaped here.
const escapeHtml = (s = "") =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Sent when someone asks to reset the password on an account that has no password
 * because it was created through Google.
 *
 * Why a mail rather than a message on the page: the forgot-password endpoint answers
 * identically whether or not an address is registered, deliberately, so that it cannot
 * be used to discover who has an account here. Saying "this one signs in with Google"
 * in the HTTP response would undo exactly that. The inbox is the one place the answer
 * can go where only the address owner reads it.
 */
export function googleAccountEmail({ to, name, signInUrl }) {
  const greeting = name ? `Hi ${name},` : "Hi,";

  const text = [
    greeting,
    "",
    "Someone asked to reset the password for your Resume94 account.",
    "",
    "This account doesn't have a password — it signs in with Google. Use the",
    "'Continue with Google' button instead:",
    "",
    signInUrl,
    "",
    "If this wasn't you, you can ignore this email. Nothing has changed.",
    "",
    "— Resume94",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
    <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
      <tr><td>
        <h1 style="margin:0 0 16px;font-size:20px;font-weight:600">This account signs in with Google</h1>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.55">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#3f3f46">
          Someone asked to reset the password for your Resume94 account. There's no password to
          reset — this account was created with Google, so use the Google button to sign in.
        </p>
        <p style="margin:0 0 24px">
          <a href="${signInUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;font-weight:500">Sign in with Google</a>
        </p>
        <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0">
        <p style="margin:0;font-size:13px;line-height:1.55;color:#71717a">
          If this wasn't you, ignore this email. Nothing has changed.
        </p>
      </td></tr>
    </table>
  </body>
</html>`;

  return { to, subject: "Signing in to Resume94", text, html };
}
