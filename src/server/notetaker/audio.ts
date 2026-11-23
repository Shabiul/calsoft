/**
 * Notes from a meeting recording, using only Gemini (no bot).
 *  1. The notes page records the meeting audio in the browser (or the host picks a file) and uploads it in <= 4 MB chunks
 *     (Vercel request bodies are capped at 4.5 MB). Chunks wait in Redis for a few hours.
 *  2. `finishUpload` queues a job; the worker joins the chunks, has Gemini transcribe and summarize the audio, saves the
 *     result and emails the host the notes and their own action items (same emails as the Recall bot path).
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getConnection } from "@/server/queue";
import { AppError } from "@/server/errors";
import { geminiMime, notifyNotesReady, setNoteStatus, summarize, saveRecordingNotes } from "./index";

const { bookings, invitees, users, eventTypes } = schema;

export const NOTES_AUDIO_JOB = "notes-audio";
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_CHUNKS = 12; // ~48 MB: hours of Opus audio, or a short screen recording
export const MIN_AUDIO_BYTES = 20_000; // ~5 s of 32 kbps Opus: anything smaller cannot hold a meeting
const TTL_SECONDS = 6 * 3600;

export const audioNotesConfigured = () => !!process.env.GEMINI_API_KEY;
export const isUploadId = (s: string) => /^[A-Za-z0-9_-]{8,40}$/.test(s);
const key = (bookingId: string, uploadId: string, i: number) => `meetflow:rec:${bookingId}:${uploadId}:${i}`;

export async function storeChunk(bookingId: string, uploadId: string, index: number, data: Buffer): Promise<void> {
  if (!isUploadId(uploadId) || !Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) throw new AppError("VALIDATION", "Invalid chunk.", 422);
  if (data.length === 0 || data.length > MAX_CHUNK_BYTES) throw new AppError("VALIDATION", "Chunk is empty or too large.", 413);
  await getConnection().set(key(bookingId, uploadId, index), data, "EX", TTL_SECONDS);
}

export interface AudioJob { bookingId: string; uploadId: string; chunks: number; mime: string }

/** Verifies every chunk arrived, marks the notes "processing" and queues the transcription job. */
export async function finishUpload(job: AudioJob): Promise<void> {
  if (!isUploadId(job.uploadId) || !Number.isInteger(job.chunks) || job.chunks < 1 || job.chunks > MAX_CHUNKS) throw new AppError("VALIDATION", "Invalid upload.", 422);
  if (!geminiMime(job.mime)) throw new AppError("VALIDATION", "That file type is not supported. Use MP3, WAV, M4A, MP4, WebM, OGG or FLAC.", 415);
  const redis = getConnection();
  let total = 0;
  for (let i = 0; i < job.chunks; i++) {
    const n = await redis.strlen(key(job.bookingId, job.uploadId, i));
    if (!n) throw new AppError("VALIDATION", "Part of the recording did not arrive. Please try again.", 422);
    total += n;
  }
  if (total < MIN_AUDIO_BYTES) {
    for (let i = 0; i < job.chunks; i++) await redis.del(key(job.bookingId, job.uploadId, i));
    throw new AppError("VALIDATION", "That recording is too short to contain a meeting. Record the whole meeting and try again.", 422);
  }
  await setNoteStatus(job.bookingId, "processing");
  const { enqueue, QUEUES } = await import("@/server/queue");
  await enqueue(QUEUES.notifications, { name: NOTES_AUDIO_JOB, data: job }, {
    attempts: 3, backoff: { type: "exponential", delay: 60_000 }, jobId: `nta-${job.uploadId}`,
  });
}

/** Worker entry. Throws (=> retry) when Gemini fails; the final attempt marks the notes as failed. */
export async function processAudioNotes(job: AudioJob, opts: { isFinal?: boolean } = {}): Promise<string> {
  const redis = getConnection();
  const parts: Buffer[] = [];
  for (let i = 0; i < job.chunks; i++) {
    const b = await redis.getBuffer(key(job.bookingId, job.uploadId, i));
    if (!b) { await setNoteStatus(job.bookingId, "failed"); return "recording expired"; }
    parts.push(b);
  }
  const blob = new Blob([Buffer.concat(parts)], { type: geminiMime(job.mime) ?? job.mime });

  const [b] = await db.select({ title: eventTypes.title, hostName: users.name, hostEmail: users.email, context: bookings.hostNotes }).from(bookings)
    .innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId)).innerJoin(users, eq(users.id, bookings.hostUserId))
    .where(eq(bookings.id, job.bookingId)).limit(1);
  if (!b) return "booking not found";
  const inv = await db.select({ name: invitees.name, email: invitees.email }).from(invitees)
    .where(and(eq(invitees.bookingId, job.bookingId), isNull(invitees.cancelledAt))).orderBy(asc(invitees.createdAt));
  const people = [{ name: b.hostName, email: b.hostEmail }, ...inv];

  const ai = await summarize({ transcript: "", title: b.title, people, audioBlob: blob, audioMime: job.mime, wantTranscript: true, context: b.context });
  if (!ai) {
    if (!opts.isFinal) throw new Error("Gemini could not produce notes yet");
    await setNoteStatus(job.bookingId, "failed");
    return "failed";
  }
  const cleanup = async () => { for (let i = 0; i < job.chunks; i++) await redis.del(key(job.bookingId, job.uploadId, i)); };
  if (!ai.speechDetected) {
    // Silence, a wrong tab or no microphone: say so on the notes page. No notes are written and nobody is emailed.
    await setNoteStatus(job.bookingId, "no_speech");
    await cleanup();
    return "no speech";
  }
  await saveRecordingNotes(job.bookingId, { transcript: ai.transcript, summary: ai.summary, actionItems: ai.actionItems });
  await notifyNotesReady(job.bookingId, ai.summary, ai.actionItems, job.uploadId);
  await cleanup();
  return "done";
}
