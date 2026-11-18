"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import { ArrowLeft, Clock, MapPin, Video, Phone, Globe, Banknote, Plus, X, AlertTriangle, RefreshCw } from "lucide-react";
import type { PublicEvent, PublicQuestion } from "@/server/public/data";
import { Calendar } from "./Calendar";
import { TimezoneSelect } from "./TimezoneSelect";
import { Confirmation, type Booked } from "./Confirmation";
import { PaymentStep } from "./PaymentStep";
import { SeriesPreview } from "./SeriesPreview";
import { hour12Store, useBrowserEnv, useHydrated } from "./client-env";
import {
  formatDateLong, formatDuration, formatMoney, formatRange, formatTime, LOCATION_LABELS,
} from "./format";

type Step = "pick" | "form" | "confirm" | "pay" | "done";
type SlotsResp = { slots: { startsAt: string; spotsLeft?: number }[] };
type ApiError = { error?: { code?: string; message?: string; details?: unknown } };

export type BookingFlowProps = {
  event: PublicEvent;
  embed?: boolean;
  /** Reschedule mode: the manage token of the booking being moved. */
  rescheduleToken?: string;
  prefill?: { name?: string; email?: string };
  /** Reschedule mode: current start (shown as "currently ..."). */
  currentStartsAt?: string;
  onRescheduled?: (newToken: string | null) => void;
};

const dayKey = (iso: string, tz: string) => DateTime.fromISO(iso, { zone: "utc" }).setZone(tz).toFormat("yyyy-MM-dd");
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);

function LocationIcon({ type }: { type: string }) {
  if (type === "in_person") return <MapPin size={16} aria-hidden />;
  if (type === "phone" || type === "invitee_phone") return <Phone size={16} aria-hidden />;
  if (type === "custom_url") return <Globe size={16} aria-hidden />;
  return <Video size={16} aria-hidden />;
}

export function BookingFlow({ event, embed, rescheduleToken, prefill, currentStartsAt, onRescheduled }: BookingFlowProps) {
  const reschedule = !!rescheduleToken;
  const env = useBrowserEnv();
  const ready = useHydrated();
  const [tzOverride, setTzOverride] = useState<string | null>(null);
  const tz = tzOverride ?? env.tz;
  const storedH12 = hour12Store.use();
  const hour12 = storedH12 === "1" ? true : storedH12 === "0" ? false : env.hour12;
  const [monthState, setMonthState] = useState<DateTime | null>(null);
  const month = monthState ?? (ready ? DateTime.now().setZone(tz).startOf("month") : null);
  const setMonth = setMonthState;
  const [slotsByMonth, setSlotsByMonth] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selDay, setSelDay] = useState<string | null>(null);
  const [selSlot, setSelSlot] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("pick");
  const [banner, setBanner] = useState<string | null>(null);
  const [booked, setBooked] = useState<Booked | null>(null);
  const idemKey = useRef(newKey());
  const autoAdvanced = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const setH12 = (v: boolean) => hour12Store.set(v ? "1" : "0");
  const monthKey = month ? `${tz}|${month.toFormat("yyyy-MM")}` : "";

  const fetchMonth = useCallback(async (m: DateTime, zone: string, force = false): Promise<string[] | null> => {
    const key = `${zone}|${m.toFormat("yyyy-MM")}`;
    if (!force && slotsByMonth[key]) return slotsByMonth[key]!;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true); setLoadError(null);
    try {
      const from = m.startOf("month").toUTC().toISO()!;
      const to = m.endOf("month").toUTC().toISO()!;
      const p = new URLSearchParams({ eventTypeId: event.id, from, to, tz: zone });
      if (rescheduleToken) p.set("token", rescheduleToken);
      const r = await fetch(`/api/public/slots?${p.toString()}`, { signal: ac.signal, cache: "no-store" });
      const data = (await r.json().catch(() => null)) as (SlotsResp & ApiError) | null;
      if (!r.ok || !data?.slots) throw new Error(data?.error?.message ?? "Could not load availability.");
      const list = data.slots.map((s) => s.startsAt);
      setSlotsByMonth((prev) => ({ ...prev, [key]: list }));
      return list;
    } catch (e) {
      if ((e as Error).name === "AbortError") return null;
      setLoadError((e as Error).message || "Could not load availability.");
      return null;
    } finally {
      if (abortRef.current === ac) setLoading(false);
    }
  }, [event.id, rescheduleToken, slotsByMonth]);

  // Load the visible month; if the very first month is empty, jump ahead to the next month with availability.
  useEffect(() => {
    if (!ready || !month) return;
    let cancelled = false;
    (async () => {
      const list = await fetchMonth(month, tz);
      if (cancelled || !list) return;
      if (!autoAdvanced.current && list.length === 0) {
        const horizonEnd = DateTime.now().setZone(tz).plus({ days: event.maxHorizonDays });
        if (month.plus({ months: 1 }).startOf("month") <= horizonEnd) setMonth(month.plus({ months: 1 }));
        else autoAdvanced.current = true;
      } else autoAdvanced.current = true;
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, monthKey]);

  // tz change -> reset view
  const changeTz = (z: string) => {
    setTzOverride(z); setSelDay(null); setSelSlot(null);
    setMonthState(null);
    autoAdvanced.current = false;
  };

  const monthSlots = useMemo(() => slotsByMonth[monthKey] ?? [], [slotsByMonth, monthKey]);
  const byDay = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of monthSlots) {
      const k = dayKey(s, tz);
      (m.get(k) ?? m.set(k, []).get(k)!).push(s);
    }
    return m;
  }, [monthSlots, tz]);
  const available = useMemo(() => new Set(byDay.keys()), [byDay]);
  const daySlots = selDay ? byDay.get(selDay) ?? [] : [];

  const nowZ = DateTime.now().setZone(tz);
  const canPrev = !!month && month > nowZ.startOf("month");
  const canNext = !!month && month.plus({ months: 1 }).startOf("month") <= nowZ.plus({ days: event.maxHorizonDays });

  async function refreshAfterConflict(msg: string) {
    idemKey.current = newKey();
    setBanner(msg); setSelSlot(null); setStep("pick");
    if (month) {
      const list = await fetchMonth(month, tz, true);
      if (list && selDay && !list.some((s) => dayKey(s, tz) === selDay)) setSelDay(null);
    }
  }

  // ───────── form state
  const [name, setName] = useState(prefill?.name ?? "");
  const [email, setEmail] = useState(prefill?.email ?? "");
  const [phone, setPhone] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [guests, setGuests] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function validateLocal(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Please enter your name";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) e.email = "Enter a valid email address";
    for (const q of event.questions) {
      const a = answers[q.id];
      const empty = Array.isArray(a) ? a.length === 0 : !a || !a.trim();
      if (q.required && empty) e[`q:${q.id}`] = "This field is required";
    }
    guests.forEach((g, i) => { if (g.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(g.trim())) e[`g:${i}`] = "Invalid email"; });
    if (!consent) e.consent = "Please accept the privacy notice to continue";
    return e;
  }

  async function submitBooking() {
    const local = validateLocal();
    setErrs(local); setFormError(null);
    if (Object.keys(local).length || !selSlot) return;
    setSubmitting(true);
    try {
      const r = await fetch("/api/public/book", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventTypeId: event.id, startsAt: selSlot,
          invitee: { name: name.trim(), email: email.trim(), phone: phone.trim() || undefined, timeZone: tz },
          answers, guests: guests.map((g) => g.trim()).filter(Boolean), idempotencyKey: idemKey.current, consent: true, embed: !!embed,
        }),
      });
      const data = (await r.json().catch(() => null)) as (ApiError & { booking?: { startsAt: string; endsAt: string; status: string; meetingUrl: string | null }; manageToken?: string | null; requiresPayment?: boolean; series?: { id: string; startsAt: string; endsAt: string; status: string }[] }) | null;
      if (!r.ok || !data?.booking) {
        const code = data?.error?.code;
        const failed = (data?.error?.details as { failedOccurrence?: number } | undefined)?.failedOccurrence;
        if (code === "SLOT_UNAVAILABLE" && failed) { setFormError(data?.error?.message ?? "One of the sessions in this series is not available. Please pick another start time."); return; }
        if (code === "SLOT_UNAVAILABLE") { await refreshAfterConflict("Sorry, that time was just taken. We refreshed the calendar - please pick another time."); return; }
        if (code === "ALREADY_BOOKED") { setFormError(data?.error?.message ?? "You are already registered for this session."); return; }
        if (code === "VALIDATION" && data?.error?.details && typeof data.error.details === "object") {
          const d = data.error.details as Record<string, string>;
          const mapped: Record<string, string> = {};
          for (const [k, v] of Object.entries(d)) {
            if (k.startsWith("invitee.")) mapped[k.slice(8)] = v;
            else if (/^[0-9a-f-]{36}$/.test(k)) mapped[`q:${k}`] = v;
            else if (k.startsWith("guests")) mapped["g:0"] = v;
            else mapped[k] = v;
          }
          setErrs(mapped);
        }
        setFormError(code === "RATE_LIMITED" ? (data?.error?.message ?? "Too many attempts. Please wait a moment.") : (data?.error?.message ?? "We could not complete your booking. Please try again."));
        return;
      }
      const b: Booked = { ...data.booking, manageToken: data.manageToken ?? null, series: data.series };
      setBooked(b);
      if (embed && window.parent !== window) {
        window.parent.postMessage({ source: "meetflow", type: "booked", eventSlug: event.slug, startsAt: b.startsAt }, "*");
      }
      setStep(data.requiresPayment && event.priceAmount ? "pay" : "done");
    } catch {
      setFormError("Network error. Please check your connection and try again.");
    } finally { setSubmitting(false); }
  }

  async function submitReschedule() {
    if (!selSlot || !rescheduleToken) return;
    setSubmitting(true); setFormError(null);
    try {
      const r = await fetch(`/api/public/manage/${encodeURIComponent(rescheduleToken)}/reschedule`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startsAt: selSlot, timeZone: tz }),
      });
      const data = (await r.json().catch(() => null)) as (ApiError & { manageToken?: string | null; booking?: { startsAt: string; endsAt: string; status: string } }) | null;
      if (!r.ok || !data?.booking) {
        if (data?.error?.code === "SLOT_UNAVAILABLE") { await refreshAfterConflict("Sorry, that time was just taken. Please pick another time."); return; }
        setFormError(data?.error?.message ?? "We could not reschedule. Please try again.");
        return;
      }
      setBooked({ ...data.booking, meetingUrl: null, manageToken: data.manageToken ?? rescheduleToken });
      onRescheduled?.(data.manageToken ?? null);
      setStep("done");
    } catch { setFormError("Network error. Please try again."); } finally { setSubmitting(false); }
  }

  // ───────── render
  if (step === "done" && booked) {
    return <Confirmation event={event} booked={booked} tz={tz} hour12={hour12} embed={embed} title={reschedule ? "Meeting rescheduled" : "You are scheduled"} />;
  }
  if (step === "pay" && booked?.manageToken && event.priceAmount && event.priceCurrency) {
    return (
      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        <PaymentStep manageToken={booked.manageToken} amount={event.priceAmount} currency={event.priceCurrency}
          onPaid={() => { setBooked({ ...booked, status: event.requiresConfirmation ? "pending_confirmation" : "confirmed" }); setStep("done"); }} />
      </div>
    );
  }

  const summary = (
    <aside style={{ display: "grid", gap: 10, alignContent: "start" }}>
      {step !== "pick" && (
        <button type="button" className="mf-btn mf-btn-ghost" style={{ width: 40, height: 40, padding: 0 }} onClick={() => { setStep("pick"); setFormError(null); }} aria-label="Back to calendar"><ArrowLeft size={18} /></button>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {event.host.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={event.host.image} alt="" width={44} height={44} style={{ borderRadius: 999, objectFit: "cover" }} referrerPolicy="no-referrer" />
        ) : (
          <div aria-hidden style={{ width: 44, height: 44, borderRadius: 999, background: "var(--mf-brand)", color: "var(--mf-brand-fg)", display: "grid", placeItems: "center", fontWeight: 700 }}>{event.host.name.slice(0, 1).toUpperCase()}</div>
        )}
        <div className="mf-muted" style={{ fontWeight: 600 }}>{event.host.name}</div>
      </div>
      {event.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={event.logoUrl} alt="" style={{ maxHeight: 32, maxWidth: 140, objectFit: "contain", objectPosition: "left" }} referrerPolicy="no-referrer" />
      )}
      <h1 style={{ fontSize: 24, lineHeight: 1.2, margin: "2px 0 0", fontWeight: 800, letterSpacing: "-.01em" }}>{reschedule ? `Reschedule: ${event.title}` : event.title}</h1>
      {event.headline && <p style={{ margin: 0, fontWeight: 600 }}>{event.headline}</p>}
      <div className="mf-muted" style={{ display: "grid", gap: 8, fontSize: 14 }}>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}><Clock size={16} aria-hidden /> {formatDuration(event.durationMinutes)}</span>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}><LocationIcon type={event.locationType} /> {event.locationAddress || LOCATION_LABELS[event.locationType] || "Online"}</span>
        {event.priceAmount && event.priceCurrency ? (
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}><Banknote size={16} aria-hidden /> {formatMoney(event.priceAmount, event.priceCurrency)}</span>
        ) : null}
        {event.kind === "group" && <span>Group session (up to {event.capacity} attendees)</span>}
        {event.recurrence && !reschedule && <span style={{ display: "flex", gap: 8, alignItems: "center" }} data-testid="series-summary"><RefreshCw size={16} aria-hidden /> {event.recurrence.count} {event.recurrence.interval === "week" ? "weekly" : "monthly"} sessions</span>}
        {event.requiresConfirmation && !reschedule && <span>The host approves each request</span>}
      </div>
      {selSlot && step !== "pick" && (
        <div style={{ fontWeight: 600, display: "grid", gap: 2, marginTop: 4 }}>
          <span>{formatRange(selSlot, DateTime.fromISO(selSlot).plus({ minutes: event.durationMinutes }).toUTC().toISO()!, tz, hour12)}</span>
          <span>{formatDateLong(selSlot, tz)}</span>
          <span className="mf-muted" style={{ fontWeight: 500, fontSize: 13 }}>{tz.replace(/_/g, " ")}</span>
        </div>
      )}
      {reschedule && currentStartsAt && step === "pick" && (
        <div className="mf-alert mf-alert-info" style={{ fontSize: 13 }}>Currently booked: <strong>{formatDateLong(currentStartsAt, tz)}, {formatTime(currentStartsAt, tz, hour12)}</strong></div>
      )}
      {event.description && step === "pick" && <p className="mf-muted" style={{ margin: "6px 0 0", fontSize: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{event.description}</p>}
      {event.cancellationPolicy && step === "pick" && (
        <details style={{ fontSize: 13 }}><summary className="mf-muted" style={{ cursor: "pointer" }}>Cancellation policy</summary><p className="mf-muted" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{event.cancellationPolicy}</p></details>
      )}
    </aside>
  );

  return (
    <div className={`mf-card`} style={{ display: "grid", gap: 0, overflow: "hidden" }}>
      <div className="mf-flow-grid" data-step={step}>
        <div className="mf-flow-side">{summary}</div>
        <div className="mf-flow-main">
          {banner && (
            <div className="mf-alert mf-alert-err mf-fade" role="alert" style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 14 }}>
              <AlertTriangle size={18} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} /><span style={{ flex: 1 }}>{banner}</span>
              <button type="button" onClick={() => setBanner(null)} aria-label="Dismiss" style={{ background: "none", border: 0, color: "inherit", cursor: "pointer" }}><X size={16} /></button>
            </div>
          )}

          {step === "pick" && (
            <div className="mf-pick">
              <div>
                <h2 style={{ margin: "0 0 14px", fontSize: 18 }}>Select a date &amp; time</h2>
                {month ? (
                  <Calendar month={month} tz={tz} available={available} selected={selDay} loading={loading}
                    canPrev={canPrev} canNext={canNext}
                    onPrev={() => { setMonth(month.minus({ months: 1 })); autoAdvanced.current = true; }}
                    onNext={() => { setMonth(month.plus({ months: 1 })); autoAdvanced.current = true; }}
                    onSelect={(k) => { setSelDay(k); setSelSlot(null); }} />
                ) : <div className="mf-skel" style={{ height: 300 }} aria-hidden />}
                {loadError && (
                  <div className="mf-alert mf-alert-err" role="alert" style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
                    <span>{loadError}</span>
                    <button type="button" className="mf-btn mf-btn-ghost" style={{ height: 34 }} onClick={() => month && fetchMonth(month, tz, true)}><RefreshCw size={14} aria-hidden /> Retry</button>
                  </div>
                )}
                {!loading && !loadError && month && monthSlots.length === 0 && (
                  <p className="mf-muted" style={{ fontSize: 14, marginTop: 12 }} role="status">No times available in {month.toFormat("LLLL")}. {canNext ? "Try the next month." : "Check back later."}</p>
                )}
                <div style={{ marginTop: 16, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
                  <TimezoneSelect value={tz} onChange={changeTz} />
                  <div role="group" aria-label="Time format" style={{ display: "inline-flex", gap: 4 }}>
                    <button type="button" className="mf-chip" aria-pressed={hour12} onClick={() => setH12(true)}>12h</button>
                    <button type="button" className="mf-chip" aria-pressed={!hour12} onClick={() => setH12(false)}>24h</button>
                  </div>
                </div>
              </div>
              <div className="mf-times" aria-live="polite">
                {selDay ? (
                  <>
                    <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700 }}>{DateTime.fromISO(selDay, { zone: tz }).toFormat("cccc, LLL d")}</h3>
                    <div className="mf-scroll" style={{ display: "grid", gap: 8, maxHeight: 380, overflowY: "auto", paddingRight: 4 }}>
                      {daySlots.map((s) => (
                        <div key={s} style={{ display: "grid", gridTemplateColumns: selSlot === s ? "1fr 1fr" : "1fr", gap: 8 }}>
                          <button type="button" className="mf-slot" aria-pressed={selSlot === s} onClick={() => setSelSlot(s)}>{formatTime(s, tz, hour12)}</button>
                          {selSlot === s && (
                            <button type="button" className="mf-btn" style={{ height: 46 }} onClick={() => setStep(reschedule ? "confirm" : "form")}>Next</button>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="mf-muted" style={{ fontSize: 14 }}>{available.size ? "Choose a highlighted day to see available times." : loading ? "Loading availability..." : ""}</p>
                )}
              </div>
            </div>
          )}

          {step === "confirm" && selSlot && (
            <div className="mf-fade" style={{ display: "grid", gap: 14, maxWidth: 460 }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>Confirm new time</h2>
              <p className="mf-muted" style={{ margin: 0 }}>Your meeting will move to <strong style={{ color: "var(--mf-text)" }}>{formatDateLong(selSlot, tz)}, {formatTime(selSlot, tz, hour12)}</strong> ({tz.replace(/_/g, " ")}).</p>
              {formError && <div className="mf-alert mf-alert-err" role="alert">{formError}</div>}
              <button type="button" className="mf-btn" onClick={submitReschedule} disabled={submitting} style={{ justifySelf: "start" }}>{submitting ? "Rescheduling..." : "Confirm reschedule"}</button>
            </div>
          )}

          {step === "form" && selSlot && (
            <form className="mf-fade" onSubmit={(e) => { e.preventDefault(); void submitBooking(); }} noValidate style={{ display: "grid", gap: 16, maxWidth: 520 }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>Enter your details</h2>
              {event.recurrence && <SeriesPreview eventTypeId={event.id} startsAt={selSlot} tz={tz} hour12={hour12} count={event.recurrence.count} interval={event.recurrence.interval} />}
              <Field label="Name" error={errs.name} required>
                <input className="mf-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} aria-invalid={!!errs.name} />
              </Field>
              <Field label="Email" error={errs.email} required>
                <input className="mf-input" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} aria-invalid={!!errs.email} />
              </Field>
              <Field label="Phone number (optional)" error={errs.phone}>
                <input className="mf-input" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" maxLength={40} />
              </Field>
              {event.questions.map((q) => (
                <QuestionField key={q.id} q={q} value={answers[q.id]} error={errs[`q:${q.id}`]} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} />
              ))}
              <div>
                {guests.length === 0 ? (
                  <button type="button" className="mf-chip" onClick={() => setGuests([""])}><Plus size={14} aria-hidden style={{ verticalAlign: "-2px" }} /> Add guests</button>
                ) : (
                  <div style={{ display: "grid", gap: 8 }}>
                    <span className="mf-label" style={{ marginBottom: 0 }}>Guests (optional)</span>
                    {guests.map((g, i) => (
                      <div key={i}>
                        <div style={{ display: "flex", gap: 6 }}>
                          <input className="mf-input" type="email" placeholder="guest@example.com" value={g} aria-label={`Guest ${i + 1} email`} aria-invalid={!!errs[`g:${i}`]}
                            onChange={(e) => setGuests((a) => a.map((x, j) => (j === i ? e.target.value : x)))} />
                          <button type="button" className="mf-btn mf-btn-ghost" style={{ width: 42, padding: 0 }} aria-label="Remove guest" onClick={() => setGuests((a) => a.filter((_, j) => j !== i))}><X size={16} /></button>
                        </div>
                        {errs[`g:${i}`] && <div className="mf-err">{errs[`g:${i}`]}</div>}
                      </div>
                    ))}
                    {guests.length < 10 && <button type="button" className="mf-chip" style={{ justifySelf: "start" }} onClick={() => setGuests((a) => [...a, ""])}><Plus size={14} aria-hidden style={{ verticalAlign: "-2px" }} /> Add another</button>}
                  </div>
                )}
              </div>
              <div>
                <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13.5, cursor: "pointer" }}>
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3, width: 16, height: 16, accentColor: "var(--mf-brand)" }} aria-invalid={!!errs.consent} />
                  <span className="mf-muted">Privacy notice: I agree that my name, email and answers are shared with {event.host.name} to arrange this meeting, and that I will receive booking emails. Your data is used only for this booking and is not sold.</span>
                </label>
                {errs.consent && <div className="mf-err">{errs.consent}</div>}
              </div>
              {formError && <div className="mf-alert mf-alert-err" role="alert">{formError}</div>}
              <button type="submit" className="mf-btn" disabled={submitting} style={{ justifySelf: "start", minWidth: 180 }}>
                {submitting ? "Scheduling..." : event.priceAmount && event.priceCurrency ? `Continue to payment (${formatMoney(event.priceAmount, event.priceCurrency)})` : event.recurrence ? `Schedule ${event.recurrence.count} sessions` : event.requiresConfirmation ? "Request booking" : "Schedule event"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, error, required, children }: { label: string; error?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="mf-label">{label}{required && <span style={{ color: "var(--mf-danger)" }} aria-hidden> *</span>}{children}</label>
      {error && <div className="mf-err" role="alert">{error}</div>}
    </div>
  );
}

function QuestionField({ q, value, error, onChange }: { q: PublicQuestion; value: string | string[] | undefined; error?: string; onChange: (v: string | string[]) => void }) {
  const opts = q.options ?? [];
  const str = typeof value === "string" ? value : "";
  const arr = Array.isArray(value) ? value : [];
  if (q.type === "radio" || q.type === "checkbox") {
    return (
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="mf-label">{q.label}{q.required && <span style={{ color: "var(--mf-danger)" }} aria-hidden> *</span>}</legend>
        <div style={{ display: "grid", gap: 8 }}>
          {opts.map((o) => (
            <label key={o} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, cursor: "pointer" }}>
              <input type={q.type === "radio" ? "radio" : "checkbox"} name={q.id} checked={q.type === "radio" ? str === o : arr.includes(o)} style={{ accentColor: "var(--mf-brand)" }}
                onChange={(e) => onChange(q.type === "radio" ? o : e.target.checked ? [...arr, o] : arr.filter((x) => x !== o))} />
              {o}
            </label>
          ))}
        </div>
        {error && <div className="mf-err" role="alert">{error}</div>}
      </fieldset>
    );
  }
  return (
    <Field label={q.label} error={error} required={q.required}>
      {q.type === "long_text" ? (
        <textarea className="mf-input" value={str} onChange={(e) => onChange(e.target.value)} maxLength={2000} aria-invalid={!!error} />
      ) : q.type === "dropdown" ? (
        <select className="mf-input" value={str} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error}>
          <option value="">Select...</option>
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input className="mf-input" type={q.type === "email" ? "email" : q.type === "phone" ? "tel" : "text"} value={str} onChange={(e) => onChange(e.target.value)} maxLength={500} aria-invalid={!!error} />
      )}
    </Field>
  );
}
