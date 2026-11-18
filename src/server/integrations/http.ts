export type ProviderErrorKind = "auth" | "not_found" | "gone" | "conflict" | "rate_limit" | "transient" | "other";

export class ProviderError extends Error {
  constructor(message: string, public kind: ProviderErrorKind, public status = 0, public body?: unknown) {
    super(message);
    this.name = "ProviderError";
  }
  get retryable() { return this.kind === "transient" || this.kind === "rate_limit"; }
}

function classify(status: number, body: unknown): ProviderErrorKind {
  const text = JSON.stringify(body ?? "").toLowerCase();
  if (status === 401) return "auth";
  if (status === 403) {
    if (/ratelimit|userratelimit|quota/.test(text)) return "rate_limit";
    if (/insufficient|scope|forbidden|accessdenied|authorization/.test(text)) return "auth";
    return "other";
  }
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 410) return "gone";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "transient";
  return "other";
}

export interface HttpOpts {
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
}

/** Thin fetch wrapper (uses global fetch so tests can mock it). */
export async function http<T = unknown>(url: string, opts: HttpOpts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.json); }
  if (opts.form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(opts.form).toString(); }
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? (body ? "POST" : "GET"), headers, body });
  } catch (e) {
    throw new ProviderError(`Network error: ${(e as Error).message}`, "transient");
  }
  const raw = await res.text();
  let parsed: unknown = undefined;
  if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = raw; } }
  if (res.ok) return parsed as T;
  const msg = parsed as { error?: { message?: string } | string; error_description?: string; message?: string } | undefined;
  const detail = typeof msg?.error === "object" ? msg.error?.message : (msg?.error_description ?? (typeof msg?.error === "string" ? msg.error : msg?.message));
  throw new ProviderError(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`, classify(res.status, parsed), res.status, parsed);
}
