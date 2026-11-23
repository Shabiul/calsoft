import { describe, expect, it } from "vitest";
import { geminiMime, geminiMimes } from "./index";
import { isUploadId, MAX_CHUNK_BYTES, MAX_CHUNKS, storeChunk } from "./audio";

describe("geminiMime", () => {
  it("maps browser/phone recordings onto the types Gemini accepts", () => {
    expect(geminiMime("audio/webm;codecs=opus")).toBe("audio/webm"); // audio-only WebM is rejected when labelled video/webm
    expect(geminiMimes("video/webm")).toEqual(["audio/webm", "video/webm"]); // real video files fall back to video/webm
    expect(geminiMime("audio/mp4")).toBe("video/mp4");
    expect(geminiMime("audio/x-m4a")).toBe("video/mp4");
    expect(geminiMime("video/quicktime")).toBe("video/mov");
    expect(geminiMime("audio/mpeg")).toBe("audio/mp3");
    expect(geminiMime("audio/x-wav")).toBe("audio/wav");
    expect(geminiMime("audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(geminiMime("audio/flac")).toBe("audio/flac");
  });
  it("rejects types it cannot read", () => {
    expect(geminiMime("application/pdf")).toBeNull();
    expect(geminiMime("image/png")).toBeNull();
    expect(geminiMime("")).toBeNull();
  });
});

describe("recording upload validation", () => {
  it("accepts only safe upload ids", () => {
    expect(isUploadId("abc123XYZ_-9")).toBe(true);
    expect(isUploadId("short")).toBe(false);
    expect(isUploadId("has space in it")).toBe(false);
    expect(isUploadId("../../etc/passwd")).toBe(false);
  });
  it("rejects bad chunk indexes, empty and oversized chunks before touching Redis", async () => {
    const id = "abcdefgh12345678";
    await expect(storeChunk("b", id, -1, Buffer.from("x"))).rejects.toMatchObject({ status: 422 });
    await expect(storeChunk("b", id, MAX_CHUNKS, Buffer.from("x"))).rejects.toMatchObject({ status: 422 });
    await expect(storeChunk("b", "bad id", 0, Buffer.from("x"))).rejects.toMatchObject({ status: 422 });
    await expect(storeChunk("b", id, 0, Buffer.alloc(0))).rejects.toMatchObject({ status: 413 });
    await expect(storeChunk("b", id, 0, Buffer.alloc(MAX_CHUNK_BYTES + 1))).rejects.toMatchObject({ status: 413 });
  });
});

import { MIN_SPOKEN_WORDS, spokenWords } from "./index";

describe("spokenWords (no-speech guard)", () => {
  it("is zero for silence, noise tags and empty transcripts", () => {
    for (const t of ["", "   ", "[silence]", "Speaker 1: [silence]", "Speaker 1: (inaudible)", "[00:03] Speaker: [music]", "Speaker 1: ...", "Speaker 1: -- -- --"]) {
      expect(spokenWords(t)).toBeLessThan(MIN_SPOKEN_WORDS);
    }
  });
  it("does not count timestamps or speaker labels as words", () => {
    expect(spokenWords("[01:05] Jane: Hello there.\n[00:03] Speaker: Hi all.")).toBe(4);
  });
  it("treats a few stray words as not a meeting", () => {
    expect(spokenWords("Speaker 1: Hello, testing one two.")).toBeLessThan(MIN_SPOKEN_WORDS);
  });
  it("counts real conversation, in any language", () => {
    expect(spokenWords("Alice: Hi Bob, are you ready to review the new design today?\nBob: Yes, let us start.")).toBeGreaterThanOrEqual(MIN_SPOKEN_WORDS);
    expect(spokenWords("Speaker 1: नमस्ते सबको, आज हम नई योजना पर चर्चा करेंगे और अगले हफ्ते का काम बांटेंगे।")).toBeGreaterThanOrEqual(MIN_SPOKEN_WORDS);
  });
});
