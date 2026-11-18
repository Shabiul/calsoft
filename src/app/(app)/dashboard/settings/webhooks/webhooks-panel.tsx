"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Plus, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, Card, EmptyState, Input, Label, Switch } from "@/components/ui";
import { WEBHOOK_EVENTS } from "@/server/webhooks/events";
import {
  createWebhookAction, deleteWebhookAction, listDeliveriesAction, retryDeliveryAction, rotateWebhookSecretAction, testWebhookAction, updateWebhookAction,
} from "./actions";

export interface EndpointRow { id: string; url: string; events: string[]; isActive: boolean; createdAt: string }
interface DeliveryRow { id: string; event: string; status: string; attempts: number; responseCode: number | null; error: string | null; createdAt: string }

function SecretBanner({ secret, onDone }: { secret: string; onDone: () => void }) {
  return (
    <Card className="space-y-2 border-warning/50 bg-warning/5 p-4">
      <p className="text-sm font-medium">Copy your signing secret now. It will not be shown again.</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 break-all rounded bg-muted px-2 py-1.5 text-xs">{secret}</code>
        <Button type="button" size="sm" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(secret); toast.success("Copied"); } catch { toast.error("Copy failed; select and copy manually"); } }}><Copy /> Copy</Button>
      </div>
      <p className="text-xs text-muted-foreground">Verify requests using the <code>MeetFlow-Signature</code> header (<code>t=timestamp,v1=hex</code>), an HMAC-SHA256 of <code>timestamp.body</code>.</p>
      <Button type="button" size="sm" onClick={onDone}>I have saved it</Button>
    </Card>
  );
}

function Deliveries({ endpointId }: { endpointId: string }) {
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [pending, start] = useTransition();
  const load = () => start(async () => {
    const r = await listDeliveriesAction(endpointId);
    if (r.ok) setRows(r.data); else toast.error(r.error.message);
  });
  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Recent deliveries</span>
        <Button type="button" size="sm" variant="outline" loading={pending} onClick={load}>{rows ? "Refresh" : "Load"}</Button>
      </div>
      {rows && rows.length === 0 && <p className="text-sm text-muted-foreground">No deliveries yet.</p>}
      {rows?.map((d) => (
        <div key={d.id} className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant={d.status === "sent" ? "success" : d.status === "dead" ? "destructive" : d.status === "failed" ? "warning" : "secondary"}>{d.status}</Badge>
          <span className="font-mono">{d.event}</span>
          <span className="text-muted-foreground">{new Date(d.createdAt).toLocaleString()}</span>
          <span className="text-muted-foreground">attempts {d.attempts}{d.responseCode ? `, HTTP ${d.responseCode}` : ""}</span>
          {d.error && <span className="truncate text-destructive" title={d.error}>{d.error.slice(0, 80)}</span>}
          {(d.status === "dead" || d.status === "failed") && (
            <Button type="button" size="sm" variant="ghost" onClick={async () => { const r = await retryDeliveryAction(d.id); if (r.ok) { toast.success("Re-queued"); } else toast.error(r.error.message); }}>Retry</Button>
          )}
        </div>
      ))}
    </div>
  );
}

export function WebhooksPanel({ endpoints }: { endpoints: EndpointRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [creating, setCreating] = useState(endpoints.length === 0);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["booking.created", "booking.cancelled", "booking.rescheduled"]);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const create = (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    start(async () => {
      const r = await createWebhookAction({ url, events });
      if (!r.ok) { setError(r.error.message); return; }
      setSecret(r.data.secret); setUrl(""); setCreating(false); router.refresh();
    });
  };
  const run = (fn: () => Promise<{ ok: boolean; error?: { message: string } }>, ok: string) => start(async () => {
    const r = await fn();
    if (!r.ok) toast.error(r.error?.message ?? "Failed"); else { toast.success(ok); router.refresh(); }
  });

  return (
    <div className="space-y-4">
      {secret && <SecretBanner secret={secret} onDone={() => setSecret(null)} />}
      {!creating && <Button onClick={() => setCreating(true)}><Plus /> Add endpoint</Button>}
      {creating && (
        <Card className="p-5">
          <form onSubmit={create} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="wh-url">Endpoint URL</Label>
              <Input id="wh-url" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhooks/meetflow" aria-invalid={!!error} />
              <p className="text-xs text-muted-foreground">HTTPS only. Private and internal addresses are blocked in production.</p>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Events</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {WEBHOOK_EVENTS.map((ev) => (
                  <label key={ev} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} />
                    <span className="font-mono text-xs">{ev}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" loading={pending}>Create endpoint</Button>
              {endpoints.length > 0 && <Button type="button" variant="ghost" onClick={() => { setCreating(false); setError(null); }}>Cancel</Button>}
            </div>
          </form>
        </Card>
      )}
      {endpoints.length === 0 && !creating && (
        <EmptyState icon={<Webhook />} title="No webhook endpoints" description="Add an endpoint to receive booking events." />
      )}
      {endpoints.map((ep) => (
        <Card key={ep.id} className="p-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="break-all font-mono text-sm">{ep.url}</p>
              <div className="mt-1 flex flex-wrap gap-1">{ep.events.map((e) => <Badge key={e} variant="secondary">{e}</Badge>)}</div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={ep.isActive} disabled={pending} aria-label="Enabled"
                onCheckedChange={(v) => run(() => updateWebhookAction(ep.id, { isActive: v }), v ? "Enabled" : "Disabled")} />
              {ep.isActive ? "Enabled" : "Disabled"}
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={pending || !ep.isActive} onClick={() => run(() => testWebhookAction(ep.id), "Test event queued")}>Send test</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setOpen(open === ep.id ? null : ep.id)}>{open === ep.id ? "Hide deliveries" : "Deliveries"}</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => {
              if (!window.confirm("Rotate the signing secret? The old secret stops working immediately.")) return;
              start(async () => { const r = await rotateWebhookSecretAction(ep.id); if (r.ok) setSecret(r.data.secret); else toast.error(r.error.message); });
            }}>Rotate secret</Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => { if (window.confirm("Delete this endpoint and its delivery history?")) run(() => deleteWebhookAction(ep.id), "Endpoint deleted"); }}>Delete</Button>
          </div>
          {open === ep.id && <Deliveries endpointId={ep.id} />}
        </Card>
      ))}
    </div>
  );
}
