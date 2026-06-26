import type { AppContext } from "./api/_utils/types";

export async function onRequest(context: AppContext): Promise<Response> {
  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
