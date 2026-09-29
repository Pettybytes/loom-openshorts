/**
 * One-time Auto Edit auto-start.
 *
 * Opening the editor for a version that still needs its FIRST draft runs the
 * EXISTING Auto Edit chain once, automatically. This module contains the
 * decision and the durable record only — it renders nothing, defines no
 * pipeline stage, and is not a second Auto Edit.
 *
 * WHY THE GUARD IS DURABLE (and not a React ref)
 * ----------------------------------------------
 * A render here produces a real asset version and a real review card, so a
 * second invocation is a real defect. A React ref dies with the component, so
 * it cannot stop any of the ways an editor is re-entered:
 *
 *   page refresh            module memory + refs are gone; sessionStorage and
 *                           the server-side draft survive it
 *   React remount /          a fresh component instance re-reads both records
 *   StrictMode double-mount
 *   websocket reconnect /    no component lifecycle at all — only the records
 *   session refresh
 *   reopen from the card     re-reads the durable draft's `auto_start`
 *
 * The record is written BEFORE the render starts (status `running`), so a
 * remount DURING a render cannot start a second one. The status is only moved
 * to `completed` once the chain reported success, and to `failed` when it did
 * not — so a failure is never silently marked done.
 */

export const AUTO_START_STORAGE_KEY = 'loom_editor_autostart_v1';

export const AUTO_START_RUNNING = 'running';
export const AUTO_START_COMPLETED = 'completed';
export const AUTO_START_FAILED = 'failed';

function _storage(storage) {
  if (storage) return storage;
  try { return typeof window !== 'undefined' ? window.sessionStorage : null; } catch (_) { return null; }
}

/** Every auto-start record this tab has written, keyed by edit_session_id. */
export function readAutoStartGuard(storage) {
  try {
    const raw = _storage(storage)?.getItem(AUTO_START_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    // Never hand back a value that would read as "already ran" by accident.
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v && typeof v === 'object'));
  } catch (_) { return {}; }
}

/** Record this session's auto-start state. Returns the whole record, or `{}`
 * when the record could NOT be persisted — a caller must never be told the
 * guard is durable when the write did not land. */
export function writeAutoStartGuard(storage, editSessionId, record) {
  if (!editSessionId) return {};
  const next = {
    ...readAutoStartGuard(storage),
    [editSessionId]: { ...record, edit_session_id: editSessionId },
  };
  try { _storage(storage)?.setItem(AUTO_START_STORAGE_KEY, JSON.stringify(next)); } catch (_) { /* fall through to verification */ }
  // Verify instead of assuming: a blocked/full sessionStorage leaves the guard
  // non-durable, and the caller must not mistake that for a persisted record.
  return readAutoStartGuard(storage)[editSessionId] ? next : {};
}

/**
 * The ONE decision. Returns `{ run, reason }`.
 *
 * `run` is true only when a first draft is genuinely required and nothing
 * durable says this session already started it.
 */
export function autoStartDecision({
  editSessionId,
  sessionStatus,
  targetAssetVersion,
  draftAutoStart,
  guardRecord,
} = {}) {
  if (!editSessionId) return { run: false, reason: 'no_session' };
  // A terminal session is never reopened for new mutations. An ABSENT status is
  // not terminal (the deep-link exchange path consumes a single-use token, which
  // only an active session can present), so it must not block a legit first run.
  if (sessionStatus && String(sessionStatus) !== 'active') {
    return { run: false, reason: `session_${String(sessionStatus)}` };
  }
  if (targetAssetVersion) return { run: false, reason: 'version_already_registered' };
  if (guardRecord?.status) return { run: false, reason: `already_${guardRecord.status}` };
  if (draftAutoStart?.status) return { run: false, reason: `draft_already_${draftAutoStart.status}` };
  return { run: true, reason: 'first_draft_required' };
}

/** The record to persist at a given moment; one shape for storage and draft. */
export function autoStartRecord(status, at) {
  return { started: true, status, at: Number(at) || 0 };
}
