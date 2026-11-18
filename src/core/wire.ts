/** Binary data across the extension ↔ webview boundary. No `vscode` import. */

/**
 * Converts what a webview message can't carry as-is. VS Code passes plain typed arrays
 * (Uint8Array, ...) through as binary, but a Node.js Buffer, whose constructor is "Buffer",
 * falls back to JSON: {"type":"Buffer","data":[...]}, one number per byte. That broke every
 * image and made large photos crawl. Buffers become Uint8Array views of the same memory.
 */
export function toWire(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 8) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    // A Buffer that owns its whole memory is wrapped without copying (large files); a slice
    // of a bigger buffer is copied so only its own bytes travel.
    return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
      ? new Uint8Array(value.buffer)
      : new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => toWire(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = toWire(v, depth + 1);
  }
  return out;
}

/** Bytes from a webview message, whatever shape they arrived in. */
export function fromWire(value: unknown): Buffer | undefined {
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (Array.isArray(value)) {
    return Buffer.from(value as number[]);
  }
  if (value && typeof value === 'object') {
    const o = value as { type?: string; data?: unknown };
    if (o.type === 'Buffer' && Array.isArray(o.data)) {
      return Buffer.from(o.data as number[]);
    }
    return Buffer.from(Object.values(o) as number[]);
  }
  return undefined;
}
