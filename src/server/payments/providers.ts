import { razorpayProvider } from "./razorpay";
import { stripeProvider } from "./stripe";
import type { PaymentProvider, ProviderName } from "./types";

export const providers: Record<ProviderName, PaymentProvider> = { razorpay: razorpayProvider, stripe: stripeProvider };
export const getProvider = (n: ProviderName) => providers[n];
export const configuredProviders = (): ProviderName[] => (Object.keys(providers) as ProviderName[]).filter((k) => providers[k].isConfigured());

/** Event type's explicit provider wins; otherwise INR -> razorpay, everything else -> stripe, falling back to any configured one. */
export function pickProvider(preferred: string | null | undefined, currency: string): PaymentProvider | null {
  if (preferred === "razorpay" || preferred === "stripe") return providers[preferred].isConfigured() ? providers[preferred] : null;
  const order: ProviderName[] = currency.toUpperCase() === "INR" ? ["razorpay", "stripe"] : ["stripe", "razorpay"];
  return order.map((n) => providers[n]).find((p) => p.isConfigured()) ?? null;
}
