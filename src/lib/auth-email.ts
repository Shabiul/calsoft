import { APP_NAME } from "./brand";

export interface AuthEmail { to: string; subject: string; html: string; text: string }

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY || process.env.SMTP_URL);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function authEmailTemplate(opts: { heading: string; body: string; cta: string; url: string }): Pick<AuthEmail, "html" | "text"> {
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:32px;max-width:480px">
<tr><td style="font-size:18px;font-weight:700;color:#4f46e5">${esc(APP_NAME)}</td></tr>
<tr><td style="padding-top:16px;font-size:20px;font-weight:600;color:#0f1115">${esc(opts.heading)}</td></tr>
<tr><td style="padding-top:8px;font-size:14px;line-height:22px;color:#4b5563">${esc(opts.body)}</td></tr>
<tr><td style="padding:24px 0"><a href="${esc(opts.url)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">${esc(opts.cta)}</a></td></tr>
<tr><td style="font-size:12px;color:#9ca3af;word-break:break-all">If the button does not work, paste this link into your browser:<br>${esc(opts.url)}</td></tr>
</table></td></tr></table></body></html>`;
  return { html, text: `${opts.heading}\n\n${opts.body}\n\n${opts.cta}: ${opts.url}\n` };
}

/**
 * Sends a transactional auth email via Resend (RESEND_API_KEY) or SMTP (SMTP_URL).
 * With neither configured: logs the message to the server console in development only; throws in production.
 */
export async function sendAuthEmail(mail: AuthEmail): Promise<void> {
  const from = process.env.EMAIL_FROM || `${APP_NAME} <no-reply@localhost>`;
  if (process.env.RESEND_API_KEY) {
    const { Resend } = await import("resend");
    const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({ from, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text });
    if (error) throw new Error(`Resend error: ${error.message}`);
    return;
  }
  if (process.env.SMTP_URL) {
    const nodemailer = await import("nodemailer");
    await nodemailer.createTransport(process.env.SMTP_URL).sendMail({ from, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text });
    return;
  }
  if (process.env.NODE_ENV === "production") throw new Error("No email provider configured (set RESEND_API_KEY or SMTP_URL)");
  console.log(`\n[auth-email:dev] To: ${mail.to}\nSubject: ${mail.subject}\n${mail.text}\n`);
}
