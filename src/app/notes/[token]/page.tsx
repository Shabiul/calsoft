import { Suspense } from "react";
import { DateTime } from "luxon";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getNotes, hostNotesBooking } from "@/server/notetaker";
import { getSession } from "@/lib/auth-session";
import { loadBookingContext } from "@/server/notifications/context";
import { formatRange } from "@/server/notifications/templates";
import { PublicShell } from "@/components/booking/PublicShell";
import { PageFrame, FlowSkeleton } from "@/components/booking/PublicChrome";
import { NotesEditor } from "@/components/booking/NotesEditor";
import { RecordingPanel } from "@/components/booking/RecordingPanel";
import { audioNotesConfigured } from "@/server/notetaker/audio";
import { APP_NAME } from "@/lib/brand";

type P = { params: Promise<{ token: string }> };

// Host-only (signed in as the booking's host, see hostNotesBooking): never index, never leak the token via referrer.
export const metadata: Metadata = {
  title: `Meeting notes | ${APP_NAME}`,
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function NotesPage({ params }: P) {
  return (
    <Suspense fallback={<PublicShell><PageFrame><FlowSkeleton /></PageFrame></PublicShell>}>
      <Notes params={params} />
    </Suspense>
  );
}

async function Notes({ params }: P) {
  const { token } = await params;
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/notes/${token}`)}`);
  // Non-hosts (invitees, other users) get a plain 404: the page does not reveal that notes exist.
  const bookingId = await hostNotesBooking(token, session.user.id);
  const ctx = bookingId ? await loadBookingContext(bookingId) : null;
  if (!bookingId || !ctx) notFound();
  const n = await getNotes(bookingId);
  const people = ctx.attendees?.length ? ctx.attendees : [ctx.invitee];
  return (
    <PublicShell brandColor={ctx.branding?.brandColor}>
      <PageFrame>
        <div className="mf-card" style={{ padding: 24, display: "grid", gap: 20 }}>
          <header>
            <p className="mf-muted" style={{ margin: 0, fontSize: 12, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase" }}>Meeting notes</p>
            <h1 style={{ margin: "4px 0 6px", fontSize: 24 }}>{ctx.eventType.title}</h1>
            <p className="mf-muted" style={{ margin: 0 }}>{formatRange(ctx.booking.startsAt, ctx.booking.endsAt, ctx.booking.inviteeTimeZone)}</p>
            <p className="mf-muted" style={{ margin: "6px 0 0", fontSize: 14 }}>
              Host: {ctx.host.name} · Attendees: {people.map((p) => p.name).join(", ")}
            </p>
            {ctx.booking.joinUrl && ctx.booking.status === "confirmed" && ctx.booking.endsAt > new Date() && (
              <a className="mf-btn" href={ctx.booking.joinUrl} target="_blank" rel="noopener noreferrer" style={{ marginTop: 12, display: "inline-flex" }}>Join meeting</a>
            )}
          </header>

          {n.botStatus === "scheduled" && <p className="mf-alert mf-alert-info" style={{ margin: 0 }}>A notetaker will join this meeting. The transcript and an AI summary appear here after it ends.</p>}
          {n.botStatus === "failed" && n.botId && <p className="mf-alert mf-alert-err" style={{ margin: 0 }}>The notetaker could not record this meeting (it may not have been let in).</p>}

          {!n.botId && audioNotesConfigured() && <RecordingPanel token={token} status={n.botStatus} />}

          {n.botId && n.botStatus === "done" && (!n.recordingExpiresAt || n.recordingExpiresAt > new Date()) && (
            <section>
              <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Recording</h2>
              {/* Same-origin URLs that redirect to fresh (expiring) Recall download links */}
              <video controls preload="metadata" src={`/api/public/notes/${token}/media/video`} style={{ width: "100%", borderRadius: 12, background: "#000" }} />
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 10 }}>
                <audio controls preload="none" src={`/api/public/notes/${token}/media/audio`} style={{ flex: "1 1 260px", maxWidth: "100%" }} aria-label="Audio only" />
                {n.recordingExpiresAt && <span className="mf-muted" style={{ fontSize: 13 }}>Available until {DateTime.fromJSDate(n.recordingExpiresAt).setZone(ctx.booking.inviteeTimeZone).toFormat("LLL d, yyyy")}</span>}
              </div>
            </section>
          )}

          {!!n.attendance?.length && (
            <section>
              <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Attendance</h2>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead><tr className="mf-muted" style={{ textAlign: "left" }}>
                    {["Name", "Joined", "Left", "Time"].map((h) => <th key={h} style={{ padding: "6px 8px", fontWeight: 600, borderBottom: "1px solid var(--mf-border)" }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {n.attendance.map((a, i) => (
                      <tr key={i}>
                        <td style={{ padding: "6px 8px" }}>{a.name}</td>
                        <td style={{ padding: "6px 8px" }}>{clock(a.joinedAt, ctx.booking.inviteeTimeZone)}</td>
                        <td style={{ padding: "6px 8px" }}>{a.leftAt ? clock(a.leftAt, ctx.booking.inviteeTimeZone) : "Until the end"}</td>
                        <td style={{ padding: "6px 8px" }}>{Math.max(1, Math.round(a.seconds / 60))} min</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {n.summary && (
            <section>
              <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>AI summary</h2>
              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: 15 }}>{n.summary}</div>
            </section>
          )}

          <section>
            <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Your notes</h2>
            <NotesEditor token={token} initial={n.content} initialUpdatedAt={n.updatedAt ? n.updatedAt.toISOString() : null} />
          </section>

          {!!n.chat?.length && (
            <details>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Meeting chat ({n.chat.length})</summary>
              <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0", display: "grid", gap: 8, fontSize: 14 }}>
                {n.chat.map((c, i) => (
                  <li key={i}><span className="mf-muted">[{clock(c.at, ctx.booking.inviteeTimeZone)}]</span> <strong>{c.name}:</strong> <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.text}</span></li>
                ))}
              </ul>
            </details>
          )}

          {n.transcript && (
            <details>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Transcript</summary>
              <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 14, lineHeight: 1.6, marginTop: 10 }}>{n.transcript}</pre>
            </details>
          )}
        </div>
      </PageFrame>
    </PublicShell>
  );
}

const clock = (iso: string, tz: string) => DateTime.fromISO(iso).setZone(tz).toFormat("h:mm a");
