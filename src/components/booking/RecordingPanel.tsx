"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const CHUNK = 4_000_000; // keep each request under the 4.5 MB serverless body limit
const MAX_CHUNKS = 12;
const MAX_BYTES = CHUNK * MAX_CHUNKS;
const EXT_MIME: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", mp4: "video/mp4", webm: "audio/webm", ogg: "audio/ogg", flac: "audio/flac", mov: "video/quicktime" };

type Phase = "idle" | "recording" | "uploading" | "processing";

const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const mb = (n: number) => `${Math.round(n / 1_000_000)} MB`;

/**
 * Gemini-only notetaker: records the meeting audio in this browser (shared meeting tab + your microphone) or takes an uploaded
 * file, then the server has Gemini write the transcript, summary and action items and emails them to everyone.
 */
export function RecordingPanel({ token, status }: { token: string; status: string | null }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(status === "processing" ? "processing" : "idle");
  const [consent, setConsent] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<{ recorder: MediaRecorder; streams: MediaStream[]; ctx: AudioContext; chunks: Blob[]; bytes: number; timer: ReturnType<typeof setInterval> } | null>(null);

  // While the server is writing the notes, refresh the page every 10 s (up to ~30 min) so the result appears by itself.
  useEffect(() => {
    if (phase !== "processing") return;
    let n = 0;
    const t = setInterval(() => { if (++n > 180) clearInterval(t); else router.refresh(); }, 10_000);
    return () => clearInterval(t);
  }, [phase, router]);
  useEffect(() => { if (status === "done" || status === "failed" || status === "no_speech") setPhase("idle"); }, [status]);

  useEffect(() => {
    if (phase !== "recording") return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  async function upload(blob: Blob, mime: string) {
    setError(null);
    if (blob.size < 20_000) { setError("The recording is empty or far too short. Make sure the meeting tab's audio was shared (or your microphone is on) and record the whole meeting."); setPhase("idle"); return; }
    const parts = Math.ceil(blob.size / CHUNK);
    if (parts > MAX_CHUNKS) { setError(`That recording is too large (${mb(blob.size)}; the limit is ${mb(MAX_BYTES)}). Export the audio only, or record in parts.`); setPhase("idle"); return; }
    setPhase("uploading"); setProgress(0);
    const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
    try {
      for (let i = 0; i < parts; i++) {
        const r = await fetch(`/api/public/notes/${encodeURIComponent(token)}/audio?upload=${id}&index=${i}`, {
          method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: blob.slice(i * CHUNK, (i + 1) * CHUNK),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? "Upload failed");
        setProgress(Math.round(((i + 1) / parts) * 100));
      }
      const done = await fetch(`/api/public/notes/${encodeURIComponent(token)}/audio/complete`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ upload: id, chunks: parts, mime, consent: true }),
      });
      if (!done.ok) throw new Error((await done.json().catch(() => null))?.error?.message ?? "Could not start the notes");
      setPhase("processing");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed. Please try again.");
      setPhase("idle");
    }
  }

  async function start() {
    setError(null);
    if (!consent) { setError("Please confirm that everyone in the meeting knows it is being recorded."); return; }
    if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === "undefined") {
      setError("Recording needs Chrome, Edge or Firefox on a computer. You can upload a recording file instead."); return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (!display.getAudioTracks().length) {
        display.getTracks().forEach((t) => t.stop());
        setError("No audio was shared. Choose the meeting tab and tick \"Also share tab audio\" in the picker."); return;
      }
      const streams: MediaStream[] = [display];
      try { streams.push(await navigator.mediaDevices.getUserMedia({ audio: true })); } catch { /* microphone is optional */ }
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      for (const s of streams) if (s.getAudioTracks().length) ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest);
      const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
      const recorder = new MediaRecorder(dest.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
      const chunks: Blob[] = [];
      const state = { recorder, streams, ctx, chunks, bytes: 0, timer: setInterval(() => setSeconds((s) => s + 1), 1000) };
      recorder.ondataavailable = (e) => {
        if (!e.data.size) return;
        chunks.push(e.data); state.bytes += e.data.size;
        if (state.bytes > MAX_BYTES - 2_000_000 && recorder.state === "recording") recorder.stop(); // stay under the upload limit
      };
      recorder.onstop = () => {
        clearInterval(state.timer);
        streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
        void ctx.close();
        rec.current = null;
        void upload(new Blob(chunks, { type: "audio/webm" }), "audio/webm");
      };
      display.getTracks().forEach((t) => t.addEventListener("ended", () => { if (recorder.state === "recording") recorder.stop(); }));
      rec.current = state; setSeconds(0); setPhase("recording");
      recorder.start(10_000);
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError");
      setError(denied ? "Screen sharing was cancelled, so nothing is being recorded." : "Could not start recording in this browser.");
    }
  }

  function stop() { if (rec.current?.recorder.state === "recording") rec.current.recorder.stop(); }

  function onFile(f: File | undefined) {
    if (!f) return;
    if (!consent) { setError("Please confirm that everyone in the meeting knows it is being recorded."); return; }
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    const mime = f.type || EXT_MIME[ext] || "";
    if (!mime) { setError("Unknown file type. Use MP3, WAV, M4A, MP4, WebM, OGG or FLAC."); return; }
    void upload(f, mime);
  }

  return (
    <section style={{ display: "grid", gap: 10 }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>AI notes from the meeting audio</h2>
      {phase === "idle" && (
        <>
          <p className="mf-muted" style={{ margin: 0, fontSize: 14 }}>
            Record this meeting from your browser, or upload a recording. Gemini writes the transcript, a summary and action items, and everyone gets them by email.
          </p>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14 }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
            <span>Everyone in the meeting knows it is being recorded.</span>
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <button type="button" className="mf-btn" onClick={start}>Record this meeting</button>
            <label className="mf-btn mf-btn-ghost" style={{ cursor: "pointer" }}>
              Upload a recording
              <input type="file" accept="audio/*,video/*,.mp3,.m4a,.wav,.mp4,.webm,.ogg,.flac,.mov" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
          </div>
          <p className="mf-muted" style={{ margin: 0, fontSize: 12 }}>
            To record: click Record, pick the Google Meet tab, and tick &quot;Also share tab audio&quot;. Your microphone is mixed in. Keep this page open until you stop.
            Files up to {mb(MAX_BYTES)}.
          </p>
        </>
      )}
      {phase === "recording" && (
        <div className="mf-alert mf-alert-info" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
          <span role="status"><strong style={{ color: "#dc2626" }}>● Recording</strong> {clock(seconds)}. Keep this tab open.</span>
          <button type="button" className="mf-btn" onClick={stop}>Stop and create notes</button>
        </div>
      )}
      {phase === "uploading" && <p role="status" className="mf-alert mf-alert-info" style={{ margin: 0 }}>Uploading the recording... {progress}%</p>}
      {phase === "processing" && (
        <p role="status" className="mf-alert mf-alert-info" style={{ margin: 0 }}>
          Writing the notes from the recording. This takes a few minutes, and everyone will get the notes by email. You can close this page.
        </p>
      )}
      {status === "no_speech" && phase === "idle" && (
        <p role="status" className="mf-alert mf-alert-err" style={{ margin: 0 }}>
          No speech was detected in the last recording, so no notes were created and nobody was emailed. Check that the meeting tab&apos;s audio was shared (or your microphone is on), then try again.
        </p>
      )}
      {status === "failed" && phase === "idle" && <p className="mf-alert mf-alert-err" style={{ margin: 0 }}>The notes could not be created from the last recording. Please try again.</p>}
      {error && <p role="alert" className="mf-alert mf-alert-err" style={{ margin: 0 }}>{error}</p>}
    </section>
  );
}
