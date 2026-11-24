import nodemailer from "nodemailer";
import { Resend } from "resend";

export interface EmailMessage {
  to: string; subject: string; html: string; text: string;
  attachments?: { filename: string; content: string; contentType: string; /** "base64" for binary files; text (e.g. .ics) otherwise */ encoding?: "base64" }[];
}
export interface EmailProvider { name: string; send(msg: EmailMessage): Promise<{ id?: string }> }

const from = () => process.env.EMAIL_FROM ?? "MeetFlow <no-reply@example.com>";

/** Dev provider: logs and keeps the last messages in memory (inspectable in tests). */
export const devOutbox: EmailMessage[] = [];
export const devLogProvider: EmailProvider = {
  name: "dev-log",
  async send(msg) {
    devOutbox.push(msg); if (devOutbox.length > 100) devOutbox.shift();
    if (process.env.NODE_ENV !== "test") console.log(`[email:dev-log] to=${msg.to} subject=${JSON.stringify(msg.subject)} attachments=${msg.attachments?.length ?? 0}`);
    return { id: `dev-${Date.now()}` };
  },
};

function resendProvider(key: string): EmailProvider {
  const client = new Resend(key);
  return {
    name: "resend",
    async send(m) {
      const { data, error } = await client.emails.send({
        from: from(), to: m.to, subject: m.subject, html: m.html, text: m.text,
        attachments: m.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content, a.encoding ?? "utf8"), contentType: a.contentType })),
      });
      if (error) throw new Error(`Resend: ${error.message}`);
      return { id: data?.id };
    },
  };
}
function smtpProvider(url: string): EmailProvider {
  const t = nodemailer.createTransport(url);
  return {
    name: "smtp",
    async send(m) {
      const r = await t.sendMail({
        from: from(), to: m.to, subject: m.subject, html: m.html, text: m.text,
        attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, encoding: a.encoding })),
      });
      return { id: r.messageId };
    },
  };
}

let cached: EmailProvider | null = null;
let override: EmailProvider | null = null;
export function setEmailProviderForTests(p: EmailProvider | null) { override = p; }
export function getEmailProvider(): EmailProvider {
  if (override) return override;
  if (cached) return cached;
  const pref = process.env.EMAIL_PROVIDER;
  if ((pref === "resend" || !pref) && process.env.RESEND_API_KEY) cached = resendProvider(process.env.RESEND_API_KEY);
  else if ((pref === "smtp" || !pref) && process.env.SMTP_URL) cached = smtpProvider(process.env.SMTP_URL);
  else cached = devLogProvider;
  return cached;
}
