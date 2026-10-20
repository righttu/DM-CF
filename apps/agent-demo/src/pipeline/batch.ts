import { Container } from "@cloudflare/containers";
import { AI_OUTBOUND_HOST, aiOutboundHandler, batchOutboundHandler } from "./outbound.js";
import {
  CONTAINER_RELEASE_FAILED,
  destroyRunningContainer,
  type ContainerReleaseConfirmation
} from "../shared/container-lifecycle.js";

export interface PipelineEnv {
  QUANT_DB: D1Database;
  BATCH?: DurableObjectNamespace<QuantBatchContainer>;
  VECTORIZE?: Vectorize;
  R2_STOCK_INFOR?: R2Bucket;
  AI?: Ai;
  DAILY?: Workflow<DailyParams>;
  MY_TUSHARE_TOKEN?: string;
  DASHSCOPE_API_KEY?: string;
  CF_AIG_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  AI_ENGINE?: string;
  BRAIN_AI_MODEL?: string;
  AUDITOR_AI_MODEL?: string;
}

export interface DailyParams {
  date?: string;
  force?: boolean;
  only?: string[];
  trigger?: string;
  cron?: string;
}

export const BATCH_OUTBOUND_HOST = "quant-data.internal";

export type BatchJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface BatchJob {
  script: string;
  run_date: string;
  status: BatchJobStatus;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  error_tail: string[];
}

export interface BatchTransport {
  start(envVars: Record<string, string>): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

let transportOverride: BatchTransport | undefined;

export function __setBatchTransportForTests(t?: BatchTransport): void {
  transportOverride = t;
}

export function batchTransport(): BatchTransport | undefined {
  return transportOverride;
}

const CONTAINER_HOST = "http://container";
// A terminal job's DO storage is wiped 24 h later (the job id contains the
// run date, so next day's run gets a fresh DO anyway); a re-run disarms it.
export const CLEANUP_AFTER_SECONDS = 24 * 60 * 60;
const CLEANUP_TOKEN_KEY = "cleanup_token";
const TERMINAL_STATUSES = new Set<BatchJobStatus>(["succeeded", "failed"]);

export interface CleanupHooks {
  schedule(token: string): Promise<void> | void;
  wipe(): Promise<void>;
}

export class BatchJobRunner {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: PipelineEnv,
    private readonly transport: () => BatchTransport,
    private readonly jobId: () => string,
    private readonly cleanup: CleanupHooks
  ) {}

  private async armCleanup(): Promise<void> {
    const token = crypto.randomUUID();
    await this.storage.put(CLEANUP_TOKEN_KEY, token);
    await this.cleanup.schedule(token);
  }

  async runCleanup(payload: unknown): Promise<void> {
    const token =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).token
        : payload;
    if (!token || token !== (await this.storage.get(CLEANUP_TOKEN_KEY))) return;
    const job = await this.loadJob();
    if (!job || !TERMINAL_STATUSES.has(job.status)) return;
    // Release the runtime before wiping; a failed release must not wipe —
    // retrying cleanup is safer than losing the record of an unreleased job.
    await this.stop();
    await this.cleanup.wipe();
  }

  private containerEnvVars(): Record<string, string> {
    const env = this.env;
    const vars: Record<string, string> = {
      D1_API_URL: `http://${BATCH_OUTBOUND_HOST}`,
      AI_BASE_URL: `http://${AI_OUTBOUND_HOST}/v1`,
      AI_API_KEY: "unused",
      CF_ACCESS_CLIENT_ID: "unused",
      CF_ACCESS_CLIENT_SECRET: "unused"
    };
    if (env.MY_TUSHARE_TOKEN) vars.MY_TUSHARE_TOKEN = env.MY_TUSHARE_TOKEN;
    if (env.CF_ACCOUNT_ID) vars.CF_ACCOUNT_ID = env.CF_ACCOUNT_ID;
    if (env.AI_ENGINE) vars.AI_ENGINE = env.AI_ENGINE;
    if (env.BRAIN_AI_MODEL) vars.BRAIN_AI_MODEL = env.BRAIN_AI_MODEL;
    if (env.AUDITOR_AI_MODEL) vars.AUDITOR_AI_MODEL = env.AUDITOR_AI_MODEL;
    return vars;
  }

  private async loadJob(): Promise<BatchJob | null> {
    return (await this.storage.get<BatchJob>("job")) ?? null;
  }

  private async saveJob(job: BatchJob): Promise<void> {
    await this.storage.put("job", job);
  }

  async jobContext(): Promise<{ script: string; run_date: string } | null> {
    const job = await this.loadJob();
    return job ? { script: job.script, run_date: job.run_date } : null;
  }

  async startJob(input: { script: string; run_date: string }): Promise<BatchJob> {
    const existing = await this.loadJob();
    if (
      existing &&
      existing.script === input.script &&
      existing.run_date === input.run_date &&
      (existing.status === "queued" || existing.status === "running")
    ) {
      return existing;
    }
    // A re-run must disarm any cleanup scheduled by the previous terminal job.
    await this.storage.delete(CLEANUP_TOKEN_KEY);
    const job: BatchJob = {
      script: input.script,
      run_date: input.run_date,
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      exit_code: null,
      error_tail: []
    };
    await this.saveJob(job);
    const t = this.transport();
    try {
      await t.start(this.containerEnvVars());
      const resp = await t.request("/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: input.script })
      });
      if (!resp.ok) throw new Error(`run_http_${resp.status}`);
    } catch (error) {
      job.status = "failed";
      job.finished_at = new Date().toISOString();
      job.error_tail = [
        `container_start: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
      ];
      await this.saveJob(job);
      await this.armCleanup();
      // A failed start may still have left a partially started runtime
      // (start() succeeded but /run failed). Release it before reporting the
      // original error; a release failure is infrastructure, not a script
      // failure, so it propagates as the marker instead.
      await this.stop();
      throw error;
    }
    return job;
  }

  async status(): Promise<BatchJob> {
    const job = await this.loadJob();
    if (!job) {
      return {
        script: "",
        run_date: "",
        status: "failed",
        started_at: "",
        finished_at: null,
        exit_code: null,
        error_tail: ["no_job"]
      };
    }
    if (job.status === "queued" || job.status === "running") {
      await this.refreshFromContainer(job);
    }
    return job;
  }

  private async refreshFromContainer(job: BatchJob): Promise<void> {
    let snap: {
      state?: string;
      exit_code?: number | null;
      error_tail?: unknown;
    };
    try {
      const resp = await this.transport().request("/status");
      if (!resp.ok) return;
      snap = (await resp.json()) as typeof snap;
    } catch {
      return;
    }
    if (snap.state === "finished") {
      job.exit_code = typeof snap.exit_code === "number" ? snap.exit_code : null;
      job.finished_at = new Date().toISOString();
      if (job.exit_code === 0) {
        job.status = "succeeded";
      } else {
        job.status = "failed";
        job.error_tail = Array.isArray(snap.error_tail)
          ? snap.error_tail.slice(-5).map((l) => String(l).slice(0, 300))
          : [`exit_code_${job.exit_code}`];
        console.error(
          JSON.stringify({
            event: "quant_batch_failed",
            job_id: this.jobId(),
            script: job.script,
            exit_code: job.exit_code,
            error_tail: snap.error_tail
          })
        );
      }
      await this.saveJob(job);
      await this.armCleanup();
    }
  }

  async stop(): Promise<void> {
    try {
      await this.transport().stop();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes(CONTAINER_RELEASE_FAILED)) throw error;
      const wrapped = new Error(
        `${CONTAINER_RELEASE_FAILED}: ${msg}`.slice(0, 300),
        { cause: error }
      );
      throw wrapped;
    }
  }
}

export class QuantBatchContainer extends Container<PipelineEnv> {
  defaultPort = 8080;
  // Steps are capped at 4/8/16 h by the workflow; the workflow polls status
  // every 2 min which keeps the container awake for the whole run, and it
  // stops the container explicitly when the job finishes.
  sleepAfter = "30m";

  private readonly runner = new BatchJobRunner(
    this.ctx.storage,
    this.env,
    () => transportOverride ?? this.defaultTransport(),
    () => this.ctx.id.name ?? "",
    {
      schedule: (token) =>
        this.schedule(CLEANUP_AFTER_SECONDS, "onJobCleanup", { token }).then(() => undefined),
      wipe: () =>
        this.ctx.storage.deleteAll().then(() => this.ctx.storage.deleteAlarm())
    }
  );

  private defaultTransport(): BatchTransport {
    return {
      // start() already short-circuits on a running container; a retry after a
      // failed attempt must never throw on a residual "already running" race.
      start: async (envVars) => {
        try {
          await this.start({ envVars, enableInternet: true });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (!/already running/i.test(msg)) throw error;
        }
      },
      request: (path, init) => this.containerFetch(`${CONTAINER_HOST}${path}`, init),
      // Container.stop() only sends SIGTERM and returns before exit; use the
      // SDK's own destroy() — the path verified to release runtimes live —
      // via an adapter so the call is unconditional and the result checked.
      stop: () => {
        const runtime = this.ctx.container!;
        return destroyRunningContainer({
          get running() { return runtime.running; },
          destroy: () => this.destroy()
        });
      }
    };
  }

  // Idle expiry is the fallback release path and must use the same confirmed
  // destruction as the explicit stop, not the base class's SIGTERM.
  async onActivityExpired(): Promise<void> {
    await this.runner.stop();
  }

  jobContext(): Promise<{ script: string; run_date: string } | null> {
    return this.runner.jobContext();
  }

  startJob(input: { script: string; run_date: string }): Promise<BatchJob> {
    return this.runner.startJob(input);
  }

  status(): Promise<BatchJob> {
    return this.runner.status();
  }

  async stopJob(): Promise<ContainerReleaseConfirmation> {
    await this.runner.stop();
    return { container_released: true, release_method: "destroy" };
  }

  async onJobCleanup(payload: unknown): Promise<void> {
    await this.runner.runCleanup(payload);
  }
}

QuantBatchContainer.outboundByHost = {
  [BATCH_OUTBOUND_HOST]: batchOutboundHandler,
  [AI_OUTBOUND_HOST]: aiOutboundHandler
};
