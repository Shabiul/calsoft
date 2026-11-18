"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, KeyRound, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, Card, EmptyState, Input, Label } from "@/components/ui";
import { API_KEY_SCOPES } from "@/server/webhooks/events";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";

export interface KeyRow { id: string; name: string; prefix: string; scopes: string[]; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }

export function ApiKeysPanel({ keys }: { keys: KeyRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["bookings:read"]);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const create = (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    start(async () => {
      const r = await createApiKeyAction({ name, scopes });
      if (!r.ok) { setError(r.error.message); return; }
      setCreated(r.data.key); setName(""); setCreating(false); router.refresh();
    });
  };
  const revoke = (k: KeyRow) => {
    if (!window.confirm(`Revoke "${k.name}"? Apps using it will stop working immediately.`)) return;
    start(async () => {
      const r = await revokeApiKeyAction(k.id);
      if (!r.ok) toast.error(r.error.message); else { toast.success("Key revoked"); router.refresh(); }
    });
  };

  return (
    <div className="space-y-4">
      {created && (
        <Card className="space-y-2 border-warning/50 bg-warning/5 p-4">
          <p className="text-sm font-medium">Copy your API key now. For security, it will not be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-muted px-2 py-1.5 text-xs">{created}</code>
            <Button type="button" size="sm" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(created); toast.success("Copied"); } catch { toast.error("Copy failed; select and copy manually"); } }}><Copy /> Copy</Button>
          </div>
          <Button type="button" size="sm" onClick={() => setCreated(null)}>I have saved it</Button>
        </Card>
      )}
      {!creating && <Button onClick={() => setCreating(true)}><Plus /> Create API key</Button>}
      {creating && (
        <Card className="p-5">
          <form onSubmit={create} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Zapier" />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Scopes</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {API_KEY_SCOPES.map((s) => (
                  <label key={s} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />
                    <span className="font-mono text-xs">{s}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" loading={pending}>Create key</Button>
              <Button type="button" variant="ghost" onClick={() => { setCreating(false); setError(null); }}>Cancel</Button>
            </div>
          </form>
        </Card>
      )}
      {keys.length === 0 && !creating ? (
        <EmptyState icon={<KeyRound />} title="No API keys" description="Create a key to call the MeetFlow API from your own tools." />
      ) : keys.map((k) => (
        <Card key={k.id} className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{k.name}</span>
              {k.revokedAt && <Badge variant="destructive">Revoked</Badge>}
            </div>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">{k.prefix}…</p>
            <div className="mt-1 flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s} variant="secondary">{s}</Badge>)}</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Created {new Date(k.createdAt).toLocaleDateString()} · {k.lastUsedAt ? `Last used ${new Date(k.lastUsedAt).toLocaleString()}` : "Never used"}
            </p>
          </div>
          {!k.revokedAt && <Button variant="outline" size="sm" disabled={pending} onClick={() => revoke(k)}>Revoke</Button>}
        </Card>
      ))}
    </div>
  );
}
