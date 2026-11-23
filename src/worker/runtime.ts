import { Worker, type Job, type Processor, type WorkerOptions } from "bullmq";
import { asConn, backoffStrategy, createConnection, queuePrefix } from "@/server/queue";
import { isFinalAttempt } from "@/server/queue/backoff";

export interface CreateWorkerOptions extends Partial<Pick<WorkerOptions, "concurrency" | "lockDuration" | "stalledInterval" | "maxStalledCount">> {
  prefix?: string;
}

/** Single place that configures a BullMQ worker (custom exponential backoff, own blocking connection). */
export function createWorker<T = unknown>(name: string, processor: Processor<T>, opts: CreateWorkerOptions = {}): Worker<T> {
  const worker = new Worker<T>(name, processor, {
    connection: asConn(createConnection()),
    prefix: opts.prefix ?? queuePrefix(),
    concurrency: opts.concurrency ?? 5,
    lockDuration: opts.lockDuration ?? 60_000,
    stalledInterval: opts.stalledInterval ?? 120_000,
    maxStalledCount: opts.maxStalledCount ?? 2,
    // Idle workers block this long (seconds) per Redis request. The BullMQ default (5s) burns ~100k requests/day on a metered
    // Redis such as Upstash; 30s cuts idle polling ~6x and new jobs still wake the worker immediately.
    drainDelay: Number(process.env.WORKER_DRAIN_DELAY_S ?? 30),
    settings: { backoffStrategy },
  });
  worker.on("error", (err) => console.error(`[worker:${name}] error`, err.message));
  worker.on("failed", (job, err) => {
    const final = job ? isFinalAttempt(job.attemptsMade - 1, job.opts.attempts ?? 1) : false;
    console.warn(`[worker:${name}] job ${job?.id} (${job?.name}) failed attempt ${job?.attemptsMade}${final ? " [FINAL]" : ""}: ${err.message}`);
  });
  return worker;
}

/** Attempt info for the job currently being processed (attemptsMade excludes the current attempt). */
export function attemptInfo(job: Job): { attemptsMade: number; isFinal: boolean } {
  return { attemptsMade: job.attemptsMade, isFinal: isFinalAttempt(job.attemptsMade, job.opts.attempts ?? 1) };
}

export async function closeWorker(w: Worker, force = false) {
  await w.close(force);
  await (w.opts.connection as unknown as { quit?: () => Promise<unknown> }).quit?.().catch(() => undefined);
}
