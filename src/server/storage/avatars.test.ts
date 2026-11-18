import { describe, expect, it } from "vitest";
import { MAX_AVATAR_BYTES, isSafeAvatarName, sniffImage, validateAvatar } from "./avatars";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("avatar validation", () => {
  it("sniffs real image signatures", () => {
    expect(sniffImage(png)?.ext).toBe("png");
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0]))?.ext).toBe("jpg");
  });
  it("rejects non-images and empty/oversized files", () => {
    expect(() => validateAvatar(new TextEncoder().encode("<svg onload=alert(1)>"))).toThrow(/PNG, JPEG/);
    expect(() => validateAvatar(new Uint8Array())).toThrow(/empty/);
    const big = new Uint8Array(MAX_AVATAR_BYTES + 1);
    big.set(png);
    expect(() => validateAvatar(big)).toThrow(/2 MB/);
  });
  it("blocks path traversal in file names", () => {
    expect(isSafeAvatarName("abc-123.png")).toBe(true);
    expect(isSafeAvatarName("../../etc/passwd")).toBe(false);
    expect(isSafeAvatarName("a.svg")).toBe(false);
  });
});
