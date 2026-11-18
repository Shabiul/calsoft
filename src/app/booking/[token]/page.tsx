import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadBookingView } from "@/server/public/data";
import { PublicShell } from "@/components/booking/PublicShell";
import { PageFrame, FlowSkeleton } from "@/components/booking/PublicChrome";
import { ManageClient } from "@/components/booking/ManageClient";
import { APP_NAME } from "@/lib/brand";

type P = { params: Promise<{ token: string }> };

// Private capability URL: never index, never leak the token via referrer.
export const metadata: Metadata = {
  title: `Manage your booking | ${APP_NAME}`,
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function ManagePage({ params }: P) {
  return (
    <Suspense fallback={<PublicShell><PageFrame wide><FlowSkeleton /></PageFrame></PublicShell>}>
      <Manage params={params} />
    </Suspense>
  );
}

async function Manage({ params }: P) {
  const { token } = await params;
  const view = await loadBookingView(token);
  if (!view) notFound();
  return (
    <PublicShell brandColor={view.event.brandColor}>
      <PageFrame wide>
        <ManageClient view={view} token={token} />
      </PageFrame>
    </PublicShell>
  );
}
