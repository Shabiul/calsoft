/**
 * Optional pinned CA for a self-hosted Redis served over TLS with a self-signed certificate.
 * REDIS_TLS_CA is the PEM certificate, base64-encoded (single line). Unset => default ioredis behaviour (e.g. Upstash).
 */
export function redisTls(): { tls: { ca: string } } | Record<string, never> {
  const b64 = process.env.REDIS_TLS_CA;
  return b64 ? { tls: { ca: Buffer.from(b64, "base64").toString("utf8") } } : {};
}
