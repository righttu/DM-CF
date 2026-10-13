export interface DlpOutcome {
  action: "BLOCK" | "FLAG" | "NONE";
  findings?: number;
  logId?: string;
  detail?: string;
}

export async function captureDlpOutcome(
  response: Response,
  sink: DlpOutcome[]
): Promise<void> {
  const logId = response.headers.get("cf-aig-log-id") ?? undefined;
  const dlpHeader = response.headers.get("cf-aig-dlp");
  if (dlpHeader) {
    try {
      const parsed = JSON.parse(dlpHeader) as {
        action?: string;
        findings?: unknown;
      };
      if (parsed.action === "BLOCK" || parsed.action === "FLAG") {
        const findings = Array.isArray(parsed.findings)
          ? parsed.findings.length
          : undefined;
        sink.push({ action: parsed.action, findings, logId, detail: "header" });
        return;
      }
    } catch {
    }
  }
  if (response.status === 400 || response.status === 403) {
    try {
      const body = (await response.json()) as {
        error?: { code?: number };
        errors?: { code?: number; message?: string }[];
      };
      const codes: number[] = [];
      if (typeof body?.error?.code === "number") codes.push(body.error.code);
      if (Array.isArray(body?.errors)) {
        for (const e of body.errors) {
          if (typeof e?.code === "number") codes.push(e.code);
        }
      }
      if (codes.includes(2029)) {
        sink.push({ action: "BLOCK", logId, detail: "error_2029_request" });
        return;
      }
      if (codes.includes(2030)) {
        sink.push({ action: "BLOCK", logId, detail: "error_2030_response" });
        return;
      }
    } catch {
    }
  }
}

export function lastBlock(sink: DlpOutcome[]): DlpOutcome | undefined {
  return [...sink].reverse().find((o) => o.action === "BLOCK");
}
