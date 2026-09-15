import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Download, Wand2, Type, Scissors, Crosshair, ArrowLeft, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { getApiUrl } from '../config';
import { apiFetch, setEditorSessionToken, clearEditorSessionToken, editorTokenFingerprint, getEditorSessionToken } from '../lib/api';
import { realignCaptions } from '../lib/captionRealign';
import SubtitleModal from './SubtitleModal';
import HookModal from './HookModal';

// Relative public paths: the editor is served from the same public origin as
// the LOOM adapter (Caddy funnel), so the exchange/complete calls and the
// authenticated /api/* calls all resolve same-origin. Env overrides remain for
// the local dev scaffold, but the default is the production path.
const EDITOR_EXCHANGE_URL =
  import.meta.env.VITE_EDITOR_EXCHANGE_URL || '/discord/editor/exchange';
const EDITOR_COMPLETE_URL =
  import.meta.env.VITE_EDITOR_COMPLETE_URL || '/discord/editor/complete';
const EDITOR_BOOTSTRAP_URL =
  import.meta.env.VITE_EDITOR_BOOTSTRAP_URL || '/discord/editor/bootstrap';

function fmt(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  const m = Math.floor(Math.abs(n) / 60);
  const sec = (Math.abs(n) % 60).toFixed(1).padStart(4, '0');
  return `${n < 0 ? '-' : ''}${m}:${sec}`;
}

function seekTo(videoRef, t) {
  const v = videoRef.current;
  if (!v) return;
  try { v.currentTime = Math.max(0, Number(t)); } catch (_) { /* ignore */ }
}

function outputBasename(url) {
  if (!url) return '';
  try {
    const u = new URL(url, 'http://localhost');
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
  } catch (_) { return ''; }
}

const ALIGNMENT_LABEL = {
  preserved: { text: 'preserved', cls: 'text-emerald-400' },
  redistributed: { text: 'redistributed', cls: 'text-amber-400' },
  realignment_required: { text: 'realignment required (audio)', cls: 'text-red-400' },
};

const PROGRESS_ORDER = ['save', 'render', 'register', 'card'];
const PROGRESS_LABEL = {
  save: 'draft saved',
  render: 'rendered',
  register: 'registered',
  card: 're-review card sent',
};

// --- External HTTPS /edit bootstrap -------------------------------------
// The single-use launch token is exchanged EXACTLY ONCE per page load. React
// StrictMode double-invokes effects in dev, and the token is stripped from the
// URL via history.replaceState on the first pass — so a later pass must NOT
// treat the now-absent token as an error, and must NOT re-exchange (the server
// token is single-use). We retain the authenticated session in module memory
// (page lifecycle) and in sessionStorage (session-scoped: survives a reload,
// dies with the tab). The single-use launch token is never persisted anywhere.
const EDITOR_SESSION_STORAGE_KEY = 'loom_e…n_v1';
let _exchangePromise = null;   // in-flight (or resolved) single exchange
let _resolvedSession = null;   // authenticated session, retained for the page

function loadStoredEditorSession() {
  try {
    const raw = sessionStorage.getItem(EDITOR_SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}
function storeEditorSession(session) {
  try { sessionStorage.setItem(EDITOR_SESSION_STORAGE_KEY, JSON.stringify(session)); } catch (_) { /* ignore */ }
}
function clearStoredEditorSession() {
  try { sessionStorage.removeItem(EDITOR_SESSION_STORAGE_KEY); } catch (_) { /* ignore */ }
}

export default function ManualTrimEditor({ initialSession = null, activityUser = null, onReauthenticate = null }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [clipUrl, setClipUrl] = useState(null);
  const [edl, setEdl] = useState(null);
  const [words, setWords] = useState([]);          // caption words {text,startMs,endMs}
  const [scenes, setScenes] = useState([]);
  const [canonical, setCanonical] = useState({ start: 0, end: 0 });
  const [clipDurationSec, setClipDurationSec] = useState(0); // clip-relative timeline length

  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [framing, setFraming] = useState('auto');
  const [captionText, setCaptionText] = useState('');
  const [originalCaptionText, setOriginalCaptionText] = useState('');
  const [captionPosition, setCaptionPosition] = useState('bottom');
  const [captionStyle, setCaptionStyle] = useState('classic');
  const [captionUppercase, setCaptionUppercase] = useState(false);
  const [captionFontName, setCaptionFontName] = useState('Verdana');
  const [captionFontSize, setCaptionFontSize] = useState(24);
  const [captionFontColor, setCaptionFontColor] = useState('#FFFFFF');
  const [captionHighlightColor, setCaptionHighlightColor] = useState('#FFDD00');
  const [captionBorderColor, setCaptionBorderColor] = useState('#000000');
  const [captionBorderWidth, setCaptionBorderWidth] = useState(2);
  const [captionBgColor, setCaptionBgColor] = useState('#000000');
  const [captionBgOpacity, setCaptionBgOpacity] = useState(0.0);
  const [captionEffect, setCaptionEffect] = useState('none');
  const [captionBaseOpacity, setCaptionBaseOpacity] = useState(1.0);
  const [hookPosition, setHookPosition] = useState('top');
  const [hookSize, setHookSize] = useState('M');
  const [hookStyle, setHookStyle] = useState('classic');
  const [hookDuration, setHookDuration] = useState(5);
  const [instruction, setInstruction] = useState('');
  const [title, setTitle] = useState('');
  const [hook, setHook] = useState('');
  const [socialCaption, setSocialCaption] = useState('');
  const [rerendering, setRerendering] = useState(false);
  const [progress, setProgress] = useState(null);   // {stage, detail} or null
  const [result, setResult] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [showSubtitleModal, setShowSubtitleModal] = useState(false);
  const [showHookModal, setShowHookModal] = useState(false);

  const videoRef = useRef(null);

  // --- 1. Session acquisition -----------------------------------------------
  useEffect(() => {
    if (initialSession) {
      if (initialSession.session_token) setEditorSessionToken(initialSession.session_token);
      setSession({
        ...initialSession,
        job_id: initialSession.job_id,
        clip_index: Number(initialSession.clip_index ?? 0),
      });
      setLoading(false);
      return;
    }

    // Capture the launch token (if present) and strip it from the URL. The
    // token is single-use and never persisted; the URL is sanitized so a
    // reload or referer cannot replay it.
    const token = new URLSearchParams(window.location.search).get('token');
    if (window.location.search) history.replaceState({}, '', '/edit');

    // Restore a previously-authenticated session. React StrictMode double-
    // invokes effects in dev and route remounts remount this component, so a
    // session retained from an earlier pass (or a reload) must be reused —
    // never mistaken for "missing token".
    const retained = _resolvedSession || loadStoredEditorSession();
    if (retained) {
      // Re-seed module memory so the autosave below merges into the FULL
      // session (token/job/clip identity) instead of clobbering storage with
      // {draft} only — the root cause of preview/transcript loss on reload.
      _resolvedSession = retained;
      if (retained.session_token) setEditorSessionToken(retained.session_token);
      setSession({ ...retained, job_id: retained.job_id, clip_index: Number(retained.clip_index ?? 0) });
      setLoading(false);
      return;
    }

    // One exchange per page load, shared across effect invocations. If an
    // exchange is already in flight (StrictMode double-mount), reuse it — never
    // re-exchange the consumed single-use token.
    let promise = _exchangePromise;
    if (!promise && token) {
      promise = _exchangePromise = (async () => {
        const res = await fetch(EDITOR_EXCHANGE_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (!data.ok || !data.session) {
          throw new Error(data.error || 'Could not open the editor session.');
        }
        return data.session;
      })();
    }

    if (!promise) {
      // No token, no retained session, no in-flight exchange: genuine state.
      setError("No editor session is pending — open it from the review card's Edit button.");
      setLoading(false);
      return;
    }

    let cancelled = false;
    promise
      .then((s) => {
        if (cancelled) return;
        if (s?.session_token) setEditorSessionToken(s.session_token);
        _resolvedSession = s;
        storeEditorSession(s);
        setSession({ ...s, job_id: s?.job_id, clip_index: Number(s?.clip_index ?? 0) });
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        _exchangePromise = null; // allow a future retry with a fresh token
        setError(e?.message || 'Could not open the editor session.');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [initialSession]);

  // Clear the injected editor session token on unmount so a later OpenShorts
  // session in the same tab never reuses a stale editor credential.
  useEffect(() => () => clearEditorSessionToken(), []);

  // --- 2. Load durable clip metadata (bootstrap) + optional live enhancement -----
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const { job_id, clip_index } = session;
        if (!job_id) throw new Error('Editor session is missing its clip identity — reopen the clip from the review card.');

        // --- Durable bootstrap: the REQUIRED source of truth -----------------
        // Resolves the exact review asset from LOOM media/version records.
        // Never depends on the transient OpenShorts /api/status runtime state,
        // so a durable review card reopens even after the render job is evicted.
        const bsRes = await apiFetch(EDITOR_BOOTSTRAP_URL);
        if (!bsRes.ok) {
          let msg = `Bootstrap failed (HTTP ${bsRes.status})`;
          try { const b = await bsRes.json(); if (b?.detail) msg = b.detail; else if (b?.error) msg = b.error; } catch (_) { /* ignore */ }
          throw new Error(msg);
        }
        const db = await bsRes.json();

        // Required durable fields — hard fail, NEVER 0:00 duration or 0/0 trim.
        const src = db?.source_range || {};
        const start = Number(src?.start);
        const end = Number(src?.end);
        const dur = Number(db?.duration_seconds);
        if (!db?.media_url || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          throw new Error('Durable clip data is unavailable for this asset — reopen the review card or re-render.');
        }

        if (db.media_url) setClipUrl(getApiUrl(db.media_url));
        setCanonical({ start, end });
        setTrimStart(start); setTrimEnd(end);
        if (Number.isFinite(dur) && dur > 0) setClipDurationSec(dur);
        if (db.framing === 'full' || db.framing === 'track') setFraming(db.framing);
        if (db.title != null) setTitle(db.title);
        if (db.hook != null) setHook(db.hook);
        if (db.social_caption != null) setSocialCaption(db.social_caption);

        // Spoken captions: word-level blocks from the durable correction log.
        const capWords = Array.isArray(db.captions) ? db.captions : [];
        if (capWords.length) {
          setWords(capWords);
          const joined = capWords.map(x => x?.text ?? x?.word ?? '').filter(Boolean).join(' ');
          setOriginalCaptionText(db.caption_text || joined);
          setCaptionText(db.caption_text || joined);
        }
        setScenes(Array.isArray(db.scenes) ? db.scenes : []);

        // --- Optional live-job enhancement (best-effort; 404 is ignored) ----
        // A live OpenShorts job may return a fresher preview/scenes. Never
        // required, never the source of truth, never throws on eviction.
        try {
          const stRes = await apiFetch(`/api/status/${job_id}`);
          if (stRes.ok) {
            const st = await stRes.json();
            const clips = st?.result?.clips || st?.clips || [];
            const cl = clips[clip_index] || clips[0];
            const rawUrl = cl?.video_url || cl?.view_url || null;
            if (rawUrl) setClipUrl(getApiUrl(rawUrl));
          }
        } catch (_) { /* ignore */ }

        try {
          const edlRes = await apiFetch(`/api/clip/${job_id}/${clip_index}/edl`);
          if (edlRes.ok) {
            const e = await edlRes.json();
            setEdl(e);
            const cr = e.canonical_range || {};
            const s2 = Number(cr.start ?? 0);
            const en2 = Number(cr.end ?? e.source?.duration ?? 0);
            if (Number.isFinite(s2) && Number.isFinite(en2) && en2 > s2) {
              setCanonical({ start: s2, end: en2 });
              setTrimStart(s2); setTrimEnd(en2);
            }
            if (e.framing === 'full' || e.framing === 'track') setFraming(e.framing);
          }
        } catch (_) { /* ignore */ }

        try {
          const tRes = await apiFetch(`/api/clip/${job_id}/${clip_index}/transcript`);
          if (tRes.ok) {
            const t = await tRes.json();
            // /transcript returns {captions:[…], durationSec} (object), never a
            // bare array — normalize defensively to the word array.
            const w = Array.isArray(t) ? t : (Array.isArray(t?.captions) ? t.captions : (Array.isArray(t?.words) ? t.words : (Array.isArray(t?.segments) ? t.segments : [])));
            if (w.length) {
              setWords(w);
              // The transcript words are CLIP-relative (0..durationSec). Record
              // the clip timeline length so caption realignment uses the clip
              // timeline, never the source-time trim window.
              if (Number.isFinite(Number(t?.durationSec))) setClipDurationSec(Number(t.durationSec));
              else if (w.length) setClipDurationSec(Math.max(...w.map(x => Number(x?.endMs ?? 0))) / 1000);
              const joined = w.map(x => x?.text ?? x?.word ?? x?.w ?? '').filter(Boolean).join(' ');
              setOriginalCaptionText(joined);
              // A persisted draft caption (edited) wins over the transcript default.
              setCaptionText(session.draft?.caption_text ?? joined);
            }
          }
        } catch (_) { /* ignore */ }

        try {
          const scRes = await apiFetch(`/api/clip/${job_id}/${clip_index}/scenes`);
          if (scRes.ok) {
            const sd = await scRes.json();
            // /scenes returns {scenes:[…], saved_overrides, …} (object) — the
            // .map below would otherwise throw "(scenes || []).map is not a function".
            setScenes(Array.isArray(sd) ? sd : (Array.isArray(sd?.scenes) ? sd.scenes : []));
          }
        } catch (_) { /* ignore */ }

        // Restore a previously persisted draft (survives reload). Runs LAST so
        // the user's in-progress edits always win over both durable bootstrap
        // defaults AND any live-job enhancement. title/hook/social caption/
        // subtitle controls + trim + framing + caption text all persist.
        const d = session.draft;
        if (d) {
          if (d.trim_start != null && d.trim_end != null) {
            setTrimStart(Number(d.trim_start));
            setTrimEnd(Number(d.trim_end));
          }
          if (d.framing) setFraming(d.framing);
          if (d.title != null) setTitle(d.title);
          if (d.hook != null) setHook(d.hook);
          if (d.social_caption != null) setSocialCaption(d.social_caption);
          if (d.caption_text != null) setCaptionText(d.caption_text);
          if (d.caption_position) setCaptionPosition(d.caption_position);
          if (d.caption_style) setCaptionStyle(d.caption_style);
          if (d.caption_uppercase != null) setCaptionUppercase(d.caption_uppercase);
          if (d.caption_font_name) setCaptionFontName(d.caption_font_name);
          if (d.caption_font_size != null) setCaptionFontSize(d.caption_font_size);
          if (d.caption_font_color) setCaptionFontColor(d.caption_font_color);
          if (d.caption_highlight_color) setCaptionHighlightColor(d.caption_highlight_color);
          if (d.caption_border_color) setCaptionBorderColor(d.caption_border_color);
          if (d.caption_border_width != null) setCaptionBorderWidth(d.caption_border_width);
          if (d.caption_bg_color) setCaptionBgColor(d.caption_bg_color);
          if (d.caption_bg_opacity != null) setCaptionBgOpacity(d.caption_bg_opacity);
          if (d.caption_effect) setCaptionEffect(d.caption_effect);
          if (d.caption_base_opacity != null) setCaptionBaseOpacity(d.caption_base_opacity);
          if (d.hook_position) setHookPosition(d.hook_position);
          if (d.hook_size) setHookSize(d.hook_size);
          if (d.hook_style) setHookStyle(d.hook_style);
          if (d.hook_duration != null) setHookDuration(d.hook_duration);
          if (d.instruction != null) setInstruction(d.instruction);
        }
      } catch (e) {
        if (!cancelled) setError('Failed to load clip: ' + (e && e.message ? e.message : String(e)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [session]);

  // --- 3. Caption timing redistribution (deterministic) ---------------------------
  // Realignment is bounded by the CLIP-relative timeline (0..clipDurationSec),
  // independent of the trim window. Trimming is a separate segment operation and
  // must never be interpreted as rewriting spoken text.
  const clipDurationMs = Math.max(0, Math.round(clipDurationSec * 1000));
  const realigned = useMemo(() => {
    if (!words.length) return null;
    return realignCaptions(words, captionText, { trimStartMs: 0, trimEndMs: clipDurationMs });
  }, [words, captionText, clipDurationMs]);

  const needsRealignment = realigned?.alignment === 'realignment_required';
  const [reauthNeeded, setReauthNeeded] = useState(false);

  const trimDurationSec = Number(trimEnd) - Number(trimStart);
  const trimInvalid = !Number.isFinite(trimDurationSec) || trimDurationSec <= 0;

  // --- 3b. Debounced draft autosave ----------------------------------------
  // Persist every editable field to the server as the user edits, so a refresh
  // or Activity reload restores the full draft (not just what was saved at
  // rerender time). Also mirror the draft into session-scoped memory so a plain
  // tab reload can restore it even if the server round-trip hasn't landed yet.
  // Fire-and-forget; never blocks input.
  useEffect(() => {
    if (!session?.edit_session_id) return;
    if (!session?.session_token && !_resolvedSession?.session_token && !getEditorSessionToken()) return;
    const draft = {
      trim_start: Number(trimStart), trim_end: Number(trimEnd), framing,
      title, hook, social_caption: socialCaption,
      caption_text: captionText, caption_position: captionPosition,
      caption_style: captionStyle, caption_uppercase: captionUppercase,
      caption_font_name: captionFontName, caption_font_size: captionFontSize,
      caption_font_color: captionFontColor, caption_highlight_color: captionHighlightColor,
      caption_border_color: captionBorderColor, caption_border_width: captionBorderWidth,
      caption_bg_color: captionBgColor, caption_bg_opacity: captionBgOpacity,
      caption_effect: captionEffect, caption_base_opacity: captionBaseOpacity,
      hook_position: hookPosition, hook_size: hookSize,
      hook_style: hookStyle, hook_duration: hookDuration,
      instruction,
    };
    // Mirror immediately into local memory so a reload restores it. Merge over
    // the FULL session (state) + any retained module session so session_token,
    // edit_session_id, job_id and clip_index are never dropped from storage.
    const merged = { ...session, ...(_resolvedSession || {}), draft };
    _resolvedSession = merged;
    storeEditorSession(merged);
    const t = setTimeout(() => {
      apiFetch('/discord/editor/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edit_session_id: session.edit_session_id, draft }),
      }).catch(() => {});
    }, 700);
    return () => clearTimeout(t);
  }, [session, trimStart, trimEnd, framing, title, hook, socialCaption, captionText, captionPosition, captionStyle, captionUppercase, captionFontName, captionFontSize, captionFontColor, captionHighlightColor, captionBorderColor, captionBorderWidth, captionBgColor, captionBgOpacity, captionEffect, captionBaseOpacity, hookPosition, hookSize, hookStyle, hookDuration, instruction]);

  // --- 4. Apply caption + rerender + register + card -------------------------------
  const handleRerender = useCallback(async () => {
    if (!session || !edl) return;
    if (needsRealignment) { setError('Caption edit requires audio realignment — not rerendering.'); return; }
    if (trimInvalid) { setError('Trim range is invalid (start must be before end).'); return; }
    setRerendering(true); setResult(null); setError(null); setReauthNeeded(false);
    setProgress({ stage: 'save', detail: 'Persisting draft…' });
    try {
      const { job_id, clip_index } = session;

      // Changed detection across the FULL control set (text + styling).
      const captionChanged = captionText !== originalCaptionText
        || captionPosition !== 'bottom'
        || captionStyle !== 'classic'
        || captionUppercase !== false
        || captionFontName !== 'Verdana'
        || captionFontSize !== 24
        || captionFontColor !== '#FFFFFF'
        || captionHighlightColor !== '#FFDD00'
        || captionBorderColor !== '#000000'
        || captionBorderWidth !== 2
        || captionBgColor !== '#000000'
        || captionBgOpacity !== 0
        || captionEffect !== 'none'
        || captionBaseOpacity !== 1.0;

      const hookChanged = (hook || '').trim() !== ''
        || hookPosition !== 'top' || hookSize !== 'M' || hookStyle !== 'classic' || hookDuration !== 5;

      const caption_changes = {
        text: captionText,
        position: captionPosition,
        style: captionStyle,
        uppercase: captionUppercase,
        font_name: captionFontName,
        font_size: captionFontSize,
        font_color: captionFontColor,
        highlight_color: captionHighlightColor,
        border_color: captionBorderColor,
        border_width: captionBorderWidth,
        bg_color: captionBgColor,
        bg_opacity: captionBgOpacity,
        effect: captionEffect,
        base_opacity: captionBaseOpacity,
        alignment: realigned?.alignment ?? 'preserved',
        changedCount: realigned?.changedCount ?? 0,
        confidence: realigned?.confidence ?? 1,
        blocks: realigned?.blocks ?? [],
      };
      const crop_reframe_changes = { framing };

      // Persist EVERY editable field server-side BEFORE render so a reload
      // cannot erase title/hook/caption/subtitle/trim work.
      await apiFetch('/discord/editor/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          edit_session_id: session.edit_session_id,
          draft: {
            trim_start: Number(trimStart), trim_end: Number(trimEnd), framing,
            title, hook, social_caption: socialCaption,
            caption_text: captionText, caption_position: captionPosition,
            caption_style: captionStyle, caption_uppercase: captionUppercase,
            caption_font_name: captionFontName, caption_font_size: captionFontSize,
            caption_font_color: captionFontColor, caption_highlight_color: captionHighlightColor,
            caption_border_color: captionBorderColor, caption_border_width: captionBorderWidth,
            caption_bg_color: captionBgColor, caption_bg_opacity: captionBgOpacity,
            caption_effect: captionEffect, caption_base_opacity: captionBaseOpacity,
            hook_position: hookPosition, hook_size: hookSize,
            hook_style: hookStyle, hook_duration: hookDuration,
            instruction,
          },
        }),
      });

      // ---- 1. Rerender trim/framing FIRST (clean base for styling) ----------
      // Burn default captions in the recut only when we are NOT about to
      // restyle them (a later /api/subtitle would otherwise double-burn).
      setProgress({ stage: 'render', detail: 'Rendering trim + framing…' });
      const segments = [{ start: Number(trimStart), end: Number(trimEnd) }];
      const rrRes = await apiFetch('/api/clip/rerender', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id, clip_index, segments, snap_to_words: true,
          reapply_captions: !captionChanged,
          framing: framing === 'auto' ? undefined : framing,
        }),
      });
      const rrData = await rrRes.json();
      if (rrRes.status === 401) {
        // Keep the editor visible; surface a Reauthenticate/Retry affordance.
        clearStoredEditorSession(); _resolvedSession = null;
        setReauthNeeded(true);
        setError('Session expired or invalid — reauthenticate to continue.');
        setProgress(null);
        setRerendering(false);
        return;
      }
      if (!rrRes.ok) { setError('Rerender failed: ' + (rrData?.detail || rrData?.error || rrRes.status)); setProgress(null); setRerendering(false); return; }

      // Chain subsequent burns off the freshly recut file.
      let currentFile = rrData?.new_video_url ? outputBasename(rrData.new_video_url) : null;

      // ---- 2. Hook (if changed) ----------------------------------------------
      let hookApplied = false;
      if (hookChanged && currentFile) {
        setProgress({ stage: 'render', detail: 'Applying hook…' });
        const hookText = (hook || '').trim();
        const hRes = await apiFetch('/api/hook', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(hookText
            ? { job_id, clip_index, text: hookText, position: hookPosition, size: hookSize, style: hookStyle, duration_seconds: hookDuration, input_filename: currentFile }
            : { job_id, clip_index, remove: true, input_filename: currentFile }),
        });
        if (hRes.ok) {
          const hData = await hRes.json();
          if (hData?.new_video_url) currentFile = outputBasename(hData.new_video_url);
          hookApplied = true;
        }
      }

      // ---- 3. Styled captions (if changed) -----------------------------------
      let subtitleApplied = false;
      if (captionChanged && currentFile) {
        setProgress({ stage: 'render', detail: 'Applying subtitles…' });
        const wordsPayload = (realigned?.blocks ?? []).map(b => ({ text: b.text, startMs: b.startMs, endMs: b.endMs }));
        const subRes = await apiFetch('/api/subtitle', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job_id, clip_index,
            position: captionPosition, style: captionStyle, uppercase: captionUppercase,
            font_name: captionFontName, font_size: captionFontSize,
            font_color: captionFontColor, highlight_color: captionHighlightColor,
            border_color: captionBorderColor, border_width: captionBorderWidth,
            bg_color: captionBgColor, bg_opacity: captionBgOpacity,
            effect: captionEffect, base_opacity: captionBaseOpacity,
            words: wordsPayload, input_filename: currentFile,
          }),
        });
        if (subRes.ok) {
          const sData = await subRes.json();
          if (sData?.new_video_url) currentFile = outputBasename(sData.new_video_url);
          subtitleApplied = true;
        }
      }

      const finalUrl = currentFile
        ? getApiUrl(`/videos/${job_id}/${currentFile}`)
        : (rrData?.new_video_url ? getApiUrl(rrData.new_video_url) : null);
      if (finalUrl) setDownloadUrl(finalUrl);

      // Register the new asset version + send the re-review card.
      setProgress({ stage: 'register', detail: 'Registering new version…' });
      const completeRes = await fetch(EDITOR_COMPLETE_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          edit_session_id: session.edit_session_id,
          content_type: 'video/mp4',
          trim_start: Number(trimStart), trim_end: Number(trimEnd),
          caption_changes, crop_reframe_changes,
          instruction: instruction.trim() || undefined, llm_assist_used: false,
          edl_metadata: { caption_applied: subtitleApplied, hook_applied: hookApplied, framing, segments },
          job_id, ready_file: currentFile || outputBasename(rrData?.new_video_url || ''),
          proposed_title: title.trim() || undefined,
          hook: hook.trim() || undefined,
          caption: socialCaption.trim() || undefined,
          duration_seconds: Number(trimEnd) - Number(trimStart),
          correction_summary: buildSummary(caption_changes, crop_reframe_changes),
        }),
      });
      const completeData = await completeRes.json();
      if (!completeData.ok) { setError('Registration failed: ' + (completeData.error || 'unknown')); setProgress(null); setRerendering(false); return; }
      clearStoredEditorSession(); _resolvedSession = null;
      setResult(completeData);
      setProgress({ stage: 'card', detail: null });
    } catch (e) {
      setError('Rerender error: ' + (e && e.message ? e.message : String(e)));
      setProgress(null);
    } finally {
      setRerendering(false);
    }
  }, [session, edl, trimStart, trimEnd, framing, title, hook, socialCaption, captionText, originalCaptionText, captionPosition, captionStyle, captionUppercase, captionFontName, captionFontSize, captionFontColor, captionHighlightColor, captionBorderColor, captionBorderWidth, captionBgColor, captionBgOpacity, captionEffect, captionBaseOpacity, hookPosition, hookSize, hookStyle, hookDuration, instruction, realigned, needsRealignment, trimInvalid]);

  const handleDownload = useCallback(async () => {
    if (!downloadUrl) return;
    try {
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error('download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `edited_${(session?.clip_id || 'clip').replace(/[:/]/g, '_')}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError('Download failed: ' + (e?.message || String(e)));
    }
  }, [downloadUrl, session]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-paper text-ink2"><p className="text-sm text-muted">Opening editor session…</p></div>;
  }
  if (error && !session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper text-ink2 p-6">
        <div className="max-w-md text-center space-y-3">
          <h1 className="font-display lowercase text-2xl text-ink">editor unavailable</h1>
          <p className="text-sm text-muted">{error}</p>
        </div>
      </div>
    );
  }

  const align = ALIGNMENT_LABEL[realigned?.alignment] || ALIGNMENT_LABEL.preserved;

  return (
    <div className="min-h-screen bg-paper text-ink2">
      <header className="h-14 border-b border-rule flex items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="font-display lowercase text-lg text-ink">LOOM editor</span>
          <span className="readout hidden sm:inline">{session?.tenant_id} · {session?.clip_id} · {session?.source_asset_version}</span>
        </div>
        {session?.launch_guild_id && session?.launch_channel_id && (
          <a href={`https://discord.com/channels/${session.launch_guild_id}/${session.launch_channel_id}`}
             target="_blank" rel="noopener noreferrer"
             className="btn-ghost px-3 py-1.5 text-xs inline-flex items-center gap-1.5">
            <ArrowLeft size={14} /> return to review
          </a>
        )}
      </header>

      <main className="p-4 sm:p-6 max-w-6xl mx-auto space-y-5">
        {error && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-input text-xs text-danger bg-[color-mix(in_oklab,var(--color-danger)_10%,transparent)]">
            <AlertCircle size={14} className="shrink-0" /> {error}
          </div>
        )}

        {/* Large preview + Generated Shorts side panel */}
        <div className="card overflow-hidden flex flex-col lg:flex-row gap-0 lg:min-h-[560px]">
          {/* Preview column */}
          <div className="w-full lg:w-[min(42vw,420px)] bg-black shrink-0 aspect-[9/16] lg:aspect-auto lg:h-auto relative group/video mx-auto lg:mx-0">
            <video ref={videoRef} src={clipUrl} controls playsInline
              className="w-full h-full object-contain" />
            <div className="absolute top-3 left-3">
              <span className="bg-black/70 text-ink font-mono text-micro uppercase px-2 py-1 rounded-full">
                clip {Number(session?.clip_index ?? 0) + 1}
              </span>
            </div>
            {clipUrl == null && <p className="absolute inset-0 flex items-center justify-center text-xs text-muted">preview unavailable</p>}
          </div>

          {/* Side panel */}
          <div className="flex-1 p-4 md:p-6 flex flex-col min-w-0">
            <div className="mb-4">
              <h3 className="text-base font-medium text-ink leading-tight line-clamp-2 break-words">
                {title || 'Untitled clip'}
              </h3>
              <div className="flex flex-wrap gap-1.5 mt-2">
                <span className="readout bg-paper3 px-2 py-0.5 rounded-full">{fmt(trimDurationSec)}</span>
                <span className="readout bg-paper3 px-2 py-0.5 rounded-full">9:16</span>
                <span className="readout bg-paper3 px-2 py-0.5 rounded-full">{framing}</span>
              </div>
            </div>

            <div className="space-y-3 mb-4">
              <label className="block">
                <span className="eyebrow block mb-1">title</span>
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
                  placeholder="The manager cancelled EVERY subscription…"
                  className="input-field" />
              </label>

              <div>
                <span className="eyebrow block mb-1">hook</span>
                <button type="button" onClick={() => setShowHookModal(true)}
                  className="w-full text-left input-field flex items-center justify-between gap-2">
                  <span className="truncate">{hook.trim() ? hook : 'add a viral hook…'}</span>
                  <span className="readout shrink-0 text-muted">
                    {hook.trim() ? `${hookPosition} · ${hookSize} · ${hookStyle} · ${hookDuration}s` : 'tap to style'}
                  </span>
                </button>
              </div>

              <label className="block">
                <span className="eyebrow block mb-1">social caption</span>
                <textarea value={socialCaption} onChange={(e) => setSocialCaption(e.target.value)} rows={2}
                  placeholder="post caption with emojis + hashtags"
                  className="input-field resize-y" />
              </label>

              <div>
                <span className="eyebrow block mb-1">spoken subtitles <span className={`normal-case ${align.cls}`}>({align.text})</span></span>
                <textarea value={captionText} onChange={(e) => setCaptionText(e.target.value)} rows={2}
                  placeholder="spoken subtitle text"
                  className="input-field resize-y" />
                <div className="flex items-center gap-2 mt-1.5">
                  <button onClick={() => setCaptionText(originalCaptionText)} className="text-xs text-muted underline hover:text-ink">reset</button>
                  {realigned && !needsRealignment && (
                    <span className="readout">changed {realigned.changedCount} · confidence {Math.round(realigned.confidence * 100)}%</span>
                  )}
                </div>
                {needsRealignment && (
                  <div className="mt-2 text-xs text-danger bg-[color-mix(in_oklab,var(--color-danger)_10%,transparent)] rounded-input px-3 py-2">
                    ⚠️ This edit lacks enough unchanged anchors for safe timing redistribution — audio-based realignment is required. Rerender is disabled.
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <select value={captionPosition} onChange={(e) => setCaptionPosition(e.target.value)} className="input-field !py-1.5">
                    <option value="top">top</option><option value="middle">middle</option><option value="bottom">bottom</option>
                  </select>
                  <select value={captionStyle} onChange={(e) => setCaptionStyle(e.target.value)} className="input-field !py-1.5">
                    <option value="classic">classic</option><option value="karaoke">karaoke</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted mt-2">
                  <input type="checkbox" checked={captionUppercase} onChange={(e) => setCaptionUppercase(e.target.checked)} /> uppercase
                </label>
              </div>

              <div>
                <span className="eyebrow block mb-1">trim</span>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-muted">start (s)
                    <input type="number" step="0.1" value={trimStart}
                      onChange={(e) => { setTrimStart(e.target.value); seekTo(videoRef, e.target.value); }}
                      className="input-field mt-1" />
                  </label>
                  <label className="text-xs text-muted">end (s)
                    <input type="number" step="0.1" value={trimEnd}
                      onChange={(e) => { setTrimEnd(e.target.value); seekTo(videoRef, e.target.value); }}
                      className="input-field mt-1" />
                  </label>
                </div>
                {trimInvalid && (
                  <p className="text-xs text-warn mt-1">start must be before end.</p>
                )}
              </div>

              <div>
                <span className="eyebrow block mb-1">reframe / crop</span>
                <div className="grid grid-cols-3 gap-2">
                  {['auto', 'full', 'track'].map(f => (
                    <button key={f} onClick={() => setFraming(f)}
                      className={`px-2 py-2 rounded-input border text-xs lowercase transition-colors ${framing === f ? 'border-[color:var(--color-accent)] text-ink bg-[color-mix(in_oklab,var(--color-accent)_10%,transparent)]' : 'border-rule text-muted hover:border-rule2'}`}>
                      {f}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Progress */}
            {progress && (
              <div className="mb-4 grid grid-cols-4 gap-1.5">
                {PROGRESS_ORDER.map((s) => {
                  const active = progressStageRank(progress.stage) >= progressStageRank(s);
                  return (
                    <div key={s} className={`rounded-input px-2 py-1.5 text-center text-[10px] lowercase border ${active ? 'border-[color:var(--color-accent)] text-ink bg-[color-mix(in_oklab,var(--color-accent)_8%,transparent)]' : 'border-rule text-muted'}`}>
                      {PROGRESS_LABEL[s]}
                    </div>
                  );
                })}
              </div>
            )}

            {reauthNeeded && (
              <div className="mb-4 text-xs text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded-input p-3 space-y-2">
                <p>Your editor session is no longer authorized. Your draft is preserved — reauthenticate or retry.</p>
                <div className="flex gap-2">
                  {onReauthenticate && (
                    <button onClick={async () => { const ok = await onReauthenticate(); if (ok) { setReauthNeeded(false); setError(null); } }}
                      className="btn-ghost px-3 py-1.5">Reauthenticate</button>
                  )}
                  <button onClick={handleRerender} className="btn-ghost px-3 py-1.5">Retry</button>
                </div>
              </div>
            )}

            {result && (
              <div className="mb-4 text-sm text-ink bg-background border border-rule rounded-input p-3 flex items-center gap-2">
                <CheckCircle2 size={16} className="text-ok shrink-0" /> registered as new asset version — re-review card sent
              </div>
            )}

            {/* Actions */}
            <div className="grid grid-cols-2 gap-2 mt-auto pt-4 border-t border-rule">
              <button onClick={handleRerender} disabled={rerendering || !edl || needsRealignment || trimInvalid}
                className="btn-primary flex-col gap-1 py-2.5 px-1 text-[11px] leading-none rounded-input whitespace-nowrap disabled:opacity-45">
                {rerendering ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
                {rerendering ? (progress?.detail || 'working…') : 'auto edit'}
              </button>
              <button onClick={() => setShowSubtitleModal(true)} disabled={rerendering}
                className="btn-quiet flex-col gap-1 py-2.5 px-1 text-[11px] leading-none rounded-input whitespace-nowrap">
                <Type size={16} /> subtitles
              </button>
              <button onClick={handleDownload} disabled={!downloadUrl && !clipUrl}
                className="btn-quiet flex-col gap-1 py-2.5 px-1 text-[11px] leading-none rounded-input whitespace-nowrap">
                <Download size={16} /> download
              </button>
              {session?.launch_guild_id && session?.launch_channel_id ? (
                <a href={`https://discord.com/channels/${session.launch_guild_id}/${session.launch_channel_id}`}
                   target="_blank" rel="noopener noreferrer"
                   className="btn-ghost flex-col gap-1 py-2.5 px-1 text-[11px] leading-none rounded-input whitespace-nowrap">
                  <ArrowLeft size={16} /> return to review
                </a>
              ) : (
                <span className="btn-ghost flex-col gap-1 py-2.5 px-1 text-[11px] leading-none rounded-input whitespace-nowrap opacity-45 cursor-not-allowed">
                  <Scissors size={16} /> trim
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Transcript + scenes */}
        <div className="grid md:grid-cols-2 gap-5">
          <div className="card p-4">
            <h3 className="eyebrow mb-2">transcript</h3>
            <div className="max-h-56 overflow-y-auto space-y-1">
              {(words || []).slice(0, 200).map((w, i) => (
                <button key={i} onClick={() => seekTo(videoRef, (w?.startMs ?? w?.start ?? w?.s ?? 0) / 1000)}
                  className="block text-left text-xs text-muted hover:text-ink w-full px-2 py-1 rounded hover:bg-paper3">
                  <span className="text-brass tabular-nums">{fmt((w?.startMs ?? w?.start ?? w?.s ?? 0) / 1000)}</span> {w?.text ?? w?.word ?? w?.w ?? ''}
                </button>
              ))}
              {words.length === 0 && <p className="text-xs text-muted">(no transcript)</p>}
            </div>
          </div>
          <div className="card p-4">
            <h3 className="eyebrow mb-2">scenes</h3>
            <div className="max-h-56 overflow-y-auto space-y-1">
              {(scenes || []).map((s, i) => (
                <button key={i} onClick={() => seekTo(videoRef, s?.start ?? s?.t ?? 0)}
                  className="block text-left text-xs text-muted hover:text-ink w-full px-2 py-1 rounded hover:bg-paper3">
                  <span className="text-brass tabular-nums">{fmt(s?.start ?? s?.t ?? 0)}</span> {s?.label ?? s?.scene ?? `scene ${i + 1}`}
                </button>
              ))}
              {scenes.length === 0 && <p className="text-xs text-muted">(no scenes)</p>}
            </div>
          </div>
        </div>

        <SubtitleModal
          isOpen={showSubtitleModal}
          onClose={() => setShowSubtitleModal(false)}
          onGenerate={(styleOptions) => {
            if (styleOptions.position) setCaptionPosition(styleOptions.position);
            if (styleOptions.style) setCaptionStyle(styleOptions.style);
            if (styleOptions.uppercase != null) setCaptionUppercase(styleOptions.uppercase);
            if (styleOptions.fontName) setCaptionFontName(styleOptions.fontName);
            if (styleOptions.fontSize != null) setCaptionFontSize(styleOptions.fontSize);
            if (styleOptions.fontColor) setCaptionFontColor(styleOptions.fontColor);
            if (styleOptions.highlightColor) setCaptionHighlightColor(styleOptions.highlightColor);
            if (styleOptions.borderColor) setCaptionBorderColor(styleOptions.borderColor);
            if (styleOptions.borderWidth != null) setCaptionBorderWidth(styleOptions.borderWidth);
            if (styleOptions.bgColor) setCaptionBgColor(styleOptions.bgColor);
            if (styleOptions.bgOpacity != null) setCaptionBgOpacity(styleOptions.bgOpacity);
            if (styleOptions.effect) setCaptionEffect(styleOptions.effect);
            if (styleOptions.baseOpacity != null) setCaptionBaseOpacity(styleOptions.baseOpacity);
            if (Array.isArray(styleOptions.captions)) {
              setCaptionText(styleOptions.captions.map((c) => c.text).join(' '));
            }
            setShowSubtitleModal(false);
          }}
          isProcessing={rerendering}
          videoUrl={clipUrl}
          jobId={session?.job_id}
          clipIndex={Number(session?.clip_index ?? 0)}
          existingHook={null}
        />

        <HookModal
          isOpen={showHookModal}
          onClose={() => setShowHookModal(false)}
          onGenerate={(hookData) => {
            if (hookData.text != null) setHook(hookData.text);
            if (hookData.position) setHookPosition(hookData.position);
            if (hookData.size) setHookSize(hookData.size);
            if (hookData.style) setHookStyle(hookData.style);
            const dur = hookData.remotion?.displayDurationSec;
            if (Number.isFinite(dur)) setHookDuration(dur);
            setShowHookModal(false);
          }}
          isProcessing={rerendering}
          videoUrl={clipUrl}
          initialText={hook}
          durationInSeconds={clipDurationSec || 30}
          existingSubtitles={null}
          hasCaptions
          serverRender
          burnedHook={null}
        />
      </main>
    </div>
  );
}

function buildSummary(caption, reframe) {
  const parts = [];
  if (reframe?.framing && reframe.framing !== 'auto') parts.push(`reframe=${reframe.framing}`);
  if (caption?.alignment && caption.alignment !== 'preserved') parts.push(`caption=${caption.alignment}`);
  return parts.length ? parts.join(', ') : 'manual edit (trim)';
}

function progressStageRank(stage) {
  const i = PROGRESS_ORDER.indexOf(stage);
  return i === -1 ? -1 : i;
}
