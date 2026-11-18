import type { Metadata } from "next";
import { PublicShell } from "@/components/booking/PublicShell";
import { PageFrame, Unavailable } from "@/components/booking/PublicChrome";

export const metadata: Metadata = { title: "Page not found", robots: { index: false, follow: false } };

export default function NotFound() {
  return (
    <PublicShell>
      <PageFrame>
        <Unavailable title="This booking page is unavailable" message="The link may be mistyped, or the host has disabled, archived or removed this page." />
      </PageFrame>
    </PublicShell>
  );
}
