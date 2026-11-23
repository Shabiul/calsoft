/** Real-DB test of the sign-in gate: only company-domain accounts get created or signed in (superadmins exempt). */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, pool, schema } from "@/server/db";
import { auth } from "./auth";

const run = randomUUID().slice(0, 8);
const ids: string[] = [];
const hooks = auth.options.databaseHooks!;
const createUser = (email: string) => hooks.user!.create!.before!({ id: `g_${run}`, email, name: "N", emailVerified: true, createdAt: new Date(), updatedAt: new Date() } as never);
const startSession = (userId: string) => hooks.session!.create!.before!({ userId } as never);
async function mk(n: string, domain: string, platformRole: "user" | "superadmin" = "user") {
  const id = `g_${run}_${n}`;
  await db.insert(schema.users).values({ id, name: n, email: `${id}@${domain}`, platformRole });
  ids.push(id);
  return id;
}

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, ids));
  await pool.end();
});

describe("company sign-in gate", () => {
  it("never creates an account outside the company domains", async () => {
    await expect(createUser(`x-${run}@outsider.test`)).rejects.toMatchObject({ status: "FORBIDDEN" });
    await expect(createUser(`x-${run}@evil-example.test`)).rejects.toMatchObject({ status: "FORBIDDEN" });
    await expect(createUser(`jane-${run}@example.test`)).resolves.toBeTruthy();
  });
  it("refuses sign-in for existing accounts outside the domains, except superadmins", async () => {
    await expect(startSession(await mk("in", "example.test"))).resolves.not.toThrow();
    await expect(startSession(await mk("out", "outsider.test"))).rejects.toMatchObject({ status: "FORBIDDEN" });
    await expect(startSession(await mk("root", "outsider.test", "superadmin"))).resolves.not.toThrow();
  });
  it("has no password sign-in or sign-up", () => {
    expect(auth.options.emailAndPassword?.enabled).toBe(false);
  });
});
