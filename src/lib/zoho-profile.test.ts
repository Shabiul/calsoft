import { describe, expect, it } from "vitest";
import { zohoProfileToUser } from "./zoho-profile";

const domains = ["acme.com", "acme.in"];
const p = (Email: string, extra = {}) => ({ ZUID: 123456, Email, Display_Name: "Jane Doe", ...extra });

describe("zohoProfileToUser (Zoho sign-in is company-only)", () => {
  it("accepts a company address and uses the immutable ZUID as the account id", () => {
    expect(zohoProfileToUser(p("Jane@ACME.com"), domains)).toEqual({ id: "123456", email: "jane@acme.com", name: "Jane Doe", emailVerified: true });
  });
  it("refuses personal and look-alike domains before any account is created", () => {
    for (const bad of ["jane@gmail.com", "jane@evil-acme.com", "jane@acme.com.evil.io", "jane@sub.acme.com"]) expect(zohoProfileToUser(p(bad), domains), bad).toBeNull();
  });
  it("refuses everyone when no company domain is configured (fails closed)", () => {
    expect(zohoProfileToUser(p("jane@acme.com"), [])).toBeNull();
  });
  it("refuses profiles without an id or an email", () => {
    expect(zohoProfileToUser({ Email: "jane@acme.com" }, domains)).toBeNull();
    expect(zohoProfileToUser({ ZUID: 1 }, domains)).toBeNull();
  });
  it("builds a name from first/last, then from the email", () => {
    expect(zohoProfileToUser({ ZUID: 1, Email: "a@acme.com", First_Name: "Ann", Last_Name: "Lee" }, domains)!.name).toBe("Ann Lee");
    expect(zohoProfileToUser({ ZUID: 1, Email: "ann.lee@acme.com" }, domains)!.name).toBe("ann.lee");
  });
});
