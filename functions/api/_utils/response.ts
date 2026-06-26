export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function apiError(status: number, message: string): Response {
  return json({ error: message }, { status });
}

export async function readJson<T>(request: Request, maxBytes = 1_000_000): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) {
    throw new Error("Request body is too large");
  }
  return request.json() as Promise<T>;
}

export function requireSameOrigin(request: Request): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return null;
  }
  const expected = new URL(request.url).origin;
  if (origin !== expected) {
    return apiError(403, "Invalid origin");
  }
  return null;
}
