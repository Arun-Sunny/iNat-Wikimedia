import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommonsApi, CommonsError, resolveCategories, categoryCandidates } from '../js/lib/commons.js';
import { fakeFetch, jsonResponse } from './helpers.js';

const API = 'https://commons.test/w/api.php';

test('findBySha1 queries allimages anonymously and returns titles', async () => {
  const fetchFn = fakeFetch(() => jsonResponse({ query: { allimages: [{ name: 'A.jpg', title: 'File:A.jpg' }] } }));
  const api = new CommonsApi({ apiUrl: API, fetchFn, userAgent: 'test-agent' });
  assert.deepEqual(await api.findBySha1('abc123'), ['File:A.jpg']);
  const { url, init } = fetchFn.calls[0];
  assert.equal(url.searchParams.get('list'), 'allimages');
  assert.equal(url.searchParams.get('aisha1'), 'abc123');
  assert.equal(url.searchParams.get('origin'), '*');
  assert.equal(url.searchParams.has('crossorigin'), false);
  assert.equal(init.headers['Api-User-Agent'], 'test-agent');
  assert.equal(init.headers.Authorization, undefined);
});

test('findBySha1 returns an empty list when nothing matches', async () => {
  const api = new CommonsApi({ apiUrl: API, fetchFn: fakeFetch(() => jsonResponse({ query: { allimages: [] } })) });
  assert.deepEqual(await api.findBySha1('0'.repeat(40)), []);
});

test('pagesExist follows title normalisation and reports missing pages', async () => {
  const fetchFn = fakeFetch(() => jsonResponse({
    query: {
      normalized: [{ from: 'Category:saxicola', to: 'Category:Saxicola' }],
      pages: [{ title: 'Category:Saxicola' }, { title: 'Category:Nope', missing: true }],
    },
  }));
  const api = new CommonsApi({ apiUrl: API, fetchFn });
  const result = await api.pagesExist(['Category:saxicola', 'Category:Nope']);
  assert.equal(result.get('Category:saxicola'), true);
  assert.equal(result.get('Category:Nope'), false);
  assert.equal(fetchFn.calls[0].url.searchParams.get('titles'), 'Category:saxicola|Category:Nope');
});

test('pagesExist batches 50 titles per request', async () => {
  const fetchFn = fakeFetch(() => jsonResponse({ query: { pages: [] } }));
  const api = new CommonsApi({ apiUrl: API, fetchFn });
  await api.pagesExist(Array.from({ length: 120 }, (_, i) => `File:${i}.jpg`));
  assert.equal(fetchFn.calls.length, 3);
});

test('userInfo sends the bearer token with crossorigin, never origin=*', async () => {
  const fetchFn = fakeFetch(() => jsonResponse({ query: { userinfo: { id: 1, name: 'Alex Example', rights: ['upload'] } } }));
  const api = new CommonsApi({ apiUrl: API, fetchFn, accessToken: 'secret-token' });
  const info = await api.userInfo();
  assert.equal(info.name, 'Alex Example');
  const { url, init } = fetchFn.calls[0];
  assert.equal(url.searchParams.get('crossorigin'), '');
  assert.equal(url.searchParams.has('origin'), false);
  assert.equal(init.headers.Authorization, 'Bearer secret-token');
  assert.ok(!url.href.includes('secret-token'), 'token must not appear in the URL');
});

test('API errors become CommonsError with the error code', async () => {
  const api = new CommonsApi({ apiUrl: API, fetchFn: fakeFetch(() => jsonResponse({ error: { code: 'maxlag', info: 'Waiting for db' } })) });
  await assert.rejects(api.findBySha1('x'), (e) => e instanceof CommonsError && e.code === 'maxlag');
  const down = new CommonsApi({ apiUrl: API, fetchFn: fakeFetch(() => jsonResponse({}, 502)) });
  await assert.rejects(down.findBySha1('x'), /HTTP 502/);
});

test('upload posts multipart with crossorigin in the URL, bearer auth, maxlag, assert and the token last', async () => {
  const fetchFn = fakeFetch(() => jsonResponse({ upload: { result: 'Success', filename: 'A.jpg' } }));
  const api = new CommonsApi({ apiUrl: API, fetchFn, accessToken: 'secret-token', userAgent: 'ua' });
  const out = await api.upload({ filename: 'A.jpg', text: 'wikitext', comment: 'c', file: new Blob(['x']), token: 'csrf+\\' });
  assert.deepEqual(out, { result: 'Success', filename: 'A.jpg' });
  const { url, init } = fetchFn.calls[0];
  assert.equal(url.href, 'https://commons.test/w/api.php?crossorigin=');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer secret-token');
  assert.equal(init.headers['Api-User-Agent'], 'ua');
  assert.ok(init.body instanceof FormData);
  const fields = [...init.body.keys()];
  assert.equal(fields.at(-1), 'token');
  assert.equal(init.body.get('action'), 'upload');
  assert.equal(init.body.get('filename'), 'A.jpg');
  assert.equal(init.body.get('text'), 'wikitext');
  assert.equal(init.body.get('maxlag'), '5');
  assert.equal(init.body.get('assert'), 'user');
  assert.equal(init.body.get('token'), 'csrf+\\');
  assert.equal(init.body.get('ignorewarnings'), null);
  assert.equal(init.body.get('file').name, 'A.jpg');
});

test('API errors carry the code and the Retry-After delay', async () => {
  const fetchFn = fakeFetch(() => new Response(JSON.stringify({ error: { code: 'maxlag', info: 'lag', lag: 6 } }), { status: 200, headers: { 'Retry-After': '9' } }));
  const api = new CommonsApi({ apiUrl: API, fetchFn, accessToken: 't' });
  await assert.rejects(
    api.upload({ filename: 'A.jpg', text: '', comment: '', file: new Blob(['x']), token: 't' }),
    (e) => e instanceof CommonsError && e.code === 'maxlag' && e.retryAfter === 9 && e.lag === 6,
  );
});

test('wbeditentity sends the entity id and JSON data as a form post', async () => {
  const fetchFn = fakeFetch(() => jsonResponse({ success: 1 }));
  const api = new CommonsApi({ apiUrl: API, fetchFn, accessToken: 't' });
  await api.editEntity({ id: 'M123', data: { claims: [] }, summary: 's', token: 'csrf' });
  const body = fetchFn.calls[0].init.body;
  assert.ok(body instanceof URLSearchParams);
  assert.equal(body.get('action'), 'wbeditentity');
  assert.equal(body.get('id'), 'M123');
  assert.equal(body.get('data'), '{"claims":[]}');
  assert.equal(body.get('maxlag'), '5');
  assert.equal([...body.keys()].at(-1), 'token');
});

test('csrfToken refuses the anonymous token', async () => {
  const anon = new CommonsApi({ apiUrl: API, accessToken: 't', fetchFn: fakeFetch(() => jsonResponse({ query: { tokens: { csrftoken: '+\\' } } })) });
  await assert.rejects(anon.csrfToken(), (e) => e.code === 'notloggedin');
  const ok = new CommonsApi({ apiUrl: API, accessToken: 't', fetchFn: fakeFetch(() => jsonResponse({ query: { tokens: { csrftoken: 'abc+\\' } } })) });
  assert.equal(await ok.csrfToken(), 'abc+\\');
});

test('pageId waits for a brand-new page to appear', async () => {
  let n = 0;
  const fetchFn = fakeFetch(() => jsonResponse({ query: { pages: [++n < 3 ? { title: 'File:A.jpg', missing: true } : { title: 'File:A.jpg', pageid: 42 }] } }));
  const api = new CommonsApi({ apiUrl: API, fetchFn });
  assert.equal(await api.pageId('File:A.jpg', { sleepFn: async () => {} }), 42);
  assert.equal(fetchFn.calls.length, 3);
});

test('writes refuse to run without a login', async () => {
  const api = new CommonsApi({ apiUrl: API, fetchFn: fakeFetch(() => jsonResponse({})) });
  await assert.rejects(api.editEntity({ id: 'M1', data: {}, summary: '', token: 't' }), /Not logged in/);
});

test('categories: species, then genus, then the fallback', async () => {
  const existing = new Set(['Category:Saxicola maurus', 'Category:Copsychus']);
  const fetchFn = fakeFetch((u) => jsonResponse({
    query: { pages: u.searchParams.get('titles').split('|').map((t) => (existing.has(t) ? { title: t } : { title: t, missing: true })) },
  }));
  const api = new CommonsApi({ apiUrl: API, fetchFn });
  const records = [
    { key: 'a', taxonName: 'Saxicola maurus', taxonRank: 'species' },
    { key: 'b', taxonName: 'Copsychus saularis', taxonRank: 'species' },
    { key: 'c', taxonName: 'Nothing here', taxonRank: 'species' },
    { key: 'd', taxonName: null, taxonRank: null },
  ];
  const out = await resolveCategories(records, api, 'Media needing categories');
  assert.deepEqual(out.get('a'), { category: 'Saxicola maurus', isFallback: false });
  assert.deepEqual(out.get('b'), { category: 'Copsychus', isFallback: false });
  assert.deepEqual(out.get('c'), { category: 'Media needing categories', isFallback: true });
  assert.deepEqual(out.get('d'), { category: 'Media needing categories', isFallback: true });
});

test('genus is only a fallback for species-level taxa', () => {
  assert.deepEqual(categoryCandidates({ taxonName: 'Saxicola maurus', taxonRank: 'species' }), ['Saxicola maurus', 'Saxicola']);
  assert.deepEqual(categoryCandidates({ taxonName: 'Muscicapidae', taxonRank: 'family' }), ['Muscicapidae']);
  assert.deepEqual(categoryCandidates({ taxonName: null }), []);
});
