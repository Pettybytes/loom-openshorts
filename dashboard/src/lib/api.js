// Centralized API client for cloud mode.
// Adds the Authorization: Bearer header from the stored session token, and turns
// a 402 (quota exceeded) into a typed QuotaError the UI can catch to prompt a top-up.
import { getApiUrl } from '../config';

export const AUTH_TOKEN_KEY = 'openshorts_auth';

export const getToken = () => localStorage.getItem(AUTH_TOKEN_KEY) || '';
export const setToken = (t) => localStorage.setItem(AUTH_TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(AUTH_TOKEN_KEY);

// Editor session token (Discord Activity / LOOM editor). When set, it overrides
// the OpenShorts auth token on /api/* calls so the LOOM adapter gateway can
// authorize the request against the short-lived editor session instead of the
// user's OpenShorts session. This is scoped to the editor mount; it is never
// persisted to storage.
let editorSessionToken = '';
export const setEditorSessionToken = (t) => { editorSessionToken = t || ''; };
export const clearEditorSessionToken = () => { editorSessionToken = ''; };
export const getEditorSessionToken = () => editorSessionToken;

export class QuotaError extends Error {
  constructor(detail) {
    super('quota_exceeded');
    this.name = 'QuotaError';
    this.minutesRequired = detail?.minutes_required;
    this.minutesRemaining = detail?.minutes_remaining;
  }
}

// Drop-in fetch wrapper. Always attaches the bearer token when present.
export async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  // The editor session token takes precedence over the OpenShorts auth token:
  // in the embedded Activity the /api/* calls are gated by the LOOM adapter
  // against the short-lived editor session, not the user's OpenShorts login.
  const token = editorSessionToken || getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(getApiUrl(path), { ...options, headers });

  if (res.status === 402) {
    let detail = {};
    try {
      const body = await res.clone().json();
      detail = body.detail || body;
    } catch (_) { /* ignore */ }
    throw new QuotaError(detail);
  }
  return res;
}

// A failed request, carrying the server's own explanation. Callers that show an
// alert should prefer `detail` — the generic "something went wrong" strings hid
// real, actionable messages (e.g. a declined card blocking checkout).
export class ApiError extends Error {
  constructor(status, detail, raw) {
    super(`${status}: ${raw}`);   // message kept verbatim for existing callers
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

// Convenience JSON helper.
export async function apiJson(path, options = {}) {
  const res = await apiFetch(path, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = '';
    try {
      const d = JSON.parse(text).detail;
      // FastAPI details are strings here, but validation errors arrive as objects.
      if (typeof d === 'string') detail = d;
    } catch (_) { /* not JSON — leave detail empty and fall back to the caller's copy */ }
    throw new ApiError(res.status, detail, text);
  }
  return res.json();
}
