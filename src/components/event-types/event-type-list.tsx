"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, CalendarPlus, Clock, Copy, ExternalLink, Link2, MoreHorizontal, Pencil, Plus, Trash2, Users } from "lucide-react";
import {
  Badge, Button, Card, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, Switch, toast,
} from "@/components/ui";
import { unwrap } from "./action-toast";
import { copyText } from "./copy";
import { KIND_LABELS, type EventKind } from "@/lib/validation/event-types";
import {
  archiveEventTypeAction, deleteEventTypeAction, duplicateEventTypeAction, toggleEventTypeActiveAction,
} from "@/app/(app)/dashboard/event-types/actions";

export type EventTypeListRow = {
  id: string; title: string; slug: string; kind: EventKind; durationMinutes: number; color: string | null; isActive: boolean; isOneOff: boolean;
  archived: boolean; hostCount: number; priceLabel: string | null; publicPath: string | null;
};

export function EventTypeList({ rows, origin, canCreate }: { rows: EventTypeListRow[]; origin: string; canCreate: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<EventTypeListRow | null>(null);

  async function run<T>(key: string, fn: () => Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string } }>, msg: string, after?: (d: T) => void) {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    const r = unwrap(res, msg);
    if (r) { after?.(r.data); router.refresh(); }
  }

  const newBtn = canCreate ? <Button asChild><Link href="/dashboard/event-types/new"><Plus /> New event type</Link></Button> : null;
  if (rows.length === 0) {
    return <EmptyState icon={<CalendarPlus />} title="No event types yet" description="Create your first event type so people can start booking time with you." action={newBtn} />;
  }

  return (
    <>
      <ul className="grid gap-3">
        {rows.map((r) => {
          const url = r.publicPath ? `${origin}${r.publicPath}` : null;
          return (
            <li key={r.id}>
              <Card className="flex items-stretch overflow-hidden">
                <div className="w-1.5 shrink-0" style={{ background: r.color ?? "var(--brand)" }} aria-hidden />
                <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/dashboard/event-types/${r.id}`} className="truncate font-medium hover:underline">{r.title}</Link>
                      {r.archived ? <Badge variant="secondary">Archived</Badge> : !r.isActive ? <Badge variant="warning">Inactive</Badge> : null}
                      {r.isOneOff ? <Badge variant="outline">One-off</Badge> : null}
                      {r.priceLabel ? <Badge>{r.priceLabel}</Badge> : null}
                    </div>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                      <span className="inline-flex items-center gap-1"><Clock className="size-3.5" /> {r.durationMinutes} min</span>
                      <span>{KIND_LABELS[r.kind]}</span>
                      {r.hostCount > 0 ? <span className="inline-flex items-center gap-1"><Users className="size-3.5" /> {r.hostCount} host{r.hostCount === 1 ? "" : "s"}</span> : null}
                      <span className="truncate">{url ? url.replace(/^https?:\/\//, "") : `/${r.slug}`}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {!r.archived ? (
                      <Switch checked={r.isActive} aria-label={`${r.title} active`} disabled={busy === r.id}
                        onCheckedChange={(c) => run(r.id, () => toggleEventTypeActiveAction(r.id, c), c ? "Event activated" : "Event deactivated")} />
                    ) : null}
                    <Button variant="ghost" size="icon" aria-label="Copy link" disabled={!url} title={url ? "Copy link" : "Set a username to get a public link"}
                      onClick={async () => { if (url && (await copyText(url))) toast.success("Link copied"); else toast.error("Could not copy the link"); }}><Link2 /></Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${r.title}`} loading={busy === r.id}><MoreHorizontal /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild><Link href={`/dashboard/event-types/${r.id}`}><Pencil /> Edit</Link></DropdownMenuItem>
                        {url ? <DropdownMenuItem asChild><a href={url} target="_blank" rel="noreferrer"><ExternalLink /> Preview</a></DropdownMenuItem> : null}
                        <DropdownMenuItem onSelect={() => run(r.id, () => duplicateEventTypeAction(r.id), "Event type duplicated", (d) => router.push(`/dashboard/event-types/${d.id}`))}><Copy /> Duplicate</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => run(r.id, () => duplicateEventTypeAction(r.id, { oneOff: true }), "One-off link created", (d) => router.push(`/dashboard/event-types/${d.id}`))}><Link2 /> Create one-off link</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => run(r.id, () => archiveEventTypeAction(r.id, !r.archived), r.archived ? "Event type restored" : "Event type archived")}>
                          {r.archived ? <><ArchiveRestore /> Restore</> : <><Archive /> Archive</>}
                        </DropdownMenuItem>
                        <DropdownMenuItem destructive onSelect={() => setConfirm(r)}><Trash2 /> Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{confirm?.title}”?</DialogTitle>
            <DialogDescription>The booking link stops working immediately. Existing bookings are kept. Consider archiving instead if you may need it again.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="destructive" loading={busy === "delete"} onClick={() => confirm && run("delete", () => deleteEventTypeAction(confirm.id), "Event type deleted", () => setConfirm(null))}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
