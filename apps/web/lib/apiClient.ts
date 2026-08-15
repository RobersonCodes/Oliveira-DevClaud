/**
 * Centralized HTTP/WebSocket/SSE client for the whole control plane frontend (Fase 1 hardening).
 *
 * Every call is same-origin and relative (`/api/v1/...`) — never an absolute
 * `NEXT_PUBLIC_API_URL`. In production, nginx routes `/api/` straight to the api service before the
 * request ever reaches this Next.js app (infra/production/nginx.prod.conf); in dev, next.config.js
 * rewrites `/api/*` to the local API process. Neither the browser nor this bundle ever needs to know
 * the API's real host, which is what eliminates the whole class of bugs where a forgotten/blank
 * NEXT_PUBLIC_API_URL build-arg silently fell back to a hardcoded `localhost:4000` in production
 * (P0-11/P0-12) — there is no such variable left to forget.
 *
 * This is also the single place that owns "what happens when the session is gone": every page that
 * uses apiFetch/apiJson gets the same 401 -> redirect to /login behavior, instead of each page
 * inventing (or forgetting to invent) its own handling.
 */

const LOGIN_PATH = '/login';

/** The auth endpoints themselves must be allowed to return a real 401 (e.g. wrong password) without
 * triggering a redirect loop back to the page the user is already on. */
function isAuthEndpoint(path: string): boolean {
  return path.startsWith('/api/v1/auth/');
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `API_ERROR_${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Same-origin fetch wrapper. Always sends the session cookie; on a 401 from anything other than the
 * auth endpoints, redirects to /login instead of letting the caller render a silently-broken page.
 * The returned promise deliberately never resolves in that case — navigation is already underway,
 * and the component that called this is about to be torn down anyway, so there is nothing useful to
 * hand back to it.
 */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, { ...init, credentials: 'include' }).then(res => {
    if (res.status === 401 && !isAuthEndpoint(path) && typeof window !== 'undefined') {
      window.location.href = LOGIN_PATH;
      return new Promise<Response>(() => {});
    }
    return res;
  });
}

/**
 * apiFetch + JSON parsing + throwing ApiError on a non-ok response, for callers that prefer
 * try/catch over manually checking `res.ok`. Not every page uses this — many keep their own
 * `res.ok` handling to preserve their existing per-field error messages — but new call sites should
 * prefer it.
 */
export async function apiJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await apiFetch(path, { ...init, headers });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!res.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP_${res.status}`;
    throw new ApiError(res.status, body, message);
  }
  return body as T;
}

/** Derives ws://.../wss://... from the page's own origin — never a separately configured URL, so
 * WebSocket always ends up on the exact same origin (and TLS posture) as the page that opened it. */
export function apiWebSocketUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}${path}`;
}

export function apiWebSocket(path: string): WebSocket {
  return new WebSocket(apiWebSocketUrl(path));
}

/** Same-origin Server-Sent Events (used by the onboarding wizard's live setup-job progress). */
export function apiEventSource(path: string): EventSource {
  return new EventSource(path, { withCredentials: true });
}
