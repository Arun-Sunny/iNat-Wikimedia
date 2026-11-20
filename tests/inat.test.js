import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageObservations, observationsUrl, toPhotoRecords, photoSizeUrl, photoExt, parseLocation, parseInatUser, fetchUser, profileUrl } from '../js/lib/inat.js';
import { fakeFetch, jsonResponse, sampleObservation } from './helpers.js';

const BASE = 'https://inat.test/v1';

function fakeClock() {
  let t = 0;
  const waits = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    },
    tick: (ms) => (t += ms),
    waits,
  };
}

async function collect(gen) {
  const pages = [];
  for await (const p of gen) pages.push(p);
  return pages;
}

const ids = (from, n) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

test('builds the observations URL with id_above paging', () => {
  const u = new URL(observationsUrl(BASE, { userLogin: 'example_naturalist', idAbove: 42, perPage: 200 }));
  assert.equal(u.pathname, '/v1/observations');
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    user_login: 'example_naturalist', photos: 'true', order_by: 'id', order: 'asc', per_page: '200', id_above: '42',
  });
  assert.equal(new URL(observationsUrl(BASE, { userLogin: 'x' })).searchParams.has('id_above'), false);
});

test('pages with id_above until a short page and never uses page=', async () => {
  const clock = fakeClock();
  const pages = { 0: ids(1, 3), 3: ids(4, 3), 6: ids(7, 1) };
  const fetchFn = fakeFetch((u) => {
    const above = Number(u.searchParams.get('id_above') ?? 0);
    return jsonResponse({ total_results: 7 - above, results: pages[above] ?? [] });
  });
  const out = await collect(pageObservations({
    userLogin: 'example_naturalist', base: BASE, perPage: 3, fetchFn, sleepFn: clock.sleep, now: clock.now,
  }));
  assert.deepEqual(out.map((p) => p.results.map((r) => r.id)), [[1, 2, 3], [4, 5, 6], [7]]);
  assert.equal(out[0].remaining, 7);
  assert.deepEqual(fetchFn.calls.map((c) => c.url.searchParams.get('id_above')), [null, '3', '6']);
  assert.ok(fetchFn.calls.every((c) => !c.url.searchParams.has('page')));
});

test('stops on an empty page when the total is an exact multiple of per_page', async () => {
  const clock = fakeClock();
  const fetchFn = fakeFetch((u) => jsonResponse({ results: u.searchParams.get('id_above') ? [] : ids(1, 2) }));
  const out = await collect(pageObservations({ userLogin: 'x', base: BASE, perPage: 2, fetchFn, sleepFn: clock.sleep, now: clock.now }));
  assert.equal(out.length, 1);
  assert.equal(fetchFn.calls.length, 2);
});

test('resumes from a stored id', async () => {
  const clock = fakeClock();
  const fetchFn = fakeFetch(() => jsonResponse({ results: [] }));
  await collect(pageObservations({ userLogin: 'x', base: BASE, idAbove: 999, fetchFn, sleepFn: clock.sleep, now: clock.now }));
  assert.equal(fetchFn.calls[0].url.searchParams.get('id_above'), '999');
});

test('spaces requests at least one second apart', async () => {
  const clock = fakeClock();
  const times = [];
  const fetchFn = fakeFetch((u) => {
    times.push(clock.now());
    clock.tick(150); // the request itself takes 150 ms
    const above = Number(u.searchParams.get('id_above') ?? 0);
    return jsonResponse({ results: above < 4 ? ids(above + 1, 2) : [] });
  });
  await collect(pageObservations({ userLogin: 'x', base: BASE, perPage: 2, fetchFn, sleepFn: clock.sleep, now: clock.now }));
  assert.equal(times.length, 3);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 1000, `gap ${times[i] - times[i - 1]}`);
});

test('retries rate-limited and server errors, then fails on other errors', async () => {
  const clock = fakeClock();
  const fetchFn = fakeFetch((_u, _i, n) => (n === 1 ? jsonResponse({}, 429) : n === 2 ? jsonResponse({}, 503) : jsonResponse({ results: ids(1, 1) })));
  const out = await collect(pageObservations({ userLogin: 'x', base: BASE, perPage: 5, fetchFn, sleepFn: clock.sleep, now: clock.now }));
  assert.equal(out.length, 1);
  assert.equal(fetchFn.calls.length, 3);

  const failing = fakeFetch(() => jsonResponse({}, 404));
  await assert.rejects(collect(pageObservations({ userLogin: 'x', base: BASE, fetchFn: failing, sleepFn: clock.sleep, now: clock.now })), /HTTP 404/);

  const alwaysLimited = fakeFetch(() => jsonResponse({}, 429));
  await assert.rejects(collect(pageObservations({ userLogin: 'x', base: BASE, fetchFn: alwaysLimited, sleepFn: clock.sleep, now: clock.now, maxRetries: 2 })), /HTTP 429/);
  assert.equal(alwaysLimited.calls.length, 3);
});

test('flattens an observation into one record per photo', () => {
  const obs = sampleObservation();
  obs.photos.push({ id: 2, license_code: 'cc-by-nc', url: 'https://static.inaturalist.org/photos/2/square.jpeg?1700000000' });
  const [first, second] = toPhotoRecords(obs);
  assert.deepEqual(first, {
    key: '123456789-987654321',
    obsId: 123456789,
    photoId: 987654321,
    position: 0,
    licenseCode: 'cc-by',
    hidden: false,
    thumbUrl: 'https://inaturalist-open-data.s3.amazonaws.com/photos/987654321/small.jpg',
    mediumUrl: 'https://inaturalist-open-data.s3.amazonaws.com/photos/987654321/medium.jpg',
    originalUrl: 'https://inaturalist-open-data.s3.amazonaws.com/photos/987654321/original.jpg',
    ext: 'jpg',
    width: 1600,
    height: 1044,
    taxonId: 201193,
    taxonName: 'Saxicola maurus',
    taxonRank: 'species',
    commonName: 'Siberian Stonechat',
    observedOn: '2024-05-12',
    qualityGrade: 'research',
    uri: 'https://www.inaturalist.org/observations/123456789',
    lat: 12.3456789012,
    lng: 76.5432109876,
    accuracy: 1953,
    geoprivacy: null,
    taxonGeoprivacy: null,
    obscured: false,
    placeGuess: 'Example Park, Example City',
    faves: 0,
    observer: 'example_naturalist',
  });
  assert.equal(second.position, 1);
  assert.equal(second.licenseCode, 'cc-by-nc');
  assert.equal(second.originalUrl, 'https://static.inaturalist.org/photos/2/original.jpeg');
  assert.equal(second.ext, 'jpg');
});

test('reads a username from what people paste or type', () => {
  const cases = {
    example_naturalist: 'example_naturalist',
    '  @example_naturalist ': 'example_naturalist',
    'https://www.inaturalist.org/people/example_naturalist': 'example_naturalist',
    'www.inaturalist.org/people/example_naturalist/': 'example_naturalist',
    'inaturalist.org/people/example_naturalist?tab=about#x': 'example_naturalist',
    'https://www.inaturalist.org/people/4242': '4242',
    'https://www.inaturalist.org/observations/example_naturalist': 'example_naturalist',
    'https://www.inaturalist.org/observations?user_id=example_naturalist&place_id=any': 'example_naturalist',
    'https://www.inaturalist.org/lists/example-naturalist-2': 'example-naturalist-2',
    'https://inaturalist.ca/people/someone': 'someone',
    'https://www.naturalista.mx/people/alguien': 'alguien',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(parseInatUser(input), expected, input);
});

test('rejects input that is not an iNaturalist person', () => {
  for (const input of [
    '', '   ', null, 'two words', 'https://example.com/people/example_naturalist',
    'https://www.inaturalist.org/observations/123456789', 'https://www.inaturalist.org/taxa/201193',
    'https://www.inaturalist.org/', 'not a url/with spaces',
  ]) {
    assert.equal(parseInatUser(input), null, String(input));
  }
});

test('looks up an account and returns null for unknown users', async () => {
  const fetchFn = fakeFetch((u) => (u.pathname.endsWith('/users/example_naturalist')
    ? jsonResponse({ total_results: 1, results: [{ id: 4242, login: 'example_naturalist', name: 'Alex Example', observations_count: 1234 }] })
    : jsonResponse({ error: 'User does not exist', status: 404 }, 404)));
  assert.deepEqual(await fetchUser('example_naturalist', { base: BASE, fetchFn }), { id: 4242, login: 'example_naturalist', name: 'Alex Example', observationsCount: 1234 });
  assert.equal(await fetchUser('nobody', { base: BASE, fetchFn }), null);
  assert.equal(fetchFn.calls[0].url.href, 'https://inat.test/v1/users/example_naturalist');
  await assert.rejects(fetchUser('x', { base: BASE, fetchFn: fakeFetch(() => jsonResponse({}, 500)) }), /HTTP 500/);
  assert.equal(profileUrl('example_naturalist'), 'https://www.inaturalist.org/people/example_naturalist');
});

test('photo URL helpers and location parsing', () => {
  assert.equal(photoSizeUrl('https://x/photos/1/square.png', 'original'), 'https://x/photos/1/original.png');
  assert.equal(photoExt('https://x/photos/1/square.png'), 'png');
  assert.equal(photoExt('https://x/photos/1/square.JPEG'), 'jpg');
  assert.deepEqual(parseLocation({ location: '1.5,-2.25' }), { lat: 1.5, lng: -2.25 });
  assert.deepEqual(parseLocation({ geojson: { coordinates: [-2.25, 1.5] } }), { lat: 1.5, lng: -2.25 });
  assert.equal(parseLocation({ location: null }), null);
});
