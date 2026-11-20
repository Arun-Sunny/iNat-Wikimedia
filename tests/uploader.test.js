import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretUpload, withRetries, uploadPhoto, addStructuredData, isAuthError } from '../js/lib/uploader.js';
import { CommonsError } from '../js/lib/commons.js';

const noSleep = async () => {};

test('maps every upload warning to an explicit outcome', () => {
  assert.deepEqual(interpretUpload({ result: 'Success', filename: 'A.jpg' }), { kind: 'success', filename: 'A.jpg' });
  assert.deepEqual(interpretUpload({ result: 'Warning', warnings: { duplicate: ['Old.jpg'] } }), { kind: 'duplicate', title: 'File:Old.jpg' });
  assert.deepEqual(interpretUpload({ result: 'Warning', warnings: { 'duplicate-archive': 'Gone.jpg' } }), { kind: 'deleted-duplicate', title: 'File:Gone.jpg' });
  assert.deepEqual(interpretUpload({ result: 'Warning', warnings: { 'was-deleted': 'A.jpg' } }), { kind: 'was-deleted', title: 'File:A.jpg' });
  assert.deepEqual(interpretUpload({ result: 'Warning', warnings: { exists: 'A.jpg' } }), { kind: 'name-taken', title: 'File:A.jpg' });
  assert.deepEqual(interpretUpload({ result: 'Warning', warnings: { 'exists-normalized': 'A.JPG' } }), { kind: 'name-taken', title: 'File:A.JPG' });
  assert.deepEqual(interpretUpload({ result: 'Warning', warnings: { badfilename: 'Better.jpg' } }), { kind: 'bad-filename', suggestion: 'Better.jpg' });
  assert.deepEqual(interpretUpload({ result: 'Warning', warnings: { 'large-file': 1 } }), { kind: 'warning', warnings: { 'large-file': 1 } });
  assert.deepEqual(interpretUpload({ result: 'Failure', captcha: { id: '1' } }), { kind: 'captcha' });
  assert.deepEqual(interpretUpload({ result: 'Continue' }), { kind: 'unexpected', result: 'Continue' });
});

test('retries maxlag after the server-given delay, then succeeds', async () => {
  const waits = [];
  let calls = 0;
  const out = await withRetries(async () => {
    calls++;
    if (calls === 1) throw new CommonsError({ code: 'maxlag', info: 'lagged', lag: 3 }, { retryAfter: 7 });
    return 'ok';
  }, { sleepFn: async (ms) => waits.push(ms) });
  assert.equal(out, 'ok');
  assert.deepEqual(waits, [7000]);
});

test('backs off longer on each rate limit', async () => {
  const waits = [];
  let calls = 0;
  await withRetries(async () => {
    if (++calls < 3) throw new CommonsError({ code: 'ratelimited' });
    return 'ok';
  }, { sleepFn: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [60000, 120000]);
});

test('refreshes a stale token once, and gives up on other errors', async () => {
  let refreshed = 0;
  let calls = 0;
  await withRetries(async () => {
    if (++calls === 1) throw new CommonsError({ code: 'badtoken' });
    return 'ok';
  }, { sleepFn: noSleep, refreshToken: async () => refreshed++ });
  assert.equal(refreshed, 1);

  await assert.rejects(
    withRetries(async () => { throw new CommonsError({ code: 'badtoken' }); }, { sleepFn: noSleep, refreshToken: async () => {} }),
    (e) => e.code === 'badtoken',
  );
  let attempts = 0;
  await assert.rejects(
    withRetries(async () => { attempts++; throw new CommonsError({ code: 'fileexists-forbidden' }); }, { sleepFn: noSleep }),
    (e) => e.code === 'fileexists-forbidden',
  );
  assert.equal(attempts, 1);
});

test('retries network failures and stops after the attempt limit', async () => {
  let calls = 0;
  await assert.rejects(
    withRetries(async () => { calls++; throw new TypeError('Failed to fetch'); }, { sleepFn: noSleep, maxAttempts: 3 }),
    TypeError,
  );
  assert.equal(calls, 3);
});

test('recognises login and permission errors', () => {
  assert.equal(isAuthError(new CommonsError({ code: 'assertuserfailed' })), true);
  assert.equal(isAuthError(new CommonsError({ code: 'mwoauth-invalid-authorization' })), true);
  assert.equal(isAuthError(new CommonsError({ code: 'permissiondenied' })), true);
  assert.equal(isAuthError(new CommonsError({ code: 'maxlag' })), false);
  assert.equal(isAuthError(new Error('x')), false);
});

// ---------- uploadPhoto with a fake Commons ----------

function fakeApi({ dupes = [], uploads = [], pageId = 555, editError = null } = {}) {
  const calls = { upload: [], edit: [], findBySha1: [] };
  return {
    calls,
    async findBySha1(sha1) { calls.findBySha1.push(sha1); return dupes; },
    async upload(args) {
      calls.upload.push(args);
      const next = uploads.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    async pageId() { return pageId; },
    async editEntity(args) {
      calls.edit.push(args);
      if (editError) throw editError;
      return { success: 1 };
    },
  };
}

const baseArgs = (api, extra = {}) => ({
  rec: { originalUrl: 'https://img.test/original.jpg' },
  filename: 'Saxicola maurus (iNaturalist 1-2).jpg',
  wikitext: '== text ==',
  comment: 'test upload',
  sdc: { claims: [] },
  sdcSummary: 'sdc',
  api,
  getToken: () => 'TOKEN',
  refreshToken: async () => {},
  download: async () => new Blob(['photo bytes']),
  sha1Fn: async () => 'abc123',
  sleepFn: noSleep,
  ...extra,
});

test('skips the upload when Commons already has the same bytes', async () => {
  const api = fakeApi({ dupes: ['File:Existing.jpg'] });
  const out = await uploadPhoto(baseArgs(api));
  assert.deepEqual(out, { state: 'duplicate', sha1: 'abc123', commonsTitle: 'File:Existing.jpg', uploadAttempted: false });
  assert.equal(api.calls.upload.length, 0);
});

test('uploads, then adds structured data to M<pageid>', async () => {
  const api = fakeApi({ uploads: [{ result: 'Success', filename: 'Saxicola maurus (iNaturalist 1-2).jpg' }] });
  const out = await uploadPhoto(baseArgs(api));
  assert.deepEqual(out, {
    state: 'sdc_done', sha1: 'abc123', uploadAttempted: true,
    commonsTitle: 'File:Saxicola maurus (iNaturalist 1-2).jpg', pageId: 555, sdcError: null,
  });
  const up = api.calls.upload[0];
  assert.equal(up.filename, 'Saxicola maurus (iNaturalist 1-2).jpg');
  assert.equal(up.text, '== text ==');
  assert.equal(up.token, 'TOKEN');
  assert.ok(up.file instanceof Blob);
  assert.equal(api.calls.edit[0].id, 'M555');
  assert.deepEqual(api.calls.edit[0].data, { claims: [] });
});

test('leaves structured data for later when the site has none (beta)', async () => {
  const api = fakeApi({ uploads: [{ result: 'Success', filename: 'A.jpg' }] });
  const out = await uploadPhoto(baseArgs(api, { sdc: null }));
  assert.equal(out.state, 'uploaded');
  assert.equal(api.calls.edit.length, 0);
});

test('keeps the upload when structured data fails, recording why', async () => {
  const api = fakeApi({ uploads: [{ result: 'Success', filename: 'A.jpg' }], editError: new CommonsError({ code: 'modification-failed', info: 'Bad claim' }) });
  const out = await uploadPhoto(baseArgs(api));
  assert.equal(out.state, 'uploaded');
  assert.equal(out.commonsTitle, 'File:A.jpg');
  assert.equal(out.sdcError, 'Bad claim');
});

test('retries once with the name Commons suggests', async () => {
  const api = fakeApi({ uploads: [{ result: 'Warning', warnings: { badfilename: 'Fixed.jpg' } }, { result: 'Success', filename: 'Fixed.jpg' }] });
  const out = await uploadPhoto(baseArgs(api, { sdc: null }));
  assert.equal(out.commonsTitle, 'File:Fixed.jpg');
  assert.deepEqual(api.calls.upload.map((u) => u.filename), ['Saxicola maurus (iNaturalist 1-2).jpg', 'Fixed.jpg']);
});

test('never overrides warnings: duplicates, deleted files and taken names are reported', async () => {
  const cases = [
    [{ duplicate: ['Other.jpg'] }, { state: 'duplicate', commonsTitle: 'File:Other.jpg' }],
    [{ 'duplicate-archive': 'Gone.jpg' }, { state: 'failed' }],
    [{ 'was-deleted': 'A.jpg' }, { state: 'failed' }],
    [{ exists: 'A.jpg' }, { state: 'failed' }],
  ];
  for (const [warnings, expected] of cases) {
    const api = fakeApi({ uploads: [{ result: 'Warning', warnings }] });
    const out = await uploadPhoto(baseArgs(api));
    for (const [k, v] of Object.entries(expected)) assert.equal(out[k], v, JSON.stringify(warnings));
    assert.equal(api.calls.upload.length, 1, 'no second attempt');
    assert.ok(api.calls.upload.every((u) => !('ignorewarnings' in u)));
  }
});

test('reports a CAPTCHA so the run can stop', async () => {
  const api = fakeApi({ uploads: [{ result: 'Failure', captcha: { type: 'image' } }] });
  const out = await uploadPhoto(baseArgs(api));
  assert.equal(out.state, 'failed');
  assert.equal(out.code, 'captcha');

  const api2 = fakeApi({ uploads: [new CommonsError({ code: 'captcha', info: 'Needs captcha' })] });
  assert.equal((await uploadPhoto(baseArgs(api2))).code, 'captcha');
});

test('login problems are thrown so the run stops', async () => {
  const api = fakeApi({ uploads: [new CommonsError({ code: 'assertuserfailed' })] });
  await assert.rejects(uploadPhoto(baseArgs(api)), (e) => e.code === 'assertuserfailed');
  const api2 = fakeApi({ uploads: [{ result: 'Success', filename: 'A.jpg' }], editError: new CommonsError({ code: 'mwoauth-invalid-authorization' }) });
  await assert.rejects(uploadPhoto(baseArgs(api2)), (e) => e.code === 'mwoauth-invalid-authorization');
});

test('addStructuredData reports a missing page instead of guessing', async () => {
  const api = fakeApi({ pageId: null });
  const out = await addStructuredData({ status: { state: 'uploaded', commonsTitle: 'File:A.jpg' }, sdc: {}, summary: 's', api, getToken: () => 't', sleepFn: noSleep });
  assert.equal(out.state, 'uploaded');
  assert.match(out.sdcError, /Could not find/);
});
