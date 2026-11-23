/**
 * Meeting notes + notetaker bot.
 *  - Every booking has a shared notes page /notes/<token> (anyone with the link can read and edit, like a shared doc).
 *  - Event types with notetakerEnabled get a Recall.ai bot (scheduled by booking-sync once the meeting link exists). It posts a
 *    recording notice in the chat, records audio + video, attendance and chat. After the meeting a delayed job asks Recall for an
 *    accurate post-meeting transcript, has Gemini write the notes (listening to the audio too), and emails everyone the notes and
 *    each person their own action items. Recall deletes the recordings after NOTETAKER_RETENTION_DAYS.
 * Env: RECALL_API_KEY (+ RECALL_REGION, default us-west-2) enables the bot; GEMINI_API_KEY (+ optional GEMINI_MODEL) enables the
 *      summary; NOTETAKER_RETENTION_DAYS (default 30) sets how long recordings are kept.
 */
import { GoogleGenAI, createPartFromUri, type Part } from "@google/genai";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { ProviderError } from "@/server/integrations/http";

const { meetingNotes, bookings, invitees, users, eventTypes } = schema;
const appName = () => process.env.APP_NAME ?? "MeetFlow";
export const retentionDays = () => Math.max(1, Number(process.env.NOTETAKER_RETENTION_DAYS ?? 30) || 30);

// ───────── share token: "<bookingId>.<hmac>" (stateless; rotating BETTER_AUTH_SECRET invalidates old links)
const sign = (bookingId: string, key: string) => createHmac("sha256", key).update(`notes:${bookingId}`).digest("base64url").slice(0, 22);

export function notesToken(bookingId: string): string | null {
  const key = process.env.BETTER_AUTH_SECRET;
  return key ? `${bookingId}.${sign(bookingId, key)}` : null;
}
export function notesUrl(bookingId: string): string {
  const t = notesToken(bookingId);
  return t ? `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/notes/${t}` : "";
}
/** Returns the booking id for a valid token, else null. */
export function verifyNotesToken(token: string): string | null {
  const key = process.env.BETTER_AUTH_SECRET;
  const [id, sig] = token.split(".");
  if (!key || !id || !sig || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const want = Buffer.from(sign(id, key)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}

// ───────── notes storage
type NoteRow = typeof meetingNotes.$inferSelect;
export async function getNotes(bookingId: string): Promise<Omit<NoteRow, "updatedAt"> & { updatedAt: Date | null }> {
  const [n] = await db.select().from(meetingNotes).where(eq(meetingNotes.bookingId, bookingId)).limit(1);
  return n ?? { bookingId, content: "", transcript: null, summary: null, botStatus: null, botId: null, attendance: null, chat: null, actionItems: null, recordingExpiresAt: null, updatedAt: null };
}
/** System fields only: updatedAt tracks edits to the shared notes (the editor's conflict check), so it is left alone here. */
async function upsertNotes(bookingId: string, set: Partial<typeof meetingNotes.$inferInsert>) {
  await db.insert(meetingNotes).values({ bookingId, ...set }).onConflictDoUpdate({ target: meetingNotes.bookingId, set });
}
export const markBotScheduled = (bookingId: string, botId: string) => upsertNotes(bookingId, { botStatus: "scheduled", botId });

/** Saves the shared notes. Optimistic check: fails (returns the latest) if someone saved since `baseUpdatedAt`. */
export async function saveNotes(bookingId: string, content: string, baseUpdatedAt: string | null) {
  const cur = await getNotes(bookingId);
  const curAt = cur.updatedAt ? cur.updatedAt.toISOString() : null;
  if (curAt && baseUpdatedAt !== curAt) return { ok: false as const, latest: { content: cur.content, updatedAt: curAt } };
  const now = new Date();
  await db.insert(meetingNotes).values({ bookingId, content, updatedAt: now })
    .onConflictDoUpdate({ target: meetingNotes.bookingId, set: { content, updatedAt: now } });
  return { ok: true as const, updatedAt: now.toISOString() };
}

// ───────── Recall.ai bot
export const notetakerConfigured = () => !!process.env.RECALL_API_KEY;

async function recall<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  const r = await fetch(`https://${process.env.RECALL_REGION ?? "us-west-2"}.recall.ai/api/v1${path}`, {
    method, signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Token ${process.env.RECALL_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  const text = await r.text();
  if (!r.ok) {
    const kind = r.status === 404 ? "not_found" : r.status === 429 ? "rate_limit" : r.status >= 500 ? "transient" : "other"; // 507 = no warm bot: retry
    throw new ProviderError(`Recall ${method} ${path} failed (${r.status}): ${text.slice(0, 300)}`, kind, r.status);
  }
  return text ? (JSON.parse(text) as T) : null;
}

/** Schedules a bot for the meeting. Bots more than 10 min ahead are "scheduled" (guaranteed); closer ones join right away. */
export async function createBot(bookingId: string, meetingUrl: string, startsAt: Date): Promise<string> {
  const joinAt = new Date(startsAt.getTime() - 60_000);
  const bot = await recall<{ id: string }>("POST", "/bot/", {
    meeting_url: meetingUrl,
    bot_name: `${appName()} Notetaker`,
    ...(joinAt.getTime() - Date.now() > 10 * 60_000 ? { join_at: joinAt.toISOString() } : {}),
    // Transcript is requested after the call (Recall's accurate async model, any language); see collectNotes.
    recording_config: {
      audio_mixed_mp3: {}, video_mixed_mp4: {}, participant_events: {}, // participant events include join/leave and chat
      retention: { type: "timed", hours: retentionDays() * 24 },
    },
    chat: { on_bot_join: { send_to: "everyone", message: `Hi, I'm the ${appName()} Notetaker. This meeting is being recorded and transcribed, and the notes will be shared with the attendees.`.slice(0, 500) } },
    automatic_leave: { everyone_left_timeout: { timeout: 60 }, waiting_room_timeout: 600 },
    metadata: { booking_id: bookingId },
  });
  return bot!.id;
}

/** Cancels a scheduled bot. A bot that already joined (405) or no longer exists (404) is treated as done. */
export async function deleteBot(botId: string): Promise<void> {
  try { await recall("DELETE", `/bot/${botId}/`); }
  catch (e) { if (!(e instanceof ProviderError) || (e.status !== 404 && e.status !== 405)) throw e; }
}

export const NOTETAKER_COLLECT_JOB = "notetaker-collect";

/** Delayed job: collect the results 10 minutes after the meeting ends, retrying with backoff while Recall processes them. */
export async function scheduleCollect(bookingId: string, botId: string, endsAt: Date) {
  const { enqueue, QUEUES } = await import("@/server/queue");
  await enqueue(QUEUES.scheduler, { name: NOTETAKER_COLLECT_JOB, data: { bookingId, botId } }, {
    delay: Math.max(0, endsAt.getTime() + 10 * 60_000 - Date.now()),
    attempts: 9, backoff: { type: "exponential", delay: 5 * 60_000 }, // ~5 min .. ~21 h
    jobId: `ntc-${botId}`,
  });
}

type Artifact = { status?: { code?: string } | null; data?: Record<string, string | null | undefined> | null } | null | undefined;
type Recording = { id: string; status?: { code?: string } | null; media_shortcuts?: Record<string, Artifact> | null };
type Bot = { status_changes?: { code: string }[]; recordings?: Recording[] };
type TranscriptEntry = { participant?: { name?: string | null }; words?: { text: string; start_timestamp?: { relative?: number } }[] };
export type ParticipantEvent = {
  action: string;
  participant: { id: number; name: string | null; email?: string | null };
  timestamp: { absolute: string; relative?: number };
  data?: { text?: string; to?: string } | null;
};

export function formatTranscript(entries: TranscriptEntry[]): string {
  const ts = (s = 0) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return entries
    .filter((e) => e.words?.length)
    .map((e) => `[${ts(e.words![0].start_timestamp?.relative)}] ${e.participant?.name || "Speaker"}: ${e.words!.map((w) => w.text).join(" ").trim()}`)
    .join("\n");
}

const isBot = (name: string | null | undefined) => !!name && name.endsWith(`${appName()} Notetaker`);

/** Attendance from join/leave events: first join, last leave, total time present. Still present at the end = counted until the last event. */
export function buildAttendance(events: ParticipantEvent[]): NonNullable<NoteRow["attendance"]> {
  const sorted = [...events].sort((a, b) => Date.parse(a.timestamp.absolute) - Date.parse(b.timestamp.absolute));
  const end = sorted.length ? Date.parse(sorted[sorted.length - 1]!.timestamp.absolute) : 0;
  const people = new Map<number, { name: string; email: string | null; joinedAt: string; leftAt: string | null; ms: number; since: number | null }>();
  for (const e of sorted) {
    if ((e.action !== "join" && e.action !== "leave") || isBot(e.participant.name)) continue;
    const t = Date.parse(e.timestamp.absolute);
    let p = people.get(e.participant.id);
    if (!p) people.set(e.participant.id, (p = { name: e.participant.name || "Guest", email: e.participant.email ?? null, joinedAt: e.timestamp.absolute, leftAt: null, ms: 0, since: null }));
    if (e.action === "join") { if (p.since === null) { p.since = t; p.leftAt = null; } }
    else if (p.since !== null) { p.ms += t - p.since; p.since = null; p.leftAt = e.timestamp.absolute; }
  }
  return [...people.values()].map((p) => ({
    name: p.name, email: p.email, joinedAt: p.joinedAt, leftAt: p.since === null ? p.leftAt : null,
    seconds: Math.round((p.ms + (p.since !== null ? end - p.since : 0)) / 1000),
  }));
}

export function buildChat(events: ParticipantEvent[]): NonNullable<NoteRow["chat"]> {
  return events
    .filter((e) => e.action === "chat_message" && e.data?.text?.trim() && !isBot(e.participant.name))
    .sort((a, b) => Date.parse(a.timestamp.absolute) - Date.parse(b.timestamp.absolute))
    .map((e) => ({ name: e.participant.name || "Guest", at: e.timestamp.absolute, text: e.data!.text!.trim().slice(0, 2000) }));
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  return (await r.json()) as T;
}

/** Audio mp3 URL: media shortcut when present, else Recall's audio_mixed listing. Download URLs expire, so fetch fresh each time. */
async function audioUrl(rec: Recording): Promise<string | null> {
  const direct = rec.media_shortcuts?.audio_mixed?.data?.download_url;
  if (direct) return direct;
  try {
    const r = await recall<{ results?: { data?: { download_url?: string | null } | null }[] }>("GET", `/audio_mixed/?recording_id=${encodeURIComponent(rec.id)}`);
    return r?.results?.find((x) => x.data?.download_url)?.data?.download_url ?? null;
  } catch { return null; }
}

/** Fresh playback URLs for the notes page (null once Recall has deleted them). */
export async function recordingUrls(botId: string): Promise<{ video: string | null; audio: string | null }> {
  const bot = await recall<Bot>("GET", `/bot/${botId}/`);
  const rec = bot?.recordings?.[0];
  if (!rec) return { video: null, audio: null };
  return { video: rec.media_shortcuts?.video_mixed?.data?.download_url ?? null, audio: await audioUrl(rec) };
}

/** Worker entry. Throws (=> retry with backoff) while Recall is still processing; the final attempt saves whatever exists. */
export async function collectNotes({ bookingId, botId }: { bookingId: string; botId: string }, opts: { isFinal?: boolean } = {}): Promise<string> {
  let bot: Bot | null;
  try { bot = await recall<Bot>("GET", `/bot/${botId}/`); }
  catch (e) { if (e instanceof ProviderError && e.status === 404) return "bot deleted"; throw e; }
  const codes = new Set((bot?.status_changes ?? []).map((s) => s.code));
  const rec = bot?.recordings?.[0];
  if (!rec || rec.status?.code === "failed") {
    if (rec || codes.has("done") || codes.has("fatal")) { await upsertNotes(bookingId, { botStatus: "failed" }); return "no recording"; }
    throw new Error("recording not ready yet");
  }
  if (rec.status?.code && rec.status.code !== "done") throw new Error("recording still processing");
  const ms = rec.media_shortcuts ?? {};

  // Transcript: ask Recall once for its post-meeting transcription (auto language), then wait for it.
  let transcript = "";
  const t = ms.transcript;
  if (!t && !opts.isFinal) {
    try { await recall("POST", `/recording/${rec.id}/create_transcript/`, { provider: { recallai_async: { language_code: "auto" } } }); }
    catch (e) { if (!(e instanceof ProviderError) || e.status >= 500 || e.status === 429) throw e; } // 4xx = already requested
    throw new Error("transcript requested");
  }
  if (t?.status?.code === "processing" && !opts.isFinal) throw new Error("transcript processing");
  if (t?.status?.code === "done" && t.data?.download_url) transcript = formatTranscript(await getJson<TranscriptEntry[]>(t.data.download_url));

  const pe = ms.participant_events?.data?.participant_events_download_url;
  const events = pe ? await getJson<ParticipantEvent[]>(pe).catch(() => []) : [];
  const attendance = buildAttendance(events), chat = buildChat(events);

  const [b] = await db.select({ title: eventTypes.title, endsAt: bookings.endsAt, hostName: users.name, hostEmail: users.email }).from(bookings)
    .innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId)).innerJoin(users, eq(users.id, bookings.hostUserId))
    .where(eq(bookings.id, bookingId)).limit(1);
  const inv = await db.select({ name: invitees.name, email: invitees.email }).from(invitees)
    .where(and(eq(invitees.bookingId, bookingId), isNull(invitees.cancelledAt))).orderBy(asc(invitees.createdAt));
  const people = [...(b ? [{ name: b.hostName, email: b.hostEmail }] : []), ...inv];

  const audio = await audioUrl(rec);
  const ai = transcript || audio ? await summarize({ transcript, title: b?.title ?? "Meeting", people, chat, audioUrl: audio }) : null;
  await upsertNotes(bookingId, {
    transcript: transcript || null, summary: ai?.summary ?? null, actionItems: ai?.actionItems ?? null,
    attendance, chat, botStatus: "done",
    recordingExpiresAt: new Date((b?.endsAt.getTime() ?? Date.now()) + retentionDays() * 86_400_000),
  });
  await notifyNotesReady(bookingId, ai?.summary ?? null, ai?.actionItems ?? [], people);
  return "done";
}

// ───────── AI notes (Gemini)
type ActionItem = NonNullable<NoteRow["actionItems"]>[number];
type Person = { name: string; email: string };

/** Keeps the model's email only if it is a real attendee; otherwise matches the owner by full or unique first name. */
export function resolveOwner(owner: string, email: string, people: Person[]): string | null {
  const e = email.trim().toLowerCase();
  if (e && people.some((p) => p.email.toLowerCase() === e)) return e;
  const n = owner.trim().toLowerCase();
  if (!n) return null;
  const full = people.filter((p) => p.name.trim().toLowerCase() === n);
  if (full.length === 1) return full[0]!.email.toLowerCase();
  const first = people.filter((p) => p.name.trim().toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]);
  return first.length === 1 ? first[0]!.email.toLowerCase() : null;
}

/** Plain-text "Action items" section appended to the summary (emails and the notes page show it as-is). */
export function actionItemsText(items: ActionItem[]): string {
  return `Action items\n${items.length ? items.map((i) => `- ${i.owner}: ${i.task}${i.due ? ` (${i.due})` : ""}`).join("\n") : "- None recorded"}`;
}

const NOTES_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Plain text with exactly these sections: Summary (3-6 sentences), Key points (\"- \" bullets), Decisions (\"- \" bullets or \"- None recorded\"). No markdown other than \"- \" bullets. No action items here." },
    actionItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Name of the person who committed to the task, as spoken" },
          ownerEmail: { type: "string", description: "Their email from the attendee list if they are clearly one of them, else empty" },
          task: { type: "string" },
          due: { type: "string", description: "Due date/time as said, else empty" },
        },
        required: ["owner", "ownerEmail", "task", "due"],
      },
    },
  },
  required: ["summary", "actionItems"],
};

/**
 * Meeting notes + action items. Listens to the audio when available (better names and terms than the transcript alone).
 * Returns null when no API key is configured or every model fails (the transcript is still saved).
 */
export async function summarize(input: { transcript: string; title: string; people: Person[]; chat?: { name: string; text: string }[]; audioUrl?: string | null }) {
  if (!process.env.GEMINI_API_KEY) return null;
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { timeout: 180_000, retryOptions: { attempts: 2, initialDelay: 2, maxDelay: 5 } }, // SDK default retries ~5x up to 60s apart
  });

  let audioPart: Part | null = null, uploaded: string | null = null;
  if (input.audioUrl) {
    try {
      const blob = await (await fetch(input.audioUrl, { signal: AbortSignal.timeout(120_000) })).blob();
      let f = await ai.files.upload({ file: blob, config: { mimeType: "audio/mpeg", displayName: `meeting-${Date.now()}.mp3` } });
      uploaded = f.name ?? null;
      for (let i = 0; i < 40 && f.state === "PROCESSING" && f.name; i++) { await new Promise((r) => setTimeout(r, 3000)); f = await ai.files.get({ name: f.name }); }
      if (f.state === "ACTIVE" && f.uri) audioPart = createPartFromUri(f.uri, f.mimeType ?? "audio/mpeg");
    } catch (e) { console.error("[notetaker] audio upload failed; summarizing from the transcript", e instanceof Error ? e.message.slice(0, 200) : e); }
  }

  const prompt = [
    `Meeting: ${input.title}`,
    `Attendees (name, email):\n${input.people.map((p) => `- ${p.name} (${p.email})`).join("\n")}`,
    input.chat?.length ? `Chat messages:\n${input.chat.map((c) => `- ${c.name}: ${c.text}`).join("\n")}` : "",
    `Transcript:\n${input.transcript || "(no transcript; use the audio)"}`,
  ].filter(Boolean).join("\n\n");
  const system = "You write meeting notes. When an audio recording is attached it is the source of truth: the transcript may misspell names and technical terms. Use only what was said in the meeting or written in its chat. Keep names as spoken. Action items: every task someone committed to or was asked to do, one per item.";

  // Newest flash models often answer 503 "high demand"; fall through to the next one instead of waiting.
  const models = [...new Set([process.env.GEMINI_MODEL ?? "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash-lite"])];
  try {
    for (const model of models) {
      try {
        const r = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [...(audioPart ? [audioPart] : []), { text: prompt }] }],
          config: { systemInstruction: system, responseMimeType: "application/json", responseJsonSchema: NOTES_SCHEMA },
        });
        const j = JSON.parse(r.text ?? "") as { summary?: unknown; actionItems?: unknown };
        if (typeof j.summary !== "string" || !j.summary.trim()) continue; // blocked / empty: try the next model
        const items: ActionItem[] = (Array.isArray(j.actionItems) ? j.actionItems : [])
          .filter((i): i is Record<string, string> => !!i && typeof i === "object" && typeof (i as { task?: unknown }).task === "string" && !!(i as { task: string }).task.trim())
          .slice(0, 50)
          .map((i) => ({
            owner: String(i.owner ?? "").trim().slice(0, 120) || "Unassigned", task: i.task.trim().slice(0, 500),
            due: String(i.due ?? "").trim().slice(0, 80) || null, ownerEmail: resolveOwner(String(i.owner ?? ""), String(i.ownerEmail ?? ""), input.people),
          }));
        return { summary: `${j.summary.trim()}\n\n${actionItemsText(items)}`, actionItems: items };
      } catch (e) {
        console.error(`[notetaker] summary with ${model} failed`, e instanceof Error ? e.message.slice(0, 200) : e);
      }
    }
    return null;
  } finally {
    if (uploaded) await ai.files.delete({ name: uploaded }).catch(() => undefined);
  }
}

async function notifyNotesReady(bookingId: string, summary: string | null, items: ActionItem[], people: Person[]) {
  const { queueNotification } = await import("@/server/notifications/service");
  const { dedupeKey } = await import("@/server/queue/backoff");
  const seen = new Set<string>();
  for (const { email } of people) {
    const e = email.toLowerCase();
    if (seen.has(e)) continue;
    seen.add(e);
    await queueNotification({ kind: "notes_ready", bookingId, recipient: email, dedupeKey: dedupeKey("notes_ready", bookingId, e), extra: summary ? { summary } : undefined });
    const mine = items.filter((i) => i.ownerEmail === e).map((i) => ({ task: i.task, due: i.due }));
    if (mine.length) await queueNotification({ kind: "action_items", bookingId, recipient: email, dedupeKey: dedupeKey("action_items", bookingId, e), extra: { actionItems: mine } });
  }
}
