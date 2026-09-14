import React, { useEffect, useState, useRef, useCallback } from 'react';
import { initDiscordActivity, requestAuthorizationCode, authenticateWithToken, fetchPendingContext } from '../lib/discordActivity';
import { setEditorSessionToken } from '../lib/api';
import ManualTrimEditor from './ManualTrimEditor';

// LOOM Activity root — the page Discord iframes when the Activity is launched.
//
// Flow:
//   1. Boot the Embedded App SDK (`ready()`).
//   2. OAuth: `authorize({response_type:'code'})` → server-side code exchange →
//      `authenticate({access_token})` → authenticated Discord user.
//   3. Ask the adapter for the pending edit context bound to that user. Because
//      the adapter persists the pending session ASYNCHRONOUSLY after the type-12
//      acknowledgement, the session may not be ready on the first probe — so we
//      poll for a short bounded period, showing "Preparing editor…", and only
//      fall back to the waiting screen once the bound elapses.
//
// No job id / clip identity / token is ever read from the URL here. Everything
// is resolved server-side for the authenticated user.

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID || '';
const PENDING_POLL_INTERVAL_MS = 500;
const PENDING_POLL_MAX_MS = 8000; // bounded: give async persistence ample time, then stop

function WaitingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-paper text-ink2 p-6">
      <div className="max-w-md text-center space-y-4">
        <div className="font-display lowercase text-2xl text-ink">LOOM editor</div>
        <p className="text-sm text-muted">
          Choose <span className="text-ink">Edit</span> on a LOOM review card to open that clip here.
        </p>
        <p className="text-xs text-muted">
          No editor session is pending for this account right now.
        </p>
      </div>
    </div>
  );
}

export default function LoomActivityRoot() {
  const [state, setState] = useState('booting'); // booting | oauth | preparing | waiting | editor | error
  const [session, setSession] = useState(null);
  const [activityUser, setActivityUser] = useState(null);
  const [errMsg, setErrMsg] = useState('');
  const accessTokenRef = useRef('');

  // Re-authenticate: re-run the pending-context resolution using the stored
  // OAuth access token, minting a fresh editor session token. Used when a 401
  // is surfaced mid-edit (keep the editor visible, offer this affordance).
  const reauthenticate = useCallback(async () => {
    const accessToken = accessTokenRef.current;
    if (!accessToken) return false;
    const pending = await fetchPendingContext(accessToken);
    if (pending && pending.ok && pending.pending && pending.session) {
      if (pending.session.session_token) setEditorSessionToken(pending.session.session_token);
      setSession(pending.session);
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!CLIENT_ID) {
        if (!cancelled) { setErrMsg('Discord client id is not configured (VITE_DISCORD_CLIENT_ID).'); setState('error'); }
        return;
      }
      const sdk = await initDiscordActivity(CLIENT_ID);
      if (!sdk) {
        if (!cancelled) { setErrMsg('Discord Activity SDK did not initialize (are you inside Discord?).'); setState('error'); }
        return;
      }
      if (cancelled) return;
      setState('oauth');

      const code = await requestAuthorizationCode(CLIENT_ID);
      if (!code) {
        if (!cancelled) { setErrMsg('Discord authorization was not completed.'); setState('error'); }
        return;
      }
      if (cancelled) return;

      let oauthData;
      try {
        const res = await fetch('/discord/editor/oauth', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        oauthData = await res.json();
      } catch (e) {
        if (!cancelled) { setErrMsg('OAuth exchange failed: ' + (e?.message || String(e))); setState('error'); }
        return;
      }
      if (cancelled) return;
      if (!oauthData.ok || !oauthData.access_token) {
        if (!cancelled) { setErrMsg(oauthData.error || 'OAuth exchange failed.'); setState('error'); }
        return;
      }
      accessTokenRef.current = oauthData.access_token;

      const auth = await authenticateWithToken(oauthData.access_token);
      if (cancelled) return;
      if (auth?.user) setActivityUser(auth.user);

      // Poll for the pending edit context (bounded). The adapter persists the
      // session asynchronously after the type-12 ack, so it may not be ready on
      // the first probe. Show "Preparing editor…" until it lands.
      setState('preparing');
      const deadline = Date.now() + PENDING_POLL_MAX_MS;
      while (Date.now() < deadline) {
        if (cancelled) return;
        const pending = await fetchPendingContext(oauthData.access_token);
        if (cancelled) return;

        if (pending && pending.ok && pending.pending && pending.session) {
          setSession(pending.session);
          setState('editor');
          return;
        }
        if (pending && !pending.ok && pending.error === 'could not resolve authenticated user') {
          // Non-transient auth failure — stop polling and surface it.
          setErrMsg(pending.error);
          setState('error');
          return;
        }
        // pending:false (still persisting) or transient transport error — retry.
        await new Promise((r) => setTimeout(r, PENDING_POLL_INTERVAL_MS));
      }

      // Bound elapsed with no session — this is a generic App Launcher launch.
      if (!cancelled) setState('waiting');
    }

    run();
    return () => { cancelled = true; };
  }, []);

  if (state === 'booting' || state === 'oauth') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper text-ink2">
        <p className="text-sm text-muted">{state === 'oauth' ? 'Authorizing with Discord…' : 'Opening LOOM editor…'}</p>
      </div>
    );
  }

  if (state === 'preparing') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper text-ink2">
        <p className="text-sm text-muted">Preparing editor…</p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper text-ink2 p-6">
        <div className="max-w-md text-center space-y-3">
          <h1 className="font-display lowercase text-2xl text-ink">editor unavailable</h1>
          <p className="text-sm text-muted">{errMsg}</p>
        </div>
      </div>
    );
  }

  if (state === 'waiting') {
    return <WaitingScreen />;
  }

  return <ManualTrimEditor initialSession={session} activityUser={activityUser} onReauthenticate={reauthenticate} />;
}
