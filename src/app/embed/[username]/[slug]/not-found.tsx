import { PublicShell } from "@/components/booking/PublicShell";
import { Unavailable } from "@/components/booking/PublicChrome";
import { EmbedResizer } from "@/components/booking/EmbedResizer";

export default function NotFound() {
  return (
    <PublicShell embed>
      <div style={{ padding: 8 }}>
        <Unavailable title="Scheduling page unavailable" message="This event is not available for booking." />
      </div>
      <EmbedResizer />
    </PublicShell>
  );
}
