"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

interface RzpResponse { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }
interface RzpInstance { open(): void; on(ev: string, cb: (r: unknown) => void): void }
declare global { interface Window { Razorpay?: new (o: Record<string, unknown>) => RzpInstance } }

export function RazorpayCheckout(p: { manageToken: string; keyId: string; orderId: string; amount: number; currency: string; title: string; email: string; name: string }) {
  const [state, setState] = useState<"idle" | "verifying" | "error">("idle");
  const [msg, setMsg] = useState("");
  const opened = useRef(false);
  const router = useRouter();
  const back = `/booking/${encodeURIComponent(p.manageToken)}`;

  const open = useCallback(() => {
    if (!window.Razorpay) { setState("error"); setMsg("Could not load the Razorpay checkout. Check your connection and retry."); return; }
    const rz = new window.Razorpay({
      key: p.keyId, order_id: p.orderId, amount: p.amount, currency: p.currency, name: p.title, prefill: { email: p.email, name: p.name },
      handler: async (r: RzpResponse) => {
        setState("verifying");
        try {
          const res = await fetch("/api/public/payments/razorpay/verify", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manageToken: p.manageToken, ...r }),
          });
          if (!res.ok) throw new Error("verify failed");
          router.push(`${back}?payment=success`);
        } catch {
          setState("error"); setMsg("We could not confirm your payment yet. If you were charged, your booking will be confirmed automatically within a few minutes.");
        }
      },
      modal: { ondismiss: () => setState("idle") },
    });
    rz.open();
  }, [p, back, router]);

  useEffect(() => {
    if (opened.current) return;
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js"; s.async = true;
    s.onload = () => { if (!opened.current) { opened.current = true; open(); } };
    s.onerror = () => { setState("error"); setMsg("Could not load the Razorpay checkout."); };
    document.body.appendChild(s);
    return () => { s.remove(); };
  }, [open]);

  return (
    <main style={{ maxWidth: 480, margin: "15vh auto", padding: 24, textAlign: "center" }}>
      <h1>{p.title}</h1>
      <p>{state === "verifying" ? "Confirming your payment..." : "Complete your payment in the Razorpay window."}</p>
      {state === "error" && <p role="alert">{msg}</p>}
      <p><button type="button" onClick={open} disabled={state === "verifying"}>Open payment window</button></p>
      <p><a href={back}>Back to your booking</a></p>
    </main>
  );
}
