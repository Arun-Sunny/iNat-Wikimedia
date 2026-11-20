// Read-only access to the public iNaturalist API v1. No login is used.
import { sleep } from './util.js';

export const INAT_API = 'https://api.inaturalist.org/v1';
export const PER_PAGE_MAX = 200;

export function observationsUrl(base, { userLogin, idAbove = 0, perPage = PER_PAGE_MAX }) {
  const params = new URLSearchParams({
    user_login: userLogin,
    photos: 'true',
    order_by: 'id',
    order: 'asc',
    per_page: String(perPage),
  });
  if (idAbove > 0) params.set('id_above', String(idAbove));
  return `${base}/observations?${params}`;
}

/**
 * Pages through one user's observations, oldest id first.
 *
 * Uses id_above paging instead of page=, because page= stops at 10,000 results.
 * Requests are spaced at least `minIntervalMs` apart (iNaturalist asks for about 1 request
 * per second). HTTP 429 and 5xx responses are retried with a growing delay.
 *
 * Yields { results, remaining } for each page; `remaining` is iNaturalist's total_results
 * for the current id_above window, so the first page's value is the total still to load.
 */
export async function* pageObservations({
  userLogin,
  idAbove = 0,
  perPage = PER_PAGE_MAX,
  base = INAT_API,
  fetchFn = (...args) => fetch(...args),
  sleepFn = sleep,
  now = () => Date.now(),
  minIntervalMs = 1000,
  maxRetries = 4,
  signal,
}) {
  if (!userLogin) throw new Error('No iNaturalist user is configured');
  let cursor = idAbove;
  let lastRequestAt = -Infinity;

  for (;;) {
    let body;
    for (let attempt = 0; ; attempt++) {
      const wait = lastRequestAt + minIntervalMs - now();
      if (wait > 0) await sleepFn(wait, signal);
      lastRequestAt = now();
      const res = await fetchFn(observationsUrl(base, { userLogin, idAbove: cursor, perPage }), {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        body = await res.json();
        break;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        throw new Error(`iNaturalist API returned HTTP ${res.status}`);
      }
      await sleepFn(minIntervalMs * 5 * 2 ** attempt, signal);
    }

    const results = Array.isArray(body?.results) ? body.results : [];
    if (results.length === 0) return;
    yield { results, remaining: typeof body.total_results === 'number' ? body.total_results : null };
    cursor = results[results.length - 1].id;
    if (results.length < perPage) return;
  }
}

const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const NETWORK_HOST_RE = /(^|\.)(inaturalist\.[a-z.]+|naturalista\.[a-z.]+|biodiversity4all\.org|argentinat\.org)$/i;
const USER_PATHS = new Set(['people', 'observations', 'lists', 'journal', 'calendar', 'faves']);

/**
 * Reads an iNaturalist username (or numeric user id) from what someone typed or pasted:
 * "yourname", "@yourname", "https://www.inaturalist.org/people/yourname",
 * ".../observations/yourname", ".../observations?user_id=yourname", or the same on an
 * iNaturalist Network site such as inaturalist.ca. Returns null if nothing usable is found.
 */
export function parseInatUser(input) {
  const s = String(input ?? '').trim().replace(/^@/, '');
  if (!s) return null;
  if (LOGIN_RE.test(s)) return s;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!NETWORK_HOST_RE.test(url.hostname)) return null;

  const fromQuery = url.searchParams.get('user_id') || url.searchParams.get('user_login');
  if (fromQuery && LOGIN_RE.test(fromQuery)) return fromQuery;

  const [section, value] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!USER_PATHS.has(section) || !value || !LOGIN_RE.test(value)) return null;
  // /observations/<number> is an observation, not a person.
  if (section === 'observations' && /^\d+$/.test(value)) return null;
  return value;
}

export function profileUrl(login) {
  return `https://www.inaturalist.org/people/${encodeURIComponent(login)}`;
}

/** Looks up an account by username or id. Returns null when iNaturalist has no such user. */
export async function fetchUser(loginOrId, { base = INAT_API, fetchFn = (...args) => fetch(...args) } = {}) {
  const res = await fetchFn(`${base}/users/${encodeURIComponent(loginOrId)}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`iNaturalist API returned HTTP ${res.status}`);
  const user = (await res.json())?.results?.[0];
  if (!user?.login) return null;
  return {
    id: user.id,
    login: user.login,
    name: user.name || '',
    observationsCount: typeof user.observations_count === 'number' ? user.observations_count : null,
  };
}

/** "lat,lng" string (or GeoJSON point) → { lat, lng } using the public, possibly obscured, position. */
export function parseLocation(obs) {
  if (typeof obs.location === 'string' && obs.location.includes(',')) {
    const [lat, lng] = obs.location.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  const c = obs.geojson?.coordinates;
  if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) return { lat: c[1], lng: c[0] };
  return null;
}

const SIZE_RE = /\/(square|thumb|small|medium|large|original)\.([a-z0-9]+)(?:\?.*)?$/i;

/** Swaps the size segment of an iNaturalist photo URL, e.g. .../square.jpg → .../original.jpg */
export function photoSizeUrl(url, size) {
  if (!SIZE_RE.test(url)) return url;
  return url.replace(SIZE_RE, (_m, _size, ext) => `/${size}.${ext}`);
}

export function photoExt(url) {
  const m = SIZE_RE.exec(url ?? '');
  const ext = m ? m[2].toLowerCase() : 'jpg';
  return ext === 'jpeg' ? 'jpg' : ext;
}

/** One record per photo, flattened from an observation. These are what the app stores and plans. */
export function toPhotoRecords(obs) {
  const photos = Array.isArray(obs.photos)
    ? obs.photos
    : (obs.observation_photos ?? []).map((op) => op.photo);
  const loc = parseLocation(obs);
  const taxon = obs.taxon ?? null;
  const accuracy = obs.public_positional_accuracy ?? obs.positional_accuracy ?? null;

  return photos
    .filter((p) => p && p.id && p.url)
    .map((p, position) => ({
      key: `${obs.id}-${p.id}`,
      obsId: obs.id,
      photoId: p.id,
      position,
      licenseCode: p.license_code ?? null,
      hidden: Boolean(p.hidden),
      thumbUrl: photoSizeUrl(p.url, 'small'),
      mediumUrl: photoSizeUrl(p.url, 'medium'),
      originalUrl: photoSizeUrl(p.url, 'original'),
      ext: photoExt(p.url),
      width: p.original_dimensions?.width ?? null,
      height: p.original_dimensions?.height ?? null,
      taxonId: taxon?.id ?? null,
      taxonName: taxon?.name ?? null,
      taxonRank: taxon?.rank ?? null,
      commonName: taxon?.preferred_common_name ?? null,
      observedOn: obs.observed_on ?? null,
      qualityGrade: obs.quality_grade ?? null,
      uri: obs.uri ?? `https://www.inaturalist.org/observations/${obs.id}`,
      lat: loc?.lat ?? null,
      lng: loc?.lng ?? null,
      accuracy: typeof accuracy === 'number' ? accuracy : null,
      geoprivacy: obs.geoprivacy ?? null,
      taxonGeoprivacy: obs.taxon_geoprivacy ?? null,
      obscured: Boolean(obs.obscured),
      placeGuess: obs.place_guess ?? null,
      faves: obs.faves_count ?? 0,
      observer: obs.user?.login ?? null,
    }));
}
