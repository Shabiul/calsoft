/**
 * Real-DB test of the sign-in rules:
 *  - Google sign-in is open to any Google account; Zoho sign-in is company-only (ALLOWED_EMAIL_DOMAINS, checked in zoho-profile.test.ts).
 *  - Every sign-in re-checks the account: a Zoho-only account off the company domains is refused; Google accounts and superadmins are not.
 *  - Every sign-in is written to the durable sign-in log (provider + browser, no IP).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import { db, pool, schema } from "@/server/db";
import { auth } from "./auth";
import { emailMaySignInWithSupabase, ensureSuperadmin, superadminEmails } from "@/server/services/account-access";

const run = randomUUID().slice(0, 8);
const ids: string[] = [];
const hooks = auth.options.databaseHooks!;
const createUser = (email: string) => hooks.user!.create!.before!({ id: `g_${run}`, email, name: "N", emailVerified: true, createdAt: new Date(), updatedAt: new Date() } as never);
const startSession = (userId: string) => hooks.session!.create!.before!({ userId } as never);
async function mk(n: string, domain: string, opts: { platformRole?: "user" | "superadmin"; status?: string; google?: boolean } = {}) {
  const id = `g_${run}_${n}`;
  await db.insert(schema.users).values({ id, name: n, email: `${id}@${domain}`, platformRole: opts.platformRole ?? "user", status: opts.status ?? "active" });
  if (opts.google) await db.insert(schema.accounts).values({ id: `acc_${id}`, accountId: `gid_${id}`, providerId: "google", userId: id });
  ids.push(id);
  return id;
}

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, ids));
  await pool.end();
});

describe("sign-in rules", () => {
  it("creating an account has no domain rule (Google is open; Zoho is gated before any account exists)", async () => {
    await expect(createUser(`jane-${run}@example.test`)).resolves.toBeTruthy();
    await expect(createUser(`someone-${run}@gmail.com`)).resolves.toBeTruthy();
  });
  it("a company-domain account can sign in", async () => {
    await expect(startSession(await mk("in", "example.test"))).resolves.not.toThrow();
  });
  it("a Zoho-only account outside the company domains is refused on every sign-in", async () => {
    await expect(startSession(await mk("out", "outsider.test"))).rejects.toMatchObject({ status: "FORBIDDEN" });
  });
  it("a Google account is allowed whatever its email domain", async () => {
    await expect(startSession(await mk("goog", "gmail.test", { google: true }))).resolves.not.toThrow();
  });
  it("superadmins are exempt so a domain change cannot lock the operator out", async () => {
    await expect(startSession(await mk("root", "outsider.test", { platformRole: "superadmin" }))).resolves.not.toThrow();
  });
  it("suspended accounts never sign in, even with Google", async () => {
    await expect(startSession(await mk("sus", "example.test", { status: "suspended", google: true }))).rejects.toMatchObject({ status: "FORBIDDEN" });
  });
  it("has no password sign-in or sign-up", () => {
    expect(auth.options.emailAndPassword?.enabled).toBe(false);
  });
  it("offers Google sign-in whenever its credentials are configured", () => {
    const configured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    expect(Boolean((auth.options.socialProviders as { google?: unknown } | undefined)?.google)).toBe(configured);
  });
});

describe("sign-in log", () => {
  const record = (userId: string, context: unknown, userAgent: string | null) => hooks.session!.create!.after!({ userId, userAgent } as never, context as never);

  it("records the method (from the OAuth callback) and a readable browser, never an IP", async () => {
    const id = await mk("log1", "example.test", { google: true });
    await record(id, { params: { id: "google" } }, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36");
    await record(id, { params: { providerId: "zoho" } }, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15");
    const rows = await db.select().from(schema.signInLogs).where(eq(schema.signInLogs.userId, id)).orderBy(desc(schema.signInLogs.createdAt));
    expect(rows.map((r) => [r.provider, r.device]).sort()).toEqual([["google", "Chrome on Windows"], ["zoho", "Safari on macOS"]]);
    expect(Object.keys(rows[0]!)).not.toContain("ip");
  });
  it("never breaks a sign-in if logging fails (unknown user)", async () => {
    await expect(record(`missing_${run}`, null, null)).resolves.not.toThrow();
  });
});

describe("superadmin and Supabase sign-in rules", () => {
  it("parses the SUPERADMIN_EMAILS list", () => {
    expect(superadminEmails(" Boss@Gmail.com, ,other@x.test ")).toEqual(["boss@gmail.com", "other@x.test"]);
    expect(superadminEmails("")).toEqual([]);
  });
  it("promotes a listed email to superadmin once, and nobody else", async () => {
    const id = await mk("sa", "gmail.test");
    const email = `${id}@gmail.test`;
    const prev = process.env.SUPERADMIN_EMAILS;
    process.env.SUPERADMIN_EMAILS = `someone-else@x.test, ${email.toUpperCase()}`;
    try {
      expect(await ensureSuperadmin(id, email, "user")).toBe("superadmin");
      const [u] = await db.select({ r: schema.users.platformRole }).from(schema.users).where(eq(schema.users.id, id));
      expect(u!.r).toBe("superadmin");
      const other = await mk("nosa", "gmail.test");
      expect(await ensureSuperadmin(other, `${other}@gmail.test`, "user")).toBe("user");
    } finally { if (prev === undefined) delete process.env.SUPERADMIN_EMAILS; else process.env.SUPERADMIN_EMAILS = prev; }
  });
  it("Supabase sign-in is for company emails and superadmins only", async () => {
    expect(await emailMaySignInWithSupabase(`a-${run}@example.test`)).toBe(true);
    expect(await emailMaySignInWithSupabase(`A-${run}@EXAMPLE.TEST`)).toBe(true);
    expect(await emailMaySignInWithSupabase(`a-${run}@gmail.com`)).toBe(false);
    const id = await mk("sbsa", "gmail.test", { platformRole: "superadmin" });
    expect(await emailMaySignInWithSupabase(`${id}@gmail.test`)).toBe(true);
  });
  it("sign-in log entries default to the sign_in event", async () => {
    const id = await mk("ev", "example.test");
    await db.insert(schema.signInLogs).values({ userId: id, provider: "google" });
    await db.insert(schema.signInLogs).values({ userId: id, event: "sign_out" });
    const rows = await db.select({ e: schema.signInLogs.event }).from(schema.signInLogs).where(eq(schema.signInLogs.userId, id));
    expect(rows.map((r) => r.e).sort()).toEqual(["sign_in", "sign_out"]);
  });
});
