export const MAX_BODY_BYTES = 16384;

export async function readBoundedText(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES
): Promise<{ status: 200; text: string } | { status: 413 }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) return { status: 413 };
  }
  if (!request.body) return { status: 200, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      if (total > maxBytes) {
        await reader.cancel();
        return { status: 413 };
      }
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: 200, text: new TextDecoder().decode(merged) };
}
