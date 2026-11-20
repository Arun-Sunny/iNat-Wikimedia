// Commons Action API client: reads (duplicate search by SHA-1, page existence, user info, CSRF
// token) and the two writes the app makes, action=upload and action=wbeditentity.
// Every write sends maxlag=5 and assert=user, and never sets ignorewarnings.
import { chunk, unique, sleep } from './util.js';

export class CommonsError extends Error {
  constructor(error, { retryAfter = null } = {}) {
    super(error?.info || error?.code || 'Commons API error');
    this.code = error?.code ?? 'unknown';
    this.retryAfter = retryAfter;
    this.lag = typeof error?.lag === 'number' ? error.lag : null;
  }
}

function retryAfterSeconds(res) {
  const n = Number(res.headers?.get?.('retry-after'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export class CommonsApi {
  /**
   * @param apiUrl e.g. https://commons.wikimedia.org/w/api.php
   * @param accessToken OAuth 2.0 bearer token, or null for anonymous reads
   */
  constructor({ apiUrl, fetchFn = (...args) => fetch(...args), userAgent, accessToken = null }) {
    this.apiUrl = apiUrl;
    this.fetchFn = fetchFn;
    this.userAgent = userAgent;
    this.accessToken = accessToken;
  }

  /**
   * GET request. Anonymous reads use origin=*. Authenticated reads use crossorigin= with an
   * Authorization header, which MediaWiki (1.44+) accepts from any origin for OAuth.
   */
  async get(params, { auth = false } = {}) {
    const query = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
    const headers = {};
    if (this.userAgent) headers['Api-User-Agent'] = this.userAgent;
    if (auth) {
      if (!this.accessToken) throw new Error('Not logged in');
      query.set('crossorigin', '');
      headers.Authorization = `Bearer ${this.accessToken}`;
    } else {
      query.set('origin', '*');
    }
    const res = await this.fetchFn(`${this.apiUrl}?${query}`, { headers });
    if (!res.ok) throw new Error(`Commons API returned HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new CommonsError(body.error, { retryAfter: retryAfterSeconds(res) });
    return body;
  }

  /**
   * Authenticated POST. crossorigin= must be in the query string; everything else goes in the
   * body. With `file`, the body is multipart and the token is appended last, as MediaWiki
   * recommends, so a truncated request can never carry a valid token.
   */
  async post(params, { file = null, fileName = 'file' } = {}) {
    if (!this.accessToken) throw new Error('Not logged in');
    const { token, ...rest } = params;
    const fields = { format: 'json', formatversion: '2', ...rest };
    let body;
    if (file) {
      body = new FormData();
      for (const [k, v] of Object.entries(fields)) body.append(k, v);
      body.append('file', file, fileName);
      if (token !== undefined) body.append('token', token);
    } else {
      body = new URLSearchParams(fields);
      if (token !== undefined) body.append('token', token);
    }
    const headers = { Authorization: `Bearer ${this.accessToken}` };
    if (this.userAgent) headers['Api-User-Agent'] = this.userAgent;
    const res = await this.fetchFn(`${this.apiUrl}?crossorigin=`, { method: 'POST', headers, body });
    if (!res.ok) throw new Error(`Commons API returned HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new CommonsError(json.error, { retryAfter: retryAfterSeconds(res) });
    return json;
  }

  async csrfToken() {
    const body = await this.get({ action: 'query', meta: 'tokens', type: 'csrf' }, { auth: true });
    const token = body.query?.tokens?.csrftoken;
    if (!token || token === '+\\') throw new CommonsError({ code: 'notloggedin', info: 'Commons did not issue an edit token' });
    return token;
  }

  /** action=upload from bytes. Returns the API's "upload" object (result Success / Warning / ...). */
  async upload({ filename, text, comment, file, token }) {
    const json = await this.post(
      { action: 'upload', filename, text, comment, maxlag: '5', assert: 'user', token },
      { file, fileName: filename },
    );
    return json.upload ?? {};
  }

  /** Page id of a title, retrying briefly because a brand-new page can lag on replicas. */
  async pageId(title, { attempts = 5, delayMs = 2000, sleepFn = sleep } = {}) {
    for (let i = 0; i < attempts; i++) {
      const body = await this.get({ action: 'query', titles: title, prop: 'info' });
      const page = body.query?.pages?.[0];
      if (page?.pageid) return page.pageid;
      if (i < attempts - 1) await sleepFn(delayMs);
    }
    return null;
  }

  /** Adds labels and statements to a MediaInfo entity (M<pageid>). */
  async editEntity({ id, data, summary, token }) {
    return this.post({
      action: 'wbeditentity', id, data: JSON.stringify(data), summary, maxlag: '5', assert: 'user', token,
    });
  }

  /** File titles on Commons whose content has this SHA-1 (hex). */
  async findBySha1(sha1) {
    const body = await this.get({ action: 'query', list: 'allimages', aisha1: sha1, ailimit: '10' });
    return (body.query?.allimages ?? []).map((i) => i.title ?? `File:${i.name}`);
  }

  /** Map of each requested title → true if the page exists. Handles title normalisation. */
  async pagesExist(titles) {
    const result = new Map();
    for (const batch of chunk(unique(titles), 50)) {
      const body = await this.get({ action: 'query', titles: batch.join('|') });
      const normalized = new Map((body.query?.normalized ?? []).map((n) => [n.from, n.to]));
      const exists = new Map(
        (body.query?.pages ?? []).map((p) => [p.title, !p.missing && !p.invalid]),
      );
      for (const t of batch) result.set(t, exists.get(normalized.get(t) ?? t) ?? false);
    }
    return result;
  }

  async userInfo() {
    const body = await this.get(
      { action: 'query', meta: 'userinfo', uiprop: 'rights|groups' },
      { auth: true },
    );
    return body.query?.userinfo ?? null;
  }
}

const SPECIES_LEVEL = new Set(['species', 'hybrid', 'subspecies', 'variety', 'form', 'infrahybrid', 'complex']);

/** Category names to try, most specific first: the taxon, then its genus for species-level taxa. */
export function categoryCandidates(rec) {
  if (!rec.taxonName) return [];
  const out = [rec.taxonName];
  if (SPECIES_LEVEL.has(rec.taxonRank)) {
    const genus = rec.taxonName.split(' ')[0];
    if (genus && genus !== rec.taxonName) out.push(genus);
  }
  return out;
}

/**
 * Picks the first existing category from categoryCandidates for each record, else `fallback`.
 * Returns Map(record.key → { category, isFallback }).
 */
export async function resolveCategories(records, api, fallback) {
  const titles = records.flatMap(categoryCandidates).map((n) => `Category:${n}`);
  const exists = titles.length ? await api.pagesExist(titles) : new Map();
  const out = new Map();
  for (const rec of records) {
    const hit = categoryCandidates(rec).find((n) => exists.get(`Category:${n}`));
    out.set(rec.key, hit ? { category: hit, isFallback: false } : { category: fallback || null, isFallback: true });
  }
  return out;
}
