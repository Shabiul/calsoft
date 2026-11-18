import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt, sha256, randomToken, hmacSign, safeEqual } from "./crypto";

beforeAll(() => { process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64"); });

describe("crypto", () => {
  it("round-trips including unicode and empty", () => {
    for (const s of ["hello", "", "héllo 日本 🚀", "x".repeat(10000)]) expect(decrypt(encrypt(s))).toBe(s);
  });
  it("uses a fresh IV each time", () => { expect(encrypt("a")).not.toBe(encrypt("a")); });
  it("detects tampering", () => {
    const parts = encrypt("secret").split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow();
  });
  it("fails with wrong key", () => {
    const c = encrypt("secret");
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decrypt(c)).toThrow();
  });
  it("rejects bad key length / bad format", () => {
    const old = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = Buffer.from("short").toString("base64");
    expect(() => encrypt("x")).toThrow(/32 bytes/);
    process.env.ENCRYPTION_KEY = old;
    expect(() => decrypt("garbage")).toThrow();
  });
  it("sha256 known vector", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("randomToken unique & url-safe", () => {
    const a = randomToken(), b = randomToken();
    expect(a).not.toBe(b); expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("hmac / safeEqual", () => {
    expect(safeEqual(hmacSign("a", "p"), hmacSign("a", "p"))).toBe(true);
    expect(safeEqual(hmacSign("a", "p"), hmacSign("a", "q"))).toBe(false);
  });
});
