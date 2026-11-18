import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeSignature, signPayload, verifySignature } from "./signing";

const body = JSON.stringify({ a: 1 });
describe("webhook signing", () => {
  it("round-trips", () => {
    const s = signPayload("whsec_x", body, 1_700_000_000);
    expect(s.headers["MeetFlow-Timestamp"]).toBe("1700000000");
    expect(verifySignature("whsec_x", body, s.signature, { nowSeconds: 1_700_000_010 })).toBe(true);
  });
  it("is HMAC-SHA256 over timestamp.body", () => {
    expect(computeSignature("k", 1, "b")).toBe(createHmac("sha256", "k").update("1.b").digest("hex"));
  });
  it("rejects wrong secret, tampered body, stale timestamp, garbage", () => {
    const s = signPayload("whsec_x", body, 1000);
    expect(verifySignature("other", body, s.signature, { nowSeconds: 1000 })).toBe(false);
    expect(verifySignature("whsec_x", body + " ", s.signature, { nowSeconds: 1000 })).toBe(false);
    expect(verifySignature("whsec_x", body, s.signature, { nowSeconds: 1000 + 301 })).toBe(false);
    expect(verifySignature("whsec_x", body, s.signature, { nowSeconds: 1000 + 299 })).toBe(true);
    expect(verifySignature("whsec_x", body, "nonsense", { nowSeconds: 1000 })).toBe(false);
    expect(verifySignature("whsec_x", body, "t=1000,v1=zz", { nowSeconds: 1000 })).toBe(false);
  });
  it("timestamp is bound into the signature", () => {
    const s = signPayload("k", body, 1000);
    const forged = s.signature.replace("t=1000", "t=1001");
    expect(verifySignature("k", body, forged, { nowSeconds: 1001 })).toBe(false);
  });
});
