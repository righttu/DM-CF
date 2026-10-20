import agentWorker, { ResearchAgent } from "../src/agent/index.js";
import mcpWorker, { ConsentTransaction } from "../src/mcp/index.js";
import { DurableObject } from "cloudflare:workers";
import quantWorker, {
  QuantEmbeddingContainer,
  type QuantEnv
} from "../src/quant/index.js";
import {
  AnalysisJobRunner,
  analysisTransport,
  type AnalysisEnv,
  type AnalysisJob
} from "../src/quant/analysis.js";

// Records stop()/wipe() ordering for the cleanup test (same isolate as the
// test module, so it can be asserted directly).
export const analysisCleanupEvents: string[] = [];

// Test stand-in for the production QuantAnalysisContainer: the container
// runtime (ctx.container) is unavailable in the local pool, so the ANALYSIS
// binding maps to a plain Durable Object that runs the same job logic against
// the injected transport stub.
class TestQuantAnalysisContainer extends DurableObject<QuantEnv & AnalysisEnv> {
  private readonly runner = new AnalysisJobRunner(
    this.ctx.storage,
    this.env,
    () =>
      analysisTransport() ?? {
        start: () => Promise.reject(new Error("no_transport_stub")),
        request: () => Promise.reject(new Error("no_transport_stub")),
        stop: () => Promise.resolve()
      },
    () => this.ctx.id.name ?? "",
    (seconds) => this.ctx.storage.setAlarm(Date.now() + seconds * 1000),
    {
      // No library schedule() in the local pool: record the armed token and let
      // tests trigger the same runCleanup path via runCleanup().
      schedule: (token) => this.ctx.storage.put("cleanup_scheduled", token),
      wipe: () => {
        analysisCleanupEvents.push("wipe");
        return this.ctx.storage.deleteAll().then(() => this.ctx.storage.deleteAlarm());
      }
    }
  );

  jobContext(): Promise<{ ts_code: string; date: string } | null> {
    return this.runner.jobContext();
  }

  startJob(input: { ts_code: string; date: string; requested_by: string }): Promise<AnalysisJob> {
    return this.runner.startJob(input);
  }

  status(): Promise<AnalysisJob> {
    return this.runner.status();
  }

  alarm(): Promise<void> {
    return this.runner.onTimeout();
  }

  async runCleanup(): Promise<void> {
    const token = await this.ctx.storage.get("cleanup_scheduled");
    await this.runner.runCleanup({ token });
  }
}

import {
  BatchJobRunner,
  batchTransport,
  type BatchJob,
  type PipelineEnv
} from "../src/pipeline/batch.js";
import type { ContainerReleaseConfirmation } from "../src/shared/container-lifecycle.js";

// Same pattern as the analysis test DO: no container runtime in the pool, so
// BATCH maps to a plain Durable Object running the same job logic.
class TestQuantBatchContainer extends DurableObject<PipelineEnv> {
  private readonly runner = new BatchJobRunner(
    this.ctx.storage,
    this.env,
    () =>
      batchTransport() ?? {
        start: () => Promise.reject(new Error("no_transport_stub")),
        request: () => Promise.reject(new Error("no_transport_stub")),
        stop: () => Promise.resolve()
      },
    () => this.ctx.id.name ?? "",
    {
      schedule: (token) => this.ctx.storage.put("cleanup_scheduled", token),
      wipe: () => this.ctx.storage.deleteAll().then(() => this.ctx.storage.deleteAlarm())
    }
  );

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

  async runCleanup(): Promise<void> {
    const token = await this.ctx.storage.get("cleanup_scheduled");
    await this.runner.runCleanup({ token });
  }
}

export {
  ResearchAgent,
  ConsentTransaction,
  QuantEmbeddingContainer,
  TestQuantAnalysisContainer as QuantAnalysisContainer,
  TestQuantBatchContainer as QuantBatchContainer
};

const MCP_PATHS = ["/mcp", "/authorize", "/token", "/register", "/.well-known"];
const QUANT_PREFIX = "/quant";

export default {
  fetch(request: Request, env: never, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === QUANT_PREFIX || url.pathname.startsWith(`${QUANT_PREFIX}/`)) {
      const inner = new URL(request.url);
      inner.pathname = inner.pathname.slice(QUANT_PREFIX.length) || "/";
      return (quantWorker as { fetch: (r: Request, e: never, c: ExecutionContext) => Promise<Response> }).fetch(
        new Request(inner.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: "manual"
        }),
        env,
        ctx
      );
    }
    const isMcp = MCP_PATHS.some(
      (p) => url.pathname === p || url.pathname.startsWith(`${p}/`)
    );
    if (isMcp) {
      return (mcpWorker as { fetch: (r: Request, e: never, c: ExecutionContext) => Promise<Response> }).fetch(request, env, ctx);
    }
    return (agentWorker as { fetch: (r: Request, e: never, c: ExecutionContext) => Promise<Response> }).fetch(request, env, ctx);
  }
};
