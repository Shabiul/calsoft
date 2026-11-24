import type { Job } from "bullmq";
import { emitEvent, enqueue, getConnection, MAX_ATTEMPTS, QUEUES, queuePrefix, type EventJobData } from "@/server/queue";
import { handleNotificationEvent } from "@/server/notifications/events";
import { processNotification, requeueStaleNotifications, type NotificationJobData } from "@/server/notifications/service";
import { expirePendingHolds, expireUnansweredRequests, processDueReminders } from "@/server/notifications/reminders";
import { fanoutWebhooks, processDelivery } from "@/server/webhooks/dispatch";
import { fanoutWorkflows, processExecution } from "@/server/workflows/engine";
import { attemptInfo } from "./runtime";
import { INTEGRATION_JOB, processIntegrationJob } from "@/server/integrations/booking-sync";
import { syncAllDue } from "@/server/integrations/sync";
import { collectNotes, NOTETAKER_COLLECT_JOB } from "@/server/notetaker";
import { benchSweep } from "@/server/services/bench";
import { runOpsCheck } from "@/server/ops/alerts";
import { NOTES_AUDIO_JOB, processAudioNotes, type AudioJob } from "@/server/notetaker/audio";
import { reconcilePayments, refundForCancelledBooking } from "@/server/payments/service";

/** Cancelled bookings with a paid payment are refunded per policy right away (reconcile sweeps any misses). */
const PAYMENT_REFUND_JOB = "payments-refund";

/** Bookings whose external calendar event must converge after this event (reschedule also tears down the old one). */
function integrationTargets(ev: EventJobData): string[] {
  const t = ev.type as string;
  if (!["booking.created", "booking.confirmed", "booking.rescheduled", "booking.cancelled", "booking.declined", "booking.expired"].includes(t)) return [];
  const p = ev.payload as { bookingId?: string; previousBookingId?: string };
  return [p.bookingId, t === "booking.rescheduled" ? p.previousBookingId : undefined].filter((x): x is string => !!x);
}

/** events -> three independent, individually retried fan-out jobs (deterministic ids = idempotent on replay). */
export async function processEvents(job: Job<EventJobData>) {
  const ev = job.data;
  const opts = { attempts: MAX_ATTEMPTS.default };
  const refundJobs = ev.type === "booking.cancelled" || ev.type === "booking.declined"
    ? [enqueue(QUEUES.scheduler, { name: PAYMENT_REFUND_JOB, data: { bookingId: ev.payload.bookingId } }, { attempts: 5, backoff: { type: "exponential", delay: 30_000 }, jobId: `prefund-${ev.eventId}` })]
    : [];
  await Promise.all([
    ...refundJobs,
    enqueue(QUEUES.notifications, { name: "fanout", data: ev }, { ...opts, jobId: `fo-n-${ev.eventId}` }),
    enqueue(QUEUES.webhooks, { name: "fanout", data: ev }, { ...opts, jobId: `fo-w-${ev.eventId}` }),
    enqueue(QUEUES.workflows, { name: "fanout", data: ev }, { ...opts, jobId: `fo-f-${ev.eventId}` }),
    ...integrationTargets(ev).map((bookingId) =>
      enqueue(QUEUES.scheduler, { name: INTEGRATION_JOB, data: { bookingId } }, { attempts: 1, jobId: `isync-${ev.eventId}-${bookingId}` })),
  ]);
}

export async function processNotifications(job: Job) {
  if (job.name === "fanout") return handleNotificationEvent(job.data as EventJobData);
  if (job.name === "send") return processNotification(job.data as NotificationJobData, attemptInfo(job));
  if (job.name === NOTES_AUDIO_JOB) return processAudioNotes(job.data as AudioJob, attemptInfo(job));
  throw new Error(`unknown notifications job ${job.name}`);
}
export async function processWebhooks(job: Job) {
  if (job.name === "fanout") return fanoutWebhooks(job.data as EventJobData);
  if (job.name === "deliver") return processDelivery((job.data as { deliveryId: string }).deliveryId, attemptInfo(job));
  throw new Error(`unknown webhooks job ${job.name}`);
}
export async function processWorkflows(job: Job) {
  if (job.name === "fanout") return fanoutWorkflows(job.data as EventJobData);
  if (job.name === "run") return processExecution((job.data as { executionId: string }).executionId, attemptInfo(job));
  throw new Error(`unknown workflows job ${job.name}`);
}

export const SCHEDULER_JOBS = {
  remindersPoll: { id: "reminders-poll", everyMs: 30_000 },
  expireHolds: { id: "expire-holds", everyMs: 60_000 },
  requeueStale: { id: "requeue-stale", everyMs: 5 * 60_000 },
  calendarSync: { id: "calendar-sync", everyMs: 10 * 60_000 },
  paymentsReconcile: { id: "payments-reconcile", everyMs: 5 * 60_000 },
  benchSweep: { id: "bench-sweep", everyMs: 6 * 3600_000 },
  opsCheck: { id: "ops-check", everyMs: 5 * 60_000 },
} as const;

export async function processScheduler(job: Job) {
  switch (job.name) {
    case SCHEDULER_JOBS.remindersPoll.id: return processDueReminders();
    case SCHEDULER_JOBS.expireHolds.id: {
      const ids = await expirePendingHolds();
      for (const bookingId of ids) await emitEvent("booking.expired", { bookingId });
      // Approval requests nobody answered before the start time (slot released, invitee notified).
      const lapsed = await expireUnansweredRequests();
      for (const r of lapsed) await emitEvent("booking.expired", { bookingId: r.id, reason: "unanswered_request", seriesIndex: r.seriesIndex, seriesCount: r.seriesCount });
      return ids.length + lapsed.length;
    }
    case SCHEDULER_JOBS.requeueStale.id: return requeueStaleNotifications();
    case SCHEDULER_JOBS.calendarSync.id: return syncAllDue();
    case SCHEDULER_JOBS.paymentsReconcile.id: return reconcilePayments();
    case SCHEDULER_JOBS.benchSweep.id: return benchSweep();
    case SCHEDULER_JOBS.opsCheck.id: return runOpsCheck(async (key, ttl) => (await getConnection().set(`${queuePrefix()}:${key}`, "1", "EX", ttl, "NX")) === "OK");
    case PAYMENT_REFUND_JOB: return refundForCancelledBooking((job.data as { bookingId: string }).bookingId);
    case NOTETAKER_COLLECT_JOB: return collectNotes(job.data as { bookingId: string; botId: string }, attemptInfo(job));
    case INTEGRATION_JOB: return processIntegrationJob(job.data as { bookingId: string; attempt?: number });
    default: throw new Error(`unknown scheduler job ${job.name}`);
  }
}
