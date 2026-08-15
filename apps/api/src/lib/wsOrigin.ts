// Exact-string comparison against WEB_ORIGIN — never a prefix/suffix/hostname check. A suffix check
// (e.g. "does origin end with seudominio.com") would let "https://evil.com?x=app.seudominio.com" or
// a real but unintended host like "https://notapp.seudominio.com" slip through. A WebSocket upgrade
// request's Origin header is set by the browser itself and cannot be overridden by page script, so
// an exact match against the single configured web origin is a reliable defense against a malicious
// site opening a cross-site WebSocket that rides the victim's session cookie.
export function isAllowedWsOrigin(origin: string | string[] | undefined): boolean {
  const allowed = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  return typeof origin === 'string' && origin === allowed;
}
