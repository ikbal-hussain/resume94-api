import { OAuth2Client } from "google-auth-library";

/**
 * Verifies the ID token Google's sign-in button hands to the browser.
 *
 * The library is doing security-critical work that is not worth hand-rolling: it
 * fetches and caches Google's signing keys, checks the signature against the right
 * one, and rejects a token whose issuer, audience or expiry is wrong. A hand-written
 * decode that skipped any of those would accept a token anyone could mint.
 *
 * Behind a tiny interface so tests can supply their own verifier, the way the AI
 * provider and the PDF extractor already are. The suite then needs no network and no
 * credential, which is also what lets this ship before a client ID exists.
 */
export function createGoogleService(config) {
  const clientId = config.GOOGLE_CLIENT_ID;
  // One client, reused: it holds the key cache, and a fresh one per request would
  // fetch Google's certificates every time.
  const client = clientId ? new OAuth2Client(clientId) : null;

  return {
    /** False when no client ID is set. The route 503s rather than pretending to work. */
    configured: Boolean(clientId),

    /**
     * Resolves to { sub, email, emailVerified, name, picture }, or throws.
     *
     * `aud` is checked against our own client ID by the library. Without that check a
     * token minted for any other Google app would be accepted here, which is the
     * classic way this integration is got wrong.
     */
    async verify(credential) {
      const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
      const payload = ticket.getPayload();
      return {
        sub: payload.sub,
        email: payload.email,
        // Google sends this as a boolean, but has historically sent the string "true"
        // through some paths. Anything else is treated as unverified — this flag is the
        // whole defence against claiming somebody else's address.
        emailVerified: payload.email_verified === true || payload.email_verified === "true",
        name: payload.name,
        picture: payload.picture,
      };
    },
  };
}
