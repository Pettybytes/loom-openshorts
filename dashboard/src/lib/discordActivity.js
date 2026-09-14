// Discord Embedded App (Activity) integration for the LOOM editor.
//
// The editor is launched inside Discord as an iframed Activity. This module
// owns the SDK lifecycle and the OAuth2 authorization-code exchange:
//
//   1. Detect whether we are actually running inside a Discord Activity (the
//      SDK only exists / `instance_id` only appears when Discord hosts us).
//      Outside Discord (dev scaffold, deep-link fallback) this returns null
//      and the editor proceeds with the plain single-use launch token.
//   2. Construct the DiscordSDK with the OAuth2 client id (== the app id).
//   3. `ready()` handshakes with the Discord client.
//   4. `commands.authorize({response_type:'code'})` opens the OAuth consent
//      modal and returns an AUTHORIZATION CODE — never an access token.
//   5. The code is sent to the LOOM adapter, which exchanges it SERVER-SIDE
//      (the Discord client secret lives only in the adapter env, never in the
//      browser). The adapter returns the access_token.
//   6. `commands.authenticate({access_token})` completes the SDK auth so the
//      Activity can identify the reviewing Discord user.
//
// This module is dependency-light and imported lazily so the dashboard bundle
// does not hard-require the SDK when it is not installed.

let sdk = null;
let _mod = null;

async function loadSdk() {
  if (_mod) return _mod;
  try {
    _mod = await import('@discord/embedded-app-sdk');
  } catch (e) {
    _mod = null; // SDK not installed — degrade gracefully
  }
  return _mod;
}

// Discord exposes the Activity context as URL fragment/query params and via the
// SDK's own transport. A reliable non-SDK signal is the presence of an
// instance_id query/fragment param that Discord appends to the Activity URL.
export function isDiscordActivity() {
  if (typeof window === 'undefined') return false;
  try {
    const raw = (window.location.hash && window.location.hash.slice(1)) || window.location.search || '';
    const params = new URLSearchParams(raw);
    return !!(params.get('instance_id') || params.get('frame_id') || params.get('guild_id'));
  } catch (_) {
    return false;
  }
}

// Initialize the SDK if we are inside Discord. Returns the SDK instance or null.
// Safe to call when the SDK package is absent (returns null).
export async function initDiscordActivity(clientId) {
  if (!clientId || !isDiscordActivity()) return null;
  const mod = await loadSdk();
  if (!mod || !mod.DiscordSDK) return null;
  try {
    sdk = new mod.DiscordSDK(clientId);
    await sdk.ready();
    return sdk;
  } catch (e) {
    sdk = null;
    return null;
  }
}

export function getDiscordSdk() {
  return sdk;
}

// Request the OAuth authorization code from the Discord client. Returns the
// code, or null when not in an Activity / the SDK is unavailable.
export async function requestAuthorizationCode(clientId) {
  if (!sdk) return null;
  try {
    const { code } = await sdk.commands.authorize({
      client_id: clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify'],
    });
    return code || null;
  } catch (e) {
    return null;
  }
}

// Complete SDK authentication with the access_token returned by the adapter's
// server-side code exchange. Returns the auth object or null.
export async function authenticateWithToken(accessToken) {
  if (!sdk || !accessToken) return null;
  try {
    return await sdk.commands.authenticate({ access_token: accessToken });
  } catch (e) {
    return null;
  }
}
