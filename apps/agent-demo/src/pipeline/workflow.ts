// Daily batch pipeline: trade-day gate -> stock_basic (Worker) -> container
// scripts (one DO job each, polled every 2 min, 4 h cap, one retry).
// Steps are functions of an injected step-like object so the sequencing is
// testable outside the Workflows runtime.
import { httpTushare, beijingNow, syncStockBasic, type TushareFetcher } from "./stockBasic.js";
import { bjCompactDate } from "../shared/outbound.js";
import { CONTAINER_RELEASE_FAILED } from "../shared/container-lifecycle.js";
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

const STEP_CAP_HOURS: Record<string, number> = {
  knowledge_miner: 8,
  ai_brain: 16
};
const DEFAULT_STEP_CAP_HOURS = 4;
const capMsFor = (name: string) => (STEP_CAP_HOURS[name] ?? DEFAULT_STEP_CAP_HOURS) * 60 * 60 * 1000;
const POLL_MINUTES = 2;
const POLL_INTERVAL = `${POLL_MINUTES} minutes`;
const MAX_ATTEMPTS = 2; // one run + one retry per script

// fundamentals 只在财报季运行：北京时间周五 且 处于以下窗口（月-日，闭区间）。
// 修改窗口或星期只需改这两个字段；force 或 only 手动触发不受此限制。
const FUNDAMENTALS_SCHEDULE = {
  weekday: 5, // 0=周日 ... 5=周五
  windows: [
    [1, 1, 4, 30], // 1–4 月：年报、一季报
    [7, 1, 8, 31], // 7–8 月：半年报
    [10, 1, 10, 31] // 10 月：三季报
  ] as const
};

// date 是北京时间 YYYYMMDD；返回该日历日是否为限定星期且落在任一个窗口内。
export function fundamentalsWindowOpen(date: string): boolean {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(4, 6));
  const d = Number(date.slice(6, 8));
  if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== FUNDAMENTALS_SCHEDULE.weekday) {
    return false;
  }
  const mmdd = m * 100 + d;
  return FUNDAMENTALS_SCHEDULE.windows.some(([m1, d1, m2, d2]) => {
    const lo = m1 * 100 + d1;
    const hi = m2 * 100 + d2;
    return mmdd >= lo && mmdd <= hi;
  });
}

// Chinese descriptions of the pipeline's own constants, surfaced in every
// DailyResult so the dashboard can show why a step ran or was skipped.
const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
const monthRangesZh = () =>
  FUNDAMENTALS_SCHEDULE.windows
    .map(([m1, , m2]) => (m1 === m2 ? `${m1}` : `${m1}–${m2}`))
    .join("、");
const fundamentalsWindowZh = () =>
  `仅在 ${monthRangesZh()} 月的${WEEKDAYS_ZH[FUNDAMENTALS_SCHEDULE.weekday]}运行`;
const stepCapsZh = () => ({
  ...Object.fromEntries(
    Object.entries(STEP_CAP_HOURS).map(([k, v]) => [k, `${v} 小时`])
  ),
  其他: `${DEFAULT_STEP_CAP_HOURS} 小时`
});

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
  reason_zh: string | null;
}

// Maps a step's machine error to the Chinese explanation shown in the output.
function reasonZhFor(error: string | null): string | null {
  if (error === "not_in_report_window") {
    return `不在财报窗口（${fundamentalsWindowZh()}）`;
  }
  if (error === "non_trading_day") return "非交易日（Tushare 交易日历）";
  if (error?.startsWith("step_timeout_")) return "超过单步时长上限";
  if (error && /max_instances|maximum number of running container instances/i.test(error)) {
    return "容器实例已达上限（max_instances）";
  }
  return null;
}

export interface DailyResult {
  date: string;
  trade_day: boolean;
  trigger: "cron" | "manual";
  cron?: string;
  rules: {
    步骤顺序: string[];
    基本面窗口: string;
    单步时长上限: Record<string, string>;
    进度检查间隔: string;
    失败重试: string;
  };
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

// Release step shared by all terminal branches: the memoized step awaits the
// DO-side destroy and returns evidence ({container_released:true}) instead of
// a bare null RPC result. Release failures are wrapped with the stable marker
// so the workflow treats them as infrastructure failures.
function releaseStep(
  step: StepLike,
  name: string,
  attempt: number,
  stub: BatchStub
): Promise<{ container_released: true }> {
  return step.do(`stop ${name} #${attempt}`, async () => {
    try {
      await stub.stopJob();
      return { container_released: true as const };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes(CONTAINER_RELEASE_FAILED)) throw error;
      throw new Error(`${CONTAINER_RELEASE_FAILED}: ${msg}`.slice(0, 300), {
        cause: error
      });
    }
  });
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
  const capMs = capMsFor(name);
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
    if (poll.job.status === "succeeded") {
      // Terminal: release the container now — sleepAfter alone is only a
      // safety net and leaving instances running exhausts max_instances.
      await releaseStep(step, name, attempt, stub);
      return { status: "succeeded", error: null };
    }
    if (poll.job.status === "failed") {
      await releaseStep(step, name, attempt, stub);
      return { status: "failed", error: jobError(poll.job.error_tail) };
    }
    if (poll.now - t0 > capMs) {
      await releaseStep(step, name, attempt, stub);
      return {
        status: "failed",
        error: `step_timeout_${capMs / 3600000}h`
      };
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
  const trigger = params.trigger === "cron" ? "cron" : "manual";
  const rules = {
    步骤顺序: ["stock_basic", ...BATCH_SCRIPTS],
    基本面窗口: fundamentalsWindowZh(),
    单步时长上限: stepCapsZh(),
    进度检查间隔: `${POLL_MINUTES} 分钟`,
    失败重试: `每个脚本失败后整体重试 ${MAX_ATTEMPTS - 1} 次`
  };
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
  const result = (trade_day: boolean): DailyResult => ({
    date,
    trade_day,
    trigger,
    ...(params.cron ? { cron: params.cron } : {}),
    rules,
    steps: records
  });
  if (!trade.open && !params.force) {
    for (const name of names) {
      records.push({
        name,
        status: "skipped",
        started_at_bj: null,
        duration_s: 0,
        error: "non_trading_day",
        reason_zh: reasonZhFor("non_trading_day")
      });
    }
    return result(false);
  }

  for (const name of names) {
    // fundamentals 仅在财报季周五运行（定时调度路径）；force 或 only 手动触发不受限。
    if (
      name === "fundamentals" &&
      !params.force &&
      !params.only?.includes("fundamentals") &&
      !fundamentalsWindowOpen(date)
    ) {
      records.push({
        name,
        status: "skipped",
        started_at_bj: null,
        duration_s: 0,
        error: "not_in_report_window",
        reason_zh: reasonZhFor("not_in_report_window")
      });
      continue;
    }
    const begin = await step.do(`begin ${name}`, () => ({ ms: clock(), bj: beijingNow() }));
    const rec: StepRecord = {
      name,
      status: "failed",
      started_at_bj: begin.bj,
      duration_s: 0,
      error: null,
      reason_zh: null
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
      const msg = error instanceof Error ? error.message : String(error);
      // An unreleased container is infrastructure failure: do not continue to
      // further script starts while capacity is still occupied.
      if (msg.includes(CONTAINER_RELEASE_FAILED)) throw error;
      rec.status = "failed";
      rec.error = msg.slice(0, 300);
    }
    const end = await step.do(`end ${name}`, () => clock());
    rec.duration_s = Math.round((end - begin.ms) / 1000);
    rec.reason_zh = reasonZhFor(rec.error);
    records.push(rec);
  }
  return result(true);
}

// Cron handler: one workflow instance per Beijing trading-day date; the id is
// deterministic so a double-fire is a no-op.
export async function scheduledTick(
  env: PipelineEnv,
  now = new Date(),
  cron?: string
): Promise<string> {
  const id = `daily-${bjCompactDate(now)}`;
  try {
    await env.DAILY!.create({ id, params: { trigger: "cron", ...(cron ? { cron } : {}) } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!/already exists|duplicate|exists/i.test(msg)) throw error;
  }
  return id;
}
