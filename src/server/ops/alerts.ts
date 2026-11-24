/**
 * Operational alerts. The worker runs `runOpsCheck` every few minutes: it looks for things that mean customers are not getting
 * their emails or reminders, and emails the operators (ALERT_EMAILS, else SUPERADMIN_EMAILS) at most once an hour while a problem lasts.
 */
import { sql } from "drizzle-orm";
import { db } from "@/server/db";
import { getEmailProvider } from "@/server/notifications/provider";
import { superadminEmails } from "@/server/services/account-access";
import { escapeHtml } from "@/server/notifications/escape";
import { APP_NAME } from "@/lib/brand";

export interface Finding { code: string; message: string; count: number }

const MIN = 60_000;
const num = (r: { rows: unknown[] }) => Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0);

/** Pure-ish: reads counts from the database, returns what is wrong right now (empty = healthy). */
export async function evaluateHealth(now = new Date()): Promise<Finding[]> {
  const t30 = new Date(now.getTime() - 30 * MIN).toISOString(), t15 = new Date(now.getTime() - 15 * MIN).toISOString(), nowIso = now.toISOString();
  const [dead, stuck, overdue, wfDead, hooksDead] = await Promise.all([
    db.execute(sql`select count(*)::int as n from notification_log where status = 'dead' and created_at >= ${t30}::timestamptz`),
    db.execute(sql`select count(*)::int as n from notification_log where status in ('queued','failed') and created_at < ${t15}::timestamptz and created_at >= ${new Date(now.getTime() - 24 * 60 * MIN).toISOString()}::timestamptz`),
    db.execute(sql`select count(*)::int as n from reminder r join booking b on b.id = r.booking_id
      where r.sent_at is null and r.send_at < ${t15}::timestamptz and b.status = 'confirmed' and b.starts_at > ${nowIso}::timestamptz`),
    db.execute(sql`select count(*)::int as n from workflow_execution where status = 'dead' and created_at >= ${t30}::timestamptz`),
    db.execute(sql`select count(*)::int as n from webhook_delivery where status = 'dead' and created_at >= ${t30}::timestamptz`),
  ]);
  const out: Finding[] = [];
  const add = (code: string, count: number, min: number, message: string) => { if (count >= min) out.push({ code, count, message }); };
  add("emails_dead", num(dead), 3, "Emails are failing permanently (gave up after retries) in the last 30 minutes.");
  add("emails_stuck", num(stuck), 1, "Emails have been waiting or retrying for over 15 minutes.");
  add("reminders_overdue", num(overdue), 1, "Reminders are more than 15 minutes late. The worker may be down or stuck.");
  add("workflows_dead", num(wfDead), 3, "Workflow steps are failing permanently in the last 30 minutes.");
  add("webhooks_dead", num(hooksDead), 5, "Webhook deliveries are failing permanently in the last 30 minutes.");
  return out;
}

export const alertRecipients = (): string[] => {
  const raw = (process.env.ALERT_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return raw.length ? raw : superadminEmails();
};

export async function sendOpsAlert(findings: Finding[]): Promise<number> {
  const to = alertRecipients();
  if (!to.length || !findings.length) return 0;
  const lines = findings.map((f) => `- ${f.message} (${f.count})`);
  const subject = `[${APP_NAME}] ${findings.length === 1 ? findings[0]!.message.split(".")[0] : `${findings.length} problems need attention`}`;
  const text = `${APP_NAME} noticed:\n\n${lines.join("\n")}\n\nCheck Admin > System health. You will get at most one of these per hour while it lasts.`;
  const html = `<p>${escapeHtml(APP_NAME)} noticed:</p><ul>${findings.map((f) => `<li>${escapeHtml(f.message)} (${f.count})</li>`).join("")}</ul><p>Check <em>Admin &gt; System health</em>. You get at most one of these per hour while it lasts.</p>`;
  for (const r of to) await getEmailProvider().send({ to: r, subject, text, html });
  return to.length;
}

/** `claim(key, ttlSeconds)` must return true only for the first caller within the TTL (Redis SET NX EX). Returns whether an alert went out. */
export async function runOpsCheck(claim: (key: string, ttlSeconds: number) => Promise<boolean>, now = new Date()): Promise<boolean> {
  const findings = await evaluateHealth(now);
  if (!findings.length) return false;
  console.error("[ops] problems:", findings.map((f) => `${f.code}=${f.count}`).join(" "));
  if (!(await claim("ops:alert:sent", 3600))) return false;
  try { return (await sendOpsAlert(findings)) > 0; } catch (err) { console.error("[ops] alert email failed:", (err as Error).message); return false; }
}
