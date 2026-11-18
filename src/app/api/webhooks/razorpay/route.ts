import { handleWebhookRequest } from "@/server/payments/webhook";

// Signature is verified over the raw request body inside handleWebhookRequest. Never add body parsing here.
export async function POST(req: Request) {
  return handleWebhookRequest("razorpay", req);
}
