"use client";

/**
 * ISOLATED payment step. Owned contract with the payments agent (later):
 *   POST /api/public/payments/session  { manageToken }
 *     -> 200 { status: "paid" }                      booking already settled (e.g. free after coupon)
 *     -> 200 { checkoutUrl: "https://..." }          hosted checkout; we redirect the invitee
 *     -> 404 / network error / anything else         treated as "payments not configured"
 * Nothing else in the booking flow depends on payments internals.
 */
import { useState } from "react";
import { CreditCard } from "lucide-react";
import { formatMoney, isHttpUrl } from "./format";

export function PaymentStep({
  manageToken, amount, currency, onPaid,
}: { manageToken: string; amount: number; currency: string; onPaid: () => void }) {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"idle" | "unconfigured" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function pay() {
    setBusy(true); setState("idle"); setMsg("");
    try {
      const r = await fetch("/api/public/payments/session", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manageToken }),
      });
      if (r.status === 404 || r.status === 405 || r.status === 501) { setState("unconfigured"); return; }
      const data = (await r.json().catch(() => null)) as { status?: string; checkoutUrl?: string; error?: { message?: string } } | null;
      if (!r.ok || !data) { setState(data?.error ? "error" : "unconfigured"); setMsg(data?.error?.message ?? ""); return; }
      if (data.status === "paid") { onPaid(); return; }
      if (isHttpUrl(data.checkoutUrl)) { window.location.assign(data.checkoutUrl); return; }
      setState("unconfigured");
    } catch {
      setState("error"); setMsg("Could not reach the payment service. Please try again.");
    } finally { setBusy(false); }
  }

  return (
    <div className="mf-fade" style={{ display: "grid", gap: 14 }}>
      <h2 style={{ margin: 0, fontSize: 20 }}>Complete payment</h2>
      <p className="mf-muted" style={{ margin: 0 }}>
        Your time slot is reserved. Pay <strong style={{ color: "var(--mf-text)" }}>{formatMoney(amount, currency)}</strong> to confirm the booking.
      </p>
      {state === "unconfigured" && (
        <div className="mf-alert mf-alert-info" role="status">
          Payments are not configured for this host yet, so we could not start checkout. Your booking stays reserved &mdash; please contact the host to arrange payment.
        </div>
      )}
      {state === "error" && <div className="mf-alert mf-alert-err" role="alert">{msg || "Payment could not be started."}</div>}
      <button type="button" className="mf-btn" onClick={pay} disabled={busy} style={{ justifySelf: "start" }}>
        <CreditCard size={16} aria-hidden /> {busy ? "Starting checkout..." : `Pay ${formatMoney(amount, currency)}`}
      </button>
    </div>
  );
}
