export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function apiError(status: number, message: string): Response {
  return json({ error: message }, { status });
}

export class RequestBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

/**
 * Read a request body with a hard limit on the bytes that are actually
 * consumed. Content-Length is only an early rejection hint: chunked requests
 * and dishonest clients are still bounded while the stream is read.
 */
export async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new RequestBodyTooLargeError(maxBytes);
    }
  }

  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Request body is too large").catch(() => undefined);
        throw new RequestBodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJson<T>(request: Request, maxBytes = 1_000_000): Promise<T> {
  const bytes = await readBodyBytes(request, maxBytes);
  if (bytes.byteLength === 0) {
    throw new SyntaxError("Request body is empty");
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function requireSameOrigin(request: Request): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return apiError(403, "Origin header is required");
  }
  const expected = new URL(request.url).origin;
  if (origin !== expected) {
    return apiError(403, "Invalid origin");
  }
  return null;
}
