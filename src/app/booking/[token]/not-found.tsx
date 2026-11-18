import type { Metadata } from "next";
import { PublicShell } from "@/components/booking/PublicShell";
import { PageFrame, Unavailable } from "@/components/booking/PublicChrome";

export const metadata: Metadata = { title: "Booking not found", robots: { index: false, follow: false } };

export default function NotFound() {
  return (
    <PublicShell>
      <PageFrame>
        <Unavailable title="Booking not found" message="This manage link is invalid or has expired. Use the link from your latest confirmation email." />
      </PageFrame>
    </PublicShell>
  );
}
