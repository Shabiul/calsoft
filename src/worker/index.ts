/**
 * Worker process entry:  npm run worker   (tsx src/worker/index.ts)
 * - one BullMQ worker per queue
 * - repeatable (job scheduler) jobs for reminders / hold expiry / stale-notification requeue
 * - heartbeat: Redis key + health file + HTTP GET /health on WORKER_HEALTH_PORT (default 4010)
 * - graceful shutdown on SIGTERM/SIGINT: stop taking jobs, wait for in-flight ones, close connections
 */
import "./env"; // must be first: loads .env.local before db/redis modules read process.env
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Worker } from "bullmq";
import { closeQueues, getConnection, getQueue, QUEUES } from "@/server/queue";
import { HEARTBEAT_KEY } from "@/server/queue/stats";
import { pool } from "@/server/db";
import { closeWorker, createWorker } from "./runtime";
import { processEvents, processNotifications, processScheduler, processWebhooks, processWorkflows, SCHEDULER_JOBS } from "./processors";

const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 4010);
const HEALTH_FILE = process.env.WORKER_HEALTH_FILE ?? path.join(os.tmpdir(), "meetflow-worker-health.json");
const startedAt = new Date().toISOString();

async function registerSchedulers() {
  const q = getQueue(QUEUES.scheduler);
  for (const j of Object.values(SCHEDULER_JOBS)) {
    // upsert => idempotent across restarts / multiple worker replicas (single repeatable definition in Redis)
    await q.upsertJobScheduler(j.id, { every: j.everyMs }, { name: j.id, opts: { attempts: 1, removeOnComplete: 10, removeOnFail: 50 } });
  }
}

async function main() {
  const workers: Worker[] = [
    createWorker(QUEUES.events, processEvents, { concurrency: 10 }),
    createWorker(QUEUES.notifications, processNotifications, { concurrency: 10 }),
    createWorker(QUEUES.webhooks, processWebhooks, { concurrency: 10 }),
    createWorker(QUEUES.workflows, processWorkflows, { concurrency: 5 }),
    createWorker(QUEUES.scheduler, processScheduler, { concurrency: 1 }),
  ];
  await registerSchedulers();

  let shuttingDown = false;
  const beat = async () => {
    const info = { pid: process.pid, host: os.hostname(), startedAt, at: new Date().toISOString(), shuttingDown, queues: Object.values(QUEUES) };
    try { fs.writeFileSync(HEALTH_FILE, JSON.stringify(info)); } catch { /* best effort */ }
    try { await getConnection().set(HEARTBEAT_KEY(), JSON.stringify(info), "EX", 45); } catch { /* redis down: health endpoint reports it */ }
  };
  await beat();
  const timer = setInterval(() => void beat(), 10_000);

  const server = http.createServer(async (req, res) => {
    if (req.url !== "/health") { res.statusCode = 404; return res.end(); }
    let redisOk = false;
    try { redisOk = (await getConnection().ping()) === "PONG"; } catch { redisOk = false; }
    const ok = redisOk && !shuttingDown && workers.every((w) => w.isRunning());
    res.statusCode = ok ? 200 : 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok, redis: redisOk, shuttingDown, startedAt, workers: workers.map((w) => ({ name: w.name, running: w.isRunning() })) }));
  });
  server.on("error", (e) => console.error("[worker] health server error:", (e as Error).message));
  server.listen(HEALTH_PORT, () => console.log(`[worker] health on :${HEALTH_PORT}/health, ${workers.length} workers up`));

  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${sig} received, draining...`);
    const force = setTimeout(() => { console.error("[worker] drain timeout, exiting"); process.exit(1); }, 30_000);
    force.unref();
    clearInterval(timer);
    try {
      await beat();
      await Promise.all(workers.map((w) => closeWorker(w))); // waits for in-flight jobs
      server.close();
      await closeQueues();
      await pool.end();
      try { fs.rmSync(HEALTH_FILE, { force: true }); } catch { /* ignore */ }
      console.log("[worker] clean shutdown");
      process.exit(0);
    } catch (e) {
      console.error("[worker] shutdown error", e);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => { console.error("[worker] fatal", e); process.exit(1); });
