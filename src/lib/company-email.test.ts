import { describe, it, expect } from "vitest";
import { allowedEmailDomains, isCompanyEmail } from "./company-email";

describe("company email gate", () => {
  const d = allowedEmailDomains(" Acme.com, @acme.in ,");
  it("parses the domain list", () => expect(d).toEqual(["acme.com", "acme.in"]));
  it("allows only exact company domains", () => {
    expect(isCompanyEmail("Jane@ACME.com", d)).toBe(true);
    expect(isCompanyEmail("raj@acme.in", d)).toBe(true);
    for (const bad of ["x@evil-acme.com", "x@acme.com.evil.io", "x@sub.acme.com", "acme.com", "@acme.com", "x@gmail.com", "", null]) {
      expect(isCompanyEmail(bad, d)).toBe(false);
    }
  });
  it("fails closed when no domain is configured", () => expect(isCompanyEmail("jane@acme.com", allowedEmailDomains(""))).toBe(false));
});
