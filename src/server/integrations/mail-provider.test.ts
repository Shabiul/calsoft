import { describe, expect, it, vi } from "vitest";
import { detectMailProvider } from "./mail-provider";

let n = 0;
const uniq = (mx: string[] | Error) => {
  const domain = `d${++n}-${Math.random().toString(36).slice(2)}.example`;
  const resolveMx = vi.fn(async () => {
    if (mx instanceof Error) throw mx;
    return mx;
  });
  return { email: `Bob@${domain}`, domain, resolveMx };
};

describe("detectMailProvider", () => {
  it("static personal providers need no resolver", async () => {
    const resolveMx = vi.fn(async () => []);
    const g = await detectMailProvider("a@gmail.com", { resolveMx });
    expect(g).toMatchObject({ kind: "personal", provider: "google", label: "Gmail", recommended: ["google"] });
    const o = await detectMailProvider("a@hotmail.co.uk", { resolveMx });
    expect(o).toMatchObject({ kind: "personal", provider: "microsoft", recommended: ["microsoft"] });
    const o2 = await detectMailProvider("a@outlook.com", { resolveMx });
    expect(o2.label).toBe("Outlook.com");
    const z = await detectMailProvider("a@zohomail.in", { resolveMx });
    expect(z).toMatchObject({ kind: "personal", provider: "zoho", recommended: ["zoho"] });
    const y = await detectMailProvider("a@yahoo.com", { resolveMx });
    expect(y).toMatchObject({ kind: "personal", provider: "other", recommended: [] });
    expect(resolveMx).not.toHaveBeenCalled();
  });

  it("Google Workspace business domain", async () => {
    const t = uniq(["aspmx.l.google.com", "alt1.aspmx.l.google.com"]);
    const r = await detectMailProvider(t.email, { resolveMx: t.resolveMx });
    expect(r).toMatchObject({ kind: "business", provider: "google", label: "Google Workspace", recommended: ["google"], domain: t.domain });
    expect(r.email).toBe(t.email.toLowerCase());
  });

  it("Microsoft 365 business domain", async () => {
    const t = uniq(["acme-com.mail.protection.outlook.com."]);
    const r = await detectMailProvider(t.email, { resolveMx: t.resolveMx });
    expect(r).toMatchObject({ kind: "business", provider: "microsoft", label: "Microsoft 365", recommended: ["microsoft"] });
  });

  it("Zoho business domains incl. regional", async () => {
    for (const host of ["mx.zoho.com", "mx2.zoho.in", "mx3.zoho.eu", "mx.zoho.com.au", "mx.zoho.jp"]) {
      const t = uniq([host]);
      const r = await detectMailProvider(t.email, { resolveMx: t.resolveMx });
      expect(r).toMatchObject({ kind: "business", provider: "zoho", label: "Zoho Mail", recommended: ["zoho"] });
    }
  });

  it("gateways are other", async () => {
    const t = uniq(["acme.mimecast.com", "mx1.pphosted.com"]);
    const r = await detectMailProvider(t.email, { resolveMx: t.resolveMx });
    expect(r).toMatchObject({ kind: "business", provider: "other", recommended: [] });
  });

  it("no MX records is other", async () => {
    const t = uniq([]);
    const r = await detectMailProvider(t.email, { resolveMx: t.resolveMx });
    expect(r).toMatchObject({ provider: "other", recommended: [] });
  });

  it("lookup error is unknown and never throws", async () => {
    const t = uniq(new Error("boom"));
    const r = await detectMailProvider(t.email, { resolveMx: t.resolveMx });
    expect(r).toMatchObject({ kind: "unknown", provider: "unknown", recommended: [] });
  });

  it("timeout yields unknown", async () => {
    vi.useFakeTimers();
    try {
      const domain = `slow-${Math.random().toString(36).slice(2)}.example`;
      const p = detectMailProvider(`a@${domain}`, { resolveMx: () => new Promise<string[]>(() => {}) });
      await vi.advanceTimersByTimeAsync(2600);
      const r = await p;
      expect(r.provider).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalid emails", async () => {
    for (const bad of ["", "nope", "a@", "@b.com", "a@b", "a b@c.com"]) {
      const r = await detectMailProvider(bad);
      expect(r).toMatchObject({ kind: "unknown", provider: "unknown", recommended: [] });
    }
  });

  it("uppercase and whitespace input", async () => {
    const r = await detectMailProvider("  Someone@GMAIL.COM ");
    expect(r.email).toBe("someone@gmail.com");
    expect(r.provider).toBe("google");
  });

  it("caches per domain", async () => {
    const t = uniq(["aspmx.l.google.com"]);
    await detectMailProvider(t.email, { resolveMx: t.resolveMx });
    await detectMailProvider(`other@${t.domain}`, { resolveMx: t.resolveMx });
    expect(t.resolveMx).toHaveBeenCalledTimes(1);
  });
});
