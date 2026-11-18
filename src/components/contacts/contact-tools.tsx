"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Card, Input, Label, Textarea } from "@/components/ui";
import {
  addNoteAction, createContactAction, deleteNoteAction, mergeContactsAction, updateContactAction, updateNoteAction,
} from "@/app/(app)/dashboard/contacts/actions";

export function AddContactForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [v, setV] = useState({ email: "", name: "", phone: "" });
  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)}>Add contact</Button>;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await createContactAction(v);
      if (!r.ok) return void toast.error(r.error.message);
      toast.success(r.data.created ? "Contact added" : "Contact already existed; details were filled in");
      router.push(`/dashboard/contacts/${r.data.id}`);
    });
  };
  return (
    <Card className="w-full p-4 sm:basis-full">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-4 sm:items-end">
        <div className="space-y-1.5"><Label htmlFor="nc-email">Email</Label><Input id="nc-email" type="email" required value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></div>
        <div className="space-y-1.5"><Label htmlFor="nc-name">Name</Label><Input id="nc-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></div>
        <div className="space-y-1.5"><Label htmlFor="nc-phone">Phone</Label><Input id="nc-phone" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} /></div>
        <div className="flex gap-2"><Button type="submit" loading={pending}>Save</Button><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
      </form>
    </Card>
  );
}

export function ProfileEditor({ contactId, initial }: { contactId: string; initial: { name: string; phone: string; timeZone: string } }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [v, setV] = useState(initial);
  const dirty = v.name !== initial.name || v.phone !== initial.phone || v.timeZone !== initial.timeZone;
  return (
    <form
      className="grid gap-3 sm:grid-cols-3 sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await updateContactAction(contactId, v);
          if (!r.ok) toast.error(r.error.message); else { toast.success("Contact updated"); router.refresh(); }
        });
      }}
    >
      <div className="space-y-1.5"><Label htmlFor="pe-name">Name</Label><Input id="pe-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={200} /></div>
      <div className="space-y-1.5"><Label htmlFor="pe-phone">Phone</Label><Input id="pe-phone" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} maxLength={40} /></div>
      <div className="space-y-1.5"><Label htmlFor="pe-tz">Time zone</Label><Input id="pe-tz" value={v.timeZone} placeholder="e.g. Europe/London" onChange={(e) => setV({ ...v, timeZone: e.target.value })} /></div>
      <div className="sm:col-span-3"><Button type="submit" size="sm" disabled={!dirty} loading={pending}>Save changes</Button></div>
    </form>
  );
}

export interface NoteItem { id: string; body: string; createdAt: string; authorName: string | null; canDelete: boolean; when: string }

export function NotesPanel({ contactId, notes }: { contactId: string; notes: NoteItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const run = (fn: () => ReturnType<typeof addNoteAction>, ok: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error.message);
      toast.success(ok); after?.(); router.refresh();
    });
  return (
    <div className="space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); run(() => addNoteAction(contactId, text), "Note added", () => setText("")); }} className="space-y-2">
        <Label htmlFor="note-new" className="sr-only">New note</Label>
        <Textarea id="note-new" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a private note about this contact…" maxLength={5000} rows={3} />
        <Button type="submit" size="sm" loading={pending} disabled={!text.trim()}>Add note</Button>
      </form>
      {notes.length === 0 ? <p className="text-sm text-muted-foreground">No notes yet.</p> : (
        <ul className="space-y-3">
          {notes.map((n) => (
            <li key={n.id} className="rounded-lg border bg-card p-3 text-sm">
              {editing?.id === n.id ? (
                <div className="space-y-2">
                  <Textarea aria-label="Edit note" value={editing.body} onChange={(e) => setEditing({ id: n.id, body: e.target.value })} rows={3} maxLength={5000} />
                  <div className="flex gap-2">
                    <Button size="sm" loading={pending} disabled={!editing.body.trim()} onClick={() => run(() => updateNoteAction(contactId, n.id, editing.body), "Note updated", () => setEditing(null))}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="whitespace-pre-wrap break-words">{n.body}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>{n.authorName ?? "Unknown"} · {n.when}</span>
                    {n.canDelete && (
                      <>
                        <button className="underline-offset-2 hover:underline" onClick={() => setEditing({ id: n.id, body: n.body })}>Edit</button>
                        <button
                          className="text-destructive underline-offset-2 hover:underline"
                          onClick={() => { if (window.confirm("Delete this note?")) run(() => deleteNoteAction(contactId, n.id), "Note deleted"); }}
                        >Delete</button>
                      </>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface DupGroupItem { key: string; contacts: { id: string; email: string; name: string | null; bookingCount: number }[] }

export function DuplicatesPanel({ groups }: { groups: DupGroupItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!groups.length) return null;
  const merge = (g: DupGroupItem) => {
    const [primary, ...rest] = [...g.contacts].sort((a, b) => b.bookingCount - a.bookingCount);
    if (!primary || !window.confirm(`Merge ${g.contacts.length} records for ${g.key} into one? This cannot be undone.`)) return;
    start(async () => {
      const r = await mergeContactsAction(primary.id, rest.map((c) => c.id));
      if (!r.ok) toast.error(r.error.message); else { toast.success("Contacts merged"); router.refresh(); }
    });
  };
  return (
    <Card className="mb-4 border-warning/40 p-4" role="region" aria-label="Duplicate contacts">
      <h2 className="text-sm font-semibold">Possible duplicates</h2>
      <p className="mt-1 text-xs text-muted-foreground">These records share the same email address (ignoring letter case).</p>
      <ul className="mt-3 space-y-2">
        {groups.map((g) => (
          <li key={g.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{g.key} <span className="text-muted-foreground">({g.contacts.length} records)</span></span>
            <Button size="sm" variant="outline" loading={pending} onClick={() => merge(g)}>Merge</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
