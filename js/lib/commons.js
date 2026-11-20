// Commons Action API client. This build only READS from Commons:
// duplicate search by SHA-1, page existence, and the logged-in user's info.
// Uploading and structured-data edits come in the next step, after review.
import { chunk, unique } from './util.js';

export class CommonsError extends Error {
  constructor(error) {
    super(error?.info || error?.code || 'Commons API error');
    this.code = error?.code ?? 'unknown';
  }
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
    if (body.error) throw new CommonsError(body.error);
    return body;
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
