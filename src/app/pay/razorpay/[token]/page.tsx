import type { Metadata } from "next";
import { Suspense } from "react";
import { getRazorpayCheckoutView } from "@/server/payments/service";
import { razorpayKeyId } from "@/server/payments/razorpay";
import { RazorpayCheckout } from "./checkout";

export const metadata: Metadata = { title: "Complete payment", robots: { index: false } };

async function Body({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await getRazorpayCheckoutView(decodeURIComponent(token));
  if (!view || !razorpayKeyId()) {
    return (
      <main style={{ maxWidth: 480, margin: "15vh auto", padding: 24, textAlign: "center" }}>
        <h1>Nothing to pay</h1>
        <p>This payment link is no longer valid. If you already paid, your booking will be confirmed shortly.</p>
        <a href={`/booking/${encodeURIComponent(decodeURIComponent(token))}`}>Back to your booking</a>
      </main>
    );
  }
  return <RazorpayCheckout manageToken={decodeURIComponent(token)} keyId={razorpayKeyId()} {...view} />;
}

export default function Page({ params }: { params: Promise<{ token: string }> }) {
  return <Suspense fallback={<main style={{ padding: 24 }}>Loading...</main>}><Body params={params} /></Suspense>;
}
