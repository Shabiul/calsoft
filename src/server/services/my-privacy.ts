import { and, desc, eq } from "drizzle-orm";
import { db as defaultDb, schema, type Db } from "@/server/db";
import { getEmailProvider } from "@/server/notifications/provider";
import { escapeHtml } from "@/server/notifications/escape";
import { APP_NAME } from "@/lib/brand";

const { auditLogs, users, organizations, signInLogs } = schema;

export interface ProfileView { id: string; at: Date; viewerName: string; viewerRole: string | null; orgName: string | null }

/** Who has opened my team-activity page (managers, team leads, admins), newest first. People can see who looked at their data. */
export async function listWhoViewedMe(userId: string, limit = 50, db: Db = defaultDb): Promise<ProfileView[]> {
  const rows = await db.select({ id: auditLogs.id, at: auditLogs.createdAt, name: users.name, meta: auditLogs.meta, org: organizations.name })
    .from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorId)).leftJoin(organizations, eq(organizations.id, auditLogs.organizationId))
    .where(and(eq(auditLogs.action, "oversight.member_viewed"), eq(auditLogs.entityId, userId)))
    .orderBy(desc(auditLogs.createdAt)).limit(limit);
  return rows.map((r) => ({ id: r.id, at: r.at, viewerName: r.name ?? "Someone", viewerRole: (r.meta as { role?: string } | null)?.role ?? null, orgName: r.org }));
}

/**
 * Emails the account owner when it signs in from a browser it has not used before (only after at least one earlier sign-in, so first
 * sign-ups are quiet). Never throws: an alert must not block a sign-in. Returns whether an alert was sent.
 */
export async function alertOnNewBrowser(userId: string, device: string | null, provider: string, db: Db = defaultDb): Promise<boolean> {
  try {
    if (!device || device === "Unknown device") return false;
    const prior = await db.select({ device: signInLogs.device }).from(signInLogs).where(and(eq(signInLogs.userId, userId), eq(signInLogs.event, "sign_in"))).limit(200);
    if (prior.length === 0 || prior.some((p) => p.device === device)) return false;
    const [u] = await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u) return false;
    const when = new Date().toUTCString();
    await getEmailProvider().send({
      to: u.email, subject: `New sign-in to ${APP_NAME} from ${device}`,
      text: `Hi ${u.name},\n\nYour ${APP_NAME} account was just signed in to from a new browser: ${device} (${provider}) at ${when}.\n\nIf this was you, no action is needed. If not, open Settings > Security and sign out of other devices.`,
      html: `<p>Hi ${escapeHtml(u.name)},</p><p>Your ${escapeHtml(APP_NAME)} account was just signed in to from a new browser: <strong>${escapeHtml(device)}</strong> (${escapeHtml(provider)}) at ${escapeHtml(when)}.</p><p>If this was you, no action is needed. If not, open <em>Settings &gt; Security</em> and sign out of other devices.</p>`,
    });
    return true;
  } catch (err) {
    console.error("[auth] new-browser alert failed:", (err as Error).message);
    return false;
  }
}
