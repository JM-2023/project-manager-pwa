import type { AppContext } from "./api/_utils/types";

// The app is fully self-contained (no external scripts, fonts, or API hosts),
// so everything locks to 'self'. 'unsafe-inline' for styles covers React's
// style attributes; blob: under img/worker covers export downloads and the
// Vite-emitted Excel worker.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

export async function onRequest(context: AppContext): Promise<Response> {
  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, noimageindex");
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
