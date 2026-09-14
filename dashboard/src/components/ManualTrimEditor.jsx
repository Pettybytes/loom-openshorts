import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getApiUrl } from '../config';
import { apiFetch, setEditorSessionToken, clearEditorSessionToken, editorTokenFingerprint } from '../lib/api';
import { realignCaptions } from '../lib/captionRealign';

// Relative public paths: the editor is served from the same public origin as
// the LOOM adapter (Caddy funnel), so the exchange/complete calls and the
// authenticated /api/* calls all resolve same-origin. Env overrides remain for
// the local dev scaffold, but the default is the production path.
const EDITOR_EXCHANGE_URL =
  import.meta.env.VITE_EDITOR_EXCHANGE_URL || '/discord/editor/exchange';
const EDITOR_COMPLETE_URL =
  import.meta.env.VITE_EDITOR_COMPLETE_URL || '/discord/editor/complete';

function fmt(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  const m = Math.floor(n / 60);
  const sec = (n % 60).toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
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

export default function ManualTrimEditor({ initialSession = null, activityUser = null, onReauthenticate = null }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [clipUrl, setClipUrl] = useState(null);
  const [edl, setEdl] = useState(null);
  const [words, setWords] = useState([]);          // caption words {text,startMs,endMs}
  const [scenes, setScenes] = useState([]);
  const [canonical, setCanonical] = useState({ start: 0, end: 0 });

  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [framing, setFraming] = useState('auto');
  const [captionText, setCaptionText] = useState('');
  const [originalCaptionText, setOriginalCaptionText] = useState('');
  const [captionPosition, setCaptionPosition] = useState('bottom');
  const [captionStyle, setCaptionStyle] = useState('classic');
  const [captionUppercase, setCaptionUppercase] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [title, setTitle] = useState('');
  const [hook, setHook] = useState('');
  const [socialCaption, setSocialCaption] = useState('');
  const [rerendering, setRerendering] = useState(false);
  const [progress, setProgress] = useState(null);   // {stage, detail} or null
  const [result, setResult] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState(null);

  const videoRef = useRef(null);

  // --- 1. Session acquisition -----------------------------------------------
  // Two paths:
  //   (a) Activity path: the Activity root already booted the Embedded App SDK,
  //       completed OAuth, resolved the pending edit context, and hands us a
  //       fully-resolved session via `initialSession`.
  //   (b) Deep-link fallback: /edit?job_id=&clip_index=&token=*** consumes the
  //       single-use launch token via the adapter exchange (private diagnostic
  //       path only — never the primary Discord experience).
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

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (window.location.search) history.replaceState({}, '', '/edit');
    if (!token) {
      setError('Missing editor token.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(EDITOR_EXCHANGE_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!data.ok) { setError(data.error || 'Token exchange failed.'); setLoading(false); return; }
        // Inject the short-lived editor session token so subsequent /api/* calls
        // are authorized by the LOOM adapter gateway against this session.
        if (data.session?.session_token) setEditorSessionToken(data.session.session_token);
        setSession({ ...data.session, job_id: data.session?.job_id, clip_index: Number(data.session?.clip_index ?? 0) });
      } catch (e) {
        if (!cancelled) { setError('Token exchange error: ' + (e && e.message ? e.message : String(e))); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [initialSession]);

  // Clear the injected editor session token on unmount so a later OpenShorts
  // session in the same tab never reuses a stale editor credential.
  useEffect(() => () => clearEditorSessionToken(), []);

  // --- 2. Load clip metadata + caption words --------------------------------------
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const { job_id, clip_index } = session;
        const stRes = await apiFetch(`/api/status/${job_id}`);
        const st = await stRes.json();
        const clips = st?.result?.clips || st?.clips || [];
        const cl = clips[clip_index] || clips[0];
        const rawUrl = cl?.video_url || cl?.view_url || null;
        if (rawUrl) setClipUrl(getApiUrl(rawUrl));

        const edlRes = await apiFetch(`/api/clip/${job_id}/${clip_index}/edl`);
        if (edlRes.ok) {
          const e = await edlRes.json();
          setEdl(e);
          const cr = e.canonical_range || {};
          const s = Number(cr.start ?? 0);
          const en = Number(cr.end ?? e.source?.duration ?? 0);
          setCanonical({ start: s, end: en });
          setTrimStart(s); setTrimEnd(en);
          if (e.framing === 'full' || e.framing === 'track') setFraming(e.framing);
        }

        // Restore a previously persisted draft (survives reload). title/hook/
        // social caption/subtitle controls + trim + framing all persist.
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
          if (d.caption_position) setCaptionPosition(d.caption_position);
          if (d.caption_style) setCaptionStyle(d.caption_style);
          if (d.caption_uppercase != null) setCaptionUppercase(d.caption_uppercase);
          if (d.instruction != null) setInstruction(d.instruction);
        }

        const tRes = await apiFetch(`/api/clip/${job_id}/${clip_index}/transcript`);
        if (tRes.ok) {
          const t = await tRes.json();
          const w = Array.isArray(t) ? t : (t?.captions || t?.words || t?.segments || []);
          setWords(w);
          const joined = w.map(x => x?.text ?? x?.word ?? x?.w ?? '').filter(Boolean).join(' ');
          setOriginalCaptionText(joined);
          // A persisted draft caption (edited) wins over the transcript default.
          setCaptionText(session.draft?.caption_text ?? joined);
        }

        const scRes = await apiFetch(`/api/clip/${job_id}/${clip_index}/scenes`);
        if (scRes.ok) setScenes(await scRes.json());
      } catch (e) {
        if (!cancelled) setError('Failed to load clip: ' + (e && e.message ? e.message : String(e)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [session]);

  // --- 3. Caption timing redistribution (deterministic) ---------------------------
  const clipDurationMs = Math.max(0, Math.round((Number(trimEnd) - Number(trimStart)) * 1000));
  const realigned = useMemo(() => {
    if (!words.length) return null;
    return realignCaptions(words, captionText, { trimStartMs: 0, trimEndMs: clipDurationMs });
  }, [words, captionText, clipDurationMs]);

  const needsRealignment = realigned?.alignment === 'realignment_required';
  const [reauthNeeded, setReauthNeeded] = useState(false);

  // --- 4. Apply caption + rerender + register + card -------------------------------
  const handleRerender = useCallback(async () => {
    if (!session || !edl) return;
    if (needsRealignment) { setError('Caption edit requires audio realignment — not rerendering.'); return; }
    setRerendering(true); setResult(null); setError(null); setReauthNeeded(false);
    setProgress({ stage: 'save', detail: 'Persisting draft…' });
    try {
      const { job_id, clip_index } = session;

      // Trim-only detection: caption text/style/position/uppercase unchanged.
      const captionChanged = captionText !== originalCaptionText
        || captionPosition !== 'bottom'
        || captionStyle !== 'classic'
        || captionUppercase !== false;

      const caption_changes = {
        text: captionText,
        position: captionPosition,
        style: captionStyle,
        uppercase: captionUppercase,
        alignment: realigned?.alignment ?? 'preserved',
        changedCount: realigned?.changedCount ?? 0,
        confidence: realigned?.confidence ?? 1,
        blocks: realigned?.blocks ?? [],
      };
      const crop_reframe_changes = { framing };

      // Persist the trim draft server-side BEFORE render so an Activity reload
      // cannot erase it.
      await apiFetch('/discord/editor/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          edit_session_id: session.edit_session_id,
          draft: {
            trim_start: Number(trimStart), trim_end: Number(trimEnd), framing,
            title, hook, social_caption: socialCaption,
            caption_text: captionText, caption_position: captionPosition,
            caption_style: captionStyle, caption_uppercase: captionUppercase,
            instruction,
          },
        }),
      });

      setProgress({ stage: 'render', detail: captionChanged ? 'Applying subtitles…' : 'Rendering clip…' });

      // TEMP fingerprint diagnostics: module token before subtitle and rerender.
      console.debug(`[loom-auth-diag] before-subtitle fp=${await editorTokenFingerprint()}`);

      let subtitleApplied = false;
      if (captionChanged) {
        // Caption application with redistributed word timings (no Gemini).
        const wordsPayload = (realigned?.blocks ?? []).map(b => ({ text: b.text, startMs: b.startMs, endMs: b.endMs }));
        const subRes = await apiFetch('/api/subtitle', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ job_id, clip_index, position: captionPosition, style: captionStyle, uppercase: captionUppercase, words: wordsPayload }),
        });
        subtitleApplied = subRes.ok;
      }

      console.debug(`[loom-auth-diag] before-rerender fp=${await editorTokenFingerprint()}`);

      // FAST rerender (trim + framing).
      const segments = [{ start: Number(trimStart), end: Number(trimEnd) }];
      const rrRes = await apiFetch('/api/clip/rerender', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id, clip_index, segments, snap_to_words: true, reapply_captions: true, framing: framing === 'auto' ? undefined : framing }),
      });
      const rrData = await rrRes.json();
      if (rrRes.status === 401) {
        // Keep the editor visible; surface a Reauthenticate/Retry affordance.
        setReauthNeeded(true);
        setError('Session expired or invalid — reauthenticate to continue.');
        setProgress(null);
        setRerendering(false);
        return;
      }
      if (!rrRes.ok) { setError('Rerender failed: ' + (rrData?.detail || rrData?.error || rrRes.status)); setProgress(null); setRerendering(false); return; }

      const renderedUrl = rrData?.new_video_url;
      if (renderedUrl) setDownloadUrl(getApiUrl(renderedUrl));

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
          edl_metadata: { caption_applied: subtitleApplied, framing, segments },
          job_id, ready_file: outputBasename(renderedUrl),
          proposed_title: title.trim() || undefined,
          hook: hook.trim() || undefined,
          caption: socialCaption.trim() || undefined,
          duration_seconds: Number(trimEnd) - Number(trimStart),
          correction_summary: buildSummary(caption_changes, crop_reframe_changes),
        }),
      });
      const completeData = await completeRes.json();
      if (!completeData.ok) { setError('Registration failed: ' + (completeData.error || 'unknown')); setProgress(null); setRerendering(false); return; }
      setResult(completeData);
      setProgress({ stage: 'card', detail: null });
    } catch (e) {
      setError('Rerender error: ' + (e && e.message ? e.message : String(e)));
      setProgress(null);
    } finally {
      setRerendering(false);
    }
  }, [session, edl, trimStart, trimEnd, framing, title, hook, socialCaption, captionText, originalCaptionText, captionPosition, captionStyle, captionUppercase, instruction, words, realigned, needsRealignment]);

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
        <span className="font-display lowercase text-lg text-ink">LOOM editor</span>
        <span className="text-xs text-muted">
          {session?.tenant_id} · {session?.clip_id} · {session?.source_asset_version}
          {activityUser ? ` · ${activityUser.global_name || activityUser.username || activityUser.id}` : ''}
        </span>
      </header>

      <main className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
        {error && <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg p-3">{error}</div>}

        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-3">
            <video ref={videoRef} src={clipUrl} controls className="w-full rounded-lg bg-black aspect-[9/16] object-contain" />
            {clipUrl == null && <p className="text-xs text-muted">(preview unavailable — no clip URL)</p>}
          </div>

          <div className="space-y-4">
            <h2 className="font-display lowercase text-xl text-ink">trim</h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-muted">start (s)
                <input type="number" step="0.1" min={canonical.start} max={canonical.end} value={trimStart}
                  onChange={(e) => { setTrimStart(e.target.value); seekTo(videoRef, e.target.value); }}
                  className="mt-1 w-full bg-background border border-rule rounded-lg px-3 py-2 text-ink" />
              </label>
              <label className="text-xs text-muted">end (s)
                <input type="number" step="0.1" min={canonical.start} max={canonical.end} value={trimEnd}
                  onChange={(e) => { setTrimEnd(e.target.value); seekTo(videoRef, e.target.value); }}
                  className="mt-1 w-full bg-background border border-rule rounded-lg px-3 py-2 text-ink" />
              </label>
            </div>
            <div className="text-sm text-ink">duration <span className="text-brass">{fmt(trimEnd - trimStart)}</span>
              <span className="text-muted"> · source {fmt(canonical.start)}–{fmt(canonical.end)}</span></div>

            <h2 className="font-display lowercase text-xl text-ink pt-2">reframe / crop</h2>
            <div className="grid grid-cols-3 gap-2">
              {['auto', 'full', 'track'].map(f => (
                <button key={f} onClick={() => setFraming(f)}
                  className={`px-2 py-2 rounded-lg border text-xs ${framing === f ? 'border-brass text-ink bg-brass/10' : 'border-rule text-muted'}`}>
                  {f}
                </button>
              ))}
            </div>

            <h2 className="font-display lowercase text-xl text-ink pt-2">title</h2>
            <label className="block text-xs text-muted">shorts title
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. The manager cancelled EVERY subscription…"
                className="mt-1 w-full bg-background border border-rule rounded-lg px-3 py-2 text-ink" />
            </label>

            <h2 className="font-display lowercase text-xl text-ink pt-2">hook</h2>
            <label className="block text-xs text-muted">hook / overlay line
              <input type="text" value={hook} onChange={(e) => setHook(e.target.value)}
                placeholder="e.g. Wait for the ending…"
                className="mt-1 w-full bg-background border border-rule rounded-lg px-3 py-2 text-ink" />
            </label>

            <h2 className="font-display lowercase text-xl text-ink pt-2">social caption</h2>
            <label className="block text-xs text-muted">caption for the social post (separate from the spoken subtitles below)
              <textarea value={socialCaption} onChange={(e) => setSocialCaption(e.target.value)} rows={2}
                placeholder="post caption with emojis + hashtags"
                className="mt-1 w-full bg-background border border-rule rounded-lg px-3 py-2 text-ink resize-y" />
            </label>

            <h2 className="font-display lowercase text-xl text-ink pt-2">
              spoken subtitles <span className={`text-xs ml-1 ${align.cls}`}>({align.text})</span>
            </h2>
            <label className="block text-xs text-muted">text
              <textarea value={captionText} onChange={(e) => setCaptionText(e.target.value)} rows={2}
                placeholder="caption text (add / delete / replace words)"
                className="mt-1 w-full bg-background border border-rule rounded-lg px-3 py-2 text-ink resize-y" />
            </label>
            <div className="flex items-center gap-3 text-xs">
              <button onClick={() => setCaptionText(originalCaptionText)} className="text-muted underline">reset to original</button>
              {realigned && <span className="text-muted">changed {realigned.changedCount} · confidence {Math.round(realigned.confidence * 100)}%</span>}
            </div>
            {needsRealignment && (
              <div className="text-xs text-red-300 bg-red-400/10 border border-red-400/20 rounded-lg p-2">
                ⚠️ This edit lacks enough unchanged anchors for safe timing redistribution — audio-based realignment is required. Rerender is disabled.
              </div>
            )}
            {realigned && !needsRealignment && realigned.blocks.length > 0 && (
              <div className="text-xs text-muted max-h-32 overflow-y-auto space-y-0.5 border border-rule rounded-lg p-2">
                <span className="text-ink">preview ({realigned.blocks.length} blocks):</span>
                {realigned.blocks.slice(0, 40).map((b, i) => (
                  <div key={i}><span className="text-brass tabular-nums">{fmt(b.startMs / 1000)}–{fmt(b.endMs / 1000)}</span> {b.text}</div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-muted">position
                <select value={captionPosition} onChange={(e) => setCaptionPosition(e.target.value)} className="mt-1 w-full bg-background border border-rule rounded-lg px-3 py-2 text-ink">
                  <option value="top">top</option><option value="middle">middle</option><option value="bottom">bottom</option>
                </select>
              </label>
              <label className="text-xs text-muted">style
                <select value={captionStyle} onChange={(e) => setCaptionStyle(e.target.value)} className="mt-1 w-full bg-background border border-rule rounded-lg px-3 py-2 text-ink">
                  <option value="classic">classic</option><option value="karaoke">karaoke</option>
                </select>
              </label>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={captionUppercase} onChange={(e) => setCaptionUppercase(e.target.checked)} /> uppercase
            </label>

            <label className="block text-xs text-muted">written instruction (captured, not yet applied — LLM edit not wired end-to-end)
              <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={2} placeholder="e.g. tighten the opening"
                className="mt-1 w-full bg-background border border-rule rounded-lg px-3 py-2 text-ink resize-y" />
            </label>

            <button onClick={handleRerender} disabled={rerendering || !edl || needsRealignment} className="btn-primary px-4 py-2 w-full disabled:opacity-50">
              {rerendering ? (progress?.detail || 'working…') : 'save · render · register · send re-review card'}
            </button>
            {progress && (
              <div className="text-xs text-muted space-y-1">
                {PROGRESS_ORDER.map((s) => (
                  <div key={s} className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${progressStageRank(progress.stage) >= progressStageRank(s) ? 'bg-brass' : 'bg-rule'}`} />
                    <span className={progressStageRank(progress.stage) >= progressStageRank(s) ? 'text-ink' : ''}>{PROGRESS_LABEL[s]}</span>
                  </div>
                ))}
              </div>
            )}
            {reauthNeeded && (
              <div className="text-xs text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded-lg p-3 space-y-2">
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
              <div className="text-sm text-ink bg-background border border-rule rounded-lg p-3 space-y-2">
                <div>✓ registered as new asset version — re-review card sent</div>
                <div className="flex flex-wrap gap-2">
                  {downloadUrl && (
                    <button onClick={handleDownload} className="btn-ghost px-3 py-1.5">Download edited clip</button>
                  )}
                  {session?.launch_guild_id && session?.launch_channel_id && (
                    <a href={`https://discord.com/channels/${session.launch_guild_id}/${session.launch_channel_id}`}
                       target="_blank" rel="noopener noreferrer"
                       className="btn-ghost px-3 py-1.5 inline-flex items-center gap-1">Return to Discord Review</a>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <h3 className="font-display lowercase text-lg text-ink">transcript</h3>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {(words || []).slice(0, 200).map((w, i) => (
                <button key={i} onClick={() => seekTo(videoRef, (w?.startMs ?? w?.start ?? w?.s ?? 0) / 1000)}
                  className="block text-left text-xs text-muted hover:text-ink w-full px-2 py-1 rounded hover:bg-background">
                  <span className="text-brass tabular-nums">{fmt((w?.startMs ?? w?.start ?? w?.s ?? 0) / 1000)}</span> {w?.text ?? w?.word ?? w?.w ?? ''}
                </button>
              ))}
              {words.length === 0 && <p className="text-xs text-muted">(no transcript)</p>}
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="font-display lowercase text-lg text-ink">scenes</h3>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {(scenes || []).map((s, i) => (
                <button key={i} onClick={() => seekTo(videoRef, s?.start ?? s?.t ?? 0)}
                  className="block text-left text-xs text-muted hover:text-ink w-full px-2 py-1 rounded hover:bg-background">
                  <span className="text-brass tabular-nums">{fmt(s?.start ?? s?.t ?? 0)}</span> {s?.label ?? s?.scene ?? `scene ${i + 1}`}
                </button>
              ))}
              {scenes.length === 0 && <p className="text-xs text-muted">(no scenes)</p>}
            </div>
          </div>
        </div>
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
