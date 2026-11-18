import { NextResponse } from "next/server";
import { isAppError } from "@/server/errors";
import { ProviderError } from "./http";

/** Map service errors to JSON responses without leaking internals. */
export function errorResponse(e: unknown): NextResponse {
  if (isAppError(e)) return NextResponse.json(e.toJSON(), { status: e.status });
  if (e instanceof ProviderError) {
    const status = e.kind === "not_found" ? 404 : e.kind === "auth" ? 409 : e.status >= 400 && e.status < 500 ? e.status : 502;
    return NextResponse.json({ error: { code: `PROVIDER_${e.kind.toUpperCase()}`, message: e.message } }, { status });
  }
  console.error("[integrations] unexpected error", e);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong" } }, { status: 500 });
}
