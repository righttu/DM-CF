import { __setModelBindingForTests } from "../src/agent/index.js";

type FakeInit = { body: string; headers: Record<string, string> };
type Responder = (input: string, init: FakeInit) => Promise<Response>;

function errorCode(body: unknown): number | undefined {
  const rec = (body ?? {}) as {
    error?: { code?: number } | { code?: number }[];
    errors?: { code?: number }[];
    internalCode?: number;
  };
  const first = Array.isArray(rec.error) ? rec.error[0] : rec.error;
  return rec.errors?.[0]?.code ?? first?.code ?? rec.internalCode;
}

export function setModelFake(impl: Responder | undefined): void {
  if (!impl) {
    __setModelBindingForTests(undefined);
    return;
  }
  const binding = {
    aiGatewayLogId: null as string | null,
    async run(model: unknown, inputs: unknown, options: unknown) {
      const gateway = (options as { gateway?: { id?: string; metadata?: unknown } } | undefined)
        ?.gateway;
      const headers: Record<string, string> = {};
      if (gateway?.id) headers["x-gateway-id"] = gateway.id;
      if (gateway?.metadata) headers["cf-aig-metadata"] = JSON.stringify(gateway.metadata);
      const resp = await impl(`workers-ai://${String(model)}`, {
        body: JSON.stringify(inputs),
        headers
      });
      binding.aiGatewayLogId = resp.headers.get("cf-aig-log-id");
      const text = await resp.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
      }
      const dlp = resp.headers.get("cf-aig-dlp");
      if (dlp && (JSON.parse(dlp) as { action?: string }).action === "BLOCK") {
        throw new Error("2029: blocked by DLP policy");
      }
      if (!resp.ok) {
        const code = errorCode(json);
        throw new Error(`${code ?? resp.status}: gateway error`);
      }
      return json;
    }
  };
  __setModelBindingForTests(binding);
}
