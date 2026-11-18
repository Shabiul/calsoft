import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "MeetFlow-Signature";
export const TIMESTAMP_HEADER = "MeetFlow-Timestamp";
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** hex HMAC-SHA256 over `${timestamp}.${body}` (Stripe-style, replay resistant). */
export function computeSignature(secret: string, timestamp: number | string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signPayload(secret: string, body: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  const sig = computeSignature(secret, nowSeconds, body);
  return {
    timestamp: nowSeconds,
    signature: `t=${nowSeconds},v1=${sig}`,
    headers: { [SIGNATURE_HEADER]: `t=${nowSeconds},v1=${sig}`, [TIMESTAMP_HEADER]: String(nowSeconds) },
  };
}

/** Receiver-side verification helper (also documents the scheme for customers). */
export function verifySignature(
  secret: string, body: string, header: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): boolean {
  const tol = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const parts = Object.fromEntries(header.split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(now - t) > tol) return false;
  const expected = Buffer.from(computeSignature(secret, t, body), "hex");
  let given: Buffer;
  try { given = Buffer.from(parts.v1, "hex"); } catch { return false; }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
