/**
 * Real Redis (REDIS_URL). Uses an isolated key prefix + random queue names; cleans up after itself.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queue, Worker } from "bullmq";

process.env.QUEUE_PREFIX = `test-${randomUUID().slice(0, 8)}`;

type Mod = typeof import("@/server/queue");
type Rt = typeof import("@/worker/runtime");
let q: Mod; let rt: Rt;
const created: Queue[] = [];
const workers: Worker[] = [];

beforeAll(async () => {
  q = await import("@/server/queue");
  rt = await import("@/worker/runtime");
});
afterAll(async () => {
  for (const w of workers) await rt.closeWorker(w, true).catch(() => undefined);
  for (const queue of created) await queue.obliterate({ force: true }).catch(() => undefined);
  await q.closeQueues();
});

const until = async (fn: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("timeout waiting for condition");
};
const mkQueue = () => { const name = `q-${randomUUID().slice(0, 8)}`; const queue = q.getQueue(name); created.push(queue); return { name, queue }; };

describe("queue against real Redis", () => {
  it("enqueue -> worker processes -> completes", async () => {
    const { name } = mkQueue();
    const seen: unknown[] = [];
    workers.push(rt.createWorker(name, async (job) => { seen.push(job.data); return "ok"; }));
    const job = await q.enqueue(name, { name: "t", data: { n: 1 } });
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ n: 1 });
    await until(async () => (await job.isCompleted()));
  });

  it("jobId dedupes duplicate enqueues", async () => {
    const { name, queue } = mkQueue();
    await q.enqueue(name, { name: "t", data: {} }, { jobId: "same", delay: 60_000 });
    await q.enqueue(name, { name: "t", data: {} }, { jobId: "same", delay: 60_000 });
    expect((await queue.getJobCounts("delayed")).delayed).toBe(1);
  });

  it("job survives worker restart (enqueued while no worker is running)", async () => {
    const { name, queue } = mkQueue();
    const w1 = rt.createWorker(name, async () => "never-runs-wrongly");
    await w1.waitUntilReady();
    await rt.closeWorker(w1); // graceful shutdown, nothing processed
    await q.enqueue(name, { name: "t", data: { v: 42 } }); // no worker alive
    expect((await queue.getJobCounts("waiting")).waiting).toBe(1);
    const seen: unknown[] = [];
    workers.push(rt.createWorker(name, async (job) => { seen.push(job.data); }));
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ v: 42 });
  });

  it("job in flight when the worker crashes is recovered by another worker (stalled recovery)", async () => {
    const { name } = mkQueue();
    let started = false;
    const fast = { lockDuration: 1500, stalledInterval: 500 };
    const w1 = rt.createWorker(name, () => new Promise(() => { started = true; /* hangs forever */ }), fast);
    await q.enqueue(name, { name: "t", data: { crash: true } });
    await until(() => started);
    await rt.closeWorker(w1, true); // force: simulates process death mid-job
    const seen: unknown[] = [];
    workers.push(rt.createWorker(name, async (job) => { seen.push(job.data); }, fast));
    await until(() => seen.length === 1, 20_000);
    expect(seen[0]).toEqual({ crash: true });
  }, 40_000);

  it("failed jobs retry with the custom backoff strategy then land in failed (dead letter)", async () => {
    const { name, queue } = mkQueue();
    let calls = 0;
    workers.push(rt.createWorker(name, async () => { calls++; throw new Error("boom"); }));
    const job = await q.enqueue(name, { name: "t", data: {} }, { attempts: 2, backoff: { type: "custom" } });
    await until(async () => (await queue.getJobCounts("failed")).failed === 1, 25_000);
    expect(calls).toBe(2);
    const failed = await queue.getFailed();
    expect(failed[0].failedReason).toBe("boom");
    expect(job.id).toBeDefined();
  }, 40_000);

  it("emitEvent persists a routable job", async () => {
    const { eventId } = await q.emitEvent("booking.created", { bookingId: randomUUID() });
    const j = await q.getQueue(q.QUEUES.events).getJob(`evt-${eventId}`);
    expect(j?.data.type).toBe("booking.created");
    await j?.remove();
  });

  it("getQueueStats reports every queue", async () => {
    const s = await q.getQueueStats();
    expect(s.queues.map((x) => x.name).sort()).toEqual(Object.values(q.QUEUES).sort());
    expect(s.worker).toHaveProperty("alive");
  });
});
