/**
 * SSRF guard for outgoing webhooks. In production: https only, no private / loopback / link-local /
 * metadata addresses. Resolution is validated at connect time (see safeLookup) to defeat DNS rebinding.
 */
import { isIP } from "node:net";
import dns from "node:dns";

export class SsrfError extends Error {}

export function isProd(): boolean { return process.env.NODE_ENV === "production" || process.env.WEBHOOK_BLOCK_PRIVATE === "1"; }

function parseV4(ip: string): number[] | null {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}

/** True for any address that must never be reached from the server. */
export function isPrivateAddress(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(lower) === 6) {
    if (lower === "::" || lower === "::1") return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const a = parseInt(mappedHex[1], 16), b = parseInt(mappedHex[2], 16);
      return isPrivateAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
    }
    const first = parseInt(lower.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xffc0) === 0xfec0) return true; // site local (deprecated)
    if (lower.startsWith("64:ff9b:")) return true; // NAT64
    return false;
  }
  const p = parseV4(lower);
  if (!p) return true; // unparseable => refuse
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24, TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

const BLOCKED_HOSTS = /(^|\.)(localhost|local|internal|localdomain)$/i;

/** Static URL checks (no DNS). Throws SsrfError. */
export function assertUrlAllowed(raw: string, opts: { production?: boolean } = {}): URL {
  const prod = opts.production ?? isProd();
  let u: URL;
  try { u = new URL(raw); } catch { throw new SsrfError("Invalid URL"); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && !prod)) {
    throw new SsrfError(prod ? "Only https:// URLs are allowed" : "Only http(s) URLs are allowed");
  }
  if (u.username || u.password) throw new SsrfError("Credentials in URL are not allowed");
  if (prod) {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (BLOCKED_HOSTS.test(host)) throw new SsrfError("Host is not allowed");
    if (isIP(host) && isPrivateAddress(host)) throw new SsrfError("Private or reserved IP addresses are not allowed");
    // decimal/hex/octal obfuscated IPv4 (e.g. http://2130706433/) is normalised by WHATWG URL to dotted form, covered above.
  }
  return u;
}

/** dns.lookup replacement that rejects private results in production (use as http(s).request `lookup`). */
export function safeLookup(production = isProd()): typeof dns.lookup {
  const fn = ((hostname: string, options: unknown, cb: unknown) => {
    const callback = (typeof options === "function" ? options : cb) as (err: Error | null, address?: unknown, family?: number) => void;
    const opts = (typeof options === "function" ? {} : options) as dns.LookupOptions;
    dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
      if (err) return callback(err);
      const list = addrs as dns.LookupAddress[];
      if (production) {
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) return callback(new SsrfError(`Resolved to a disallowed address (${bad.address})`));
      }
      if (opts.all) return callback(null, list);
      const first = list[0];
      return callback(null, first.address, first.family);
    });
  }) as unknown as typeof dns.lookup;
  return fn;
}
