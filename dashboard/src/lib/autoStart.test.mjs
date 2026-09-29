/**
 * One-time Auto Edit auto-start — the decision and the durable guard.
 *
 * Pins the contracts that actually matter operationally:
 *   - a version needing a first draft auto-starts exactly once
 *   - refresh / remount / reconnect / reopen cannot start a second one
 *   - a draft or an already-registered version blocks it
 *   - a failure is recorded as failed, never as done
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  AUTO_START_STORAGE_KEY,
  AUTO_START_RUNNING,
  AUTO_START_COMPLETED,
  AUTO_START_FAILED,
  readAutoStartGuard,
  writeAutoStartGuard,
  autoStartDecision,
  autoStartRecord,
} from './autoStart.js';

/** Minimal sessionStorage stand-in — the guard must not need a real browser. */
function fakeStorage(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

const FIRST_DRAFT = {
  editSessionId: 'sess-1',
  sessionStatus: 'active',
  targetAssetVersion: null,
  draftAutoStart: null,
  guardRecord: null,
};

test('a version needing a first draft is auto-started (reason: first_draft_required)', () => {
  const d = autoStartDecision(FIRST_DRAFT);
  assert.equal(d.run, true);
  assert.equal(d.reason, 'first_draft_required');
});

test('no session identity never auto-starts', () => {
  assert.equal(autoStartDecision({ ...FIRST_DRAFT, editSessionId: null }).run, false);
});

test('an absent status is not terminal — the deep-link exchange path still starts', () => {
  // resolve_editor_token historically returns no `status`; a single-use launch
  // token can only be consumed by an active session, so this must not block.
  const d = autoStartDecision({ ...FIRST_DRAFT, sessionStatus: undefined });
  assert.equal(d.run, true);
});

test('a completed session never auto-starts', () => {
  const d = autoStartDecision({ ...FIRST_DRAFT, sessionStatus: 'completed' });
  assert.equal(d.run, false);
  assert.equal(d.reason, 'session_completed');
});

test('a session that already registered a version never auto-starts', () => {
  const d = autoStartDecision({ ...FIRST_DRAFT, targetAssetVersion: 'render-1.3' });
  assert.equal(d.run, false);
  assert.equal(d.reason, 'version_already_registered');
});

test('a durable guard record blocks a second run — whatever its status', () => {
  for (const status of [AUTO_START_RUNNING, AUTO_START_COMPLETED, AUTO_START_FAILED]) {
    const d = autoStartDecision({ ...FIRST_DRAFT, guardRecord: { status } });
    assert.equal(d.run, false, `status=${status} must not re-run`);
    assert.equal(d.reason, `already_${status}`);
  }
});

test('the durable draft blocks it too — the server side of the guard', () => {
  const d = autoStartDecision({ ...FIRST_DRAFT, draftAutoStart: { status: AUTO_START_COMPLETED } });
  assert.equal(d.run, false);
  assert.equal(d.reason, 'draft_already_completed');
});

test('a running guard blocks a re-entry during the render itself', () => {
  const storage = fakeStorage();
  writeAutoStartGuard(storage, 'sess-1', autoStartRecord(AUTO_START_RUNNING, 1));
  const guardRecord = readAutoStartGuard(storage)['sess-1'];
  assert.equal(autoStartDecision({ ...FIRST_DRAFT, guardRecord }).run, false);
});

test('the guard survives a remount: a fresh read of the same storage still blocks', () => {
  const storage = fakeStorage();
  writeAutoStartGuard(storage, 'sess-1', autoStartRecord(AUTO_START_COMPLETED, 42));
  // A remount re-reads storage; no React state or ref is carried over.
  assert.equal(readAutoStartGuard(storage)['sess-1'].status, AUTO_START_COMPLETED);
  assert.equal(autoStartDecision({ ...FIRST_DRAFT, guardRecord: readAutoStartGuard(storage)['sess-1'] }).run, false);
});

test('the guard survives a reload: a fresh page reads the same storage', () => {
  const storage = fakeStorage();
  writeAutoStartGuard(storage, 'sess-1', autoStartRecord(AUTO_START_COMPLETED, 42));
  // Same tab, new page: sessionStorage persists, module memory does not.
  const afterReload = readAutoStartGuard(storage);
  assert.equal(Object.keys(afterReload).length, 1);
  assert.equal(afterReload['sess-1'].status, AUTO_START_COMPLETED);
});

test('records are keyed by edit_session_id — a NEW session is a new first draft', () => {
  const storage = fakeStorage();
  writeAutoStartGuard(storage, 'sess-1', autoStartRecord(AUTO_START_COMPLETED, 1));
  const guard = readAutoStartGuard(storage);
  assert.equal(autoStartDecision({ ...FIRST_DRAFT, guardRecord: guard['sess-1'] }).run, false);
  assert.equal(autoStartDecision({ ...FIRST_DRAFT, editSessionId: 'sess-2', guardRecord: guard['sess-2'] }).run, true,
    'a different session is a different version and needs its own first draft');
  assert.equal(autoStartDecision({ ...FIRST_DRAFT, guardRecord: guard['sess-1'] }).run, false,
    'and the first session stays blocked');
});

test('a failure is recorded as failed — never as done, so retry stays available', () => {
  const storage = fakeStorage();
  writeAutoStartGuard(storage, 'sess-1', autoStartRecord(AUTO_START_FAILED, 7));
  const rec = readAutoStartGuard(storage)['sess-1'];
  assert.equal(rec.status, AUTO_START_FAILED);
  assert.notEqual(rec.status, AUTO_START_COMPLETED);
  // It does not silently re-run (that would render twice on every reopen) and
  // it is not marked done: the operator drives the existing retry affordance.
  assert.equal(autoStartDecision({ ...FIRST_DRAFT, guardRecord: rec }).run, false);
});

test('storage failures are tolerated — a broken sessionStorage never throws', () => {
  const hostile = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.deepEqual(readAutoStartGuard(hostile), {});
  assert.deepEqual(writeAutoStartGuard(hostile, 'sess-1', autoStartRecord(AUTO_START_RUNNING, 1)), {});
  assert.equal(autoStartDecision(FIRST_DRAFT).run, true, 'the decision is unaffected');
});

test('corrupt stored JSON reads as "no record" rather than crashing the editor', () => {
  const storage = fakeStorage({ [AUTO_START_STORAGE_KEY]: '{not json' });
  assert.deepEqual(readAutoStartGuard(storage), {});
});

test('the storage key is the documented one (a rename would silently unlock re-runs)', () => {
  assert.equal(AUTO_START_STORAGE_KEY, 'loom_editor_autostart_v1');
});
