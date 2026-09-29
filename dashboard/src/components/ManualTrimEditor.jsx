import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Download, Wand2, Type, Scissors, Crosshair, ArrowLeft, Loader2, CheckCircle2, AlertCircle, Film } from 'lucide-react';
import { getApiUrl } from '../config';
import { apiFetch, setEditorSessionToken, clearEditorSessionToken, editorTokenFingerprint, getEditorSessionToken } from '../lib/api';
import { realignCaptions } from '../lib/captionRealign';
// The ONE range model (shared with the OpenShorts segment editor) + the visual
// track that reuses ClipEditor's drag/scrub/snap mechanics.
import {
  MIN_RANGE_SEC,
  resolveSourceDuration,
  normalizeRange,
  buildTimelineDocument,
  parseTimelineDocument,
} from '../lib/timelineState';
import RangeTimeline from './RangeTimeline';
import SubtitleModal from './SubtitleModal';
import HookModal from './HookModal';
import HeaderModal from './HeaderModal';
import TextOverlayPreview from './TextOverlayPreview';
import PreviewSurface from './PreviewSurface';
import { buildPreviewState } from '../lib/editorPreviewState';
import { normalizeRich, serializeRich, isEmptyBase } from '../lib/richText';
import { keepSelection, readSelection } from '../lib/rangeSelection';
import { resolveClipIdentity, clipApiPath, jobApiPath } from '../lib/clipIdentity';
import {
  AUTO_START_COMPLETED,
  AUTO_START_FAILED,
  AUTO_START_RUNNING,
  autoStartDecision,
  autoStartRecord,
  readAutoStartGuard,
  writeAutoStartGuard,
} from '../lib/autoStart';

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

const PROGRESS_ORDER = ['save', 'clean', 'render', 'hook', 'subtitle', 'register', 'card', 'complete'];
const PROGRESS_LABEL = {
  save: 'saving draft',
  clean: 'preparing clean source',
  render: 'rendering trim/reframe',
  hook: 'applying hook',
  subtitle: 'applying subtitles',
  register: 'registering version',
  card: 'sending card',
  complete: 'complete',
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
  // The DURABLE SOURCE the trim window lives on: how long the media actually is
  // (measured) and what the durable bootstrap declared. Kept separate from
  // clipDurationSec — that one is the CLIP-relative caption timeline.
  const [measuredDurationSec, setMeasuredDurationSec] = useState(0);
  const [declaredSourceDurationSec, setDeclaredSourceDurationSec] = useState(0);
  // Browser-native selection preview (no render, no registration, no card).
  const [previewing, setPreviewing] = useState(false);

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
  // Structured Hook rich text (range styling) — the ONE saved shape for a
  // hook's text + ranges, shared by the modal, the preview and the burn.
  const [hookRich, setHookRich] = useState({ text: '', base: { color: null, font: null, size: null }, spans: [] });
  const [hookEntrance, setHookEntrance] = useState('spring');
  // Header rich text (range styling) — the SAME model as the hook, stored as its
  // own record so a plain-string header keeps hydrating exactly as before.
  const [headerRich, setHeaderRich] = useState({ text: '', base: { color: null, font: null }, spans: [] });
  // Layout mode for the on-video Header: 'overlay' (draw over the video — the
  // accepted default) or 'dedicated' (a real reserved black band above it).
  const [headerRegion, setHeaderRegion] = useState('overlay');
  const [showHeaderModal, setShowHeaderModal] = useState(false);
  // Selection made in the INLINE header field, carried into the header editor so
  // the range interaction works from either entry point. Sticky, because the
  // field loses focus (and reports an empty selection) when the button is hit.
  const [headerInlineSelection, setHeaderInlineSelection] = useState({ start: 0, end: 0 });
  // Preview clock — drives the hook's time visibility in the primary preview.
  const [videoTime, setVideoTime] = useState(0);
  const [instruction, setInstruction] = useState('');
  const [title, setTitle] = useState('');
  const [hook, setHook] = useState('');
  const [socialCaption, setSocialCaption] = useState('');
  const [cleanSourceUrl, setCleanSourceUrl] = useState(null);
  const [hasBurnedHook, setHasBurnedHook] = useState(false);
  // On-video title/header overlay — DISTINCT from the metadata Shorts title.
  const [titleOverlayEnabled, setTitleOverlayEnabled] = useState(false);
  const [titleOverlayText, setTitleOverlayText] = useState('');
  const [titleOverlayPosition, setTitleOverlayPosition] = useState('top');
  const [titleOverlayFontFamily, setTitleOverlayFontFamily] = useState('Verdana');
  const [titleOverlayFontSize, setTitleOverlayFontSize] = useState(40);
  const [titleOverlayColor, setTitleOverlayColor] = useState('#FFFFFF');
  const [titleOverlayBackground, setTitleOverlayBackground] = useState('box');
  const [titleOverlayBackgroundColor, setTitleOverlayBackgroundColor] = useState('#000000');
  const [titleOverlayAlignment, setTitleOverlayAlignment] = useState('center');
  const [rerendering, setRerendering] = useState(false);
  const [progress, setProgress] = useState(null);   // {stage, detail} or null
  const [result, setResult] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [showSubtitleModal, setShowSubtitleModal] = useState(false);
  const [showHookModal, setShowHookModal] = useState(false);
  // "Finish in CapCut" — OPTIONAL lane state. Kept local to the editor and
  // independent of rerender/registration: a failure here must never disturb an
  // in-progress edit.
  const [capcutBusy, setCapcutBusy] = useState(false);
  const [capcutResult, setCapcutResult] = useState(null);

  // One-time Auto Edit auto-start. `autoStart` is the record mirrored into the
  // durable draft; the decision and its guards live in lib/autoStart.js.
  const [autoStart, setAutoStart] = useState(null);

  const videoRef = useRef(null);
  // The auto-start effect must call the LATEST handleRerender without taking a
  // dependency on it (that identity changes on every keystroke and would
  // re-trigger the effect), and must run at most once per mounted editor.
  const handleRerenderRef = useRef(null);
  const autoStartInvokedRef = useRef(false);
  // Selection-preview plumbing. The listener is removed explicitly (and on
  // unmount) so repeat previews cannot stack timeupdate handlers.
  const previewListenerRef = useRef(null);
  const previewingRef = useRef(false);
  // Typed edit events restored from the durable timeline document. Empty in
  // Phase 2A (no event type is authorized yet) but carried through a reload so
  // a future event survives instead of being dropped by the editor.
  const timelineEventsRef = useRef([]);

  // --- 1a. ONE range state model ---------------------------------------------
  // `trimStart`/`trimEnd` are the single source of truth. The visual timeline,
  // the ±1s controls and the numeric fields all write through setRange(), so
  // they cannot hold divergent trim values.
  const sourceDurationSec = useMemo(() => resolveSourceDuration({
    measured: measuredDurationSec,
    declared: declaredSourceDurationSec,
    range: { start: Number(trimStart) || 0, end: Number(trimEnd) || 0 },
  }), [measuredDurationSec, declaredSourceDurationSec, trimStart, trimEnd]);

  // Which half of the bound was used — reported, never guessed.
  const sourceBoundSource = useMemo(() => {
    if (Number.isFinite(measuredDurationSec) && measuredDurationSec > 0) return 'measured';
    if (Number.isFinite(declaredSourceDurationSec) && declaredSourceDurationSec > 0) return 'declared';
    return null;
  }, [measuredDurationSec, declaredSourceDurationSec]);

  const setRange = useCallback(({ start, end }) => {
    const next = normalizeRange({
      start, end, sourceDuration: sourceDurationSec, minDuration: MIN_RANGE_SEC,
    });
    setTrimStart(next.start);
    setTrimEnd(next.end);
  }, [sourceDurationSec]);

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
        // Resolve the clip identity FIRST. A session whose job_id/clip_index
        // never resolved must not produce a single clip API request — that is
        // what used to render `/api/status/undefined` into the live gateway.
        const identity = resolveClipIdentity(session);
        if (!identity.ok) {
          throw new Error('Editor session is missing its clip identity — reopen the clip from the review card.');
        }
        const job_id = identity.jobId;
        const clip_index = identity.clipIndex;

        // --- Durable bootstrap: the REQUIRED source of truth -----------------
        // Resolves the exact review asset from LOOM media/version records.
        // Never depends on the transient OpenShorts /api/status runtime state,
        // so a durable review card reopens even after the render job is evicted.
        const bsRes = await apiFetch(EDITOR_BOOTSTRAP_URL);
        if (!bsRes.ok) {
          let msg = `Bootstrap failed (HTTP ${bsRes.status})`;
          let reason = '';
          try {
            const b = await bsRes.json();
            reason = b?.reason || '';
            if (b?.detail) msg = b.detail; else if (b?.error) msg = b.error;
          } catch (_) { /* ignore */ }
          // A terminal session is not a transient failure: drop the retained
          // credential so the next open re-acquires instead of looping on a
          // dead token (which surfaced as an unexplained 401 wall).
          if (bsRes.status === 401 && ['expired', 'completed', 'revoked', 'inactive', 'hash_mismatch'].includes(reason)) {
            clearStoredEditorSession();
            _resolvedSession = null;
            const why = reason === 'completed' ? 'already been completed'
              : reason === 'expired' ? 'expired'
              : 'no longer valid';
            throw new Error(`This editor session has ${why} — open the clip again from the review card to start a new one.`);
          }
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
        if (db.clean_source_url) setCleanSourceUrl(getApiUrl(db.clean_source_url));
        setHasBurnedHook(!!db.has_burned_hook);
        setCanonical({ start, end });
        setTrimStart(start); setTrimEnd(end);
        if (Number.isFinite(dur) && dur > 0) setClipDurationSec(dur);
        // The durable DECLARED duration. On a source-lineage launch this is the
        // candidate's window length (floored at the window end), NOT the whole
        // file — so it is only ever a fallback behind the media element's own
        // measurement. See lib/timelineState.js resolveSourceDuration().
        setDeclaredSourceDurationSec(Number.isFinite(dur) && dur > 0 ? dur : 0);
        if (db.framing === 'full' || db.framing === 'track') setFraming(db.framing);
        if (db.title != null) setTitle(db.title);
        if (db.hook != null) setHook(db.hook);
        if (db.social_caption != null) setSocialCaption(db.social_caption);

        // Durable recipe: synthesize the `edl` the Auto Edit flow needs from
        // the bootstrap, so Auto Edit stays enabled even after the render job
        // is evicted (the live /api/clip/.../edl 404s then). This is the root
        // cause of the previous "Auto Edit did nothing" no-op: `edl` was only
        // ever set from the live endpoint.
        setEdl({
          canonical_range: { start, end },
          source: { duration: dur },
          framing: db.framing || 'auto',
          durable: true,
        });

        // Restore a persisted title/header overlay from the durable draft (if any).
        const d0 = session.draft;
        if (d0?.title_overlay) {
          const to = d0.title_overlay;
          if (to.enabled != null) setTitleOverlayEnabled(!!to.enabled);
          if (to.text != null) setTitleOverlayText(to.text);
          if (to.position) setTitleOverlayPosition(to.position);
          if (to.font_family) setTitleOverlayFontFamily(to.font_family);
          if (to.font_size != null) setTitleOverlayFontSize(Number(to.font_size));
          if (to.text_color) setTitleOverlayColor(to.text_color);
          if (to.background) setTitleOverlayBackground(to.background);
          if (to.background_color) setTitleOverlayBackgroundColor(to.background_color);
          if (to.alignment) setTitleOverlayAlignment(to.alignment);
          // Absent on drafts saved before the mode existed -> accepted default.
          setHeaderRegion(to.region === 'dedicated' ? 'dedicated' : 'overlay');
        }
        // Restore persisted Hook rich text (range styling) + entrance. Absent
        // on legacy drafts, where the plain `hook` string still hydrates.
        if (d0?.hook_rich != null) setHookRich(normalizeRich(d0.hook_rich));
        if (d0?.hook_entrance) setHookEntrance(d0.hook_entrance);
        // Restore persisted Header rich text the same way. Absent on legacy
        // drafts, where the flat title_overlay fields stay the base style.
        if (d0?.header_rich != null) setHeaderRich(normalizeRich(d0.header_rich));

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
          // Tolerant read-back: a draft saved before the timeline existed has no
          // `timeline`, and the flat trim fields are then the honest answer.
          const restored = parseTimelineDocument(d.timeline, {
            range: { start: d.trim_start, end: d.trim_end },
            sourceDuration: d.source_duration_seconds,
          });
          // Events are carried through untouched so a future typed edit event
          // survives a reload instead of being silently dropped. Phase 2A
          // creates none, and parseTimelineDocument refuses unimplemented types.
          timelineEventsRef.current = restored.events || [];
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

  // --- 3a. ONE preview state for every preview surface ---------------------
  // The primary preview and the Hook modal both render from this object, so
  // they cannot drift apart. Header (visual), Hook (visual) and Social Caption
  // (metadata, never visual) stay explicitly distinct.
  const previewState = useMemo(() => buildPreviewState({
    title, hook, hook_rich: hookRich, social_caption: socialCaption,
    header_rich: headerRich,
    caption_text: captionText, caption_position: captionPosition,
    hook_position: hookPosition, hook_size: hookSize, hook_style: hookStyle,
    hook_duration: hookDuration, hook_entrance: hookEntrance,
    title_overlay: {
      enabled: titleOverlayEnabled, text: titleOverlayText, position: titleOverlayPosition,
      region: headerRegion,
      alignment: titleOverlayAlignment, font_family: titleOverlayFontFamily,
      font_size: titleOverlayFontSize, text_color: titleOverlayColor,
      background: titleOverlayBackground, background_color: titleOverlayBackgroundColor,
    },
  }), [
    title, hook, hookRich, headerRich, socialCaption, captionText, captionPosition,
    hookPosition, hookSize, hookStyle, hookDuration, hookEntrance,
    titleOverlayEnabled, titleOverlayText, titleOverlayPosition, titleOverlayAlignment,
    titleOverlayFontFamily, titleOverlayFontSize, titleOverlayColor,
    titleOverlayBackground, titleOverlayBackgroundColor, headerRegion,
  ]);

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
      hook_rich: serializeRich(hookRich), hook_entrance: hookEntrance,
      header_rich: serializeRich(headerRich),
      title_overlay: {
        enabled: titleOverlayEnabled,
        text: titleOverlayText,
        position: titleOverlayPosition,
        region: headerRegion,
        font_family: titleOverlayFontFamily,
        font_size: titleOverlayFontSize,
        text_color: titleOverlayColor,
        background: titleOverlayBackground,
        background_color: titleOverlayBackgroundColor,
        alignment: titleOverlayAlignment,
      },
      instruction,
      // The DURABLE half of the one-time auto-start guard (lib/autoStart.js).
      // Written with the draft so a reopen from a review card — where module
      // memory and refs are gone — reads back "already started" instead of
      // starting a second render.
      auto_start: autoStart || undefined,
      // The timeline document is the durable, ADDITIVE home for typed edit
      // events (lib/timelineState.js). Phase 2A writes exactly the range; the
      // shape is already the seam for split/remove/reorder/sfx/transition/
      // overlay/commentary/captions/hook, so adding one later does not replace
      // this representation.
      source_duration_seconds: sourceDurationSec,
      timeline: buildTimelineDocument({
        range: { start: Number(trimStart) || 0, end: Number(trimEnd) || 0 },
        sourceDuration: sourceDurationSec,
        events: timelineEventsRef.current,
      }),
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
  }, [session, trimStart, trimEnd, framing, title, hook, socialCaption, captionText, captionPosition, captionStyle, captionUppercase, captionFontName, captionFontSize, captionFontColor, captionHighlightColor, captionBorderColor, captionBorderWidth, captionBgColor, captionBgOpacity, captionEffect, captionBaseOpacity, hookPosition, hookSize, hookStyle, hookDuration, titleOverlayEnabled, titleOverlayText, titleOverlayPosition, titleOverlayFontFamily, titleOverlayFontSize, titleOverlayColor, titleOverlayBackground, titleOverlayBackgroundColor, titleOverlayAlignment, hookRich, hookEntrance, instruction, headerRegion, sourceDurationSec, autoStart]);

  // Snapshot the inline field's selection EAGERLY, during the event.
  //
  // React nulls an event's currentTarget once dispatch completes, so reading
  // selectionStart from inside a deferred state updater threw
  // "Cannot read properties of null (reading 'selectionStart')" and tripped the
  // editor error boundary. The snapshot is taken now and is a plain object.
  const syncHeaderInlineSelection = (e) => {
    const snapshot = readSelection(e?.currentTarget);
    if (!snapshot) return;
    setHeaderInlineSelection((cur) => keepSelection(cur, snapshot, titleOverlayText.length));
  };

  // --- 3c. Preview the SELECTED range (browser-native) ---------------------
  // Seeks the existing preview element to START, plays, and pauses at END.
  // This is playback of media the browser already holds: it issues no render,
  // no registration, no asset version, no review card and no acquisition.
  const stopSelectionPreview = useCallback(() => {
    previewingRef.current = false;
    setPreviewing(false);
    if (previewListenerRef.current) {
      previewListenerRef.current();
      previewListenerRef.current = null;
    }
    const v = videoRef.current;
    if (v) { try { v.pause(); } catch (_) { /* ignore */ } }
  }, []);

  const previewSelection = useCallback(() => {
    const v = videoRef.current;
    const s = Number(trimStart);
    const e2 = Number(trimEnd);
    if (!v || !Number.isFinite(s) || !Number.isFinite(e2) || e2 <= s) return;
    stopSelectionPreview();
    previewingRef.current = true;
    setPreviewing(true);
    try { v.currentTime = s; } catch (_) { /* ignore */ }
    const onTime = () => {
      if (!previewingRef.current) return;
      if (v.currentTime >= e2 - 0.001) stopSelectionPreview();
    };
    v.addEventListener('timeupdate', onTime);
    previewListenerRef.current = () => v.removeEventListener('timeupdate', onTime);
    const p = v.play?.();
    if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay policy */ });
  }, [trimStart, trimEnd, stopSelectionPreview]);

  // Never leave a listener or a playing element behind on unmount.
  useEffect(() => () => {
    if (previewListenerRef.current) previewListenerRef.current();
    previewListenerRef.current = null;
  }, []);

  // --- 4. Apply caption + rerender + register + card -------------------------------
  const handleRerender = useCallback(async () => {
    // Returns true only when a version was actually registered. The one-time
    // auto-start records that outcome, so a failure is never marked done.
    if (!session) { setError('Editor session is missing — reopen the clip from the review card.'); return false; }
    if (!edl) { setError('Clip recipe is unavailable — the render job may have expired. Reopen the review card to retry.'); return false; }
    if (needsRealignment) { setError('Caption edit requires audio realignment — not rerendering.'); return false; }
    if (trimInvalid) { setError('Trim range is invalid (start must be before end).'); return false; }
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
        || hookRich.spans.length > 0 || !isEmptyBase(hookRich.base)
        || hookPosition !== 'top' || hookSize !== 'M' || hookStyle !== 'classic' || hookDuration !== 5
        || hookEntrance !== 'spring';

      // A required overlay step that fails must abort the completion: the
      // registered asset must always be the LAST output of the chain, never an
      // intermediate that silently skipped an overlay.
      const failStep = (res, label) => {
        setError(`${label} step failed (HTTP ${res.status}). Nothing was registered — fix and retry.`);
        setProgress(null);
        setRerendering(false);
        return false;
      };

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
            hook_rich: serializeRich(hookRich), hook_entrance: hookEntrance,
            header_rich: serializeRich(headerRich),
            instruction,
            // Freshest durable value (the auto-start record is written before
            // this call), so the server copy can never lag the guard.
            auto_start: (session?.edit_session_id
              ? readAutoStartGuard()[session.edit_session_id]
              : null) || autoStart || undefined,
          },
        }),
      });

      // ---- 1. Prepare clean source ----------------------------------------
      setProgress({ stage: 'clean', detail: 'Preparing clean source…' });

      // ---- 2. Rerender trim/framing FIRST (clean base for styling) ----------
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
      if (!rrRes.ok) { setError('Rerender failed: ' + (rrData?.detail || rrData?.error || rrRes.status)); setProgress(null); setRerendering(false); return false; }

      // Chain subsequent burns off the freshly recut file.
      let currentFile = rrData?.new_video_url ? outputBasename(rrData.new_video_url) : null;

      // ---- 3. Hook (always apply if present, since rerender strips it) -------
      let hookApplied = false;
      const hookText = (hook || '').trim();
      if (hookText !== '' && currentFile) {
        setProgress({ stage: 'hook', detail: 'Applying hook…' });
        const burnRichPayload = (() => {
          const burnRich = normalizeRich({ text: hookText, base: hookRich.base, spans: hookRich.spans });
          const payload = {};
          if (burnRich.spans.length) payload.spans = burnRich.spans;
          if (!isEmptyBase(burnRich.base)) payload.base = burnRich.base;
          return payload;
        })();
        const hRes = await apiFetch('/api/hook', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job_id, clip_index, text: hookText, position: hookPosition,
            size: hookSize, style: hookStyle, duration_seconds: hookDuration,
            input_filename: currentFile,
            ...burnRichPayload,
          }),
        });
        if (!hRes.ok) {
          // A failed burn must NEVER be swallowed: completing here would
          // register the PRE-overlay render as a success and the review card
          // would show a clip with no hook at all.
          return failStep(hRes, 'Hook');
        }
        const hData = await hRes.json();
        if (hData?.new_video_url) currentFile = outputBasename(hData.new_video_url);
        hookApplied = true;
      }

      // ---- 4. Styled captions (if changed) -----------------------------------
      let subtitleApplied = false;
      if (captionChanged && currentFile) {
        setProgress({ stage: 'subtitle', detail: 'Applying subtitles…' });
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

      // ---- 5. Header (if enabled) --------------------------------------------
      let headerApplied = false;
      if (titleOverlayEnabled && titleOverlayText.trim() && currentFile) {
        setProgress({ stage: 'header', detail: 'Applying header…' });
        const headerRichPayload = (() => {
          const burnRich = normalizeRich({ text: titleOverlayText.trim(), base: headerRich.base, spans: headerRich.spans });
          const payload = {};
          if (burnRich.spans.length) payload.spans = burnRich.spans;
          if (!isEmptyBase(burnRich.base)) payload.base = burnRich.base;
          return payload;
        })();
        const headRes = await apiFetch('/api/header', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job_id, clip_index, text: titleOverlayText.trim(), position: titleOverlayPosition,
            region: headerRegion, font_family: titleOverlayFontFamily, font_size: titleOverlayFontSize,
            text_color: titleOverlayColor, background: titleOverlayBackground,
            background_color: titleOverlayBackgroundColor, alignment: titleOverlayAlignment,
            input_filename: currentFile,
            ...headerRichPayload,
          }),
        });
        if (!headRes.ok) {
          // The exact defect that put a header-less clip on the review card:
          // the Header burn failed, the failure was swallowed, and the
          // pre-Header render was registered as a successful version. Refuse to
          // complete instead — nothing is registered, and the error is shown.
          return failStep(headRes, 'Header');
        }
        const headData = await headRes.json();
        if (headData?.new_video_url) currentFile = outputBasename(headData.new_video_url);
        headerApplied = true;
      }

      const finalUrl = currentFile
        ? getApiUrl(`/videos/${job_id}/${currentFile}`)
        : (rrData?.new_video_url ? getApiUrl(rrData.new_video_url) : null);
      if (finalUrl) setDownloadUrl(finalUrl);

      // Register the new asset version + send the re-review card.
      setProgress({ stage: 'register', detail: 'Registering new version…' });
      // The adapter authenticates this request from the Bearer credential
      // BEFORE it reads or validates the body, so the editor session token must
      // be attached here — the same credential the bootstrap/draft calls use.
      const completeToken = getEditorSessionToken();
      const completeRes = await fetch(EDITOR_COMPLETE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(completeToken ? { Authorization: `Bearer ${completeToken}` } : {}),
        },
        body: JSON.stringify({
          edit_session_id: session.edit_session_id,
          content_type: 'video/mp4',
          trim_start: Number(trimStart), trim_end: Number(trimEnd),
          caption_changes, crop_reframe_changes,
          instruction: instruction.trim() || undefined, llm_assist_used: false,
          edl_metadata: { caption_applied: subtitleApplied, hook_applied: hookApplied, header_applied: headerApplied, framing, segments,
            // LOOM owns correction/event persistence; the type-aware timeline
            // document rides the existing jsonb — no schema change. This is the
            // exact place a future typed edit event is added.
            timeline: buildTimelineDocument({
              range: { start: Number(trimStart) || 0, end: Number(trimEnd) || 0 },
              sourceDuration: sourceDurationSec,
              events: timelineEventsRef.current,
            }),
            // The durable record of the hook's range styling, so the render
            // contract keeps the same semantics the preview showed.
            hook_rich: hookApplied ? serializeRich(normalizeRich({ text: hook.trim(), base: hookRich.base, spans: hookRich.spans })) : null,
            // The header's range styling, carried on the same durable record as
            // the rest of the overlay so a render/reopen keeps the semantics.
            header_rich: headerApplied && (headerRich.spans.length || headerRich.base.color || headerRich.base.font)
              ? { text: titleOverlayText.trim(), base: { ...headerRich.base }, spans: headerRich.spans.map((s) => ({ ...s })) }
              : null,
            title_overlay: headerApplied ? {
              region: headerRegion,
            text: titleOverlayText.trim(), position: titleOverlayPosition, font_family: titleOverlayFontFamily,
            font_size: titleOverlayFontSize, text_color: titleOverlayColor, background: titleOverlayBackground,
            background_color: titleOverlayBackgroundColor, alignment: titleOverlayAlignment,
          } : null },
          job_id, ready_file: currentFile || outputBasename(rrData?.new_video_url || ''),
          proposed_title: title.trim() || undefined,
          hook: hook.trim() || undefined,
          caption: socialCaption.trim() || undefined,
          duration_seconds: Number(trimEnd) - Number(trimStart),
          correction_summary: buildSummary(caption_changes, crop_reframe_changes),
        }),
      });
      const completeData = await completeRes.json();
      if (!completeData.ok) { setError('Registration failed: ' + (completeData.error || 'unknown')); setProgress(null); setRerendering(false); return false; }
      clearStoredEditorSession(); _resolvedSession = null;
      setResult(completeData);
      setProgress({ stage: 'card', detail: null });
      setProgress({ stage: 'complete', detail: null });
      return true;
    } catch (e) {
      setError('Rerender error: ' + (e && e.message ? e.message : String(e)));
      setProgress(null);
      return false;
    } finally {
      setRerendering(false);
    }
  }, [session, edl, trimStart, trimEnd, framing, title, hook, socialCaption, captionText, originalCaptionText, captionPosition, captionStyle, captionUppercase, captionFontName, captionFontSize, captionFontColor, captionHighlightColor, captionBorderColor, captionBorderWidth, captionBgColor, captionBgOpacity, captionEffect, captionBaseOpacity, hookPosition, hookSize, hookStyle, hookDuration, instruction, realigned, needsRealignment, trimInvalid, sourceDurationSec]);

  // Keep the auto-start effect pointed at the latest Auto Edit flow without
  // depending on its identity (which changes on every keystroke).
  handleRerenderRef.current = handleRerender;

  // --- 4a. ONE-TIME auto-start of the existing Auto Edit flow ---------------
  // Opening the editor for a version that still needs its FIRST draft runs the
  // EXISTING chain once (handleRerender — the same path the `auto edit` button
  // uses; no second flow, no duplicated stages, no pipeline change).
  //
  // The decision is durable, not a React ref: the record is written to
  // sessionStorage AND mirrored into the server-side draft BEFORE the render
  // starts, so a refresh, remount, StrictMode double-mount, websocket
  // reconnect, session refresh or reopen from the review card cannot start a
  // second render or a second version. lib/autoStart.js holds the rules.
  useEffect(() => {
    if (autoStartInvokedRef.current) return;      // one per mounted editor
    if (loading || !session || !edl) return;      // wait for the real state
    if (trimInvalid || needsRealignment) return;  // a render now could not be valid
    const editSessionId = session.edit_session_id;
    const decision = autoStartDecision({
      editSessionId,
      sessionStatus: session.status,
      targetAssetVersion: session.target_asset_version,
      draftAutoStart: session.draft?.auto_start,
      guardRecord: readAutoStartGuard()[editSessionId],
    });
    if (!decision.run) return;
    autoStartInvokedRef.current = true;
    // Record BEFORE invoking, so anything that re-enters the editor while the
    // render is in flight already sees `running` and cannot start another one.
    const started = autoStartRecord(AUTO_START_RUNNING, Date.now());
    writeAutoStartGuard(null, editSessionId, started);
    setAutoStart(started);
    let cancelled = false;
    Promise.resolve(handleRerenderRef.current?.())
      .then((ok) => {
        if (cancelled) return;
        // Never mark a failure as done: a failed run stays `failed` and the
        // existing error + Retry affordance is what the operator sees.
        const done = autoStartRecord(ok ? AUTO_START_COMPLETED : AUTO_START_FAILED, Date.now());
        writeAutoStartGuard(null, editSessionId, done);
        setAutoStart(done);
      })
      .catch(() => {
        if (cancelled) return;
        const failed = autoStartRecord(AUTO_START_FAILED, Date.now());
        writeAutoStartGuard(null, editSessionId, failed);
        setAutoStart(failed);
      });
    return () => { cancelled = true; };
  }, [loading, session, edl, trimInvalid, needsRealignment]);

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

  // "Finish in CapCut" — hand the version the operator is CURRENTLY viewing to
  // CapCut as an editable project. This is the same one-way handoff the lane is
  // built on: it renders nothing, registers no asset version, triggers no CI and
  // publishes nothing. The adapter writes the project locally and reports where
  // it landed (CapCut's own project store), which the operator then opens.
  const handleFinishInCapCut = useCallback(async () => {
    if (!session?.edit_session_id) return;
    setCapcutBusy(true);
    setCapcutResult(null);
    try {
      const res = await apiFetch('/discord/editor/capcut', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edit_session_id: session.edit_session_id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setCapcutResult({ ok: false, message: data?.reason || data?.error || `HTTP ${res.status}` });
        return;
      }
      setCapcutResult({
        ok: true, draftName: data.draft_name, draftPath: data.draft_path,
        captions: data.captions,
      });
    } catch (e) {
      setCapcutResult({ ok: false, message: e?.message || String(e) });
    } finally {
      setCapcutBusy(false);
    }
  }, [session]);

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
          {/* Preview column — the SAME surface the range modals render, so the
              Header/Hook land identically here and in the modal preview. */}
          <div className="w-full lg:w-[min(42vw,420px)] shrink-0 mx-auto lg:mx-0 group/video">
            <PreviewSurface
              videoUrl={clipUrl}
              videoRef={videoRef}
              header={previewState.header}
              hook={previewState.hook}
              region={headerRegion}
              currentTime={videoTime}
              onTimeUpdate={setVideoTime}
              onDurationChange={setMeasuredDurationSec}
              muted={!previewing}
              maxWidth={420}
            >
              <div className="absolute top-3 left-3">
                <span className="bg-black/70 text-ink font-mono text-micro uppercase px-2 py-1 rounded-full">
                  clip {Number(session?.clip_index ?? 0) + 1}
                </span>
              </div>
              {clipUrl == null && <p className="absolute inset-0 flex items-center justify-center text-xs text-muted">preview unavailable</p>}
            </PreviewSurface>
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

              {/* On-video title/header overlay — DISTINCT from the metadata title */}
              <div className="border border-rule rounded-input p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="eyebrow">on-video title / header</span>
                  <label className="flex items-center gap-1.5 text-xs text-muted">
                    <input type="checkbox" checked={titleOverlayEnabled} onChange={(e) => setTitleOverlayEnabled(e.target.checked)} /> enabled
                  </label>
                </div>
                {titleOverlayEnabled && (
                  <>
                    <input type="text" value={titleOverlayText} onChange={(e) => setTitleOverlayText(e.target.value)}
                      onSelect={syncHeaderInlineSelection}
                      onKeyUp={syncHeaderInlineSelection}
                      onMouseUp={syncHeaderInlineSelection}
                      placeholder="Text overlaid in the top black region"
                      className="input-field" />
                    <label className="block text-xs text-muted">
                      <span className="eyebrow block mb-1">header region</span>
                      <select value={headerRegion} onChange={(e) => setHeaderRegion(e.target.value)}
                        className="input-field !py-1.5">
                        <option value="overlay">overlay — text over the video (default)</option>
                        <option value="dedicated">dedicated black region above the video</option>
                      </select>
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <select value={titleOverlayPosition} onChange={(e) => setTitleOverlayPosition(e.target.value)} className="input-field !py-1.5">
                        <option value="top">top region</option>
                        <option value="upper">upper edge</option>
                      </select>
                      <select value={titleOverlayAlignment} onChange={(e) => setTitleOverlayAlignment(e.target.value)} className="input-field !py-1.5">
                        <option value="left">left</option>
                        <option value="center">center</option>
                        <option value="right">right</option>
                      </select>
                      <select value={titleOverlayFontFamily} onChange={(e) => setTitleOverlayFontFamily(e.target.value)} className="input-field !py-1.5">
                        <option value="Verdana">Verdana</option>
                        <option value="Arial">Arial</option>
                        <option value="Impact">Impact</option>
                        <option value="Helvetica">Helvetica</option>
                        <option value="Georgia">Georgia</option>
                        <option value="Courier New">Courier New</option>
                      </select>
                      <select value={titleOverlayBackground} onChange={(e) => setTitleOverlayBackground(e.target.value)} className="input-field !py-1.5">
                        <option value="none">no background</option>
                        <option value="box">box</option>
                        <option value="highlight">highlight</option>
                      </select>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <label className="text-xs text-muted">size (px)
                        <input type="number" min="12" max="160" value={titleOverlayFontSize}
                          onChange={(e) => setTitleOverlayFontSize(Number(e.target.value))}
                          className="input-field mt-1" />
                      </label>
                      <label className="text-xs text-muted">text color
                        <input type="color" value={titleOverlayColor}
                          onChange={(e) => setTitleOverlayColor(e.target.value)}
                          className="input-field mt-1 h-9" />
                      </label>
                      <label className="text-xs text-muted">bg color
                        <input type="color" value={titleOverlayBackgroundColor}
                          onChange={(e) => setTitleOverlayBackgroundColor(e.target.value)}
                          className="input-field mt-1 h-9" />
                      </label>
                    </div>
                    {/* SAME interaction model as the hook: select text, then give
                        just that range its own colour / font / size. */}
                    <button type="button" onClick={() => setShowHeaderModal(true)}
                      className="w-full text-left input-field flex items-center justify-between gap-2">
                      <span className="truncate">
                        {headerRich.spans.length
                          ? `${headerRich.spans.length} styled range${headerRich.spans.length === 1 ? '' : 's'}`
                          : 'style selected text (ranges)…'}
                      </span>
                      <span className="readout shrink-0 text-muted">select text → colour · font · size</span>
                    </button>
                  </>
                )}
              </div>

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
                {/* The SAME trim state, two views: the visual track (drag the
                    handles, click the track to aim the monitor, ±1s on either
                    edge) and the numeric fields. Both write through setRange,
                    which clamps into the available source — neither can create
                    an invalid range, and neither can move a boundary past the
                    start of the source or the end of the source. */}
                <RangeTimeline
                  sourceDuration={sourceDurationSec}
                  start={Number(trimStart) || 0}
                  end={Number(trimEnd) || 0}
                  words={[]}
                  sourceBoundSource={sourceBoundSource}
                  onCommitRange={setRange}
                  onSeek={(t) => seekTo(videoRef, t)}
                  onPreviewSelection={previewSelection}
                  onStopPreview={stopSelectionPreview}
                  previewing={previewing}
                  currentTime={videoTime}
                  disabled={rerendering}
                />
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <label className="text-xs text-muted">start (s)
                    <input type="number" step="0.1" value={trimStart}
                      onChange={(e) => { setRange({ start: e.target.value, end: Number(trimEnd) }); seekTo(videoRef, e.target.value); }}
                      className="input-field mt-1" />
                  </label>
                  <label className="text-xs text-muted">end (s)
                    <input type="number" step="0.1" value={trimEnd}
                      onChange={(e) => { setRange({ start: Number(trimStart), end: e.target.value }); seekTo(videoRef, e.target.value); }}
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

            {capcutResult && (
              <div className={`mb-4 text-xs rounded-input p-3 border space-y-1 ${capcutResult.ok ? 'text-ink bg-background border-rule' : 'text-amber-300 bg-amber-400/10 border-amber-400/20'}`}>
                {capcutResult.ok ? (
                  <>
                    <p className="flex items-center gap-2">
                      <CheckCircle2 size={14} className="text-ok shrink-0" />
                      CapCut project created — open CapCut to finish it.
                    </p>
                    <p className="text-muted break-all">{capcutResult.draftPath}</p>
                    {capcutResult.captions?.included === false && (
                      <p className="text-muted">{capcutResult.captions.reason}</p>
                    )}
                  </>
                ) : (
                  <p className="flex items-start gap-2">
                    <AlertCircle size={14} className="shrink-0 mt-0.5" />
                    <span>{capcutResult.message}</span>
                  </p>
                )}
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
              <button onClick={handleFinishInCapCut} disabled={capcutBusy || rerendering}
                className="btn-quiet col-span-2 flex-row gap-2 py-2.5 px-1 text-[11px] leading-none rounded-input whitespace-nowrap disabled:opacity-45">
                {capcutBusy ? <Loader2 size={16} className="animate-spin" /> : <Film size={16} />}
                Finish in CapCut
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
          initialFontSize={captionFontSize}
        />

        <HookModal
          isOpen={showHookModal}
          onClose={() => setShowHookModal(false)}
          onGenerate={(hookData) => {
            if (hookData.text != null) setHook(hookData.text);
            if (hookData.position) setHookPosition(hookData.position);
            if (hookData.size) setHookSize(hookData.size);
            if (hookData.style) setHookStyle(hookData.style);
            if (hookData.rich) setHookRich(normalizeRich(hookData.rich));
            if (hookData.entranceAnimation) setHookEntrance(hookData.entranceAnimation);
            const dur = hookData.remotion?.displayDurationSec;
            if (Number.isFinite(dur)) setHookDuration(dur);
            setShowHookModal(false);
          }}
          isProcessing={rerendering}
          videoUrl={clipUrl}
          cleanVideoUrl={cleanSourceUrl}
          initialText={hook}
          initialRich={hookRich}
          headerPreview={previewState.header}
          initialPosition={hookPosition}
          initialSize={hookSize}
          initialStyle={hookStyle}
          initialDuration={hookDuration}
          initialEntrance={hookEntrance}
          durationInSeconds={clipDurationSec || 30}
          existingSubtitles={null}
          hasCaptions
          serverRender
          burnedHook={hasBurnedHook ? hook : null}
        />

        <HeaderModal
          isOpen={showHeaderModal}
          onClose={() => setShowHeaderModal(false)}
          onApply={(data) => {
            if (data.text != null) {
              setTitleOverlayText(data.text);
              setTitleOverlayEnabled(!!data.enabled && data.text.trim().length > 0);
            }
            if (data.rich) setHeaderRich(normalizeRich(data.rich));
            if (data.fontFamily) setTitleOverlayFontFamily(data.fontFamily);
            if (Number.isFinite(data.fontSize)) setTitleOverlayFontSize(data.fontSize);
            if (data.color) setTitleOverlayColor(data.color);
            // The modal now returns the region; apply it so a `dedicated`
            // selection survives the modal round-trip instead of reverting.
            if (data.region) setHeaderRegion(data.region === 'dedicated' ? 'dedicated' : 'overlay');
            setShowHeaderModal(false);
          }}
          videoUrl={clipUrl}
          initialText={titleOverlayText}
          initialRich={headerRich}
          initialSelection={headerInlineSelection}
          initialRegion={headerRegion}
          initialPosition={titleOverlayPosition}
          initialAlignment={titleOverlayAlignment}
          initialFontFamily={titleOverlayFontFamily}
          initialFontSize={titleOverlayFontSize}
          initialColor={titleOverlayColor}
          initialBackground={titleOverlayBackground}
          initialBackgroundColor={titleOverlayBackgroundColor}
          hookPreview={previewState.hook}
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
