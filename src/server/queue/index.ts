/**
 * Queue contract (owner: worker agent).
 *   getQueue(name), QUEUES, enqueue(name, job, opts), emitEvent(type, payload), getQueueStats()
 * emitEvent is durable: it persists a job in Redis ("events" queue); the worker fans it out to
 * notifications, outgoing webhooks and workflows as independent, individually-retried jobs.
 */
import { Queue, type JobsOptions, type ConnectionOptions } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { backoffDelay } from "./backoff";
import { redisTls } from "./redis-tls";

export const QUEUES = {
  events: "events",
  notifications: "notifications",
  webhooks: "webhooks",
  workflows: "workflows",
  scheduler: "scheduler",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type EventType =
  | "booking.created" | "booking.confirmed" | "booking.cancelled" | "booking.rescheduled"
  | "booking.declined" | "booking.completed" | "booking.no_show" | "booking.expired"
  | "payment.succeeded" | "payment.failed";

export interface EventPayload {
  bookingId: string;
  /** rescheduled: bookingId is the NEW booking; previousBookingId the old one */
  previousBookingId?: string;
  /** Raw manage token (only used to render manage links in emails; never forwarded to webhooks). */
  manageToken?: string;
  actor?: string;
  reason?: string;
  /** Recurring series: position (0-based) of this occurrence and the number of occurrences affected. */
  seriesIndex?: number;
  seriesCount?: number;
  /** booking.confirmed raised by a host approving a request. */
  approved?: boolean;
  [k: string]: unknown;
}
export interface EventJobData { eventId: string; type: EventType; payload: EventPayload; at: string }

export const MAX_ATTEMPTS = { default: 6, webhook: 8, event: 5 } as const;

export function queuePrefix(): string { return process.env.QUEUE_PREFIX ?? "meetflow"; }

const g = globalThis as unknown as { __mfRedis?: Redis; __mfQueues?: Map<string, Queue> };

export function getConnection(): Redis {
  if (!g.__mfRedis) {
    g.__mfRedis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:63799", { maxRetriesPerRequest: null, ...redisTls() });
  }
  return g.__mfRedis;
}
/** Workers need their own blocking connection. */
export function createConnection(): Redis {
  return new IORedis(process.env.REDIS_URL ?? "redis://localhost:63799", { maxRetriesPerRequest: null, ...redisTls() });
}
export const asConn = (r: Redis) => r as unknown as ConnectionOptions;

export function getQueue(name: string): Queue {
  g.__mfQueues ??= new Map();
  let q = g.__mfQueues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: asConn(getConnection()),
      prefix: queuePrefix(),
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS.default,
        backoff: { type: "custom" },
        removeOnComplete: { age: 24 * 3600, count: 5000 },
        removeOnFail: { age: 14 * 24 * 3600 },
      },
    });
    g.__mfQueues.set(name, q);
  }
  return q;
}

/** Custom backoff strategy; pass as Worker `settings.backoffStrategy`. */
export const backoffStrategy = (attemptsMade: number) => backoffDelay(attemptsMade);

export async function enqueue(
  name: string,
  job: { name: string; data: unknown },
  opts?: JobsOptions,
) {
  return getQueue(name).add(job.name, job.data, opts);
}

export async function emitEvent(type: EventType, payload: EventPayload) {
  const eventId = randomUUID();
  const data: EventJobData = { eventId, type, payload, at: new Date().toISOString() };
  await enqueue(QUEUES.events, { name: "route", data }, { jobId: `evt-${eventId}`, attempts: MAX_ATTEMPTS.event });
  return { eventId };
}

export async function closeQueues() {
  const qs = g.__mfQueues ? [...g.__mfQueues.values()] : [];
  await Promise.all(qs.map((q) => q.close()));
  g.__mfQueues = undefined;
  if (g.__mfRedis) { await g.__mfRedis.quit().catch(() => undefined); g.__mfRedis = undefined; }
}

export { getQueueStats } from "./stats";
