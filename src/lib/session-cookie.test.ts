/** Proves the e2e test sign-in cookie (tests/e2e/session-cookie.ts) is accepted by better-auth, and a forged one is not. */
import { afterAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "@/server/db";
import { auth } from "./auth";
import { SESSION_COOKIE, signSessionToken } from "../../tests/e2e/session-cookie";

const id = `sc_${randomUUID().slice(0, 8)}`;
afterAll(async () => { await db.delete(schema.users).where(eq(schema.users.id, id)); await pool.end(); });

describe("e2e session cookie", () => {
  it("signs a session cookie better-auth accepts", async () => {
    const secret = process.env.BETTER_AUTH_SECRET!;
    expect(secret).toBeTruthy();
    await db.insert(schema.users).values({ id, name: "Cookie", email: `${id}@example.test`, emailVerified: true });
    const token = randomBytes(24).toString("base64url");
    await db.insert(schema.sessions).values({ id: randomUUID(), token, userId: id, expiresAt: new Date(Date.now() + 3600_000) });
    const get = (value: string) => auth.api.getSession({ headers: new Headers({ cookie: `${SESSION_COOKIE}=${value}` }) });
    expect((await get(signSessionToken(token, secret)))?.user.id).toBe(id);
    expect(await get(signSessionToken(token, "wrong-secret-wrong-secret-wrong!!"))).toBeNull();
  });
});
