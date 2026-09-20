// Clip identity resolution + API-path guarding.
//
// The live defect this closes: the editor mounted with a session whose
// `job_id` was undefined (a retained session restored from sessionStorage that
// predated the job/clip fields, or a session object that never carried them)
// and immediately issued `GET /api/status/undefined` plus
// `/api/clip/undefined/0/{edl,transcript,scenes}` — with no credential at all,
// because the session token was missing too. The server (correctly) rejected
// them, but the client should never have built the request in the first place.
//
// Contract: a clip API request is only issued once a VALID job_id and a
// non-negative integer clip_index are resolved. Anything else resolves to
// `ok:false` with a reason, and `clipApiPath` returns null — there is no code
// path that renders `undefined` into a URL.

export const CLIP_IDENTITY_ERROR = 'clip_identity_unresolved';

// Literal string spellings that mean "this value never resolved". They are the
// exact tokens that showed up in the defect (`undefined:0`).
const UNRESOLVED_TOKENS = new Set(['undefined', 'null', 'NaN']);

export function isResolvedSegment(value) {
  if (value === undefined || value === null) return false;
  const s = String(value).trim();
  return s !== '' && !UNRESOLVED_TOKENS.has(s);
}

/**
 * Resolve the clip identity carried by an editor session.
 * @returns {{ok:true, jobId:string, clipIndex:number}
 *          |{ok:false, reason:'no_session'|'job_id_unresolved'|'clip_index_unresolved'}}
 */
export function resolveClipIdentity(session) {
  if (!session || typeof session !== 'object') {
    return { ok: false, reason: 'no_session' };
  }
  const rawJobId = session.job_id ?? session.jobId;
  if (!isResolvedSegment(rawJobId)) {
    return { ok: false, reason: 'job_id_unresolved' };
  }
  const rawIndex = session.clip_index ?? session.clipIndex ?? 0;
  if (!isResolvedSegment(rawIndex)) {
    return { ok: false, reason: 'clip_index_unresolved' };
  }
  const clipIndex = Number(rawIndex);
  if (!Number.isInteger(clipIndex) || clipIndex < 0) {
    return { ok: false, reason: 'clip_index_unresolved' };
  }
  return { ok: true, jobId: String(rawJobId), clipIndex };
}

/**
 * Build a clip sub-resource path, or null when the identity is unresolved.
 * `clipApiPath(session, 'transcript')` -> '/api/clip/<job>/<idx>/transcript'
 */
export function clipApiPath(session, resource) {
  const identity = resolveClipIdentity(session);
  if (!identity.ok) return null;
  return `/api/clip/${identity.jobId}/${identity.clipIndex}/${resource}`;
}

/** Path for a job-scoped read (e.g. '/api/status/<job>'), or null. */
export function jobApiPath(session, prefix = '/api/status') {
  const identity = resolveClipIdentity(session);
  if (!identity.ok) return null;
  return `${prefix}/${identity.jobId}`;
}

export class ClipIdentityError extends Error {
  constructor(path) {
    super(`refusing to request an unresolved API path: ${path}`);
    this.name = 'ClipIdentityError';
    this.code = CLIP_IDENTITY_ERROR;
    this.path = path;
  }
}

/**
 * Last line of defence at the transport layer: throw before a fetch is issued
 * for any path containing an unresolved segment. Existing, valid paths (which
 * never contain these tokens) pass through untouched.
 */
export function assertResolvedApiPath(path) {
  if (path === undefined || path === null) throw new ClipIdentityError(path);
  const segments = String(path).split('/');
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i] === '' || UNRESOLVED_TOKENS.has(segments[i])) {
      throw new ClipIdentityError(path);
    }
  }
  return path;
}
