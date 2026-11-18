"use client";
import { useState } from "react";
import { visibleFields, type Answers, type RoutingField } from "@/server/services/routing-eval";

type Result = { kind: "redirect"; url: string; external: boolean } | { kind: "message"; title: string; message: string };

export function PublicRoutingForm({ username, slug, title, hostName, fields }: { username: string; slug: string; title: string; hostName: string; fields: RoutingField[] }) {
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<Result | null>(null);

  const shown = visibleFields(fields, answers);
  const set = (id: string, v: string | string[]) => { setAnswers((a) => ({ ...a, [id]: v })); setErrors((e) => { const { [id]: _drop, ...rest } = e; void _drop; return rest; }); };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setFormError(null);
    try {
      const visibleIds = new Set(shown.map((f) => f.id));
      const payload = Object.fromEntries(Object.entries(answers).filter(([k]) => visibleIds.has(k)));
      const res = await fetch("/api/public/routing", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, slug, answers: payload }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        if (json?.error?.code === "VALIDATION" && json.error.details && typeof json.error.details === "object") setErrors(json.error.details as Record<string, string>);
        setFormError(res.status === 429 ? "Too many attempts. Please wait a moment and try again." : json?.error?.message ?? "Something went wrong. Please try again.");
        return;
      }
      const result = json.result as Result;
      if (result.kind === "redirect") {
        setDone(result);
        window.location.assign(result.url);
      } else setDone(result);
    } catch {
      setFormError("Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done?.kind === "message") {
    return (
      <div className="mf-card" role="status" style={{ padding: "40px 28px", textAlign: "center" }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>{done.title}</h1>
        <p className="mf-muted" style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>{done.message}</p>
      </div>
    );
  }
  if (done?.kind === "redirect") {
    return (
      <div className="mf-card" role="status" style={{ padding: "40px 28px", textAlign: "center" }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Redirecting...</h1>
        <p className="mf-muted" style={{ marginTop: 10 }}>If nothing happens, <a href={done.url} rel={done.external ? "noopener noreferrer" : undefined} style={{ color: "var(--mf-brand)" }}>continue here</a>.</p>
      </div>
    );
  }

  return (
    <form className="mf-card" onSubmit={submit} noValidate style={{ padding: "clamp(18px, 4vw, 32px)", display: "grid", gap: 18 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 24 }}>{title}</h1>
        <p className="mf-muted" style={{ margin: "6px 0 0" }}>from {hostName}</p>
      </div>
      {shown.map((f) => <FieldInput key={f.id} f={f} value={answers[f.id]} error={errors[f.id]} onChange={(v) => set(f.id, v)} />)}
      {formError && <div className="mf-err" role="alert">{formError}</div>}
      <button type="submit" className="mf-btn" disabled={busy} style={{ justifySelf: "start" }}>{busy ? "Please wait..." : "Continue"}</button>
    </form>
  );
}

function FieldInput({ f, value, error, onChange }: { f: RoutingField; value: string | string[] | undefined; error?: string; onChange: (v: string | string[]) => void }) {
  const id = `rf-${f.id}`;
  const str = typeof value === "string" ? value : "";
  const arr = Array.isArray(value) ? value : [];
  const errId = error ? `${id}-err` : undefined;
  const label = <span className="mf-label" id={`${id}-l`}>{f.label}{f.required && <span style={{ color: "var(--mf-danger)" }} aria-hidden> *</span>}</span>;
  let control: React.ReactNode;
  if (f.type === "dropdown") {
    control = (
      <select id={id} className="mf-input" value={str} aria-invalid={!!error} aria-describedby={errId} aria-required={f.required} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select...</option>
        {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (f.type === "radio" || f.type === "checkbox") {
    control = (
      <div role={f.type === "radio" ? "radiogroup" : "group"} aria-labelledby={`${id}-l`} aria-describedby={errId} style={{ display: "grid", gap: 8 }}>
        {(f.options ?? []).map((o) => (
          <label key={o} style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input
              type={f.type} name={id} checked={f.type === "radio" ? str === o : arr.includes(o)} style={{ accentColor: "var(--mf-brand)" }}
              onChange={(e) => onChange(f.type === "radio" ? o : e.target.checked ? [...arr, o] : arr.filter((x) => x !== o))}
            />
            <span>{o}</span>
          </label>
        ))}
      </div>
    );
  } else if (f.type === "long_text") {
    control = <textarea id={id} className="mf-input" value={str} maxLength={2000} aria-invalid={!!error} aria-describedby={errId} aria-required={f.required} onChange={(e) => onChange(e.target.value)} />;
  } else {
    control = (
      <input id={id} className="mf-input" type={f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text"} value={str} maxLength={500}
        autoComplete={f.type === "email" ? "email" : f.type === "phone" ? "tel" : undefined} aria-invalid={!!error} aria-describedby={errId} aria-required={f.required}
        onChange={(e) => onChange(e.target.value)} />
    );
  }
  const isGroup = f.type === "radio" || f.type === "checkbox";
  return (
    <div>
      {isGroup ? label : <label htmlFor={id}>{label}</label>}
      {control}
      {error && <div className="mf-err" id={errId} role="alert">{error}</div>}
    </div>
  );
}
