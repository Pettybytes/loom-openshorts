import React, { useEffect, useState } from 'react';
import { initDiscordActivity, requestAuthorizationCode, authenticateWithToken, fetchPendingContext } from '../lib/discordActivity';
import ManualTrimEditor from './ManualTrimEditor';

// LOOM Activity root — the page Discord iframes when the Activity is launched.
//
// Flow:
//   1. Boot the Embedded App SDK (`ready()`).
//   2. OAuth: `authorize({response_type:'code'})` → server-side code exchange →
//      `authenticate({access_token})` → authenticated Discord user.
//   3. Ask the adapter for the pending edit context bound to that user:
//        - pending session  -> render the editor for the exact clip.
//        - no pending       -> render the "choose Edit on a card" waiting screen.
//
// No job id / clip identity / token is ever read from the URL here. Everything
// is resolved server-side for the authenticated user.

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID || '';

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
  const [state, setState] = useState('booting'); // booting | oauth | waiting | editor | error
  const [session, setSession] = useState(null);
  const [activityUser, setActivityUser] = useState(null);
  const [errMsg, setErrMsg] = useState('');

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

      const auth = await authenticateWithToken(oauthData.access_token);
      if (cancelled) return;
      if (auth?.user) setActivityUser(auth.user);

      const pending = await fetchPendingContext(oauthData.access_token);
      if (cancelled) return;

      if (pending && pending.ok && pending.pending && pending.session) {
        setSession(pending.session);
        setState('editor');
      } else if (pending && pending.ok && !pending.pending) {
        setState('waiting');
      } else {
        setErrMsg(pending?.error || 'Could not resolve the pending editor session.');
        setState('error');
      }
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

  return <ManualTrimEditor initialSession={session} activityUser={activityUser} />;
}
