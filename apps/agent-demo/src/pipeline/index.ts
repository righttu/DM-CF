import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import { QuantBatchContainer, type DailyParams, type PipelineEnv } from "./batch.js";
import { runDailyPipeline, scheduledTick, type StepLike } from "./workflow.js";

export { ContainerProxy } from "@cloudflare/containers";
export { QuantBatchContainer };
export type { PipelineEnv, DailyParams };

export class QuantDailyWorkflow extends WorkflowEntrypoint<PipelineEnv, DailyParams> {
  async run(event: Readonly<WorkflowEvent<DailyParams>>, step: WorkflowStep): Promise<unknown> {
    const params = event.payload ?? {};
    const instanceId = (event as { instanceId?: string }).instanceId ?? "manual";
    return runDailyPipeline(this.env, instanceId, params, step as StepLike);
  }
}

export default {
  async scheduled(controller: ScheduledController, env: PipelineEnv): Promise<void> {
    await scheduledTick(env, new Date(), controller.cron);
  },
  async fetch(): Promise<Response> {
    return new Response("abc-quant-pipeline", { status: 200 });
  }
};
