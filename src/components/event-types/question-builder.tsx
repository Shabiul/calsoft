"use client";
import * as React from "react";
import { ArrowDown, ArrowUp, MessageSquarePlus, Trash2 } from "lucide-react";
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Textarea } from "@/components/ui";
import { OPTION_QUESTION_TYPES, QUESTION_TYPES, type QuestionType } from "@/lib/validation/event-types";

export type QuestionState = { id?: string; label: string; type: QuestionType; options: string[]; required: boolean; key: string };

const TYPE_LABELS: Record<QuestionType, string> = {
  short_text: "Short text", long_text: "Long text", email: "Email", phone: "Phone number", dropdown: "Dropdown", radio: "Radio buttons", checkbox: "Checkboxes",
};
const needsOptions = (t: QuestionType) => (OPTION_QUESTION_TYPES as readonly string[]).includes(t);

let counter = 0;
export const newKey = () => `q${Date.now().toString(36)}${counter++}`;

export function QuestionBuilder({ questions, onChange, error }: { questions: QuestionState[]; onChange: (q: QuestionState[]) => void; error?: string }) {
  const update = (i: number, patch: Partial<QuestionState>) => onChange(questions.map((q, k) => (k === i ? { ...q, ...patch } : q)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= questions.length) return;
    const next = [...questions];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Name and email are always collected. Add extra questions invitees answer when booking.</p>
      {questions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No custom questions yet.</div>
      ) : null}
      {questions.map((q, i) => (
        <div key={q.key} className="rounded-lg border bg-card p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
            <div className="space-y-1.5">
              <Label htmlFor={`q-label-${q.key}`}>Question {i + 1}</Label>
              <Input id={`q-label-${q.key}`} value={q.label} maxLength={200} placeholder="What would you like to discuss?" onChange={(e) => update(i, { label: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Answer type</Label>
              <Select value={q.type} onValueChange={(v) => update(i, { type: v as QuestionType, options: needsOptions(v as QuestionType) ? q.options : [] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{QUESTION_TYPES.map((t) => <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          {needsOptions(q.type) ? (
            <div className="mt-3 space-y-1.5">
              <Label htmlFor={`q-opt-${q.key}`}>Options (one per line)</Label>
              <Textarea id={`q-opt-${q.key}`} rows={3} value={q.options.join("\n")} onChange={(e) => update(i, { options: e.target.value.split("\n") })} onBlur={() => update(i, { options: q.options.map((o) => o.trim()).filter(Boolean) })} />
            </div>
          ) : null}
          <div className="mt-3 flex items-center justify-between">
            <label className="flex cursor-pointer items-center gap-2 text-sm"><Switch checked={q.required} onCheckedChange={(c) => update(i, { required: c })} aria-label="Required" /> Required</label>
            <div className="flex gap-1">
              <Button type="button" variant="ghost" size="icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
              <Button type="button" variant="ghost" size="icon" aria-label="Move down" disabled={i === questions.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
              <Button type="button" variant="ghost" size="icon" aria-label="Delete question" onClick={() => onChange(questions.filter((_, k) => k !== i))}><Trash2 /></Button>
            </div>
          </div>
        </div>
      ))}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <Button type="button" variant="outline" disabled={questions.length >= 30} onClick={() => onChange([...questions, { label: "", type: "short_text", options: [], required: false, key: newKey() }])}>
        <MessageSquarePlus /> Add question
      </Button>
    </div>
  );
}
