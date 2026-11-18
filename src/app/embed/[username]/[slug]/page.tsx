import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadEvent, loadUserIdByUsername, trackPageView, safeColor } from "@/server/public/data";
import { PublicShell } from "@/components/booking/PublicShell";
import { FlowSkeleton } from "@/components/booking/PublicChrome";
import { BookingFlow } from "@/components/booking/BookingFlow";
import { EmbedResizer } from "@/components/booking/EmbedResizer";

type P = {
  params: Promise<{ username: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function EmbedPage(props: P) {
  return (
    <Suspense fallback={<div style={{ padding: 8 }}><FlowSkeleton /></div>}>
      <Embed {...props} />
    </Suspense>
  );
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function Embed({ params, searchParams }: P) {
  const { username, slug } = await params;
  const sp = await searchParams;
  const event = await loadEvent(username, slug);
  if (!event) notFound();
  const uid = await loadUserIdByUsername(username);
  await trackPageView(event.id, uid);

  const theme = one(sp.theme);
  const colorParam = one(sp.color);
  const brand = colorParam ? safeColor(`#${colorParam.replace(/^#/, "")}`) : null;
  return (
    <PublicShell embed brandColor={brand ?? event.brandColor} forcedTheme={theme === "dark" || theme === "light" ? theme : undefined}>
      <div style={{ padding: 8 }}>
        <BookingFlow event={event} embed />
      </div>
      <EmbedResizer />
    </PublicShell>
  );
}
