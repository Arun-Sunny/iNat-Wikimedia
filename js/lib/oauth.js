// Wikimedia OAuth 2.0, authorization-code flow with PKCE, for a non-confidential (browser) client.
// No client secret is used or stored. Tokens are never logged.

function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomString(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** RFC 7636 S256 code challenge. */
export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** The callback URL to register: the app's own address without query, hash or "index.html". */
export function redirectUriFor(loc) {
  return loc.origin + loc.pathname.replace(/index\.html$/, '');
}

export function buildAuthorizeUrl({ restBase, clientId, redirectUri, state, challenge }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${restBase}/oauth2/authorize?${params}`;
}

export async function exchangeCode({ restBase, clientId, code, redirectUri, verifier, fetchFn = (...a) => fetch(...a), now = Date.now }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const res = await fetchFn(`${restBase}/oauth2/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const reason = json.error_description || json.message || json.error || `HTTP ${res.status}`;
    throw new Error(`Wikimedia login failed: ${reason}`);
  }
  return {
    accessToken: json.access_token,
    expiresAt: now() + (Number(json.expires_in) || 4 * 3600) * 1000,
  };
}
