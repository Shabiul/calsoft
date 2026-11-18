import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Clock, MapPin } from "lucide-react";
import { loadProfile, loadUserIdByUsername, trackPageView, LOCATION_LABELS } from "@/server/public/data";
import { PublicShell } from "@/components/booking/PublicShell";
import { PageFrame, FlowSkeleton } from "@/components/booking/PublicChrome";
import { formatDuration, formatMoney } from "@/components/booking/format";
import { APP_NAME } from "@/lib/brand";

type P = { params: Promise<{ username: string }> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { username } = await params;
  const p = await loadProfile(username);
  if (!p) return { title: `Not found | ${APP_NAME}`, robots: { index: false } };
  const title = `${p.host.name} | Book a meeting`;
  const description = p.host.bio?.slice(0, 160) || `Schedule a meeting with ${p.host.name}.`;
  return {
    title, description,
    openGraph: { title, description, type: "profile", images: p.host.image ? [{ url: p.host.image }] : undefined },
    twitter: { card: "summary", title, description },
  };
}

export default function ProfilePage({ params }: P) {
  return (
    <Suspense fallback={<PublicShell><PageFrame><FlowSkeleton /></PageFrame></PublicShell>}>
      <Profile params={params} />
    </Suspense>
  );
}

async function Profile({ params }: P) {
  const { username } = await params;
  const p = await loadProfile(username);
  if (!p) notFound();
  const uid = await loadUserIdByUsername(username);
  await trackPageView(null, uid);

  return (
    <PublicShell brandColor={p.host.brandColor}>
      <PageFrame>
        <header style={{ textAlign: "center", display: "grid", gap: 8, justifyItems: "center", marginBottom: 28 }}>
          {p.host.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.host.logoUrl} alt="" style={{ maxHeight: 40, maxWidth: 180, objectFit: "contain" }} referrerPolicy="no-referrer" />
          )}
          {p.host.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.host.image} alt="" width={84} height={84} style={{ borderRadius: 999, objectFit: "cover" }} referrerPolicy="no-referrer" />
          ) : (
            <div aria-hidden style={{ width: 84, height: 84, borderRadius: 999, background: "var(--mf-brand)", color: "var(--mf-brand-fg)", display: "grid", placeItems: "center", fontSize: 34, fontWeight: 800 }}>{p.host.name.slice(0, 1).toUpperCase()}</div>
          )}
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>{p.host.name}</h1>
          {p.host.bio && <p className="mf-muted" style={{ margin: 0, maxWidth: 520, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{p.host.bio}</p>}
          <p className="mf-muted" style={{ margin: 0, fontSize: 14 }}>Welcome! Pick a meeting type to schedule a time.</p>
        </header>

        {p.events.length === 0 ? (
          <div className="mf-card" style={{ padding: 36, textAlign: "center" }}>
            <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>No public meeting types yet</h2>
            <p className="mf-muted" style={{ margin: 0 }}>{p.host.name} has not published any bookable events.</p>
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))" }}>
            {p.events.map((e) => (
              <li key={e.slug}>
                <a className="mf-card mf-profile-link" href={`/${p.host.username}/${e.slug}`} style={{ padding: 20, borderTop: `4px solid ${e.color ?? "var(--mf-brand)"}`, height: "100%" }}>
                  <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>{e.title}</h2>
                  {e.description && <p className="mf-muted" style={{ margin: "0 0 12px", fontSize: 14, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>{e.description}</p>}
                  <div className="mf-muted" style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13.5 }}>
                    <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}><Clock size={14} aria-hidden /> {formatDuration(e.durationMinutes)}</span>
                    <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}><MapPin size={14} aria-hidden /> {LOCATION_LABELS[e.locationType] ?? "Online"}</span>
                    {e.priceAmount && e.priceCurrency ? <span style={{ fontWeight: 600, color: "var(--mf-text)" }}>{formatMoney(e.priceAmount, e.priceCurrency)}</span> : null}
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </PageFrame>
    </PublicShell>
  );
}
