import { describe, expect, it } from "vitest";
import { describeDevice, providerFromContext } from "./sign-in-info";

describe("describeDevice", () => {
  it("summarises common browsers and systems", () => {
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Edge on Windows");
    expect(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15")).toBe("Safari on macOS");
    expect(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(describeDevice("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0")).toBe("Firefox on Linux");
  });
  it("handles missing or odd user agents", () => {
    expect(describeDevice(null)).toBe("Unknown device");
    expect(describeDevice("")).toBe("Unknown device");
    expect(describeDevice("curl/8.0")).toBe("Browser");
  });
});

describe("providerFromContext", () => {
  it("reads the provider from the OAuth callback params or path", () => {
    expect(providerFromContext({ params: { id: "Google" } })).toBe("google");
    expect(providerFromContext({ params: { providerId: "zoho" } })).toBe("zoho");
    expect(providerFromContext({ path: "/oauth2/callback/zoho" })).toBe("zoho");
    expect(providerFromContext({ path: "/callback/google" })).toBe("google");
  });
  it("falls back to unknown", () => {
    expect(providerFromContext(null)).toBe("unknown");
    expect(providerFromContext({ path: "/sign-in/email" })).toBe("unknown");
  });
  it("names the Supabase sign-in methods from the endpoint used", () => {
    expect(providerFromContext({ path: "/supabase/verify" })).toBe("supabase_code");
    expect(providerFromContext({ path: "/supabase/password" })).toBe("supabase_password");
    expect(providerFromContext({ path: "/supabase/exchange" })).toBe("supabase_link");
  });
});
