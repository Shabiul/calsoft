import http from "node:http";
import https from "node:https";
import { assertUrlAllowed, safeLookup } from "./ssrf";

export interface PostResult { status: number; body: string }

/**
 * POST JSON with SSRF protections: URL validated, DNS results validated at connect time,
 * redirects are NOT followed, response body capped, hard timeout.
 */
export function postJson(
  rawUrl: string, body: string, headers: Record<string, string>,
  opts: { timeoutMs?: number; production?: boolean } = {},
): Promise<PostResult> {
  const url = assertUrlAllowed(rawUrl, { production: opts.production });
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "user-agent": "MeetFlow-Webhooks/1.0", ...headers },
      lookup: safeLookup(opts.production) as never,
      timeout: opts.timeoutMs ?? 10_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size <= 4096) chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}
