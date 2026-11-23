"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarDays, Link2, RefreshCw, Video } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Switch, toast } from "@/components/ui";

export interface ProviderInfo {
  id: "google" | "microsoft" | "zoho" | "zoom"; configured: boolean; missing: string[]; redirectUri: string; webhookUrl: string | null;
}
interface Cal { id: string; name: string; checkConflicts: boolean; isDestination: boolean; lastSyncedAt: string | null; syncError: string | null; pushActive: boolean }
interface Conn { id: string; provider: "google" | "microsoft" | "zoho"; email: string | null; status: string; lastError: string | null; createdAt: string; calendars: Cal[] }
interface Video { id: string; provider: string; email: string | null; status: string; lastError: string | null }

export interface MailHint { email: string; label: string; kind: "personal" | "business" | "unknown"; recommended: string[]; reason: string }
const LABEL = { google: "Google Calendar", microsoft: "Microsoft Outlook", zoho: "Zoho Calendar", zoom: "Zoom" } as const;
const BLURB = {
  google: "Check Google calendars for conflicts, add events and Google Meet links.",
  microsoft: "Check Outlook calendars for conflicts, add events and Microsoft Teams links.",
  zoho: "Check Zoho calendars for conflicts, add events and Zoho Meeting links.",
} as const;
type CalId = keyof typeof BLURB;
const CAL_IDS: CalId[] = ["google", "microsoft", "zoho"];
const DOC_HINT = "See docs/INTEGRATIONS.md for the exact console setup.";

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; message?: string }> {
  try {
    const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    if (r.ok) return { ok: true };
    const j = await r.json().catch(() => null) as { error?: { message?: string } } | null;
    return { ok: false, message: j?.error?.message ?? `Request failed (${r.status})` };
  } catch { return { ok: false, message: "Network error. Check your connection and try again." }; }
}

function StatusBadge({ status }: { status: string }) {
  if (status === "active") return <Badge variant="success">Connected</Badge>;
  if (status === "needs_reauth") return <Badge variant="warning">Reconnect required</Badge>;
  return <Badge variant="destructive">Error</Badge>;
}

function ConnectButton({ p, label }: { p: ProviderInfo; label: string }) {
  if (!p.configured) {
    return (
      <div className="space-y-1 text-sm">
        <Badge variant="secondary">Requires credentials</Badge>
        <p className="text-muted-foreground">Set <code className="rounded bg-muted px-1">{p.missing.join(", ")}</code> on the server. {DOC_HINT}</p>
        <p className="text-xs text-muted-foreground">Redirect URI to register: <code className="break-all rounded bg-muted px-1">{p.redirectUri}</code></p>
      </div>
    );
  }
  return <Button asChild><a href={`/api/integrations/${p.id}/start`}><Link2 />{label}</a></Button>;
}

export function IntegrationsPanel({ providers, connections, video, flash, webhooksAvailable, mail }: {
  providers: ProviderInfo[]; connections: Conn[]; video: Video[]; flash: { type: "error" | "success"; text: string } | null; webhooksAvailable: boolean; mail?: MailHint;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const shown = React.useRef(false);
  React.useEffect(() => {
    if (flash && !shown.current) { shown.current = true; (flash.type === "error" ? toast.error : toast.success)(flash.text); }
  }, [flash]);

  const run = async (key: string, fn: () => Promise<{ ok: boolean; message?: string }>, okMsg?: string) => {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    if (!r.ok) toast.error(r.message ?? "Something went wrong");
    else { if (okMsg) toast.success(okMsg); router.refresh(); }
  };
  const info = (id: ProviderInfo["id"]) => providers.find((p) => p.id === id)!;
  const googleConnected = connections.some((c) => c.provider === "google" && c.status === "active");
  const msConnected = connections.some((c) => c.provider === "microsoft" && c.status === "active");
  const zohoConnected = connections.some((c) => c.provider === "zoho" && c.status === "active");
  const recommended = CAL_IDS.filter((id) => mail?.recommended.includes(id));
  const others = CAL_IDS.filter((id) => !recommended.includes(id));
  const zoom = video.find((v) => v.provider === "zoom");
  const hasDestination = connections.some((c) => c.calendars.some((k) => k.isDestination));

  const providerCard = (id: CalId, highlight?: boolean) => (
    <Card key={id} className={highlight ? "border-primary/50 ring-1 ring-primary/20" : undefined}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">{LABEL[id]}{highlight && <Badge variant="success">Recommended</Badge>}</CardTitle>
        <CardDescription>{BLURB[id]}</CardDescription>
      </CardHeader>
      <CardContent><ConnectButton p={info(id)} label={connections.some((c) => c.provider === id) ? "Connect another account" : "Connect"} /></CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      {flash?.type === "error" && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {flash.text}
        </div>
      )}
      {!webhooksAvailable && connections.length > 0 && (
        <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
          Real-time push updates need a public HTTPS <code>APP_URL</code>. Until then, calendars are polled every ~10 minutes and re-checked live at booking time.
        </p>
      )}

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><CalendarDays className="size-5" /> Calendars</h2>
        {connections.map((c) => (
          <Card key={c.id}>
            <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
              <div>
                <CardTitle>{LABEL[c.provider]}</CardTitle>
                <CardDescription>{c.email ?? "Account"}</CardDescription>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <StatusBadge status={c.status} />
                {c.status !== "active" && info(c.provider).configured && <Button asChild size="sm" variant="secondary"><a href={`/api/integrations/${c.provider}/start`}>Reconnect</a></Button>}
                <Button size="sm" variant="outline" loading={busy === `r${c.id}`} disabled={c.status !== "active"}
                  onClick={() => run(`r${c.id}`, () => call(`/api/integrations/connections/${c.id}/refresh`, "POST"), "Calendars refreshed")}><RefreshCw />Refresh</Button>
                <Button size="sm" variant="destructive" loading={busy === `d${c.id}`}
                  onClick={() => { if (window.confirm(`Disconnect ${LABEL[c.provider]} (${c.email ?? "account"})? Existing bookings keep their events but will no longer sync.`)) void run(`d${c.id}`, () => call(`/api/integrations/connections/${c.id}`, "DELETE"), "Disconnected"); }}>Disconnect</Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {c.status !== "active" && (
                <p role="alert" className="flex items-start gap-2 text-sm text-warning"><AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  {c.status === "needs_reauth" ? "Access was revoked or expired. Reconnect to resume conflict checks and event creation." : c.lastError ?? "Unknown error."}</p>
              )}
              {c.calendars.length === 0 && <p className="text-sm text-muted-foreground">No calendars found on this account.</p>}
              <ul className="divide-y rounded-lg border">
                {c.calendars.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{k.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {k.checkConflicts ? (k.lastSyncedAt ? `Synced ${new Date(k.lastSyncedAt).toLocaleString()}${k.pushActive ? " · live updates" : ""}` : "Waiting for first sync") : "Not checked for conflicts"}
                      </p>
                      {k.syncError && <p className="text-xs text-destructive">Sync error: {k.syncError}</p>}
                    </div>
                    <div className="flex items-center gap-5 text-sm">
                      <label className="flex items-center gap-2">
                        <Switch checked={k.checkConflicts} disabled={busy === `c${k.id}` || c.status !== "active"} aria-label={`Check ${k.name} for conflicts`}
                          onCheckedChange={(v) => run(`c${k.id}`, () => call(`/api/integrations/calendars/${k.id}`, "PATCH", { checkConflicts: v }))} />
                        Check conflicts
                      </label>
                      <label className="flex items-center gap-2">
                        <Switch checked={k.isDestination} disabled={busy === `x${k.id}` || c.status !== "active"} aria-label={`Add new bookings to ${k.name}`}
                          onCheckedChange={(v) => run(`x${k.id}`, () => call(`/api/integrations/calendars/${k.id}`, "PATCH", { isDestination: v }))} />
                        Add bookings here
                      </label>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
        {connections.length > 0 && !hasDestination && (
          <p className="text-sm text-muted-foreground">Choose a destination calendar to have new bookings (and Google Meet / Teams / Zoho Meeting links) added automatically.</p>
        )}
        {recommended.length > 0 && mail && (
          <div className="space-y-2">
            <div>
              <h3 className="text-sm font-semibold">Recommended for {mail.email}</h3>
              {mail.reason && <p className="text-sm text-muted-foreground">{mail.reason}</p>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {recommended.map((id) => providerCard(id, true))}
            </div>
          </div>
        )}
        <div className="space-y-2">
          {recommended.length > 0 && <h3 className="text-sm font-semibold text-muted-foreground">Other options</h3>}
          <div className="grid gap-3 sm:grid-cols-2">
            {others.map((id) => providerCard(id))}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><Video className="size-5" /> Video conferencing</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card><CardHeader><CardTitle>Google Meet</CardTitle><CardDescription>Created with the booking event on your Google destination calendar.</CardDescription></CardHeader>
            <CardContent>{googleConnected ? <Badge variant="success">Available</Badge> : <Badge variant="secondary">Connect Google Calendar first</Badge>}</CardContent></Card>
          <Card><CardHeader><CardTitle>Microsoft Teams</CardTitle><CardDescription>Created with the booking event on your Microsoft destination calendar.</CardDescription></CardHeader>
            <CardContent>{msConnected ? <Badge variant="success">Available</Badge> : <Badge variant="secondary">Connect Outlook first</Badge>}</CardContent></Card>
          <Card><CardHeader><CardTitle>Zoho Meeting</CardTitle><CardDescription>Created with the booking event on your Zoho destination calendar.</CardDescription></CardHeader>
            <CardContent>{zohoConnected ? <Badge variant="success">Available</Badge> : <Badge variant="secondary">Connect Zoho Calendar first</Badge>}</CardContent></Card>
          <Card><CardHeader><CardTitle>Zoom</CardTitle><CardDescription>{zoom ? zoom.email ?? "Connected account" : "A unique Zoom meeting is created for each booking."}</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              {zoom ? (
                <>
                  <StatusBadge status={zoom.status} />
                  {zoom.status !== "active" && <p role="alert" className="text-sm text-warning">Reconnect Zoom to keep creating meetings.</p>}
                  <div className="flex gap-2">
                    {zoom.status !== "active" && info("zoom").configured && <Button asChild size="sm" variant="secondary"><a href="/api/integrations/zoom/start">Reconnect</a></Button>}
                    <Button size="sm" variant="destructive" loading={busy === "zoom"} onClick={() => run("zoom", () => call("/api/integrations/video/zoom", "DELETE"), "Zoom disconnected")}>Disconnect</Button>
                  </div>
                </>
              ) : <ConnectButton p={info("zoom")} label="Connect Zoom" />}
            </CardContent></Card>
        </div>
      </section>
    </div>
  );
}
