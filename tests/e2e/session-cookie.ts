/**
 * Test-only sign-in. Real sign-in is Zoho only, which a browser test cannot drive, so e2e tests create a session row and set
 * better-auth's signed session cookie: value = encodeURIComponent(`${token}.${base64(HMAC-SHA256(token, BETTER_AUTH_SECRET))}`).
 * Lives in the test tree only; the app itself has no password or test login. Verified against auth.api.getSession in
 * src/lib/session-cookie.test.ts. On https origins the cookie name gets the "__Secure-" prefix.
 */
import { createHmac } from "node:crypto";

export const SESSION_COOKIE = "better-auth.session_token";
export const signSessionToken = (token: string, secret: string) =>
  encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`);
