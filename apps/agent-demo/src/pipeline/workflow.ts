// Daily batch pipeline: trade-day gate -> stock_basic (Worker) -> container
// scripts (one DO job each, polled every 2 min, 4 h cap, one retry).
// Steps are functions of an injected step-like object so the sequencing is
// testable outside the Workflows runtime.
import { httpTushare, beijingNow, syncStockBasic, type TushareFetcher } from "./stockBasic.js";
import { bjCompactDate } from "../shared/outbound.js";
import type { BatchJob, DailyParams, PipelineEnv } from "./batch.js";

export { bjCompactDate };

export const BATCH_SCRIPTS = [
  "fundamentals",
  "chip_hunter",
  "alpha_hunter",
  "hotspot_registry",
  "registry_auditor",
  "hotspot_hunter",
  "knowledge_miner",
  "ai_brain"
] as const;

const STEP_CAP_MS = 4 * 60 * 60 * 1000;
const POLL_INTERVAL = "2 minutes";

export interface StepLike {
  do<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
}

export interface StepRecord {
  name: string;
  status: "succeeded" | "failed" | "skipped";
  started_at_bj: string | null;
  duration_s: number;
  error: string | null;
}

export interface DailyResult {
  date: string;
  trade_day: boolean;
  steps: StepRecord[];
}

type BatchStub = {
  startJob(input: { script: string; run_date: string }): Promise<BatchJob>;
  status(): Promise<BatchJob>;
  stopJob(): Promise<void>;
};

type BatchNamespaceLike = {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string } | string): BatchStub;
};

function stubFor(env: PipelineEnv, jobName: string): BatchStub {
  const ns = env.BATCH as unknown as BatchNamespaceLike | undefined;
  if (!ns) throw new Error("batch_binding_missing");
  return ns.get(ns.idFromName(jobName));
}

export async function isTradeDay(
  date: string,
  token: string,
  fetcher: TushareFetcher = httpTushare
): Promise<boolean> {
  const { fields, items } = await fetcher(
    "trade_cal",
    { exchange: "SSE", start_date: date, end_date: date },
    token,
    "cal_date,is_open"
  );
  const idx = fields.indexOf("is_open");
  return items.some((row) => String(row[idx]) === "1");
}

interface ScriptOutcome {
  status: "succeeded" | "failed";
  error: string | null;
}

function jobError(tail: string[]): string {
  const lines = tail.filter((l) => String(l).trim() !== "").slice(-2);
  return (lines.length ? lines.join(" | ") : "script_failed").slice(0, 300);
}

// One attempt. Workflows re-execute run() from the top after every sleep, so
// every timestamp must be produced inside a step (steps are memoized; replayed
// runs see the original values). Step names carry the attempt number — a retry
// must not reuse the memoized steps of the failed attempt.
async function runScriptOnce(
  step: StepLike,
  env: PipelineEnv,
  jobName: string,
  name: string,
  runDate: string,
  attempt: number,
  clock: () => number
): Promise<ScriptOutcome> {
  const stub = stubFor(env, jobName);
  const t0 = await step.do(`t0 ${name} #${attempt}`, () => clock());
  await step.do(`start ${name} #${attempt}`, () =>
    stub.startJob({ script: name, run_date: runDate })
  );
  for (let n = 0; ; n++) {
    await step.sleep(`wait ${name} #${attempt} ${n}`, POLL_INTERVAL);
    const poll = await step.do(`poll ${name} #${attempt} ${n}`, async () => ({
      job: await stub.status(),
      now: clock()
    }));
    if (poll.job.status === "succeeded") return { status: "succeeded", error: null };
    if (poll.job.status === "failed") {
      return { status: "failed", error: jobError(poll.job.error_tail) };
    }
    if (poll.now - t0 > STEP_CAP_MS) {
      await step.do(`stop ${name} #${attempt}`, () => stub.stopJob());
      return { status: "failed", error: "step_timeout_4h" };
    }
  }
}

async function runScript(
  step: StepLike,
  env: PipelineEnv,
  jobName: string,
  name: string,
  runDate: string,
  clock: () => number
): Promise<ScriptOutcome> {
  const first = await runScriptOnce(step, env, jobName, name, runDate, 1, clock);
  if (first.status === "succeeded") return first;
  // All batch writes are idempotent: retry the whole script once.
  return runScriptOnce(step, env, jobName, name, runDate, 2, clock);
}

export async function runDailyPipeline(
  env: PipelineEnv,
  instanceId: string,
  params: DailyParams,
  step: StepLike,
  opts: { fetcher?: TushareFetcher; now?: Date; clock?: () => number } = {}
): Promise<DailyResult> {
  const clock = opts.clock ?? Date.now;
  const records: StepRecord[] = [];
  const names = ["stock_basic", ...BATCH_SCRIPTS].filter(
    (n) => !params.only || params.only.includes(n)
  );

  // The run date lives inside the step so replays keep the original value even
  // when a hibernated instance resumes on a later day.
  const trade = await step.do("trade_day", async () => {
    const d = params.date ?? bjCompactDate(opts.now);
    return {
      date: d,
      open: await isTradeDay(d, env.MY_TUSHARE_TOKEN ?? "", opts.fetcher)
    };
  });
  const date = trade.date;
  if (!trade.open && !params.force) {
    for (const name of names) {
      records.push({
        name,
        status: "skipped",
        started_at_bj: null,
        duration_s: 0,
        error: null
      });
    }
    return { date, trade_day: false, steps: records };
  }

  for (const name of names) {
    const begin = await step.do(`begin ${name}`, () => ({ ms: clock(), bj: beijingNow() }));
    const rec: StepRecord = {
      name,
      status: "failed",
      started_at_bj: begin.bj,
      duration_s: 0,
      error: null
    };
    try {
      if (name === "stock_basic") {
        await step.do("stock_basic", () => syncStockBasic(env, { fetcher: opts.fetcher }));
        rec.status = "succeeded";
      } else {
        const outcome = await runScript(step, env, `${instanceId}:${name}`, name, date, clock);
        rec.status = outcome.status;
        rec.error = outcome.error;
      }
    } catch (error) {
      rec.status = "failed";
      rec.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    }
    const end = await step.do(`end ${name}`, () => clock());
    rec.duration_s = Math.round((end - begin.ms) / 1000);
    records.push(rec);
  }
  return { date, trade_day: true, steps: records };
}

// Cron handler: one workflow instance per Beijing trading-day date; the id is
// deterministic so a double-fire is a no-op.
export async function scheduledTick(env: PipelineEnv, now = new Date()): Promise<string> {
  const id = `daily-${bjCompactDate(now)}`;
  try {
    await env.DAILY!.create({ id, params: {} });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!/already exists|duplicate|exists/i.test(msg)) throw error;
  }
  return id;
}
