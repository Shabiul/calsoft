import { describe, expect, it } from "vitest";
import { assertUrlAllowed, isPrivateAddress, safeLookup, SsrfError } from "./ssrf";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0",
    "100.64.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});
describe("assertUrlAllowed (production)", () => {
  const prod = { production: true };
  it.each([
    "http://example.com/hook", "https://localhost/x", "https://127.0.0.1/x", "https://foo.localhost/x", "https://[::1]/x",
    "https://169.254.169.254/latest/meta-data", "https://10.0.0.5/x", "https://2130706433/x", "https://0x7f.0.0.1/x",
    "ftp://example.com", "javascript:alert(1)", "https://user:pw@example.com/", "not a url", "https://db.internal/x",
  ])("rejects %s", (u) => expect(() => assertUrlAllowed(u, prod)).toThrow(SsrfError));
  it("accepts public https", () => expect(assertUrlAllowed("https://hooks.example.com/a?b=1", prod).hostname).toBe("hooks.example.com"));
});
describe("assertUrlAllowed (development)", () => {
  it("allows localhost http but still only http(s)", () => {
    expect(() => assertUrlAllowed("http://localhost:3999/x", { production: false })).not.toThrow();
    expect(() => assertUrlAllowed("file:///etc/passwd", { production: false })).toThrow(SsrfError);
  });
});
describe("safeLookup (DNS-rebinding guard)", () => {
  it("rejects hostnames resolving to loopback in production", async () => {
    const lookup = safeLookup(true) as unknown as (h: string, o: object, cb: (e: Error | null) => void) => void;
    const err = await new Promise<Error | null>((res) => lookup("localhost", {}, (e) => res(e)));
    expect(err).toBeInstanceOf(SsrfError);
  });
  it("allows loopback when not production", async () => {
    const lookup = safeLookup(false) as unknown as (h: string, o: object, cb: (e: Error | null) => void) => void;
    const err = await new Promise<Error | null>((res) => lookup("localhost", {}, (e) => res(e)));
    expect(err).toBeNull();
  });
});
