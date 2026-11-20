import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pkceChallenge, buildAuthorizeUrl, redirectUriFor, exchangeCode, randomString } from '../js/lib/oauth.js';
import { sha1Hex } from '../js/lib/hash.js';
import { fakeFetch, jsonResponse } from './helpers.js';

const REST = 'https://meta.test/w/rest.php';

test('PKCE S256 challenge matches the RFC 7636 example', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('random strings are base64url and long enough for a verifier', () => {
  const v = randomString(48);
  assert.match(v, /^[A-Za-z0-9_-]{64}$/);
  assert.notEqual(v, randomString(48));
});

test('authorize URL carries the client, callback, state and challenge', () => {
  const u = new URL(buildAuthorizeUrl({ restBase: REST, clientId: 'abc', redirectUri: 'https://me.github.io/inat2commons/', state: 's1', challenge: 'c1' }));
  assert.equal(u.origin + u.pathname, 'https://meta.test/w/rest.php/oauth2/authorize');
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    response_type: 'code', client_id: 'abc', redirect_uri: 'https://me.github.io/inat2commons/', state: 's1', code_challenge: 'c1', code_challenge_method: 'S256',
  });
});

test('callback URL drops index.html, query and hash', () => {
  assert.equal(redirectUriFor(new URL('https://me.github.io/inat2commons/index.html?code=1#x')), 'https://me.github.io/inat2commons/');
  assert.equal(redirectUriFor(new URL('http://localhost:8080/')), 'http://localhost:8080/');
});

test('code exchange posts the verifier and no client secret', async () => {
  const fetchFn = fakeFetch(() => jsonResponse({ access_token: 'tok', expires_in: 14400, token_type: 'Bearer' }));
  const out = await exchangeCode({ restBase: REST, clientId: 'abc', code: 'xyz', redirectUri: 'https://me/', verifier: 'ver', fetchFn, now: () => 1000 });
  assert.deepEqual(out, { accessToken: 'tok', expiresAt: 1000 + 14400 * 1000 });
  const { url, init } = fetchFn.calls[0];
  assert.equal(url.href, 'https://meta.test/w/rest.php/oauth2/access_token');
  assert.equal(init.method, 'POST');
  const body = Object.fromEntries(new URLSearchParams(String(init.body)));
  assert.deepEqual(body, { grant_type: 'authorization_code', code: 'xyz', client_id: 'abc', redirect_uri: 'https://me/', code_verifier: 'ver' });
});

test('code exchange reports the server error', async () => {
  const fetchFn = fakeFetch(() => jsonResponse({ error: 'invalid_grant', error_description: 'Code expired' }, 400));
  await assert.rejects(
    exchangeCode({ restBase: REST, clientId: 'abc', code: 'x', redirectUri: 'https://me/', verifier: 'v', fetchFn }),
    /Wikimedia login failed: Code expired/,
  );
});

test('sha1Hex matches the standard test vector', async () => {
  assert.equal(await sha1Hex(new TextEncoder().encode('abc')), 'a9993e364706816aba3e25717850c26c9cd0d89d');
});
