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
