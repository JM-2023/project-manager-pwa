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

// Pages gives every upload its own address (<hash>.<project>.pages.dev) and
// every preview branch an alias (<branch>.<project>.pages.dev), and each one
// is a full working copy of the app — that upload's code — on the live
// database. Only the project's own address (<project>.pages.dev) may serve
// the app; the rest answer as if nothing were there. Local dev hosts and any
// custom domain pass.
export function isSideAddress(hostname: string): boolean {
  return hostname.endsWith(".pages.dev") && hostname.split(".").length > 3;
}

// Responses that pass through a Function don't get _headers' path rules, so
// the ones that must revalidate on every load are restated here.
const NO_CACHE_PATHS = new Set(["/", "/index.html", "/sw.js"]);

export async function onRequest(context: AppContext): Promise<Response> {
  const url = new URL(context.request.url);
  if (isSideAddress(url.hostname)) {
    return new Response("Not found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow, noarchive, noimageindex"
      }
    });
  }
  const response = await context.next();
  const headers = new Headers(response.headers);
  if (NO_CACHE_PATHS.has(url.pathname)) headers.set("Cache-Control", "no-cache");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, noimageindex");
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
